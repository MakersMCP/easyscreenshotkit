"use strict";

// The run's own proxy, the browser's one way to the network (see proxy.js):
// what it passes on and what it refuses, asked directly, and in a real
// headless browser (skipped when none is installed) every request the
// browser makes on its own, each reaching nothing but the proxy's refusal.

const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const dns = require("node:dns");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { startProxy, dialer, closing, NO_RULE } = require("../skills/easyscreenshotkit/scripts/lib/proxy");
const { findChrome, launch, openTab, closeTab, navigate, roomIn, proxySaid, BARRED, UNREACHED } = require("../skills/easyscreenshotkit/scripts/lib/chrome");
const { guardFor, NOT_GIVEN, NOT_PUBLIC } = require("../skills/easyscreenshotkit/scripts/lib/address");
const { takeShots } = require("../skills/easyscreenshotkit/scripts/lib/shots");
const { pickPages } = require("../skills/easyscreenshotkit/scripts/lib/tour");
const { setTimeLimit, sleep } = require("../skills/easyscreenshotkit/scripts/lib/time");
const { serve, tempProblem, sh, reachAt, pngOf } = require("./helpers");

const noTemp = tempProblem();
const noBrowser = (!findChrome() && "no Chrome, Chromium, Edge or Brave installed") || noTemp;
const openssl = spawnSync("openssl", ["version"], { encoding: "utf8" });
const noOpenssl = (openssl.error || openssl.status !== 0) && "no openssl to make the test's certificates";
const DESKTOP = { width: 1200, height: 800, scale: 1, mobile: false, touch: false, agent: "desktop" };
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-proxy-"));
const html = { "Content-Type": "text/html; charset=utf-8" };

// A server that counts every connection made to it and what came first on
// each: what a test's request must never reach.
async function trap() {
  const seen = [];
  const server = net.createServer((socket) => {
    seen.push("connection");
    socket.on("error", () => {});
    socket.once("data", (data) => seen.push(String(data).split("\r\n")[0]));
    setTimeout(() => socket.destroy(), 200);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, port: server.address().port, close: () => server.close() };
}

// Names that resolve here as a DNS server answers them, for the run's rule,
// each an address; asked: how many times each was asked for.
async function withNames(answers, body) {
  const lookup = dns.lookup;
  const asked = new Map();
  dns.lookup = (host, options, callback) => {
    if (typeof options === "function") [options, callback] = [{}, options];
    if (answers[host] === undefined) return lookup(host, options, callback);
    asked.set(host, (asked.get(host) || 0) + 1);
    process.nextTick(callback, null, options && options.all ? [{ address: answers[host], family: 4 }] : answers[host], 4);
  };
  try {
    return await body(asked);
  } finally {
    dns.lookup = lookup;
  }
}

// A request to the proxy as a browser writes one, its address whole: the
// status, headers and body of the answer.
function askProxy(port, target, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: target, headers: { Host: new URL(target).host, ...headers }, maxHeaderSize: 64 * 1024 }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// A request to the proxy that gets no answer, as the proxy closes its
// connection for one it does not pass on: the system's code for that, or
// the status of an answer that came.
const unanswered = (port, target) => askProxy(port, target).then((res) => `answered ${res.status}`, (err) => err.code);

// A tunnel asked of the proxy, as CONNECT host:port: the status line it
// answered with, and the socket, open when the tunnel was made.
function tunnel(port, authority) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    let got = Buffer.alloc(0);
    const onData = (data) => {
      got = Buffer.concat([got, data]);
      const end = got.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.off("data", onData);
      resolve({ status: got.subarray(0, got.indexOf("\r\n")).toString(), socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: got.toString().split("\r\n")[0] || "closed", socket }));
  });
}

// What a site of this machine given as the address sees through the proxy,
// and what the proxy refuses: another port of the machine, a request that
// is no proxy's, one that asks to switch protocols, and a tunnel to a host
// and port written otherwise than CONNECT writes them. The site gets the
// request as the browser wrote it, with the headers of the browser's
// connection to the proxy left out and the host its address names.
test("the proxy passes on what the run's rule opens, and the rest gets no answer or a 403 and a record", async () => {
  const asked = [];
  const site = await serve((req, res) => {
    asked.push({ url: req.url, host: req.headers.host, kept: req.headers["x-kept"], hop: req.headers["proxy-connection"], named: req.headers["x-named"] });
    res.writeHead(200, { "Content-Type": "text/plain", "X-From": "site" }).end(`site ${req.url}`);
  });
  const other = await trap();
  const given = `${site.origin}/`;
  const guard = await guardFor(given);
  const proxy = await startProxy(() => guard);
  try {
    const passed = await askProxy(proxy.port, `${site.origin}/x?y=1`, { headers: { "Proxy-Connection": "keep-alive", Connection: "x-named", "X-Named": "1", "X-Kept": "1", Host: "elsewhere.example" } });
    assert.deepEqual([passed.status, passed.body, passed.headers["x-from"]], [200, "site /x?y=1", "site"]);
    assert.deepEqual(asked, [{ url: "/x?y=1", host: new URL(site.origin).host, kept: "1", hop: undefined, named: undefined }]);
    // Another port of this machine, as a plain request, which gets no answer
    // a page could read, and as a tunnel.
    const away = `127.0.0.1:${other.port}`;
    assert.equal(await unanswered(proxy.port, `http://${away}/`), "ECONNRESET");
    assert.equal(proxy.refusalOf(`http://${away}/x`), NOT_GIVEN);
    // Headers past Node.js's own 16 KB, as a site's cookies and a long
    // policy can be, both ways, to a server that takes them.
    const roomy = http.createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => res.writeHead(String(req.headers.cookie || "").length > 20_000 ? 200 : 400, { "X-Long": "y".repeat(20_000) }).end("big"));
    await new Promise((resolve) => roomy.listen(0, "127.0.0.1", resolve));
    try {
      const roomyGuard = await guardFor(`http://127.0.0.1:${roomy.address().port}/`);
      const roomyProxy = await startProxy(() => roomyGuard);
      try {
        const big = await askProxy(roomyProxy.port, `http://127.0.0.1:${roomy.address().port}/big`, { headers: { Cookie: `c=${"x".repeat(20_000)}` } });
        assert.deepEqual([big.status, String(big.headers["x-long"] || "").length], [200, 20_000]);
      } finally {
        roomyProxy.close();
      }
    } finally {
      roomy.close();
    }
    assert.equal((await tunnel(proxy.port, away)).status, "HTTP/1.1 403 Forbidden");
    assert.equal(proxy.refused.get(away), NOT_GIVEN);
    // A tunnel to the site carries what the browser sends through it.
    const { status, socket } = await tunnel(proxy.port, new URL(site.origin).host);
    assert.equal(status, "HTTP/1.1 200 Connection Established");
    const answer = await new Promise((resolve) => {
      let got = "";
      socket.on("data", (d) => (got += d));
      socket.on("close", () => resolve(got));
      socket.write(`GET /through HTTP/1.1\r\nHost: ${new URL(site.origin).host}\r\nConnection: close\r\n\r\n`);
    });
    assert.match(answer, /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\nsite \/through\r\n/);
    // What no browser sends a proxy.
    const direct = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: proxy.port, path: "/" }, (res) => res.resume().on("end", () => resolve(res.statusCode))));
    assert.equal(direct, 403);
    const upgrade = await new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: proxy.port, path: `${site.origin}/ws`, headers: { Connection: "Upgrade", Upgrade: "websocket" } });
      req.on("upgrade", (res) => resolve(res.statusCode));
      req.on("response", (res) => resolve(res.statusCode));
      req.on("error", () => resolve("closed"));
      req.end();
    });
    assert.equal(upgrade, 403);
    for (const authority of [`user@127.0.0.1:${new URL(site.origin).port}`, "127.0.0.1", `127.0.0.1:${new URL(site.origin).port}/x`, "[::1"]) {
      assert.equal((await tunnel(proxy.port, authority)).status, "HTTP/1.1 403 Forbidden", authority);
    }
    assert.deepEqual(other.seen, []);
    assert.equal(asked.length, 2);
  } finally {
    proxy.close();
    site.server.close();
    other.close();
  }
});

// The proxy's own probe, a name no lookup answers, which it answers itself
// (see proxySaid() in chrome.js); one with no rule refuses every address;
// and a plain http address it cannot connect to gets no answer and is kept
// with the system's code, so the browser's words for it are the ones it
// gives a connection it makes itself.
test("the proxy answers its probe itself, refuses all with no rule, and keeps why it could not connect", async () => {
  const site = await serve((req, res) => res.end("site"));
  const closed = await serve((req, res) => res.end("gone"));
  const closedOrigin = closed.origin;
  await new Promise((resolve) => closed.server.close(resolve));
  const guard = await guardFor(`${closedOrigin}/`);
  const proxy = await startProxy(() => guard);
  const none = await startProxy(() => null);
  try {
    assert.equal(proxy.saw("http"), false);
    assert.equal((await askProxy(proxy.port, `http://${proxy.probe}/`)).status, 204);
    assert.equal((await tunnel(proxy.port, `${proxy.probe}:443`)).status, "HTTP/1.1 403 Forbidden");
    assert.deepEqual([proxy.saw("http"), proxy.saw("connect")], [true, true]);
    // The probe of this machine's own address, through the proxy and past
    // it, straight to its port.
    assert.match(proxy.loopback, new RegExp(`^http://127\\.0\\.0\\.1:${proxy.port}/[0-9a-f]{24}$`));
    assert.equal((await askProxy(proxy.port, proxy.loopback)).status, 204);
    assert.deepEqual([proxy.saw("loopback"), proxy.saw("direct")], [true, false]);
    const straight = await new Promise((resolve) => http.get(proxy.loopback, (res) => res.resume().on("end", () => resolve(res.statusCode))));
    assert.deepEqual([straight, proxy.saw("direct")], [204, true]);
    assert.deepEqual([...proxy.refused], []);
    assert.equal(await unanswered(proxy.port, `${closedOrigin}/`), "ECONNRESET");
    assert.equal(proxy.unreached.get(new URL(closedOrigin).host), "ECONNREFUSED");
    assert.equal((await tunnel(proxy.port, new URL(closedOrigin).host)).status, "HTTP/1.1 502 Bad Gateway");
    assert.equal(await unanswered(none.port, `${site.origin}/`), "ECONNRESET");
    assert.equal(none.refused.get(new URL(site.origin).host), NO_RULE);
    assert.equal(await proxy.reachable(), "");
  } finally {
    proxy.close();
    none.close();
    site.server.close();
  }
});

// The proxy keeps what came of each host and port the last time it was
// asked for, so a run that gives its browser another rule, as a test does,
// finds no refusal of the earlier rule where the new one connects; and it
// keeps it by the way it was asked, a plain request or a tunnel, as the
// rule can refuse a host and port over http and open it over https: from
// https://localhost:<port>/ given, its http on that port is refused and its
// https opened, and a request of the page's that failed over https was not
// to be named as refused because the same host and port had been over http.
test("the proxy keeps the last outcome for each host and port, by the way it was asked", { timeout: 30_000 }, async () => {
  const site = await serve((req, res) => res.end("site"));
  const other = await serve((req, res) => res.end("other"));
  let rule = await guardFor(`${site.origin}/`);
  const proxy = await startProxy(() => rule);
  try {
    const at = new URL(other.origin).host;
    assert.equal(await unanswered(proxy.port, `${other.origin}/`), "ECONNRESET");
    assert.equal(proxy.refused.get(at), NOT_GIVEN);
    assert.equal(proxy.refusalOf(`${other.origin}/x`), NOT_GIVEN);
    rule = await guardFor(`${other.origin}/`);
    assert.equal((await askProxy(proxy.port, `${other.origin}/`)).body, "other");
    assert.equal(proxy.refused.has(at), false);
    assert.equal(proxy.refusalOf(`${other.origin}/x`), "");
    // https given on the site's port: a tunnel there, then a plain request
    // there, which the rule refuses as http below https on that port.
    const port = new URL(site.origin).port;
    rule = await guardFor(`https://localhost:${port}/`);
    const { status, socket } = await tunnel(proxy.port, `localhost:${port}`);
    socket.destroy();
    assert.equal(status, "HTTP/1.1 200 Connection Established");
    assert.equal(await unanswered(proxy.port, `http://localhost:${port}/`), "ECONNRESET");
    assert.equal(proxy.refusalOf(`http://localhost:${port}/x`), `on port ${port}, not 80 or 443, and not on the scheme, host and port given`);
    assert.equal(proxy.refusalOf(`https://localhost:${port}/y`), "");
    assert.equal(proxy.refusalOf(`wss://localhost:${port}/z`), "");
  } finally {
    proxy.close();
    site.server.close();
    other.server.close();
  }
});

// A host's addresses are tried in their order, the next beside one that has
// not connected in a quarter of a second, each once though the lookup gives
// it twice, and the first to connect is taken, the others ended; once each
// is under way, two more connections to them are started a quarter of a
// second apart while none has connected, as the browser starts a second
// connection to a host that does not answer at once; a host that refuses
// is tried once, and an address this machine has no way to, as a site's
// IPv6 address on a machine with no IPv6, once, the two more going to the
// address that can still connect, the first of them at once; the proxy's
// close() ends a connection under way, and no other address is tried after
// it. Tried one after another, 30 s each, a
// host whose addresses did not answer held a request two minutes, and the
// run's process lived on that long after its end. Here 93.184.215.40 does
// not answer, and 93.184.215.41 is the site's server.
test("the proxy tries each address of a host, the next beside one that has not connected, then two more, and its close() ends what is under way", { timeout: 60_000 }, async () => {
  const site = await serve((req, res) => res.end(`site ${req.url}`));
  const closed = await serve((req, res) => res.end("gone"));
  const closedPort = Number(new URL(closed.origin).port);
  await new Promise((resolve) => closed.server.close(resolve));
  const made = [];
  const silent = [];
  let madeByFailure = 0;
  const before = dialer.connect;
  dialer.connect = (options) => {
    made.push(`${options.host}:${options.port}`);
    if (options.host === "93.184.215.41") return before({ ...options, host: "127.0.0.1", port: Number(new URL(site.origin).port), family: 4 });
    if (options.host === "93.184.215.42") return before({ ...options, host: "127.0.0.1", port: closedPort, family: 4 });
    const socket = new net.Socket();
    // An address this machine has no way to fails at once; how many
    // connections were made by the time that failure has been heard is
    // noted, before any timer of the proxy's can run.
    if (options.host === "2600:1f13:37c::1") {
      process.nextTick(() => {
        socket.destroy(Object.assign(new Error("connect ENETUNREACH 2600:1f13:37c::1:80"), { code: "ENETUNREACH" }));
        setImmediate(() => (madeByFailure = made.length));
      });
      return socket;
    }
    silent.push(socket);
    return socket;
  };
  const lookup = dns.lookup;
  const answers = { "both.example": ["93.184.215.40", "93.184.215.40", "93.184.215.41"], "silent.example": ["93.184.215.40", "93.184.215.40", "93.184.215.40"], "refusing.example": ["93.184.215.42"], "nosix.example": ["93.184.215.43", "2600:1f13:37c::1"] };
  dns.lookup = (host, options, callback) => {
    if (typeof options === "function") [options, callback] = [{}, options];
    const list = answers[String(host).replace(/\.$/, "")];
    if (!list) return lookup(host, options, callback);
    process.nextTick(callback, null, options && options.all ? list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) : list[0], 4);
  };
  let proxy = null;
  try {
    const guard = await guardFor("http://both.example/");
    proxy = await startProxy(() => guard);
    const started = Date.now();
    assert.equal((await askProxy(proxy.port, "http://both.example/x")).body, "site /x");
    assert.ok(Date.now() - started < 5_000, `the answer took ${Date.now() - started} ms`);
    assert.deepEqual(made.slice(0, 2), ["93.184.215.40:80", "93.184.215.41:80"]);
    assert.ok(silent.every((socket) => socket.destroyed));
    // A host that refuses: tried once, and failed at once.
    made.length = 0;
    const refusedAt = Date.now();
    assert.equal(await unanswered(proxy.port, "http://refusing.example/"), "ECONNRESET");
    assert.ok(Date.now() - refusedAt < 2_000, `the refusal took ${Date.now() - refusedAt} ms`);
    assert.deepEqual(made, ["93.184.215.42:80"]);
    assert.equal(proxy.unreached.get("refusing.example:80"), "ECONNREFUSED");
    // A host none of whose addresses answers, its one address given three
    // times: tried, then twice more a quarter of a second apart, then no
    // more, and ended with the proxy.
    made.length = 0;
    silent.length = 0;
    const asked = askProxy(proxy.port, "http://silent.example/y").then(() => "answered", (err) => err.code);
    await sleep(1_200);
    assert.deepEqual(made, ["93.184.215.40:80", "93.184.215.40:80", "93.184.215.40:80"]);
    proxy.close();
    assert.equal(await asked, "ECONNRESET");
    await sleep(600);
    assert.equal(made.length, 3);
    assert.deepEqual(silent.map((socket) => socket.destroyed), [true, true, true]);
    // A host whose IPv6 address this machine has no way to, and whose IPv4
    // address's connections the network loses: the IPv6 address is tried
    // once, and the two more connections go to the IPv4 address, the first
    // as soon as the IPv6 one has failed, a quarter of a second in.
    proxy = await startProxy(() => guard);
    made.length = 0;
    silent.length = 0;
    const lost = askProxy(proxy.port, "http://nosix.example/z").then(() => "answered", (err) => err.code);
    await sleep(1_200);
    assert.deepEqual(made, ["93.184.215.43:80", "2600:1f13:37c::1:80", "93.184.215.43:80", "93.184.215.43:80"]);
    assert.equal(madeByFailure, 3, "the next connection started as soon as the IPv6 one failed");
    proxy.close();
    assert.equal(await lost, "ECONNRESET");
  } finally {
    dialer.connect = before;
    dns.lookup = lookup;
    if (proxy) proxy.close();
    site.server.close();
  }
});

