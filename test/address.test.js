"use strict";

// Which addresses a run opens and reads (lib/address.js): only web
// addresses, and from a site on the public internet only addresses on it,
// on port 80 or 443 away from the address given, and none the host's
// MAKERSMCP_REFUSE_ADDRESSES names, so a site, a steps file or a manifest
// cannot send the kit to this machine, its network or another program of a
// host. No browser here.

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { guardFor, getChecked, notPublicIp, hostRefusals, refusalsProblem, unresolvedError, refusedError, throughNoProxy, UNRESOLVED } = require("../skills/easyscreenshotkit/scripts/lib/address");
const { alternateFor } = require("../skills/easyscreenshotkit/scripts/lib/pick");
const CASES = require("./address-cases.json");

const NOT_PUBLIC = "not on the public internet";
const NOT_GIVEN = "not on the public internet, and not on the host and port given";
const SETTING = "MAKERSMCP_REFUSE_ADDRESSES";
const port = (n) => `on port ${n}, not 80 or 443, and not on the scheme, host and port given`;
const here = (address) => `at ${address}, an address ${SETTING} refuses`;

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

// The run with MAKERSMCP_REFUSE_ADDRESSES set to value, or unset for
// undefined; put back as it was, deleted when it was unset.
async function withSetting(value, body) {
  const saved = process.env[SETTING];
  if (value === undefined) delete process.env[SETTING];
  else process.env[SETTING] = value;
  try {
    return await body();
  } finally {
    if (saved === undefined) delete process.env[SETTING];
    else process.env[SETTING] = saved;
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

// The cases easybrandkit and easyscreenshotkit judge alike
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

// The cases of the host given that easybrandkit and easyscreenshotkit judge
// alike (address-cases.json): the host given is its own name, and where it
// is one of this machine's own names, localhost, 127.0.0.1 or [::1],
// localhost and the others it reaches on its port (theHostGiven). Nothing
// else is, though it lead to an address of the host given
// (notTheHostGiven): many sites are served at one address and port, a
// program there picking each by its name, as Laravel Valet or Herd serve
// *.test and DDEV's router *.ddev.site, so taken for the host given, a page
// of http://app1.test/ had the run load http://app2.test/, another site at
// 127.0.0.1:80, as a frame, a picture and a fetch() that read its data.
test("the shared table of the host given: this machine's own names on its port, and no other host that leads to an address of it", async () => {
  for (const { given, opened } of CASES.theHostGiven) {
    const guard = await guardFor(given);
    assert.equal(guard.local, true, given);
    for (const url of opened) assert.equal(await guard.refuses(url), "", `${given} ${url}`);
  }
  for (const { given, names, refused } of CASES.notTheHostGiven) {
    await withNames(names, async () => {
      const guard = await guardFor(given);
      assert.equal(guard.local, true, given);
      assert.equal(await guard.refuses(given), "", given);
      for (const url of refused) assert.equal(await guard.refuses(url), NOT_GIVEN, `${given} ${url}`);
    });
  }
});

// This machine's own addresses, as its network interfaces hold them, and
// the IPv6 network of each, are not opened away from the address given,
// though their ranges are public: a machine on an IPv6 network holds a
// global address of its own, and a server can hold a public IPv4 address,
// and a site that read one off the run's connection had the browser load a
// service of this machine there. The rest of a public IPv4 range on an
// interface is other people's servers. The interfaces are read as the run
// goes, as their addresses change while it does, at most once a second;
// and an address of this machine given is the user's own choice, as
// localhost is.
test("an address this machine's network interfaces hold, a public one included, and the IPv6 network of one are not opened away from the address given", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const os = require("node:os");
  const saved = os.networkInterfaces;
  const loopback = { lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }, { address: "::1", netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", family: "IPv6", internal: true, cidr: "::1/128", scopeid: 0 }] };
  const server = {
    ...loopback,
    eth0: [
      { address: "81.2.69.160", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "81.2.69.160/24" },
      { address: "2a02:1205:5000::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, cidr: "2a02:1205:5000::1/64", scopeid: 0 },
      { address: "2a02:1205:5000:0:5c1b:2e:9a4f:11d0", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, cidr: "2a02:1205:5000:0:5c1b:2e:9a4f:11d0/64", scopeid: 0 },
    ],
  };
  let interfaces = server;
  os.networkInterfaces = () => interfaces;
  try {
    await withNames({ "own-machine.example": "81.2.69.160", "own-machine.acme.com": "81.2.69.160", "own-machine6.example": "2a02:1205:5000::1", "own-lan6.example": ["93.184.215.14", "2a02:1205:5000::77"], "own-site.example": "93.184.215.14" }, async () => {
      const guard = await guardFor("https://own-site.example/");
      assert.equal(guard.local, false);
      for (const [url, why] of [
        ["http://81.2.69.160/", "at 81.2.69.160, an address of this machine"],
        ["http://[2a02:1205:5000::1]/frame", "at 2a02:1205:5000::1, an address of this machine"],
        ["http://[2a02:1205:5000:0:5c1b:2e:9a4f:11d0]/", "at 2a02:1205:5000:0:5c1b:2e:9a4f:11d0, an address of this machine"],
        ["http://[::ffff:81.2.69.160]/", "at ::ffff:5102:45a0, an address of this machine"],
        ["http://[64:ff9b::81.2.69.160]/", "at 64:ff9b::5102:45a0, an address of this machine"],
        ["http://1359103392/", "at 81.2.69.160, an address of this machine"],
        ["http://[2a02:1205:5000::77]/api", "at 2a02:1205:5000::77, on a network of this machine"],
        ["http://own-machine.example/sitemap.xml", "at 81.2.69.160, an address of this machine"],
        ["http://own-machine6.example/", "at 2a02:1205:5000::1, an address of this machine"],
        // A name that also answers on the public internet is named so, in
        // the words of the address given.
        ["http://own-lan6.example/", "on a host whose name answers with an address on the public internet, 93.184.215.14, and with one on a network of this machine, 2a02:1205:5000::77"],
        // Other people's servers in the public IPv4 range of the interface,
        // and another IPv6 network.
        ["http://81.2.69.161/", ""],
        ["http://[2a02:1205:5001::1]/", ""],
        ["https://own-site.example/pricing", ""],
      ]) {
        assert.equal(await guard.refuses(url), why, url);
      }
      // A connection of the kit's or the proxy's to a name that answers with
      // one is refused before it is made.
      const answer = await new Promise((resolve) => guard.lookupFor("http://own-machine.example/")("own-machine.example", { all: true }, (err, list) => resolve(err || list)));
      assert.deepEqual({ code: answer.code, refused: answer.refused }, { code: "ENOTPUBLIC", refused: "it is at 81.2.69.160, an address of this machine" });
      // Read as the run goes: once a second has passed, an address the
      // machine no longer holds is any other.
      interfaces = loopback;
      t.mock.timers.tick(1_000);
      assert.equal(await guard.refuses("http://81.2.69.160/"), "");
      assert.equal(await guard.refuses("http://[2a02:1205:5000::77]/"), "");
      interfaces = server;
      t.mock.timers.tick(1_000);
      // Given as the address, it is the user's own choice, as localhost is:
      // that host and port are opened, and no other address of the machine;
      // given by http on port 80, its https on 443 too, where the browser
      // tries it first.
      const given = await guardFor("http://81.2.69.160:8080/");
      assert.equal(given.local, true);
      assert.equal(await given.refuses("http://81.2.69.160:8080/app.js"), "");
      assert.equal(await given.refuses("http://[2a02:1205:5000::1]/"), "at 2a02:1205:5000::1, an address of this machine, and not on the host and port given");
      assert.equal(await given.refuses("https://81.2.69.160/"), "at 81.2.69.160, an address of this machine, and not on the host and port given");
      const web = await guardFor("http://own-machine.acme.com/");
      assert.equal(await web.refuses("https://own-machine.acme.com/"), "");
      // Its address is another host, on any port: many sites can be served
      // there, each picked by its name.
      assert.equal(await web.refuses("https://81.2.69.160/"), "at 81.2.69.160, an address of this machine, and not on the host and port given");
      assert.equal(await web.refuses("https://81.2.69.160:8443/"), "at 81.2.69.160, an address of this machine, and not on the host and port given");
      assert.equal(await (await guardFor("http://81.2.69.160/")).refuses("https://81.2.69.160/"), "");
      // Not for a name under a domain of a network's own, nor an IPv6
      // address, which the browser opens by http alone.
      assert.equal(await (await guardFor("http://own-machine.example/")).refuses("https://own-machine.example/"), "at 81.2.69.160, an address of this machine, and not on the host and port given");
      assert.equal(await (await guardFor("http://[2a02:1205:5000::1]/")).refuses("https://[2a02:1205:5000::1]/"), "at 2a02:1205:5000::1, an address of this machine, and not on the host and port given");
      // A run that could not reach it adds no word about a proxy setting.
      const proxySaved = process.env.HTTPS_PROXY;
      process.env.HTTPS_PROXY = "http://127.0.0.1:9";
      try {
        assert.equal(throughNoProxy("Could not open http://81.2.69.160:8080/: net::ERR_CONNECTION_REFUSED"), "Could not open http://81.2.69.160:8080/: net::ERR_CONNECTION_REFUSED");
      } finally {
        if (proxySaved === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = proxySaved;
      }
    });
  } finally {
    os.networkInterfaces = saved;
  }
});

// On the port given, the host given is its own name, wherever it is: a name
// every address of which is one of the host given's is another host, as a
// server's www name at its own address is, and so is that address itself.
// Many sites are served at one address and port, a program there picking
// each by its name, so such a name can be another site: taken for the host
// given, a page of http://app1.test/ had the run load a frame and a
// picture of http://app2.test/, another site at 127.0.0.1:80, and a
// fetch() read its data. A site that moves on to another of its names
// there stops the run at that move, which names where it leads, and that
// name given is taken, its other names there left out.
test("on the port given, a name every address of which is one of the host given's is another host, as a server's www name at its own address", async () => {
  const os = require("node:os");
  const saved = os.networkInterfaces;
  os.networkInterfaces = () => ({
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
    eth0: [
      { address: "81.2.69.160", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "81.2.69.160/24" },
      { address: "81.2.69.161", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "81.2.69.161/24" },
    ],
  });
  const ask = (resolve, host) => new Promise((done) => resolve(host, { all: true }, (err, list) => done(err ? err.refused : list.map((one) => one.address))));
  const at = (address) => `at ${address}, an address of this machine, and not on the host and port given`;
  try {
    await withNames({ "own.example": "81.2.69.160", "www.own.example": "81.2.69.160", "static.own.example": "81.2.69.160", "two.own.example": ["81.2.69.160", "81.2.69.161"], "other.own.example": "81.2.69.161", "own.acme.com": "81.2.69.160", "www.own.acme.com": "81.2.69.160", "loop.example": "127.0.0.1" }, async () => {
      const guard = await guardFor("https://own.example/");
      assert.equal(guard.local, true);
      for (const [url, why] of [
        ["https://own.example/pricing", ""],
        ["https://own.example./pricing", ""],
        ["https://www.own.example/", at("81.2.69.160")],
        ["https://www.own.example/pricing", at("81.2.69.160")],
        ["https://static.own.example/site.css", at("81.2.69.160")],
        ["https://81.2.69.160/logo.png", at("81.2.69.160")],
        ["https://www.own.example:8443/", at("81.2.69.160")],
        ["http://www.own.example:443/", at("81.2.69.160")],
        ["https://other.own.example/", at("81.2.69.161")],
        ["https://two.own.example/", at("81.2.69.160")],
        ["https://81.2.69.161/", at("81.2.69.161")],
        ["https://loop.example/", NOT_GIVEN],
      ]) {
        assert.equal(await guard.refuses(url), why, url);
      }
      // No connection is made to them either.
      assert.equal(await ask(guard.lookupFor("https://www.own.example/pricing"), "www.own.example"), `it is ${at("81.2.69.160")}`);
      assert.equal(await ask(guard.lookupFor("https://static.own.example/site.css"), "static.own.example"), `it is ${at("81.2.69.160")}`);
      assert.deepEqual(await ask(guard.lookupFor("https://own.example/pricing"), "own.example"), ["81.2.69.160"]);
      // Given, its www name is the host given, and the bare name another.
      const www = await guardFor("https://www.own.example/");
      assert.equal(await www.refuses("https://www.own.example/pricing"), "");
      assert.equal(await www.refuses("https://own.example/"), at("81.2.69.160"));
      assert.equal(await www.refuses("https://static.own.example/site.css"), at("81.2.69.160"));
      // From http on port 80 of a name the browser tries over https first,
      // its own https on 443, and not its www name.
      const web = await guardFor("http://own.acme.com/");
      assert.equal(await web.refuses("https://own.acme.com/"), "");
      assert.equal(await web.refuses("https://www.own.acme.com/"), at("81.2.69.160"));
      assert.equal(await web.refuses("http://www.own.acme.com/"), at("81.2.69.160"));
      // A site given on this machine by 127.0.0.1: a name at that address
      // alone is another host on any port.
      const local = await guardFor("http://127.0.0.1:4000/");
      assert.equal(await local.refuses("http://loop.example:4000/app.js"), NOT_GIVEN);
      assert.equal(await local.refuses("http://loop.example:4001/"), NOT_GIVEN);
    });
  } finally {
    os.networkInterfaces = saved;
  }
});

// The machine's network interfaces are read once a second at most, however
// many addresses the run judges meanwhile: read at each judgement, twice for
// each address of each request the proxy judged, a page of many hosts loaded
// 3 to 5 times more slowly on a machine of 200 interfaces than with 0.1.3,
// the run's main thread busy reading them. A change in them is seen once the
// second has passed, and at once where the clock went back.
test("this machine's network interfaces are read once a second at most, whatever the run judges meanwhile", (t) =>
  withNames({ "four.example": ["93.184.216.1", "93.184.216.2", "93.184.216.3", "93.184.216.4"] }, async () => {
    const os = require("node:os");
    const saved = os.networkInterfaces;
    let reads = 0;
    let interfaces = { lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }] };
    os.networkInterfaces = () => {
      reads++;
      return interfaces;
    };
    t.mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
    const lookup = (guard, raw) => new Promise((resolve) => guard.lookupFor(raw)(new URL(raw).hostname, { all: true }, (err, list) => resolve(err || list)));
    try {
      const guard = await guardFor("");
      for (let n = 0; n < 50; n++) {
        assert.equal(await guard.refuses(`https://four.example/${n}`), "");
        assert.equal((await lookup(guard, `https://four.example/${n}`)).length, 4);
      }
      assert.equal(reads, 1);
      t.mock.timers.tick(999);
      interfaces = { eth0: [{ address: "93.184.216.2", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "93.184.216.2/24" }] };
      assert.equal(await guard.refuses("https://four.example/"), "");
      assert.equal(reads, 1);
      t.mock.timers.tick(1);
      assert.equal(await guard.refuses("https://four.example/"), "on a host whose name answers with an address on the public internet, 93.184.216.1, and with one of this machine's, 93.184.216.2");
      assert.equal(reads, 2);
      interfaces = {};
      t.mock.timers.setTime(4_000_000);
      assert.equal(await guard.refuses("https://four.example/"), "");
      assert.equal(reads, 3);
      // And at once where the function that reads them is another, as a
      // test puts one in its place.
      os.networkInterfaces = () => {
        reads++;
        return { eth1: [{ address: "93.184.216.3", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "93.184.216.3/24" }] };
      };
      assert.equal(await guard.refuses("https://four.example/"), "on a host whose name answers with an address on the public internet, 93.184.216.1, and with one of this machine's, 93.184.216.3");
      assert.equal(reads, 4);
    } finally {
      os.networkInterfaces = saved;
    }
  }));

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
      ["http://both.example/", "on a host whose name answers with an address on the public internet, 93.184.215.14, and with one that is not, 127.0.0.1"],
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
      ["http://127.0.0.1:3001/", NOT_GIVEN],
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

// A name that answers both with an address on the public internet and with
// one that is not, or that is this machine's, is not opened, the address
// given included, which a run then refuses before any work: taken for the
// user's own, as one of its answers was, its every answer was opened, so a
// site whose name answered with its public address and with 127.0.0.1,
// which served its first page and then refused new connections, had its
// page's fetch() of its own address reach this machine's service there,
// through the proxy's next address. A name all of whose answers are inside
// is the user's own, as a dev name at 127.0.0.1 is.
test("a name given that answers both on the public internet and off it, or at this machine, is refused before any work, and one all of whose answers are inside is the user's own", async () => {
  const os = require("node:os");
  const { checkManifest } = require("../skills/easyscreenshotkit/scripts/lib/pwa");
  const saved = os.networkInterfaces;
  os.networkInterfaces = () => ({
    lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
    eth0: [
      { address: "81.2.69.160", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "81.2.69.160/24" },
      { address: "2a02:1205:5000::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, cidr: "2a02:1205:5000::1/64", scopeid: 0 },
    ],
  });
  const names = {
    "evil.example": ["2606:2800:220:1::99", "127.0.0.1"],
    "evil4.example": ["93.184.216.34", "10.9.8.7"],
    "first.example": ["192.168.1.1", "93.184.216.34"],
    "evil-own.example": ["93.184.216.34", "81.2.69.160"],
    "evil-lan.example": ["93.184.216.34", "2a02:1205:5000::77"],
    "evil-fake.example": ["2606:2800:220:1::99", "198.18.0.5"],
    "mixdev.example": ["127.0.0.1", "::1"],
    "mixsite.example": "93.184.216.34",
  };
  const lookup = (guard, raw) => new Promise((resolve) => guard.lookupFor(raw)(new URL(raw).hostname, { all: true }, (err, list) => resolve(err || list)));
  try {
    await withNames(names, async () => {
      for (const [given, why] of [
        ["http://evil.example/", "on a host whose name answers with an address on the public internet, 2606:2800:220:1::99, and with one that is not, 127.0.0.1"],
        ["http://evil4.example/", "on a host whose name answers with an address on the public internet, 93.184.216.34, and with one that is not, 10.9.8.7"],
        ["https://first.example/", "on a host whose name answers with an address on the public internet, 93.184.216.34, and with one that is not, 192.168.1.1"],
        ["https://evil-own.example/", "on a host whose name answers with an address on the public internet, 93.184.216.34, and with one of this machine's, 81.2.69.160"],
        ["https://evil-lan.example/", "on a host whose name answers with an address on the public internet, 93.184.216.34, and with one on a network of this machine, 2a02:1205:5000::77"],
        ["http://evil-fake.example/", "on a host whose name answers with an address on the public internet, 2606:2800:220:1::99, and with one in the range a proxy in fake-ip mode gives every name, 198.18.0.0/15, 198.18.0.5"],
      ]) {
        const guard = await guardFor(given);
        assert.equal(guard.local, false, given);
        assert.equal(guard.unresolved, "", given);
        assert.equal(guard.refused, why, given);
        assert.equal(refusedError(given, guard).message, `Could not open ${given}: it is ${why}.`);
        // Every page of it, on any port and either scheme, and every
        // connection for it.
        const { hostname } = new URL(given);
        for (const url of [given, `http://${hostname}/secret`, `https://${hostname}/`, `http://${hostname}:8080/`, `http://${hostname}./x`]) assert.equal(await guard.refuses(url), why, url);
        const answer = await lookup(guard, `http://${hostname}/secret`);
        assert.deepEqual({ code: answer.code, refused: answer.refused }, { code: "ENOTPUBLIC", refused: `it is ${why}` }, given);
        // --pwa-check of it reads nothing.
        await assert.rejects(checkManifest({ url: given }), { message: `Could not read ${given}: it is ${why}` });
      }
      // Away from the address given, such a name is refused in the same
      // words, not as one off the public internet, which it is not alone,
      // and so is a connection for it, from a site of this machine too.
      const site = await guardFor("https://mixsite.example/");
      assert.equal(site.refused, "");
      const dev4 = await guardFor("http://localhost:4000/");
      for (const [url, why] of [
        ["http://evil.example/secret", "on a host whose name answers with an address on the public internet, 2606:2800:220:1::99, and with one that is not, 127.0.0.1"],
        ["https://evil-own.example/", "on a host whose name answers with an address on the public internet, 93.184.216.34, and with one of this machine's, 81.2.69.160"],
        ["https://evil-lan.example/", "on a host whose name answers with an address on the public internet, 93.184.216.34, and with one on a network of this machine, 2a02:1205:5000::77"],
        ["http://evil-fake.example/", "on a host whose name answers with an address on the public internet, 2606:2800:220:1::99, and with one in the range a proxy in fake-ip mode gives every name, 198.18.0.0/15, 198.18.0.5"],
      ]) {
        for (const guard of [site, dev4]) {
          assert.equal(await guard.refuses(url), why, url);
          const answer = await lookup(guard, url);
          assert.deepEqual({ code: answer.code, refused: answer.refused }, { code: "ENOTPUBLIC", refused: `it is ${why}` }, url);
        }
        // The README's Limits, SKILL.md and the help of both commands quote
        // the refusal in its general form, as the run words it.
        assert.match(why, /^on a host whose name answers with an address on the public internet, [0-9a-f:.]+, and with one /, url);
      }
      const fs = require("node:fs");
      const path = require("node:path");
      const general = '"on a host whose name answers with an address on the public internet, <address>, and with one ..."';
      const cli = path.join(__dirname, "..", "skills", "easyscreenshotkit", "scripts", "easyscreenshotkit.js");
      const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
      const limits = readme.slice(readme.indexOf("\n## Limits\n"));
      for (const [where, text] of [
        ["the README's Limits", limits.slice(0, limits.indexOf("\n## ", 2))],
        ["SKILL.md", fs.readFileSync(path.join(__dirname, "..", "skills", "easyscreenshotkit", "SKILL.md"), "utf8")],
        ["--help", spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).stdout],
        ["demo --help", spawnSync(process.execPath, [cli, "demo", "--help"], { encoding: "utf8" }).stdout],
      ]) {
        const flat = text.replace(/\s+/g, " ");
        assert.ok(flat.includes(general), where);
        assert.match(flat.slice(flat.indexOf(general) + general.length), /^[^.]*answers? (?:its|that) name with the address (?:you|the user) means? alone, as a line in its hosts file does\./, where);
      }
      // All its answers inside: the user's own, as before.
      const dev = await guardFor("http://mixdev.example:4000/");
      assert.deepEqual([dev.local, dev.refused], [true, ""]);
      assert.equal(await dev.refuses("http://mixdev.example:4000/app.js"), "");
      assert.deepEqual(await lookup(dev, "http://mixdev.example:4000/app.js"), [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ]);
    });
  } finally {
    os.networkInterfaces = saved;
  }
});

// Away from the address given a run opens port 80 and 443 only: a site's
// link, redirect, frame or manifest that names another port of its own host
// or of another one on the public internet reached another program there,
// as a mail, a database or an admin server is, and 0.1.3 opened it and
// saved what answered. The scheme, host and port given are the run's own,
// whatever the port, as a site that serves on 8443 is given, and so is
// https on the host and port of an http address given, where the browser
// goes itself for a host that asks for https (every .dev name does) and a
// server's redirect can send it: that is the program the address names.
// http on the port of an https address given is not, unless the port is 80
// or 443. A site on this machine given keeps its host and port, as before.
// A host is the one given with or without the dot that can end a name, and
// its www form is another host, as the README says.
test("away from the address given a run opens port 80 and 443 only, and the scheme, host and port given on any port", () =>
  withNames({ "public.example": "93.184.215.14", "www.public.example": "93.184.215.14", "other.example": "93.184.215.15", "inside.example": "10.0.0.7", "inside.acme.com": "10.0.0.7", "fritz.box": "192.168.178.1", "nas.home.arpa": "192.168.1.20", "myapp.test": "127.0.0.1", "router.lan": "192.168.1.1", "nas.local": "192.168.1.20", "x.internal": "10.0.0.8", "intranet": "10.0.0.9", "app.corp": "10.0.0.10", "acme.xn--p1ai": "10.0.0.11", "app": "10.0.0.12", "a..com": "10.0.0.13" }, async () => {
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
      // The host with the dot that can end a name is the same host, and
      // its www form another one.
      ["https://public.example.:8443/", ""],
      ["https://other.example.:8443/", port(8443)],
      ["https://www.public.example:8443/", port(8443)],
      ["https://www.public.example/", ""],
    ]) {
      assert.equal(await fromPort.refuses(url), why, url);
    }
    // And given with that dot, its pages without it, as the sitemap its
    // robots.txt names, which was refused as not on the host given.
    const fromDotted = await guardFor("https://public.example.:8443/");
    for (const [url, why] of [
      ["https://public.example:8443/sitemap.xml", ""],
      ["https://public.example.:8443/pricing", ""],
      ["http://public.example:8443/", port(8443)],
      ["https://public.example:9443/", port(9443)],
    ]) {
      assert.equal(await fromDotted.refuses(url), why, url);
    }
    const fromLocalDotted = await guardFor("http://localhost.:3000/");
    assert.equal(await fromLocalDotted.refuses("http://localhost:3000/pricing"), "");
    assert.equal(await fromLocalDotted.refuses("http://localhost:3001/"), NOT_GIVEN);
    // An http address given on another port: https on that host and port
    // too, and no other port of it or of another host.
    const fromHttp = await guardFor("http://public.example:8080/");
    for (const [url, why] of [
      ["http://public.example:8080/pricing", ""],
      ["https://public.example:8080/", ""],
      ["https://public.example:8080/login", ""],
      ["https://public.example:8081/", port(8081)],
      ["https://other.example:8080/", port(8080)],
      ["https://inside.example:8080/", NOT_PUBLIC],
    ]) {
      assert.equal(await fromHttp.refuses(url), why, url);
    }
    // A site on this machine given: its host and port as before, https of
    // its http, http of its https only on 80 or 443, the web ports on the
    // public internet, and no other port there.
    const fromLocal = await guardFor("http://localhost:3000/");
    for (const [url, why] of [
      ["http://localhost:3000/pricing", ""],
      ["https://localhost:3000/", ""],
      ["http://localhost:3001/", NOT_GIVEN],
      ["https://localhost:3001/", NOT_GIVEN],
      ["https://public.example/", ""],
      ["https://public.example:3000/", port(3000)],
    ]) {
      assert.equal(await fromLocal.refuses(url), why, url);
    }
    const fromLocalHttps = await guardFor("https://127.0.0.1:3443/");
    assert.equal(await fromLocalHttps.refuses("https://127.0.0.1:3443/x"), "");
    assert.equal(await fromLocalHttps.refuses("http://127.0.0.1:3443/x"), port(3443));
    const fromLocalWeb = await guardFor("http://localhost/");
    assert.equal(await fromLocalWeb.refuses("https://localhost:80/"), "");
    assert.equal(await fromLocalWeb.refuses("https://localhost/"), NOT_GIVEN);
    // From http on port 80 of a name that leads to the user's network, https
    // on 443 of it too, where the browser goes there first itself
    // (HTTPS-Upgrades): a name of two labels or more under one of the
    // internet's top-level domains, in ASCII as the URL parser writes it.
    // Not a name under a domain of a network's own or of one label, which
    // the browser opens by http alone, as Chrome 155 and 157 did, nor
    // localhost or an address not on the public internet: of those, port
    // 443 is another program, which a page could have the run open.
    for (const host of ["inside.acme.com", "fritz.box", "nas.home.arpa", "acme.xn--p1ai", "INSIDE.ACME.COM", "inside.acme.com."]) {
      const fromNetworkWeb = await guardFor(`http://${host}/`);
      assert.equal(fromNetworkWeb.local, true, host);
      assert.equal(await fromNetworkWeb.refuses(`https://${host}/login`), "", host);
      assert.equal(await fromNetworkWeb.refuses(`https://${host}:8443/`), NOT_GIVEN, host);
    }
    // A name of one label is one too, though it be the name of a top-level
    // domain, as a container's app or dev, and so is one with a label left
    // empty, which no domain holds.
    for (const host of ["inside.example", "myapp.test", "router.lan", "nas.local", "x.internal", "intranet", "app.corp", "10.0.0.7", "app", "a..com"]) {
      const fromNetworkWeb = await guardFor(`http://${host}/`);
      assert.equal(fromNetworkWeb.local, true, host);
      assert.equal(await fromNetworkWeb.refuses(`http://${host}/login`), "", host);
      assert.equal(await fromNetworkWeb.refuses(`https://${host}/login`), NOT_GIVEN, host);
    }
    assert.equal(await (await guardFor("http://inside.acme.com:8080/")).refuses("https://inside.acme.com/"), NOT_GIVEN);
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
  } finally {
    dns.lookup = lookup;
  }
});

