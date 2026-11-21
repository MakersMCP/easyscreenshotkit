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

// A connection that has not been made in this time is given up on.
const CONNECT_MS = 30_000;

// The most a request's or an answer's headers may hold, as a browser takes
// them: Node.js's own limit, 16 KB, refused a request with a site's cookies
// past it, and an answer whose headers held a long policy.
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

// A connection to the first of `list` that takes one, each tried in turn.
// Fails with the last one's error.
async function dialFirst(list, port) {
  let last = null;
  for (const { address, family } of list) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = dialer.connect({ host: address, port: Number(port), ...(family ? { family } : {}) });
        const timer = setTimeout(() => {
          socket.destroy();
          reject(Object.assign(new Error(`no connection in ${CONNECT_MS / 1000} s`), { code: "ETIMEDOUT" }));
        }, CONNECT_MS);
        socket.once("connect", () => {
          clearTimeout(timer);
          resolve(socket);
        });
        socket.once("error", (err) => {
          clearTimeout(timer);
          socket.destroy();
          reject(err);
        });
      });
    } catch (err) {
      last = err;
    }
  }
  throw last || Object.assign(new Error("no address"), { code: "ENOTFOUND" });
}

// Starts the proxy. ruleOf(): the run's rule at the moment a request comes
// (see guardFor()), or null for a browser that opens no address of the web.
// Resolves to { port, refused, unreached, probe, saw(kind), answeredBy(),
// reachable(), close() }: refused, by host and port, why the proxy refused
// one the last time it was asked for, as said after "it is"; unreached, by
// host and port, the code of the last connection to it that could not be
// made; a host and port the proxy connects to is taken out of both, as a
// run can give its browser another rule (see launch() in chrome.js). probe:
// a host no lookup answers, and loopback, an address of this machine, the
// proxy's own with a path of its own, which the proxy answers itself, with
// saw(kind) saying whether a plain http request ("http") and a tunnel
// ("connect") for the host came, and for loopback a request sent through
// the proxy ("loopback") or one sent past it, straight to its port
// ("direct") (see proxySaid() in chrome.js). answeredBy(headers): for the
// headers of an answer, { why } for a refusal of the proxy's own, { code }
// for a connection it could not make, or null. reachable(): resolves to ""
// once a connection of this process to the proxy is taken, else to the
// system's code for why not.
async function startProxy(ruleOf) {
  const refused = new Map();
  const unreached = new Map();
  const seen = new Set();
  const probe = `${crypto.randomBytes(12).toString("hex")}.easyscreenshotkit.invalid`;
  const looped = `/${crypto.randomBytes(12).toString("hex")}`;
  const secret = crypto.randomBytes(12).toString("hex");
  const sockets = new Set();
  const keep = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    // A socket with no error listener throws its error at the process.
    socket.on("error", () => socket.destroy());
    return socket;
  };
  const refuse = (authority, why) => {
    refused.set(authority, why);
    unreached.delete(authority);
  };
  const unreach = (authority, code) => {
    unreached.set(authority, code);
    refused.delete(authority);
  };
  const reached = (authority) => {
    refused.delete(authority);
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
          refuse(authority, why);
          req.resume();
          return answer(403, { [REFUSED_HEADER]: `${secret} ${encodeURIComponent(why)}` }, `easyscreenshotkit did not reach ${authority}: it is ${why}.\n`);
        }
        let socket;
        try {
          if (error) throw error;
          socket = keep(await dialFirst(list, url.port || "80"));
        } catch (err) {
          const code = (err && err.code) || "ECONNREFUSED";
          unreach(authority, code);
          req.resume();
          return answer(502, { [UNREACHED_HEADER]: `${secret} ${code}` }, `easyscreenshotkit could not connect to ${authority} (${code}).\n`);
        }
        reached(authority);
        if (res.destroyed) return socket.destroy();
        // The request goes on as the browser wrote it, with the headers that
        // are of the browser's connection to the proxy left out, and the
        // host its address names.
        const headers = [];
        const named = new Set(String(req.headers.connection || "").toLowerCase().split(",").map((one) => one.trim()).filter(Boolean));
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i].toLowerCase();
          if (HOP.has(name) || named.has(name) || name === "host") continue;
          headers.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
        }
        headers.push("Host", url.host);
        const upstream = http.request({ method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false, maxHeaderSize: HEADERS_MAX, createConnection: () => socket });
        upstream.on("response", (answered) => {
          const back = [];
          for (let i = 0; i < answered.rawHeaders.length; i += 2) {
            if (!HOP.has(answered.rawHeaders[i].toLowerCase())) back.push(answered.rawHeaders[i], answered.rawHeaders[i + 1]);
          }
          res.writeHead(answered.statusCode, answered.statusMessage, back);
          answered.pipe(res);
          answered.on("error", () => res.destroy());
        });
        // A connection the site closed before it answered, as the browser
        // says of one it makes itself.
        upstream.on("error", (err) => {
          if (!res.headersSent) answer(502, { [UNREACHED_HEADER]: `${secret} ${(err && err.code) || "ECONNRESET"}` }, `easyscreenshotkit lost the connection to ${authority}.\n`);
          else res.destroy();
        });
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
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
          refuse(authority, why);
          return end("403 Forbidden", "");
        }
        let socket;
        try {
          if (error) throw error;
          socket = keep(await dialFirst(list, port));
        } catch (err) {
          unreach(authority, (err && err.code) || "ECONNREFUSED");
          return end("502 Bad Gateway", "");
        }
        reached(authority);
        if (client.destroyed) return socket.destroy();
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
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
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
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

module.exports = { startProxy, dialer, authorityOf, authorityOfUrl, wordsFor, NO_RULE, REFUSED_HEADER, UNREACHED_HEADER };
