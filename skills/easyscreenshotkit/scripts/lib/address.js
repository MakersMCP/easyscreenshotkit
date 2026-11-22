"use strict";

// Which addresses a run opens and reads. A run opens the address it is given,
// whatever host it is on, a steps file's url when the command line gives
// none included, as long as its host's name can be looked up here (see
// below), and what it finds from there
// (a page of the tour, a step's visit, a redirect, a move of a page or of a
// frame in it, a window a page opens, a sitemap, a manifest and its
// screenshots) only while that is a web address on the public internet that
// is not this machine's own, on port 80 or 443 or on the scheme, host and
// port of the address given. So no page, link, redirect, step or manifest
// of a site can send the browser or the kit to an address that is not on
// the public internet, to an address this machine's network interfaces
// hold or the IPv6 network of one (see ownIp()), as the run looks a name up
// (the browser's own lookup is below), nor to another program of a host on
// the public internet, to find what answers there and save it in a
// screenshot, a demo or a report. An address that leads into this machine
// or its network from outside, as the public IPv4 address of a router that
// turns a connection to it back inside, is no address of this machine's
// interfaces, and the run cannot tell it from any other on the public
// internet: MAKERSMCP_REFUSE_ADDRESSES (below) is for those. A run given
// such an address itself, as a developer gives the address of a site on
// their own machine, opens that host and port and no other address of the
// kind. That is an address given whose host is such an address, or a name
// every address of which is one: a name that answers both with an address
// on the public internet and with one that is not, or is this machine's,
// is not opened, the address given included (see standing()).
//
// The host that runs the kit can refuse more addresses with
// MAKERSMCP_REFUSE_ADDRESSES, a comma list of IP addresses and CIDR ranges,
// as a service that runs it for others names its own public addresses,
// which lead back into its network: those are refused wherever they come
// from, the address given included (see hostRefusals()).
//
// The rule holds for every request of the run's browser, which goes
// through the run's own proxy (see proxy.js): the documents it loads for
// the run's pages, judged first over the DevTools protocol for the words
// they are named with (see guardBrowser() in chrome.js), and whatever else
// the browser asks for, a page's pictures, styles, scripts and data, a
// WebSocket, a service worker's fetches and the requests the browser makes
// for itself. It holds too for the files the kit reads itself.
//
// A host name is judged by every address it resolves to here, looked up
// once in a run (see addressesOf()), and a connection the browser's proxy
// or the kit itself makes (a sitemap, a manifest, a screenshot's file) goes
// to one of those addresses, never to a second answer of the DNS (see
// lookupFor()). The browser asks the DNS for nothing: left to its own
// lookup, a DNS server of the site's that answered the run with a public
// address and the browser with 127.0.0.1 had the browser show the
// machine's own page on port 80, as the address given, a frame or after a
// redirect. A name that does not resolve here, or gives no answer in
// LOOKUP_MS, is not opened: such a name has no address the rule could
// judge. The address given on such a host stops the run before any work.

const dns = require("dns");
const net = require("net");
const os = require("os");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

// What an address that is not opened is, as said after "it is".
const NOT_WEB = "not a web address";
const NOT_PUBLIC = "not on the public internet";
const NOT_GIVEN = "not on the public internet, and not on the host and port given";
const UNRESOLVED = "on a host whose name could not be looked up";
// An address on another port than 80 and 443, away from the address given:
// given, whether the run has an address given, as --pwa-check of a
// manifest file has none.
const otherPort = (port, given) => `on port ${port}, not 80 or 443${given ? ", and not on the scheme, host and port given" : ""}`;
// An address that MAKERSMCP_REFUSE_ADDRESSES names, by the address of its
// host that the setting refuses.
const REFUSE_SETTING = "MAKERSMCP_REFUSE_ADDRESSES";
const refusedHere = (address) => `at ${address}, an address ${REFUSE_SETTING} refuses`;
// One the setting refuses as the address a connection to it reaches, this
// machine's 127.0.0.1 or ::1 (see hostRefusals()).
const reachesHere = (address, reached) => `at ${address}, where a connection reaches ${reached}, an address ${REFUSE_SETTING} refuses`;

// The ports a run opens on any host on the public internet: those of the
// web. Any other is opened only on the scheme, host and port of the address
// given, as a site that serves on 8443 is given: a site that links or
// redirects to another port, of its own host or of another one, reached
// another program there, as a mail or a database server is, and the run
// told an open port from a closed one.
const WEB_PORTS = new Set(["80", "443"]);

// The ranges that are not on the public internet: this machine, private and
// shared networks, link-local, and in IPv4 the ranges kept for
// documentation, benchmarks, multicast and later use; in IPv6 the
// documentation range 2001:db8::/32, the discard range 100::/64, the old
// site local range and multicast, and not the newer documentation prefix
// 3fff::/20 nor the benchmarking one, 2001:2::/48, which MakersMCP's worker
// takes for public too. The worker refuses the same ones for a link
// (helpers/kits/fetch-input.js), and NAT64's well known prefix whole
// besides. An IPv6 address that holds an IPv4 one is judged by that address
// (see heldIpv4()), and Teredo's 2001::/32 is not public at all: such an
// address carries the IPv4 addresses of a Teredo server and of a client,
// either of which can be this machine (2001:0:7f00:1::1 names the server
// 127.0.0.1), and a machine with a Teredo client reaches it through them.
// NAT64's local use prefix, 64:ff9b:1::/48, is not public whatever IPv4
// address it holds. test/address-cases.json holds the cases.
const V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6 = [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
];
const blocked4 = new net.BlockList();
for (const [address, prefix] of V4) blocked4.addSubnet(address, prefix, "ipv4");
const blocked6 = new net.BlockList();
for (const [address, prefix] of V6) blocked6.addSubnet(address, prefix, "ipv6");