// A request to the host and port given on this machine connects to the
// addresses the run takes that host for, both of this machine's for a name
// under localhost, as the browser takes them. Left to Node.js's own lookup,
// which can ask with ADDRCONFIG, ::1 was left out on a machine whose only
// IPv6 address is its loopback's, as in a container on Docker's own
// network, so a server that listens on ::1 alone, as one started on
// localhost can, was not reached: the tour read no robots.txt or sitemap
// of it, and --pwa-check could not read its page. Here the system's lookup
// of localhost gives 127.0.0.1 alone, as it does there, and the site
// listens on ::1 alone, with MAKERSMCP_REFUSE_ADDRESSES unset.
test("the kit reads the files of a site on localhost that listens on ::1 alone, whatever the system's lookup gives for localhost", async (t) => {
  const pick = require("../skills/easyscreenshotkit/scripts/lib/pick");
  const { checkManifest } = require("../skills/easyscreenshotkit/scripts/lib/pwa");
  let port = 0;
  const site = http.createServer((req, res) => {
    if (req.url === "/robots.txt") return res.end(`Sitemap: http://localhost:${port}/sitemap.xml\n`);
    if (req.url === "/sitemap.xml") return res.end(`<urlset><url><loc>http://localhost:${port}/integrations</loc></url></urlset>`);
    res.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>Acme</title><h1>Acme</h1>");
  });
  const listening = await new Promise((resolve) => {
    site.once("error", () => resolve(false));
    site.listen(0, "::1", () => resolve(true));
  });
  if (!listening) return t.skip("this machine has no ::1 to listen on");
  port = site.address().port;
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (typeof options === "function") [options, callback] = [{}, options];
    if (String(host).replace(/\.$/, "").toLowerCase() !== "localhost") return lookup(host, options, callback);
    process.nextTick(callback, null, options && options.all ? [{ address: "127.0.0.1", family: 4 }] : "127.0.0.1", 4);
  };
  // Each request of the kit's for the site asks the lookup the kit gave
  // it, which has to hand back both of this machine's addresses, ::1
  // first; it then goes to ::1 alone, so another program that listens on
  // 127.0.0.1 on that port, as another job's server can, is not reached
  // in its place.
  const handed = [];
  const get = http.get;
  http.get = (url, options, ...rest) => {
    const at = url instanceof URL ? url : new URL(String(url));
    if (at.hostname !== "localhost") return get.call(http, url, options, ...rest);
    const given = options && options.lookup;
    const only = (host, opts, callback) => {
      if (!given) return callback(Object.assign(new Error(`no lookup was given for ${host}`), { code: "ENOLOOKUP" }));
      given(host, { ...opts, all: true }, (err, list) => {
        handed.push(err ? err.code : list.map((one) => one.address).join(","));
        if (err) return callback(err);
        if (opts && opts.all) callback(null, [{ address: "::1", family: 6 }]);
        else callback(null, "::1", 6);
      });
    };
    return get.call(http, url, { ...options, lookup: only }, ...rest);
  };
  try {
    await withSetting(undefined, async () => {
      const origin = `http://localhost:${port}`;
      const index = await pick.readSiteIndex(origin);
      assert.deepEqual(index.urls, [`${origin}/integrations`]);
      await assert.rejects(checkManifest({ url: `${origin}/` }), { message: `${origin}/ links no web app manifest (no <link rel="manifest"> in its HTML). Give the manifest's own address or file.` });
    });
    assert.ok(handed.length >= 3, handed.join(" "));
    assert.deepEqual([...new Set(handed)], ["::1,127.0.0.1"]);
  } finally {
    http.get = get;
    dns.lookup = lookup;
    site.close();
  }
});

