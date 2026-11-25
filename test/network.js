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
//
// Run as
//
//   unshare -rmn sh -c '... mount --bind <resolv.conf> /etc/resolv.conf
//     && mount --bind <hosts> /etc/hosts && exec node network.js silent
//     <uid> <gid> <cli> <folder> <names>'
//
// with a resolv.conf that names 127.0.0.1 and a hosts file that holds
// cdn.good.example at 93.184.216.34, it stands a DNS server on 127.0.0.1
// that takes every question and answers none, as for names whose servers
// are gone, and serves a page that asks for a picture on each of <names>
// such names and, half a second later, for one on cdn.good.example, which
// the kit's proxy is told to reach at the page's own server (DIAL_TO, read
// by the preload this file is with --require); with <names> "burst", a
// page that fetch()es from 40 other such names over https as it has
// loaded: the browser asks the proxy for a tunnel to each, 32 at once at
// most, where it sends a page's pictures a few at a time, and plain http
// requests through a proxy 6 at a time; with <names> "endless", a page that
// fetch()es from another such name over https every tenth of a second for
// as long as it is open. The kit's command takes it as the user who ran the
// test, with --json, saving in <folder>, or with <command> "demo" records a
// demo of it, with no GIF. It prints one line of JSON: { status, said,
// manifest, after, asked, quiet }, the exit code, the last lines on stderr,
// the manifest it printed and how long its process lived after it printed
// it, in ms, each name the DNS server was asked, once, as [name, when it
// was first asked, in ms after the manifest was printed, under 0 before],
// and how long the process lived after the server's last question, in ms.
//
// Run as
//
//   unshare -rmn sh -c 'ip link set lo up && mount --bind <hosts> /etc/hosts
//     && exec node network.js mixed <uid> <gid> <cli> <folder>'
//
// with a hosts file that holds evil.example at SITE6 and at 127.0.0.1, and
// mixdev.example at 127.0.0.1 alone, it stands in for a machine with a
// global IPv6 address of its own and a service of its own on 127.0.0.1:80,
// which notes each request, joined by a veth link to the site's network
// namespace (see siteMixed()): the site at SITE6 serves a home page that
// fetch()es /secret from its own address and shows what it read, and turns
// away every connection after it. The kit's command takes
// http://evil.example/ and then http://mixdev.example/, as the user who ran
// the test, with --json, saving in <folder>-0 and <folder>-1. It prints one
// line of JSON: { runs, seen, site }, for each run { url, status, said,
// titles }, then the requests the machine's service got and those the
// site got.
//
// Run as
//
//   unshare -rmn sh -c 'ip link set lo up && mount --bind <hosts> /etc/hosts
//     && exec node network.js routed <uid> <gid> <cli> <folder>'
//
// with a hosts file that holds app1.test, app2.test and app3.test at
// 127.0.0.1, it stands in for a machine that serves several sites at one
// address and port, a program there picking each by its name, as Laravel
// Valet or Herd, DDEV's router or a web server with virtual hosts does (see
// routed()). The kit's command takes http://app1.test/ and then
// http://app3.test/, as the user who ran the test, with --json, saving in
// <folder>-0 and <folder>-1. It prints one line of JSON: { runs, seen }, for
// each run { url, status, said, titles, notes }, then the requests the
// server got, each as the name it was asked for and the path.
//
// Run as
//
//   unshare -rn node network.js downed
//
// it stands in for a machine whose kernel takes a connection to more of its
// addresses for one to itself than its interfaces that are up and have a
// link hold (see DOWNED), with a service of its own on port 80 and 443 of
// all its addresses that notes each connection. With the run's rule for a
// site on the public internet, it asks for each address of DOWNED by the
// rule's refuses(), through the run's proxy as the browser asks, a plain
// http request to port 80 and a tunnel to port 443, and as a request of the
// kit's own (getChecked()). It prints one line of JSON: { judged, seen },
// for each address { refuses, http, tunnel, kit }, the first line of what
// the proxy answered ("" for none) and what the kit's request gave, and
// the connections the service got.
//
// Run as
//
//   unshare -rn node network.js networks
//
// it stands in for a machine whose interfaces hold IPv6 addresses on
// networks of its own (see NETWORKS): n0 a 6to4 address, which a network
// builds from the IPv4 address of its 6to4 router, another box's, and v0
// an address at /128 with the network's /64 a route alone, as a DHCPv6
// client holds the address it gets and a router's advertisement gives the
// network. The rest
// of each network is in a network namespace of its own, joined to the
// machine by a veth link (see devices()), where the router at the prefix's
// ::1 and another device answer on port 80 and note each request. It asks
// for each address of NETWORKS as downed() does, with a service of the
// machine's own on port 80 and 443 of all its addresses, and prints one
// line of JSON: { judged, seen, devices }, as downed() does, and the
// requests the devices got.

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
  // A name the kit's process looked up comes to the server again with each
  // domain of the machine's search list after it, as the system's resolver
  // tries those once the name alone is not found: on GitHub's runners,
  // clients2.google.com.ec2.internal for clients2.google.com. Those are the
  // kit's own lookups too.
  const searched = [...resolvConf.matchAll(/^\s*(?:search|domain)\s+(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/)).map((d) => d.replace(/\.$/, "").toLowerCase()).filter(Boolean);
  const ownLookup = (name) => {
    const lower = String(name).toLowerCase();
    return own.has(lower) || searched.some((d) => lower.endsWith(`.${d}`) && own.has(lower.slice(0, -d.length - 1)));
  };
  process.stdout.write(`${JSON.stringify({ failed: told.failed || "", shown: told.shown || "", ssdp: seen.ssdp, mdns: seen.mdns, dns: seen.dns.filter((name) => !ownLookup(name)), connections: seen.connections, joined: [...joined] })}\n`);
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

async function silent(uid, gid, cli, folder, names, command = "shots") {
  ip("link", "set", "lo", "up");
  const dns = dgram.createSocket("udp4");
  // When each name was first asked, and when the last question came.
  const asked = new Map();
  let last = 0;
  dns.on("message", (message) => {
    last = Date.now();
    const labels = [];
    for (let at = 12; at < message.length && message[at] > 0 && message[at] < 64; at += message[at] + 1) labels.push(message.toString("latin1", at + 1, at + 1 + message[at]));
    const name = labels.join(".").toLowerCase();
    if (!asked.has(name)) asked.set(name, last);
  });
  await new Promise((resolve) => dns.bind(53, "127.0.0.1", resolve));
  const dead = ["burst", "endless"].includes(names) ? [] : Array.from({ length: Number(names) }, (_, i) => `http://dead${i + 1}.example/x.png`);
  const burst = names === "burst" ? '<script>addEventListener("load", () => { for (let n = 1; n <= 40; n++) fetch("https://dead-b" + n + ".example/x", { mode: "no-cors" }).catch(() => {}); });</script>' : names === "endless" ? '<script>let n = 0; setInterval(() => fetch("https://dead-e" + ++n + ".example/x", { mode: "no-cors" }).catch(() => {}), 100);</script>' : "";
  const page = http.createServer((req, res) => {
    if (req.url === "/logo.svg") return res.writeHead(200, { "Content-Type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="rgb(0,160,0)"/></svg>');
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Acme | Tools</title><h1>Acme</h1><p>Tools for teams.</p>${dead.map((src) => `<img src="${src}">`).join("")}<script>setTimeout(() => { const img = new Image(); img.onload = () => (document.title = "Acme | Loaded"); img.src = "http://cdn.good.example/logo.svg"; document.body.append(img); }, 500);</script>${burst}<div style="height:1400px"></div>`);
  });
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
  const told = await new Promise((resolve) => {
    const given = `http://127.0.0.1:${page.address().port}/`;
    const args = ["-U", `--map-user=${uid}`, `--map-group=${gid}`, process.execPath, "--require", __filename, cli, ...(command === "demo" ? ["demo", given, "--pages", "1", "--no-gif"] : [given, "--pages", "1", "--sizes", "desktop"]), "--json", "--out", folder];
    const child = spawn("unshare", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DIAL_TO: `127.0.0.1:${page.address().port}` } });
    let out = "";
    let err = "";
    let printed = 0;
    child.stdout.on("data", (d) => {
      out += d;
      printed = Date.now();
    });
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 150_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let manifest = null;
      try {
        manifest = JSON.parse(out);
      } catch {
        manifest = null;
      }
      const ended = Date.now();
      resolve({ status: code === null ? signal : code, said: err.trim().split("\n").slice(-3).join(" | "), manifest, after: printed ? ended - printed : -1, asked: [...asked].map(([name, at]) => [name, printed ? at - printed : null]), quiet: last ? ended - last : -1 });
    });
  });
  page.close();
  dns.close();
  process.stdout.write(`${JSON.stringify(told)}\n`);
}

