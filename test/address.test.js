"use strict";

// Which addresses a run opens and reads (lib/address.js): only web
// addresses, and from a site on the public internet only addresses on it,
// on port 80 or 443 away from the address given, so a site, a steps file
// or a manifest cannot send the kit to this machine, its network or another
// program of a host. No browser here.

const assert = require("node:assert/strict");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { guardFor, getChecked, notPublicIp, unresolvedError, UNRESOLVED } = require("../skills/easyscreenshotkit/scripts/lib/address");
const { alternateFor } = require("../skills/easyscreenshotkit/scripts/lib/pick");
const CASES = require("./address-cases.json");

const NOT_PUBLIC = "not on the public internet";
const NOT_GIVEN = "not on the public internet, and not on the host and port given";
const port = (n) => `on port ${n}, not 80 or 443, and not on the scheme, host and port given`;

// Names as a DNS server of the site's own would answer them, for the run's
// rule: by name, an address, a list of them, or none for no such name.
// Puts the lookup back as it was.
async function withNames(names, body) {
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (typeof options === "function") [options, callback] = [{}, options];
    const known = names[host];
    if (!known) return process.nextTick(callback, Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host }));
    process.nextTick(callback, null, [known].flat().map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
  };
  try {
    return await body();
  } finally {
    dns.lookup = lookup;
  }
}

