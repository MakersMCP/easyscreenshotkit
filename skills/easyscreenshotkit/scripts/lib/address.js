"use strict";

// Which addresses a run opens and reads. A run opens the address it is given,
// whatever it is, a steps file's url included, and what it finds from there
// (a page of the tour, a step's visit, a redirect, a move of a page or of a
// frame in it, a window a page opens, a sitemap, a manifest and its
// screenshots) only while that is a web address on the public internet. So
// no page, link, redirect, step or manifest of a site can send the browser
// or the kit to this machine, its network or another address that is not on
// the public internet, to find what answers there and save it in a
// screenshot, a demo or a report. A run given such an address itself, as a
// developer gives the address of a site on their own machine, opens that
// host and port and no other address of the kind.
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
// can answer otherwise in between. A name that does not resolve here, or
// gives no answer in LOOKUP_MS, is left to the browser's own lookup.

const dns = require("dns");
const net = require("net");
const http = require("http");
const https = require("https");
const zlib = require("zlib");

// What an address that is not opened is, as said after "it is".
const NOT_WEB = "not a web address";
const NOT_PUBLIC = "not on the public internet";
const NOT_GIVEN = "not on the public internet, and not on the host and port given";

// The ranges that are not on the public internet: this machine, private and
// shared networks, link-local, and the ranges kept for documentation,
// benchmarks, multicast and later use. MakersMCP's worker refuses the same
// ones for a link.
const V4 = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const V6 = [
  ["::", 128], ["::1", 128], ["64:ff9b:1::", 48], ["100::", 64], ["2001:db8::", 32],
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

// Whether an IP address is not on the public internet. Anything that is no
// IP address counts as not on it.
function notPublicIp(address) {
  const ip = String(address || "").replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = net.isIP(ip);
  if (family === 4) return blocked4.check(ip, "ipv4");
  if (family !== 6) return true;
  const groups = groupsOf(ip);
  if (!groups) return true;
  const held = heldIpv4(groups);
  if (held) return blocked4.check(held, "ipv4");
  return blocked6.check(ip, "ipv6");
}

// A name every browser takes for this machine without asking the DNS.
const localName = (host) => /(^|\.)localhost\.?$/i.test(host);

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

// Whether a host, as a URL gives it, is not on the public internet: an
// address of that kind, a name for this machine, or a name one of whose
// addresses is. A name that cannot be resolved here is judged by the browser,
// which cannot open it either.
async function hostNotPublic(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return true;
  if (net.isIP(host)) return notPublicIp(host);
  if (localName(host)) return true;
  const { list } = await addressesOf(host);
  return Boolean(list && list.some((answer) => notPublicIp(answer.address)));
}

const portOf = (url) => url.port || (url.protocol === "https:" ? "443" : "80");

// The rule for a run that starts at `start`, the address it was given, or
// at no address ("", for a manifest read from a file). refuses(url)
// resolves to "" for an address the run may open, else to what it is, as
// said after "it is": not a web address, or not on the public internet.
async function guardFor(start) {
  let from = null;
  try {
    from = start ? new URL(start) : null;
  } catch {
    from = null;
  }
  const local = Boolean(from) && /^https?:$/.test(from.protocol) && (await hostNotPublic(from.hostname));
  const given = (url) => local && url.hostname === from.hostname && portOf(url) === portOf(from);
  const parse = (raw) => {
    try {
      return new URL(String(raw));
    } catch {
      return null;
    }
  };
  return {
    local,
    async refuses(raw) {
      const url = parse(raw);
      if (!url || !/^https?:$/.test(url.protocol)) return NOT_WEB;
      if (given(url)) return "";
      if (await hostNotPublic(url.hostname)) return local ? NOT_GIVEN : NOT_PUBLIC;
      return "";
    },
    // For a request the kit makes itself: the lookup that connects it to
    // the addresses refuses() judged, undefined where any address goes.
    lookupFor(raw) {
      const url = parse(raw);
      if (!url || given(url)) return undefined;
      return (hostname, options, callback) => {
        const host = String(hostname).replace(/\.$/, "");
        addressesOf(host).then(({ list, error }) => {
          if (error) return callback(error);
          if (list.some((answer) => notPublicIp(answer.address))) {
            return callback(Object.assign(new Error(`${host} is ${local ? NOT_GIVEN : NOT_PUBLIC}`), { code: "ENOTPUBLIC", hostname: host }));
          }
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
// an address the guard refuses.
const REDIRECTS = 5;

async function getChecked(raw, { guard, headers = {}, timeoutMs = 15_000, maxBytes = Infinity } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = new URL(raw);
  for (let hop = 0; ; hop++) {
    const why = await guard.refuses(url.href);
    if (why) {
      const reason = hop ? `it leads to ${url.href}, which is ${why}` : `it is ${why}`;
      throw Object.assign(new Error(reason), { refused: reason });
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

module.exports = { guardFor, getChecked, notPublicIp, hostNotPublic, NOT_WEB, NOT_PUBLIC, NOT_GIVEN };