// The machine of own(): its global IPv6 address on a network of its own,
// /64, and a public IPv4 address, as a server can hold one; and the site,
// in a network namespace of its own, at a public IPv6 address.
const MACHINE6 = "2a02:1205:5000::1";
const MACHINE4 = "81.2.69.160";
const SITE6 = "2606:2800:220:1::99";

// Run in a network namespace of its own (see own()): the site. It waits
// for the link own() moves into its namespace, takes SITE6 there, and
// serves on port 80 a home page that names the address each connection
// came from, as a site reads it off the run's own connection: a frame, a
// picture and a fetch() there, and a frame at MACHINE4, which it is given;
// a page it links; and a robots.txt whose sitemap is there too. It prints
// "ready" once it serves.
async function site6(machine4) {
  for (let i = 0; i < 200 && spawnSync("ip", ["link", "show", "v1"]).status !== 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  ip("link", "set", "lo", "up");
  ip("link", "set", "v1", "up");
  ip("-6", "addr", "add", `${SITE6}/128`, "dev", "v1", "nodad");
  ip("-6", "route", "add", "default", "dev", "v1");
  const server = http.createServer((req, res) => {
    const from = String(req.socket.remoteAddress || "");
    const at = from.includes(":") ? `[${from}]` : from;
    if (req.url === "/robots.txt") return res.writeHead(200, { "Content-Type": "text/plain" }).end(`User-agent: *\nAllow: /\nSitemap: http://${at}/sitemap.xml\n`);
    if (req.url === "/about") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><title>Acme | About</title><h1>About Acme</h1><p>Who makes the tools, and how.</p><p><a href="/">Home</a></p><div style="height:1400px"></div>');
    if (req.url !== "/") return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Acme</title><h1>Acme</h1><p>Tools for teams.</p><p><a href="/about">About</a></p><iframe src="http://${at}/frame6" width="300" height="100"></iframe><iframe src="http://${machine4}/frame4" width="300" height="100"></iframe><img src="http://${at}/pic.png"><script>fetch("http://${at}/api", { mode: "no-cors" }).catch(() => {});</script>`);
  });
  await new Promise((resolve) => server.listen(80, "::", resolve));
  process.stdout.write("ready\n");
}

// Run as
//
//   unshare -rn node network.js own <uid> <gid> <cli> <folder>
//
// it stands in for a machine whose own addresses are on the public
// internet by their range: MACHINE6 on a network of its own, as a machine
// on an IPv6 network holds one of its own, and MACHINE4. A veth link joins
// it to the site's network namespace (see site6()), and a service of the
// machine's own listens on port 80 of all its addresses, noting each
// request. The kit's command takes the site, http://[SITE6]/, as the user
// who ran the test, with --json, saving in <folder>. It prints one line of
// JSON: { status, said, manifest, seen }, the exit code, the last lines on
// stderr, the manifest it printed, and the requests the machine's service
// got.
async function own(uid, gid, cli, folder) {
  ip("link", "set", "lo", "up");
  ip("link", "add", "v0", "type", "veth", "peer", "name", "v1");
  const site = spawn("unshare", ["-n", process.execPath, __filename, "site6", MACHINE4], { stdio: ["ignore", "pipe", "inherit"] });
  let printed = "";
  site.stdout.on("data", (d) => (printed += d));
  const seen = [];
  const service = http.createServer((req, res) => {
    seen.push(`${req.socket.remoteAddress} ${req.method} ${req.headers.host} ${req.url}`);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><body style="background:red"><h1>THIS MACHINE\'S OWN SERVICE</h1>');
  });
  try {
    // The site's namespace is made once its node has started.
    await new Promise((resolve, reject) => {
      site.once("error", reject);
      site.once("spawn", resolve);
    });
    for (let i = 0; i < 200 && spawnSync("ip", ["link", "show", "v1"]).status === 0; i++) {
      if (spawnSync("ip", ["link", "set", "v1", "netns", String(site.pid)]).status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ip("link", "set", "v0", "up");
    ip("-6", "addr", "add", `${MACHINE6}/64`, "dev", "v0", "nodad");
    ip("addr", "add", `${MACHINE4}/24`, "dev", "v0");
    ip("-6", "route", "add", `${SITE6}/128`, "dev", "v0");
    await new Promise((resolve) => service.listen(80, "::", resolve));
    for (let i = 0; i < 200 && !printed.includes("ready"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!printed.includes("ready")) throw new Error("the site did not start");
    const told = await new Promise((resolve) => {
      const args = ["-U", `--map-user=${uid}`, `--map-group=${gid}`, process.execPath, cli, `http://[${SITE6}]/`, "--pages", "2", "--sizes", "desktop", "--json", "--out", folder];
      const child = spawn("unshare", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        let manifest = null;
        try {
          manifest = JSON.parse(out);
        } catch {
          manifest = null;
        }
        resolve({ status: code === null ? signal : code, said: err.trim().split("\n").slice(-3).join(" | "), manifest });
      });
    });
    // A moment for what is still on its way.
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.stdout.write(`${JSON.stringify({ ...told, seen })}\n`);
  } finally {
    service.close();
    site.kill("SIGKILL");
  }
}

