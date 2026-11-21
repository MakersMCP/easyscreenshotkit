"use strict";

// What the kit's browser sends on the networks of the machine past the
// run's proxy, seen in a network namespace of a test's own (see the test in
// proxy.test.js that runs this file). Run as
//
//   unshare -rn node network.js outer <uid> <gid>
//
// it is root of a user namespace of its own with a network of its own: it
// brings up the loopback and a dummy network, 192.168.99.1/24, that nothing
// leaves, with the multicast range and every other address routed there,
// and stands in on it for what the browser could reach past its proxy:
// devices that answer a search for screens to cast to, over SSDP (a DIAL
// device) and over mDNS (a Cast device), each with a server of its own on
// 192.168.99.1 that notes every connection, and the DNS servers the
// machine's /etc/resolv.conf names. It serves a page that asks whether a
// screen to cast to is there (PresentationRequest.getAvailability(), which
// needs no click and no permission) and gives WebRTC two candidates of the
// other side by name, one under .local and one not. Then it runs itself
// again as `inner`, as the user who ran the test (unshare -U), so the
// browser keeps its sandbox: there the kit's own launch() opens the page,
// waits, and says what the page showed and which names the kit's process
// looked up itself. Last it prints one line of JSON: { shown, ssdp, mdns,
// dns, connections, joined }, the names asked over mDNS and of the DNS
// servers but those the kit's process looked up itself, as its proxy does
// for the requests it judges, the connections the stand-in devices got, and
// the multicast groups something but the stand-ins joined on the network.
//
// Run as
//
//   unshare -rn node network.js alone <uid> <gid> <cli> <folder>
//
// it brings up the loopback alone, as on a machine with no network, or in a
// container with none, and has the kit's command take a site it serves on
// 127.0.0.1, given as http://localhost:<port>/, as the user who ran the
// test, saving in <folder>. It prints one line of JSON: { status, said },
// the command's exit code and the last lines it printed on stderr.

const { spawn, spawnSync } = require("node:child_process");
const dgram = require("node:dgram");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");

const LAN = "192.168.99.1";
const CAST_NAME = "esgw-cast._googlecast._tcp.local";
const PROBE_LOCAL = "esgw-chosen-name-1.local";
const PROBE_DNS = "esgw-dns-probe-a.example";

// The first question's name of a DNS or mDNS message, whether it is a
// question (not an answer), and where its name ends.
function questionOf(message) {
  const labels = [];
  let at = 12;
  while (at < message.length && message[at] && labels.length < 64) {
    labels.push(message.subarray(at + 1, at + 1 + message[at]).toString("latin1"));
    at += 1 + message[at];
  }
  return { name: labels.join("."), question: message.length > 12 && !(message[2] & 0x80), end: at + 1 };
}

// A name as DNS writes it.
const nameOf = (name) => Buffer.concat([...name.split(".").map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);

// One record of an mDNS answer: name, type, class with the cache flush bit,
// a TTL of two minutes, and its data.
function record(name, type, data, flush = true) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(flush ? 0x8001 : 1, 2);
  head.writeUInt32BE(120, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([nameOf(name), head, data]);
}

// The mDNS answer of a Cast device at 192.168.99.1 on `port`: where its
// service is, its name and its address.
function castAnswer(port) {
  const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 3]);
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(port, 4);
  const txt = Buffer.concat(["id=0123456789abcdef0123456789abcdef", "md=Chromecast", "fn=Test screen", "ve=05", "ca=4101", "st=0", "rs=", "ic=/setup/icon.png"].map((entry) => Buffer.concat([Buffer.from([entry.length]), Buffer.from(entry)])));
  return Buffer.concat([
    header,
    record("_googlecast._tcp.local", 12, nameOf(CAST_NAME), false),
    record(CAST_NAME, 33, Buffer.concat([srv, nameOf("esgw-cast.local")])),
    record(CAST_NAME, 16, txt),
    record("esgw-cast.local", 1, Buffer.from(LAN.split(".").map(Number))),
  ]);
}

const PAGE = `<!doctype html><title>Network</title><h1>Network</h1><script>
const shown = [];
const say = (word) => { shown.push(word); document.title = shown.join(" "); };
try {
  new PresentationRequest("https://cast.example/receiver").getAvailability().then(() => say("asked"), (e) => say("refused " + e.name));
} catch (e) { say("threw " + e.name); }
(async () => {
  try {
    const one = new RTCPeerConnection();
    one.createDataChannel("x");
    const two = new RTCPeerConnection();
    const offer = await one.createOffer();
    await one.setLocalDescription(offer);
    await two.setRemoteDescription(offer);
    const answer = await two.createAnswer();
    await two.setLocalDescription(answer);
    await one.setRemoteDescription(answer);
    const mid = answer.sdp.match(/a=mid:(\\S+)/)[1];
    for (const host of ${JSON.stringify([PROBE_LOCAL, PROBE_DNS])}) await one.addIceCandidate({ candidate: "candidate:5 1 udp 2122260223 " + host + " 4444 typ host", sdpMid: mid, sdpMLineIndex: 0 });
    say("candidates");
  } catch (e) { say("rtc " + e.name); }
})();
</script>`;

