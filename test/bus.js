"use strict";

// A session bus of the tests' own, and a stand-in for the desktop's portal
// on it, for the tests that hold the browser to handing an address such as
// mailto: to no program of the machine. On a Linux desktop the browser hands
// such an address to the portal (org.freedesktop.portal.OpenURI) over the
// session bus, and the portal starts the user's mail program: a test that
// reached the user's own bus would open it. This bus starts no service of
// its own, and the stand-in only writes down what it was asked.

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PORTAL = "org.freedesktop.portal.Desktop";

// Why a bus of the tests' own cannot be had in a folder made in root here,
// or "": dbus-daemon takes a socket path of 99 bytes at most.
function noBus(root) {
  if (process.platform !== "linux") return "the desktop's portal is on Linux only";
  if (Buffer.byteLength(path.join(root, "bus-XXXXXX", "bus")) > 99) return "the temp folder's path is too long for a bus's socket";
  const found = spawnSync("dbus-daemon", ["--version"], { stdio: "ignore" });
  return found.error || found.status !== 0 ? "dbus-daemon is not installed" : "";
}

// Starts a session bus listening in dir, as bus, where a program that is
// given no address can look for it when XDG_RUNTIME_DIR is dir. It activates
// no service, so nothing on it but the stand-in answers. Resolves to {
// address, dir, close }.
async function privateBus(dir) {
  const socket = path.join(dir, "bus");
  const config = path.join(dir, "bus.conf");
  fs.writeFileSync(
    config,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:path=${socket}</listen><auth>EXTERNAL</auth>
<policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
`,
  );
  const daemon = spawn("dbus-daemon", [`--config-file=${config}`, "--nofork", "--print-address=1"], { stdio: ["ignore", "pipe", "ignore"] });
  const address = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error("dbus-daemon did not start")), 10_000);
    daemon.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) {
        clearTimeout(timer);
        resolve(out.trim().split("\n")[0]);
      }
    });
    daemon.on("exit", () => reject(new Error("dbus-daemon ended")));
  });
  return {
    address,
    dir,
    close: () =>
      new Promise((resolve) => {
        if (daemon.exitCode !== null) return resolve();
        daemon.once("exit", resolve);
        daemon.kill("SIGTERM");
      }),
  };
}

// ─── the wire format of D-Bus, as little of it as the stand-in needs ─────

const align = (n, to) => (n + to - 1) & ~(to - 1);

// Values written one after another, each at its own alignment.
function writer() {
  let buf = Buffer.alloc(0);
  const pad = (to) => {
    const at = align(buf.length, to);
    if (at > buf.length) buf = Buffer.concat([buf, Buffer.alloc(at - buf.length)]);
  };
  const raw = (bytes) => (buf = Buffer.concat([buf, bytes]));
  const w = {
    byte: (v) => raw(Buffer.from([v])),
    uint32: (v) => {
      pad(4);
      const b = Buffer.alloc(4);
      b.writeUInt32LE(v);
      raw(b);
    },
    string: (s) => {
      const bytes = Buffer.from(s, "utf8");
      w.uint32(bytes.length);
      raw(Buffer.concat([bytes, Buffer.from([0])]));
    },
    signature: (s) => {
      raw(Buffer.from([Buffer.byteLength(s)]));
      raw(Buffer.concat([Buffer.from(s, "ascii"), Buffer.from([0])]));
    },
    pad,
    get length() {
      return buf.length;
    },
    get buffer() {
      return buf;
    },
  };
  return w;
}

// A message: type 1 a call, 2 a reply, 3 an error. fields: [code, kind,
// value], kind one of s, o, u, g. body: a writer that wrote it, signature
// the body's.
function message(type, serial, fields, body = null, signature = "") {
  const all = signature ? [...fields, [8, "g", signature]] : fields;
  // Each value is aligned from the start of the message.
  const m = writer();
  m.byte(0x6c);
  m.byte(type);
  m.byte(0);
  m.byte(1);
  m.uint32(body ? body.length : 0);
  m.uint32(serial);
  m.uint32(0);
  const start = m.length;
  for (const [code, kind, value] of all) {
    m.pad(8);
    m.byte(code);
    m.signature(kind);
    if (kind === "u") m.uint32(value);
    else if (kind === "g") m.signature(value);
    else m.string(value);
  }
  m.buffer.writeUInt32LE(m.length - start, 12);
  m.pad(8);
  return Buffer.concat([m.buffer, body ? body.buffer : Buffer.alloc(0)]);
}

// Reads one message from the front of buf: { type, serial, fields, body,
// size }, or null when it is not all there yet.
function readMessage(buf) {
  if (buf.length < 16) return null;
  const bodyLength = buf.readUInt32LE(4);
  const arrayLength = buf.readUInt32LE(12);
  const size = align(16 + arrayLength, 8) + bodyLength;
  if (buf.length < size) return null;
  const fields = {};
  let at = 16;
  while (at < 16 + arrayLength) {
    at = align(at, 8);
    const code = buf[at++];
    const sigLength = buf[at++];
    const kind = buf.toString("ascii", at, at + sigLength);
    at += sigLength + 1;
    if (kind === "u") {
      at = align(at, 4);
      fields[code] = buf.readUInt32LE(at);
      at += 4;
    } else if (kind === "g") {
      const length = buf[at++];
      fields[code] = buf.toString("ascii", at, at + length);
      at += length + 1;
    } else {
      at = align(at, 4);
      const length = buf.readUInt32LE(at);
      fields[code] = buf.toString("utf8", at + 4, at + 4 + length);
      at += 4 + length + 1;
    }
  }
  const bodyAt = align(16 + arrayLength, 8);
  return { type: buf[1], serial: buf.readUInt32LE(8), fields, body: buf.subarray(bodyAt, bodyAt + bodyLength), size };
}

// The strings at the start of a body whose signature starts with them.
function strings(body, count) {
  const out = [];
  let at = 0;
  for (let i = 0; i < count && at + 4 <= body.length; i++) {
    at = align(at, 4);
    const length = body.readUInt32LE(at);
    out.push(body.toString("utf8", at + 4, at + 4 + length));
    at += 4 + length + 1;
  }
  return out;
}

// Takes the portal's name on the bus at address and answers as the portal
// does: its version, and a request for each address it is asked to open,
// which it writes down and does nothing with. Resolves to { opened: the
// addresses it was asked to open, asked: every method it was called with,
// close }.
async function fakePortal(address) {
  const socket = /^unix:path=([^,]+)/.exec(address)[1];
  const conn = net.createConnection(socket);
  await new Promise((resolve, reject) => {
    conn.once("connect", resolve);
    conn.once("error", reject);
  });
  const opened = [];
  const asked = [];
  let serial = 0;
  let buf = Buffer.alloc(0);
  let authed = false;
  let waiting = null;
  const replies = new Map();
  const call = (fields, body = null, signature = "") => {
    const n = ++serial;
    conn.write(message(1, n, fields, body, signature));
    return new Promise((resolve) => replies.set(n, resolve));
  };
  const reply = (to, body, signature) => conn.write(message(2, ++serial, [[5, "u", to.serial], [6, "s", to.fields[7]]], body, signature));
  const refuse = (to) => {
    const body = writer();
    body.string("not here");
    conn.write(message(3, ++serial, [[4, "s", "org.freedesktop.DBus.Error.UnknownMethod"], [5, "u", to.serial], [6, "s", to.fields[7]]], body, "s"));
  };
  conn.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (!authed) {
      const line = buf.indexOf("\r\n");
      if (line < 0) return;
      const said = buf.toString("ascii", 0, line);
      buf = buf.subarray(line + 2);
      if (!said.startsWith("OK")) throw new Error(`the bus said ${said}`);
      authed = true;
      conn.write("BEGIN\r\n");
      waiting();
    }
    for (;;) {
      const m = readMessage(buf);
      if (!m) break;
      buf = buf.subarray(m.size);
      if ((m.type === 2 || m.type === 3) && replies.has(m.fields[5])) {
        replies.get(m.fields[5])(m);
        replies.delete(m.fields[5]);
        continue;
      }
      if (m.type !== 1) continue;
      const member = `${m.fields[2] || ""}.${m.fields[3] || ""}`;
      asked.push(member);
      if (member === "org.freedesktop.DBus.Properties.Get") {
        const body = writer();
        body.signature("u");
        body.uint32(4);
        reply(m, body, "v");
      } else if (member === "org.freedesktop.portal.OpenURI.OpenURI" || member === "org.freedesktop.portal.OpenURI.OpenFile") {
        opened.push(strings(m.body, 2)[1] || "");
        const body = writer();
        body.string("/org/freedesktop/portal/desktop/request/1_1/t");
        reply(m, body, "o");
      } else refuse(m);
    }
  });
  const ready = new Promise((resolve) => (waiting = resolve));
  conn.write(Buffer.from([0]));
  conn.write(`AUTH EXTERNAL ${Buffer.from(String(process.getuid())).toString("hex")}\r\n`);
  await ready;
  const bus = [[1, "o", "/org/freedesktop/DBus"], [2, "s", "org.freedesktop.DBus"], [6, "s", "org.freedesktop.DBus"]];
  await call([...bus, [3, "s", "Hello"]]);
  const name = writer();
  name.string(PORTAL);
  name.uint32(4);
  await call([...bus, [3, "s", "RequestName"]], name, "su");
  return { opened, asked, close: () => conn.destroy() };
}

module.exports = { noBus, privateBus, fakePortal, PORTAL };
