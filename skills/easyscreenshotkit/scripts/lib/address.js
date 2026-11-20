"use strict";

// Which addresses a run opens and reads. A run opens the address it is given,
// whatever host it is on, a steps file's url when the command line gives
// none included, as long as its host's name can be looked up here (see
// below), and what it finds from there
// (a page of the tour, a step's visit, a redirect, a move of a page or of a
// frame in it, a window a page opens, a sitemap, a manifest and its
// screenshots) only while that is a web address on the public internet, on
// port 80 or 443 or on the scheme, host and port of the address given. So
// no page, link, redirect, step or manifest of a site can send the browser
// or the kit to this machine, its network or another address that is not on
// the public internet, as the run looks a name up (the browser's own lookup
// is below), nor to another program of a host on the public internet, to
// find what answers there and save it in a screenshot, a demo or a report.
// A run given such an address itself, as a developer gives the
// address of a site on their own machine, opens that host and port and no
// other address of the kind.
//
// The host that runs the kit can refuse more addresses with
// MAKERSMCP_REFUSE_ADDRESSES, a comma list of IP addresses and CIDR ranges,
// as a service that runs it for others names its own public addresses,
// which lead back into its network: those are refused wherever they come
// from, the address given included (see hostRefusals()).
//
// The rule is held for the documents the browser loads for the run's pages
// (see guardBrowser() in chrome.js) and for the files the kit reads itself.
// What a page asks for itself, its pictures, styles, scripts and data, and
// the manifest the browser reads for itself, are left to the browser's own
// rules.
//
// A host name is judged by every address it resolves to here, and a request
// the kit makes itself (a sitemap, a manifest, a screenshot's file) goes to
// one of those addresses, not to a second answer of the DNS. The browser
// resolves a name again when it opens it, which a DNS server of the site's
// can answer otherwise in between: so each document the browser loads is
// judged again by where the browser says it reached it, before the browser
// reads it (see reached() and guardBrowser() in chrome.js), and one it
// reached on this machine or its network is not shown but on the host and
// port given there; its request has reached that address by then. A site
// whose DNS answered the run with a public address and the browser with
// 127.0.0.1 had the browser show the machine's own page on port 80, as the
// address given, a frame or after a redirect. An address the browser counts
// as public, as one MAKERSMCP_REFUSE_ADDRESSES names, is judged by the
// run's lookup alone, as is any address behind a proxy. A
// name that does not resolve here, or gives no answer in LOOKUP_MS, is not
// opened: left to the browser's own lookup, it let a DNS server that failed
// the kit's question, or answered it late, send the browser's next one to
// this machine. The address given on such a host stops the run before any
// work.

const dns = require("dns");
const net = require("net");
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
// A document the browser reached on this machine or its network, by its
// own lookup, where the run's found the host on the public internet or on
// another host and port; and one the browser said nothing of where it
// reached (see reached()).
const REACHED_INSIDE = "on a host the browser reached on this machine or its network";
const REACHED_UNNAMED = "on a host the browser reached at an address it did not name";

// The address spaces Chrome gives the answer to a request it made itself
// (resourceIPAddressSpace): Loopback for this machine and Local for a
// private or link-local network, as Chrome 155 and 157 name them, where
// earlier versions named this machine Local and such a network Private;
// Public for the rest, and Unknown through a proxy, whose own address it
// reached, which says nothing of the page.
const INSIDE_SPACES = new Set(["Loopback", "Local", "Private"]);

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
// (see heldRange()). An empty or missing value refuses nothing more.
// A value that does not parse throws, naming the setting, so that a run
// stops before any work: a run that went on would open what the host meant
// to refuse. So does an entry that holds every IPv4 address, as
// 64:ff9b::/96 and 2002::/16 do, which would refuse them all: an entry a
// host copies from a firewall's list of IPv6 ranges it refuses whole.
// has(address): whether an address, as a URL or a lookup gives it, is one
// of those. Read again for each run, and parsed once a value.
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
  const has = (address) => {
    if (!size) return false;
    const ip = bareIp(address);
    const family = net.isIP(ip);
    if (family === 4) return v4.check(ip, "ipv4");
    if (family !== 6) return false;
    if (v6.check(ip, "ipv6")) return true;
    const groups = groupsOf(ip);
    if (!groups) return false;
    if (fours && localNat64(groups)) return true;
    const held = [heldIpv4(groups), ...teredoIpv4(groups)].filter(Boolean);
    return held.some((one) => v4.check(one, "ipv4"));
  };
  const refusals = { size, has };
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
// the addresses it takes it for.
const localName = (host) => /(^|\.)localhost\.?$/i.test(host);
const LOOPBACK = [
  { address: "127.0.0.1", family: 4 },
  { address: "::1", family: 6 },
];

// What a host name resolves to here: {list} of {address, family}, or
// {error}. Each name is asked once in a run, for 10 s at most.
const LOOKUP_MS = 10_000;
const answers = new Map();

function addressesOf(host) {
  if (!answers.has(host)) {
    const asked = new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: Object.assign(new Error(`${host} gave no answer in ${LOOKUP_MS / 1000} s`), { code: "ETIMEOUT", hostname: host }) }), LOOKUP_MS);
      dns.lookup(host, { all: true, verbatim: true }, (error, list) => {
        clearTimeout(timer);
        resolve(error ? { error } : { list });
      });
    });
    answers.set(host, asked);
  }
  return answers.get(host);
}

