"use strict";

// Test helpers: a minimal PNG reader and writer, a local web server and a
// browser behind a relay of its pipe.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const zlib = require("node:zlib");

// Minimal PNG reader for 8-bit RGB/RGBA, non-interlaced (what Chrome
// writes), every filter type.
function readPng(fileOrBuffer) {
  const buf = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let p = v;
      if (filter === 1) p = v + a;
      else if (filter === 2) p = v + b;
      else if (filter === 3) p = v + ((a + b) >> 1);
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      pixels[y * stride + x] = p & 0xff;
    }
  }
  return { width, height, pixel: (x, y) => [...pixels.subarray(y * stride + x * channels, y * stride + x * channels + 3)] };
}

function crc(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// Minimal PNG writer: 8-bit RGB, each row filtered with filterOf(y), the
// way an encoder picks a filter per row.
function pngOf(width, height, color, filterOf = () => 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const plain = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) Buffer.from(color(x, y)).copy(plain, y * stride + x * 3);
  }
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const filter = filterOf(y);
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const v = plain[y * stride + x];
      const a = x >= 3 ? plain[y * stride + x - 3] : 0;
      const b = y > 0 ? plain[(y - 1) * stride + x] : 0;
      const c = x >= 3 && y > 0 ? plain[(y - 1) * stride + x - 3] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + x] = (v - p) & 0xff;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function serve(handler) {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// Within a few levels of a color: anti-aliasing and color profiles differ.
function near(actual, expected, tolerance = 12) {
  return actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance);
}

// The processes under pid, each with its command line, from /proc: none
// where there is no /proc.
function descendants(pid) {
  let kids = [];
  try {
    kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
  return kids.flatMap((kid) => {
    let args = "";
    try {
      args = fs.readFileSync(`/proc/${kid}/cmdline`, "utf8");
    } catch {
      // Gone already.
    }
    return [{ pid: kid, args }, ...descendants(kid)];
  });
}

// A browser for CHROME_PATH that is the real one, `browser`, behind a relay
// of the DevTools pipe (file descriptors 3 and 4) that drops the answer to
// an input event under way as the page's main frame starts to move on to
// another document, as Chrome does at times: it can drop such an event with
// the page it was for, and then the call that sent it never hears back. A
// tab's main frame is the target it was attached by. Returns the wrapper
// to set CHROME_PATH to, and dropped(): what it dropped, a line each.
function relayBrowser(root, browser) {
  const script = path.join(root, "relay.js");
  const log = path.join(root, "dropped.log");
  fs.writeFileSync(
    script,
    `"use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const child = spawn(${JSON.stringify(browser)}, process.argv.slice(2), { stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"] });
const fromKit = fs.createReadStream(null, { fd: 3 });
const toKit = fs.createWriteStream(null, { fd: 4 });
for (const stream of [fromKit, toKit, child.stdio[3], child.stdio[4]]) stream.on("error", () => {});
const inputs = new Map();
const attaching = new Map();
const mainOf = new Map();
const dropped = new Set();
const split = (stream, take) => {
  let held = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    held = Buffer.concat([held, chunk]);
    let at;
    while ((at = held.indexOf(0)) >= 0) {
      const text = held.subarray(0, at).toString();
      held = held.subarray(at + 1);
      take(text);
    }
  });
};
split(fromKit, (text) => {
  const msg = JSON.parse(text);
  if (/^Input\\./.test(msg.method)) inputs.set(msg.id, { session: msg.sessionId, what: msg.method + " " + msg.params.type });
  if (msg.method === "Target.attachToTarget") attaching.set(msg.id, msg.params.targetId);
  child.stdio[3].write(text + "\\0");
});
split(child.stdio[4], (text) => {
  const msg = JSON.parse(text);
  if (attaching.has(msg.id)) {
    if (msg.result && msg.result.sessionId) mainOf.set(msg.result.sessionId, attaching.get(msg.id));
    attaching.delete(msg.id);
  }
  const moving = msg.method === "Page.frameRequestedNavigation" || (msg.method === "Page.frameStartedNavigating" && !/sameDocument/i.test(msg.params.navigationType || ""));
  if (moving && msg.sessionId && msg.params.frameId === mainOf.get(msg.sessionId)) {
    for (const [id, call] of inputs) {
      if (call.session !== msg.sessionId || dropped.has(id)) continue;
      dropped.add(id);
      fs.appendFileSync(${JSON.stringify(log)}, call.what + " as the page moved on to " + msg.params.url + "\\n");
    }
  }
  if (inputs.has(msg.id)) {
    inputs.delete(msg.id);
    if (dropped.has(msg.id)) return;
  }
  toKit.write(text + "\\0");
});
fromKit.on("end", () => child.stdio[3].end());
child.on("exit", (code) => process.exit(code === null ? 1 : code));
`,
  );
  const wrapper = path.join(root, "relayed-chrome");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
  return { browser: wrapper, dropped: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

module.exports = { readPng, pngOf, serve, near, descendants, relayBrowser };