// A request the kit makes itself connects to the address its host was
// judged by, through no proxy: Node.js sends a request through the proxy
// HTTP_PROXY names once NODE_USE_ENV_PROXY is set, without the lookup the
// request was given, and the proxy looks the name up again for itself.
// Here a Node.js with those set reads a file of a server of this machine
// given to it: the server answers, and the proxy, a server of this test,
// is asked nothing. A Node.js that does not read NODE_USE_ENV_PROXY sends
// nothing to the proxy either way.
test("a request the kit makes itself goes through no proxy, not the one NODE_USE_ENV_PROXY has Node.js send its requests to", async () => {
  const { spawn } = require("node:child_process");
  const proxied = [];
  const proxy = http.createServer((req, res) => {
    proxied.push(req.url);
    res.end("from the proxy");
  });
  const site = http.createServer((req, res) => res.end("from the site"));
  await Promise.all([proxy, site].map((server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const module = require.resolve("../skills/easyscreenshotkit/scripts/lib/address");
  const code = `const { guardFor, getChecked } = require(${JSON.stringify(module)});
(async () => process.stdout.write((await getChecked(${JSON.stringify(`${origin}/robots.txt`)}, { guard: await guardFor(${JSON.stringify(`${origin}/`)}) })).body.toString()))().catch((err) => process.stdout.write(err.message));`;
  try {
    const env = { ...process.env, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, NO_PROXY: "", [SETTING]: "" };
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["-e", code], { env });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.on("close", () => resolve(text));
    });
    assert.equal(out, "from the site");
    assert.deepEqual(proxied, []);
  } finally {
    proxy.close();
    site.close();
  }
});