// A connection the network loses costs a page nothing: the proxy starts
// another beside it, as the browser does. With one connection to the
// site's one address, which the network lost, the page waited 30 s and was
// left out with net::ERR_TIMED_OUT, where 0.1.3's browser took it at once.
// Here every other connection to the site is lost, the first among them.
test("a connection the network loses has another started beside it, and the page comes at once", { timeout: 60_000 }, async () => {
  const site = await serve((req, res) => res.end(`site ${req.url}`));
  const before = dialer.connect;
  let n = 0;
  const lost = [];
  dialer.connect = (options) => {
    if (n++ % 2 === 0) {
      const socket = new net.Socket();
      lost.push(socket);
      return socket;
    }
    return before({ ...options, host: "127.0.0.1", port: Number(new URL(site.origin).port), family: 4 });
  };
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (typeof options === "function") [options, callback] = [{}, options];
    if (String(host).replace(/\.$/, "") !== "lossy.example") return lookup(host, options, callback);
    process.nextTick(callback, null, options && options.all ? [{ address: "93.184.215.50", family: 4 }] : "93.184.215.50", 4);
  };
  let proxy = null;
  try {
    const guard = await guardFor("http://lossy.example/");
    proxy = await startProxy(() => guard);
    for (const path of ["/a", "/b", "/c"]) {
      const started = Date.now();
      assert.equal((await askProxy(proxy.port, `http://lossy.example${path}`)).body, `site ${path}`);
      assert.ok(Date.now() - started < 5_000, `${path} took ${Date.now() - started} ms`);
    }
    assert.ok(lost.length >= 3 && lost.every((socket) => socket.destroyed));
    // A host whose one address refuses the connection started beside the
    // lost one is not waited for: it refuses, and the request fails then.
    const closed = await serve((req, res) => res.end("gone"));
    const closedPort = Number(new URL(closed.origin).port);
    await new Promise((resolve) => closed.server.close(resolve));
    n = 0;
    dialer.connect = (options) => {
      if (n++ === 0) {
        const socket = new net.Socket();
        lost.push(socket);
        return socket;
      }
      return before({ ...options, host: "127.0.0.1", port: closedPort, family: 4 });
    };
    const started = Date.now();
    assert.equal(await unanswered(proxy.port, "http://lossy.example/d"), "ECONNRESET");
    assert.ok(Date.now() - started < 5_000, `the refusal took ${Date.now() - started} ms`);
    assert.equal(proxy.unreached.get("lossy.example:80"), "ECONNREFUSED");
  } finally {
    dialer.connect = before;
    dns.lookup = lookup;
    if (proxy) proxy.close();
    site.server.close();
  }
});

// In a network namespace of the test's own that loses every other
// connection to the site whole, its first among them, the kit's own command
// takes the page at once, where the proxy's one connection was lost and the
// run failed after 30 s with net::ERR_TIMED_OUT, while 0.1.3's browser took
// it. With nftables (see network.js).
const noLossy = (() => {
  if (process.platform !== "linux") return "network namespaces are Linux's";
  const probe = spawnSync("unshare", ["-rn", "sh", "-c", `ip link add d0 type dummy && nft add table inet probe && unshare -U --map-user=${process.getuid()} --map-group=${process.getgid()} true`], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return `no nftables in a network namespace of the test's own here (unshare -rn with ip, nft and unshare -U --map-user: ${String(probe.stderr || probe.error || probe.status).trim().slice(0, 200)})`;
  return false;
})();

test("on a network that loses every other connection to a site, the page is taken at once", { skip: noBrowser || noLossy, timeout: 200_000 }, async () => {
  const root = tempDir();
  try {
    const folder = path.join(root, "shots");
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const child = spawn("unshare", ["-rn", process.execPath, path.join(__dirname, "network.js"), "lossy", String(process.getuid()), String(process.getgid()), cli, folder], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 190_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    let told = null;
    try {
      told = JSON.parse(out.trim().split("\n").pop());
    } catch {
      assert.fail(`network.js printed no result: ${(out + err).trim().slice(-600)}`);
    }
    assert.equal(told.status, 0, told.said || told.failed || err);
    assert.deepEqual(told.manifest.pages.map((page) => page.title), ["Acme | Tools"]);
    assert.ok(told.took < 25_000, `the run took ${told.took} ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The run's process ends as soon as the run has saved, whatever the proxy
// still waits on: here a page's picture is on a host whose four addresses
// do not answer, each a connection the system is still making, which keeps
// the process alive until it is ended. With each tried in turn for 30 s
// and none ended with the proxy, the process lived on two minutes after
// it had saved, where 0.1.3's ended with its browser.
test("the run's process ends once the run has saved, with a picture on a host that does not answer", { skip: noBrowser, timeout: 150_000 }, async () => {
  const root = tempDir();
  const preload = path.join(root, "stuck.js");
  fs.writeFileSync(
    preload,
    `const dns = require("dns");
const net = require("net");
const { dialer } = require(${JSON.stringify(require.resolve("../skills/easyscreenshotkit/scripts/lib/proxy"))});
const stuck = ["93.184.215.30", "93.184.215.31", "93.184.215.32", "93.184.215.33"];
const lookup = dns.lookup;
dns.lookup = (host, options, callback) => {
  if (typeof options === "function") [options, callback] = [{}, options];
  if (String(host).replace(/\\.$/, "") !== "stuck.example") return lookup(host, options, callback);
  process.nextTick(callback, null, options && options.all ? stuck.map((address) => ({ address, family: 4 })) : stuck[0], 4);
};
const connect = dialer.connect;
dialer.connect = (options) => {
  if (!stuck.includes(options.host)) return connect(options);
  const socket = new net.Socket();
  const held = setInterval(() => {}, 1000);
  const destroy = socket.destroy;
  socket.destroy = function (...args) {
    clearInterval(held);
    return destroy.apply(this, args);
  };
  return socket;
};
`,
  );
  const { server, origin } = await serve((req, res) => {
    if (req.url !== "/") return res.writeHead(404).end();
    res.writeHead(200, html).end(`<!doctype html><title>Acme | Tools</title><h1>Acme</h1><p>Tools for teams.</p><img src="http://stuck.example/ad.png"><div style="height:1400px"></div>`);
  });
  try {
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const child = spawn(process.execPath, ["--require", preload, cli, `${origin}/`, "--pages", "1", "--sizes", "desktop", "--out", path.join(root, "shots")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let saved = 0;
    child.stdout.on("data", (d) => {
      out += d;
      if (!saved && /Saved 1 page of 127\.0\.0\.1/.test(out)) saved = Date.now();
    });
    child.stderr.on("data", (d) => (err += d));
    const killer = setInterval(() => saved && Date.now() - saved > 20_000 && child.kill("SIGKILL"), 500);
    const status = await new Promise((resolve) => child.on("close", resolve));
    clearInterval(killer);
    const ended = Date.now();
    assert.equal(status, 0, `${out}\n${err}`);
    assert.ok(saved, out);
    assert.ok(ended - saved < 3_000, `the process ended ${ended - saved} ms after it saved`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A run whose page has a picture that comes after 4 MB of informational
// heads, with --timeout 60, ends well, the picture drawn: the proxy's
// reading of those heads took the run's main thread for hours, so the run
// heard neither its --timeout nor a signal, and a SIGTERM was heard 66 s
// late with 1.5 MB of them. The run is killed at 100 s.
test("a run whose picture comes after megabytes of informational heads ends well within its --timeout", { skip: noBrowser, timeout: 150_000 }, async () => {
  const root = tempDir();
  const head = "HTTP/1.1 100 Continue\r\n\r\n";
  const png = pngOf(40, 30, () => [0, 160, 0]);
  const flood = Buffer.concat([Buffer.alloc(head.length * 168_000).fill(head), Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${png.length}\r\n\r\n`), png]);
  const site = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (data) => {
      const target = data.toString("latin1").split(" ")[1];
      if (target === "/flood.png") return socket.end(flood);
      const body = `<!doctype html><title>Acme | Tools</title><h1>Acme</h1><p>Tools for teams.</p><img src="/flood.png" onload="document.title = 'Acme | Drawn'"><div style="height:1400px"></div>`;
      socket.end(`HTTP/1.1 ${target === "/" ? "200 OK" : "404 Not Found"}\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  try {
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const child = spawn(process.execPath, [cli, `http://127.0.0.1:${site.address().port}/`, "--pages", "1", "--sizes", "desktop", "--timeout", "60", "--json", "--out", path.join(root, "shots")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const killer = setTimeout(() => child.kill("SIGKILL"), 100_000);
    const status = await new Promise((resolve) => child.on("close", (code, signal) => resolve(code === null ? signal : code)));
    clearTimeout(killer);
    assert.equal(status, 0, `${out}\n${err}`);
    assert.equal(JSON.parse(out).pages[0].title, "Acme | Drawn");
  } finally {
    site.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A site's answer to a plain http request reaches the browser as the site
// sent it, with Connection: close put in after the status line of the
// request's own answer, past an informational one before it, so the
// browser opens a new connection for its next request; a request on that
// connection all the same is ended unanswered, as the browser sends it
// again on a new one. A site that kept its connection open past its answer
// could otherwise have had the browser read what it sent later as the
// answer to another request.
test("the proxy passes a site's answer on as it came, telling the browser to close that connection", { timeout: 30_000 }, async () => {
  const site = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (data) => {
      const target = data.toString("latin1").split(" ")[1];
      if (target === "/hints") return socket.write("HTTP/1.1 103 Early Hints\r\nLink: </x.css>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nConnection: keep-alive\r\nContent-Length: 5\r\n\r\nhints");
      // Bare line feeds, a folded header and a space before a colon, which
      // Node.js's parser refuses, and the connection kept open.
      socket.write("HTTP/1.1 200 Fine\nX-Folded: a\n b\nX-Spaced : 1\nConnection: keep-alive\nContent-Length: 4\n\nbody");
    });
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const guard = await guardFor(`${origin}/`);
  const proxy = await startProxy(() => guard);
  // What the proxy sends back on one connection for two requests written on
  // it, the second once the first's answer is in.
  const twice = (first, second, { raw = false } = {}) =>
    new Promise((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => socket.write(`GET ${first} HTTP/1.1\r\nHost: ${new URL(first).host}\r\n\r\n`));
      let got = "";
      let sent = false;
      socket.on("data", (data) => {
        got += data.toString("latin1");
        if (!sent && /\r?\n\r?\n(body|hints)$/.test(got)) {
          sent = true;
          socket.write(raw ? second : `GET ${second} HTTP/1.1\r\nHost: ${new URL(second).host}\r\n\r\n`);
        }
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve(got));
      // A connection the proxy left open after that.
      setTimeout(() => {
        resolve(`${got} (the connection was left open)`);
        socket.destroy();
      }, 5_000);
    });
  try {
    assert.equal(await twice(`${origin}/plain`, `${origin}/again`), "HTTP/1.1 200 Fine\nConnection: close\nProxy-Connection: close\nX-Folded: a\n b\nX-Spaced : 1\nConnection: keep-alive\nContent-Length: 4\n\nbody");
    // What is no request at all on that connection ends it too, with no
    // answer of the proxy's own put in the site's.
    assert.equal(await twice(`${origin}/plain`, "no request\r\n\r\n", { raw: true }), "HTTP/1.1 200 Fine\nConnection: close\nProxy-Connection: close\nX-Folded: a\n b\nX-Spaced : 1\nConnection: keep-alive\nContent-Length: 4\n\nbody");
    assert.equal(await twice(`${origin}/hints`, `${origin}/again`), "HTTP/1.1 103 Early Hints\r\nLink: </x.css>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nConnection: close\r\nProxy-Connection: close\r\nConnection: keep-alive\r\nContent-Length: 5\r\n\r\nhints");
  } finally {
    proxy.close();
    site.close();
  }
});

// What the proxy sends back for one request written on a connection of its
// own, as raw bytes, the connection closed by the proxy.
function rawThrough(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(Buffer.from(request, "latin1")));
    const parts = [];
    socket.on("data", (data) => parts.push(data));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(parts)));
  });
}

// The status line of the request's own answer is found where the browser
// finds it, and the two lines go in after it: past a line break or other
// bytes before HTTP, with no version, with no space before its code or no
// code at all, as Chrome reads each of those as a status of 200 and sent its
// next request on such a connection; past informational answers, a status
// from 100 to 199 however its code is written, an empty line ending such a
// head with or without carriage returns; and not after a head whose code is
// written after a tab, which the browser reads as 200 too.
test("the proxy finds the status line of a site's answer where the browser finds it", { timeout: 30_000 }, async () => {
  const sent = {
    junk: "\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    cased: "hTtP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    noversion: "HTTP 200 OK\r\nContent-Length: 2\r\n\r\nok",
    nospace: "HTTP/1.1200 OK\r\nContent-Length: 2\r\n\r\nok",
    nocode: "HTTP/1.1 OK\r\nContent-Length: 2\r\n\r\nok",
    spaces: "HTTP/1.1  100  Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    zeros: "HTTP/1.1 0100 Continue\n\nHTTP/1.1 200 OK\nContent-Length: 2\n\nok",
    mixed: "HTTP/1.1 102 Processing\nX-A: 1\n\r\nHTTP/1.1 101 Switching\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
    tab: "HTTP/1.1\t100 Continue\r\n\r\nok",
    none: "SSH-2.0-OpenSSH_9.6\r\n",
  };
  const site = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (data) => socket.end(Buffer.from(sent[data.toString("latin1").split(" ")[1].slice(1)], "latin1")));
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const guard = await guardFor(`${origin}/`);
  const proxy = await startProxy(() => guard);
  const lines = (end) => `Connection: close${end}Proxy-Connection: close${end}`;
  // Each answer with the two lines after the given part of it, or as it came.
  const expected = {
    junk: ["\r\nHTTP/1.1 200 OK\r\n", "\r\n"],
    cased: ["hTtP/1.1 200 OK\r\n", "\r\n"],
    noversion: ["HTTP 200 OK\r\n", "\r\n"],
    nospace: ["HTTP/1.1200 OK\r\n", "\r\n"],
    nocode: ["HTTP/1.1 OK\r\n", "\r\n"],
    spaces: ["HTTP/1.1  100  Continue\r\n\r\nHTTP/1.1 200 OK\r\n", "\r\n"],
    zeros: ["HTTP/1.1 0100 Continue\n\nHTTP/1.1 200 OK\n", "\n"],
    mixed: ["HTTP/1.1 102 Processing\nX-A: 1\n\r\nHTTP/1.1 101 Switching\r\n\r\nHTTP/1.1 200 OK\r\n", "\r\n"],
    tab: ["HTTP/1.1\t100 Continue\r\n", "\r\n"],
    none: null,
  };
  try {
    for (const [shape, answer] of Object.entries(sent)) {
      const got = (await rawThrough(proxy.port, `GET ${origin}/${shape} HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n\r\n`)).toString("latin1");
      const at = expected[shape];
      assert.equal(got, at ? `${at[0]}${lines(at[1])}${answer.slice(at[0].length)}` : answer, shape);
    }
  } finally {
    proxy.close();
    site.close();
  }
});

// The proxy's reader of a site's answer (see closing() in proxy.js) reads
// each byte once, as it comes, in whatever parts it comes: every shape of
// the test above, and a status line with four bytes before HTTP, one with
// no space at all and one with a carriage return inside it, which the
// browser ends there, give the same bytes fed one byte a part and in two
// parts at every split as whole. A reader that forgot a line feed at the
// end of a part, looked for HTTP at the first four bytes only, read a status
// line past a carriage return in it or took one with no space for none
// passed every test that gave it an answer whole, or in the large parts one
// write makes.
const SHAPES = {
  junk: ["\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", "\r\nHTTP/1.1 200 OK\r\n", "\r\n"],
  four: ["\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", "\r\n\r\nHTTP/1.1 200 OK\r\n", "\r\n"],
  cased: ["hTtP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", "hTtP/1.1 200 OK\r\n", "\r\n"],
  noversion: ["HTTP 200 OK\r\nContent-Length: 2\r\n\r\nok", "HTTP 200 OK\r\n", "\r\n"],
  nospace: ["HTTP/1.1200 OK\r\nContent-Length: 2\r\n\r\nok", "HTTP/1.1200 OK\r\n", "\r\n"],
  bare: ["HTTP/1.1\r\nContent-Length: 2\r\n\r\nok", "HTTP/1.1\r\n", "\r\n"],
  nocode: ["HTTP/1.1 OK\r\nContent-Length: 2\r\n\r\nok", "HTTP/1.1 OK\r\n", "\r\n"],
  inside: ["HTTP/1.1\r 100 Continue\r\nContent-Length: 2\r\n\r\nok", "HTTP/1.1\r 100 Continue\r\n", "\r\n"],
  spaces: ["HTTP/1.1  100  Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", "HTTP/1.1  100  Continue\r\n\r\nHTTP/1.1 200 OK\r\n", "\r\n"],
  zeros: ["HTTP/1.1 0100 Continue\n\nHTTP/1.1 200 OK\nContent-Length: 2\n\nok", "HTTP/1.1 0100 Continue\n\nHTTP/1.1 200 OK\n", "\n"],
  mixed: ["HTTP/1.1 102 Processing\nX-A: 1\n\r\nHTTP/1.1 101 Switching\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", "HTTP/1.1 102 Processing\nX-A: 1\n\r\nHTTP/1.1 101 Switching\r\n\r\nHTTP/1.1 200 OK\r\n", "\r\n"],
  continued: ["HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n", "\r\n"],
  tab: ["HTTP/1.1\t100 Continue\r\n\r\nok", "HTTP/1.1\t100 Continue\r\n", "\r\n"],
  none: ["SSH-2.0-OpenSSH_9.6\r\n", null],
};

// How much of the main thread's CPU time has gone since `from`: judged so, as
// a busy machine makes the clock longer, or the process's where Node.js has
// no count of a thread's.
const cpuSince = (from) => (process.threadCpuUsage ? process.threadCpuUsage(from) : process.cpuUsage(from));

// What the reader gives for an answer that comes in `parts`: the bytes it
// passes on, as text.
function readInParts(parts) {
  const reader = closing();
  const out = [];
  let passing = false;
  for (const part of parts) {
    if (passing) out.push(part);
    else {
      const marked = reader.read(part);
      if (marked) {
        passing = true;
        out.push(marked);
      }
    }
  }
  if (!passing) out.push(reader.held());
  return Buffer.concat(out).toString("latin1");
}