// Where a host, as a URL gives it, stands: "inside" when it is not on the
// public internet (an address of that kind, a name for this machine, or a
// name one of whose addresses is), "unknown" for a name that could not be
// looked up here, "" for one on the public internet. A failed lookup is
// kept as unknown for the run, never as public.
async function standing(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return "inside";
  if (net.isIP(host)) return notPublicIp(host) ? "inside" : "";
  if (localName(host)) return "inside";
  const { list } = await addressesOf(host);
  if (!list || !list.length) return "unknown";
  return list.some((answer) => notPublicIp(answer.address)) ? "inside" : "";
}

async function hostNotPublic(hostname) {
  return (await standing(hostname)) === "inside";
}

// Why a name could not be looked up, in a few words.
async function lookupWhy(hostname) {
  const host = String(hostname || "").replace(/\.$/, "");
  const { error } = await addressesOf(host);
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
  const host = String(hostname || "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
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
// away from the address given. reached(url, space) says the same of a
// document the browser has reached, by where it says it reached it (see
// INSIDE_SPACES). lookupWhy(url): why the name of a host refuses() calls
// one whose name could not be looked up was not, in a few words (see
// lookupWhy()). unresolved: why the host of the address given could not be
// looked up, or "": a run given it opens nothing. refused: why
// MAKERSMCP_REFUSE_ADDRESSES refuses the address given, or "" likewise.
// Throws when MAKERSMCP_REFUSE_ADDRESSES does not parse.
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
  // The host and port given on this machine or its network, which the run
  // opens though they are not on the public internet; and the scheme, host
  // and port given, which the run opens on any port, and https on the host
  // and port of an http address given, the same program: the browser goes
  // there itself for a host that asks for https, as every .dev and .app
  // name does (HSTS), and a server can redirect there on its own port, so
  // http://myapp.dev:8080/ stopped the run on the address the browser
  // itself opened for it. A move from https down to http on that port is
  // not the address given.
  const given = (url) => local && hostOf(url) === hostOf(from) && portOf(url) === portOf(from);
  const own = (url) => web && hostOf(url) === hostOf(from) && portOf(url) === portOf(from) && (url.protocol === from.protocol || (from.protocol === "http:" && url.protocol === "https:"));
  const parse = (raw) => {
    try {
      return new URL(String(raw));
    } catch {
      return null;
    }
  };
  // The first address of a host that the host's setting refuses, or "".
  // A name that cannot be looked up has none to judge: it is refused as
  // such.
  const refusedAt = async (hostname) => {
    if (!refusals.size) return "";
    const { list } = await addressesFor(hostname);
    const hit = (list || []).find((answer) => refusals.has(answer.address));
    return hit ? hit.address : "";
  };
  const firstRefused = web ? await refusedAt(from.hostname) : "";
  return {
    local,
    unresolved: at === "unknown" ? await lookupWhy(from.hostname) : "",
    refused: firstRefused ? refusedHere(firstRefused) : "",
    async refuses(raw) {
      const url = parse(raw);
      if (!url || !/^https?:$/.test(url.protocol)) return NOT_WEB;
      const hit = await refusedAt(url.hostname);
      if (hit) return refusedHere(hit);
      const port = portOf(url);
      const anyPort = own(url) || WEB_PORTS.has(port);
      if (given(url)) return anyPort ? "" : otherPort(port, web);
      const where = await standing(url.hostname);
      if (where === "unknown") return UNRESOLVED;
      if (where === "inside") return local ? NOT_GIVEN : NOT_PUBLIC;
      return anyPort ? "" : otherPort(port, web);
    },
    // Why a document refuses() took is not to be shown, now that the
    // browser has reached it in the address space `space`, or "": the
    // browser looks a name up again for itself, and one it reached on this
    // machine or its network is shown only on the host and port given
    // there. null for space: the browser did not say where it reached it.
    // Elsewhere the run's own lookup has decided.
    reached(raw, space) {
      if (space === null) return REACHED_UNNAMED;
      if (!INSIDE_SPACES.has(String(space || ""))) return "";
      const url = parse(raw);
      if (url && given(url)) return "";
      return local ? `${REACHED_INSIDE}, and not on the host and port given` : REACHED_INSIDE;
    },
    lookupWhy(raw) {
      const url = parse(raw);
      return lookupWhy(url ? url.hostname : "");
    },
    // For a request the kit makes itself, to an address refuses() took: the
    // lookup that connects it to the addresses refuses() judged, the answer
    // the name was asked for once (see addressesOf()), and not to a second
    // answer of the DNS; undefined where any address goes. refuses() has
    // already refused a name with an address that is not public, or that
    // MAKERSMCP_REFUSE_ADDRESSES names, from that same answer, so the lookup
    // judges none again.
    lookupFor(raw) {
      const url = parse(raw);
      if (!url || (given(url) && !refusals.size)) return undefined;
      return (hostname, options, callback) => {
        const host = String(hostname).replace(/\.$/, "");
        addressesFor(host).then(({ list, error }) => {
          if (error) return callback(error);
          const family = options && options.family;
          const fit = family ? list.filter((answer) => answer.family === family) : list;
          if (!fit.length) return callback(Object.assign(new Error(`${host} has no address`), { code: "ENOTFOUND", hostname: host }));
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

function requestOf(url, { headers, lookup, signal }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const req = client.get(url, { headers, ...(lookup ? { lookup } : {}), signal }, resolve);
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

module.exports = { guardFor, getChecked, hostOf, notPublicIp, hostNotPublic, hostRefusals, refusalsProblem, unresolvedError, refusedError, otherPort, refusedHere, NOT_WEB, NOT_PUBLIC, NOT_GIVEN, UNRESOLVED, REFUSE_SETTING, REACHED_INSIDE, REACHED_UNNAMED, INSIDE_SPACES };