// The lookup a request of the kit's connects with refuses again what the
// rule refuses of the answer it hands back, before a connection: an address
// that is not public, away from the host and port given on this machine,
// and one MAKERSMCP_REFUSE_ADDRESSES names, with the rule's reason.
// refuses() refuses such a name first, from the same answer, so a request
// meets this only when it asks for a name in another spelling than
// refuses() read, as one written with two dots at its end did; here the
// lookup is asked for other names directly.
test("the lookup a request of the kit's connects with hands back no address the rule refuses", () =>
  withNames({ "site.example": "93.184.215.14", "half-loopback.example": ["93.184.215.15", "127.0.0.1"], "refused.example": "93.184.215.99" }, async () => {
    const ask = (resolve, host) => new Promise((done) => resolve(host, { all: true }, (err, list) => done(err ? [err.code, err.refused, err.at] : list.map((one) => one.address))));
    const HALF = "on a host whose name answers with an address on the public internet, 93.184.215.15, and with one that is not, 127.0.0.1";
    await withSetting("93.184.215.99", async () => {
      const guard = await guardFor("https://site.example/");
      const resolve = guard.lookupFor("https://site.example/sitemap.xml");
      assert.deepEqual(await ask(resolve, "site.example"), ["93.184.215.14"]);
      assert.deepEqual(await ask(resolve, "half-loopback.example"), ["ENOTPUBLIC", `it is ${HALF}`, "https://site.example/sitemap.xml"]);
      assert.deepEqual(await ask(resolve, "refused.example"), ["ENOTPUBLIC", `it is ${here("93.184.215.99")}`, "https://site.example/sitemap.xml"]);
      // From the host and port given on this machine: its own name hands
      // back its addresses, and any other name that leads to this machine
      // is not on the host and port given.
      const own = (await guardFor("http://localhost:3000/")).lookupFor("http://localhost:3000/robots.txt");
      assert.deepEqual(await ask(own, "localhost"), ["::1", "127.0.0.1"]);
      assert.deepEqual(await ask(own, "half-loopback.example"), ["ENOTPUBLIC", `it is ${HALF}`, "http://localhost:3000/robots.txt"]);
      assert.deepEqual(await ask(own, "refused.example"), ["ENOTPUBLIC", `it is ${here("93.184.215.99")}`, "http://localhost:3000/robots.txt"]);
    });
  }));