test("an address on this machine, a private network or a range kept aside is not on the public internet, in any form it is written in", () => {
  for (const ip of ["127.0.0.1", "127.8.9.10", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fd12::1", "[::1]", "fe80::1%eth0"]) {
    assert.equal(notPublicIp(ip), true, ip);
  }
  // IPv6 forms that hold an IPv4 address are judged by that address.
  for (const ip of ["::ffff:7f00:1", "::ffff:127.0.0.1", "::7f00:1", "::ffff:0:7f00:1", "2002:7f00:1::", "64:ff9b::a00:1", "64:ff9b:1::1"]) {
    assert.equal(notPublicIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "93.184.215.14", "2606:4700::1111", "::ffff:8.8.8.8", "2002:808:808::", "64:ff9b::808:808"]) {
    assert.equal(notPublicIp(ip), false, ip);
  }
  assert.equal(notPublicIp("not an address"), true);
});

// The cases easybrandkit, easyscreenshotkit and launch-film judge alike
// (address-cases.json): every IPv6 form that holds an IPv4 address by that
// address, NAT64's well known prefix among them (publicInKitsOnly), and
// Teredo and the other ranges kept aside as not public. 0.1.3 took Teredo's
// 2001::/32 for public, so 2001:0:7f00:1::1, which names the Teredo server
// 127.0.0.1, passed for a site's address. In an address, as the URL parser
// writes them, each IP address of the table the same, but for the one with
// a zone, which no address holds.
test("the shared table of addresses: every IPv6 form that holds an IPv4 address is judged by it, and Teredo and the other ranges kept aside are not public", async () => {
  const { isIP } = require("node:net");
  const reachable = [...CASES.public, ...CASES.publicInKitsOnly];
  for (const ip of CASES.notPublic) assert.equal(notPublicIp(ip), true, ip);
  for (const ip of reachable) assert.equal(notPublicIp(ip), false, ip);
  const guard = await guardFor("");
  const url = (ip) => (ip.includes(":") ? `http://[${ip}]/` : `http://${ip}/`);
  const ips = (list) => list.filter((ip) => isIP(ip) && !ip.includes("%"));
  for (const ip of ips(CASES.notPublic)) assert.equal(await guard.refuses(url(ip)), NOT_PUBLIC, ip);
  for (const ip of ips(reachable)) assert.equal(await guard.refuses(url(ip)), "", ip);
});

test("from a public address a run opens web addresses on the public internet only, and from one on this machine that host and port too", async () => {
  const lookup = dns.lookup;
  // Names as a DNS server of the site's own would answer them.
  const names = { "public.example": "93.184.215.14", "inside.example": "10.0.0.7", "both.example": ["93.184.215.14", "127.0.0.1"] };
  dns.lookup = (host, options, callback) => {
    const known = names[host];
    if (!known) return process.nextTick(callback, Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host }));
    process.nextTick(callback, null, [known].flat().map((address) => ({ address, family: 4 })));
  };
  try {
    const fromPublic = await guardFor("https://public.example/app/#/plants");
    assert.equal(fromPublic.local, false);
    for (const [url, why] of [
      ["https://public.example/pricing", ""],
      ["http://93.184.215.14/", ""],
      ["http://127.0.0.1:9222/json/list", NOT_PUBLIC],
      ["http://0x7f000001/", NOT_PUBLIC],
      ["http://127.1:40000/", NOT_PUBLIC],
      ["http://[::ffff:127.0.0.1]/", NOT_PUBLIC],
      ["http://localhost:3000/", NOT_PUBLIC],
      ["http://app.localhost/", NOT_PUBLIC],
      ["http://169.254.169.254/latest/meta-data/", NOT_PUBLIC],
      ["http://inside.example/", NOT_PUBLIC],
      ["http://both.example/", NOT_PUBLIC],
      ["file://localhost/etc/passwd", "not a web address"],
      ["file:///etc/passwd", "not a web address"],
      ["data:text/html,hi", "not a web address"],
      ["javascript:alert(1)", "not a web address"],
      ["no address", "not a web address"],
    ]) {
      assert.equal(await fromPublic.refuses(url), why, url);
    }
    // A site on this machine, as a developer runs one: that host and port,
    // and the public internet.
    const fromLocal = await guardFor("http://localhost:3000/");
    assert.equal(fromLocal.local, true);
    for (const [url, why] of [
      ["http://localhost:3000/pricing", ""],
      ["http://localhost:3000/app/#/plants", ""],
      ["https://public.example/", ""],
      ["http://localhost:3001/", NOT_GIVEN],
      ["http://127.0.0.1:3000/", NOT_GIVEN],
      ["http://inside.example/", NOT_GIVEN],
      ["file://localhost/etc/passwd", "not a web address"],
    ]) {
      assert.equal(await fromLocal.refuses(url), why, url);
    }
    // A name that resolves to an address on a private network is such an
    // address itself.
    assert.equal((await guardFor("http://inside.example/")).local, true);
    // No address given, as for a manifest read from a file: the public
    // internet only.
    const none = await guardFor("");
    assert.equal(await none.refuses("http://127.0.0.1:3000/x.png"), NOT_PUBLIC);
    assert.equal(await none.refuses("https://public.example/x.png"), "");
  } finally {
    dns.lookup = lookup;
  }
});