const ip = (...args) => {
  const done = spawnSync("ip", args, { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`ip ${args.join(" ")}: ${String(done.stderr || done.error).trim()}`);
};

async function outer(uid, gid) {
  ip("link", "set", "lo", "up");
  ip("link", "add", "d0", "type", "dummy");
  ip("link", "set", "d0", "up", "multicast", "on");
  ip("addr", "add", `${LAN}/24`, "dev", "d0");
  ip("route", "add", "224.0.0.0/4", "dev", "d0");
  ip("route", "add", "default", "dev", "d0");
  const seen = { ssdp: 0, mdns: [], dns: [], connections: [] };
  const sockets = [];
  const listening = [];
  const bound = (socket, ...args) => new Promise((resolve) => socket.bind(...args, resolve));
  // A server that notes every connection made to it and its first line.
  const device = (label) => {
    const server = net.createServer((socket) => {
      seen.connections.push(label);
      socket.on("error", () => {});
      socket.once("data", (data) => seen.connections.push(`${label}: ${data[0] === 0x16 ? "a TLS handshake" : data.toString("latin1").split(/\r?\n/)[0].slice(0, 80)}`));
      setTimeout(() => socket.destroy(), 300);
    });
    listening.push(new Promise((resolve) => server.listen(0, LAN, resolve)));
    sockets.push(server);
    return server;
  };
  const dial = device("DIAL device");
  const cast = device("Cast device");
  await Promise.all(listening);
  // The DIAL device answers a search with where its description is.
  const ssdp = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sockets.push(ssdp);
  ssdp.on("message", (message, from) => {
    if (!/^M-SEARCH/.test(message.toString("latin1"))) return;
    seen.ssdp++;
    ssdp.send(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\nLOCATION: http://${LAN}:${dial.address().port}/dd.xml\r\nSERVER: Linux/1 UPnP/1.0 test/1\r\nST: urn:dial-multiscreen-org:service:dial:1\r\nUSN: uuid:00000000-0000-0000-0000-000000000001::urn:dial-multiscreen-org:service:dial:1\r\n\r\n`, from.port, from.address);
  });
  await bound(ssdp, 1900);
  ssdp.addMembership("239.255.255.250", LAN);
  // The Cast device answers a question for Cast devices, to the network.
  const mdns = dgram.createSocket({ type: "udp4", reuseAddr: true });
  sockets.push(mdns);
  mdns.on("message", (message, from) => {
    const { name, question } = questionOf(message);
    if (!question) return;
    seen.mdns.push(name);
    if (name !== "_googlecast._tcp.local") return;
    const answer = castAnswer(cast.address().port);
    mdns.send(answer, 5353, "224.0.0.251");
    if (from.port !== 5353) mdns.send(answer, from.port, from.address);
  });
  await bound(mdns, 5353);
  mdns.addMembership("224.0.0.251", LAN);
  mdns.setMulticastInterface(LAN);
  // The DNS servers the machine names, each at its own address, which goes
  // on the dummy network unless it is on the loopback.
  const resolvConf = (() => {
    try {
      return fs.readFileSync("/etc/resolv.conf", "utf8");
    } catch {
      return "";
    }
  })();
  const servers = [...resolvConf.matchAll(/^\s*nameserver\s+(\d+\.\d+\.\d+\.\d+)\s*$/gm)].map((m) => m[1]);
  for (const server of new Set(servers)) {
    if (!server.startsWith("127.")) ip("addr", "add", `${server}/32`, "dev", "d0");
    const udp = dgram.createSocket("udp4");
    sockets.push(udp);
    // Each question is noted and answered at once that no such name is
    // there, so the lookups the kit's own process makes end quickly.
    udp.on("message", (message, from) => {
      const { name, end } = questionOf(message);
      seen.dns.push(name);
      if (end + 4 > message.length) return;
      const header = Buffer.from([message[0], message[1], 0x81, 0x83, 0, 1, 0, 0, 0, 0, 0, 0]);
      udp.send(Buffer.concat([header, message.subarray(12, end + 4)]), from.port, from.address);
    });
    await bound(udp, 53, server);
    const tcp = net.createServer((socket) => {
      seen.dns.push("(over TCP)");
      socket.destroy();
    });
    sockets.push(tcp);
    await new Promise((resolve) => tcp.listen(53, server, resolve));
  }
  // The multicast groups a socket on the dummy network has joined beyond the
  // stand-ins' own and the system's all-hosts group, by /proc/net/igmp,
  // which counts the sockets that joined each: a browser that listens for
  // mDNS joins 224.0.0.251, and says so to the network as it does.
  const ours = { FB0000E0: 1, FAFFFFEF: 1, "010000E0": 1 };
  const joined = new Set();
  const groups = setInterval(() => {
    let table = "";
    try {
      table = fs.readFileSync("/proc/net/igmp", "utf8");
    } catch {
      return;
    }
    let device = "";
    for (const line of table.split("\n")) {
      const head = /^\d+\s+(\S+)\s*:/.exec(line);
      if (head) device = head[1];
      const group = /^\s+([0-9A-F]{8})\s+(\d+)/.exec(line);
      if (group && device === "d0" && Number(group[2]) > (ours[group[1]] || 0)) joined.add(group[1].match(/../g).reverse().map((byte) => parseInt(byte, 16)).join("."));
    }
  }, 50);
  sockets.push({ close: () => clearInterval(groups) });
  const page = http.createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGE));
  sockets.push(page);
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${page.address().port}/`;
  const told = await new Promise((resolve) => {
    const child = spawn("unshare", ["-U", `--map-user=${uid}`, `--map-group=${gid}`, process.execPath, __filename, "inner", url], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ failed: `the kit's run ended with ${code}: ${(out + err).trim().split("\n").slice(-3).join(" | ")}` });
      }
    });
  });
  // A moment for what is still on its way.
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const socket of sockets) socket.close();
  const own = new Set((told.looked || []).map((name) => String(name).replace(/\.$/, "").toLowerCase()));
  process.stdout.write(`${JSON.stringify({ failed: told.failed || "", shown: told.shown || "", ssdp: seen.ssdp, mdns: seen.mdns, dns: seen.dns.filter((name) => !own.has(String(name).toLowerCase())), connections: seen.connections, joined: [...joined] })}\n`);
}