// A host written with dots at its end is one name to the run's lookup,
// however many dots: the DNS is asked once for dots.example, dots.example.
// and dots.example.., and a request for any of them goes to that first
// answer. With one dot taken off, dots.example.. was a name of its own, the
// DNS was asked again, and its spelling judged and reached by that second
// answer, which a site's DNS server can give as 127.0.0.1.
test("a host written with dots at its end is looked up once, however many", async () => {
  const asked = [];
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (typeof options === "function") [options, callback] = [{}, options];
    if (!/^dots\.example\.*$/i.test(host)) return lookup(host, options, callback);
    asked.push(host);
    const address = asked.length === 1 ? "93.184.215.14" : "127.0.0.1";
    process.nextTick(callback, null, options && options.all ? [{ address, family: 4 }] : address, 4);
  };
  const ask = (resolve, host) => new Promise((done) => resolve(host, { all: true }, (err, list) => done(err ? err.code : list.map((one) => one.address))));
  try {
    const guard = await guardFor("");
    for (const url of ["http://dots.example/a", "http://dots.example./b", "http://DOTS.example../c", "https://dots.example.../d"]) assert.equal(await guard.refuses(url), "", url);
    for (const host of ["dots.example..", "dots.example.", "dots.example"]) assert.deepEqual(await ask(guard.lookupFor(`http://${host}/x`), host), ["93.184.215.14"], host);
    assert.deepEqual(asked, ["dots.example"]);
  } finally {
    dns.lookup = lookup;
  }
});

// On the port given, this machine's own names, localhost, 127.0.0.1 and
// ::1, are the host given when it is one of them, where they reach an
// address of it, and their requests go to those addresses alone: a site
// given at http://127.0.0.1:4000/ whose pages name their styles, scripts
// and pictures at http://localhost:4000/, as Jekyll writes them, was taken
// without them. 127.0.0.1 and ::1 reach no address of each other, and can
// be two programs on one port. Nothing else is the host given: not a name
// under localhost, which a router on this machine, as Traefik or Caddy,
// serves as a site of its own, so from http://app1.localhost/ the run
// opened http://traefik.localhost/; not another address of 127.0.0.0/8,
// 0.0.0.0 or ::; and not a name whose every address is the host given's,
// as one a hosts file or the public DNS answers with 127.0.0.1.
test("on the port given, this machine's own names are the host given where they reach an address of it, and no other host is", () =>
  withNames({ "loopback-name.example": "127.0.0.1", "app1.test": "127.0.0.1", "app2.test": "127.0.0.1" }, async () => {
    const ask = (resolve, host) => new Promise((done) => resolve(host, { all: true }, (err, list) => done(err ? err.code : list.map((one) => one.address))));
    const fromFour = await guardFor("http://127.0.0.1:4000/");
    for (const [url, why] of [
      ["http://localhost:4000/site.css", ""],
      ["http://localhost.:4000/site.css", ""],
      ["https://localhost:4000/", ""],
      ["http://app.localhost:4000/", NOT_GIVEN],
      ["http://[::1]:4000/", NOT_GIVEN],
      ["http://localhost:4001/", NOT_GIVEN],
      ["http://127.0.0.2:4000/", NOT_GIVEN],
      ["http://0.0.0.0:4000/", NOT_GIVEN],
      ["http://[::]:4000/", NOT_GIVEN],
      ["http://loopback-name.example:4000/", NOT_GIVEN],
      ["http://loopback-name.example:4001/", NOT_GIVEN],
    ]) {
      assert.equal(await fromFour.refuses(url), why, url);
    }
    assert.deepEqual(await ask(fromFour.lookupFor("http://localhost:4000/site.css"), "localhost"), ["127.0.0.1"]);
    assert.equal(await ask(fromFour.lookupFor("http://loopback-name.example:4000/"), "loopback-name.example"), "ENOTPUBLIC");
    const fromName = await guardFor("http://localhost:4000/");
    for (const [url, why] of [
      ["http://127.0.0.1:4000/", ""],
      ["http://[::1]:4000/", ""],
      ["http://app.localhost:4000/", NOT_GIVEN],
      ["http://127.0.0.1:4001/", NOT_GIVEN],
      ["http://127.0.0.2:4000/", NOT_GIVEN],
      ["http://0.0.0.0:4000/", NOT_GIVEN],
      ["http://[::]:4000/", NOT_GIVEN],
    ]) {
      assert.equal(await fromName.refuses(url), why, url);
    }
    assert.deepEqual(await ask(fromName.lookupFor("http://localhost:4000/"), "localhost"), ["::1", "127.0.0.1"]);
    assert.equal(await ask(fromName.lookupFor("http://app.localhost:4000/"), "app.localhost"), "ENOTPUBLIC");
    const fromSix = await guardFor("http://[::1]:4000/");
    assert.equal(await fromSix.refuses("http://localhost:4000/"), "");
    assert.equal(await fromSix.refuses("http://127.0.0.1:4000/"), NOT_GIVEN);
    assert.deepEqual(await ask(fromSix.lookupFor("http://localhost:4000/"), "localhost"), ["::1"]);
    // A name under localhost given is that name alone: its own addresses
    // are both of this machine's, as the browser takes them.
    const fromUnder = await guardFor("http://app1.localhost/");
    for (const [url, why] of [
      ["http://app1.localhost/pricing", ""],
      ["http://traefik.localhost/", NOT_GIVEN],
      ["http://localhost/", NOT_GIVEN],
      ["http://127.0.0.1/", NOT_GIVEN],
      ["http://[::1]/", NOT_GIVEN],
    ]) {
      assert.equal(await fromUnder.refuses(url), why, url);
    }
    assert.deepEqual(await ask(fromUnder.lookupFor("http://app1.localhost/pricing"), "app1.localhost"), ["::1", "127.0.0.1"]);
    // A name at 127.0.0.1 given is that name alone too.
    const fromTest = await guardFor("http://app1.test/");
    for (const [url, why] of [
      ["http://app1.test/pricing", ""],
      ["http://app2.test/private", NOT_GIVEN],
      ["http://localhost/", NOT_GIVEN],
      ["http://127.0.0.1/", NOT_GIVEN],
    ]) {
      assert.equal(await fromTest.refuses(url), why, url);
    }
    assert.deepEqual(await ask(fromTest.lookupFor("http://app1.test/pricing"), "app1.test"), ["127.0.0.1"]);
    assert.equal(await ask(fromTest.lookupFor("http://app2.test/private"), "app2.test"), "ENOTPUBLIC");
  }));

// Behind a proxy in fake-ip mode every name answers in 198.18.0.0/15, which
// is not on the public internet: no host but the one given is opened, and
// the reason names the address and that range, where it said only that a
// host such as github.githubassets.com was not on the public internet. A
// name that answers with an IPv6 form of such an address is named with
// that form. An address written so in the address itself is that address,
// as before.
test("a name that answers in the range a proxy in fake-ip mode gives is refused with that address and the range named", () =>
  withNames({ "fake-site.example": "198.18.0.2", "fake-assets.example": "198.18.0.3", "fake-inside.example": "10.0.0.8", "fake-six.example": "::ffff:198.18.0.4" }, async () => {
    const fake = (address, away) => `at ${address}, in the range a proxy in fake-ip mode gives every name, 198.18.0.0/15, which is not on the public internet${away ? ", and not on the host and port given" : ""}`;
    const ask = (resolve, host) => new Promise((done) => resolve(host, { all: true }, (err, list) => done(err ? [err.code, err.refused] : list.map((one) => one.address))));
    const guard = await guardFor("https://fake-site.example/");
    assert.equal(guard.local, true);
    for (const [url, why] of [
      ["https://fake-site.example/pricing", ""],
      ["https://fake-assets.example/app.css", fake("198.18.0.3", true)],
      ["https://fake-six.example/app.js", fake("::ffff:198.18.0.4", true)],
      ["http://198.18.0.3/", NOT_GIVEN],
      ["http://fake-inside.example/", NOT_GIVEN],
    ]) {
      assert.equal(await guard.refuses(url), why, url);
    }
    const none = await guardFor("");
    assert.equal(await none.refuses("https://fake-assets.example/app.css"), fake("198.18.0.3", false));
    assert.equal(await none.refuses("https://fake-six.example/app.js"), fake("::ffff:198.18.0.4", false));
    assert.deepEqual(await ask(none.lookupFor("https://public.example/"), "fake-assets.example"), ["ENOTPUBLIC", `it is ${fake("198.18.0.3", false)}`]);
  }));

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