// Away from the address given a run opens port 80 and 443 only: a site's
// link, redirect, frame or manifest that names another port of its own host
// or of another one on the public internet reached another program there,
// as a mail, a database or an admin server is, and 0.1.3 opened it and
// saved what answered. The scheme, host and port given are the run's own,
// whatever the port, as a site that serves on 8443 is given; another scheme
// on that port is not, unless the port is 80 or 443. A site on this machine
// given keeps its host and port, as before.
test("away from the address given a run opens port 80 and 443 only, and the scheme, host and port given on any port", () =>
  withNames({ "public.example": "93.184.215.14", "other.example": "93.184.215.15", "inside.example": "10.0.0.7" }, async () => {
    const fromPublic = await guardFor("https://public.example/");
    for (const [url, why] of [
      ["https://public.example/", ""],
      ["https://public.example:443/x", ""],
      ["http://public.example/x", ""],
      ["http://public.example:80/x", ""],
      ["https://public.example:80/x", ""],
      ["http://public.example:443/x", ""],
      ["HTTPS://PUBLIC.EXAMPLE:0443/x", ""],
      ["https://other.example/x", ""],
      ["http://93.184.215.14/", ""],
      ["https://public.example:8443/", port(8443)],
      ["http://public.example:8080/admin", port(8080)],
      ["https://other.example:8443/x", port(8443)],
      ["http://93.184.215.14:8080/", port(8080)],
      ["http://93.184.215.14:25/", port(25)],
      ["http://[2606:4700::1111]:3306/", port(3306)],
      ["http://public.example:22/", port(22)],
      ["https://public.example:1/", port(1)],
      ["https://public.example:65535/", port(65535)],
      // Not on the public internet comes first, as it did.
      ["http://inside.example:8080/", NOT_PUBLIC],
      ["http://127.0.0.1:9222/json/list", NOT_PUBLIC],
    ]) {
      assert.equal(await fromPublic.refuses(url), why, url);
    }
    // A site given on another port: its scheme, host and port, and the web
    // ports of any host.
    const fromPort = await guardFor("https://public.example:8443/app/");
    for (const [url, why] of [
      ["https://public.example:8443/pricing", ""],
      ["https://Public.Example:8443/", ""],
      ["https://public.example/", ""],
      ["http://public.example/", ""],
      ["https://other.example/", ""],
      ["http://public.example:8443/", port(8443)],
      ["https://public.example:9443/", port(9443)],
      ["https://other.example:8443/", port(8443)],
      ["https://public.example.:8443/", port(8443)],
    ]) {
      assert.equal(await fromPort.refuses(url), why, url);
    }
    // A site on this machine given: its host and port as before, another
    // scheme on that port only on 80 or 443, the web ports on the public
    // internet, and no other port there.
    const fromLocal = await guardFor("http://localhost:3000/");
    for (const [url, why] of [
      ["http://localhost:3000/pricing", ""],
      ["https://localhost:3000/", port(3000)],
      ["http://localhost:3001/", NOT_GIVEN],
      ["https://public.example/", ""],
      ["https://public.example:3000/", port(3000)],
    ]) {
      assert.equal(await fromLocal.refuses(url), why, url);
    }
    const fromLocalWeb = await guardFor("http://localhost/");
    assert.equal(await fromLocalWeb.refuses("https://localhost:80/"), "");
    assert.equal(await fromLocalWeb.refuses("https://localhost/"), NOT_GIVEN);
    // No address given, as for a manifest read from a file: the web ports
    // only, said without an address given.
    const none = await guardFor("");
    assert.equal(await none.refuses("https://public.example:8443/wide.png"), "on port 8443, not 80 or 443");
    assert.equal(await none.refuses("https://public.example/wide.png"), "");
  }));