test("the proxy's reader of an answer gives the same bytes whatever parts the answer comes in", () => {
  const lines = (end) => `Connection: close${end}Proxy-Connection: close${end}`;
  for (const [shape, [answer, part, end]] of Object.entries(SHAPES)) {
    const expected = part === null ? answer : `${part}${lines(end)}${answer.slice(part.length)}`;
    const bytes = Buffer.from(answer, "latin1");
    assert.equal(readInParts([bytes]), expected, `${shape}, whole`);
    assert.equal(readInParts([...bytes].map((byte) => Buffer.from([byte]))), expected, `${shape}, a byte a part`);
    for (let at = 1; at < bytes.length; at++) assert.equal(readInParts([bytes.subarray(0, at), bytes.subarray(at)]), expected, `${shape}, split at ${at}`);
  }
});

// Each head read once: 9,000 informational heads, each a part of its own, as
// a site writes them when it writes each once the last was read, cost the
// reader a moment of the main thread. Read again from the answer's first
// byte for each part that came, they took it twelve seconds.
test("the proxy's reader reads each byte once, however many parts an answer comes in", () => {
  const head = Buffer.from("HTTP/1.1 100 Continue\r\n\r\n", "latin1");
  const final = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", "latin1");
  const reader = closing();
  const before = cpuSince();
  let marked = null;
  for (let i = 0; i < 9_000 && !marked; i++) marked = reader.read(head);
  assert.equal(marked, null);
  marked = reader.read(final);
  const spent = cpuSince(before);
  assert.ok((spent.user + spent.system) / 1000 < 500, `the reader took ${Math.round((spent.user + spent.system) / 1000)} ms of the main thread`);
  assert.equal(marked.length, head.length * 9_000 + final.length + 44);
  assert.equal(marked.subarray(-final.length - 44).toString("latin1"), "HTTP/1.1 200 OK\r\nConnection: close\r\nProxy-Connection: close\r\nContent-Length: 2\r\n\r\nok");
});

// The reader puts the two lines in after the status line of the request's
// own answer where that line ends within the answer's first HEADERS_MAX
// bytes, 256 KB, and passes the answer as it came where it ends past them,
// whatever parts the answer comes in: an answer with an informational head
// of 300 KB, one whose status line ends at the limit's last byte and one
// whose status line ends a byte past it give the same bytes fed whole, in
// parts of one size and in two parts split at each byte around the end of
// the informational head, the end of the status line and the limit. Where
// the reader went by how much of the answer had come when it looked, the one
// with the large head got the two lines fed whole and went as it came in
// smaller parts, so the test below, whose site sends it at once, failed now
// and then.
test("the proxy's reader puts the two lines in by where the status line of the request's own answer ends, whatever parts the answer comes in", () => {
  const MAX = 256 * 1024;
  const status = "HTTP/1.1 200 OK\r\n";
  const final = `${status}Content-Length: 2\r\n\r\nok`;
  const answer = (pad) => `HTTP/1.1 100 Continue\r\nX-Big: ${"a".repeat(pad)}\r\n\r\n${final}`;
  // The bytes of answer(pad) up to the end of the status line of its answer.
  const end = (pad) => answer(pad).length - final.length + status.length;
  const cases = { "an informational head of 300 KB": 300_000, "a status line that ends at the limit's last byte": MAX - end(0), "a status line that ends a byte past the limit": MAX - end(0) + 1 };
  for (const [name, pad] of Object.entries(cases)) {
    const text = answer(pad);
    const within = end(pad) <= MAX;
    const expected = within ? `${text.slice(0, end(pad))}Connection: close\r\nProxy-Connection: close\r\n${text.slice(end(pad))}` : text;
    const bytes = Buffer.from(text, "latin1");
    const gives = (parts, how) => assert.ok(readInParts(parts) === expected, `${name}, ${how}: the reader did not give the answer ${within ? "with the two lines put in" : "as it came"}`);
    gives([bytes], "whole");
    for (const size of [1000, 4096, 65_536, 100_000, 131_072]) {
      const parts = [];
      for (let at = 0; at < bytes.length; at += size) parts.push(bytes.subarray(at, at + size));
      gives(parts, `in parts of ${size} bytes`);
    }
    const splits = new Set();
    for (const near of [end(pad) - status.length, end(pad), MAX]) for (let at = near - 16; at <= near + 16; at++) if (at > 0 && at < bytes.length) splits.add(at);
    for (const at of splits) gives([bytes.subarray(0, at), bytes.subarray(at)], `split at ${at}`);
  }
});

// A site that answers with informational heads, one after another, before
// its own answer costs the proxy next to nothing of the run's main thread,
// and its answer reaches the browser: under HEADERS_MAX of them with the two
// lines put in after its status line, and past it as it came, one head as
// long as that too. Read from the
// start of the answer again for each part that came, 256 KB of "HTTP/1.1 100
// Continue" heads held the main thread more than two seconds and a megabyte
// of them two minutes, in which the run heard neither its --timeout nor a
// signal. Judged by the main thread's own CPU time (see cpuSince()).

test("a site that answers with many informational heads before its answer costs the proxy little, and the answer goes through", { timeout: 60_000 }, async () => {
  const head = "HTTP/1.1 100 Continue\r\n\r\n";
  const final = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
  const sizes = { under: 10_000, over: 160_000 };
  // One informational head of its own past HEADERS_MAX, a header of 300 KB.
  const huge = `HTTP/1.1 100 Continue\r\nX-Big: ${"a".repeat(300_000)}\r\n\r\n${final}`;
  const site = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", (data) => {
      const asked = data.toString("latin1").split(" ")[1].slice(1);
      if (asked === "huge") return socket.end(huge);
      socket.end(Buffer.concat([Buffer.alloc(head.length * sizes[asked]).fill(head), Buffer.from(final)]));
    });
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const guard = await guardFor(`${origin}/`);
  const proxy = await startProxy(() => guard);
  try {
    // 244 KB of heads: the two lines go in after the answer's status line.
    let before = cpuSince();
    const under = await rawThrough(proxy.port, `GET ${origin}/under HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n\r\n`);
    let spent = cpuSince(before);
    assert.ok((spent.user + spent.system) / 1000 < 500, `the proxy took ${Math.round((spent.user + spent.system) / 1000)} ms of the main thread`);
    assert.equal(under.length, head.length * sizes.under + final.length + 44);
    assert.equal(under.subarray(-final.length - 44).toString("latin1"), "HTTP/1.1 200 OK\r\nConnection: close\r\nProxy-Connection: close\r\nContent-Length: 2\r\n\r\nok");
    // 3.9 MB of them: past HEADERS_MAX, the answer goes as it came.
    before = cpuSince();
    const over = await rawThrough(proxy.port, `GET ${origin}/over HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n\r\n`);
    spent = cpuSince(before);
    assert.ok((spent.user + spent.system) / 1000 < 500, `the proxy took ${Math.round((spent.user + spent.system) / 1000)} ms of the main thread`);
    assert.equal(over.length, head.length * sizes.over + final.length);
    assert.equal(over.subarray(-final.length).toString("latin1"), final);
    // One head past it goes as it came too.
    assert.equal((await rawThrough(proxy.port, `GET ${origin}/huge HTTP/1.1\r\nHost: ${new URL(origin).host}\r\n\r\n`)).toString("latin1"), huge);
  } finally {
    proxy.close();
    site.close();
  }
});

// A request reaches the site as the browser wrote it, byte for byte: a
// header past ASCII, as a cookie a page set with document.cookie or a value
// a fetch() gave, which went as UTF-8 with each such byte as two, so the
// site got "JosÃ©" for a cookie of "José"; a header that holds a control
// character or DEL, which the proxy answered 400 itself; and a body, with a
// Content-Length, a large one, and one sent in chunks, sent in chunks again
// with no Content-Length beside it. A header with a NUL byte, which no
// browser sends, is refused. The path and query go as the browser wrote
// them too, a ? with nothing after it included, which the URL parser's own
// form of them dropped, so a page's fetch("/ask?") reached the site as /ask.
test("the proxy passes a request on byte for byte, its headers past ASCII or with control characters and its body", { timeout: 30_000 }, async () => {
  const heads = [];
  const bodies = [];
  const targets = [];
  const site = http.createServer({ insecureHTTPParser: true }, (req, res) => {
    const named = (name) => Buffer.from(req.rawHeaders[req.rawHeaders.findIndex((one, i) => i % 2 === 0 && one.toLowerCase() === name) + 1] || "", "latin1").toString("hex");
    targets.push(req.url);
    heads.push({ cookie: named("cookie"), name: named("x-name"), del: named("x-del"), c0: named("x-c0"), length: req.headers["content-length"], chunked: req.headers["transfer-encoding"] });
    const parts = [];
    req.on("data", (data) => parts.push(data));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      bodies.push({ length: body.length, sha: crypto.createHash("sha256").update(body).digest("hex").slice(0, 16) });
      res.end("taken");
    });
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const host = new URL(origin).host;
  const guard = await guardFor(`${origin}/`);
  const proxy = await startProxy(() => guard);
  const hash = (text) => crypto.createHash("sha256").update(Buffer.from(text, "latin1")).digest("hex").slice(0, 16);
  try {
    const got = await rawThrough(proxy.port, `GET ${origin}/headers HTTP/1.1\r\nHost: ${host}\r\nCookie: n=Jos\xc3\xa9\r\nX-Name: caf\xe9\r\nX-Del: a\x7fb\r\nX-C0: a\x01b\r\n\r\n`);
    assert.match(got.toString("latin1"), /^HTTP\/1\.1 200 OK\r\n[\s\S]*taken$/);
    assert.deepEqual(heads.shift(), { cookie: "6e3d4a6f73c3a9", name: "636166e9", del: "617f62", c0: "610162", length: undefined, chunked: undefined });
    assert.deepEqual(bodies.shift(), { length: 0, sha: hash("") });
    // Each as Chrome writes it, its escapes kept as they are; a fragment,
    // which no browser sends, is left out, and a target written as no
    // browser writes one, with no path or with a \ in it, goes in the URL
    // parser's form.
    const asked = [
      ["/ask?", "/ask?"],
      ["/ask?#", "/ask?"],
      ["/q?a=%27b%27&e={f}&g=^h|i&l=%zz", "/q?a=%27b%27&e={f}&g=^h|i&l=%zz"],
      ["/p%7Bx%7D%60y%60'v", "/p%7Bx%7D%60y%60'v"],
      ["/s%2e/t", "/s%2e/t"],
      ["?only", "/?only"],
      ["/a\\b", "/a/b"],
    ];
    for (const [target] of asked) {
      assert.match((await rawThrough(proxy.port, `GET ${origin}${target} HTTP/1.1\r\nHost: ${host}\r\n\r\n`)).toString("latin1"), /taken$/);
      heads.shift();
      bodies.shift();
    }
    const large = "x".repeat(200_000);
    for (const [body, framed] of [
      ["hello world", `Content-Length: 11\r\n\r\nhello world`],
      [large, `Content-Length: ${large.length}\r\n\r\n${large}`],
      ["hello world", "Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n"],
    ]) {
      const answered = await rawThrough(proxy.port, `POST ${origin}/form HTTP/1.1\r\nHost: ${host}\r\n${framed}`);
      assert.match(answered.toString("latin1"), /taken$/);
      assert.deepEqual(bodies.shift(), { length: body.length, sha: hash(body) });
      const { length, chunked } = heads.shift();
      assert.deepEqual([length, chunked], framed.startsWith("Transfer-Encoding") ? [undefined, "chunked"] : [String(body.length), undefined]);
    }
    // Content-Length beside chunks: the body goes in chunks, and the length
    // stays behind.
    await rawThrough(proxy.port, `POST ${origin}/form HTTP/1.1\r\nHost: ${host}\r\nContent-Length: 99\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n0\r\n\r\n`);
    assert.deepEqual(bodies.shift(), { length: 2, sha: hash("ok") });
    assert.deepEqual([heads[0].length, heads.shift().chunked], [undefined, "chunked"]);
    const nul = await rawThrough(proxy.port, `GET ${origin}/nul HTTP/1.1\r\nHost: ${host}\r\nX-Nul: a\x00b\r\n\r\n`);
    assert.match(nul.toString("latin1"), /^HTTP\/1\.1 400 Bad Request\r\n/);
    assert.deepEqual([heads, bodies], [[], []]);
    assert.deepEqual(targets, ["/headers", ...asked.map(([, reached]) => reached), "/form", "/form", "/form", "/form"]);
  } finally {
    proxy.close();
    site.close();
  }
});

// A request whose rule answers only once the proxy has closed, as a lookup
// that comes late, dials nothing: close() ends the dials under way when it
// is called, and one begun after it would hold the run's process alive
// until it gave up, as a host that does not answer does. Here the lookup
// answers 300 ms after it is asked, and the proxy closes at once.
test("a request whose lookup answers after the proxy has closed dials nothing", { timeout: 30_000 }, async () => {
  const dialed = [];
  const before = dialer.connect;
  dialer.connect = (options) => {
    dialed.push(`${options.host}:${options.port}`);
    return new net.Socket();
  };
  const late = {
    refuses: async () => "",
    lookupFor: () => (hostname, options, callback) => setTimeout(() => callback(null, [{ address: "93.184.215.14", family: 4 }]), 300),
  };
  const proxy = await startProxy(() => late);
  try {
    const plain = rawThrough(proxy.port, "GET http://late.example/ HTTP/1.1\r\nHost: late.example\r\n\r\n").catch((err) => err.code);
    const tunneled = tunnel(proxy.port, "late.example:443").then(({ status, socket }) => {
      socket.destroy();
      return status;
    });
    await sleep(100);
    proxy.close();
    await Promise.all([plain, tunneled]);
    await sleep(500);
    assert.deepEqual(dialed, []);
  } finally {
    dialer.connect = before;
    proxy.close();
  }
});