// MAKERSMCP_REFUSE_ADDRESSES: a comma list of IP addresses and CIDR ranges
// that the host which runs the kit refuses besides, as a service names its
// own public addresses, which lead back into its network. Empty or missing,
// it refuses nothing more; a value that does not parse is said so, naming
// the setting, so a run stops over it before any work: a run that went on
// would open what the host meant to refuse.
test("MAKERSMCP_REFUSE_ADDRESSES takes IP addresses and CIDR ranges separated by commas, and a value that does not parse is said so, naming it", async () => {
  for (const [value, size] of [
    [undefined, 0],
    ["", 0],
    ["  ", 0],
    [" , ,", 0],
    ["185.137.215.163", 1],
    [" 185.137.215.163 , 185.137.215.165 ", 2],
    ["185.137.215.163,", 1],
    ["10.0.0.0/8,192.168.0.0/16", 2],
    ["185.137.215.163/24", 1],
    ["2001:db8::/32,::1", 2],
    ["::ffff:185.137.215.163,0.0.0.0/0,::/0", 3],
  ]) {
    assert.equal(refusalsProblem(value), "", String(value));
    assert.equal(hostRefusals(value).size, size, String(value));
  }
  const said = (entry) => `${SETTING} takes IP addresses and CIDR ranges, separated by commas, such as 192.0.2.7,198.51.100.0/24, and "${entry}" is neither. Correct it, or leave it empty to refuse no more addresses.`;
  for (const entry of ["foo", "localhost", "127.1", "0x7f000001", "1.2.3", "1.2.3.4.5", "1.2.3.4/33", "::1/129", "1.2.3.4/", "/24", "1.2.3.4/-1", "1.2.3.4/+8", "1.2.3.4/ 8", "1.2.3.4/0x8", "1.2.3.4 5.6.7.8", "1.2.3.4;5.6.7.8", "[::1]", "fe80::1%eth0", "300.1.2.3", "01.2.3.4"]) {
    assert.equal(refusalsProblem(entry), said(entry), entry);
    assert.equal(refusalsProblem(`185.137.215.163,${entry}`), said(entry), entry);
    assert.throws(() => hostRefusals(entry), { message: said(entry) });
  }
  const long = `${"1".repeat(80)}`;
  assert.equal(refusalsProblem(long), said(`${"1".repeat(57)}...`));
  // What is no printable ASCII is shown escaped, a line break and a lone
  // surrogate too, so the message stays on its line.
  assert.equal(refusalsProblem("10.0.0.1\nSaved 12 pages, 1.2.3.4"), said("10.0.0.1%0ASaved 12 pages"));
  assert.equal(refusalsProblem("10.0.0.1 ‮x\ud800"), said("10.0.0.1%E2%80%A8%E2%80%AEx%EF%BF%BD"));
  assert.equal(refusalsProblem(`${"é".repeat(70)}`), said(`${"%C3%A9".repeat(57)}...`));
  // A run's rule reads the setting as the run starts.
  await withSetting("not an address", () => assert.rejects(guardFor("https://acme.com/"), { message: said("not an address") }));
});

// What MAKERSMCP_REFUSE_ADDRESSES names is refused for every address the run
// opens, the address given included, whatever the rule would let through:
// a site on this machine given, a name that resolves to it among other
// addresses, and each IPv6 form that holds an IPv4 address it names. The
// words name the setting and the address.
test("the addresses MAKERSMCP_REFUSE_ADDRESSES names are refused wherever they come from, the address given included", () =>
  withNames(
    {
      "public.example": "93.184.215.14",
      "vm.example": "185.137.215.163",
      "mixed.example": ["93.184.215.14", "185.137.215.165"],
      "v6.example": "2a00:1450:4001::1",
      "devbox.example": "10.0.0.7",
    },
    async () => {
      await withSetting("185.137.215.163, 185.137.215.165,2a00:1450::/32", async () => {
        const guard = await guardFor("https://public.example/");
        assert.equal(guard.refused, "");
        for (const [url, why] of [
          ["https://public.example/", ""],
          ["https://vm.example/", here("185.137.215.163")],
          ["http://185.137.215.165/", here("185.137.215.165")],
          ["https://185.137.215.163:443/x", here("185.137.215.163")],
          ["https://mixed.example/", here("185.137.215.165")],
          ["https://v6.example/", here("2a00:1450:4001::1")],
          ["http://[::ffff:185.137.215.163]/", here("::ffff:b989:d7a3")],
          ["http://[::185.137.215.163]/", here("::b989:d7a3")],
          ["http://[::ffff:0:185.137.215.163]/", here("::ffff:0:b989:d7a3")],
          ["http://[2002:b989:d7a3::1]/", here("2002:b989:d7a3::1")],
          ["http://[64:ff9b::185.137.215.165]/", here("64:ff9b::b989:d7a5")],
          // Before the port's rule, and with the scheme, host and port given.
          ["https://vm.example:8443/", here("185.137.215.163")],
        ]) {
          assert.equal(await guard.refuses(url), why, url);
        }
        // The address given on such a host: the run stops over it.
        const given = await guardFor("https://vm.example/app/");
        assert.equal(given.refused, here("185.137.215.163"));
        assert.equal(await given.refuses("https://vm.example/app/"), here("185.137.215.163"));
        assert.equal(refusedError("https://vm.example/app/", given).message, `Could not open https://vm.example/app/: it is ${here("185.137.215.163")}.`);
        // A name that cannot be looked up is refused as such.
        assert.equal(await guard.refuses("https://nowhere.example/"), UNRESOLVED);
      });
      // A site on this machine or its network given, which the setting names.
      await withSetting("127.0.0.0/8", async () => {
        const local = await guardFor("http://localhost:3000/");
        assert.equal(local.refused, here("127.0.0.1"));
        assert.equal(await local.refuses("http://localhost:3000/pricing"), here("127.0.0.1"));
        assert.equal((await guardFor("http://127.0.0.1:3000/")).refused, here("127.0.0.1"));
      });
      await withSetting("::1", async () => assert.equal((await guardFor("http://app.localhost:3000/")).refused, here("::1")));
      await withSetting("10.0.0.0/8", async () => assert.equal((await guardFor("http://devbox.example:8080/")).refused, here("10.0.0.7")));
      // Empty or missing, it refuses nothing more.
      for (const value of ["", undefined, " , "]) {
        await withSetting(value, async () => {
          const guard = await guardFor("https://vm.example/");
          assert.equal(guard.refused, "");
          assert.equal(await guard.refuses("https://vm.example/x"), "");
          assert.equal(await (await guardFor("http://localhost:3000/")).refuses("http://localhost:3000/x"), "");
        });
      }
    },
  ));