// The kit's own requests, a sitemap, a manifest and its screenshots, are
// judged at every hop before a connection: a redirect to another port of a
// host on the public internet is not followed, and nothing connects there.
// Here the kit's requests go to stand-ins, so nothing leaves this machine.
test("a file the kit reads itself is not read on another port than 80 and 443 away from the address given, nor after a redirect to one, and no connection is made there", () =>
  withNames({ "public.example": "93.184.215.14", "cdn.example": "93.184.215.15" }, async () => {
    const asked = [];
    const answer = (url, options, done) => {
      const where = new URL(url);
      asked.push(where.href);
      const req = new EventEmitter();
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, resume() {}, destroy() {} });
      if (where.pathname === "/away") Object.assign(res, { statusCode: 302, headers: { location: "https://cdn.example:8443/sitemap.xml" } });
      if (where.pathname === "/home" && !where.port) Object.assign(res, { statusCode: 301, headers: { location: "https://public.example:9443/home" } });
      res[Symbol.asyncIterator] = async function* () {
        yield Buffer.from(`body of ${where.pathname}`);
      };
      process.nextTick(done, res);
      return req;
    };
    const saved = { http: http.get, https: https.get };
    http.get = answer;
    https.get = answer;
    try {
      const guard = await guardFor("https://public.example/");
      const got = await getChecked("https://public.example/robots.txt", { guard });
      assert.deepEqual([got.status, got.body.toString()], [200, "body of /robots.txt"]);
      await assert.rejects(getChecked("https://public.example/away", { guard }), { refused: `it leads to https://cdn.example:8443/sitemap.xml, which is ${port(8443)}` });
      await assert.rejects(getChecked("https://cdn.example:8443/wide.png", { guard }), { refused: `it is ${port(8443)}` });
      await assert.rejects(getChecked("http://public.example:8080/sitemap.xml", { guard }), { refused: `it is ${port(8080)}` });
      // A site given on 9443 reads its own files there, after a redirect
      // too, and no other port.
      const own = await guardFor("https://public.example:9443/");
      const back = await getChecked("https://public.example/home", { guard: own });
      assert.deepEqual([back.status, back.url], [200, "https://public.example:9443/home"]);
      await assert.rejects(getChecked("https://cdn.example:9443/wide.png", { guard: own }), { refused: `it is ${port(9443)}` });
      assert.deepEqual(asked, ["https://public.example/robots.txt", "https://public.example/away", "https://public.example/home", "https://public.example:9443/home"]);
    } finally {
      http.get = saved.http;
      https.get = saved.https;
    }
  }));

// A name is looked up once, and a request the kit makes itself goes to an
// address of that answer: a DNS server of the site's that answers a public
// address first and this machine's next cannot send the request here after
// the name was judged. Here the lookup is mocked so: the request has to go
// to the first answer, with no second lookup.
test("a request the kit makes itself goes to the address the name was judged by, not to a later answer of the DNS", async () => {
  const lookup = dns.lookup;
  const asked = [];
  dns.lookup = (host, options, callback) => {
    asked.push(host);
    const address = asked.filter((name) => name === host).length === 1 ? "93.184.215.14" : "127.0.0.1";
    process.nextTick(callback, null, [{ address, family: 4 }]);
  };
  try {
    const guard = await guardFor("https://rebinding.example/");
    assert.equal(await guard.refuses("https://rebinding.example/sitemap.xml"), "");
    const resolve = guard.lookupFor("https://rebinding.example/sitemap.xml");
    assert.equal(typeof resolve, "function");
    const one = await new Promise((done, fail) => resolve("rebinding.example", {}, (err, address, family) => (err ? fail(err) : done([address, family]))));
    assert.deepEqual(one, ["93.184.215.14", 4]);
    const all = await new Promise((done, fail) => resolve("rebinding.example", { all: true }, (err, list) => (err ? fail(err) : done(list))));
    assert.deepEqual(all, [{ address: "93.184.215.14", family: 4 }]);
    assert.deepEqual(asked, ["rebinding.example"]);
    // The host and port given on this machine are the run's own: any
    // address of them goes.
    assert.equal((await guardFor("http://localhost:3000/")).lookupFor("http://localhost:3000/robots.txt"), undefined);
  } finally {
    dns.lookup = lookup;
  }
});

