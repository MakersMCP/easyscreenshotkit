"use strict";

// Test helpers: a minimal PNG reader and writer, a local web server, a
// browser behind a relay of its pipe and the command line run to its end.

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const { spawn } = require("node:child_process");
const path = require("node:path");
const zlib = require("node:zlib");
const { roomIn } = require("../skills/easyscreenshotkit/scripts/lib/chrome");

// A path or a word quoted for sh as a whole, each ' written as '\'': in
// double quotes a $, a backquote or a ! of a temp folder's path would be
// read by the shell, and the stand-in would write somewhere else.
const sh = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

// Why the kit starts no browser from this temp folder, in its own words, or
// false, as a test's skip takes it (an empty reason skips the test too): on
// Linux one whose path holds PATH's delimiter, where the browser's
// stand-ins could not come first on its PATH, and on Linux and macOS one
// whose path leaves no room for the socket the browser opens there (see
// chrome.js). A test that starts a browser from it, or a program in its
// place, skips with that.
function tempProblem(tmp = os.tmpdir()) {
  if (process.platform === "linux" && tmp.includes(path.delimiter)) return `the temp folder's path, ${tmp}, has a ${path.delimiter} in it, which parts the folders of PATH`;
  if (process.platform !== "win32" && !roomIn(tmp)) return `the temp folder's path, ${tmp}, is too long for the socket the browser opens there`;
  return false;
}

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
// another document, or as a frame of it that runs in a process of its own
// commits another (the browser says so of the frame's target), as Chrome
// does at times: it can drop such an event with the document it was for,
// and then the call that sent it never hears back. A tab's main frame is
// the target it was attached by. holdMs: how long the answer to each input
// event is held before it goes on, so that a frame's move a moment after
// the answer came, which the browser tells only once the frame has moved,
// still drops it. Returns the wrapper to set CHROME_PATH to, and dropped():
// what it dropped, a line each.
function relayBrowser(root, browser, { holdMs = 0 } = {}) {
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
const frameUrls = new Map();
const dropFor = (session, why) => {
  for (const [id, call] of inputs) {
    if (call.session !== session || dropped.has(id)) continue;
    dropped.add(id);
    fs.appendFileSync(${JSON.stringify(log)}, call.what + " as " + why + "\\n");
  }
};
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
  if (moving && msg.sessionId && msg.params.frameId === mainOf.get(msg.sessionId)) dropFor(msg.sessionId, "the page moved on to " + msg.params.url);
  const frame = /^Target\\.target(Created|InfoChanged)$/.test(msg.method || "") && msg.params.targetInfo.type === "iframe" ? msg.params.targetInfo : null;
  if (frame) {
    const was = frameUrls.get(frame.targetId);
    frameUrls.set(frame.targetId, frame.url);
    if (was !== undefined && was !== frame.url) for (const [session, main] of mainOf) if (main === frame.parentFrameId) dropFor(session, "a frame of the page moved on to " + frame.url);
  }
  if (inputs.has(msg.id)) {
    if (dropped.has(msg.id)) return void inputs.delete(msg.id);
    if (${Number(holdMs)} > 0) {
      setTimeout(() => {
        inputs.delete(msg.id);
        if (!dropped.has(msg.id)) toKit.write(text + "\\0");
      }, ${Number(holdMs)});
      return;
    }
    inputs.delete(msg.id);
  }
  toKit.write(text + "\\0");
});
fromKit.on("end", () => child.stdio[3].end());
child.on("exit", (code) => process.exit(code === null ? 1 : code));
`,
  );
  const wrapper = path.join(root, "relayed-chrome");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(script)} "$@"\n`, { mode: 0o755 });
  return { browser: wrapper, dropped: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

// A browser for CHROME_PATH that is the real one, `browser`, behind a relay
// of the DevTools pipe that has it crash a tab's page as the kit takes the
// tab's first screenshot: it passes every message on, and right after the
// first Page.captureScreenshot to a tab that opened an address matching
// `page` (a regular expression; every tab when it is none), it sends
// Page.crash for that tab, which ends its page's process alone while the
// browser goes on, as the system can end one for its memory (Chrome does
// not do it while the tab has a navigation under way). The kit hears of it
// as Chrome 157 tells it, whatever the browser: the screenshot answered
// "Unable to capture screenshot", and 150 ms later Inspector.targetCrashed,
// where Chrome 155 sends that event first and no answer. Returns the
// wrapper to set CHROME_PATH to, and crashed(): what it did, a line each.
function crashingBrowser(root, browser, { page = "" } = {}) {
  const script = path.join(root, "crashing.js");
  const log = path.join(root, "crashing.log");
  fs.writeFileSync(
    script,
    `"use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const child = spawn(${JSON.stringify(browser)}, process.argv.slice(2), { stdio: ["ignore", "inherit", "inherit", "pipe", "pipe"] });
const fromKit = fs.createReadStream(null, { fd: 3 });
const toKit = fs.createWriteStream(null, { fd: 4 });
for (const stream of [fromKit, toKit, child.stdio[3], child.stdio[4]]) stream.on("error", () => {});
const note = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
const page = ${JSON.stringify(page)} ? new RegExp(${JSON.stringify(page)}) : null;
const opened = new Set();
// The tab crashed and the screenshot under way there, once it is sent.
let crashing = null;
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
  if (msg.method === "Page.navigate" && msg.sessionId && (!page || page.test(msg.params.url))) opened.add(msg.sessionId);
  child.stdio[3].write(text + "\\0");
  if (!crashing && msg.method === "Page.captureScreenshot" && opened.has(msg.sessionId)) {
    crashing = { session: msg.sessionId, id: msg.id, answered: false };
    note("Page.crash");
    child.stdio[3].write(JSON.stringify({ id: 2000000000, sessionId: crashing.session, method: "Page.crash", params: {} }) + "\\0");
  }
});
split(child.stdio[4], (text) => {
  const msg = JSON.parse(text);
  if (msg.id === 2000000000) return;
  if (crashing && msg.id === crashing.id && msg.sessionId === crashing.session) {
    if (crashing.answered) return;
    crashing.answered = true;
  }
  if (crashing && msg.method === "Inspector.targetCrashed" && msg.sessionId === crashing.session) {
    if (!crashing.answered) {
      crashing.answered = true;
      toKit.write(JSON.stringify({ id: crashing.id, sessionId: crashing.session, error: { code: -32000, message: "Unable to capture screenshot" } }) + "\\0");
    }
    note("Inspector.targetCrashed");
    return void setTimeout(() => toKit.write(text + "\\0"), 150);
  }
  toKit.write(text + "\\0");
});
fromKit.on("end", () => child.stdio[3].end());
child.on("exit", (code) => process.exit(code === null ? 1 : code));
`,
  );
  const wrapper = path.join(root, "crashing-chrome");
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(script)} "$@"\n`, { mode: 0o755 });
  return { browser: wrapper, crashed: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

// Runs the command line with args and resolves to how it ended: { status,
// stdout, stderr } once it has, or { stdout, stderr, held: true } when it had
// printed its whole JSON (--json) holdMs before and still had not exited, as
// a run held by a program left running did; it is killed then.
function runUntilOver(cli, args, { env = process.env, holdMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = "";
    let stderr = "";
    let timer = null;
    child.stdout.on("data", (d) => {
      stdout += d;
      if (timer || !/\n\}\n$/.test(stdout)) return;
      timer = setTimeout(() => {
        resolve({ stdout, stderr, held: true });
        child.kill("SIGKILL");
      }, holdMs);
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

// Servers of this process standing in for sites on the public internet: the
// run's proxy connects the browser only to an address its rule judged (see
// proxy.js), the one the name's lookup gave, so a test whose names resolve
// to public addresses (see withNames() in the tests) has the proxy's
// connections to those addresses go to its servers on 127.0.0.1 instead.
// map: by "address" or "address:port", where the connection goes, as
// "127.0.0.1" on the same port or "127.0.0.1:<port>". A connection to any
// other address on the public internet fails, as no connection leaves this
// machine in a test, and one to an address that is not goes as it would.
// made(): the connections asked for, as "address:port", in order. Returns
// { made, restore }, restore putting the proxy's own back.
function reachAt(map) {
  const net = require("node:net");
  const { dialer } = require("../skills/easyscreenshotkit/scripts/lib/proxy");
  const { notPublicIp } = require("../skills/easyscreenshotkit/scripts/lib/address");
  const before = dialer.connect;
  const made = [];
  dialer.connect = (options) => {
    const at = `${options.host}:${options.port}`;
    made.push(at);
    const to = map[at] ?? map[options.host];
    if (to !== undefined) {
      const [host, port] = String(to).split(":");
      return before({ ...options, host, port: port ? Number(port) : options.port, family: 4 });
    }
    if (notPublicIp(options.host)) return before(options);
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(Object.assign(new Error(`no connection leaves this machine in a test: ${at}`), { code: "ECONNREFUSED" })));
    return socket;
  };
  return { made: () => [...made], restore: () => (dialer.connect = before) };
}

// A DNS server of a site's that answers the first question for each name of
// `names` with a public address, 93.184.215.14, and each later one with
// 127.0.0.1, as such a server can. A name is the same to it with the dots
// at its end or without, as the system's lookup asks it for cdn.example.
// and for cdn.example alike. Each request of the kit's to such a name stops
// before it connects, and reached() resolves to the addresses the lookup it
// was given hands back, the ones it would connect to; asked(): the names
// the DNS was asked for. Other names are looked up, and requests to other
// hosts sent, as they would be.
async function withRebinding(names, body) {
  const dns = require("node:dns");
  const https = require("node:https");
  const bare = (host) => String(host).replace(/\.+$/, "").toLowerCase();
  const held = (host) => names.includes(bare(host));
  const lookup = dns.lookup;
  const asked = [];
  dns.lookup = (host, options, callback) => {
    if (typeof options === "function") [options, callback] = [{}, options];
    if (!held(host)) return lookup(host, options, callback);
    const before = asked.filter((one) => bare(one) === bare(host)).length;
    asked.push(host);
    const address = before ? "127.0.0.1" : "93.184.215.14";
    process.nextTick(callback, null, options && options.all ? [{ address, family: 4 }] : address, 4);
  };
  const reached = [];
  const saved = [http, https].map((client) => client.get);
  [http, https].forEach((client, i) => {
    client.get = (url, options, ...rest) => {
      const at = url instanceof URL ? url : new URL(String(url));
      if (!held(at.hostname)) return saved[i].call(client, url, options, ...rest);
      const resolve = (options && options.lookup) || dns.lookup;
      reached.push(new Promise((done) => resolve(at.hostname, { all: true }, (err, list) => done(err ? err.code : list.map((one) => one.address).join(",")))));
      throw new Error(`no request leaves this machine in a test: ${at.href}`);
    };
  });
  try {
    return await body({ reached: () => Promise.all(reached), asked: () => [...asked] });
  } finally {
    dns.lookup = lookup;
    [http, https].forEach((client, i) => (client.get = saved[i]));
  }
}

module.exports = { readPng, pngOf, serve, near, descendants, relayBrowser, crashingBrowser, runUntilOver, tempProblem, sh, reachAt, withRebinding };