// Run in a network namespace of its own (see mixed()): the site. It waits
// for the link mixed() moves into its namespace, takes SITE6 there, and
// serves on port 80 a home page that fetch()es /secret from its own
// address every 300 ms and shows what it read, then closes its listener
// 50 ms after serving that page, so every connection after it is refused.
// It notes each request it gets on stdout, and prints "ready" once it
// serves.
async function siteMixed() {
  for (let i = 0; i < 200 && spawnSync("ip", ["link", "show", "v1"]).status !== 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
  ip("link", "set", "lo", "up");
  ip("link", "set", "v1", "up");
  ip("-6", "addr", "add", `${SITE6}/128`, "dev", "v1", "nodad");
  ip("-6", "route", "add", "default", "dev", "v1");
  const server = http.createServer((req, res) => {
    process.stdout.write(`site ${req.method} ${req.headers.host} ${req.url}\n`);
    if (req.url !== "/") return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end('<!doctype html><title>Evil</title><h1 id="said">Waiting</h1><script>setInterval(() => fetch("/secret?try=" + Date.now()).then((r) => r.text()).then((text) => { document.getElementById("said").textContent = "READ: " + text; document.title = "READ " + text; }).catch(() => {}), 300);</script><div style="height:1400px"></div>');
    setTimeout(() => server.close(), 50);
  });
  await new Promise((resolve) => server.listen(80, "::", resolve));
  process.stdout.write("ready\n");
}

async function mixed(uid, gid, cli, folder) {
  ip("link", "set", "lo", "up");
  ip("link", "add", "v0", "type", "veth", "peer", "name", "v1");
  const site = spawn("unshare", ["-n", process.execPath, __filename, "siteMixed"], { stdio: ["ignore", "pipe", "inherit"] });
  let printed = "";
  site.stdout.on("data", (d) => (printed += d));
  const seen = [];
  const service = http.createServer((req, res) => {
    seen.push(`${req.socket.remoteAddress} ${req.method} ${req.headers.host} ${req.url}`);
    if (req.url.startsWith("/secret")) return res.writeHead(200, { "Content-Type": "text/plain" }).end("LOCAL SECRET of this machine's own service");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><title>Machine service</title><h1>This machine's own service</h1><div style=\"height:1400px\"></div>");
  });
  try {
    await new Promise((resolve, reject) => {
      site.once("error", reject);
      site.once("spawn", resolve);
    });
    for (let i = 0; i < 200 && spawnSync("ip", ["link", "show", "v1"]).status === 0; i++) {
      if (spawnSync("ip", ["link", "set", "v1", "netns", String(site.pid)]).status === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    ip("link", "set", "v0", "up");
    ip("-6", "addr", "add", `${MACHINE6}/64`, "dev", "v0", "nodad");
    ip("-6", "route", "add", `${SITE6}/128`, "dev", "v0");
    await new Promise((resolve) => service.listen(80, "127.0.0.1", resolve));
    for (let i = 0; i < 200 && !printed.includes("ready"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!printed.includes("ready")) throw new Error("the site did not start");
    const runs = [];
    for (const [n, host] of ["evil.example", "mixdev.example"].entries()) {
      const url = `http://${host}/`;
      runs.push(
        await new Promise((resolve) => {
          const child = spawn("unshare", ["-U", `--map-user=${uid}`, `--map-group=${gid}`, process.execPath, cli, url, "--pages", "1", "--sizes", "desktop", "--json", "--out", `${folder}-${n}`], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          const timer = setTimeout(() => child.kill("SIGKILL"), 100_000);
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            let manifest = null;
            try {
              manifest = JSON.parse(out);
            } catch {
              manifest = null;
            }
            resolve({ url, status: code === null ? signal : code, said: err.trim().split("\n").slice(-3).join(" | "), titles: manifest && manifest.pages ? manifest.pages.map((one) => one.title) : [] });
          });
        }),
      );
    }
    // A moment for what is still on its way.
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.stdout.write(`${JSON.stringify({ runs, seen, site: printed.split("\n").filter((line) => line.startsWith("site ")) })}\n`);
  } finally {
    service.close();
    site.kill("SIGKILL");
  }
}

// Run as
//
//   unshare -rmn sh -c '... mount --bind <hosts> /etc/hosts && exec node
//     network.js upgraded <uid> <gid> <cli> <folder>'
//
// with a hosts file that holds intranet.acme.com at 10.1.2.3 and myapp.test
// at 127.0.0.1, it stands in for a machine on a network of its own whose own
// address is on the public internet, 81.2.69.160, as a server's can be, with
// a site of the network's at 10.1.2.3 that serves on port 80, a site of the
// machine's own there too, and a site on 127.0.0.1:80 whose page holds a
// frame of https://myapp.test/frame. On port 443 of every address another
// program notes each connection and ends it. The kit's command takes each
// by http, at http://intranet.acme.com/, at http://81.2.69.160/ and at
// http://myapp.test/, as the user who ran the test, with --json, saving in
// <folder>. The browser tries the first two over https on 443 first by
// itself, and myapp.test, a name under no domain of the internet, by http
// alone. It prints one line of JSON: { runs }, for each { url, status, said,
// titles, notes, tls }, the exit code, the last lines on stderr, the titles
// of the pages it took, the first page's notes and how many connections the
// program on 443 got while it ran.
async function upgraded(uid, gid, cli, folder) {
  ip("link", "set", "lo", "up");
  ip("link", "add", "d0", "type", "dummy");
  ip("link", "set", "d0", "up");
  ip("addr", "add", "10.1.2.3/32", "dev", "d0");
  ip("addr", "add", "81.2.69.160/32", "dev", "d0");
  const page = http.createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><title>Site at ${req.socket.localAddress}</title><h1>The team's site</h1><p>Served on port 80 alone.</p>${req.headers.host === "myapp.test" ? '<iframe src="https://myapp.test/frame" width="300" height="100"></iframe>' : ""}<div style="height:1400px"></div>`));
  await new Promise((resolve) => page.listen(80, "0.0.0.0", resolve));
  let tls = 0;
  const other = net.createServer((socket) => {
    tls++;
    socket.on("error", () => {});
    socket.destroy();
  });
  await new Promise((resolve) => other.listen(443, "::", resolve));
  const runs = [];
  for (const [n, url] of ["http://intranet.acme.com/", "http://81.2.69.160/", "http://myapp.test/"].entries()) {
    tls = 0;
    runs.push(
      await new Promise((resolve) => {
        const child = spawn("unshare", ["-U", `--map-user=${uid}`, `--map-group=${gid}`, process.execPath, cli, url, "--pages", "1", "--sizes", "desktop", "--json", "--out", `${folder}-${n}`], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        const timer = setTimeout(() => child.kill("SIGKILL"), 100_000);
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          let manifest = null;
          try {
            manifest = JSON.parse(out);
          } catch {
            manifest = null;
          }
          resolve({ url, status: code === null ? signal : code, said: err.trim().split("\n").slice(-3).join(" | "), titles: manifest && manifest.pages ? manifest.pages.map((one) => one.title) : [], notes: manifest && manifest.pages && manifest.pages[0] ? manifest.pages[0].notes || [] : [], tls });
        });
      }),
    );
  }
  page.close();
  other.close();
  process.stdout.write(`${JSON.stringify({ runs })}\n`);
}

// Run as
//
//   unshare -rn node network.js lossy <uid> <gid> <cli> <folder>
//
// it stands in for a network that loses every other connection to a site
// whole, its first among them, as a lossy path or a load balancer with a
// backend that does not answer can: a dummy network holds the site at
// 93.184.216.34, which serves a page on port 8080, where the browser does
// not try https first, and nftables drops every packet of every other
// connection made to it. The kit's command takes the
// site as the user who ran the test, with --json, saving in <folder>. It
// prints one line of JSON: { status, said, manifest, took }, the exit code,
// the last lines on stderr, the manifest it printed and how long it ran, in
// ms.
async function lossy(uid, gid, cli, folder) {
  ip("link", "set", "lo", "up");
  ip("link", "add", "d0", "type", "dummy");
  ip("link", "set", "d0", "up");
  ip("addr", "add", "93.184.216.34/32", "dev", "d0");
  const page = http.createServer((req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!doctype html><title>Acme | Tools</title><h1>Acme</h1><p>Tools for teams, on a lossy network.</p><div style=\"height:1400px\"></div>"));
  await new Promise((resolve) => page.listen(8080, "93.184.216.34", resolve));
  for (const rule of [
    "add table inet lossy",
    "add set inet lossy known { type ipv4_addr . inet_service; }",
    "add set inet lossy lost { type ipv4_addr . inet_service; }",
    "add chain inet lossy out { type filter hook output priority 0; }",
    "add rule inet lossy out ip daddr 93.184.216.34 tcp flags & (syn|ack) == syn ip daddr . tcp sport != @known numgen inc mod 2 == 0 add @lost { ip daddr . tcp sport }",
    "add rule inet lossy out ip daddr 93.184.216.34 tcp flags & (syn|ack) == syn ip daddr . tcp sport != @lost add @known { ip daddr . tcp sport }",
    "add rule inet lossy out ip daddr . tcp sport @lost drop",
  ]) {
    const done = spawnSync("nft", [rule], { encoding: "utf8" });
    if (done.status !== 0) throw new Error(`nft ${rule}: ${String(done.stderr || done.error).trim()}`);
  }
  const began = Date.now();
  const told = await new Promise((resolve) => {
    const child = spawn("unshare", ["-U", `--map-user=${uid}`, `--map-group=${gid}`, process.execPath, cli, "http://93.184.216.34:8080/", "--pages", "1", "--sizes", "desktop", "--json", "--out", folder], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      let manifest = null;
      try {
        manifest = JSON.parse(out);
      } catch {
        manifest = null;
      }
      resolve({ status: code === null ? signal : code, said: err.trim().split("\n").slice(-3).join(" | "), manifest, took: Date.now() - began });
    });
  });
  page.close();
  process.stdout.write(`${JSON.stringify(told)}\n`);
}

// The sites of routed(), all on 127.0.0.1:80, each picked by its name:
// app1.test's home page holds a frame of http://app2.test/private, a
// picture of http://app2.test/pixel.svg and one of http://localhost/logo.svg,
// and fetch()es http://app2.test/api/customers, whose answer any page may
// read, showing what it read in its title; app3.test's home page sends its
// visitors to http://app2.test/; app2.test is another site of the machine,
// with private pages and data, and localhost the machine's own.
async function routed(uid, gid, cli, folder) {
  ip("link", "set", "lo", "up");
  const seen = [];
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || "").replace(/:\d+$/, "");
    seen.push(`${host} ${req.url}`);
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    if (host === "app1.test" && req.url === "/") return html('<!doctype html><title>App one</title><h1>App one</h1><p>The first site of this machine.</p><iframe src="http://app2.test/private" width="300" height="100"></iframe><img src="http://app2.test/pixel.svg"><img src="http://localhost/logo.svg"><script>fetch("http://app2.test/api/customers").then((r) => r.text()).then((text) => { document.title = "App one READ " + text; }).catch(() => {});</script><div style="height:1400px"></div>');
    if (host === "app3.test" && req.url === "/") return res.writeHead(302, { Location: "http://app2.test/" }).end();
    if (host === "app2.test" && req.url === "/api/customers") return res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }).end('{"customers":["ACME GmbH"]}');
    if ((host === "app2.test" && req.url === "/pixel.svg") || (host === "localhost" && req.url === "/logo.svg")) return res.writeHead(200, { "Content-Type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="rgb(200,0,0)"/></svg>');
    if (host === "app2.test") return html("<!doctype html><title>App two admin</title><h1>APP2 PRIVATE DATA of another site of this machine</h1>");
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(80, "127.0.0.1", resolve));
  const runs = [];
  try {
    for (const [n, url] of ["http://app1.test/", "http://app3.test/"].entries()) {
      runs.push(
        await new Promise((resolve) => {
          const child = spawn("unshare", ["-U", `--map-user=${uid}`, `--map-group=${gid}`, process.execPath, cli, url, "--pages", "2", "--sizes", "desktop", "--json", "--out", `${folder}-${n}`], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          let err = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          const timer = setTimeout(() => child.kill("SIGKILL"), 100_000);
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            let manifest = null;
            try {
              manifest = JSON.parse(out);
            } catch {
              manifest = null;
            }
            resolve({ url, status: code === null ? signal : code, said: err.trim().split("\n").slice(-3).join(" | "), titles: manifest && manifest.pages ? manifest.pages.map((one) => one.title) : [], notes: manifest && manifest.pages && manifest.pages[0] ? manifest.pages[0].notes || [] : [] });
          });
        }),
      );
    }
    // A moment for what is still on its way.
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    server.close();
  }
  process.stdout.write(`${JSON.stringify({ runs, seen })}\n`);
}