// An entry written as an IPv6 form of an IPv4 address or range, as a log
// shows a client's address (::ffff:185.137.215.163), refuses that IPv4
// address and range too, and every other form of it, as an IPv4 entry does:
// it named only itself, so 185.137.215.163 itself was opened. NAT64's local
// use prefix written with the IPv4 address last is such a form too, where
// 64:ff9b:1::b989:d7a3 named only itself.
test("an entry of MAKERSMCP_REFUSE_ADDRESSES in an IPv6 form of an IPv4 address or range refuses that IPv4 address or range and its other forms", () => {
  const forms = ["185.137.215.163", "::ffff:185.137.215.163", "::185.137.215.163", "::ffff:0:185.137.215.163", "2002:b989:d7a3::", "2002:b989:d7a3:1::5", "64:ff9b::b989:d7a3", "64:ff9b:1::b989:d7a3", "2001:0:b989:d7a3::", "2001:0:4136:e378:8000:63bf:4676:285c"];
  for (const entry of ["::ffff:185.137.215.163", "::ffff:b989:d7a3/128", "::185.137.215.163", "::ffff:0:185.137.215.163", "64:ff9b::185.137.215.163", "64:ff9b:1::185.137.215.163", "64:ff9b:1::b989:d7a3", "64:ff9b:1:fffe::b989:d7a3", "2002:b989:d7a3::/48", "2002:b989:d7a3:1::/64", "::ffff:185.137.215.0/120", "2002:b989:d700::/40"]) {
    const refusals = hostRefusals(entry);
    for (const address of forms) assert.equal(refusals.has(address), true, `${entry} ${address}`);
    assert.equal(refusals.has("185.137.214.163"), false, entry);
  }
  // A range holds the IPv4 range of its bits.
  assert.equal(hostRefusals("::ffff:185.137.215.0/120").has("185.137.215.7"), true);
  assert.equal(hostRefusals("::ffff:185.137.215.0/120").has("185.137.216.7"), false);
  assert.equal(hostRefusals("2002:b989:d700::/40").has("185.137.215.250"), true);
  assert.equal(hostRefusals("2002:b989:d700::/40").has("185.137.216.1"), false);
  // An IPv6 entry of no such form, ::1 and :: among them, holds no IPv4
  // address, nor does a range of such a form shorter than /96, or than /16
  // for 6to4, nor a Teredo entry, which names the IPv6 addresses it covers
  // alone; and with no IPv4 address named, an address of NAT64's local use
  // prefix is refused only as an entry names it.
  for (const entry of ["::1", "::", "2606:4700::/32", "2001:0:b989:d7a3::", "2001::/32", "2002::/15", "::/95", "::ffff:0:0/95", "64:ff9b::/95", "64:ff9b:1::/48"]) {
    for (const address of ["185.137.215.163", "93.184.215.14", "0.0.0.0", "0.0.0.1"]) assert.equal(hostRefusals(entry).has(address), false, `${entry} ${address}`);
    assert.equal(hostRefusals(entry).has("64:ff9b:1:abcd::7f00:1"), entry === "64:ff9b:1::/48", entry);
  }
});

// A Teredo address holds two IPv4 addresses, its server's and, each bit
// turned over, its client's, and NAT64's local use prefix can stand for any
// IPv4 address in a way of its network's choosing, in its last 32 bits as
// RFC 6052 puts it for a /96, in another place for a /48, or by a table of
// its own: an IPv4 entry refuses a Teredo address whose server or client it
// is, and while the setting names an IPv4 address, every address of the
// local use prefix. Both were opened as the user's own local site, the
// address given at 64:ff9b:1::7f00:1 with 127.0.0.1 refused among them.
test("MAKERSMCP_REFUSE_ADDRESSES refuses a Teredo address whose server or client it names, and while it names an IPv4 address every address of NAT64's local use prefix", async () => {
  const refusals = hostRefusals("185.137.215.163,10.20.0.0/16");
  for (const [address, refused] of [
    ["64:ff9b:1::b989:d7a3", true],
    ["64:ff9b:1::185.137.215.163", true],
    // RFC 6052's layout for a /48: 185.137 before the u octet, 215.163 after it.
    ["64:ff9b:1:b989:d7:a300::", true],
    ["64:ff9b:1::a14:5", true],
    ["64:ff9b:1::5db8:d70e", true],
    // A Teredo server, then a client, at 185.137.215.163 and in 10.20.0.0/16.
    ["2001:0:b989:d7a3::", true],
    ["2001:0:4136:e378:8000:63bf:4676:285c", true],
    ["2001:0:a14:5::1", true],
    ["2001:0:4136:e378:8000:63bf:f5eb:fffa", true],
    // Both on the public internet, neither of them named.
    ["2001:0:5db8:d70e::", false],
    ["2001:0:4136:e378:8000:63bf:a247:28f1", false],
    ["2606:4700::1111", false],
  ]) {
    assert.equal(refusals.has(address), refused, address);
  }
  await withSetting("127.0.0.1", async () => {
    for (const address of ["64:ff9b:1::7f00:1", "2001:0:7f00:1::", "2001:0:4136:e378:8000:63bf:80ff:fffe"]) {
      const url = `http://[${address}]:3000/`;
      const guard = await guardFor(url);
      assert.equal(guard.refused, here(address), url);
      assert.equal(await guard.refuses(`${url}app/`), here(address), url);
      assert.equal(refusedError(url, guard).message, `Could not open ${url}: it is ${here(address)}.`);
    }
    // The setting's other forms as before.
    assert.equal((await guardFor("http://[64:ff9b::7f00:1]:3000/")).refused, here("64:ff9b::7f00:1"));
  });
});

// An entry that holds every IPv4 address in an IPv6 form, as a host copies
// a firewall's list of the IPv6 ranges it refuses whole, would refuse them
// all, with a reason that blamed each site's address: it stops a run as a
// value that does not parse does, saying so.
test("an entry of MAKERSMCP_REFUSE_ADDRESSES that holds every IPv4 address in an IPv6 form is refused, saying so", () => {
  const said = (entry) => `${SETTING} takes IP addresses and CIDR ranges, and "${entry}" holds every IPv4 address, each in an IPv6 form, so it would refuse them all. An IPv6 form of an IPv4 address is judged by that address: name the IPv4 addresses to refuse, or leave it empty to refuse no more addresses.`;
  for (const entry of ["64:ff9b::/96", "::ffff:0:0/96", "::ffff:0:0:0/96", "::/96", "2002::/16", "64:ff9b:1::/96", "64:ff9b:1:fffe::/96"]) {
    assert.equal(refusalsProblem(entry), said(entry), entry);
    assert.equal(refusalsProblem(`185.137.215.163,${entry}`), said(entry), entry);
    assert.throws(() => hostRefusals(entry), { message: said(entry) });
  }
  // One bit longer, it holds half of them, as written.
  assert.equal(refusalsProblem("2002::/17"), "");
  assert.equal(hostRefusals("2002::/17").has("93.184.215.14"), true);
  assert.equal(hostRefusals("2002::/17").has("185.137.215.163"), false);
});

// A connection to 0.0.0.0 reaches this machine's 127.0.0.1, and one to ::
// reaches ::1, so a setting that refuses those refuses 0.0.0.0 in each of
// its forms and ::, as the address given, at a page and for a name found
// there, by the shared table (address-cases.json), and names both the
// address and the one it reaches. Judged as written, with 127.0.0.0/8 and
// ::1 refused, the address given at 0.0.0.0, 0, [::ffff:0.0.0.0] or [::],
// and at a name whose answer was 0.0.0.0, was opened, and the program on
// this machine's loopback at that port answered.
test("MAKERSMCP_REFUSE_ADDRESSES that refuses 127.0.0.1 or ::1 refuses 0.0.0.0 and ::, which a connection takes there, in every form and for a name found at one", () =>
  withNames({ "zero.example": "0.0.0.0", "zero6.example": "::", "zeromap.example": "::ffff:0.0.0.0", "zeropage.example": "93.184.215.14" }, async () => {
    const reached = (address, loop) => `at ${address}, where a connection reaches ${loop}, an address ${SETTING} refuses`;
    const lookup = (guard, raw) => new Promise((resolve) => guard.lookupFor(raw)(new URL(raw).hostname, { all: true }, (err, list) => resolve(err || list)));
    for (const [loop, list] of Object.entries(CASES.reachesLoopback)) {
      const other = loop === "::1" ? "127.0.0.1" : "::1";
      for (const address of list) {
        assert.deepEqual([hostRefusals(loop).has(address), hostRefusals(loop).via(address)], [true, loop], address);
        assert.equal(hostRefusals(other).has(address), false, address);
        assert.equal(hostRefusals("185.137.215.163").has(address), false, address);
      }
    }
    // A range that holds 127.0.0.1 does as well; one that names 0.0.0.0
    // names it itself; any other address of 0.0.0.0/8 reaches no program of
    // this machine.
    assert.deepEqual([hostRefusals("127.0.0.0/8").has("0.0.0.0"), hostRefusals("127.0.0.0/8").via("0.0.0.0")], [true, "127.0.0.1"]);
    assert.deepEqual([hostRefusals("0.0.0.0/8").has("0.0.0.0"), hostRefusals("0.0.0.0/8").via("0.0.0.0")], [true, ""]);
    assert.equal(hostRefusals("127.0.0.1").has("0.1.2.3"), false);
    assert.equal(hostRefusals("127.0.0.1").has("::1"), false);
    assert.equal(hostRefusals("::1").has("0.0.0.0"), false);
    await withSetting("127.0.0.0/8,::1", async () => {
      const page = await guardFor("https://zeropage.example/");
      for (const [loop, hosts] of Object.entries(CASES.reachesLoopbackHosts)) {
        for (const host of hosts) {
          const url = `http://${host}:3000/`;
          const guard = await guardFor(url);
          const why = reached(new URL(url).hostname.replace(/^\[|\]$/g, ""), loop);
          assert.equal(guard.refused, why, url);
          assert.equal(refusedError(url, guard).message, `Could not open ${url}: it is ${why}.`);
          assert.equal(await guard.refuses(`${url}app.js`), why, url);
          assert.equal(await page.refuses(url), why, url);
        }
      }
      for (const [host, address, loop] of [["zero.example", "0.0.0.0", "127.0.0.1"], ["zero6.example", "::", "::1"], ["zeromap.example", "::ffff:0.0.0.0", "127.0.0.1"]]) {
        const url = `http://${host}:3000/`;
        const guard = await guardFor(url);
        assert.equal(guard.refused, reached(address, loop), url);
        const answer = await lookup(guard, `${url}robots.txt`);
        assert.deepEqual({ code: answer.code, refused: answer.refused }, { code: "ENOTPUBLIC", refused: `it is ${reached(address, loop)}` }, url);
      }
      // 127.0.0.1 itself, as before.
      assert.equal((await guardFor("http://127.0.0.1:3000/")).refused, here("127.0.0.1"));
    });
    // Unset, 0.0.0.0 given is the user's own, as 127.0.0.1 is.
    await withSetting(undefined, async () => {
      const guard = await guardFor("http://0.0.0.0:3000/");
      assert.deepEqual([guard.local, guard.refused], [true, ""]);
    });
  }));

