"use strict";

// The run's own proxy, the browser's one way to the network. The browser is
// started with --proxy-server naming it, on 127.0.0.1, and with
// --proxy-bypass-list=<-loopback>, so its requests for this machine's own
// addresses come here too (see start() in chrome.js). It takes two kinds of
// request: a plain http one, its address written whole (GET http://host/x),
// and a CONNECT tunnel to a host and port, which carries https, wss and ws.
// Each is judged by the run's rule (see guardFor() in address.js): the
// address is opened only when the rule opens it, the host is looked up once,
// by the run's own lookup, and the connection goes to an address that lookup
// gave and the rule judged, never to a second answer of the DNS. Anything
// else is not passed on, and recorded with the address and the reason: a
// tunnel is answered 403, and a plain http request, or one whose site could
// not be reached, gets no answer at all, its connection closed, as the
// browser's own connection to a site that is down fails. What the proxy did
// not pass on is told by those records (see refusalOf() and unreached),
// never by what it sends: an answer of its own to a plain http request is
// one a page can read, headers and all, so a mark in it that told the run
// the proxy wrote it, a secret one included, was a mark a site could learn
// and then send with its own answers, which the run then took for the
// proxy's refusal, in the site's own words.
//
// The rules the browser is held to over the DevTools protocol judge the
// documents it loads before their requests go (see guardBrowser()), which
// gives the words a page left out or a move refused is named with; this is
// what holds whatever made a request. Without it the browser asked the DNS
// for a name itself, so a site whose DNS server answered the run with a
// public address and the browser with 127.0.0.1 had the browser show the
// machine's own page; and the browser made requests no rule of the run saw: a
// speculation rule's prefetch, the fetch of a certificate's issuer, the
// well-known file WebAuthn asks a site for, a service worker's fetches, a
// WebSocket, and a page's pictures, styles, scripts and data at any address.
//
// It listens on 127.0.0.1 alone, on a port the system gives, for as long as
// its browser runs. Another program of this machine can use it too, and
// gets what the browser gets: the addresses the run's rule opens.

const net = require("net");
const http = require("http");
const crypto = require("crypto");
const { NOT_WEB } = require("./address");

// How a connection to an address is made: to `host`, an IP address the
// rule judged, on `port`. A test stands a server of its own on 127.0.0.1
// in for a site on the public internet by putting another function here.
const dialer = { connect: (options) => net.connect(options) };

// What a request with no rule to judge it by is: the proxy of a browser
// that draws the kit's own pages, which opens no address of the web.
const NO_RULE = "not an address this browser opens";

// A connection to a host that has not been made in this time is given up
// on, whichever of its addresses were tried; and an address that has not
// connected in STAGGER_MS has the next one tried beside it, and once each
// was, another connection to them (see dial()).
const CONNECT_MS = 30_000;
const STAGGER_MS = 250;

// The most a request's headers may hold, as a browser takes them: Node.js's
// own limit, 16 KB, refused a request with a site's cookies past it. The
// most an answer may hold up to the end of the status line of the request's
// own answer, its informational answers before it included, for the proxy
// to put two lines in after that line (see closing()).
const HEADERS_MAX = 256 * 1024;