// A page whose answers Node.js's parser refuses, and the browser reads, is
// taken as the browser reads it, as 0.1.3 took each of these, and so is
// its script that comes the same way: lines that end in a bare line feed,
// Content-Length beside Transfer-Encoding: chunked, a folded header, a
// control character in a value, a space before a header's colon or in its
// name, a chunk's size followed by a space, a status line with no reason,
// an answer whose end is the connection's, HTTP/1.0, an informational
// answer before the page's, a connection kept open, a status under 100 or
// a DEL in the reason, which crashed the run. Through Node.js's parser the
// first six failed with "net::ERR_CONNECTION_FAILED" and the seventh with
// "net::ERR_EMPTY_RESPONSE". An answer with nothing in it, and a connection
// the site resets before it answers, are said so in the browser's own
// words, as 0.1.3 said them. And the browser sends no further request on
// a connection that carried a site's answer, a status line it reads where
// a stricter reading finds none included: a line break before HTTP, no
// version, no space before the code or no code, each with its connection
// kept open, where the browser sent its next request on that connection.
// Each request the proxy takes is counted by the connection it came on.
test("a page whose answers Node.js's parser refuses is taken as the browser reads them, its script with it", { skip: noBrowser, timeout: 150_000 }, async () => {
  setTimeLimit(150_000);
  const page = (shape, script) => (script ? `document.title += " ran";` : `<!doctype html><title>${shape}</title><h1>${shape}</h1><script src="/${shape}.js"></script>`);
  const length = (body) => Buffer.byteLength(body);
  const shapes = {
    lf: (b, t) => `HTTP/1.1 200 OK\nContent-Type: ${t}\nContent-Length: ${length(b)}\n\n${b}`,
    both: (b, t) => `HTTP/1.1 200 OK\r\nContent-Type: ${t}\r\nContent-Length: 999\r\nTransfer-Encoding: chunked\r\n\r\n${length(b).toString(16)}\r\n${b}\r\n0\r\n\r\n`,
    folded: (b, t) => `HTTP/1.1 200 OK\r\nContent-Type: ${t}\r\nX-Folded: a\r\n b\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    control: (b, t) => `HTTP/1.1 200 OK\r\nContent-Type: ${t}\r\nX-Control: a\x01b\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    spacecolon: (b, t) => `HTTP/1.1 200 OK\r\nContent-Type: ${t}\r\nX-Thing : 1\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    spacename: (b, t) => `HTTP/1.1 200 OK\r\nContent-Type: ${t}\r\nX Thing: 1\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    chunkext: (b, t) => `HTTP/1.1 200 OK\r\nContent-Type: ${t}\r\nTransfer-Encoding: chunked\r\n\r\n${length(b).toString(16)} ;ext=1\r\n${b}\r\n0\r\n\r\n`,
    noreason: (b, t) => `HTTP/1.1 200\r\nContent-Type: ${t}\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    closed: (b, t) => `HTTP/1.1 200 OK\r\nContent-Type: ${t}\r\n\r\n${b}`,
    old: (b, t) => `HTTP/1.0 200 OK\r\nContent-Type: ${t}\r\n\r\n${b}`,
    hints: (b, t) => `HTTP/1.1 103 Early Hints\r\nLink: </x.css>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: ${t}\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    open: (b, t) => `HTTP/1.1 200 OK\r\nContent-Type: ${t}\r\nConnection: keep-alive\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    low: (b, t) => `HTTP/1.1 099 Low\r\nContent-Type: ${t}\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    zero: (b, t) => `HTTP/1.1 000 Zero\r\nContent-Type: ${t}\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    del: (b, t) => `HTTP/1.1 200 O\x7fK\r\nContent-Type: ${t}\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    junk: (b, t) => `\r\nHTTP/1.1 200 OK\r\nContent-Type: ${t}\r\nConnection: keep-alive\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    noversion: (b, t) => `HTTP 200 OK\r\nContent-Type: ${t}\r\nConnection: keep-alive\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    nospace: (b, t) => `HTTP/1.1200 OK\r\nContent-Type: ${t}\r\nConnection: keep-alive\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    nocode: (b, t) => `HTTP/1.1 OK\r\nContent-Type: ${t}\r\nConnection: keep-alive\r\nContent-Length: ${length(b)}\r\n\r\n${b}`,
    empty: () => "",
    reset: () => "",
  };
  const site = net.createServer((socket) => {
    socket.on("error", () => {});
    let got = "";
    socket.on("data", (data) => {
      got += data.toString("latin1");
      if (!got.includes("\r\n\r\n")) return;
      const target = got.split(" ")[1];
      const script = target.endsWith(".js");
      const shape = target.slice(1).replace(/\.js$/, "");
      if (!shapes[shape]) return socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      // A connection the site resets before it answers.
      if (shape === "reset") return void socket.resetAndDestroy();
      // The connection kept open is the site's to close, a moment later.
      const answer = Buffer.from(shapes[shape](page(shape, script), script ? "text/javascript" : "text/html"), "latin1");
      if (["open", "junk", "noversion", "nospace", "nocode"].includes(shape)) return void socket.write(answer, () => setTimeout(() => socket.destroy(), 3_000));
      socket.end(answer);
    });
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  let chrome = null;
  // The proxy's own server, taken as it is made, and the addresses of the
  // requests each connection of the browser's brought it.
  const made = http.createServer;
  let proxyServer = null;
  http.createServer = function (...args) {
    const server = made.apply(this, args);
    proxyServer = proxyServer || server;
    return server;
  };
  const asked = new Map();
  try {
    try {
      chrome = await launch({ guard: await guardFor(`${origin}/`) });
    } finally {
      http.createServer = made;
    }
    proxyServer.on("request", (req) => asked.set(req.socket, [...(asked.get(req.socket) || []), req.url.replace(origin, "")]));
    const took = {};
    for (const shape of Object.keys(shapes)) {
      const tab = await openTab(chrome, DESKTOP);
      try {
        const { status } = await navigate(tab, `${origin}/${shape}`);
        let title = "";
        for (let i = 0; i < 40 && !/ ran$/.test(title); i++) {
          ({ result: { value: title } } = await tab.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }));
          if (!/ ran$/.test(title)) await sleep(100);
        }
        took[shape] = `${status} ${title}`;
      } catch (err) {
        took[shape] = err.message.replace(origin, "<site>");
      } finally {
        await closeTab(chrome, tab);
      }
    }
    const expected = Object.fromEntries(Object.keys(shapes).map((shape) => [shape, `200 ${shape} ran`]));
    Object.assign(expected, { low: "99 low ran", zero: "0 zero ran", empty: "Could not open <site>/empty: net::ERR_EMPTY_RESPONSE", reset: "Could not open <site>/reset: net::ERR_CONNECTION_RESET" });
    assert.deepEqual(took, expected);
    // A connection the proxy answered on itself, as for the reset, can
    // take another request.
    assert.deepEqual([...asked.values()].filter((urls) => urls.length > 1 && !/^\/reset(\.js)?$/.test(urls[0])), []);
  } finally {
    if (chrome) await chrome.close();
    site.close();
  }
});

// A host name is looked up once, by the run's own lookup, and every
// connection for it goes to an address that lookup gave: a site on the
// public internet, a public address the setting names, and a name that
// leads to this machine. Here the run's proxy takes the public addresses to
// the site's server on this machine (see helpers.js reachAt()).
test("the proxy looks each name up once and connects only to the address it judged, MAKERSMCP_REFUSE_ADDRESSES and this machine refused", () =>
  withNames({ "proxy-site.example": "93.184.215.14", "proxy-refused.example": "93.184.215.99", "proxy-inside.example": "127.0.0.1" }, async (asked) => {
    const site = await serve((req, res) => res.end(`site ${req.headers.host}${req.url}`));
    const stand = reachAt({ "93.184.215.14:80": `127.0.0.1:${new URL(site.origin).port}`, "93.184.215.14:443": `127.0.0.1:${new URL(site.origin).port}` });
    const saved = process.env.MAKERSMCP_REFUSE_ADDRESSES;
    process.env.MAKERSMCP_REFUSE_ADDRESSES = "93.184.215.99";
    let proxy = null;
    try {
      const guard = await guardFor("https://proxy-site.example/");
      proxy = await startProxy(() => guard);
      for (let i = 0; i < 3; i++) assert.equal((await askProxy(proxy.port, `http://proxy-site.example/${i}`)).body, `site proxy-site.example/${i}`);
      const { status, socket } = await tunnel(proxy.port, "proxy-site.example:443");
      socket.destroy();
      assert.equal(status, "HTTP/1.1 200 Connection Established");
      assert.equal(await unanswered(proxy.port, "http://proxy-refused.example/"), "ECONNRESET");
      assert.equal((await tunnel(proxy.port, "proxy-inside.example:443")).status, "HTTP/1.1 403 Forbidden");
      // Another port of the site's own host on the public internet.
      assert.equal(await unanswered(proxy.port, "http://proxy-site.example:8080/"), "ECONNRESET");
      assert.equal((await tunnel(proxy.port, "proxy-site.example:8443")).status, "HTTP/1.1 403 Forbidden");
      assert.deepEqual([...proxy.refused], [
        ["proxy-refused.example:80", "at 93.184.215.99, an address MAKERSMCP_REFUSE_ADDRESSES refuses"],
        ["proxy-inside.example:443", NOT_PUBLIC],
        ["proxy-site.example:8080", "on port 8080, not 80 or 443, and not on the scheme, host and port given"],
        ["proxy-site.example:8443", "on port 8443, not 80 or 443, and not on the scheme, host and port given"],
      ]);
      assert.equal(asked.get("proxy-site.example"), 1);
      assert.deepEqual(stand.made().filter((at) => /^93\.|^127\.0\.0\.1:(80|443)$/.test(at)), ["93.184.215.14:80", "93.184.215.14:80", "93.184.215.14:80", "93.184.215.14:443"]);
    } finally {
      if (saved === undefined) delete process.env.MAKERSMCP_REFUSE_ADDRESSES;
      else process.env.MAKERSMCP_REFUSE_ADDRESSES = saved;
      if (proxy) proxy.close();
      stand.restore();
      site.server.close();
    }
  }));

