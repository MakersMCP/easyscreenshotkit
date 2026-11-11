"use strict";

// Which addresses a run opens and reads (lib/address.js): only web
// addresses, and from a site on the public internet only addresses on it,
// so a site, a steps file or a manifest cannot send the kit to this
// machine or its network. No browser here.

const assert = require("node:assert/strict");
const dns = require("node:dns");
const http = require("node:http");
const test = require("node:test");
const { guardFor, getChecked, notPublicIp, unresolvedError, UNRESOLVED } = require("../skills/easyscreenshotkit/scripts/lib/address");
const { alternateFor } = require("../skills/easyscreenshotkit/scripts/lib/pick");

const NOT_PUBLIC = "not on the public internet";
const NOT_GIVEN = "not on the public internet, and not on the host and port given";

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
      ["http://93.184.215.14:8080/", ""],
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