// A name that cannot be looked up here, as the DNS fails or answers late,
// is refused, and stays refused for the run: it counted as public, was
// kept so, and was left to the browser's own lookup, which the same DNS
// server could answer with this machine. The address given on such a host
// tells the run why, so it can stop before any work.
test("a name that cannot be looked up here is refused for the run, and the address given on such a host says why", { timeout: 60_000 }, async () => {
  const lookup = dns.lookup;
  const asked = [];
  dns.lookup = (host, options, callback) => {
    asked.push(host);
    if (host === "public.example") return process.nextTick(callback, null, [{ address: "93.184.215.14", family: 4 }]);
    // No answer at all.
    if (host === "slow.example") return;
    process.nextTick(callback, Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: host === "flaky.example" ? "EAI_AGAIN" : "ENOTFOUND", hostname: host }));
  };
  try {
    const guard = await guardFor("https://public.example/");
    assert.equal(guard.unresolved, "");
    assert.equal(await guard.refuses("https://nowhere.example/"), UNRESOLVED);
    assert.equal(await guard.refuses("https://nowhere.example:8443/x"), UNRESOLVED);
    assert.equal(await guard.refuses("https://flaky.example/"), UNRESOLVED);
    let started = Date.now();
    assert.equal(await guard.refuses("https://slow.example/"), UNRESOLVED);
    assert.ok(Date.now() - started >= 9_000, `${Date.now() - started} ms`);
    started = Date.now();
    assert.equal(await guard.refuses("https://slow.example:8443/"), UNRESOLVED);
    assert.ok(Date.now() - started < 1_000, `${Date.now() - started} ms`);
    assert.deepEqual(asked.filter((host) => host !== "public.example"), ["nowhere.example", "flaky.example", "slow.example"]);
    // From a site on this machine too.
    assert.equal(await (await guardFor("http://localhost:3000/")).refuses("http://nowhere.example/"), UNRESOLVED);
    // The address given on such a host.
    assert.equal((await guardFor("https://nowhere.example/app/")).unresolved, "no such name");
    assert.equal((await guardFor("https://flaky.example/")).unresolved, "the name servers did not answer");
    assert.equal((await guardFor("https://slow.example/")).unresolved, "no answer in 10 s");
    assert.equal(unresolvedError("https://nowhere.example/app/", await guardFor("https://nowhere.example/app/")).message, `Could not open https://nowhere.example/app/: it is ${UNRESOLVED} (no such name).`);
    // A file the kit would read there is not read either.
    await assert.rejects(getChecked("https://nowhere.example/sitemap.xml", { guard }), { refused: `it is ${UNRESOLVED}` });
  } finally {
    dns.lookup = lookup;
  }
});

test("a file the kit reads itself is not read from an address the run does not open, nor after a redirect to one", async () => {
  const seen = [];
  const other = http.createServer((req, res) => {
    seen.push(req.url);
    res.end("from the other server");
  });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const elsewhere = `http://127.0.0.1:${other.address().port}`;
  const site = http.createServer((req, res) => {
    if (req.url === "/away") return res.writeHead(302, { Location: `${elsewhere}/moved` }).end();
    if (req.url === "/twice") return res.writeHead(301, { Location: "/here" }).end();
    res.writeHead(200, { "Content-Type": "text/plain" }).end(`here: ${req.url}`);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  try {
    const guard = await guardFor(`${origin}/`);
    const got = await getChecked(`${origin}/twice`, { guard });
    assert.deepEqual([got.status, got.url, got.body.toString()], [200, `${origin}/here`, "here: /here"]);
    await assert.rejects(getChecked(`${origin}/away`, { guard }), { refused: `it leads to ${elsewhere}/moved, which is ${NOT_GIVEN}` });
    await assert.rejects(getChecked(`${elsewhere}/asked`, { guard }), { refused: `it is ${NOT_GIVEN}` });
    await assert.rejects(getChecked(`${elsewhere}/asked`, { guard: await guardFor("") }), { refused: `it is ${NOT_PUBLIC}` });
    assert.deepEqual(seen, []);
  } finally {
    site.close();
    other.close();
  }
});

test("a page's version in another language is taken only at a web address", () => {
  const alternates = [
    { lang: "tr", href: "file://127.0.0.1/etc/hostname" },
    { lang: "tr", href: "file://localhost/etc/passwd" },
    { lang: "de", href: "javascript:alert(1)" },
  ];
  assert.equal(alternateFor(alternates, "tr"), null);
  assert.equal(alternateFor(alternates, "de"), null);
  assert.deepEqual(alternateFor([...alternates, { lang: "tr", href: "https://acme.com/tr/" }], "tr"), { lang: "tr", href: "https://acme.com/tr/" });
});