// The certificate chain of an https site whose leaf names its issuer at
// `issuer` (Authority Information Access), the issuer itself left out of
// what the site sends, as a browser then fetches it: { key, cert }.
function chainNaming(root, issuer) {
  const run = (...args) => {
    const done = spawnSync("openssl", args, { cwd: root, encoding: "utf8" });
    assert.equal(done.status, 0, done.stderr);
  };
  fs.writeFileSync(path.join(root, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  fs.writeFileSync(path.join(root, "leaf.ext"), `subjectAltName=DNS:localhost,IP:127.0.0.1\nauthorityInfoAccess=caIssuers;URI:${issuer}\nextendedKeyUsage=serverAuth\n`);
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "root.crt", "-days", "1", "-subj", "/CN=Test Root", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "mid.key", "-out", "mid.csr", "-subj", "/CN=Test Issuer");
  run("x509", "-req", "-in", "mid.csr", "-CA", "root.crt", "-CAkey", "root.key", "-CAcreateserial", "-out", "mid.crt", "-days", "1", "-extfile", "ca.ext");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=localhost");
  run("x509", "-req", "-in", "leaf.csr", "-CA", "mid.crt", "-CAkey", "mid.key", "-CAcreateserial", "-out", "leaf.crt", "-days", "1", "-extfile", "leaf.ext");
  return { key: fs.readFileSync(path.join(root, "leaf.key")), cert: fs.readFileSync(path.join(root, "leaf.crt")) };
}

// Every request the browser makes on its own, of a site given on this
// machine, goes through the run's proxy, which refuses another port of the
// machine and a name that leads to it: a picture there, a frame there, a
// WebSocket there, a service worker's fetch, the related origin file
// WebAuthn asks a site for (/.well-known/webauthn), and the issuer a
// certificate names. With the browser asking the DNS and connecting for
// itself, each but the frame reached the other program, which no rule of
// the run saw: the frame is refused before its request too (BARRED). The
// run's own lookup, which the proxy asks, finds the WebAuthn name on this
// machine, as a site's DNS server can answer it; the browser looks no name
// up itself.
test("every request the browser makes on its own reaches nothing but the proxy's refusal: a picture, a frame, a WebSocket, a service worker's fetch, WebAuthn's well-known file and a certificate's issuer", { skip: noBrowser, timeout: 150_000 }, () =>
  withNames({ "rp-elsewhere.example": "127.0.0.1" }, async () => {
    setTimeLimit(180_000);
    const other = await trap();
    const away = `127.0.0.1:${other.port}`;
    const root = tempDir();
    const { server, origin } = await serve((req, res) => {
      if (req.url === "/sw.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(`self.addEventListener("install", (e) => e.waitUntil(fetch("http://${away}/from-worker").catch(() => {})));`);
      if (req.url !== "/") return res.writeHead(404).end();
      res.writeHead(200, html).end(`<!doctype html><title>Own</title><h1>Own</h1><img id="pic" src="http://${away}/picture.png"><iframe src="http://${away}/frame"></iframe>
<script>
try { new WebSocket("ws://${away}/socket"); } catch (e) {}
navigator.serviceWorker.register("/sw.js").catch(() => {});
navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), rpId: "rp-elsewhere.example", timeout: 4000 } }).catch(() => {});
</script>`);
    });
    const given = `http://localhost:${new URL(origin).port}/`;
    let chrome = null;
    let secure = null;
    try {
      chrome = await launch({ guard: await guardFor(given) });
      const tab = await openTab(chrome, DESKTOP);
      const barred = [];
      const unreached = [];
      tab.on(BARRED, (b) => barred.push([b.url, b.why]));
      tab.on(UNREACHED, (u) => unreached.push([u.url, u.why]));
      try {
        assert.equal((await navigate(tab, given)).status, 200);
        const until = Date.now() + 10_000;
        while ((!chrome.proxy.refused.has(away) || !chrome.proxy.refused.has("rp-elsewhere.example:443")) && Date.now() < until) await sleep(100);
        await sleep(1_500);
      } finally {
        await closeTab(chrome, tab);
      }
      assert.deepEqual(barred, [[`http://${away}/frame`, NOT_GIVEN]]);
      // One note for the other program, from the picture or the WebSocket,
      // whichever the browser tells of first: Chrome 155 the picture, 157
      // the WebSocket.
      assert.equal(unreached.length, 1, JSON.stringify(unreached));
      assert.ok([`http://${away}`, `ws://${away}`].includes(unreached[0][0]), unreached[0][0]);
      assert.equal(unreached[0][1], NOT_GIVEN);
      assert.equal(chrome.proxy.refused.get(away), NOT_GIVEN);
      assert.equal(chrome.proxy.refused.get("rp-elsewhere.example:443"), NOT_GIVEN);
      // An https site given whose certificate names its issuer at the other
      // program: the browser fetches the issuer to complete the chain.
      if (!noOpenssl) {
        secure = https.createServer(chainNaming(root, `http://${away}/issuer.der`), (req, res) => res.writeHead(200, html).end("<h1>Secure</h1>"));
        await new Promise((resolve) => secure.listen(0, "127.0.0.1", resolve));
        const secureGiven = `https://localhost:${secure.address().port}/`;
        chrome.proxy.refused.clear();
        chrome.guard = await guardFor(secureGiven);
        const secureTab = await openTab(chrome, DESKTOP);
        try {
          await assert.rejects(navigate(secureTab, secureGiven), /net::ERR_CERT_AUTHORITY_INVALID/);
        } finally {
          await closeTab(chrome, secureTab);
        }
        assert.equal(chrome.proxy.refused.get(away), NOT_GIVEN);
      }
      assert.deepEqual(other.seen, []);
    } finally {
      if (chrome) await chrome.close();
      if (secure) secure.close();
      server.close();
      other.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));

// From a site on the public internet the same holds for another port of its
// own host: a picture there and a frame there reach nothing but the
// refusal, which names the port. The run's proxy takes the site's address
// on port 80 to its server, and the other program listens on that other
// port of this machine.
test("from a site on the public internet, a picture and a frame on another port of its host reach nothing but the refusal", { skip: noBrowser, timeout: 60_000 }, () =>
  withNames({ "public-pic.example": "93.184.215.20" }, async () => {
    setTimeLimit(60_000);
    const other = await trap();
    const { server, origin } = await serve((req, res) => {
      if (req.url !== "/") return res.writeHead(404).end();
      res.writeHead(200, html).end(`<!doctype html><title>Public</title><h1>Public</h1><img src="http://public-pic.example:${other.port}/picture.png"><iframe src="http://public-pic.example:${other.port}/frame"></iframe>`);
    });
    const stand = reachAt({ "93.184.215.20:80": `127.0.0.1:${new URL(origin).port}` });
    const otherPort = `on port ${other.port}, not 80 or 443, and not on the scheme, host and port given`;
    let chrome = null;
    try {
      chrome = await launch({ guard: await guardFor("http://public-pic.example/") });
      const tab = await openTab(chrome, DESKTOP);
      const barred = [];
      const unreached = [];
      tab.on(BARRED, (b) => barred.push([b.url, b.why]));
      tab.on(UNREACHED, (u) => unreached.push([u.url, u.why]));
      try {
        assert.equal((await navigate(tab, "http://public-pic.example/")).status, 200);
        await sleep(1_500);
      } finally {
        await closeTab(chrome, tab);
      }
      assert.deepEqual(barred, [[`http://public-pic.example:${other.port}/frame`, otherPort]]);
      assert.deepEqual(unreached, [[`http://public-pic.example:${other.port}`, otherPort]]);
      assert.deepEqual(other.seen, []);
    } finally {
      if (chrome) await chrome.close();
      stand.restore();
      server.close();
      other.close();
    }
  }));

// On a machine whose own address is on the public internet, as a server's,
// a site it serves given by a name that moves on to its www name at that
// address is taken there, its picture from another of its names at that
// address too, the same program on the port given: the run stopped at that
// move as an address of this machine, where 0.1.3 took the site. Here the
// machine's network interfaces hold 81.2.69.160, and the run's proxy takes
// that address to the site's server on this machine.
test("a site a server serves at its own address, given by a name that moves on to its www name there, is taken with what its other names there serve", { skip: noBrowser, timeout: 90_000 }, () =>
  withNames({ "own.example": "81.2.69.160", "www.own.example": "81.2.69.160", "static.own.example": "81.2.69.160" }, async () => {
    setTimeLimit(80_000);
    const saved = os.networkInterfaces;
    os.networkInterfaces = () => ({ ...saved(), own0: [{ address: "81.2.69.160", netmask: "255.255.255.255", family: "IPv4", internal: false, cidr: "81.2.69.160/32" }] });
    const seen = [];
    let port = 0;
    const { server, origin } = await serve((req, res) => {
      const host = String(req.headers.host).replace(/:\d+$/, "");
      seen.push(`${host} ${req.url}`);
      if (host === "own.example") return res.writeHead(301, { Location: `http://www.own.example:${port}/` }).end();
      if (host === "static.own.example" && req.url === "/logo.svg") return res.writeHead(200, { "Content-Type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="rgb(0,160,0)"/></svg>');
      if (host !== "www.own.example" || req.url !== "/") return res.writeHead(404).end();
      res.writeHead(200, html).end(`<!doctype html><title>Own | Home</title><h1>Own</h1><img id="logo" src="http://static.own.example:${port}/logo.svg">`);
    });
    port = Number(new URL(origin).port);
    const stand = reachAt({ "81.2.69.160": "127.0.0.1" });
    let chrome = null;
    try {
      const given = `http://own.example:${port}/`;
      chrome = await launch({ guard: await guardFor(given) });
      const tab = await openTab(chrome, DESKTOP);
      const barred = [];
      const unreached = [];
      tab.on(BARRED, (b) => barred.push([b.url, b.why]));
      tab.on(UNREACHED, (u) => unreached.push([u.url, u.why]));
      try {
        assert.equal((await navigate(tab, given)).status, 200);
        const until = Date.now() + 5_000;
        let loaded = false;
        while (!loaded && Date.now() < until) {
          const { result } = await tab.send("Runtime.evaluate", { expression: "document.getElementById('logo').complete && document.getElementById('logo').naturalWidth", returnByValue: true });
          loaded = result.value === 40;
          if (!loaded) await sleep(100);
        }
        const { result } = await tab.send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
        assert.equal(result.value, `http://www.own.example:${port}/`);
        assert.ok(loaded, "the picture from static.own.example was loaded");
      } finally {
        await closeTab(chrome, tab);
      }
      assert.deepEqual([barred, unreached], [[], []]);
      assert.deepEqual(seen.filter((line) => !line.endsWith("/favicon.ico")), ["own.example /", "www.own.example /", "static.own.example /logo.svg"]);
    } finally {
      os.networkInterfaces = saved;
      if (chrome) await chrome.close();
      stand.restore();
      server.close();
    }
  }));

// A page's speculation rules have a browser whose own preloading is on fetch
// an address before any move there: the kit's browser runs with it off, and
// one that preloads is not used (see shots.test.js), but the proxy refuses
// such a fetch all the same. Here a browser started by the test, its
// preloading on, goes through the kit's proxy, and the prefetch of another
// port of this machine reaches nothing but the proxy's refusal; without the
// proxy the other program got the browser's GET /prefetched.
test("a speculation rules prefetch of a browser with its preloading on reaches nothing but the proxy's refusal", { skip: noBrowser || (process.platform !== "linux" && "the browser is started headless with --dump-dom, which the test reads on Linux"), timeout: 60_000 }, async (t) => {
  // The browser's temp folder is its profile, so what it leaves there goes
  // with it, as the kit has it (see roomIn() in chrome.js).
  const profile = tempDir();
  if (!roomIn(profile)) {
    fs.rmSync(profile, { recursive: true, force: true });
    return t.skip(`${profile} leaves no room for the browser's lock`);
  }
  const other = await trap();
  const away = `127.0.0.1:${other.port}`;
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/slow.png") return setTimeout(() => res.writeHead(404).end(), 2_000);
    res.writeHead(200, html).end(`<!doctype html><title>Spec</title><h1>Spec</h1><script type="speculationrules">{"prefetch":[{"source":"list","urls":["http://${away}/prefetched"],"eagerness":"immediate"}]}</script><img src="/slow.png">`);
  });
  const guard = await guardFor(`${origin}/`);
  const proxy = await startProxy(() => guard);
  // No display and no session bus, as the kit's own browser has (see
  // browserEnv() in chrome.js), and its crash reports and config in its
  // profile, not in the user's own browser's (see configIn()).
  const env = { ...process.env, TMPDIR: profile, WAYLAND_DISPLAY: path.join(profile, "no-display"), DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(profile, "no-bus")}`, CHROME_CONFIG_HOME: profile, XDG_CONFIG_HOME: path.join(profile, "config") };
  delete env.DISPLAY;
  delete env.WAYLAND_SOCKET;
  let browser = null;
  try {
    browser = spawn(findChrome(), ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--dump-dom", `--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>", ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []), `${origin}/`], { stdio: ["ignore", "pipe", "ignore"], env });
    let dom = "";
    browser.stdout.on("data", (d) => (dom += d));
    await new Promise((resolve) => browser.on("exit", resolve));
    assert.match(dom, /<h1>Spec<\/h1>/);
    assert.equal(proxy.refused.get(away), NOT_GIVEN);
    assert.deepEqual(other.seen, []);
  } finally {
    // A browser left running when the test fails or runs out of time.
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      browser.kill("SIGKILL");
      await new Promise((resolve) => browser.once("exit", resolve));
    }
    proxy.close();
    server.close();
    other.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

// WebRTC sends UDP around a proxy: with the proxy alone a page's STUN
// requests reached a server on this machine. The browser runs with the
// policy that sends none past it.
test("WebRTC sends no UDP past the proxy", { skip: noBrowser, timeout: 60_000 }, async () => {
  setTimeLimit(60_000);
  const udp = dgram.createSocket("udp4");
  let packets = 0;
  udp.on("message", () => packets++);
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const { server, origin } = await serve((req, res) =>
    res.writeHead(200, html).end(`<!doctype html><title>Call</title><h1>Call</h1><script>const rtc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udp.address().port}" }] }); rtc.createDataChannel("x"); rtc.createOffer().then((offer) => rtc.setLocalDescription(offer));</script>`),
  );
  let chrome = null;
  try {
    chrome = await launch({ guard: await guardFor(`${origin}/`) });
    const tab = await openTab(chrome, DESKTOP);
    try {
      assert.equal((await navigate(tab, `${origin}/`)).status, 200);
      // ICE asks a STUN server at once; two seconds is long past that.
      await sleep(2_000);
    } finally {
      await closeTab(chrome, tab);
    }
    assert.equal(packets, 0, "UDP packets that reached the STUN server");
  } finally {
    if (chrome) await chrome.close();
    server.close();
    udp.close();
  }
});

// What the browser sends on the networks of the machine past its proxy:
// nothing. In a network namespace of the test's own, with a dummy network
// where stand-ins for screens to cast to answer, and stand-ins for the DNS
// servers the machine names (see network.js), a page asks
// whether a screen to cast to is there, with no click and no permission,
// and gives WebRTC two candidates of the other side by name. With the Media
// Router on, the browser searched every network of the machine (SSDP and
// mDNS) and connected to both devices, the DIAL one with a GET of its
// description and the Cast one over TLS; with its own lookup, it asked the
// network for the .local name and the DNS for the other one, which no rule
// of the run judged; and with WebRTC's names for its own addresses, any
// RTCPeerConnection, the start's own probe of WebRTC too, had it join mDNS's
// group on the network to answer for them, though it gathers no address of
// its own to name.
const noNamespace = (() => {
  if (process.platform !== "linux") return "network namespaces are Linux's";
  const probe = spawnSync("unshare", ["-rn", "sh", "-c", `ip link add d0 type dummy && unshare -U --map-user=${process.getuid()} --map-group=${process.getgid()} true`], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return `no network namespace of the test's own here (unshare -rn with ip and unshare -U --map-user: ${String(probe.stderr || probe.error || probe.status).trim().slice(0, 200)})`;
  return false;
})();

test("the browser sends nothing past its proxy on the machine's networks: no search for screens to cast to, and no lookup of a name a page gives WebRTC", { skip: noBrowser || noNamespace, timeout: 150_000 }, async () => {
  const child = spawn("unshare", ["-rn", process.execPath, path.join(__dirname, "network.js"), "outer", String(process.getuid()), String(process.getgid())], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 140_000);
  await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  const line = out.trim().split("\n").pop() || "";
  let seen = null;
  try {
    seen = JSON.parse(line);
  } catch {
    assert.fail(`network.js printed no result: ${(out + err).trim().slice(-600)}`);
  }
  assert.equal(seen.failed, "");
  // The page asked, and gave its candidates.
  assert.deepEqual(seen.shown.split(" ").sort(), ["asked", "candidates"]);
  assert.deepEqual({ ssdp: seen.ssdp, mdns: seen.mdns, dns: seen.dns, connections: seen.connections, joined: seen.joined }, { ssdp: 0, mdns: [], dns: [], connections: [], joined: [] });
});

// On a machine whose one network up is its loopback, as one offline, or a
// container with no network, a site of the machine given as the address is
// taken: there the browser does not say it is done gathering WebRTC's
// candidates for its first seconds, and the start, which waited for that
// among its probes of the proxy, stopped most runs as ones whose browser
// was too slow for them, where 0.1.3 took the site. In a network namespace
// of the test's own with its loopback alone (see network.js), the kit's own
// command. The next test holds the probe's time where the browser never says
// so.
test("on a machine whose one network is its loopback, a site of the machine given as the address is taken", { skip: noBrowser || noNamespace, timeout: 150_000 }, async () => {
  const root = tempDir();
  try {
    const folder = path.join(root, "shots");
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const child = spawn("unshare", ["-rn", process.execPath, path.join(__dirname, "network.js"), "alone", String(process.getuid()), String(process.getgid()), cli, folder], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 140_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    let told = null;
    try {
      told = JSON.parse(out.trim().split("\n").pop());
    } catch {
      assert.fail(`network.js printed no result: ${(out + err).trim().slice(-600)}`);
    }
    assert.equal(told.status, 0, told.said || err);
    assert.match(fs.readFileSync(path.join(folder, "SCREENSHOTS.md"), "utf8"), /Local/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// This machine's own addresses are not opened away from the address given,
// a public one included: a machine on an IPv6 network holds a global address
// of its own, and a server can hold a public IPv4 address, each on the
// public internet by its range, and a site that read the address off the
// run's own connection had the browser load a frame, a picture and a
// fetch() from a service of the machine that listens on all its addresses,
// and the kit read the sitemap its robots.txt named there, with no word. In
// network namespaces of the test's own joined by a veth link (see
// network.js), the kit's own command.
const noVeth = (() => {
  if (noNamespace) return noNamespace;
  const probe = spawnSync("unshare", ["-rn", "sh", "-c", `ip link add v0 type veth peer name v1 && unshare -n true && unshare -U --map-user=${process.getuid()} --map-group=${process.getgid()} true`], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return `no veth link between network namespaces of the test's own here (unshare -rn with ip and unshare -n: ${String(probe.stderr || probe.error || probe.status).trim().slice(0, 200)})`;
  return false;
})();

test("an address of this machine's own, a public one too, is not opened from a site that reads it off the run's connection", { skip: noBrowser || noVeth, timeout: 200_000 }, async () => {
  const root = tempDir();
  try {
    const folder = path.join(root, "shots");
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const child = spawn("unshare", ["-rn", process.execPath, path.join(__dirname, "network.js"), "own", String(process.getuid()), String(process.getgid()), cli, folder], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 190_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    let told = null;
    try {
      told = JSON.parse(out.trim().split("\n").pop());
    } catch {
      assert.fail(`network.js printed no result: ${(out + err).trim().slice(-600)}`);
    }
    assert.equal(told.status, 0, told.said || told.failed || err);
    // Nothing reached the machine's own service.
    assert.deepEqual(told.seen, []);
    const [home] = told.manifest.pages;
    // In whichever order the browser named them.
    assert.deepEqual([...home.notes].sort(), [
      "a frame of it tried to open http://81.2.69.160/frame4, which is at 81.2.69.160, an address of this machine: it was not opened",
      "a frame of it tried to open http://[2a02:1205:5000::1]/frame6, which is at 2a02:1205:5000::1, an address of this machine: it was not opened",
      "it asked for http://[2a02:1205:5000::1], which is at 2a02:1205:5000::1, an address of this machine: nothing was sent there",
    ]);
    assert.ok(told.manifest.notes.includes("The sitemap http://[2a02:1205:5000::1]/sitemap.xml, which robots.txt names, was not read: it is at 2a02:1205:5000::1, an address of this machine."), JSON.stringify(told.manifest.notes));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The start's probe of WebRTC ends 1.5 s after its offer was set, where the
// browser does not say it is done gathering: waited for, as on a machine
// whose one network is its loopback, the probe ran to its 10 s and the
// browser was said to be too slow for the run's checks of its proxy. Here a
// relay of the browser's pipe, the program CHROME_PATH names, has the
// probe's page never hear that gathering is done.
test("the start's probe of WebRTC ends in its time where the browser never says it is done gathering", { skip: noBrowser || (process.platform === "win32" && "the relay is started by a shell script"), timeout: 90_000 }, async () => {
  setTimeLimit(90_000);
  const root = tempDir();
  const relay = path.join(root, "relay.js");
  const log = path.join(root, "rewritten.log");
  fs.writeFileSync(
    relay,
    `"use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const child = spawn(${JSON.stringify(findChrome())}, process.argv.slice(2), { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] });
const fromKit = fs.createReadStream(null, { fd: 3 });
const toKit = fs.createWriteStream(null, { fd: 4 });
for (const stream of [fromKit, toKit, child.stdio[3], child.stdio[4]]) stream.on("error", () => {});
const split = (stream, take) => {
  let bytes = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    let at;
    while ((at = bytes.indexOf(0)) >= 0) {
      const text = bytes.subarray(0, at).toString();
      bytes = bytes.subarray(at + 1);
      take(text);
    }
  });
};
split(fromKit, (text) => {
  const msg = JSON.parse(text);
  if (msg.method === "Runtime.evaluate" && /iceGatheringState === "complete"/.test(msg.params.expression)) {
    msg.params.expression = msg.params.expression.replace('rtc.iceGatheringState === "complete"', "false");
    fs.appendFileSync(${JSON.stringify(log)}, "rewritten\\n");
  }
  child.stdio[3].write(JSON.stringify(msg) + "\\0");
});
split(child.stdio[4], (text) => toKit.write(text + "\\0"));
fromKit.on("end", () => child.stdio[3].end());
child.on("exit", (code) => process.exit(code === null ? 1 : code));
`,
  );
  const browser = path.join(root, "gathering");
  fs.writeFileSync(browser, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(relay)} "$@"\n`, { mode: 0o755 });
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = browser;
  try {
    const chrome = await launch();
    await chrome.close();
    assert.equal(fs.readFileSync(log, "utf8"), "rewritten\n");
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Names whose DNS gives no answer do not hold up the lookup of another name
// a page asks for, and the run's process ends once it has saved: with the
// 4 threads Node starts with, the system's lookup tried two names at once,
// each for as long as the system waits, so a picture on a name the system
// answers at once, asked after six such names, waited behind them past its
// own 10 s and was refused as on a host whose name could not be looked up,
// where 0.1.3's browser drew it, and the process lived on until the system
// had tried every name. In namespaces of the test's own (see network.js):
// a network of its loopback alone, a DNS server there that answers no
// question, with glibc waiting 10 s for one, and a hosts file that holds
// the picture's name. The kit's own command.
const noMountNamespace = (() => {
  if (process.platform !== "linux") return "network and mount namespaces are Linux's";
  const probe = spawnSync("unshare", ["-rmn", "sh", "-c", `ip link set lo up && mount --bind "$0" "$0" && unshare -U --map-user=${process.getuid()} --map-group=${process.getgid()} true`, __filename], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return `no network and mount namespace of the test's own here (unshare -rmn with ip and mount --bind, and unshare -U --map-user: ${String(probe.stderr || probe.error || probe.status).trim().slice(0, 200)})`;
  return false;
})();

test("names whose DNS gives no answer do not hold up a picture on another name, and the run's process ends once it has saved", { skip: noBrowser || noMountNamespace, timeout: 150_000 }, async () => {
  const root = tempDir();
  try {
    const resolv = path.join(root, "resolv.conf");
    const hosts = path.join(root, "hosts");
    fs.writeFileSync(resolv, "nameserver 127.0.0.1\noptions timeout:10 attempts:1\n");
    fs.writeFileSync(hosts, "127.0.0.1 localhost\n::1 localhost\n93.184.216.34 cdn.good.example\n");
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const script = 'ip link set lo up && mount --bind "$1" /etc/resolv.conf && mount --bind "$2" /etc/hosts && exec "$3" "$4" silent "$5" "$6" "$7" "$8" 6';
    const child = spawn("unshare", ["-rmn", "sh", "-c", script, "sh", resolv, hosts, process.execPath, path.join(__dirname, "network.js"), String(process.getuid()), String(process.getgid()), cli, path.join(root, "shots")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 140_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    let told = null;
    try {
      told = JSON.parse(out.trim().split("\n").pop());
    } catch {
      assert.fail(`network.js printed no result: ${(out + err).trim().slice(-600)}`);
    }
    assert.equal(told.status, 0, told.said || err);
    const [page] = told.manifest.pages;
    assert.equal(page.title, "Acme | Loaded", JSON.stringify(page.notes));
    assert.deepEqual(page.notes.filter((note) => /nothing was sent there/.test(note) && !/^it asked for (http:\/\/dead[1-6]\.example, which is on a host whose name could not be looked up|3 more addresses the run does not open): nothing was sent there$/.test(note)), []);
    // The system is asked the six names at once and gives up on each 10 s
    // after it was asked, so the process ends 10 s after it asked them, as a
    // run can save while their pictures still load; it lived on until the
    // system had been asked each name in turn, two at a time. Judged by what
    // the test's DNS server was asked and when, as the next test says.
    const six = told.asked.filter(([name]) => /^dead[1-6]\.example$/.test(name)).map(([, at]) => at);
    assert.equal(six.length, 6, JSON.stringify(told.asked));
    assert.ok(Math.max(...six) - Math.min(...six) < 5_000, `the system was asked the six names over ${Math.max(...six) - Math.min(...six)} ms`);
    assert.ok(told.quiet < 20_000, `the run's process lived ${told.quiet} ms after the system was last asked a name`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Once a run has saved, a name still waiting for its lookup is not asked,
// and the run's process ends once the system has given up on the 16 it was
// trying, 10 s after it was asked the last of them here: a page that
// fetch()es from 40 names whose DNS gives no answer as it has loaded has
// more names waiting than are tried as it is taken, and asked in turn, 16
// at a time, each round 10 s, they held the process that much longer past
// its end. Judged by what the test's DNS server was asked and when: no name
// of the page's is first asked after the run printed its manifest, and the
// process ends within 20 s of the server's last question, the system's 10 s
// and as much again for a busy machine, where the process was to end within
// 13 s of the print, and a run in a container of 3 GB with the rest of the
// suite beside it ended 13.4 s after it. In the same namespaces.
test("once a run has saved, a name still waiting for its lookup is not asked, and the run's process ends", { skip: noBrowser || noMountNamespace, timeout: 150_000 }, async () => {
  const root = tempDir();
  try {
    const resolv = path.join(root, "resolv.conf");
    const hosts = path.join(root, "hosts");
    fs.writeFileSync(resolv, "nameserver 127.0.0.1\noptions timeout:10 attempts:1\n");
    fs.writeFileSync(hosts, "127.0.0.1 localhost\n::1 localhost\n93.184.216.34 cdn.good.example\n");
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const script = 'ip link set lo up && mount --bind "$1" /etc/resolv.conf && mount --bind "$2" /etc/hosts && exec "$3" "$4" silent "$5" "$6" "$7" "$8" burst';
    const child = spawn("unshare", ["-rmn", "sh", "-c", script, "sh", resolv, hosts, process.execPath, path.join(__dirname, "network.js"), String(process.getuid()), String(process.getgid()), cli, path.join(root, "shots")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 140_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    let told = null;
    try {
      told = JSON.parse(out.trim().split("\n").pop());
    } catch {
      assert.fail(`network.js printed no result: ${(out + err).trim().slice(-600)}`);
    }
    assert.equal(told.status, 0, told.said || err);
    const page = told.asked.filter(([name]) => /^dead-b\d+\.example$/.test(name));
    assert.ok(page.length > 0, `the system was asked none of the page's names: ${JSON.stringify(told.asked)}`);
    assert.deepEqual(page.filter(([, at]) => at > 0).map(([name]) => name), [], "names of the page's first asked after the run printed its manifest");
    assert.ok(told.quiet < 20_000, `the run's process lived ${told.quiet} ms after the system was last asked a name`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A site given by http on port 80 at a name of the user's network, or at an
// address of this machine's own on the public internet, is taken: the
// browser tries such a host over https on 443 first by itself, and the run
// opens that too, where it refused it as another program of the host, so a
// run given http://intranet.acme.com/ failed with "it leads to
// https://intranet.acme.com/, which is not on the public internet, and not
// on the host and port given". A name under no domain of the internet, as
// myapp.test, the browser opens by http alone, and there port 443 stays
// another program: a frame of its page at https://myapp.test/ is not
// opened, where the run opened 127.0.0.1:443 for it. In namespaces of the
// test's own (see network.js).
test("a site given by http on port 80 at a name of the user's network or an address of this machine is taken, as the browser tries https first, and of a name it does not try so port 443 is not opened", { skip: noBrowser || noMountNamespace, timeout: 300_000 }, async () => {
  const root = tempDir();
  try {
    const hosts = path.join(root, "hosts");
    fs.writeFileSync(hosts, "127.0.0.1 localhost\n::1 localhost\n10.1.2.3 intranet.acme.com\n127.0.0.1 myapp.test\n");
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const script = 'ip link set lo up && mount --bind "$1" /etc/hosts && exec "$2" "$3" upgraded "$4" "$5" "$6" "$7"';
    const child = spawn("unshare", ["-rmn", "sh", "-c", script, "sh", hosts, process.execPath, path.join(__dirname, "network.js"), String(process.getuid()), String(process.getgid()), cli, path.join(root, "shots")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 290_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    let told = null;
    try {
      told = JSON.parse(out.trim().split("\n").pop());
    } catch {
      assert.fail(`network.js printed no result: ${(out + err).trim().slice(-600)}`);
    }
    assert.deepEqual(
      told.runs.map(({ url, status, titles, tls }) => ({ url, status, titles, tried: tls > 0 })),
      [
        { url: "http://intranet.acme.com/", status: 0, titles: ["Site at 10.1.2.3"], tried: true },
        { url: "http://81.2.69.160/", status: 0, titles: ["Site at 81.2.69.160"], tried: true },
        { url: "http://myapp.test/", status: 0, titles: ["Site at 127.0.0.1"], tried: false },
      ],
      JSON.stringify(told.runs.map((run) => [run.said, run.tls])),
    );
    assert.deepEqual(told.runs[2].notes, ["a frame of it tried to open https://myapp.test/frame, which is not on the public internet, and not on the host and port given: it was not opened"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A site given by a name that answers both with its public address and with
// 127.0.0.1 is not opened: the run stops before any work, naming both. Taken
// for the user's own, as one of its answers was, its every answer was
// opened, so once the site served its first page and then refused new
// connections, the page's fetch() of its own address went through the
// proxy's next address to this machine's service on 127.0.0.1:80, and the
// page read it. A name all of whose answers are 127.0.0.1, as a dev name
// in the hosts file, is the user's own and taken. In namespaces of the
// test's own (see network.js).
test("a site given by a name that answers with a public address and with 127.0.0.1 is not opened, and nothing reaches this machine's service", { skip: noBrowser || noMountNamespace || noVeth, timeout: 240_000 }, async () => {
  const root = tempDir();
  try {
    const hosts = path.join(root, "hosts");
    fs.writeFileSync(hosts, "127.0.0.1 localhost\n::1 localhost\n2606:2800:220:1::99 evil.example\n127.0.0.1 evil.example\n127.0.0.1 mixdev.example\n");
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const script = 'ip link set lo up && mount --bind "$1" /etc/hosts && exec "$2" "$3" mixed "$4" "$5" "$6" "$7"';
    const child = spawn("unshare", ["-rmn", "sh", "-c", script, "sh", hosts, process.execPath, path.join(__dirname, "network.js"), String(process.getuid()), String(process.getgid()), cli, path.join(root, "shots")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 230_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    let told = null;
    try {
      told = JSON.parse(out.trim().split("\n").pop());
    } catch {
      assert.fail(`network.js printed no result: ${(out + err).trim().slice(-600)}`);
    }
    const [evil, dev] = told.runs;
    assert.equal(evil.status, 1, evil.said);
    assert.ok(evil.said.endsWith("easyscreenshotkit: Could not open http://evil.example/: it is on a host whose name answers with an address on the public internet, 2606:2800:220:1::99, and with one that is not, 127.0.0.1."), evil.said);
    // Nothing of the site's reached this machine's service, and the site
    // was not opened at all.
    assert.deepEqual(told.seen.filter((line) => line.includes("evil.example")), []);
    assert.deepEqual(told.site, []);
    assert.deepEqual({ status: dev.status, titles: dev.titles }, { status: 0, titles: ["Machine service"] }, dev.said);
    assert.ok(told.seen.includes("127.0.0.1 GET mixdev.example /"), JSON.stringify(told.seen));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// So does a demo: once it has saved, a name still waiting for its lookup is
// not asked, and its process ends once the system has given up on the 16
// it was trying. Here a page fetch()es from another name whose DNS gives
// no answer every tenth of a second for as long as it is open, so names
// wait at the end of any demo, and asked in turn, 16 at a time, each round
// 10 s, they held the demo's process that much longer past its end. Judged
// as above, by what the test's DNS server was asked and when. In the same
// namespaces.
const noFfmpeg = !require("../skills/easyscreenshotkit/scripts/lib/ffmpeg").findFfmpeg() && "no ffmpeg on this machine";

test("once a demo has saved, a name still waiting for its lookup is not asked, and the demo's process ends", { skip: noBrowser || noMountNamespace || noFfmpeg, timeout: 200_000 }, async () => {
  const root = tempDir();
  try {
    const resolv = path.join(root, "resolv.conf");
    const hosts = path.join(root, "hosts");
    fs.writeFileSync(resolv, "nameserver 127.0.0.1\noptions timeout:10 attempts:1\n");
    fs.writeFileSync(hosts, "127.0.0.1 localhost\n::1 localhost\n93.184.216.34 cdn.good.example\n");
    const cli = require.resolve("../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
    const script = 'ip link set lo up && mount --bind "$1" /etc/resolv.conf && mount --bind "$2" /etc/hosts && exec "$3" "$4" silent "$5" "$6" "$7" "$8" endless demo';
    const child = spawn("unshare", ["-rmn", "sh", "-c", script, "sh", resolv, hosts, process.execPath, path.join(__dirname, "network.js"), String(process.getuid()), String(process.getgid()), cli, path.join(root, "demo")], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 190_000);
    await new Promise((resolve) => child.on("close", resolve));
    clearTimeout(timer);
    let told = null;
    try {
      told = JSON.parse(out.trim().split("\n").pop());
    } catch {
      assert.fail(`network.js printed no result: ${(out + err).trim().slice(-600)}`);
    }
    assert.equal(told.status, 0, told.said || err);
    const page = told.asked.filter(([name]) => /^dead-e\d+\.example$/.test(name));
    assert.ok(page.length > 0, `the system was asked none of the page's names: ${JSON.stringify(told.asked)}`);
    assert.deepEqual(page.filter(([, at]) => at > 0).map(([name]) => name), [], "names of the page's first asked after the demo printed its manifest");
    assert.ok(told.quiet < 20_000, `the demo's process lived ${told.quiet} ms after the system was last asked a name`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A site you run on your machine and give as the address works through the
// proxy as before: here one started on localhost that listens on ::1 alone,
// as one can on a machine whose only IPv6 address is its loopback's, with
// its picture and a WebSocket on its own port.
const noLoopback6 = (() => {
  const probe = spawnSync(process.execPath, ["-e", 'require("net").createServer().listen(0, "::1", function () { this.close(); }).on("error", () => process.exit(1))']);
  return probe.status !== 0 && "this machine has no IPv6 loopback";
})();

test("a site on localhost given as the address is taken through the proxy, a WebSocket and a picture on its own port with it", { skip: noBrowser || noLoopback6, timeout: 60_000 }, async () => {
  setTimeLimit(60_000);
  const seen = [];
  const site = http.createServer((req, res) => {
    seen.push(req.url);
    if (req.url === "/pic.svg") return res.writeHead(200, { "Content-Type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="rgb(0,160,0)"/></svg>');
    res.writeHead(200, html).end(`<!doctype html><title>Dev</title><h1>Dev</h1><img id="pic" src="/pic.svg"><script>const ws = new WebSocket("ws://" + location.host + "/live"); ws.onmessage = (m) => (document.title = m.data);</script>`);
  });
  // The WebSocket's handshake, and one message on it.
  site.on("upgrade", (req, socket) => {
    seen.push(`upgrade ${req.url}`);
    const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 4, ...Buffer.from("live")]));
    socket.on("error", () => {});
  });
  await new Promise((resolve) => site.listen(0, "::1", resolve));
  const port = site.address().port;
  const given = `http://localhost:${port}/`;
  // Nothing is reached at 127.0.0.1 on that port, whatever listens there,
  // as another job's server can: such a connection is refused, as the
  // system refuses one where nothing listens.
  const before = dialer.connect;
  dialer.connect = (options) => {
    if (options.host !== "127.0.0.1" || Number(options.port) !== port) return before(options);
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
    return socket;
  };
  let chrome = null;
  try {
    chrome = await launch({ guard: await guardFor(given) });
    const tab = await openTab(chrome, DESKTOP);
    try {
      assert.equal((await navigate(tab, given)).status, 200);
      const until = Date.now() + 5_000;
      let shown = {};
      while (Date.now() < until) {
        const { result = {}, exceptionDetails } = await tab.send("Runtime.evaluate", { expression: "({ title: document.title, width: (document.getElementById('pic') || {}).naturalWidth, text: document.body ? document.body.innerText.slice(0, 200) : '' })", returnByValue: true });
        if (exceptionDetails) assert.fail(`the page could not be read: ${JSON.stringify(exceptionDetails).slice(0, 300)}`);
        shown = result.value || {};
        if (shown.title === "live" && shown.width) break;
        await sleep(100);
      }
      assert.deepEqual({ title: shown.title, width: shown.width }, { title: "live", width: 40 }, `the page held: ${JSON.stringify(shown)}`);
    } finally {
      await closeTab(chrome, tab);
    }
    assert.deepEqual([...chrome.proxy.refused].filter(([at]) => /localhost|::1|127\.0\.0\.1/.test(at)), []);
    assert.ok(seen.includes("/") && seen.includes("/pic.svg") && seen.includes("upgrade /live"), seen.join(" "));
  } finally {
    dialer.connect = before;
    if (chrome) await chrome.close();
    site.close();
  }
});

// A program for CHROME_PATH that starts the real browser, `real`, without
// the run's switches that `dropped` matches, relays its pipe (file
// descriptors 3 and 4), and names as the browser's own process, as the start
// asks it (SystemInfo.getProcessInfo), a process of its own whose command
// line holds every switch of the run's, so the start's reading of the
// switches (see switchesSaid() in chrome.js) finds them and its probes of
// the proxy decide (see proxySaid()), as they do for a browser a Chrome
// policy sends past the proxy, whose switches are the run's. It writes the
// switches it started the browser with to `told`, a line each.
function decoyBrowser(root, name, real, dropped, told) {
  const relay = path.join(root, `${name}.js`);
  fs.writeFileSync(
    relay,
    `"use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const args = process.argv.slice(2);
const decoy = spawn(process.execPath, ["-e", "const p = process.ppid; setInterval(() => { if (process.ppid !== p) process.exit(); }, 200);", "--", ...args], { stdio: "ignore" });
const started = args.filter((arg) => !${dropped}.test(arg));
fs.writeFileSync(${JSON.stringify(told)}, started.join("\\n"));
const child = spawn(${JSON.stringify(real)}, started, { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] });
const fromKit = fs.createReadStream(null, { fd: 3 });
const toKit = fs.createWriteStream(null, { fd: 4 });
for (const stream of [fromKit, toKit, child.stdio[3], child.stdio[4]]) stream.on("error", () => {});
const asked = new Set();
const split = (stream, take) => {
  let bytes = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    let at;
    while ((at = bytes.indexOf(0)) >= 0) {
      const text = bytes.subarray(0, at).toString();
      bytes = bytes.subarray(at + 1);
      take(text);
    }
  });
};
split(fromKit, (text) => {
  const msg = JSON.parse(text);
  if (msg.method === "SystemInfo.getProcessInfo") asked.add(msg.id);
  child.stdio[3].write(text + "\\0");
});
split(child.stdio[4], (text) => {
  const msg = JSON.parse(text);
  if (asked.has(msg.id) && msg.result) msg.result.processInfo = msg.result.processInfo.map((one) => (one.type === "browser" ? { ...one, id: decoy.pid } : one));
  toKit.write(JSON.stringify(msg) + "\\0");
});
fromKit.on("end", () => child.stdio[3].end());
child.on("exit", (code) => {
  decoy.kill();
  process.exit(code === null ? 1 : code);
});
`,
  );
  const browser = path.join(root, name);
  fs.writeFileSync(browser, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(relay)} "$@"\n`, { mode: 0o755 });
  return browser;
}

// A browser that sends its requests past the run's proxy, as a Chrome policy
// (ProxySettings) or a program that starts it without the run's switches
// can make it, asks the DNS and connects for itself, past the run's rule:
// it is not used. Here the program CHROME_PATH names starts the browser
// with the proxy's switches taken out; on Linux, where the start reads the
// browser's switches first, it names a process of its own that holds them
// as the browser's, so the probes of the proxy decide (see decoyBrowser()).
test("a browser that sends its requests past the proxy is not used", { skip: noBrowser || (process.platform === "win32" && "the wrapper is a shell script"), timeout: 60_000 }, async () => {
  setTimeLimit(60_000);
  const root = tempDir();
  const told = path.join(root, "args");
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = decoyBrowser(root, "unproxied", findChrome(), "/^--proxy-(server|bypass-list)=/", told);
  try {
    await assert.rejects(launch(), {
      message: "unproxied does not send its requests through the proxy the run starts for it, as a Chrome policy (ProxySettings) or a program that starts it without the run's switches can make it, so it was not used: a page could have it reach an address the run does not open. Lift that policy, or point CHROME_PATH at the browser's own program.",
    });
    // The browser started and was ended, its profile gone with it.
    const args = fs.readFileSync(told, "utf8").split("\n");
    assert.deepEqual(args.filter((arg) => arg.startsWith("--proxy-")), []);
    const profile = args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
    await sleep(500);
    assert.equal(fs.existsSync(profile), false, profile);
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A browser that sends its requests for this machine's own addresses past
// the proxy, as one started without --proxy-bypass-list=<-loopback> does, or
// whose WebRTC sends UDP past it, as with its own policy (WebRtcIPHandling)
// or without --webrtc-ip-handling-policy, is not used: a page could have it
// reach a program of this machine, or send packets anywhere, past the rule.
// Here the program CHROME_PATH names starts the browser with that switch
// taken out, and names a process that holds it as the browser's (see
// decoyBrowser()).
test("a browser that sends this machine's addresses or WebRTC's UDP past the proxy is not used", { skip: noBrowser || (process.platform === "win32" && "the wrapper is a shell script"), timeout: 90_000 }, async () => {
  setTimeLimit(90_000);
  const root = tempDir();
  const saved = process.env.CHROME_PATH;
  // The browser itself, found before CHROME_PATH names a wrapper.
  const real = findChrome();
  try {
    for (const [name, dropped, message] of [
      ["bypassed", "/^--proxy-bypass-list=/", "bypassed sends its requests for this machine's own addresses past the proxy the run starts for it, as a program that starts it without the run's switches can make it, so it was not used: a page could have it reach an address the run does not open. Point CHROME_PATH at the browser's own program."],
      ["leaky", "/^--webrtc-ip-handling-policy=/", "leaky sends WebRTC's UDP past the proxy the run starts for it, as a Chrome policy (WebRtcIPHandling) or a program that starts it without the run's switches can make it, so it was not used: a page could have it reach an address the run does not open. Lift that policy, or point CHROME_PATH at the browser's own program."],
    ]) {
      process.env.CHROME_PATH = decoyBrowser(root, name, real, dropped, path.join(root, `${name}.args`));
      await assert.rejects(launch(), { message }, name);
    }
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A browser that runs with switches of its own after the run's, or without
// the run's, that hold it to its proxy, its Media Router off and its
// lookups to the run's own, is not used: Chrome takes the last value of a
// switch, so a program that started it with a --proxy-bypass-list of its
// own after the run's, <-loopback> kept and one port of 127.0.0.1 named, had
// a page's picture and fetch() reach that port of this machine past the
// proxy, and one with a --disable-features of its own had its Media Router
// search the machine's networks for screens to cast to and connect to
// those that answered, while each passed every probe of the start's. Nor is
// one with a switch Chrome takes in place of --proxy-server wherever it
// stands. Here the program CHROME_PATH names adds a switch, before or after
// the run's, or takes one out; one starts the browser apart from the run
// and stays; and one that relays the browser's pipe answers the question of
// which process is the browser's with an error, names none, or names one
// the run did not start. A browser launch() hands back where it was to
// refuse one is closed before the test fails. On Linux, where the
// browser's command line is read.
test("a browser that runs with switches of its own after the run's, or without the run's, is not used", { skip: noBrowser || (process.platform !== "linux" && "the browser's command line is read on Linux"), timeout: 300_000 }, async () => {
  setTimeLimit(300_000);
  const root = tempDir();
  const saved = process.env.CHROME_PATH;
  // The browser itself, found before CHROME_PATH names a wrapper.
  const real = findChrome();
  const features = (name) => `${name} runs without MediaRouter and WebRtcHideLocalIpsWithMdns in its last --disable-features, as a program that starts it with switches of its own after the run's, or without the run's, can make it, so it was not used: a page could have it search this machine's networks for screens to cast to and connect to them, past the proxy the run starts for it. Point CHROME_PATH at the browser's own program.`;
  const rules = (name) => `${name} runs without the run's --host-resolver-rules last, as a program that starts it with switches of its own after the run's, or without the run's, can make it, so it was not used: a page could have it look a name up itself and reach an address the run does not open, past the proxy the run starts for it. Point CHROME_PATH at the browser's own program.`;
  const proxied = (name, which) => `${name} runs without the run's --${which} last, as a program that starts it with switches of its own after the run's, or without the run's, can make it, so it was not used: a page could have it reach an address the run does not open, past the proxy the run starts for it. Point CHROME_PATH at the browser's own program.`;
  const overridden = (name, which) => `${name} runs with --${which}, which Chrome takes in place of the run's --proxy-server, as a program that starts it with switches of its own can make it, so it was not used: a page could have it reach an address the run does not open, past the proxy the run starts for it. Point CHROME_PATH at the browser's own program.`;
  const cannot = (name, why) => `${name} cannot say which switches it runs with (${why}), so it was not used: with switches of its own after the run's it could reach an address the run does not open, past the proxy the run starts for it. Point CHROME_PATH at the browser's own program.`;
  const leaving = (pattern) => `for a in "$@"; do shift; case "$a" in ${pattern}) ;; *) set -- "$@" "$a" ;; esac; done\n`;
  // A program that relays the browser's pipe, as the browser's parent, and
  // answers the kit's SystemInfo.getProcessInfo itself, by its mode.
  const relay = path.join(root, "relay.js");
  fs.writeFileSync(
    relay,
    `"use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const mode = process.argv[2];
const child = spawn(${JSON.stringify(real)}, process.argv.slice(3), { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] });
const fromKit = fs.createReadStream(null, { fd: 3 });
const toKit = fs.createWriteStream(null, { fd: 4 });
for (const stream of [fromKit, toKit, child.stdio[3], child.stdio[4]]) stream.on("error", () => {});
const asked = new Set();
const split = (stream, take) => {
  let bytes = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    let at;
    while ((at = bytes.indexOf(0)) >= 0) {
      const text = bytes.subarray(0, at).toString();
      bytes = bytes.subarray(at + 1);
      take(text);
    }
  });
};
split(fromKit, (text) => {
  const msg = JSON.parse(text);
  if (msg.method === "SystemInfo.getProcessInfo" && mode === "error") return toKit.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "SystemInfo.getProcessInfo wasn't found" } }) + "\\0");
  if (msg.method === "SystemInfo.getProcessInfo") asked.add(msg.id);
  child.stdio[3].write(text + "\\0");
});
split(child.stdio[4], (text) => {
  const msg = JSON.parse(text);
  if (asked.has(msg.id) && msg.result) msg.result.processInfo = mode === "none" ? msg.result.processInfo.filter((one) => one.type !== "browser") : msg.result.processInfo.map((one) => (one.type === "browser" ? { ...one, id: 1 } : one));
  toKit.write(JSON.stringify(msg) + "\\0");
});
fromKit.on("end", () => child.stdio[3].end());
child.on("exit", (code) => process.exit(code === null ? 1 : code));
`,
  );
  // launch() with CHROME_PATH at the program `name` whose script is body:
  // the error it throws, or a browser it hands back, closed at once.
  const launched = async (name, body) => {
    const browser = path.join(root, name);
    fs.writeFileSync(browser, `#!/bin/sh\n${body}`, { mode: 0o755 });
    process.env.CHROME_PATH = browser;
    const got = await launch().then(
      (chrome) => chrome,
      (err) => err,
    );
    if (got instanceof Error) return got.message;
    await got.close();
    return "used";
  };
  try {
    for (const [name, body, message] of [
      ["appended", `exec ${sh(real)} "$@" --disable-features=Translate\n`, features("appended")],
      ["dashed", `exec ${sh(real)} "$@" -disable-features=Translate\n`, features("dashed")],
      ["router", `exec ${sh(real)} "$@" --disable-features=MediaRouter\n`, features("router")],
      ["named", `exec ${sh(real)} "$@" --disable-features=WebRtcHideLocalIpsWithMdns\n`, features("named")],
      ["unfeatured", `${leaving("--disable-features=*")}exec ${sh(real)} "$@"\n`, features("unfeatured")],
      ["resolving", `${leaving("--host-resolver-rules=*")}exec ${sh(real)} "$@"\n`, rules("resolving")],
      ["rerouted", `exec ${sh(real)} "$@" "--host-resolver-rules=MAP * 127.0.0.1"\n`, rules("rerouted")],
      ["further", `exec ${sh(real)} "$@" "--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"\n`, rules("further")],
      ["spaced", `exec ${sh(real)} "$@" "--host-resolver-rules=MAP * ^NOTFOUND, EXCLUDE 127.0.0.1 ,EXCLUDE localhost"\n`, rules("spaced")],
      ["bypassed", `exec ${sh(real)} "$@" "--proxy-bypass-list=<-loopback>;127.0.0.1:6379"\n`, proxied("bypassed", "proxy-bypass-list")],
      ["bypassspaced", `exec ${sh(real)} "$@" "--proxy-bypass-list=<-loopback> ;127.0.0.1:6379"\n`, proxied("bypassspaced", "proxy-bypass-list")],
      ["served", `exec ${sh(real)} "$@" --proxy-server=http://127.0.0.1:1\n`, proxied("served", "proxy-server")],
      ["policy", `exec ${sh(real)} "$@" --webrtc-ip-handling-policy=default_public_interface_only\n`, proxied("policy", "webrtc-ip-handling-policy")],
      ["direct", `exec ${sh(real)} --no-proxy-server "$@"\n`, overridden("direct", "no-proxy-server")],
      ["scripted", `exec ${sh(real)} "$@" --proxy-pac-url=http://127.0.0.1:1/proxy.pac\n`, overridden("scripted", "proxy-pac-url")],
      ["unnamed", `exec ${sh(process.execPath)} ${sh(relay)} error "$@"\n`, cannot("unnamed", "SystemInfo.getProcessInfo wasn't found")],
      ["nameless", `exec ${sh(process.execPath)} ${sh(relay)} none "$@"\n`, cannot("nameless", "it names no process of its own")],
      ["elsewhere", `exec ${sh(process.execPath)} ${sh(relay)} other "$@"\n`, cannot("elsewhere", "its process, 1, is not one the run started")],
    ]) {
      assert.equal(await launched(name, body), message, name);
    }
    // A browser a program starts apart from the run, which then stays: its
    // process is no process the run started.
    const apart = await launched("apart", `setsid -f ${sh(real)} "$@"\nexec sleep 20\n`);
    assert.match(apart, /^apart cannot say which switches it runs with \(its process, \d+, is not one the run started\), so it was not used: /);
    // A switch of its own before the run's is the browser's, as the run's
    // comes last; and one the run does not read, after it.
    assert.equal(await launched("before", `exec ${sh(real)} --disable-features=Translate "--host-resolver-rules=MAP * 127.0.0.1" --proxy-server=http://127.0.0.1:1 "--proxy-bypass-list=<-loopback>;127.0.0.1:6379" --webrtc-ip-handling-policy=default "$@"\n`), "used");
    assert.equal(await launched("muted", `exec ${sh(real)} "$@" --mute-audio\n`), "used");
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Where this user cannot connect to 127.0.0.1, as behind a firewall that
// refuses it, the browser could not reach its proxy either, and every page
// would fail in the browser's bare words: the run says so before it starts
// the browser. Here the proxy's own connection to itself is refused.
test("a proxy this user cannot reach stops the run before the browser starts, saying why", { skip: noBrowser || (process.platform === "win32" && "the wrapper is a shell script"), timeout: 30_000 }, async () => {
  setTimeLimit(30_000);
  // The browser, behind a program that notes whether it was started.
  const root = tempDir();
  const browser = path.join(root, "noted");
  const started = path.join(root, "started");
  fs.writeFileSync(browser, `#!/bin/sh\n: > ${sh(started)}\nexec ${sh(findChrome())} "$@"\n`, { mode: 0o755 });
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = browser;
  const before = dialer.connect;
  dialer.connect = (options) => {
    if (options.host !== "127.0.0.1") return before(options);
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
    return socket;
  };
  try {
    await assert.rejects(launch(), { message: "noted was not started: the proxy the run starts for it on 127.0.0.1, the browser's one way to the network, cannot be reached here (ECONNREFUSED), as a firewall that keeps this user from 127.0.0.1 can make it. Let this user connect to its own ports on 127.0.0.1." });
    assert.equal(fs.existsSync(started), false, "the browser was started");
  } finally {
    dialer.connect = before;
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A site that is down is named in the browser's words for it, as before
// the proxy: over http and over https, where the browser hears only that
// its tunnel failed.
test("a site that is down is said so in the browser's own words through the proxy", { skip: noBrowser, timeout: 60_000 }, async () => {
  setTimeLimit(60_000);
  const gone = await serve((req, res) => res.end("gone"));
  const port = new URL(gone.origin).port;
  await new Promise((resolve) => gone.server.close(resolve));
  let chrome = null;
  try {
    chrome = await launch();
    for (const given of [`http://127.0.0.1:${port}/`, `https://127.0.0.1:${port}/`, `http://localhost:${port}/`]) {
      chrome.guard = await guardFor(given);
      const tab = await openTab(chrome, DESKTOP);
      try {
        await assert.rejects(navigate(tab, given), { message: `Could not open ${given}: net::ERR_CONNECTION_REFUSED`, reason: "net::ERR_CONNECTION_REFUSED" });
      } finally {
        await closeTab(chrome, tab);
      }
    }
  } finally {
    if (chrome) await chrome.close();
  }
});

// What the proxy did not pass on of a page's own requests is in the page's
// notes, with the reason, for each way a page asks another program of this
// machine for something, on a site given there: a picture over http and
// one over https, whose tunnel the proxy refused; a module script, a fetch()
// and an XMLHttpRequest, a picture with crossorigin and a WebSocket, which
// the browser fails in its own words and not with the proxy's answer, and
// which went without a note; and past three addresses on one page, how many
// more it asked for. The run has 300 s for its seven pages: it keeps 40 s
// for each page asked for, so in 120 s a run whose first six pages took more
// than 80 s, as on a busy machine, left out the seventh as out of time.
test("a run names in a page's notes what the proxy did not pass on of its requests, in each way a page asks", { skip: noBrowser, timeout: 330_000 }, async () => {
  const traps = [];
  for (let i = 0; i < 11; i++) traps.push(await trap());
  const at = (i) => `127.0.0.1:${traps[i].port}`;
  const ways = {
    "/module": `<script type="module" src="http://${at(5)}/app.js"></script>`,
    "/fetch": `<script>fetch("http://${at(6)}/api/data").catch(() => {});</script>`,
    "/xhr": `<script>const xhr = new XMLHttpRequest(); xhr.open("GET", "http://${at(7)}/api/data"); xhr.send();</script>`,
    "/cors": `<img crossorigin="anonymous" src="http://${at(8)}/logo.png">`,
    "/socket": `<script>try { new WebSocket("ws://${at(9)}/live"); } catch (e) {}</script>`,
    "/secure": `<img src="https://${at(10)}/secure.png">`,
  };
  const { server, origin } = await serve((req, res) => {
    const way = req.url === "/" ? [0, 1, 2, 3, 4].map((i) => `<img src="http://${at(i)}/${i}.png">`).join("") : ways[req.url];
    if (way === undefined) return res.writeHead(404).end();
    const name = req.url === "/" ? "Tools" : req.url.slice(1);
    res.writeHead(200, html).end(`<!doctype html><title>Acme | ${name}</title><h1>Acme ${name}</h1><p>The ${name} page of Acme, which makes tools for teams.</p>${way}<div style="height:1400px"></div>`);
  });
  const root = tempDir();
  const asked = (i) => `it asked for ${i === 9 ? "ws" : i === 10 ? "https" : "http"}://${at(i)}, which is ${NOT_GIVEN}: nothing was sent there`;
  try {
    const { manifest } = await takeShots(`${origin}/`, { dir: path.join(root, "shots"), pages: 7, extra: Object.keys(ways), sizes: "desktop", timeLimit: 300_000 });
    const notesOf = (where) => {
      const one = manifest.pages.find((p) => new URL(p.url).pathname === where);
      assert.ok(one, `${where} was not taken`);
      return one.notes.filter((note) => /nothing was sent there/.test(note));
    };
    // The home page asked five, of which three are named, in any order.
    const home = notesOf("/");
    assert.equal(home.length, 4, home.join("\n"));
    assert.equal(home.filter((note) => [0, 1, 2, 3, 4].some((i) => note === asked(i))).length, 3, home.join("\n"));
    assert.equal(home[3], "it asked for 2 more addresses the run does not open: nothing was sent there");
    const md = fs.readFileSync(path.join(root, "shots", "SCREENSHOTS.md"), "utf8");
    Object.keys(ways).forEach((where, n) => {
      assert.deepEqual(notesOf(where), [asked(n + 5)], where);
      assert.ok(md.includes(asked(n + 5)), `${where}: ${md}`);
    });
    assert.deepEqual(traps.flatMap((one) => one.seen), []);
  } finally {
    server.close();
    for (const one of traps) one.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The proxy listens on 127.0.0.1 alone, and only while its browser runs:
// its port takes no connection at another address of this machine, as
// 127.0.0.2 or ::1 are, and none once the browser has closed.
test("the run's proxy listens on 127.0.0.1 alone, and its port takes no connection once its browser has closed", { skip: noBrowser, timeout: 60_000 }, async () => {
  setTimeLimit(60_000);
  const reach = (host, port) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port }, () => {
        socket.destroy();
        resolve("connected");
      });
      socket.on("error", (err) => resolve(err.code));
      socket.setTimeout(3_000, () => {
        socket.destroy();
        resolve("no answer");
      });
    });
  const chrome = await launch();
  let closed = false;
  try {
    const { port } = chrome.proxy;
    assert.equal(await reach("127.0.0.1", port), "connected");
    const others = [...(process.platform === "linux" ? ["127.0.0.2"] : []), ...(noLoopback6 ? [] : ["::1"])];
    for (const host of others) assert.equal(await reach(host, port), "ECONNREFUSED", host);
    await chrome.close();
    closed = true;
    assert.equal(await reach("127.0.0.1", port), "ECONNREFUSED");
  } finally {
    if (!closed) await chrome.close();
  }
});

// The probes of the proxy are judged only once they have all come back: a
// browser that did not finish them in their time is said to be slow, with
// the start's advice (see launch()), not held by a policy, which nothing
// showed. Here a tab stands in for the browser's.
test("a browser that does not finish the proxy's probes in their time is not said to send its requests past the proxy", { timeout: 30_000 }, async () => {
  const proxy = { probe: "probe.easyscreenshotkit.invalid", loopback: "http://127.0.0.1:9/x", saw: () => false };
  const tab = (answer) => ({ send: async (method) => (method === "Runtime.evaluate" ? answer() : {}) });
  // The probes' own timer won the race, with the time they had: here what
  // the start had left, a second kept, cut below their 10 s.
  assert.deepEqual(await proxySaid(tab(() => ({ result: { value: "late" } })), () => 5_000, proxy), { late: { ms: 4_000, cut: true } });
  assert.deepEqual(await proxySaid(tab(() => ({ result: { value: "late" } })), () => 40_000, proxy), { late: { ms: 10_000, cut: false } });
  // The call itself ran out of time.
  assert.deepEqual(await proxySaid(tab(() => Promise.reject(Object.assign(new Error("Runtime.evaluate timed out"), { timedOut: true }))), () => 5_000, proxy), { late: { ms: 4_000, cut: true } });
  // Done, and the proxy saw none of them: the browser goes past it.
  const { why } = await proxySaid(tab(() => ({ result: { value: "done" } })), () => 5_000, proxy);
  assert.match(why, /^does not send its requests through the proxy the run starts for it/);
  // Not done, but a request for this machine's own address came straight
  // to the proxy's port, past it: that holds however slow the browser is.
  const past = { ...proxy, saw: (kind) => kind === "direct" };
  assert.match((await proxySaid(tab(() => ({ result: { value: "late" } })), () => 5_000, past)).why, /^sends its requests for this machine's own addresses past the proxy/);
});

// A browser too slow to finish the probes in their time is not used, in the
// start's own words for a slow browser, with the time the probes had, 10 s:
// the words named the start's whole wait, 45 s here, and asked for a longer
// --timeout, which gives the probes no more. Here the program CHROME_PATH
// names relays the browser's pipe and holds back the answer to the probes'
// call, as a browser that does not finish them would leave it unanswered.
test("a browser that does not finish the proxy's probes in the start's time is said to be slow", { skip: noBrowser || (process.platform === "win32" && "the relay is started by a shell script"), timeout: 90_000 }, async () => {
  setTimeLimit(60_000);
  const root = tempDir();
  const relay = path.join(root, "relay.js");
  fs.writeFileSync(
    relay,
    `"use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const child = spawn(${JSON.stringify(findChrome())}, process.argv.slice(2), { stdio: ["ignore", "ignore", "inherit", "pipe", "pipe"] });
const fromKit = fs.createReadStream(null, { fd: 3 });
const toKit = fs.createWriteStream(null, { fd: 4 });
for (const stream of [fromKit, toKit, child.stdio[3], child.stdio[4]]) stream.on("error", () => {});
const held = new Set();
const split = (stream, take) => {
  let bytes = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    let at;
    while ((at = bytes.indexOf(0)) >= 0) {
      const text = bytes.subarray(0, at).toString();
      bytes = bytes.subarray(at + 1);
      take(text);
    }
  });
};
split(fromKit, (text) => {
  const msg = JSON.parse(text);
  if (msg.method === "Runtime.evaluate" && /RTCPeerConnection/.test(msg.params.expression)) held.add(msg.id);
  child.stdio[3].write(text + "\\0");
});
split(child.stdio[4], (text) => {
  const msg = JSON.parse(text);
  if (held.has(msg.id)) return;
  toKit.write(text + "\\0");
});
fromKit.on("end", () => child.stdio[3].end());
child.on("exit", (code) => process.exit(code === null ? 1 : code));
`,
  );
  const browser = path.join(root, "slow-chrome");
  fs.writeFileSync(browser, `#!/bin/sh\nexec ${sh(process.execPath)} ${sh(relay)} "$@"\n`, { mode: 0o755 });
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = browser;
  try {
    await assert.rejects(launch(), { message: "slow-chrome started but did not finish the run's checks of its proxy in 10 s. The machine may be too busy: try again." });
  } finally {
    if (saved === undefined) delete process.env.CHROME_PATH;
    else process.env.CHROME_PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Two checks of the documents the proxy refuses, for when it refuses one
// that the browser's own guard let through, as a lookup refusal of the
// run's that refuses() did not give: an http page answered with the
// proxy's own refusal is not shown as a page, and an https one whose
// tunnel it refused is named with its reason, not as a tunnel that failed.
// Here the rule's lookup refuses every name its refuses() lets through.
test("a document the proxy refuses past the browser's guard is not shown, and its reason is said", { skip: noBrowser, timeout: 60_000 }, async () => {
  setTimeLimit(60_000);
  const { server, origin } = await serve((req, res) => res.writeHead(200, html).end("<!doctype html><title>Site</title><h1>Site</h1>"));
  const given = `${origin}/`;
  const rule = await guardFor(given);
  const walled = {
    ...rule,
    lookupFor: (raw) => (hostname, options, callback) => process.nextTick(callback, Object.assign(new Error(`${hostname} is ${NOT_GIVEN}`), { code: "ENOTPUBLIC", why: NOT_GIVEN, refused: `it is ${NOT_GIVEN}`, at: raw })),
  };
  let chrome = null;
  try {
    chrome = await launch();
    chrome.guard = walled;
    for (const url of [given, given.replace("http:", "https:")]) {
      const tab = await openTab(chrome, DESKTOP);
      try {
        await assert.rejects(navigate(tab, url), { message: `Could not open ${url}: it is ${NOT_GIVEN}.` });
      } finally {
        await closeTab(chrome, tab);
      }
    }
  } finally {
    if (chrome) await chrome.close();
    server.close();
  }
});

// A page taken on its loading screen as the run's time ran short is not told
// to give more time when its app is at an address the run does not open:
// more time does not bring it, as a longer run says it still showed a
// loading screen after 20 s, and the notes asked for more time beside the
// note that nothing was sent there. Here an app shell whose module script
// is on another port of this machine, in a run of 45 s.
test("a page taken on its loading screen whose app the run does not fetch is not told to give more time", { skip: noBrowser, timeout: 120_000 }, async () => {
  const other = await trap();
  const { server, origin } = await serve((req, res) => (req.url === "/" ? res.writeHead(200, html).end(`<!doctype html><title>App</title><div id="app"><h1>Loading…</h1></div><script type="module" src="http://127.0.0.1:${other.port}/app.js"></script>`) : res.writeHead(404).end()));
  const root = tempDir();
  try {
    const { manifest } = await takeShots(`${origin}/`, { dir: path.join(root, "shots"), pages: 1, sizes: "desktop", timeLimit: 45_000 });
    const [page] = manifest.pages;
    assert.ok(page.notes.includes(`it asked for http://127.0.0.1:${other.port}, which is ${NOT_GIVEN}: nothing was sent there`), JSON.stringify(page.notes));
    assert.ok(page.notes.some((note) => ["taken while it still showed a loading screen", "still showed a loading screen after 20 s"].includes(note)), JSON.stringify(page.notes));
    assert.deepEqual(page.notes.filter((note) => /give more with --timeout/.test(note)), []);
    assert.deepEqual(other.seen, []);
  } finally {
    server.close();
    other.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A page asked for with --page on another port of the site's host on this
// machine, at the path of a page the run took, is named with why the run
// does not open it, where it was said to be the same page as that one: no
// request goes there either way. In the screenshots and a demo's tour.
test("a page asked for on another port of the site's host is named with why it is not opened, not as the same page", { skip: noBrowser, timeout: 240_000 }, async () => {
  const other = await trap();
  const { server, origin } = await serve((req, res) => (req.url === "/" ? res.writeHead(200, html).end('<!doctype html><title>Acme | Tools</title><h1>Acme</h1><p>Tools for teams.</p><div style="height:1400px"></div>') : res.writeHead(404).end()));
  const root = tempDir();
  const elsewhere = `http://127.0.0.1:${other.port}/`;
  try {
    const { manifest } = await takeShots(`${origin}/`, { dir: path.join(root, "shots"), pages: 1, extra: [elsewhere], sizes: "desktop", timeLimit: 120_000 });
    assert.ok(manifest.notes.includes(`${elsewhere} was asked for but not taken: ${NOT_GIVEN}.`), JSON.stringify(manifest.notes));
    assert.deepEqual(manifest.skipped, [{ url: elsewhere, reason: NOT_GIVEN }]);
    setTimeLimit(120_000);
    const chrome = await launch({ guard: await guardFor(`${origin}/`) });
    try {
      const tour = await pickPages(chrome, `${origin}/`, { pages: 1, extra: [elsewhere] });
      assert.deepEqual(tour.skipped, [{ url: elsewhere, reason: NOT_GIVEN }]);
    } finally {
      await chrome.close();
    }
    assert.deepEqual(other.seen, []);
  } finally {
    server.close();
    other.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A page that moves on once it has loaded to an address the browser could
// not open shows the browser's own error page, which is no page of the
// site: it is not taken. It was saved as the site's screenshot, its title
// the host's name and its heading "This site can't be reached", with exit
// 0. Here a page moves on as it has loaded, to a host that refuses and to
// one that answers nothing, whose connections fail in 3 s; and one moves on
// twice to pages of its own and then to the host that refuses, each once
// the run's clean-up has hidden its banner, so the last move comes as the
// run's last round of following it takes the page as it stands, and that
// round does not take it either. A demo's tour leaves such a page out in the same words,
// where it stayed in the tour and the demo stopped at the step that
// visited it, with "<url> could not be opened.".
test("a page that moves on to an address the browser cannot open is not taken as the browser's error page", { skip: noBrowser, timeout: 400_000 }, () =>
  withNames({ "moves.acme.example": "93.184.215.14", "dead.acme.example": "93.184.215.15", "hole.acme.example": "93.184.215.16", "home-moves.acme.example": "93.184.215.14" }, async () => {
    const closed = await serve((req, res) => res.end("gone"));
    const closedPort = Number(new URL(closed.origin).port);
    await new Promise((resolve) => closed.server.close(resolve));
    const { server, origin } = await serve((req, res) => {
      const to = { "/moves-dead": "http://dead.acme.example/landing", "/moves-hole": "http://hole.acme.example/landing", "/moves-thrice": "/thrice-1", "/thrice-1": "/thrice-2", "/thrice-2": "http://dead.acme.example/landing" }[req.url];
      const moving = req.url === "/" && String(req.headers.host).startsWith("home-moves.") ? "http://dead.acme.example/landing" : "";
      if (req.url === "/" && !moving) return res.writeHead(200, html).end('<!doctype html><title>Acme | Tools</title><h1>Acme</h1><p>Tools for teams.</p><div style="height:1400px"></div>');
      if (moving) return res.writeHead(200, html).end(`<!doctype html><title>Acme | Moving</title><h1>Moving</h1><p>This home page moves on.</p><div style="height:1400px"></div><script>addEventListener("load", () => setTimeout(() => (location.href = ${JSON.stringify(moving)}), 300));</script>`);
      if (!to) return res.writeHead(404).end();
      if (/thrice/.test(req.url)) return res.writeHead(200, html).end(`<!doctype html><title>Acme | Moving</title><h1>Moving</h1><p>This page moves on once its banner is hidden.</p><div style="height:1400px"></div><div id="banner" style="position:fixed;bottom:0;left:0;right:0;height:60px;background:#222;color:#fff">We use cookies on this site. <button>Accept</button></div><script>new ResizeObserver(([seen]) => { if (seen.contentRect.height === 0 && !window.moving) { window.moving = true; location.href = ${JSON.stringify(to)}; } }).observe(document.getElementById("banner"));</script>`);
      res.writeHead(200, html).end(`<!doctype html><title>Acme | Moving</title><h1>Moving</h1><p>This page moves on.</p><div style="height:1400px"></div><script>addEventListener("load", () => setTimeout(() => (location.href = ${JSON.stringify(to)}), 300));</script>`);
    });
    const stand = reachAt({ "93.184.215.14": `127.0.0.1:${new URL(origin).port}`, "93.184.215.15": `127.0.0.1:${closedPort}` });
    const reached = dialer.connect;
    dialer.connect = (options) => {
      if (options.host !== "93.184.215.16") return reached(options);
      const socket = new net.Socket();
      setTimeout(() => socket.destroy(Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })), 3_000);
      return socket;
    };
    const root = tempDir();
    try {
      await assert.rejects(takeShots("http://moves.acme.example/moves-dead", { dir: path.join(root, "dead"), pages: 1, sizes: "desktop", timeLimit: 90_000 }), {
        message: "Could not open http://moves.acme.example/moves-dead: it moved on to http://dead.acme.example/landing once it had loaded, and the browser could not open that (net::ERR_CONNECTION_REFUSED).",
      });
      const { manifest } = await takeShots("http://moves.acme.example/", { dir: path.join(root, "hole"), pages: 1, extra: ["/moves-hole"], sizes: "desktop", timeLimit: 120_000 });
      assert.deepEqual(manifest.pages.map((page) => page.title), ["Acme | Tools"]);
      assert.ok(manifest.notes.some((note) => /^http:\/\/moves\.acme\.example\/moves-hole was asked for but not taken: could not be opened: it moved on to http:\/\/hole\.acme\.example\/landing once it had loaded, and the browser could not open that \(net::ERR_(CONNECTION_)?TIMED_OUT\)\.$/.test(note)), JSON.stringify(manifest.notes));
      assert.deepEqual(fs.readdirSync(path.join(root, "hole")).filter((name) => name.endsWith(".png")).sort(), ["01-home-desktop.png", "sheet.png"]);
      const thrice = await takeShots("http://moves.acme.example/", { dir: path.join(root, "thrice"), pages: 1, extra: ["/moves-thrice"], sizes: "desktop", timeLimit: 120_000 });
      assert.deepEqual(thrice.manifest.pages.map((page) => page.title), ["Acme | Tools"]);
      assert.ok(thrice.manifest.notes.includes("http://moves.acme.example/moves-thrice was asked for but not taken: could not be opened: it moved on to http://dead.acme.example/landing once it had loaded, and the browser could not open that (net::ERR_CONNECTION_REFUSED)."), JSON.stringify(thrice.manifest.notes));
      // A demo's tour, of the page given and of a page asked for.
      setTimeLimit(400_000);
      const chrome = await launch({ guard: await guardFor("http://moves.acme.example/") });
      try {
        const tour = await pickPages(chrome, "http://moves.acme.example/", { pages: 1, extra: ["/moves-dead"] });
        assert.deepEqual(tour.pages.map((page) => page.url), ["http://moves.acme.example/"]);
        assert.deepEqual(tour.skipped, [{ url: "http://moves.acme.example/moves-dead", reason: "could not be opened: it moved on to http://dead.acme.example/landing once it had loaded, and the browser could not open that (net::ERR_CONNECTION_REFUSED)" }]);
      } finally {
        await chrome.close();
      }
      const given = await launch({ guard: await guardFor("http://moves.acme.example/moves-dead") });
      try {
        await assert.rejects(pickPages(given, "http://moves.acme.example/moves-dead", { pages: 1 }), { message: "http://moves.acme.example/moves-dead was asked for but not taken: could not be opened: it moved on to http://dead.acme.example/landing once it had loaded, and the browser could not open that (net::ERR_CONNECTION_REFUSED). No demo was recorded." });
      } finally {
        await given.close();
      }
      // A home page given that moves on so: the tour stops at it, where it
      // went on with the browser's error page as the home page.
      const home = await launch({ guard: await guardFor("http://home-moves.acme.example/") });
      try {
        await assert.rejects(pickPages(home, "http://home-moves.acme.example/", { pages: 1 }), { message: "Could not open http://home-moves.acme.example/: it moved on to http://dead.acme.example/landing once it had loaded, and the browser could not open that (net::ERR_CONNECTION_REFUSED)." });
      } finally {
        await home.close();
      }
    } finally {
      dialer.connect = reached;
      stand.restore();
      server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }));

// What the proxy did not pass on is told by its own records, never by an
// answer a page can read: a plain http site whose page fetch()ed its own
// address while its connection could not be made, or was reset, read the
// proxy's answer, headers and all, and the mark in them that told the run
// the proxy wrote it, and then sent that mark with its own answers, so a
// page of its own was left out as refused, in the site's own words, as at
// an address MAKERSMCP_REFUSE_ADDRESSES refuses that nobody asked for. Now
// the page reads no answer there at all, and a site's answer with such a
// header is the site's.
test("a site cannot learn what marks the proxy's own answers and send it with its own", { skip: noBrowser, timeout: 150_000 }, async () => {
  const learned = [];
  let told = null;
  const heard = new Promise((resolve) => (told = resolve));
  // The next connection the proxy makes to the site cannot be made, as when
  // the site has stopped listening a moment.
  let armed = false;
  const before = dialer.connect;
  dialer.connect = (options) => {
    if (!armed) return before(options);
    armed = false;
    const socket = new net.Socket();
    process.nextTick(() => socket.destroy(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })));
    return socket;
  };
  const forged = encodeURIComponent("at 10.9.8.7, an address MAKERSMCP_REFUSE_ADDRESSES refuses (forged by the site)");
  const { server, origin } = await serve(async (req, res) => {
    if (req.url === "/gone") return void req.socket.resetAndDestroy();
    if (req.url === "/arm") {
      armed = true;
      return res.writeHead(204).end();
    }
    if (req.url.startsWith("/learn?")) {
      learned.push(...JSON.parse(decodeURIComponent(req.url.slice("/learn?".length))));
      told();
      return res.writeHead(204).end();
    }
    if (req.url === "/pricing") {
      // Asked once the home page has read what it could.
      await Promise.race([heard, sleep(10_000)]);
      const marks = learned.flatMap((one) => [...one.matchAll(/x-easyscreenshotkit-[a-z]+=(\S+) /g)].map((m) => m[1]));
      return res.writeHead(200, { ...html, "x-easyscreenshotkit-refused": `${marks[0] || "nothing"} ${forged}`, "x-easyscreenshotkit-unreached": `${marks[0] || "nothing"} ECONNREFUSED` }).end('<!doctype html><title>Acme | Pricing</title><h1>Pricing</h1><p>Plans for teams of every size.</p><p><a href="/">Home</a></p><div style="height:1400px"></div>');
    }
    if (req.url !== "/") return res.writeHead(404).end();
    res.writeHead(200, html).end(`<!doctype html><title>Acme | Tools</title><h1>Acme</h1><p>Tools for teams.</p><p><a href="/pricing">Pricing</a></p><div style="height:1400px"></div>
<script>
const read = (path) => fetch(path).then((r) => [...r.headers].map(([k, v]) => k + "=" + v + " ").join("&"), (e) => "failed: " + e.message);
addEventListener("load", () => setTimeout(async () => {
  const reset = await read("/gone");
  await fetch("/arm");
  const down = await read("/down");
  fetch("/learn?" + encodeURIComponent(JSON.stringify([reset, down])));
}, 300));
</script>`);
  });
  const root = tempDir();
  try {
    const { manifest } = await takeShots(`${origin}/`, { dir: path.join(root, "shots"), pages: 2, sizes: "desktop", timeLimit: 120_000 });
    // The page read no answer of the proxy's at all, for a connection reset
    // or one that could not be made.
    assert.equal(learned.length, 2, JSON.stringify(learned));
    for (const one of learned) assert.match(one, /^failed: /);
    assert.deepEqual(manifest.pages.map((page) => new URL(page.url).pathname), ["/", "/pricing"]);
    assert.deepEqual(manifest.skipped, []);
    assert.doesNotMatch(JSON.stringify(manifest), /forged by the site/);
  } finally {
    dialer.connect = before;
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// On the port given, this machine's own names are the host given where they
// reach an address of it: a site given at http://127.0.0.1:<port>/ whose
// page names its style, script and picture at http://localhost:<port>/, as
// Jekyll writes them from its site.url, is taken with them, as 0.1.3 took
// it, and they come from 127.0.0.1, the address given, where the page came
// unstyled with a broken picture and notes that called them not on the
// public internet.
test("a site given at 127.0.0.1 whose page names its files at localhost on the same port is taken with them", { skip: noBrowser, timeout: 60_000 }, async () => {
  setTimeLimit(60_000);
  const asked = [];
  const { server, origin } = await serve((req, res) => {
    asked.push(`${req.url} ${req.headers.host}`);
    const port = new URL(origin).port;
    if (req.url === "/site.css") return res.writeHead(200, { "Content-Type": "text/css" }).end("h1 { color: rgb(200, 0, 0); }");
    if (req.url === "/app.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end('document.title = "script ran";');
    if (req.url === "/logo.svg") return res.writeHead(200, { "Content-Type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="rgb(0,160,0)"/></svg>');
    res.writeHead(200, html).end(`<!doctype html><title>Jekyll</title><link rel="stylesheet" href="http://localhost:${port}/site.css"><h1>Jekyll</h1><img id="logo" src="http://localhost:${port}/logo.svg"><script src="http://localhost:${port}/app.js"></script>`);
  });
  let chrome = null;
  try {
    chrome = await launch({ guard: await guardFor(`${origin}/`) });
    const tab = await openTab(chrome, DESKTOP);
    const unreached = [];
    tab.on(UNREACHED, (u) => unreached.push(u.url));
    try {
      assert.equal((await navigate(tab, `${origin}/`)).status, 200);
      const { result } = await tab.send("Runtime.evaluate", { expression: "({ title: document.title, color: getComputedStyle(document.querySelector('h1')).color, width: document.getElementById('logo').naturalWidth })", returnByValue: true });
      assert.deepEqual(result.value, { title: "script ran", color: "rgb(200, 0, 0)", width: 40 });
    } finally {
      await closeTab(chrome, tab);
    }
    assert.deepEqual(unreached, []);
    const port = new URL(origin).port;
    assert.deepEqual(asked.filter((line) => /^\/(app\.js|logo\.svg|site\.css) /.test(line)).sort(), [`/app.js localhost:${port}`, `/logo.svg localhost:${port}`, `/site.css localhost:${port}`]);
  } finally {
    if (chrome) await chrome.close();
    server.close();
  }
});

// What a page sends a site of this machine given as the address reaches it
// as the browser sent it: a cookie the page set to "José" and a header of
// "café" from a fetch(), each byte past ASCII as one, where the site got
// "JosÃ©" and a page that greets by that cookie showed it; a fetch() whose
// header holds DEL or another control character, which the proxy answered
// 400 itself; a fetch() of /ask?, which reached the site as /ask; and a
// form's POST, its body whole.
test("a page's cookie and headers past ASCII, a header with a control character and a form's POST reach the site as the browser sent them", { skip: noBrowser, timeout: 60_000 }, async () => {
  setTimeLimit(60_000);
  const got = {};
  const named = (req, name) => Buffer.from(req.rawHeaders[req.rawHeaders.findIndex((one, i) => i % 2 === 0 && one.toLowerCase() === name) + 1] || "", "latin1").toString("hex");
  const site = http.createServer({ insecureHTTPParser: true }, (req, res) => {
    if (req.url === "/") {
      return res.writeHead(200, html).end(`<!doctype html><title>Forms</title><h1>Forms</h1><iframe name="sink"></iframe><form method="post" action="/form" target="sink"><input name="w" value="hello world"></form><script>
document.cookie = "n=Jos\\u00e9; path=/";
Promise.all([
  fetch("/echo", { headers: { "X-Name": "caf\\u00e9" } }).then((r) => r.status),
  fetch("/del", { headers: { "X-Test": "a\\u007fb" } }).then((r) => r.status),
  fetch("/c0", { headers: { "X-Test": "a\\u0001b" } }).then((r) => r.status),
  fetch("/ask?").then((r) => r.status),
]).then((codes) => { document.title = codes.join(" "); document.forms[0].submit(); }, (e) => (document.title = "failed " + e));
</script>`);
    }
    if (req.url === "/echo") Object.assign(got, { cookie: named(req, "cookie"), name: named(req, "x-name") });
    if (req.url === "/del" || req.url === "/c0") got[req.url.slice(1)] = named(req, "x-test");
    if (req.url.startsWith("/ask")) got.ask = req.url;
    const parts = [];
    req.on("data", (data) => parts.push(data));
    req.on("end", () => {
      if (req.url === "/form") got.form = Buffer.concat(parts).toString("latin1");
      res.writeHead(200, html).end("taken");
    });
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const given = `http://127.0.0.1:${site.address().port}/`;
  let chrome = null;
  try {
    chrome = await launch({ guard: await guardFor(given) });
    const tab = await openTab(chrome, DESKTOP);
    try {
      assert.equal((await navigate(tab, given)).status, 200);
      let title = "";
      for (let i = 0; i < 100 && !(got.form && title); i++) {
        ({ result: { value: title } } = await tab.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }));
        if (title === "Forms") title = "";
        if (!(got.form && title)) await sleep(100);
      }
      assert.equal(title, "200 200 200 200");
    } finally {
      await closeTab(chrome, tab);
    }
    assert.deepEqual(got, { cookie: "6e3d4a6f73c3a9", name: "636166e9", del: "617f62", c0: "610162", ask: "/ask?", form: "w=hello+world" });
  } finally {
    if (chrome) await chrome.close();
    site.close();
  }
});