async function inner(url) {
  const dns = require("node:dns");
  const looked = new Set();
  const lookup = dns.lookup;
  dns.lookup = (host, ...rest) => {
    looked.add(String(host));
    return lookup(host, ...rest);
  };
  const { launch, openTab, closeTab, navigate } = require("../skills/easyscreenshotkit/scripts/lib/chrome");
  const { guardFor } = require("../skills/easyscreenshotkit/scripts/lib/address");
  const { setTimeLimit, sleep } = require("../skills/easyscreenshotkit/scripts/lib/time");
  setTimeLimit(80_000);
  const chrome = await launch({ guard: await guardFor(url) });
  let shown = "";
  try {
    const tab = await openTab(chrome, { width: 1200, height: 800, scale: 1, mobile: false, touch: false, agent: "desktop" });
    try {
      await navigate(tab, url);
      // The searches go out as soon as the page asks; the connections to
      // what answered follow within a second or two.
      const until = Date.now() + 6_000;
      while (Date.now() < until) {
        const { result } = await tab.send("Runtime.evaluate", { expression: "document.title", returnByValue: true });
        shown = String(result.value || "");
        await sleep(250);
      }
    } finally {
      await closeTab(chrome, tab);
    }
  } finally {
    await chrome.close();
  }
  process.stdout.write(JSON.stringify({ shown, looked: [...looked] }));
}

async function alone(uid, gid, cli, folder) {
  ip("link", "set", "lo", "up");
  const page = http.createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><title>Local</title><h1>Local</h1><p>A site served on this machine.</p>"));
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
  const told = await new Promise((resolve) => {
    const child = spawn("unshare", ["-U", `--map-user=${uid}`, `--map-group=${gid}`, process.execPath, cli, `http://localhost:${page.address().port}/`, "--pages", "1", "--sizes", "desktop", "--out", folder], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 100_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code === null ? signal : code, said: err.trim().split("\n").slice(-3).join(" | ") });
    });
  });
  page.close();
  process.stdout.write(`${JSON.stringify(told)}\n`);
}

const [mode, ...rest] = process.argv.slice(2);
(mode === "outer" ? outer(...rest) : mode === "alone" ? alone(...rest) : inner(...rest)).catch((err) => {
  process.stdout.write(JSON.stringify({ failed: String((err && err.message) || err) }));
  process.exitCode = 1;
});