// An IPv6 address as its eight 16-bit groups, or null.
function groupsOf(text) {
  let s = String(text).toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    s = `${s.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (h) => (h ? h.split(":") : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const all = [...head, ...Array(Math.max(0, fill)).fill("0"), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

// The IPv4 address an IPv6 one holds, as ::ffff:127.0.0.1 does, or "".
// Forms: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), translated
// (::ffff:0:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::).
function heldIpv4(groups) {
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from, to) => groups.slice(from, to).every((g) => g === 0);
  if (zero(0, 5) && groups[5] === 0xffff) return v4(groups[6], groups[7]);
  if (zero(0, 6) && (groups[6] || groups[7] > 1)) return v4(groups[6], groups[7]);
  if (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) return v4(groups[6], groups[7]);
  if (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) return v4(groups[6], groups[7]);
  if (groups[0] === 0x2002) return v4(groups[1], groups[2]);
  return "";
}

// The IPv4 addresses a Teredo address (2001::/32) holds: its server's, the
// 32 bits after 2001:0, and its client's, the last 32 bits with each bit
// turned over. Either can be this machine or the host's own: a machine
// with a Teredo client reaches such an address through them. [] for any
// other address.
function teredoIpv4(groups) {
  if (groups[0] !== 0x2001 || groups[1] !== 0) return [];
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  return [v4(groups[2], groups[3]), v4(groups[6] ^ 0xffff, groups[7] ^ 0xffff)];
}

// Whether an IPv6 address is in NAT64's local use prefix, 64:ff9b:1::/48,
// where a network puts the IPv4 address its translator reaches in a way of
// its own choosing: in the last 32 bits, in one of the other places RFC
// 6052 gives it, or by a table of its own.
const localNat64 = (groups) => groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1;

// The IPv4 address or range an IPv6 address or range holds, in one of the
// forms heldIpv4() reads or NAT64's local use prefix, as [address,
// prefix], or null: the IPv4 part is the last 32 bits of the mapped,
// compatible, translated and NAT64 forms, the local use prefix's too, as
// 64:ff9b:1::185.137.215.163 writes it, so a range of them at /96 or longer
// holds the IPv4 range of its last bits, and the 32 bits after 2002 in
// 6to4, so a range of those at /16 or longer holds the IPv4 range of its
// next bits, /32 from /48 on. A shorter range holds none. A compatible
// range that holds only :: and ::1, which are no IPv4 address, holds none.
// ::ffff:185.137.215.0/120 holds 185.137.215.0/24, and ::ffff:0:0/96 every
// IPv4 address, 0.0.0.0/0.
function heldRange(groups, bits) {
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zero = (from, to) => groups.slice(from, to).every((g) => g === 0);
  if (bits >= 96) {
    const prefix = bits - 96;
    if ((zero(0, 5) && groups[5] === 0xffff) || (zero(0, 4) && groups[4] === 0xffff && groups[5] === 0) || (groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)) || localNat64(groups)) return [v4(groups[6], groups[7]), prefix];
    if (zero(0, 6)) {
      const low = ((groups[6] << 16) | groups[7]) >>> 0;
      const size = 2 ** (32 - prefix);
      const first = low - (low % size);
      return first + size - 1 >= 2 ? [v4(groups[6], groups[7]), prefix] : null;
    }
  }
  if (groups[0] === 0x2002 && bits >= 16) return [v4(groups[1], groups[2]), Math.min(bits, 48) - 16];
  return null;
}

// An IP address as written in a URL's host or by a lookup, without the
// brackets and the zone (%eth0) that are no part of it.
const bareIp = (address) => String(address || "").replace(/^\[|\]$/g, "").replace(/%.*$/, "");

// Whether an IP address is not on the public internet. Anything that is no
// IP address counts as not on it.
function notPublicIp(address) {
  const ip = bareIp(address);
  const family = net.isIP(ip);
  if (family === 4) return blocked4.check(ip, "ipv4");
  if (family !== 6) return true;
  const groups = groupsOf(ip);
  if (!groups) return true;
  const held = heldIpv4(groups);
  if (held) return blocked4.check(held, "ipv4");
  return blocked6.check(ip, "ipv6");
}

// Whether an IP address is this machine's own: "machine" for one of the
// addresses its network interfaces hold, "network" for one of the IPv6
// network of such an address, the prefix its interface gives it, /48 or
// longer, else "". A machine on an IPv6 network holds global addresses of
// its own (SLAAC), temporary ones among them that come and go, and a server
// can hold a public IPv4 address on an interface: such an address is on the
// public internet by its range, so a site that read it off the run's own
// connection had the browser load a frame, a picture or a fetch() from a
// service of this machine that listens on all its addresses, and the kit
// read the sitemap robots.txt named there, with no word. A global IPv6
// network is the user's own, whose router and other machines answer there;
// the rest of a public IPv4 range on an interface is other people's
// servers, so in IPv4 the address alone. An IPv6 form of an IPv4 address of
// the machine's is judged by that address (see heldIpv4()). The interfaces
// are read at each judgement, as their addresses change while a run goes.
function ownIp(address) {
  const ip = bareIp(address);
  const family = net.isIP(ip);
  if (!family) return "";
  const groups = family === 6 ? groupsOf(ip) : null;
  if (family === 6 && !groups) return "";
  const held = groups ? heldIpv4(groups) : ip;
  let interfaces = {};
  try {
    interfaces = os.networkInterfaces();
  } catch {
    // None to read.
  }
  const mine = new net.BlockList();
  const networks = new net.BlockList();
  let some = false;
  for (const list of Object.values(interfaces)) {
    for (const one of list || []) {
      const at = bareIp(one && one.address);
      const kind = net.isIP(at);
      if (!kind) continue;
      some = true;
      mine.addAddress(at, kind === 4 ? "ipv4" : "ipv6");
      const bits = Number(String(one.cidr || "").split("/")[1]);
      if (kind === 6 && bits >= 48 && bits < 128) networks.addSubnet(at, bits, "ipv6");
    }
  }
  if (!some) return "";
  if (held) return mine.check(held, "ipv4") ? "machine" : "";
  if (mine.check(ip, "ipv6")) return "machine";
  return networks.check(ip, "ipv6") ? "network" : "";
}

// Whether the run takes an IP address for one it does not open away from
// the address given: one not on the public internet, or this machine's own
// (see ownIp()).
const insideIp = (address) => notPublicIp(address) || Boolean(ownIp(address));

// The addresses the host that runs the kit refuses besides those, from
// MAKERSMCP_REFUSE_ADDRESSES: a comma list of IP addresses and CIDR ranges,
// as 185.137.215.163,10.20.0.0/16, spaces around each allowed. A service
// that runs the kit for others names its own public addresses there, which
// lead back into its network. An IPv4 entry refuses that address in every
// IPv6 form that holds it too (see heldIpv4()), and a Teredo address whose
// server or client it is (see teredoIpv4()); and while the setting names
// an IPv4 address or range, every address of NAT64's local use prefix is
// refused, as one can stand for any IPv4 address (see localNat64()). It
// opened 64:ff9b:1::7f00:1 and 2001:0:7f00:1:: with 127.0.0.1 refused. An
// IPv6 entry refuses the IPv6 addresses it covers, and one in such a form,
// local use prefix included, the IPv4 address or range it holds as well
// (see heldRange()). A connection to 0.0.0.0 goes to this machine's
// 127.0.0.1, and one to :: to its ::1, so 0.0.0.0 in every form, the IPv6
// ones that hold it too, is judged as 127.0.0.1 as well, and :: as ::1:
// judged as written, with 127.0.0.0/8 and ::1 refused, the address given at
// 0.0.0.0, 0, [::ffff:0.0.0.0] or [::], or at a name whose answer was
// 0.0.0.0, was opened, and the program on this machine's loopback at that
// port answered. An empty or missing value refuses nothing more.
// A value that does not parse throws, naming the setting, so that a run
// stops before any work: a run that went on would open what the host meant
// to refuse. So does an entry that holds every IPv4 address, as
// 64:ff9b::/96 and 2002::/16 do, which would refuse them all: an entry a
// host copies from a firewall's list of IPv6 ranges it refuses whole.
// has(address): whether an address, as a URL or a lookup gives it, is one
// of those; via(address): for one the setting refuses only as the address a
// connection to it reaches, that address, 127.0.0.1 or ::1, else "". Read
// again for each run, and parsed once a value.
const ENTRY = /^([0-9A-Fa-f:.]+)(?:\/(\d{1,3}))?$/;
const settings = new Map();

function hostRefusals(value = process.env[REFUSE_SETTING]) {
  const text = value === undefined || value === null ? "" : String(value);
  if (settings.has(text)) return settings.get(text);
  const v4 = new net.BlockList();
  const v6 = new net.BlockList();
  // size: the entries; fours: those that refuse IPv4 addresses.
  let size = 0;
  let fours = 0;
  for (const part of text.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const match = ENTRY.exec(entry);
    const family = match ? net.isIP(match[1]) : 0;
    const bits = match && match[2] !== undefined ? Number(match[2]) : family === 4 ? 32 : 128;
    if (!family || bits > (family === 4 ? 32 : 128)) {
      // Shown cut, and with every character but printable ASCII escaped,
      // as no address holds one: a line break in it starts no line.
      const chars = [...entry];
      const cut = chars.length > 60 ? `${chars.slice(0, 57).join("")}...` : entry;
      const shown = cut.replace(/[^\x20-\x7e]/gu, (c) => {
        try {
          return encodeURIComponent(c);
        } catch {
          return "%EF%BF%BD";
        }
      });
      throw new Error(`${REFUSE_SETTING} takes IP addresses and CIDR ranges, separated by commas, such as 192.0.2.7,198.51.100.0/24, and "${shown}" is neither. Correct it, or leave it empty to refuse no more addresses.`);
    }
    // An entry written as an IPv6 form of an IPv4 address or range refuses
    // that IPv4 address or range too, and so each form of it, as an IPv4
    // entry does: ::ffff:185.137.215.163 named only itself, and
    // 185.137.215.163 was opened. One that holds every IPv4 address is not
    // taken.
    const held = family === 6 ? heldRange(groupsOf(match[1]) || [], bits) : null;
    if (held && held[1] === 0) throw new Error(`${REFUSE_SETTING} takes IP addresses and CIDR ranges, and "${entry}" holds every IPv4 address, each in an IPv6 form, so it would refuse them all. An IPv6 form of an IPv4 address is judged by that address: name the IPv4 addresses to refuse, or leave it empty to refuse no more addresses.`);
    (family === 4 ? v4 : v6).addSubnet(match[1], bits, family === 4 ? "ipv4" : "ipv6");
    if (held) v4.addSubnet(held[0], held[1], "ipv4");
    if (family === 4 || held) fours++;
    size++;
  }
  // What the list says of an address: "" for one it does not refuse, "self"
  // for one it names, or the loopback address it names that a connection to
  // the address reaches.
  const verdict = (address) => {
    if (!size) return "";
    const ip = bareIp(address);
    const family = net.isIP(ip);
    const four = (one) => (v4.check(one, "ipv4") ? "self" : one === "0.0.0.0" && v4.check("127.0.0.1", "ipv4") ? "127.0.0.1" : "");
    if (family === 4) return four(ip);
    if (family !== 6) return "";
    if (v6.check(ip, "ipv6")) return "self";
    const groups = groupsOf(ip);
    if (!groups) return "";
    if (fours && localNat64(groups)) return "self";
    const named = [heldIpv4(groups), ...teredoIpv4(groups)].filter(Boolean).map(four);
    if (named.includes("self")) return "self";
    return named.find(Boolean) || (groups.every((group) => group === 0) && v6.check("::1", "ipv6") ? "::1" : "");
  };
  const has = (address) => Boolean(verdict(address));
  const via = (address) => (verdict(address) === "self" ? "" : verdict(address));
  const refusals = { size, has, via };
  settings.set(text, refusals);
  return refusals;
}

// Why MAKERSMCP_REFUSE_ADDRESSES cannot be read, for a run to stop over
// before any work, or "".
function refusalsProblem(value = process.env[REFUSE_SETTING]) {
  try {
    hostRefusals(value);
    return "";
  } catch (err) {
    return err.message;
  }
}

// A name every browser takes for this machine without asking the DNS, and
// the addresses it takes it for, in the order the browser tries them, ::1
// first, as this machine's resolver gives them: with 127.0.0.1 first, a
// site started on localhost that listens on ::1 alone was passed over for
// another program that listens on 127.0.0.1 on the same port, whose pages
// the run then saved with no word.
const localName = (host) => /(^|\.)localhost\.?$/i.test(host);
const LOOPBACK = [
  { address: "::1", family: 6 },
  { address: "127.0.0.1", family: 4 },
];

// The addresses of this machine one of its own names stands for: a name
// under localhost both of them, and 127.0.0.1 and ::1 themselves; null for
// any other host, read as lookupKey() reads it.
function machineAddresses(host) {
  if (localName(host)) return LOOPBACK.map((one) => one.address);
  return host === "127.0.0.1" || host === "::1" ? [host] : null;
}

// A host as a URL gives it, as its addresses are asked for and kept (see
// addressesOf()): without the brackets of an IPv6 address and the dots that
// can end a name, every one of them, as the DNS takes rebind.example.. and
// rebind.example. for rebind.example. standing(), lookupWhy() and
// addressesFor() read it so, and the lookup each request of the kit's
// connects with hands addressesFor() the name as the request asks for it
// (see lookupFor()), so a request goes to the answer its host was judged
// by. When that lookup took a dot off before addressesFor() took another, a
// host written with two dots at its end, as cdn.evil.example.., was judged
// by the answer for cdn.evil.example., and its request went to a second
// answer of the DNS, for cdn.evil.example, which a site's DNS server gave
// as 127.0.0.1. With one dot taken off, such a host was a name of its own
// in the run's answers, asked of the DNS a second time.
const lookupKey = (hostname) => String(hostname || "").replace(/^\[|\]$/g, "").replace(/\.+$/, "");

// What a host name resolves to here: {list} of {address, family}, or
// {error}. Each name is asked once in a run, for LOOKUP_MS at most from when
// its lookup starts. The system's lookup (dns.lookup) runs on libuv's
// threads, at most half of them at once, UV_THREADPOOL_SIZE, 4 unless it is
// set, and the run's proxy looks up the name of every request the browser
// makes: a name whose DNS gives no answer holds a thread for as long as the
// system waits, 10 s with glibc's own settings, so with the 4 threads Node
// starts with, two such names on a page held every name asked after them
// past its 10 s, counted from when it was asked, and the requests for those
// were refused as names that could not be looked up, where 0.1.3's browser
// looked them up itself, side by side. So the run asks no more names at
// once than libuv looks up (atOnce()), and each waits its turn before its
// time starts; the command sets UV_THREADPOOL_SIZE to 32, 16 names at once
// (see easyscreenshotkit.js). A name's lookup that has run out of time
// keeps its turn until the system has given up on it, as its thread is
// busy till then. stopLookups(): the run is over, so a name still waiting
// for its turn is not asked, and fails as a name that gave no answer: the
// run's process ended only once the system had been asked each of them,
// in turn, and had given up on them.
const LOOKUP_MS = 10_000;
const answers = new Map();
const waiting = [];
let looking = 0;
let stopped = false;
const atOnce = () => Math.max(1, Math.floor((Math.min(1024, Math.max(1, Number(process.env.UV_THREADPOOL_SIZE) || 4)) + 1) / 2));
const noAnswer = (host) => ({ error: Object.assign(new Error(`${host} gave no answer in ${LOOKUP_MS / 1000} s`), { code: "ETIMEOUT", hostname: host }) });

function nextLookups() {
  while (!stopped && waiting.length && looking < atOnce()) {
    const { host, resolve } = waiting.shift();
    looking++;
    let over = false;
    const timer = setTimeout(() => {
      over = true;
      resolve(noAnswer(host));
    }, LOOKUP_MS);
    dns.lookup(host, { all: true, verbatim: true }, (error, list) => {
      looking--;
      clearTimeout(timer);
      if (!over) resolve(error ? { error } : { list });
      nextLookups();
    });
  }
}

function addressesOf(host) {
  if (!answers.has(host)) {
    answers.set(
      host,
      new Promise((resolve) => {
        if (stopped) return resolve(noAnswer(host));
        waiting.push({ host, resolve });
        nextLookups();
      }),
    );
  }
  return answers.get(host);
}

function stopLookups() {
  stopped = true;
  for (const { host, resolve } of waiting.splice(0)) resolve(noAnswer(host));
}

// Where a host, as a URL gives it, stands: "inside" when it is not on the
// public internet or is this machine's own (an address of that kind, a
// name for this machine, or a name every address of which is), "mixed" for
// a name that answers both with such an address and with one on the
// public internet, "unknown" for a name that could not be looked up here,
// "" for one on the public internet. A failed lookup is kept as unknown for
// the run, never as public. A mixed name is refused wherever it is, as an
// inside one is away from the address given, and given as the address it
// stops the run (see guardFor()): taken for the user's own, as one of its
// answers was, its every answer was opened, so a site whose name answered
// with its public address and with 127.0.0.1, which served its first page
// and then refused new connections, had its page's fetch() of its own
// address reach this machine's service on port 80 there, through the
// proxy's next address, and send what it read to another host; and where
// the system put 127.0.0.1 first, the run saved that service's page as the
// site's.
async function standing(hostname) {
  const host = lookupKey(hostname);
  if (!host) return "inside";
  if (net.isIP(host)) return insideIp(host) ? "inside" : "";
  if (localName(host)) return "inside";
  const { list } = await addressesOf(host);
  if (!list || !list.length) return "unknown";
  const inside = list.filter((answer) => insideIp(answer.address)).length;
  return !inside ? "" : inside === list.length ? "inside" : "mixed";
}

// Behind a proxy in fake-ip mode, as Clash, Surge or sing-box run with a
// TUN device, every name the run looks up answers in 198.18.0.0/15, and the
// proxy takes a connection there to the host the name is for. Such an
// address is not on the public internet, so behind such a proxy no host but
// the one given is opened: its reason names the address and the range,
// where it said only that the host, as github.githubassets.com, was not on
// the public internet. Taken for public, such an address would be judged
// for nothing: the proxy looks the name up again for itself and connects
// where that answers, to this machine too.
const FAKE_IP = new net.BlockList();
FAKE_IP.addSubnet("198.18.0.0", 15, "ipv4");

function inFakeRange(address) {
  const ip = bareIp(address);
  if (net.isIP(ip) === 4) return FAKE_IP.check(ip, "ipv4");
  const groups = net.isIP(ip) === 6 ? groupsOf(ip) : null;
  const held = groups ? heldIpv4(groups) : "";
  return Boolean(held) && FAKE_IP.check(held, "ipv4");
}

// Why a host refuses() or a lookup finds not on the public internet, or
// this machine's own, is refused, as said after "it is": for an address of
// this machine's, or a name whose first such answer in `list` is one, that
// address and that it is this machine's (see ownIp()); for a name whose
// first such answer is in fake-ip's range, that address and the range;
// else not on the public internet; and with the address given on this
// machine or its network (local), not on the host and port given either.
function insideWhy(hostname, list, local) {
  const host = lookupKey(hostname);
  const literal = net.isIP(bareIp(host)) ? [{ address: bareIp(host) }] : null;
  const hit = localName(host) ? null : (literal || list || []).find((answer) => insideIp(answer.address));
  const tail = local ? ", and not on the host and port given" : "";
  const own = hit && !notPublicIp(hit.address) ? ownIp(hit.address) : "";
  if (own) return `at ${bareIp(hit.address)}, ${own === "network" ? "on a network of this machine" : "an address of this machine"}${tail}`;
  if (hit && !literal && inFakeRange(hit.address)) return `at ${bareIp(hit.address)}, in the range a proxy in fake-ip mode gives every name, 198.18.0.0/15, which is not on the public internet${tail}`;
  return local ? NOT_GIVEN : NOT_PUBLIC;
}

// Why a name whose answers mix (see standing()) is refused, as said after
// "it is": its first answer on the public internet and its first that is
// not, or is this machine's, named as insideWhy() names it.
function mixedWhy(list) {
  const outside = list.find((answer) => !insideIp(answer.address));
  const hit = list.find((answer) => insideIp(answer.address));
  const own = !notPublicIp(hit.address) ? ownIp(hit.address) : "";
  const kind = own === "network" ? "one on a network of this machine" : own ? "one of this machine's" : inFakeRange(hit.address) ? "one in the range a proxy in fake-ip mode gives every name, 198.18.0.0/15" : "one that is not";
  return `on a host whose name answers with an address on the public internet, ${bareIp(outside.address)}, and with ${kind}, ${bareIp(hit.address)}`;
}

// Why a name could not be looked up, in a few words.
async function lookupWhy(hostname) {
  const { error } = await addressesOf(lookupKey(hostname));
  const code = (error && error.code) || "";
  if (code === "ENOTFOUND" || code === "ENODATA" || !error) return "no such name";
  if (code === "ETIMEOUT") return `no answer in ${LOOKUP_MS / 1000} s`;
  if (code === "EAI_AGAIN") return "the name servers did not answer";
  return code;
}

const portOf = (url) => url.port || (url.protocol === "https:" ? "443" : "80");

// A host as a URL gives it, with the one dot that can end a name left out,
// as standing() looks it up: portal.example. and portal.example are one
// host to the DNS, and on one port one program. Compared as written, an
// address given at https://portal.example.:8443/ had the sitemap its
// robots.txt names at https://portal.example:8443/ refused as not on the
// host given. The tour reads the site's host so too (see pick.js siteOf
// and opensPort).
const hostOf = (url) => url.hostname.replace(/\.$/, "");

// The addresses a host, as a URL gives it, stands for here: an IP address
// itself, the browser's own for a name under localhost, or what the name
// resolves to (see addressesOf). {list} of {address, family}, or {error}.
function addressesFor(hostname) {
  const host = lookupKey(hostname);
  const family = net.isIP(bareIp(host));
  if (family) return Promise.resolve({ list: [{ address: bareIp(host), family }] });
  if (localName(host)) return Promise.resolve({ list: LOOPBACK });
  return addressesOf(host);
}

// The rule for a run that starts at `start`, the address it was given, or
// at no address ("", for a manifest read from a file). refuses(url)
// resolves to "" for an address the run may open, else to what it is, as
// said after "it is": not a web address, at an address the host's
// MAKERSMCP_REFUSE_ADDRESSES refuses, not on the public internet, on a host
// whose name could not be looked up, or on a port other than 80 and 443
// away from the address given. lookupWhy(url): why the name of a host
// refuses() calls one whose name could not be looked up was not, in a few
// words (see lookupWhy()). unresolved: why the host of the address given
// could not be looked up, or "": a run given it opens nothing. refused: why
// MAKERSMCP_REFUSE_ADDRESSES refuses the address given, or why a name of it
// that answers both on the public internet and off it is not opened (see
// standing()), or "" likewise. Throws when MAKERSMCP_REFUSE_ADDRESSES does
// not parse.
async function guardFor(start) {
  const refusals = hostRefusals();
  let from = null;
  try {
    from = start ? new URL(start) : null;
  } catch {
    from = null;
  }
  const web = Boolean(from) && /^https?:$/.test(from.protocol);
  const at = web ? await standing(from.hostname) : "";
  const local = at === "inside";
  // A name given whose answers mix, which the run refuses as a whole, the
  // address given and every page of it.
  const mixed = at === "mixed" ? mixedWhy((await addressesFor(from.hostname)).list) : "";
  const ofMixed = (url) => Boolean(mixed) && hostOf(url) === hostOf(from);
  // The host and port given on this machine or its network, which the run
  // opens though they are not on the public internet; and the scheme, host
  // and port given, which the run opens on any port, and https on the host
  // and port of an http address given, the same program: the browser goes
  // there itself for a host that asks for https, as every .dev and .app
  // name does (HSTS), and a server can redirect there on its own port, so
  // http://myapp.dev:8080/ stopped the run on the address the browser
  // itself opened for it. A move from https down to http on that port is
  // not the address given. From an http address given on port 80, https on
  // port 443 of that host is the address given too, unless the host is a
  // name for this machine or an address not on the public internet: the
  // browser goes there itself from a plain http address on port 80, for a
  // host that asks for https, and for a name under a public suffix or an
  // address on the public internet, which it tries over https first
  // (HTTPS-Upgrades). A site given by http at a name of the user's network
  // that leads to one of its addresses, as intranet.acme.com, failed as the
  // browser tried it there, and so would one given at an address of this
  // machine's own on the public internet, as a server holds, which the run
  // takes for this machine (see ownIp()).
  // On the port given, this machine's own names (localhost, a name under
  // it, 127.0.0.1 and ::1) are the host given when it is one of them, where
  // they reach an address of it, which is all they reach (see lookupFor()):
  // a site given at http://127.0.0.1:4000/ whose pages name their styles,
  // scripts and pictures at http://localhost:4000/, as Jekyll writes them,
  // was taken without them, where 0.1.3, which judged documents alone, took
  // them. 127.0.0.1 and ::1 reach no address of each other, and can be two
  // programs on one port. shared(url): the addresses of this machine the
  // host of url stands for that the host given does too, or null.
  const mine = local ? machineAddresses(lookupKey(from.hostname)) : null;
  const shared = (url) => {
    const theirs = mine && machineAddresses(lookupKey(url.hostname));
    const both = theirs ? theirs.filter((address) => mine.includes(address)) : [];
    return both.length ? both : null;
  };
  const sameHost = (url) => hostOf(url) === hostOf(from) || Boolean(shared(url));
  const tried = web && from.protocol === "http:" && portOf(from) === "80" && !localName(lookupKey(from.hostname)) && !(net.isIP(bareIp(lookupKey(from.hostname))) && notPublicIp(lookupKey(from.hostname)));
  const upgraded = (url) => tried && url.protocol === "https:" && portOf(url) === "443";
  const samePort = (url) => portOf(url) === portOf(from) || upgraded(url);
  const given = (url) => local && sameHost(url) && samePort(url);
  const own = (url) => web && sameHost(url) && samePort(url) && (url.protocol === from.protocol || (from.protocol === "http:" && url.protocol === "https:"));
  const parse = (raw) => {
    try {
      return new URL(String(raw));
    } catch {
      return null;
    }
  };
  // Why the host's setting refuses an address of a host, as said after "it
  // is", by the address, and by the address a connection to it reaches
  // where that is the one it names.
  const refusedWhy = (address) => {
    const reached = refusals.via(address);
    return reached ? reachesHere(bareIp(address), reached) : refusedHere(bareIp(address));
  };
  // Why the host's setting refuses the first address of a host that it
  // refuses, or "". A name that cannot be looked up has none to judge: it
  // is refused as such.
  const refusedAt = async (hostname) => {
    if (!refusals.size) return "";
    const { list } = await addressesFor(hostname);
    const hit = (list || []).find((answer) => refusals.has(answer.address));
    return hit ? refusedWhy(hit.address) : "";
  };
  const firstRefused = web ? await refusedAt(from.hostname) : "";
  return {
    local,
    unresolved: at === "unknown" ? await lookupWhy(from.hostname) : "",
    refused: firstRefused || mixed,
    async refuses(raw) {
      const url = parse(raw);
      if (!url || !/^https?:$/.test(url.protocol)) return NOT_WEB;
      const hit = await refusedAt(url.hostname);
      if (hit) return hit;
      if (ofMixed(url)) return mixed;
      const port = portOf(url);
      const anyPort = own(url) || WEB_PORTS.has(port);
      if (given(url)) return anyPort ? "" : otherPort(port, web);
      const where = await standing(url.hostname);
      if (where === "unknown") return UNRESOLVED;
      if (where === "inside" || where === "mixed") return insideWhy(url.hostname, (await addressesFor(url.hostname)).list, local);
      return anyPort ? "" : otherPort(port, web);
    },
    lookupWhy(raw) {
      const url = parse(raw);
      return lookupWhy(url ? url.hostname : "");
    },
    // For a connection the kit or the browser's proxy makes, to an address
    // refuses() took: the lookup that connects it to the addresses
    // refuses() judged, the answer the name was asked for once (see
    // addressesOf()), and not to a second answer of the DNS. For the host
    // and port given it hands back the
    // addresses the run takes that host for, both of this machine's for a
    // name under localhost, as the browser takes them (see addressesFor()):
    // left to Node.js's own lookup, which can ask with ADDRCONFIG, ::1 was
    // left out where the machine's only IPv6 address is its loopback's, as
    // in a container on Docker's own network, so a server that listens on
    // ::1 alone, as one started on localhost can, was not reached, and its
    // robots.txt, its sitemaps and its page for --pwa-check were not read.
    // It reads the host as refuses() does (see lookupKey()), and refuses
    // again an answer that is not public, away from the host and port
    // given, or that MAKERSMCP_REFUSE_ADDRESSES names, failing the request
    // before it connects, with the reason as refuses() gives it. refuses()
    // refuses such a name first, from the same answer; with this refusal
    // taken out, a host the lookup read otherwise than refuses(), one
    // written with two dots at its end, had the kit's request connect to
    // 127.0.0.1. undefined for what is no address.
    lookupFor(raw) {
      const url = parse(raw);
      if (!url) return undefined;
      return (hostname, options, callback) => {
        const refuse = (why) => callback(Object.assign(new Error(`${hostname} is ${why}`), { code: "ENOTPUBLIC", hostname, refused: `it is ${why}`, why, at: url.href }));
        // The host and port given on this machine or its network, asked for
        // by its own name: every address of it goes, as the run opens it,
        // and of another of this machine's names only those it shares with
        // the host given (see shared()).
        const inside = given(url) && lookupKey(hostname) === lookupKey(url.hostname);
        const only = inside ? shared(url) : null;
        addressesFor(hostname).then(({ list, error }) => {
          if (error) return callback(error);
          const hit = list.find((answer) => refusals.has(answer.address));
          if (hit) return refuse(refusedWhy(hit.address));
          if (ofMixed(url) && lookupKey(hostname) === lookupKey(url.hostname)) return refuse(mixed);
          if (!inside && list.some((answer) => insideIp(answer.address))) return refuse(insideWhy(hostname, list, local));
          const family = options && options.family;
          const fit = list.filter((answer) => (!family || answer.family === family) && (!only || only.includes(bareIp(answer.address))));
          if (!fit.length) return callback(Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND", hostname }));
          if (options && options.all) callback(null, fit);
          else callback(null, fit[0].address, fit[0].family);
        });
      };
    },
  };
}

// A GET the kit makes itself, as fetch makes it, with every address on the
// way judged by guard first: redirects are followed by hand, 5 at most, and
// each is judged again. Resolves to {url, status, ok, type, body}, the body
// decompressed and cut at maxBytes; fails with refused set, the reason, for
// an address the guard refuses, why, what the guard said of it, and at, that
// address.
const REDIRECTS = 5;

async function getChecked(raw, { guard, headers = {}, timeoutMs = 15_000, maxBytes = Infinity } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(raw);
  for (let hop = 0; ; hop++) {
    const why = await guard.refuses(url.href);
    if (why) {
      const reason = hop ? `it leads to ${url.href}, which is ${why}` : `it is ${why}`;
      throw Object.assign(new Error(reason), { refused: reason, why, at: url.href });
    }
    const res = await requestOf(url, { headers: { "accept-encoding": "gzip, deflate, br", ...headers }, lookup: guard.lookupFor(url.href), signal });
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && location && hop < REDIRECTS) {
      res.resume();
      url = new URL(location, url);
      continue;
    }
    const body = await bodyOf(res, maxBytes);
    return { url: url.href, status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, type: String(res.headers["content-type"] || ""), body };
  }
}

// A request goes to the address the lookup hands back, through no proxy (an
// agent of its own): Node.js sends a request through the proxy HTTP_PROXY or
// HTTPS_PROXY names once NODE_USE_ENV_PROXY is set, or with
// --use-env-proxy, without the lookup the request was given, and the proxy
// looks the name up again for itself, as a site's DNS server can answer
// with 127.0.0.1.
function requestOf(url, { headers, lookup, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(url, { headers, agent: false, ...(lookup ? { lookup } : {}), signal }, resolve);
    req.on("error", reject);
  });
}

async function bodyOf(res, maxBytes) {
  const coding = String(res.headers["content-encoding"] || "").trim().toLowerCase();
  const decoder = coding === "gzip" || coding === "x-gzip" ? zlib.createGunzip() : coding === "deflate" ? zlib.createInflate() : coding === "br" ? zlib.createBrotliDecompress() : null;
  const stream = decoder ? res.pipe(decoder) : res;
  if (decoder) res.on("error", (err) => decoder.destroy(err));
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes) break;
    }
  } finally {
    res.destroy();
  }
  return Buffer.concat(chunks);
}

// The error for an address given whose host could not be looked up, before
// any work: guard is the run's rule for it.
function unresolvedError(url, guard) {
  return new Error(`Could not open ${url}: it is ${UNRESOLVED} (${guard.unresolved}).`);
}

// The error for an address given that MAKERSMCP_REFUSE_ADDRESSES refuses,
// before any work, likewise.
function refusedError(url, guard) {
  return new Error(`Could not open ${url}: it is ${guard.refused}.`);
}

// The settings that name a proxy for programs to reach the web through, as
// a network that reaches the web only through one gives them, which the
// kit does not use: its browser goes through the run's own proxy, which
// connects to each site itself, as the kit's own requests do (see proxy.js
// and requestOf()).
const PROXY_SETTINGS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"];

// What the address given did when such a network makes it fail: no name is
// found, no connection is made, or no answer comes, in the browser's words
// or in those of a file the kit reads itself (see pwa.js reasonOf()).
const UNREACHED_GIVEN = /^Could not (?:open|read) (\S+): (?:net::ERR_(?:NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_[A-Z_]+|ADDRESS_UNREACHABLE|INTERNET_DISCONNECTED|TIMED_OUT|EMPTY_RESPONSE|TUNNEL_CONNECTION_FAILED)\b|it is on a host whose name could not be looked up|no answer in \d+ s|\S+ was not found|E(?:CONNREFUSED|TIMEDOUT|HOSTUNREACH|NETUNREACH|CONNRESET|AI_AGAIN)\b)/;

// A run's last words for an address given that it could not reach, with
// the word, when one of those settings is set, that the kit does not use
// the proxy it names; the setting's value is not said, as it can hold a
// password. An address of this machine or of a private network by its
// form, as a server under development that is not running, gets no such
// word. On a server or a CI runner that reaches the web only through such
// a proxy, 0.1.3's browser went through it; without this word a run there
// gave only the browser's words for a connection that failed.
function throughNoProxy(message) {
  const name = PROXY_SETTINGS.find((one) => process.env[one]);
  const found = name ? UNREACHED_GIVEN.exec(String(message)) : null;
  if (!found) return message;
  let host = "";
  try {
    host = lookupKey(new URL(found[1]).hostname);
  } catch {
    return message;
  }
  if (localName(host) || (net.isIP(bareIp(host)) && insideIp(host))) return message;
  const text = String(message).trim();
  return `${text}${/[.!?]$/.test(text) ? "" : "."} easyscreenshotkit does not use the proxy ${name} names: its browser and its own requests connect to each site themselves, so on a network that reaches the web only through that proxy, it reaches no site.`;
}

module.exports = { guardFor, getChecked, hostOf, notPublicIp, ownIp, hostRefusals, refusalsProblem, unresolvedError, refusedError, otherPort, refusedHere, stopLookups, throughNoProxy, NOT_WEB, NOT_PUBLIC, NOT_GIVEN, UNRESOLVED, REFUSE_SETTING };
