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
const { startProxy, dialer, NO_RULE } = require("../skills/easyscreenshotkit/scripts/lib/proxy");
const { findChrome, launch, openTab, closeTab, navigate, roomIn, BARRED, UNREACHED } = require("../skills/easyscreenshotkit/scripts/lib/chrome");
const { guardFor, NOT_GIVEN, NOT_PUBLIC } = require("../skills/easyscreenshotkit/scripts/lib/address");
const { takeShots } = require("../skills/easyscreenshotkit/scripts/lib/shots");
const { setTimeLimit, sleep } = require("../skills/easyscreenshotkit/scripts/lib/time");
const { serve, tempProblem, sh, reachAt } = require("./helpers");

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
test("the proxy passes on what the run's rule opens and answers the rest with a 403 and a record", async () => {
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
    // Another port of this machine, as a plain request and as a tunnel.
    const away = `127.0.0.1:${other.port}`;
    const refused = await askProxy(proxy.port, `http://${away}/`);
    assert.equal(refused.status, 403);
    const listed = (headers) => Object.entries(headers).map(([name, value]) => ({ name, value }));
    assert.deepEqual(proxy.answeredBy(listed(refused.headers)), { why: NOT_GIVEN });
    // A site's own header of that name is no refusal of the proxy's.
    assert.equal(proxy.answeredBy([{ name: "X-Easyscreenshotkit-Refused", value: encodeURIComponent(NOT_GIVEN) }]), null);
    assert.equal(proxy.answeredBy(listed(passed.headers)), null);
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
// and an address it cannot connect to is answered 502 and kept with the
// system's code, so the browser's words for it are the ones it gives a
// connection it makes itself.
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
    const down = await askProxy(proxy.port, `${closedOrigin}/`);
    assert.equal(down.status, 502);
    assert.deepEqual(proxy.answeredBy(Object.entries(down.headers).map(([name, value]) => ({ name, value }))), { code: "ECONNREFUSED" });
    assert.equal(proxy.unreached.get(new URL(closedOrigin).host), "ECONNREFUSED");
    assert.equal((await tunnel(proxy.port, new URL(closedOrigin).host)).status, "HTTP/1.1 502 Bad Gateway");
    assert.equal((await askProxy(none.port, `${site.origin}/`)).status, 403);
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
// finds no refusal of the earlier rule where the new one connects.
test("the proxy keeps the last outcome for each host and port", async () => {
  const site = await serve((req, res) => res.end("site"));
  const other = await serve((req, res) => res.end("other"));
  let rule = await guardFor(`${site.origin}/`);
  const proxy = await startProxy(() => rule);
  try {
    const at = new URL(other.origin).host;
    assert.equal((await askProxy(proxy.port, `${other.origin}/`)).status, 403);
    assert.equal(proxy.refused.get(at), NOT_GIVEN);
    rule = await guardFor(`${other.origin}/`);
    assert.equal((await askProxy(proxy.port, `${other.origin}/`)).body, "other");
    assert.equal(proxy.refused.has(at), false);
  } finally {
    proxy.close();
    site.server.close();
    other.server.close();
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
      assert.equal((await askProxy(proxy.port, "http://proxy-refused.example/")).status, 403);
      assert.equal((await tunnel(proxy.port, "proxy-inside.example:443")).status, "HTTP/1.1 403 Forbidden");
      // Another port of the site's own host on the public internet.
      assert.equal((await askProxy(proxy.port, "http://proxy-site.example:8080/")).status, 403);
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
// browser is told the other program is where the WebAuthn name leads
// (--host-resolver-rules), as a site's DNS server can tell it; the run's
// own lookup, which the proxy asks, finds it on this machine too.
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
      chrome = await launch({ guard: await guardFor(given), args: [`--host-resolver-rules=MAP rp-elsewhere.example ${away}`] });
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
      assert.deepEqual(unreached, [[`http://${away}`, NOT_GIVEN]]);
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
// on port 80 to its server, and the browser's own lookup would lead it to
// this machine, where the other program listens on that other port.
test("from a site on the public internet, a picture and a frame on another port of its host reach nothing but the refusal", { skip: noBrowser, timeout: 60_000 }, () =>
  withNames({ "public-pic.example": "93.184.215.20" }, async () => {
    const other = await trap();
    const { server, origin } = await serve((req, res) => {
      if (req.url !== "/") return res.writeHead(404).end();
      res.writeHead(200, html).end(`<!doctype html><title>Public</title><h1>Public</h1><img src="http://public-pic.example:${other.port}/picture.png"><iframe src="http://public-pic.example:${other.port}/frame"></iframe>`);
    });
    const stand = reachAt({ "93.184.215.20:80": `127.0.0.1:${new URL(origin).port}` });
    const otherPort = `on port ${other.port}, not 80 or 443, and not on the scheme, host and port given`;
    let chrome = null;
    try {
      chrome = await launch({ guard: await guardFor("http://public-pic.example/"), args: ["--host-resolver-rules=MAP public-pic.example 127.0.0.1"] });
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
  // browserEnv() in chrome.js).
  const env = { ...process.env, TMPDIR: profile, WAYLAND_DISPLAY: path.join(profile, "no-display"), DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(profile, "no-bus")}` };
  delete env.DISPLAY;
  delete env.WAYLAND_SOCKET;
  try {
    const browser = spawn(findChrome(), ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--dump-dom", `--proxy-server=http://127.0.0.1:${proxy.port}`, "--proxy-bypass-list=<-loopback>", ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []), `${origin}/`], { stdio: ["ignore", "pipe", "ignore"], env });
    let dom = "";
    browser.stdout.on("data", (d) => (dom += d));
    await new Promise((resolve) => browser.on("exit", resolve));
    assert.match(dom, /<h1>Spec<\/h1>/);
    assert.equal(proxy.refused.get(away), NOT_GIVEN);
    assert.deepEqual(other.seen, []);
  } finally {
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

// A site you run on your machine and give as the address works through the
// proxy as before: here one started on localhost that listens on ::1 alone,
// as one can on a machine whose only IPv6 address is its loopback's, with
// its picture and a WebSocket on its own port.
const noLoopback6 = (() => {
  const probe = spawnSync(process.execPath, ["-e", 'require("net").createServer().listen(0, "::1", function () { this.close(); }).on("error", () => process.exit(1))']);
  return probe.status !== 0 && "this machine has no IPv6 loopback";
})();

test("a site on localhost given as the address is taken through the proxy, a WebSocket and a picture on its own port with it", { skip: noBrowser || noLoopback6, timeout: 60_000 }, async () => {
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
  const given = `http://localhost:${site.address().port}/`;
  let chrome = null;
  try {
    chrome = await launch({ guard: await guardFor(given) });
    const tab = await openTab(chrome, DESKTOP);
    try {
      assert.equal((await navigate(tab, given)).status, 200);
      const until = Date.now() + 5_000;
      let shown = {};
      while (Date.now() < until) {
        ({ result: { value: shown } } = await tab.send("Runtime.evaluate", { expression: "({ title: document.title, width: document.getElementById('pic').naturalWidth })", returnByValue: true }));
        if (shown.title === "live" && shown.width) break;
        await sleep(100);
      }
      assert.deepEqual(shown, { title: "live", width: 40 });
    } finally {
      await closeTab(chrome, tab);
    }
    assert.deepEqual([...chrome.proxy.refused].filter(([at]) => /localhost|::1|127\.0\.0\.1/.test(at)), []);
    assert.ok(seen.includes("/") && seen.includes("/pic.svg") && seen.includes("upgrade /live"), seen.join(" "));
  } finally {
    if (chrome) await chrome.close();
    site.close();
  }
});

// A browser that sends its requests past the run's proxy, as a Chrome policy
// (ProxySettings) or a program that starts it without the run's switches
// can make it, asks the DNS and connects for itself, past the run's rule:
// it is not used. Here the program CHROME_PATH names starts the browser
// with the proxy's switches taken out.
test("a browser that sends its requests past the proxy is not used", { skip: noBrowser || (process.platform === "win32" && "the wrapper is a shell script"), timeout: 60_000 }, async () => {
  const root = tempDir();
  const browser = path.join(root, "unproxied");
  const told = path.join(root, "args");
  // It writes down what it starts the browser with, a line each.
  fs.writeFileSync(browser, `#!/bin/sh\nfor a in "$@"; do shift; case "$a" in --proxy-server=*|--proxy-bypass-list=*) ;; *) set -- "$@" "$a" ;; esac; done\nprintf '%s\\n' "$@" > ${sh(told)}\nexec ${sh(findChrome())} "$@"\n`, { mode: 0o755 });
  const saved = process.env.CHROME_PATH;
  process.env.CHROME_PATH = browser;
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
// taken out.
test("a browser that sends this machine's addresses or WebRTC's UDP past the proxy is not used", { skip: noBrowser || (process.platform === "win32" && "the wrapper is a shell script"), timeout: 90_000 }, async () => {
  const root = tempDir();
  const saved = process.env.CHROME_PATH;
  // The browser itself, found before CHROME_PATH names a wrapper.
  const real = findChrome();
  try {
    for (const [name, left, message] of [
      ["bypassed", "--proxy-bypass-list=*", "bypassed sends its requests for this machine's own addresses past the proxy the run starts for it, as a program that starts it without the run's switches can make it, so it was not used: a page could have it reach an address the run does not open. Point CHROME_PATH at the browser's own program."],
      ["leaky", "--webrtc-ip-handling-policy=*", "leaky sends WebRTC's UDP past the proxy the run starts for it, as a Chrome policy (WebRtcIPHandling) or a program that starts it without the run's switches can make it, so it was not used: a page could have it reach an address the run does not open. Lift that policy, or point CHROME_PATH at the browser's own program."],
    ]) {
      const browser = path.join(root, name);
      fs.writeFileSync(browser, `#!/bin/sh\nfor a in "$@"; do shift; case "$a" in ${left}) ;; *) set -- "$@" "$a" ;; esac; done\nexec ${sh(real)} "$@"\n`, { mode: 0o755 });
      process.env.CHROME_PATH = browser;
      await assert.rejects(launch(), { message });
    }
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
// notes, with the reason: a picture of another program of this machine, on
// a site given there.
test("a run names in a page's notes what the proxy did not pass on of its requests", { skip: noBrowser, timeout: 120_000 }, async () => {
  const other = await trap();
  const away = `127.0.0.1:${other.port}`;
  const { server, origin } = await serve((req, res) => {
    if (req.url !== "/") return res.writeHead(404).end();
    res.writeHead(200, html).end(`<!doctype html><title>Acme | Tools</title><h1>Acme</h1><p>Tools for teams.</p><img src="http://${away}/one.png"><img src="http://${away}/two.png"><div style="height:1400px"></div>`);
  });
  const root = tempDir();
  try {
    const { manifest } = await takeShots(`${origin}/`, { dir: path.join(root, "shots"), pages: 1, sizes: "desktop", timeLimit: 90_000 });
    assert.deepEqual(manifest.pages[0].notes.filter((note) => /nothing was sent there/.test(note)), [`it asked for http://${away}, which is ${NOT_GIVEN}: nothing was sent there`]);
    const md = fs.readFileSync(path.join(root, "shots", "SCREENSHOTS.md"), "utf8");
    assert.ok(md.includes(`it asked for http://${away}, which is ${NOT_GIVEN}: nothing was sent there`), md);
    assert.deepEqual(other.seen, []);
  } finally {
    server.close();
    other.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