// The machine of downed(), each address on the public internet by its
// range: an interface up with no link, eth9, a veth whose other end is
// down; a dummy left down, kd0, as kube-proxy leaves kube-ipvs0 with every
// Service's address on it; and ranges routed to the machine itself, as a
// pool of addresses for a proxy is set up; beside a running dummy, d0, with
// the default routes, and a transparent proxy's table 100, which routes
// every address to the machine itself for the packets it marks alone.
const DOWNED = { noLink4: "93.184.216.77", noLink6: "2a02:2f0c:8000:77::5", down4: "93.184.216.88", down6: "2a02:2f0c:8000:88::8", routed4: "93.184.217.50", routed6: "2a02:2f0c:8000:99::7" };

async function downed() {
  ip("link", "set", "lo", "up");
  ip("link", "add", "d0", "type", "dummy");
  ip("link", "set", "d0", "up");
  ip("addr", "add", "198.51.100.9/24", "dev", "d0");
  ip("-6", "addr", "add", "2a02:2f0c:8000:1::9/64", "dev", "d0", "nodad");
  ip("route", "add", "default", "dev", "d0");
  ip("-6", "route", "add", "default", "dev", "d0");
  ip("link", "add", "eth9", "type", "veth", "peer", "name", "eth9p");
  ip("link", "set", "eth9", "up");
  ip("addr", "add", `${DOWNED.noLink4}/24`, "dev", "eth9");
  ip("-6", "addr", "add", `${DOWNED.noLink6}/64`, "dev", "eth9", "nodad");
  ip("link", "add", "kd0", "type", "dummy");
  ip("addr", "add", `${DOWNED.down4}/32`, "dev", "kd0");
  ip("-6", "addr", "add", `${DOWNED.down6}/128`, "dev", "kd0", "nodad");
  ip("route", "add", "local", "93.184.217.0/24", "dev", "lo");
  ip("-6", "route", "add", "local", "2a02:2f0c:8000:99::/64", "dev", "lo");
  ip("rule", "add", "fwmark", "1", "table", "100");
  ip("route", "add", "local", "0.0.0.0/0", "dev", "lo", "table", "100");
  ip("-6", "rule", "add", "fwmark", "1", "table", "100");
  ip("-6", "route", "add", "local", "::/0", "dev", "lo", "table", "100");
  process.stdout.write(`${JSON.stringify(await judgeAll(Object.values(DOWNED)))}\n`);
}