// The headers that are of one connection and not passed on (RFC 9110).
const HOP = new Set(["connection", "proxy-connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);


// Marks a connection of the browser's that carried a site's answer, which
// the browser was told to close (see closing()).
const CARRIED = Symbol("carried");

// The words Chrome gives a document whose connection failed, by the code
// the system gave the proxy, and the reason Fetch.failRequest gives it so
// (see guardBrowser()). Through the proxy the browser hears only that the
// tunnel or the answer failed.
const CHROME_WORDS = {
  ECONNREFUSED: ["net::ERR_CONNECTION_REFUSED", "ConnectionRefused"],
  ETIMEDOUT: ["net::ERR_CONNECTION_TIMED_OUT", "TimedOut"],
  EHOSTUNREACH: ["net::ERR_ADDRESS_UNREACHABLE", "AddressUnreachable"],
  ENETUNREACH: ["net::ERR_ADDRESS_UNREACHABLE", "AddressUnreachable"],
  ECONNRESET: ["net::ERR_CONNECTION_RESET", "ConnectionReset"],
};
const wordsFor = (code) => CHROME_WORDS[code] || ["net::ERR_CONNECTION_FAILED", "ConnectionFailed"];

// A host and port as the proxy keys them: the URL parser's host, lowercased
// and with an IPv6 address in brackets, and its port, the scheme's own when
// none is written.
function authorityOf(url) {
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  return `${url.hostname}:${port}`;
}

// The path and query of a plain http request as the browser wrote them,
// after the host of its address (raw) whose URL is url: the URL parser's
// own form of them drops a ? with nothing after it, so a page's
// fetch("/ask?") reached the site as /ask. A fragment, which no browser
// sends, is left out, as the URL parser leaves it out, and a target written
// as no browser writes one, with no path or with a \ in it, goes in the URL
// parser's form.
function targetOf(raw, url) {
  const rest = String(raw).slice(String(raw).indexOf("//") + 2);
  const at = rest.search(/[/?#\\]/);
  const tail = at < 0 ? "" : rest.slice(at).split("#")[0];
  return tail.startsWith("/") && !tail.includes("\\") ? tail : `${url.pathname}${url.search}`;
}

// The authority of an address as the browser asks for it, or "".
function authorityOfUrl(raw) {
  try {
    return authorityOf(new URL(String(raw)));
  } catch {
    return "";
  }
}

// The addresses a lookup that the rule gave hands back for a host: those it
// judged (see lookupFor() in address.js). Fails with why set, what the
// address is, when that lookup refuses one.
function addressesBy(lookup, hostname) {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (err, list) => (err ? reject(err) : resolve(list)));
  });
}

// A connection to one of `list`, the addresses of a host the rule judged,
// in their order: the next is tried beside the ones under way once none has
// connected in STAGGER_MS, or at once when one fails, as a browser tries a
// host's addresses, and the first to connect is taken and the others ended.
// An address the list holds twice, as a resolver can give each answer more
// than once, is tried once in that order. Once each address is under way,
// another connection to them, in turn, is started beside those each
// STAGGER_MS that none has connected, EXTRA in all, as the browser starts a
// second connection to a host that has not answered in a quarter of a
// second: with one connection to each address, one the network lost, on a
// lossy path, behind a NAT or a load balancer with a backend that does not
// answer, cost a page CONNECT_MS and then the page, where the browser's
// second connection got through. One that fails has the next connection
// started at once; an address whose connection failed in a way that says
// it would fail again (see DEAD) is not tried again, and once every address
// under way has failed so, the dial fails then: a host that refuses fails
// at once. Counted as one to try again, the IPv6 address of a host on a
// machine with no IPv6, which fails at once with ENETUNREACH, had one of
// the two more connections go there, and beside an IPv4 connection the
// network lost, one more started, at half a second, where two were to
// start from a quarter of a second. All of it is given up CONNECT_MS after
// it began. Each dial is kept in `dials`
// while it goes, so that the proxy's close() ends it: its connections under
// way are ended, its timers cleared, and no other address is tried. Tried
// one after another with 30 s each, a picture on a host whose four
// addresses did not answer kept the run's process alive two minutes after
// it had saved, and longer where the resolver gave each address five
// times. Fails with the last error.
const EXTRA = 2;

// The codes of a connection that failed before it was made that say the
// address would fail again at once: it refused, or this machine has no way
// to it or no address to send from.
const DEAD = new Set(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL"]);

function dial(list, port, dials) {
  const seen = new Set();
  const addresses = list.filter(({ address }) => !seen.has(address) && seen.add(address));
  return new Promise((resolve, reject) => {
    // The connections under way, each with its address, and the addresses
    // that are not tried again.
    const tries = new Map();
    const refusing = new Set();
    // The next address not tried yet, and the connections started beside
    // them once each was.
    let next = 0;
    let extra = 0;
    let last = null;
    let over = false;
    let stagger = null;
    let limit = null;
    const end = (err, socket) => {
      if (over) return;
      over = true;
      clearTimeout(stagger);
      clearTimeout(limit);
      dials.delete(entry);
      for (const one of tries.keys()) if (one !== socket) one.destroy();
      tries.clear();
      if (err) reject(err);
      else resolve(socket);
    };
    const entry = { stop: () => end(Object.assign(new Error("the proxy has closed"), { code: "ECONNABORTED" })) };
    const failed = () => end(last || Object.assign(new Error("no address"), { code: "ENOTFOUND" }));
    // A connection to one address: whether it was started. Nagle's
    // algorithm is off on it, as the browser has it off on the connections
    // it makes itself: with it on, the browser's request in a tunnel, which
    // it writes after its last part of the TLS handshake, waited until the
    // site had acknowledged that part, which a site can hold back 40 ms or
    // more, so each tunnel a page opened, one for each host of its pictures
    // too, waited that long for its first answer.
    const start = ({ address, family }) => {
      let socket;
      try {
        socket = dialer.connect({ host: address, port: Number(port), noDelay: true, ...(family ? { family } : {}) });
      } catch (err) {
        // A port or an address the system will not connect to at all.
        last = err;
        refusing.add(address);
        return false;
      }
      tries.set(socket, address);
      socket.once("connect", () => end(null, socket));
      // Kept for the socket's life: an error with no listener is thrown at
      // the process.
      socket.on("error", (err) => {
        socket.destroy();
        if (over || !tries.delete(socket)) return;
        last = err;
        if (err && DEAD.has(err.code)) refusing.add(address);
        another();
      });
      return true;
    };
    // The next connection: to the next address not tried yet, or, while
    // one is still under way, another to them in turn, past those that are
    // not tried again.
    const another = () => {
      clearTimeout(stagger);
      if (over) return;
      let started = false;
      while (!started && next < addresses.length) started = start(addresses[next++]);
      const open = addresses.filter((one) => !refusing.has(one.address));
      if (!started && tries.size && open.length && extra < EXTRA) start(open[extra++ % open.length]);
      if ([...tries.values()].every((one) => refusing.has(one))) return failed();
      if (next < addresses.length || extra < EXTRA) stagger = setTimeout(another, STAGGER_MS);
    };
    dials.add(entry);
    limit = setTimeout(() => end(Object.assign(new Error(`no connection in ${CONNECT_MS / 1000} s`), { code: "ETIMEDOUT" })), CONNECT_MS);
    another();
  });
}

// An answer to a plain http request goes to the browser as the site sent
// it, for the browser's own parser to read, as it reads one it gets itself:
// Node.js's parser refused answers the browser reads, as one whose lines
// end in a bare line feed, one with both Content-Length and
// Transfer-Encoding, a header folded onto a second line, a control
// character in a value, a space before a header's colon or in its name and
// a chunk's size followed by a space, so such a page failed where 0.1.3
// took it, and a status under 100 crashed the run. Two lines are put in,
// Connection: close and Proxy-Connection: close, after the status line of
// the answer the request gets, past the informational answers (1xx) before
// it, so the browser does not send another request on that connection; one
// it sends there all the same is ended (see CARRIED), and the browser sends
// it again on a new one. The heads are read as the browser reads them
// (Chrome's HttpUtil and HttpResponseHeaders): a head's status line starts
// with HTTP, in any case, at one of its first five bytes, and ends at its
// first line feed; its code is the digits after the spaces that follow its
// first space, and with no space or no digits there it is 200; one from 100
// to 199 is informational, and its head ends where a line feed follows a
// line feed, a carriage return between them or not. So a status line with
// a line break or other bytes before HTTP, with no version, with no space
// before its code or with no code, as the browser reads them, gets the two
// lines too, where the browser sent its next request on such a connection.
// An answer with no status line at its start, or one whose status line of
// the request's own answer does not end within its first HEADERS_MAX bytes,
// goes as it came, whatever parts it comes in, where that was decided by how
// much of it had come when the reader looked: an answer whose informational
// heads ran past HEADERS_MAX got the two lines when the part that held their
// end held that line too, and went as it came when it did not, so the
// suite's test of such an answer failed now and then. closing() gives a
// reader for one answer: read(bytes) takes what came next, and gives the
// bytes to pass on once that line is found or the answer is not one to put
// it in, else null while more is needed; held() gives what it holds, for an
// answer that ended before. Each byte is read once: where the reading
// started again at the answer's first byte for each part that came, and
// made text of all that came after each informational head, a site that
// answered with a megabyte of "HTTP/1.1 100 Continue" heads held the run's
// main thread two minutes, past its --timeout and its signals.
const HTTP = Buffer.from("http");

function closing() {
  let held = Buffer.allocUnsafe(16 * 1024);
  let size = 0;
  // Where the head being read starts, where its status line starts (-1 until
  // it is found), and how far it has been read.
  let head = 0;
  let status = -1;
  let at = 0;
  // In an informational head, read to its end: whether the last byte read
  // was a line feed, or a carriage return right after one.
  let skipping = false;
  let lf = false;
  const keep = (data) => {
    if (size + data.length > held.length) {
      const bigger = Buffer.allocUnsafe(Math.max(held.length * 2, size + data.length));
      held.copy(bigger, 0, 0, size);
      held = bigger;
    }
    data.copy(held, size);
    size += data.length;
  };
  // The bytes to pass on, with the two lines put in after the line feed at
  // `after`, or as they came for -1.
  const done = (after) => {
    const bytes = held.subarray(0, size);
    if (after < 0) return bytes;
    const end = held[after - 1] === 13 ? "\r\n" : "\n";
    return Buffer.concat([bytes.subarray(0, after + 1), Buffer.from(`Connection: close${end}Proxy-Connection: close${end}`), bytes.subarray(after + 1)]);
  };
  // Where HTTP starts in the head at `head`: an offset, -1 while more bytes
  // could still show it, or -2 when it is not there.
  const start = () => {
    for (let i = 0; i <= 4 && head + i + 4 <= size; i++) {
      let same = true;
      for (let j = 0; j < 4 && same; j++) same = (held[head + i + j] | 0x20) === HTTP[j];
      if (same) return head + i;
    }
    return size - head >= 8 ? -2 : -1;
  };
  // The code of the status line from `from` to its line feed at `to`, read
  // to its first carriage return as the browser reads it.
  const codeOf = (from, to) => {
    let end = from;
    while (end < to && held[end] !== 13) end++;
    let p = from;
    while (p < end && held[p] !== 32) p++;
    if (p === end) return 200;
    while (p < end && held[p] === 32) p++;
    const digits = p;
    while (p < end && held[p] >= 48 && held[p] <= 57) p++;
    if (p === digits) return 200;
    return p - digits > 9 ? Infinity : Number(held.toString("latin1", digits, p));
  };
  const read = (data) => {
    keep(data);
    for (;;) {
      if (skipping) {
        for (; at < size; at++) {
          const byte = held[at];
          if (byte === 10 && lf) break;
          if (byte === 10) lf = true;
          else if (byte !== 13 || held[at - 1] !== 10) lf = false;
        }
        if (at >= size) return size >= HEADERS_MAX ? done(-1) : null;
        skipping = false;
        head = at + 1;
        status = -1;
      }
      if (status < 0) {
        status = start();
        if (status === -2) return done(-1);
        if (status === -1) return size >= HEADERS_MAX ? done(-1) : null;
        at = status;
      }
      const line = held.subarray(0, size).indexOf(10, at);
      if (line < 0) {
        at = size;
        return size >= HEADERS_MAX ? done(-1) : null;
      }
      const code = codeOf(status, line);
      if (code < 100 || code > 199) return done(line < HEADERS_MAX ? line : -1);
      skipping = true;
      lf = true;
      at = line + 1;
    }
  };
  return { read, held: () => held.subarray(0, size) };
}

// Starts the proxy. ruleOf(): the run's rule at the moment a request comes
// (see guardFor()), or null for a browser that opens no address of the web.
// Resolves to { port, refused, unreached, probe, saw(kind), refusalOf(),
// reachable(), close() }: refused, by host and port, why the proxy refused
// one the last time it was asked for, as said after "it is", and
// refusalOf(url) the same for the way the browser asks for url; unreached,
// by host and port, the code of the last connection to it that could not
// be made, or that was lost before the site answered; a host and port the
// proxy connects to is taken out of both, as a run can give its browser
// another rule (see launch() in chrome.js). probe: a host no lookup
// answers, and loopback, an address of this machine, the proxy's own with
// a path of its own, which the proxy answers itself, with saw(kind) saying
// whether a plain http request ("http") and a tunnel ("connect") for the
// host came, and for loopback a request sent through the proxy ("loopback")
// or one sent past it, straight to its port ("direct") (see proxySaid() in
// chrome.js). reachable(): resolves to "" once a connection of this process
// to the proxy is taken, else to the system's code for why not.
async function startProxy(ruleOf) {
  const refused = new Map();
  const unreached = new Map();
  // Why the proxy refused a host and port the last time it was asked for,
  // by the way it was asked: a plain http request ("http") or a tunnel
  // ("tunnel"), which carries https, wss and ws (see refusalOf()).
  const refusals = new Map();
  const seen = new Set();
  const probe = `${crypto.randomBytes(12).toString("hex")}.easyscreenshotkit.invalid`;
  const looped = `/${crypto.randomBytes(12).toString("hex")}`;
  const sockets = new Set();
  // The connections under way (see dial()), and whether the proxy has
  // closed, after which it dials nothing more.
  const dials = new Set();
  let closed = false;
  const keep = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A socket with no error listener throws its error at the process.
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const refuse = (authority, why, kind) => {
    refused.set(authority, why);
    refusals.set(`${kind} ${authority}`, why);
    unreached.delete(authority);
  };
  const unreach = (authority, code, kind) => {
    unreached.set(authority, code);
    refused.delete(authority);
    refusals.delete(`${kind} ${authority}`);
  };
  const reached = (authority, kind) => {
    refused.delete(authority);
    refusals.delete(`${kind} ${authority}`);
    unreached.delete(authority);
  };
  // What the rule says of an address: { why } for one it refuses, else {
  // list }, the addresses to connect to, which it judged.
  const judge = async (url) => {
    const rule = ruleOf();
    if (!rule) return { why: NO_RULE };
    const why = await rule.refuses(url.href).catch(() => NOT_WEB);
    if (why) return { why };
    try {
      return { list: await addressesBy(rule.lookupFor(url.href), url.hostname) };
    } catch (err) {
      if (err.why) return { why: err.why };
      return { error: err };
    }
  };

  // The browser's requests are read as leniently as a site's server reads
  // them (insecureHTTPParser): Node.js's own strict reading answered 400 to
  // a request whose header holds a control character or DEL, which a page's
  // fetch() may send and the site got from 0.1.3's browser. A header that
  // holds a NUL byte, which no browser sends and the lenient reading takes,
  // is refused (see below).
  const server = http.createServer({ requestTimeout: 0, maxHeaderSize: HEADERS_MAX, insecureHTTPParser: true }, (req, res) => {
    // A request on a connection that carried a site's answer, which the
    // browser was told to close (see closing()): it is ended, and the
    // browser sends the request again on a new connection.
    if (req.socket[CARRIED]) return void req.socket.destroy();
    // The loopback probe sent past the proxy: straight to its port, with the
    // address's path alone.
    if (req.url === looped) {
      seen.add("direct");
      req.resume();
      res.writeHead(204, { "access-control-allow-origin": "*", connection: "close" });
      return res.end();
    }
    let url = null;
    try {
      url = new URL(req.url);
    } catch {
      url = null;
    }
    // An answer of the proxy's own, unless the browser has gone meanwhile,
    // after which the browser sends no other request on that connection.
    const answer = (status, headers, text) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", connection: "close", ...headers });
      res.end(text);
    };
    // No answer at all, for a request the proxy does not pass on: the
    // browser's request fails as one to a site that closed its connection,
    // and the proxy's records say why (see refusalOf() and unreached). A
    // connection of the browser's to the proxy carries one request (see
    // answer() and closing()), so the browser sends none of them again on
    // another.
    const drop = () => {
      req.resume();
      req.socket.destroy();
    };
    // A request with its address written whole, over http: the browser asks
    // so for an http address and a tunnel for anything else.
    if (!url || url.protocol !== "http:") {
      req.resume();
      return answer(403, {}, "easyscreenshotkit's proxy takes plain http requests and CONNECT tunnels only.\n");
    }
    if (req.rawHeaders.some((part) => part.includes("\0"))) {
      req.resume();
      return answer(400, {}, "easyscreenshotkit's proxy takes no header with a NUL byte in it.\n");
    }
    if (url.hostname === probe || (url.hostname === "127.0.0.1" && url.port === String(server.address().port) && url.pathname === looped)) {
      seen.add(url.hostname === probe ? "http" : "loopback");
      req.resume();
      return answer(204, { "access-control-allow-origin": "*" }, "");
    }
    const authority = authorityOf(url);
    judge(url).then(
      async ({ why, list, error }) => {
        if (why) {
          refuse(authority, why, "http");
          return drop();
        }
        let socket;
        try {
          if (error) throw error;
          if (closed) throw new Error("the proxy has closed");
          socket = keep(await dial(list, url.port || "80", dials));
        } catch (err) {
          if (closed) return void res.destroy();
          unreach(authority, (err && err.code) || "ECONNREFUSED", "http");
          return drop();
        }
        reached(authority, "http");
        const client = req.socket;
        if (res.destroyed || client.destroyed || closed) return void socket.destroy();
        // The request goes on as the browser wrote it, byte for byte, its
        // path and query too (see targetOf()), with the headers that are of
        // the browser's connection to the proxy left out, the host its
        // address names, and Connection: close, so the site's connection
        // carries it alone. Node.js hands each header over as a string of
        // one character to a byte (latin1), which goes out so again: written
        // as UTF-8, every byte past ASCII went as two, so a cookie a page set
        // to "José" reached the site as "JosÃ©". A body the browser sent in
        // chunks is sent in chunks again, with no Content-Length beside it.
        const named = new Set(String(req.headers.connection || "").toLowerCase().split(",").map((one) => one.trim()).filter(Boolean));
        const chunked = /(^|,)\s*chunked\s*$/i.test(String(req.headers["transfer-encoding"] || ""));
        const lines = [`${req.method} ${targetOf(req.url, url)} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i].toLowerCase();
          if (HOP.has(name) || named.has(name) || name === "host" || (chunked && name === "content-length")) continue;
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        lines.push(`Host: ${url.host}`, ...(chunked ? ["Transfer-Encoding: chunked"] : []), "Connection: close");
        socket.write(Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"));
        req.on("data", (data) => {
          if (!socket.write(chunked ? Buffer.concat([Buffer.from(`${data.length.toString(16)}\r\n`), data, Buffer.from("\r\n")]) : data)) {
            req.pause();
            socket.once("drain", () => req.resume());
          }
        });
        req.on("end", () => chunked && socket.write("0\r\n\r\n"));
        // The site's answer goes to the browser as it came (see closing()),
        // and the browser's connection ends with the site's, as the end of
        // an answer that says nothing of its length, or the end of one that
        // never came, which the browser names as it names one it gets
        // itself. A connection that fails before the site has sent anything
        // is kept as one that could not be made, with the system's code,
        // and the browser's is closed with no answer (see drop()).
        const reader = closing();
        let passing = false;
        const pass = (bytes) => {
          passing = true;
          client[CARRIED] = true;
          if (!client.write(bytes)) {
            socket.pause();
            client.once("drain", () => socket.resume());
          }
        };
        socket.on("data", (data) => {
          if (passing) return pass(data);
          const marked = reader.read(data);
          if (marked) pass(marked);
        });
        socket.on("end", () => {
          if (!passing) pass(reader.held());
          client.end();
        });
        socket.on("error", (err) => {
          if (!passing) unreach(authority, (err && err.code) || "ECONNRESET", "http");
          client.destroy();
        });
        client.on("close", () => socket.destroy());
      },
      () => drop(),
    );
  });
  // A tunnel, to a host and port written as CONNECT asks for them.
  server.on("connect", (req, client, head) => {
    const end = (status, text) => client.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n${text ? `${text}\r\n` : ""}\r\n`);
    const parts = /^(\[[0-9A-Fa-f:.]+\]|[^\s:/?#@[\]\\]+):(\d{1,5})$/.exec(String(req.url || ""));
    let url = null;
    try {
      url = parts ? new URL(`https://${parts[1]}:${parts[2]}/`) : null;
    } catch {
      url = null;
    }
    if (!url) return end("403 Forbidden", "");
    if (url.hostname === probe) {
      seen.add("connect");
      return end("403 Forbidden", "");
    }
    const port = url.port || "443";
    const authority = `${url.hostname}:${port}`;
    judge(url).then(
      async ({ why, list, error }) => {
        if (why) {
          refuse(authority, why, "tunnel");
          return end("403 Forbidden", "");
        }
        let socket;
        try {
          if (error) throw error;
          if (closed) throw new Error("the proxy has closed");
          socket = keep(await dial(list, port, dials));
        } catch (err) {
          if (closed) return void client.destroy();
          unreach(authority, (err && err.code) || "ECONNREFUSED", "tunnel");
          return end("502 Bad Gateway", "");
        }
        reached(authority, "tunnel");
        if (client.destroyed || closed) return void socket.destroy();
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) socket.write(head);
        socket.pipe(client);
        client.pipe(socket);
        socket.on("close", () => client.destroy());
        client.on("close", () => socket.destroy());
      },
      () => end("502 Bad Gateway", ""),
    );
  });
  // A request that asks to switch the connection to another protocol over
  // plain http: the browser opens a WebSocket through a tunnel instead.
  server.on("upgrade", (req, socket) => {
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (err, socket) => {
    if (socket.writable && !socket[CARRIED]) socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  // Each connection of the browser's, a tunnel's too, is kept till it ends.
  server.on("connection", keep);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => {});
  // The run's process does not wait for it: what holds the run is its
  // browser, and the proxy goes when the browser does (see close()).
  server.unref();
  const { port } = server.address();
  return {
    port,
    refused,
    unreached,
    probe,
    loopback: `http://127.0.0.1:${port}${looped}`,
    saw: (kind) => seen.has(kind),
    // Why the proxy refused the host and port of `url` the last time it
    // was asked for it the way the browser asks for such an address: a
    // plain request for an http one and a tunnel for any other; "" when it
    // did not, or has connected there since.
    refusalOf(url) {
      const at = authorityOfUrl(url);
      return (at && refusals.get(`${/^http:/i.test(String(url)) ? "http" : "tunnel"} ${at}`)) || "";
    },
    reachable() {
      return new Promise((resolve) => {
        const socket = dialer.connect({ host: "127.0.0.1", port });
        const timer = setTimeout(() => {
          socket.destroy();
          resolve("ETIMEDOUT");
        }, 5_000);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.destroy();
          resolve("");
        });
        socket.once("error", (err) => {
          clearTimeout(timer);
          socket.destroy();
          resolve(err.code || "ECONNREFUSED");
        });
      });
    },
    // Ends the proxy and every connection of it, those under way to a
    // site's address included, which kept the run's process alive past its
    // end for as long as they took (see dial()).
    close() {
      closed = true;
      server.close();
      for (const one of [...dials]) one.stop();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

module.exports = { startProxy, dialer, closing, authorityOf, authorityOfUrl, wordsFor, NO_RULE };
