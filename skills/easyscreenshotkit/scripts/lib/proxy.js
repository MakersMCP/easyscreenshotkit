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
// else is answered 403 and recorded, with the address and the reason.
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
// connected in STAGGER_MS has the next one tried beside it (see dial()).
const CONNECT_MS = 30_000;
const STAGGER_MS = 250;

// The most a request's headers may hold, as a browser takes them: Node.js's
// own limit, 16 KB, refused a request with a site's cookies past it. The
// most the first lines of an answer may hold before the proxy stops looking
// for the end of its status line (see closing()).
const HEADERS_MAX = 256 * 1024;

// The headers that are of one connection and not passed on (RFC 9110).
const HOP = new Set(["connection", "proxy-connection", "keep-alive", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"]);

// The headers that tell what the proxy answered for itself: a refusal, with
// the reason as it is said after "it is", and a connection that could not
// be made, or was lost before an answer came, with the system's code. Each
// value starts with the proxy's secret, a word of its own made as it starts
// (see answeredBy()), so a site that sends such a header itself is not
// taken for the proxy.
const REFUSED_HEADER = "x-easyscreenshotkit-refused";
const UNREACHED_HEADER = "x-easyscreenshotkit-unreached";

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
// than once, is tried once. All of it is given up CONNECT_MS after it
// began. Each dial is kept in `dials` while it goes, so that the proxy's
// close() ends it: its connections under way are ended, its timers
// cleared, and no other address is tried. Tried one after another with 30 s
// each, a picture on a host whose four addresses did not answer kept the
// run's process alive two minutes after it had saved, and longer where the
// resolver gave each address five times. Fails with the last error.
function dial(list, port, dials) {
  const seen = new Set();
  const addresses = list.filter(({ address }) => !seen.has(address) && seen.add(address));
  return new Promise((resolve, reject) => {
    const tries = new Set();
    let next = 0;
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
      for (const one of tries) if (one !== socket) one.destroy();
      tries.clear();
      if (err) reject(err);
      else resolve(socket);
    };
    const entry = { stop: () => end(Object.assign(new Error("the proxy has closed"), { code: "ECONNABORTED" })) };
    const another = () => {
      clearTimeout(stagger);
      if (over) return;
      if (next >= addresses.length) {
        if (!tries.size) end(last || Object.assign(new Error("no address"), { code: "ENOTFOUND" }));
        return;
      }
      const { address, family } = addresses[next++];
      let socket;
      try {
        socket = dialer.connect({ host: address, port: Number(port), ...(family ? { family } : {}) });
      } catch (err) {
        // A port or an address the system will not connect to at all.
        last = err;
        return another();
      }
      tries.add(socket);
      socket.once("connect", () => end(null, socket));
      // Kept for the socket's life: an error with no listener is thrown at
      // the process.
      socket.on("error", (err) => {
        socket.destroy();
        if (over || !tries.delete(socket)) return;
        last = err;
        another();
      });
      stagger = setTimeout(another, STAGGER_MS);
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
// took it, and a status under 100 crashed the run. Only Connection: close
// is put in, after the status line of the answer the request gets, past any
// informational answer (1xx) before it, so the browser opens a new
// connection for its next request: a site that kept its connection open
// past the answer could have had the browser read what it sent later as the
// answer to another request of the browser's, for another site. closing()
// resolves the bytes of an answer so far to { bytes, done }: done once that
// line is in, or once the answer is not one to put it in (no status line
// at its start, or one HEADERS_MAX long and still not ended); null while
// more is needed.
function closing(bytes) {
  let at = 0;
  for (;;) {
    const line = bytes.indexOf(10, at);
    if (line < 0) return bytes.length - at > HEADERS_MAX ? { bytes, done: true } : null;
    const status = /^HTTP\/\d+(\.\d+)?[ \t]+(\d{3})/i.exec(bytes.subarray(at, line).toString("latin1"));
    if (!status) return { bytes, done: true };
    if (status[2].startsWith("1") && status[2] !== "101") {
      // An informational answer, a head of its own and no body: the one
      // that follows its empty line is the request's. The search starts at
      // the status line's own line end, for a head with no header.
      const empty = /\r?\n\r?\n/.exec(bytes.subarray(line - 1).toString("latin1"));
      if (!empty) return bytes.length - at > HEADERS_MAX ? { bytes, done: true } : null;
      at = line - 1 + empty.index + empty[0].length;
      continue;
    }
    const end = bytes[line - 1] === 13 ? "\r\n" : "\n";
    return { bytes: Buffer.concat([bytes.subarray(0, line + 1), Buffer.from(`Connection: close${end}Proxy-Connection: close${end}`), bytes.subarray(line + 1)]), done: true };
  }
}

// Starts the proxy. ruleOf(): the run's rule at the moment a request comes
// (see guardFor()), or null for a browser that opens no address of the web.
// Resolves to { port, refused, unreached, probe, saw(kind), refusalOf(),
// answeredBy(), reachable(), close() }: refused, by host and port, why the
// proxy refused one the last time it was asked for, as said after "it is",
// and refusalOf(url) the same for the way the browser asks for url;
// unreached, by host and port, the code of the last connection to it that
// could not be made; a host and port the proxy connects to is taken out of
// both, as a run can give its browser another rule (see launch() in
// chrome.js). probe: a host no lookup answers, and loopback, an address of
// this machine, the proxy's own with a path of its own, which the proxy
// answers itself, with saw(kind) saying whether a plain http request
// ("http") and a tunnel ("connect") for the host came, and for loopback a
// request sent through the proxy ("loopback") or one sent past it, straight
// to its port ("direct") (see proxySaid() in chrome.js).
// answeredBy(headers): for the headers of an answer, { why } for a refusal
// of the proxy's own, { code } for a connection it could not make, or null.
// reachable(): resolves to "" once a connection of this process to the
// proxy is taken, else to the system's code for why not.
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
  const secret = crypto.randomBytes(12).toString("hex");
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

  const server = http.createServer({ requestTimeout: 0, maxHeaderSize: HEADERS_MAX }, (req, res) => {
    // A request on a connection that carried a site's answer, which the
    // browser was told to close (see closing()): it is ended, and the
    // browser sends the request again on a new connection.
    if (req.socket[CARRIED]) return void req.socket.destroy();
    // The loopback probe sent past the proxy: straight to its port, with the
    // address's path alone.
    if (req.url === looped) {
      seen.add("direct");
      req.resume();
      res.writeHead(204, { "access-control-allow-origin": "*" });
      return res.end();
    }
    let url = null;
    try {
      url = new URL(req.url);
    } catch {
      url = null;
    }
    // An answer of the proxy's own, unless the browser has gone meanwhile.
    const answer = (status, headers, text) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
      res.end(text);
    };
    // A request with its address written whole, over http: the browser asks
    // so for an http address and a tunnel for anything else.
    if (!url || url.protocol !== "http:") {
      req.resume();
      return answer(403, {}, "easyscreenshotkit's proxy takes plain http requests and CONNECT tunnels only.\n");
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
          req.resume();
          return answer(403, { [REFUSED_HEADER]: `${secret} ${encodeURIComponent(why)}` }, `easyscreenshotkit did not reach ${authority}: it is ${why}.\n`);
        }
        let socket;
        try {
          if (error) throw error;
          if (closed) throw new Error("the proxy has closed");
          socket = keep(await dial(list, url.port || "80", dials));
        } catch (err) {
          if (closed) return void res.destroy();
          const code = (err && err.code) || "ECONNREFUSED";
          unreach(authority, code, "http");
          req.resume();
          return answer(502, { [UNREACHED_HEADER]: `${secret} ${code}` }, `easyscreenshotkit could not connect to ${authority} (${code}).\n`);
        }
        reached(authority, "http");
        const client = req.socket;
        if (res.destroyed || client.destroyed || closed) return void socket.destroy();
        // The request goes on as the browser wrote it, with the headers that
        // are of the browser's connection to the proxy left out, the host
        // its address names, and Connection: close, so the site's
        // connection carries it alone. A body the browser sent in chunks is
        // sent in chunks again.
        const named = new Set(String(req.headers.connection || "").toLowerCase().split(",").map((one) => one.trim()).filter(Boolean));
        const lines = [`${req.method} ${url.pathname}${url.search} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i].toLowerCase();
          if (HOP.has(name) || named.has(name) || name === "host") continue;
          lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        }
        const chunked = /(^|,)\s*chunked\s*$/i.test(String(req.headers["transfer-encoding"] || ""));
        lines.push(`Host: ${url.host}`, ...(chunked ? ["Transfer-Encoding: chunked"] : []), "Connection: close");
        socket.write(`${lines.join("\r\n")}\r\n\r\n`);
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
        // is answered as lost, in the words the browser gives one it makes
        // itself.
        let head = Buffer.alloc(0);
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
          head = Buffer.concat([head, data]);
          const marked = closing(head);
          if (marked) pass(marked.bytes);
        });
        socket.on("end", () => {
          if (!passing) pass(head);
          client.end();
        });
        socket.on("error", (err) => {
          if (passing) return void client.destroy();
          answer(502, { [UNREACHED_HEADER]: `${secret} ${(err && err.code) || "ECONNRESET"}` }, `easyscreenshotkit lost the connection to ${authority}.\n`);
        });
        client.on("close", () => socket.destroy());
      },
      () => answer(502, {}, "easyscreenshotkit's proxy failed.\n"),
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
    answeredBy(headers = []) {
      const named = (name) => (headers.find((header) => String(header.name).toLowerCase() === name) || {}).value || "";
      const [refusal, failure] = [named(REFUSED_HEADER), named(UNREACHED_HEADER)].map((value) => (String(value).startsWith(`${secret} `) ? String(value).slice(secret.length + 1) : ""));
      if (refusal) {
        try {
          return { why: decodeURIComponent(refusal) };
        } catch {
          return { why: NOT_WEB };
        }
      }
      return failure ? { code: failure } : null;
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

module.exports = { startProxy, dialer, authorityOf, authorityOfUrl, wordsFor, NO_RULE, REFUSED_HEADER, UNREACHED_HEADER };