// With the run's rule for a site on the public internet, each of addresses
// asked for by the rule's refuses(), through the run's proxy as the browser
// asks, a plain http request to port 80 and a tunnel to port 443, and as a
// request of the kit's own (getChecked()), with a service of this machine's
// own on port 80 and 443 of all its addresses that notes each connection:
// { judged, seen }, as downed() prints them.
async function judgeAll(addresses) {
  const { guardFor, getChecked } = require("../skills/easyscreenshotkit/scripts/lib/address");
  const { startProxy } = require("../skills/easyscreenshotkit/scripts/lib/proxy");
  const seen = [];
  const web = http.createServer((req, res) => {
    seen.push(`${req.socket.localAddress}:80 ${req.method} ${req.url}`);
    res.end("this machine's own service: secret");
  });
  const tls = net.createServer((socket) => {
    seen.push(`${socket.localAddress}:443`);
    socket.destroy();
  });
  await new Promise((resolve) => web.listen(80, "::", resolve));
  await new Promise((resolve) => tls.listen(443, "::", resolve));
  const guard = await guardFor("https://93.184.215.14/");
  const proxy = await startProxy(() => guard);
  // What the proxy answers a request, its first line, or "" for none.
  const ask = (request) =>
    new Promise((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => socket.write(request));
      let got = "";
      socket.on("data", (data) => (got += data));
      socket.on("error", () => {});
      socket.on("close", () => resolve(got.split("\r\n")[0]));
      setTimeout(() => socket.destroy(), 5_000);
    });
  const judged = {};
  try {
    for (const address of addresses) {
      const host = address.includes(":") ? `[${address}]` : address;
      let kit;
      try {
        kit = String((await getChecked(`http://${host}/secret`, { guard, timeoutMs: 5_000 })).status);
      } catch (err) {
        kit = err.refused || err.code || err.message;
      }
      judged[address] = {
        refuses: await guard.refuses(`http://${host}/secret`),
        http: await ask(`GET http://${host}/secret HTTP/1.1\r\nHost: ${host}\r\n\r\n`),
        tunnel: await ask(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`),
        kit,
      };
    }
    // A moment for what is still on its way.
    await new Promise((resolve) => setTimeout(resolve, 300));
  } finally {
    proxy.close();
    web.close();
    tls.close();
  }
  return { judged, seen };
}

// The machine of networks(): an IPv6 address of its own on each network,
// on the public internet by its range, beside a running dummy, d0, with the
// default routes, and the addresses of devices of those networks, which
// answer in devices(). machine: the machine's own, with its prefix; route:
// the network as a route alone; devices: the devices' addresses.
const NETWORKS = {
  sixToFour: { link: "n0", peer: "n1", machine: "2002:5db8:d84d:1::5/64", devices: ["2002:5db8:d84d:1::1", "2002:5db8:d84d:1::9"] },
  dhcp: { link: "v0", peer: "v1", machine: "2001:470:1:2::5/128", route: "2001:470:1:2::/64", devices: ["2001:470:1:2::1", "2001:470:1:2::c4"] },
};

async function networks() {
  ip("link", "set", "lo", "up");
  ip("link", "add", "d0", "type", "dummy");
  ip("link", "set", "d0", "up");
  ip("addr", "add", "198.51.100.9/24", "dev", "d0");
  ip("-6", "addr", "add", "2a02:2f0c:8000:1::9/64", "dev", "d0", "nodad");
  ip("route", "add", "default", "dev", "d0");
  ip("-6", "route", "add", "default", "dev", "d0");
  const all = Object.values(NETWORKS);
  for (const one of all) ip("link", "add", one.link, "type", "veth", "peer", "name", one.peer);
  const rest = spawn("unshare", ["-n", process.execPath, __filename, "devices", ...all.map((one) => `${one.peer}=${one.devices.join(",")}`)], { stdio: ["ignore", "pipe", "inherit"] });
  let printed = "";
  rest.stdout.on("data", (d) => (printed += d));
  try {
    await new Promise((resolve, reject) => {
      rest.once("error", reject);
      rest.once("spawn", resolve);
    });
    for (const one of all) {
      for (let i = 0; i < 200 && spawnSync("ip", ["link", "show", one.peer]).status === 0; i++) {
        if (spawnSync("ip", ["link", "set", one.peer, "netns", String(rest.pid)]).status === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      ip("link", "set", one.link, "up");
      ip("-6", "addr", "add", one.machine, "dev", one.link, "nodad");
      if (one.route) ip("-6", "route", "add", one.route, "dev", one.link);
    }
    for (let i = 0; i < 200 && !printed.includes("ready"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!printed.includes("ready")) throw new Error("the devices did not start");
    const told = await judgeAll(all.flatMap((one) => [one.machine.split("/")[0], ...one.devices]));
    process.stdout.write(`${JSON.stringify({ ...told, devices: printed.split("\n").filter((line) => line.startsWith("device ")) })}\n`);
  } finally {
    rest.kill("SIGKILL");
  }
}

// Run in a network namespace of its own (see networks()): the rest of the
// machine's networks. Each argument names a link networks() moves into its
// namespace and the addresses it takes there, as n1=<address>,<address>.
// It serves on port 80 of all of them, notes each request it gets on
// stdout, and prints "ready" once it serves.
async function devices(...links) {
  ip("link", "set", "lo", "up");
  for (const one of links) {
    const [name, list] = one.split("=");
    for (let i = 0; i < 200 && spawnSync("ip", ["link", "show", name]).status !== 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    ip("link", "set", name, "up");
    for (const address of list.split(",")) ip("-6", "addr", "add", `${address}/64`, "dev", name, "nodad");
  }
  const server = http.createServer((req, res) => {
    process.stdout.write(`device ${req.socket.localAddress} ${req.method} ${req.url}\n`);
    res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }).end("A DEVICE OF THIS MACHINE'S NETWORK");
  });
  await new Promise((resolve) => server.listen({ port: 80, host: "::", ipv6Only: true }, resolve));
  process.stdout.write("ready\n");
}

// As the preload of the kit's command (see silent()): the kit's proxy
// reaches 93.184.216.34 on port 80 at DIAL_TO, the page's own server.
if (require.main !== module && process.env.DIAL_TO) {
  const { dialer } = require("../skills/easyscreenshotkit/scripts/lib/proxy");
  const connect = dialer.connect;
  const [host, port] = process.env.DIAL_TO.split(":");
  dialer.connect = (options) => (options.host === "93.184.216.34" && Number(options.port) === 80 ? connect({ ...options, host, port: Number(port), family: 4 }) : connect(options));
}

const [mode, ...rest] = process.argv.slice(2);
const modes = { outer, alone, silent, own, site6, upgraded, lossy, mixed, siteMixed, routed, downed, networks, devices };
if (require.main === module) (modes[mode] || inner)(...rest).catch((err) => {
  process.stdout.write(JSON.stringify({ failed: String((err && err.message) || err) }));
  process.exitCode = 1;
});