// A file the kit reads itself is held to the setting too, on the host and
// port given on this machine, whose lookup the run otherwise leaves to the
// system: no request is sent to an address it names.
test("a file the kit reads itself is not read at an address MAKERSMCP_REFUSE_ADDRESSES names, from the address given either", async () => {
  const seen = [];
  const site = http.createServer((req, res) => {
    seen.push(req.url);
    res.end("here");
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${site.address().port}`;
  try {
    await withSetting("127.0.0.1", async () => {
      const guard = await guardFor(`${origin}/`);
      assert.equal(guard.refused, here("127.0.0.1"));
      await assert.rejects(getChecked(`${origin}/robots.txt`, { guard }), { refused: `it is ${here("127.0.0.1")}` });
      // A name under localhost too, before any connection: nothing listens
      // on that port, and a request sent there would fail otherwise.
      await assert.rejects(getChecked("http://localhost:9/robots.txt", { guard: await guardFor("http://localhost:9/") }), { refused: `it is ${here("127.0.0.1")}` });
    });
    await withSetting(undefined, async () => {
      const got = await getChecked(`${origin}/robots.txt`, { guard: await guardFor(`${origin}/`) });
      assert.equal(got.body.toString(), "here");
    });
    assert.deepEqual(seen, ["/robots.txt"]);
  } finally {
    site.close();
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

// A name waits its turn for the system's lookup, which runs on libuv's
// threads, at most half of them at once, and its 10 s are counted from when
// its own lookup starts: two names whose DNS gives no answer for 12 s held
// both turns of Node's 4 threads, and a name asked beside them, which the
// system answers at once, ran out of its 10 s while it waited, and was
// refused for the run as one that could not be looked up. Once the run is
// over, a name still waiting for its turn is not asked at all, and fails at
// once: the run's process lived on until the system had been asked each of
// them, in turn, and had given up on them. In a process of its own, with
// UV_THREADPOOL_SIZE at 4, as Node starts, and the system's lookup stood in
// for, slow for the names that start with slow.
test("a name waits its turn for a lookup, its time counted from when its lookup starts, and none still waiting is asked once the run is over", { timeout: 60_000 }, () => {
  const script = `
const dns = require("dns");
const asked = [];
dns.lookup = (host, options, callback) => {
  asked.push(host);
  setTimeout(() => callback(null, [{ address: "93.184.215.14", family: 4 }]), host.startsWith("slow") ? 12_000 : 0);
};
const { guardFor, stopLookups } = require(${JSON.stringify(require.resolve("../skills/easyscreenshotkit/scripts/lib/address"))});
(async () => {
  const guard = await guardFor("");
  const said = await Promise.all(["slow1.example", "slow2.example", "fast.example"].map((host) => guard.refuses("http://" + host + "/")));
  const waits = ["slow3.example", "slow4.example", "after1.example", "after2.example"].map((host) => guard.refuses("http://" + host + "/"));
  await new Promise((done) => setTimeout(done, 200));
  const before = asked.slice();
  stopLookups();
  const started = Date.now();
  const after = await Promise.all(waits.slice(2));
  process.stdout.write(JSON.stringify({ said, after, ms: Date.now() - started, before, asked }));
  process.exit(0);
})();
`;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 50_000, env: { ...process.env, UV_THREADPOOL_SIZE: "4" } });
  assert.equal(run.status, 0, run.stderr);
  const { said, after, ms, before, asked } = JSON.parse(run.stdout);
  assert.deepEqual(said, [UNRESOLVED, UNRESOLVED, ""]);
  assert.deepEqual(after, [UNRESOLVED, UNRESOLVED]);
  assert.ok(ms < 1_000, `the names still waiting took ${ms} ms`);
  assert.deepEqual(before, ["slow1.example", "slow2.example", "fast.example", "slow3.example", "slow4.example"]);
  assert.deepEqual(asked, before);
});

// On a machine that reaches the web only through a proxy that a setting
// names, as a server or a CI runner can, the kit's browser and its own
// requests connect to each site themselves and reach none: a run that
// cannot reach the address given says so then, naming the setting and not
// its value, which can hold a password, where it gave only the browser's
// words for a connection that failed. An address of this machine or of a
// private network by its form, as a server under development that is not
// running, gets no such word, and nor does another address than the one
// given, as the manifest a page links.
// Once a run has saved, a name it asks for the first time is not looked up
// (see stopLookups()), and gives no answer at once, so the run's process
// waits for no lookup of it: in a process of its own, as the stop holds for
// the process's life.
test("a name first asked once the run has stopped its lookups is not looked up", () => {
  const script = `const dns = require("dns");
const asked = [];
const lookup = dns.lookup;
dns.lookup = (host, ...rest) => { asked.push(host); return lookup(host, ...rest); };
const address = require(${JSON.stringify(require.resolve("../skills/easyscreenshotkit/scripts/lib/address"))});
address.stopLookups();
const started = Date.now();
address.guardFor("https://after-the-stop.example/").then((guard) => process.stdout.write(JSON.stringify({ unresolved: guard.unresolved, asked, ms: Date.now() - started })));`;
  const run = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000 });
  let told = null;
  try {
    told = JSON.parse(run.stdout);
  } catch {
    assert.fail(`the lookup gave nothing: ${run.stdout}${run.stderr}`);
  }
  assert.deepEqual({ unresolved: told.unresolved, asked: told.asked }, { unresolved: "no answer in 10 s", asked: [] });
  assert.ok(told.ms < 5_000, `${told.ms} ms`);
});

test("a run that cannot reach the address given says that the kit does not use the proxy a setting names", () => {
  const names = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const word = (name) => ` easyscreenshotkit does not use the proxy ${name} names: its browser and its own requests connect to each site themselves, so on a network that reaches the web only through that proxy, it reaches no site.`;
  const failed = [
    "Could not open https://acme.com/: net::ERR_CONNECTION_TIMED_OUT",
    "Could not open https://acme.com/: net::ERR_TUNNEL_CONNECTION_FAILED",
    "Could not open https://acme.com/pricing: it is on a host whose name could not be looked up (the name servers did not answer).",
    "Could not open https://acme.com/: no answer in 60 s. The site may be down or slow, or the machine too busy: try again.",
    "Could not read https://acme.com/manifest.json: ECONNREFUSED",
    "Could not read https://acme.com/: acme.com was not found",
  ];
  const kept = [
    "Could not open http://127.0.0.1:3000/: net::ERR_CONNECTION_REFUSED",
    "Could not open http://localhost:3000/: net::ERR_CONNECTION_REFUSED",
    "Could not open http://192.168.1.20/: net::ERR_ADDRESS_UNREACHABLE",
    "Could not read https://acme.com/manifest.json, the manifest https://acme.com/ links: ECONNREFUSED",
    "Could not open https://acme.com/: net::ERR_CERT_AUTHORITY_INVALID",
    "Could not open https://acme.com/: it is at 185.137.215.163, an address MAKERSMCP_REFUSE_ADDRESSES refuses.",
  ];
  try {
    for (const name of names) delete process.env[name];
    for (const message of [...failed, ...kept]) assert.equal(throughNoProxy(message), message, message);
    process.env.HTTPS_PROXY = "http://user:secret@proxy.example:3128";
    for (const message of failed) assert.equal(throughNoProxy(message), `${message}${/[.]$/.test(message) ? "" : "."}${word("HTTPS_PROXY")}`, message);
    for (const message of kept) assert.equal(throughNoProxy(message), message, message);
    delete process.env.HTTPS_PROXY;
    // Each of the six settings, set alone, is named.
    for (const name of names) {
      process.env[name] = "socks5://127.0.0.1:1080";
      assert.equal(throughNoProxy(failed[0]), `${failed[0]}.${word(name)}`, name);
      delete process.env[name];
    }
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
