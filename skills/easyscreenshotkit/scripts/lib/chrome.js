"use strict";

// The browser: a Chrome, Chromium, Edge or Brave already on this machine,
// started headless with a throwaway profile and driven over the DevTools
// protocol on a pipe, the two file descriptors it is started with, so it
// opens no port: no other program on the machine can reach it, and a page
// cannot either. Nothing is downloaded. Finding, starting and closing the
// browser come from easybrandkit 0.2.1; every page here opens in a window of
// its own, set up as the device it is captured on.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { timeLeft, sleep } = require("./time");
const { NOT_WEB } = require("./address");
const programs = require("./programs");

const MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const LINUX = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WINDOWS = [
  ["PROGRAMFILES", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Google\\Chrome\\Application\\chrome.exe"],
  ["LOCALAPPDATA", "Google\\Chrome\\Application\\chrome.exe"],
  ["PROGRAMFILES(X86)", "Microsoft\\Edge\\Application\\msedge.exe"],
  ["PROGRAMFILES", "Microsoft\\Edge\\Application\\msedge.exe"],
];

// What a run says when it finds no browser at all, and the first words of
// what it says of one it found that is no program this user may run.
const NO_BROWSER = "No Chrome, Chromium, Edge or Brave found";
const MISSING = `${NO_BROWSER}. Install one, or point CHROME_PATH at its binary.`;

// How to get a browser that runs, for one CHROME_PATH names and for one
// found on the machine.
const FIX = {
  CHROME_PATH: "Point CHROME_PATH at the program of a browser that runs, or unset it to use one installed on this machine.",
  found: "Install Chrome, Chromium, Edge or Brave, or point CHROME_PATH at one that runs.",
};

// Where this run's browser is: { name, file, variable, value, where, fix,
// problem } (see programs.js), or null where there is none. CHROME_PATH is
// a path, taken from the folder the run starts in, or a name looked up on
// PATH, as a shell would. Else where macOS and Windows install a browser,
// and on Linux each of its names on PATH: the first program this user may
// run, or else the first thing by such a name, as a folder or a file that
// may not be run, to say what is wrong with it. A CHROME_PATH that names the
// browser the run finds with it unset, as one a tool sets to what it found
// does, is told to install another: unset, it gives the same one.
function browserPlace() {
  const named = programs.named("CHROME_PATH", { name: "browser", fix: FIX.CHROME_PATH });
  return named ? programs.orInstall(named, installed(), FIX.found) : installed();
}

// The browser the run finds with CHROME_PATH unset.
function installed() {
  const listed = (file) => programs.found(file, { name: path.basename(file), where: "installed on this machine", fix: FIX.found });
  if (process.platform === "darwin") {
    const file = MAC.find((at) => fs.existsSync(at));
    return file ? listed(file) : null;
  }
  if (process.platform === "win32") {
    for (const [root, rest] of WINDOWS) {
      const file = process.env[root] ? path.join(process.env[root], rest) : "";
      if (file && fs.existsSync(file)) return listed(file);
    }
    return null;
  }
  let other = null;
  for (const name of LINUX) {
    const seen = programs.lookOnPath(name);
    if (seen.file) return programs.found(seen.file, { name, where: "on PATH", fix: FIX.found });
    if (!other && seen.other) other = programs.found(seen.other, { name, where: "on PATH", fix: FIX.found });
  }
  return other;
}

// The browser to start, or "" where there is none this user may run.
function findChrome() {
  const place = browserPlace();
  return place && !place.problem ? place.file : "";
}

// Why there is no browser to start, as a run says it before any work, or
// "": none at all, or what CHROME_PATH or the browser found names, and what
// keeps that from being a program this user may run, as a folder, a link
// to nothing or a file without the permission to run it. Whether one that
// passes starts, only starting it shows (see launch()).
function browserProblem() {
  const place = browserPlace();
  if (!place) return MISSING;
  return place.problem ? `${NO_BROWSER}: ${programs.told(place, place.problem)}` : "";
}

const onPath = programs.onPath;

// What a call to a tab whose page crashed fails with.
const CRASHED = "the browser's tab crashed";

// A browser asked for its version answers at once while it runs, whatever
// its pages are doing. A call that has had no answer for SLOW_MS, or whose
// time ran out, has the browser asked (see start()), and one that gives no
// answer to that in PROBE_MS either has stopped answering.
const SLOW_MS = 15_000;
const PROBE_MS = 10_000;
// What a call fails with once the browser has stopped answering.
const STALLED = "The browser stopped answering.";

// What a call fails with once the connection it went on has closed.
const CLOSED = "The browser connection closed.";

// The largest message the browser can send that is read: one past it fails
// the call it answers, as a string that long cannot be made of it.
const MESSAGE_MAX = 256 * 1024 * 1024;

// The DevTools protocol on the pipe a browser was started with: it reads
// each call from file descriptor 3 and writes each answer and event on 4,
// each one JSON ended by a NUL byte. The browser itself answers on this
// connection; a window's tab answers in a session of it (see session()), as
// it does on a connection of its own over a WebSocket.
//
// onClose: called once the pipe has closed, as it does when the browser
// ends. over: settled once no answer can come any more, as the pipe closed
// or fail() was called. A call that gets no answer in its time fails with
// timedOut set, and cut when the run's time made that time shorter than the
// call asked for, and one the browser answers with an error with answered
// set.
// A call's time is what it asks for within what the run has left, a second
// at least, or with fixed what it asks for whatever the run has left. watch:
// asks whether the browser still answers (see start()), once a call has had
// no answer for SLOW_MS, and again when a call's time runs out, and
// resolves to the error a call fails with when it does not, or to null; the
// call that asked fails with that error at once. A call sent with watched
// false is not watched. A call sent with until, a promise, is let go of
// once that settles before its answer came: it resolves to { unanswered:
// true }, and its answer, should it come later, finds no one waiting (see
// sendInput()).
function pipeTo(child, { onClose = () => {}, watch = null } = {}) {
  // A program that could not be started has no pipe: every call fails.
  const none = { on() {}, write() {}, end() {}, destroyed: true, writable: false };
  const input = (child.stdio && child.stdio[3]) || none;
  const output = (child.stdio && child.stdio[4]) || none;
  const pending = new Map();
  const listeners = new Map();
  // The sessions of the windows' tabs, by their id.
  const sessions = new Map();
  let nextId = 0;
  // Set by fail(): every call goes on failing with it.
  let failure = "";
  let shut = false;
  let ended;
  const over = new Promise((settle) => (ended = settle));

  const settle = (waiter) => {
    clearTimeout(waiter.timer);
    clearTimeout(waiter.slow);
  };
  // Ends a session: each of its calls under way fails with message.
  const endSession = (state, message) => {
    if (state.done) return;
    state.done = message;
    for (const [id, waiter] of pending) {
      if (waiter.session !== state) continue;
      pending.delete(id);
      settle(waiter);
      waiter.reject(new Error(message));
    }
    sessions.delete(state.id);
    state.ended();
  };
  const dispatch = (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.method) {
      const state = msg.sessionId ? sessions.get(msg.sessionId) : null;
      if (msg.sessionId && !state) return;
      for (const listener of (state ? state.listeners : listeners).get(msg.method) || []) listener(msg.params || {});
      // A tab whose window closed, or that crashed and went, answers no
      // more: its calls fail at once, as on a connection that closed.
      if (!msg.sessionId && msg.method === "Target.detachedFromTarget") {
        const gone = sessions.get((msg.params || {}).sessionId);
        if (gone) endSession(gone, CLOSED);
      }
      return;
    }
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    settle(waiter);
    if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message || "DevTools protocol error"), { answered: true }));
    else waiter.resolve(msg.result || {});
  };
  // A message comes in parts: they are kept until its NUL, and one longer
  // than MESSAGE_MAX is let go of, failing the call it answers, whose id
  // is at its start.
  let parts = [];
  let size = 0;
  let head = "";
  const take = () => {
    if (size > MESSAGE_MAX) {
      const id = Number((/^\{"id":(\d+)/.exec(head) || [])[1]);
      const waiter = pending.get(id);
      if (waiter) {
        pending.delete(id);
        settle(waiter);
        waiter.reject(new Error(`The browser's answer to ${waiter.method} is over ${MESSAGE_MAX / 1024 / 1024} MB, too large to read.`));
      }
      return;
    }
    let msg = null;
    try {
      msg = JSON.parse(Buffer.concat(parts, size).toString("utf8"));
    } catch {
      return;
    }
    dispatch(msg);
  };
  output.on("data", (chunk) => {
    let from = 0;
    let at;
    while ((at = chunk.indexOf(0, from)) !== -1) {
      const piece = chunk.subarray(from, at);
      if (!size) head = piece.subarray(0, 32).toString("latin1");
      size += piece.length;
      if (size <= MESSAGE_MAX) parts.push(piece);
      take();
      parts = [];
      size = 0;
      from = at + 1;
    }
    if (from < chunk.length) {
      const piece = chunk.subarray(from);
      if (!size) head = piece.subarray(0, 32).toString("latin1");
      size += piece.length;
      if (size <= MESSAGE_MAX) parts.push(piece);
      else parts = [];
    }
  });
  const closeAll = () => {
    if (shut) return;
    shut = true;
    for (const waiter of pending.values()) {
      settle(waiter);
      waiter.reject(new Error(CLOSED));
    }
    pending.clear();
    for (const state of [...sessions.values()]) endSession(state, CLOSED);
    ended();
    onClose();
  };
  output.on("end", closeAll);
  output.on("close", closeAll);
  output.on("error", closeAll);
  input.on("error", () => {});
  // A browser that ended answers no more, though a process it left can hold
  // the pipe open, as one a wrapper script starts beside it does: what it
  // sent before it ended is read first.
  child.once("exit", () => setImmediate(closeAll));
  if (output === none) closeAll();

  const call = (method, params, timeoutMs, { fixed = false, watched = true, until = null } = {}, state = null) => {
    // A call on a connection that is closed, or a session that ended, would
    // get no answer and wait out its whole time limit: it fails at once.
    if (failure) return Promise.reject(new Error(failure));
    if (state && state.done) return Promise.reject(new Error(state.done));
    if (shut || input.destroyed || !input.writable) return Promise.reject(new Error(CLOSED));
    const id = ++nextId;
    const ask = watched && watch;
    return new Promise((res, rej) => {
      const limit = fixed ? Math.max(1, timeoutMs) : Math.max(1_000, Math.min(timeoutMs, timeLeft()));
      // A browser that stopped answering is found while a long call waits,
      // not at the end of its wait, and the call fails with that at once.
      const slow =
        ask && limit > SLOW_MS
          ? setTimeout(async () => {
              const lost = await ask();
              if (!lost || !pending.has(id)) return;
              pending.delete(id);
              clearTimeout(timer);
              rej(lost);
            }, SLOW_MS)
          : null;
      const timer = setTimeout(async () => {
        pending.delete(id);
        clearTimeout(slow);
        const lost = ask ? await ask() : null;
        rej(lost || Object.assign(new Error(`${method} timed out`), { timedOut: true, cut: !fixed && limit < timeoutMs }));
      }, limit);
      pending.set(id, { resolve: res, reject: rej, timer, slow, method, session: state });
      if (until) {
        until.then(() => {
          const waiter = pending.get(id);
          if (!waiter) return;
          pending.delete(id);
          settle(waiter);
          res({ unanswered: true });
        });
      }
      input.write(`${JSON.stringify({ id, method, params, ...(state ? { sessionId: state.id } : {}) })}\0`);
    });
  };
  const subscribe = (map) => ({
    on(method, listener) {
      map.set(method, [...(map.get(method) || []), listener]);
    },
    off(method, listener) {
      map.set(method, (map.get(method) || []).filter((known) => known !== listener));
    },
  });

  return {
    over,
    send: (method, params = {}, timeoutMs = 30_000, options = {}) => call(method, params, timeoutMs, options),
    ...subscribe(listeners),
    close() {
      input.end();
    },
    closed() {
      return Boolean(failure) || shut;
    },
    // Fails every call under way and every call to come with message, on
    // this connection and in each session of it.
    fail(message) {
      failure = message;
      for (const waiter of pending.values()) {
        settle(waiter);
        waiter.reject(new Error(message));
      }
      pending.clear();
      for (const state of [...sessions.values()]) endSession(state, message);
      ended();
    },
    // A tab's session, once the browser attached the connection to it
    // (Target.attachToTarget with flatten): its calls, its events, and an
    // end of its own, with the same calls a connection has. close() ends it
    // here; the tab is closed with Target.closeTarget.
    session(id) {
      const state = { id, listeners: new Map(), done: "", ended: null };
      const ending = new Promise((done) => (state.ended = done));
      sessions.set(id, state);
      return {
        over: Promise.race([ending, over]),
        send: (method, params = {}, timeoutMs = 30_000, options = {}) => call(method, params, timeoutMs, options, state),
        ...subscribe(state.listeners),
        // An event of the kit's own for this tab (see openTab).
        emit(method, params) {
          for (const listener of state.listeners.get(method) || []) listener(params);
        },
        close() {
          endSession(state, CLOSED);
        },
        closed() {
          return Boolean(failure) || shut || Boolean(state.done);
        },
        fail(message) {
          endSession(state, message);
        },
      };
    },
  };
}

// The browsers this process has started and not closed yet, each with its
// profile, from the moment it is spawned.
const open = new Set();

// --use-mock-keychain and --password-store=basic keep Chrome on macOS from
// asking for the login keychain, which it does for a fresh profile. The
// profile is a temp folder, removed when the browser has ended. On Linux the
// browser's crash reports go in it too (see configIn), and it still uses the
// certificate database in the home (NSS), so a local certificate authority,
// such as mkcert's, still counts.
// Windows in the background keep drawing (the three --disable-*background*
// flags), so a page waiting its turn is not left half loaded, and colors are
// written in sRGB whatever the machine's display. args: more switches for
// this run (a demo draws its pages at a higher pixel density).
async function launch({ lang = "", args = [] } = {}) {
  const problem = browserProblem();
  if (problem) throw new Error(problem);
  const place = programs.remember(browserPlace());
  const binary = place.file;
  const name = path.basename(binary);
  // A browser whose lock has a longer name than room was left for in its
  // profile (see roomIn) does not start there: it starts again with the
  // temp folder as its own.
  const wait = startWait();
  let tried = await start(binary, { lang, args, own: true, wait: wait.ms });
  if (tried.tooDeep && tried.own) tried = await start(binary, { lang, args, own: false, wait: wait.ms });
  if (tried.chrome) return tried.chrome;
  // A program that could not be started, as one whose loader or a library
  // it needs is missing, or one for another system: what is wrong with it.
  if (tried.unstarted) throw new Error(`${name} did not start: ${tried.unstarted}`);
  if (tried.unguarded) throw new Error(`${name} was not started: it hands addresses such as mailto: to programs of this machine, and none could be put in their place, as ${tried.unguarded}.`);
  if (tried.refused) throw new Error(`${name} cannot be told to refuse the downloads a page starts (${tried.refused}), so it was not used: a site could save files on this machine through it. Point CHROME_PATH at another browser.`);
  if (tried.tooDeep) throw new Error(`${name} did not start: the temp folder's path, ${os.tmpdir()}, is too long for the socket it opens there. Point TMPDIR at a folder with a shorter path.`);
  const free = freeInTemp();
  if (free !== null && free < TEMP_NEEDED) throw new Error(`${name} did not start: the temp folder, ${os.tmpdir()}, has only ${Math.round(free / 1024)} KB free. Free some space there, or point TMPDIR at another disk.`);
  if (tried.silent) throw new Error(`${name} started but did not answer in ${Math.round(wait.ms / 1000)} s. ${busy(wait.cut)}`);
  const said = saidWhy(tried.said);
  if (said) throw new Error(`${name} did not start: ${said}`);
  throw new Error(`${name} did not start. Try again, or point CHROME_PATH at another browser.`);
}

// What a browser that ended before it answered printed, in Chrome's own
// words, of why, when trying again or another browser would not help, with
// what to do: it was not handed the kit's pipe, as by a program that
// CHROME_PATH names and that starts the browser with its file descriptors 3
// and 4 closed, which 0.1.1 did not need as it read a port; its sandbox
// could not start, as in a container that does not let it, for a user who
// is not root; it could not make the lock of its profile, a symbolic link,
// as on a disk that takes none; it, or the system, had as many files open
// as they may; or the system started no more processes or threads for it.
// And what the loader or the shell printed of a program that a launcher
// script starts, as google-chrome on PATH is one on Linux, that needs a
// library the machine lacks or is made for another system: only a program
// started itself is looked at more closely (see notRun()). Each was said to
// be a browser that did not start, with the advice to try again.
const SAID = [
  [/Remote debugging pipe file descriptors are not open/, "A program that starts the browser has to hand it easyscreenshotkit's pipe, its file descriptors 3 and 4: point CHROME_PATH at the browser's own program, or at one that hands those on."],
  [/No usable sandbox|SUID sandbox helper binary was found, but is not configured correctly|setuid sandbox: failed to move to new namespaces|Failed to move to new namespace/, "Its sandbox could not start: on Linux a browser's own package sets the sandbox up, and a container has to let it start, as Docker does with --security-opt seccomp=unconfined."],
  [/Failed to create .*SingletonLock|Failed to create a ProcessSingleton/, "The lock of the browser's profile, a symbolic link in the temp folder, could not be made: point TMPDIR at a folder on another disk, one that takes symbolic links."],
  [/Too many open files in system/, "The system had as many files open as it may: run fewer jobs at once."],
  [/Too many open files/, "The browser had as many files open as it may: raise that limit, as ulimit -n does, and run again."],
  [/Resource temporarily unavailable/, "The system started no more processes or threads for this user: run fewer jobs at once, or raise that limit (ulimit -u, or a container's pids limit)."],
  [/error while loading shared libraries|cannot execute binary file|Exec format error/, "A library the browser needs is missing, or it is made for another system: reinstall it with its package manager, or point CHROME_PATH at one that runs."],
];

// The line of what the browser printed that holds words of SAID, quoted
// without the place in Chrome's code it starts with, cut to about 200
// characters and its control characters written out, and what to do: "" for
// one that printed none. That place can be cut short too, as what is kept of
// what the browser printed starts in the middle of a line when it printed
// much, as a browser short of threads does from each of its processes.
function saidWhy(output) {
  const lines = String(output || "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const [words, fix] of SAID) {
    const line = lines.find((one) => words.test(one));
    if (!line) continue;
    const bare = line.replace(/^\[?[^\]\s]*\]\s*/, "");
    const cut = bare.length > 200 ? `${bare.slice(0, 200)}...` : bare;
    return `it printed "${cut.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)}". ${fix}`;
  }
  return "";
}

// A browser that started has START_MS to answer, or up to START_MAX_MS when
// the run has the time, keeping AFTER_START_MS of it for its first page: on
// a busy machine a browser can take long to answer. cut: whether the run's
// time made the wait shorter than START_MAX_MS.
const START_MS = 20_000;
const START_MAX_MS = 60_000;
const AFTER_START_MS = 15_000;

function startWait() {
  const room = timeLeft() - AFTER_START_MS;
  return { ms: Math.max(START_MS, Math.min(START_MAX_MS, room)), cut: room < START_MAX_MS };
}

// A window has up to WINDOW_MS to open and a page up to ANSWER_MS to answer,
// within what the run has left. cut: whether the run's time made the wait
// shorter.
const WINDOW_MS = 60_000;
const ANSWER_MS = 60_000;

function waitOf(most) {
  const left = timeLeft();
  return { ms: Math.max(1_000, Math.min(most, left)), cut: left < most };
}

// What to do about a browser or a page that did not answer in time.
const busy = (cut) => `The machine may be too busy: try again${cut ? ", or give the run more time with --timeout" : ""}.`;

// With less than this free in the temp folder, which holds its profile, a
// browser that did not start is told so: with more, disk space is not why.
const TEMP_NEEDED = 5 * 1024 * 1024;

// The bytes free in the temp folder, or null where that cannot be told.
function freeInTemp() {
  try {
    const { bavail, bsize } = fs.statfsSync(os.tmpdir());
    return bavail * bsize;
  } catch {
    return null;
  }
}

// Starts the browser once. On Linux, with own, its profile is its temp
// folder too, when there is room for its lock's socket there: the browser
// makes its lock in its temp folder, and in its first seconds a folder for
// what it downloads for itself, which it leaves behind when it quits or is
// killed before the download has ended. Both go with the profile then.
// wait: how long it has to answer, its version and the order to refuse
// downloads both within it. Returns {chrome} once it answers, else {own,
// tooDeep, silent, refused}: whether its profile was its temp folder,
// whether it ended because its lock's socket did not fit in that folder,
// whether it was still running without an answer when the wait ran out,
// and the error it answered the order to refuse downloads with. A profile
// that cannot be made, as in a temp folder this user cannot write in, and a
// program the system will not start, as one another process has open for
// writing or with no memory left to start it, which Node throws where it
// does not say so in an error event, are said in unstarted, in place of
// Node's bare words, and the profile goes.
async function start(binary, { lang, args, own, wait = START_MS }) {
  let profile;
  try {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-chrome-"));
  } catch (err) {
    return { unstarted: `the temp folder, ${os.tmpdir()}, cannot be written (${programs.worded(err)}). Point TMPDIR at a folder this user can write to.` };
  }
  // No program of the machine opens what the browser hands out (see
  // standIns): a browser that could not be kept from it is not started.
  const apart = process.platform === "linux" ? standIns(profile) : {};
  if (apart.problem) {
    removeProfile(profile);
    return { unguarded: apart.problem };
  }
  const inProfile = own && process.platform === "linux" && roomIn(profile);
  const locksBefore = lockFolders();
  // In the temp folder, the folders the browser may leave there (see
  // removeFetchFolders); none, in a profile that is its temp folder too.
  const fetching = inProfile ? null : fetchFolders();
  // The protocol goes over a pipe, file descriptors 3 and 4, and not over a
  // port: a port on 127.0.0.1 is open to every program on the machine, and
  // through it to every job of a service that runs this kit for many
  // people, which could read and drive the pages of another job's browser.
  let child;
  try {
    child = spawn(
      binary,
      [
        "--headless=new",
        "--remote-debugging-pipe",
        `--user-data-dir=${profile}`,
        "--window-size=1600,900",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--force-color-profile=srgb",
        "--use-mock-keychain",
        "--password-store=basic",
        ...(lang ? [`--lang=${lang}`] : []),
        ...args,
        // Chrome refuses to start as root without it (a container, a CI box).
        ...(process.getuid && process.getuid() === 0 ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], env: browserEnv(profile, { ...configIn(profile), ...(inProfile ? { TMPDIR: profile } : {}), ...apart }) },
    );
  } catch (err) {
    removeProfile(profile);
    return { unstarted: whyUnstarted(binary, err) };
  }
  let exited = false;
  // Whether the browser ended, or its connection closed, before close()
  // asked it to quit: it crashed, or something outside the run killed it,
  // and every page and window the run had still to take went with it. Or
  // it stopped answering (stalled): see watch.
  let lost = false;
  let stalled = false;
  let closing = false;
  // What it said last, and the error a program that could not be started
  // at all gave: what is wrong with one that did not start.
  let failed = null;
  let said = "";
  child.on("exit", () => {
    exited = true;
    if (!closing) lost = true;
  });
  child.on("error", (err) => {
    exited = true;
    failed = failed || err;
  });
  // Read on, so the browser is never held writing to it.
  if (child.stderr) child.stderr.on("data", (d) => (said = (said + d).slice(-8_000)));
  // lock: its lock folder, read once it answers (see lockFolderOf).
  const started = { child, profile, lock: "", fetching };
  open.add(started);
  // Whether the start handed the browser over: only then does the pipe's
  // end, or a call with no answer, tell of a browser lost in the middle of
  // the run.
  let kept = false;
  // Whether it answered at all: one that never did is not asked to quit.
  let answered = false;
  const browser = pipeTo(child, {
    onClose: () => {
      if (kept && !closing) lost = true;
    },
    watch: () => (kept ? watch() : Promise.resolve(null)),
  });
  // Chrome is asked to quit first: killed outright, its helper processes go
  // on writing to the profile for a while and the folder cannot be removed.
  // A profile that still cannot be removed is left in the temp folder; the
  // screenshots are not lost over it.
  const close = async () => {
    closing = true;
    let killed = lost;
    // A browser that never answered is not asked.
    if (answered && !exited && !browser.closed()) {
      await browser.send("Browser.close", {}, 3_000, { fixed: true, watched: false }).catch(() => {});
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    }
    browser.close();
    if (!exited) {
      killed = true;
      child.kill("SIGKILL");
    }
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    // A program that a wrapper script left running beside the browser holds
    // the other ends of its pipes, and the run's process waited for that
    // program to end before it exited, the run over: they are let go of
    // once the browser has ended. One that could not be started for want of
    // file descriptors has none.
    const letGo = () => (child.stdio || []).forEach((stream) => stream && stream.destroy());
    if (exited) letGo();
    else child.once("exit", letGo);
    open.delete(started);
    const lock = started.lock || lockFolderOf(profile);
    const remove = () => {
      removeProfile(profile);
      removeLockFolder(lock);
      removeFetchFolders(fetching);
    };
    remove();
    // The helpers of a browser that was killed go on for a moment and make
    // its profile again: it is removed again once they have ended.
    for (let i = 0; i < 4 && killed; i++) {
      await sleep(200);
      if (fs.existsSync(profile)) remove();
    }
  };
  // Whether the browser still answers, asked once a call to it or to one of
  // its tabs has had no answer for a while (see pipeTo()): asked for its
  // version, a running browser answers at once, whatever its pages do. One
  // that does not in PROBE_MS has stopped answering, as one that hung or
  // was stopped, or one on a machine too busy to run it: every window and
  // page the run has still to take would wait out its time for nothing. It
  // is killed, so each call under way or to come fails at once, and it
  // counts as lost. Resolves to the error a call fails with then, or null.
  let asking = null;
  const watch = () => {
    if (stalled) return Promise.resolve(Object.assign(new Error(STALLED), { stalled: true }));
    if (closing || lost || !browser) return Promise.resolve(null);
    asking =
      asking ||
      browser
        .send("Browser.getVersion", {}, PROBE_MS, { fixed: true, watched: false })
        .then(
          () => null,
          (err) => {
            if (!err.timedOut || closing || lost) return null;
            stalled = true;
            lost = true;
            child.kill("SIGKILL");
            // Every call to it fails at once from now on, closing a window
            // too, where each waited out its time.
            browser.fail(STALLED);
            return Object.assign(new Error(STALLED), { stalled: true });
          },
        )
        .finally(() => (asking = null));
    return asking;
  };
  // The browser reads its first call once it is up. It has the whole wait to
  // answer it, and the order to refuse downloads what is left of it,
  // whatever the run has left: the wait itself is what the run could give
  // it (see startWait).
  const until = Date.now() + wait;
  const left = () => Math.max(1, until - Date.now());
  let refused = "";
  try {
    // One that answers with an error has answered all the same.
    const version = await browser.send("Browser.getVersion", {}, left(), { fixed: true }).catch((err) => {
      if (err.answered) return {};
      throw err;
    });
    answered = true;
    // A page cannot make the browser save a file: a download it starts (a
    // link to an attachment, a redirect to one) is refused before anything
    // is written, in the Downloads folder or anywhere else. Said once, for
    // the whole browser, on the connection that lasts as long as it does:
    // Page.setDownloadBehavior on a tab lifts this for every tab as soon as
    // that tab's connection closes, and a tab closed right after a download
    // began saved it. A browser that does not take the order is not used.
    await browser.send("Browser.setDownloadBehavior", { behavior: "deny" }, left(), { fixed: true }).catch((err) => {
      if (err.answered) refused = err.message;
      throw err;
    });
    // Read now: a browser that is quitting removes the link to it before
    // the folder, and a stop can land in between. In a profile that is the
    // browser's temp folder, it goes with the profile.
    started.lock = lockFolderOf(profile);
    kept = true;
    // gone(): whether the browser ended or stopped answering in the middle
    // of the run; stalled(): whether it stopped answering. guard: set by the
    // run, the rule for the addresses its pages may open (see address.js
    // and guardBrowser()). owners: by its id, the tab each tab, frame of a
    // tab and window a page opened belongs to.
    return { chrome: { pid: child.pid, browser, userAgent: String(version.userAgent || ""), close, watch, gone: () => lost, stalled: () => stalled, guard: null, owners: new Map(), guarding: null } };
  } catch {
    // No answer in the wait, an answer that refused, or a browser that
    // ended before it answered: its pipe closes a moment before it is
    // known to have ended.
    for (let i = 0; i < 20 && browser.closed() && !exited; i++) await sleep(100);
  }
  // Still running, with no answer: on a busy machine, or a browser that hangs.
  const silent = !exited && !refused;
  // A program the system could not start, or one that ended before it
  // answered as one the system cannot run does (see programs.js), and
  // what is wrong with it.
  const unstarted = failed ? whyUnstarted(binary, failed) : exited && !answered ? notRun(binary, said) : "";
  // A browser that ends before it answers, as Chrome does in a temp folder
  // whose path leaves no room for its lock's socket, leaves its lock folder
  // there, empty and with no link to it in the profile, and one of its
  // helpers can make the profile again a moment after it went. Both go once
  // the helpers have ended too.
  const deep = inProfile && removeStrayLocks(new Set(), { dir: profile });
  await close();
  await sleep(300);
  removeProfile(profile);
  return { own: inProfile, tooDeep: removeStrayLocks(locksBefore) || deep, silent, refused, unstarted, said: exited && !answered ? said : "" };
}

// Removes a browser's profile, trying again while a helper of the browser
// still writes in it, and leaves what cannot be removed for the system's
// temp clean-up: a removal that fails is no reason to lose a run, nor to
// say why a browser did not start in other words.
function removeProfile(profile) {
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Left for the system's temp clean-up.
  }
}

// What is wrong with a browser the system could not start, from the error
// it gave, as a sentence that ends with how to get one that runs.
function whyUnstarted(binary, err) {
  if (programs.SHORT[err.code]) return `${programs.SHORT[err.code]}.`;
  const place = programs.places.get(binary) || programs.found(binary, { name: path.basename(binary), where: "", fix: FIX.found });
  return programs.told(place, programs.explain(binary, { error: err }));
}

// What is wrong with a browser that ended before it answered, when the
// loader or the shell said so, or when its file is no program of this
// system, as an empty or a text file with no #! line that the shell ran to
// nothing, or one for another system: "" for any other, as a browser that
// crashed as it started.
function notRun(binary, stderr) {
  const what = programs.unrun(binary, { stderr }) || programs.whatItIs(programs.kindOf(binary));
  if (!what) return "";
  const place = programs.places.get(binary) || programs.found(binary, { name: path.basename(binary), where: "", fix: FIX.found });
  return programs.told(place, what);
}

// The browser's environment: the run's, with more (see configIn and
// standIns). On Linux it has no display either, as it draws headless: the
// desktop's display, X11's or Wayland's, is a way to the desktop too, for
// the browser and for what it starts. DISPLAY is unset, and so is
// WAYLAND_SOCKET, a connection handed down open. WAYLAND_DISPLAY is a path
// in the browser's profile that is never made, which libwayland takes for
// the socket itself: unset, it looks for wayland-0 in XDG_RUNTIME_DIR,
// where a Wayland desktop's display is, and the browser sets it to that
// for the programs it starts.
function browserEnv(profile, more) {
  const env = { ...process.env, ...more };
  if (process.platform === "linux") {
    delete env.DISPLAY;
    delete env.WAYLAND_SOCKET;
    env.WAYLAND_DISPLAY = path.resolve(profile, "easyscreenshotkit-no-display");
  }
  return env;
}

// On Linux the browser hands an address of a kind it does not open itself,
// mailto:, news: or snews:, to a program of the machine without asking. On
// a desktop it asks the desktop's portal (org.freedesktop.portal.OpenURI)
// over the session bus, and the portal starts the user's own mail program
// with what the site wrote in the address; with no portal to ask, it starts
// xdg-email or xdg-open by its name through PATH, which did the same, and
// on a service that runs the kit for many people started xdg-open there.
// Before either, it starts xdg-settings through PATH, twice, to ask which
// program opens such an address (tel: too), which runs xdg-mime.
// So the browser starts with a session bus where nothing listens, a socket
// in its profile that is never made (unset, a bus can be looked for in
// XDG_RUNTIME_DIR, where the desktop's is, as libdbus does), with no
// display (see browserEnv), and with programs of those names first on its
// PATH, in a folder of its profile: links to true, which start nothing, in
// the place of the programs it hands an address to (HANDED_TO), and links
// to false, which find no program, in the place of those it asks (ASKED),
// or scripts that exit at once where there is no true or false. The rest
// of PATH stays as it was. Returns the browser's PATH and bus, once each
// of those names on that PATH leads to its stand-in, or { problem }: why it
// cannot, as the temp folder is on a disk that takes no symbolic links,
// where the browser could not make the lock of its profile either, no
// program may run from the temp folder (one mounted noexec, with no true or
// false to link to), or the temp folder's path has in it the character that
// parts the folders of PATH, which led the browser to the real programs.
const HANDED_TO = ["xdg-open", "xdg-email", "x-www-browser", "www-browser", "sensible-browser"];
const ASKED = ["xdg-settings", "xdg-mime"];

function standIns(profile) {
  const dir = path.resolve(profile, "easyscreenshotkit-handlers");
  const PATH = `${dir}${path.delimiter}${process.env.PATH ?? "/usr/bin:/bin"}`;
  const runs = (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  let noLinks = false;
  try {
    fs.mkdirSync(dir);
    for (const [names, ends] of [[HANDED_TO, 0], [ASKED, 1]]) {
      const program = (ends ? ["/usr/bin/false", "/bin/false"] : ["/usr/bin/true", "/bin/true"]).find(runs);
      for (const name of names) {
        const at = path.join(dir, name);
        if (program) fs.symlinkSync(program, at);
        else fs.writeFileSync(at, `#!/bin/sh\nexit ${ends}\n`, { mode: 0o700 });
      }
    }
  } catch (err) {
    // Said below: the names do not lead to stand-ins.
    noLinks = err.syscall === "symlink" && ["EPERM", "EOPNOTSUPP", "ENOSYS"].includes(err.code);
  }
  if ([...HANDED_TO, ...ASKED].every((name) => programs.lookOnPath(name, { within: PATH }).file === path.join(dir, name))) {
    return { PATH, DBUS_SESSION_BUS_ADDRESS: `unix:path=${busPath(path.resolve(profile, "easyscreenshotkit-no-bus"))}` };
  }
  const tmp = os.tmpdir();
  if (noLinks) return { problem: `the temp folder, ${tmp}, is on a disk that takes no symbolic links, which the browser's profile needs. Point TMPDIR at a folder on another disk` };
  if (dir.includes(path.delimiter)) return { problem: `the temp folder's path, ${tmp}, has a ${path.delimiter} in it, which parts the folders of PATH. Point TMPDIR at a folder whose path has none` };
  return { problem: `no program may run from the temp folder, ${tmp}. Point TMPDIR at a folder where programs may run` };
}

// A path as a D-Bus address writes it: each byte but a letter, a digit and
// -_/.\* as %xx.
const busPath = (file) => Array.from(Buffer.from(file, "utf8"), (byte) => (/[-0-9A-Za-z_/.\\*]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, "0")}`)).join("");

// On Linux a browser keeps its crash reports in the folder of the user's own
// browser of its kind (~/.config/google-chrome/Crash Reports), whatever
// profile it is given: it rewrote a file there each time it started, and one
// that crashed left a report there with its command line, which nothing
// removed. CHROME_CONFIG_HOME puts that folder in its profile, so it goes
// with the profile. Elsewhere it is left as it is.
function configIn(profile) {
  return process.platform === "linux" ? { CHROME_CONFIG_HOME: profile } : {};
}

// The longest path a socket can have: 107 bytes on Linux, 103 on macOS.
const SOCKET_PATH_MAX = process.platform === "darwin" ? 103 : 107;

// Whether a browser's lock fits in a folder: the path of its socket there,
// in a lock folder with the longest name one of the browsers easyscreenshotkit
// finds gives it, Chromium's.
function roomIn(folder) {
  return Buffer.byteLength(path.join(folder, "org.chromium.Chromium.XXXXXX", "SingletonSocket")) <= SOCKET_PATH_MAX;
}

// After a browser that did not start: removes the lock folders that came
// into the temp folder since it started (before: the names there then) and
// are too deep for their socket. No browser can use one of those, so none
// is the lock of another browser starting at the same moment, empty for an
// instant too. Returns whether there was one.
function removeStrayLocks(before, { dir = os.tmpdir(), max = SOCKET_PATH_MAX } = {}) {
  let found = false;
  for (const name of lockFolders(dir)) {
    if (before.has(name) || Buffer.byteLength(path.join(dir, name, "SingletonSocket")) <= max) continue;
    found = true;
    removeLockFolder(path.join(dir, name));
  }
  return found;
}

// In its first seconds a browser makes a folder in its temp folder for what
// it downloads for itself (com.google.Chrome.chrome_chrome_url_fetcher_.XXXXXX
// and the like; chrome_url_fetcher_XXXX_XXXX on Windows) and another to unpack
// it in (chrome_Unpacker_BeginUnzipping), and leaves them there when it quits
// or is killed before that has ended.
function fetchFolders(dir = os.tmpdir()) {
  try {
    return new Set(fs.readdirSync(dir).filter((name) => /chrome_(url_fetcher|Unpacker)_/.test(name)));
  } catch {
    return new Set();
  }
}

// Once a browser has ended, removes such folders that came since it started
// (before: the names there then), with what they hold: a browser that ended
// in its first seconds left a part of its download in them. One that another
// browser made a moment ago costs that browser a download of its own, which
// it does again. before: null when the browser had a temp folder of its own.
function removeFetchFolders(before, dir = os.tmpdir()) {
  if (!before) return;
  for (const name of fetchFolders(dir)) {
    if (before.has(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // Held open by a browser still at it (Windows), or gone already.
    }
  }
}

// The devices a page is captured on. A phone is a phone to the site: its
// size, a touch screen, and the user agent (with the client hints Chrome
// sends) of that phone's browser, so a site that picks its mobile layout by
// the browser sends it too. A narrowed desktop window is not enough: tables
// came out wrapped word by word, and some sites kept their desktop layout.
const ANDROID_MODEL = "Pixel 8";

function userAgentFor(device, chromeAgent) {
  const major = (/Chrome\/(\d+)/.exec(chromeAgent) || [])[1] || "141";
  if (device.agent === "android") {
    return {
      userAgent: `Mozilla/5.0 (Linux; Android 14; ${ANDROID_MODEL}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
      platform: "Linux aarch64",
      userAgentMetadata: {
        brands: [{ brand: "Chromium", version: major }, { brand: "Not?A_Brand", version: "24" }],
        fullVersionList: [{ brand: "Chromium", version: `${major}.0.0.0` }, { brand: "Not?A_Brand", version: "24.0.0.0" }],
        platform: "Android",
        platformVersion: "14.0.0",
        architecture: "",
        model: ANDROID_MODEL,
        mobile: true,
      },
    };
  }
  if (device.agent === "iphone") {
    return {
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      platform: "iPhone",
    };
  }
  // Headless Chrome says "HeadlessChrome" in its user agent, and some sites
  // answer that with a stripped page; the tab says "Chrome", as the same
  // browser with a window would.
  return { userAgent: chromeAgent.replace("HeadlessChrome", "Chrome") };
}

// Whether an address is of a kind the browser does not open as a page but
// hands to a program of the machine: anything with a scheme of its own that
// is no web address and none of the browser's own.
const outside = (url) => /^[a-z][a-z0-9+.-]*:/i.test(String(url || "")) && !/^(https?|about|data|blob|javascript|file|filesystem|chrome|chrome-error|devtools):/i.test(String(url));

// Where a document's answer, paused before the browser read it, redirects
// to: the address its Location names, read against the request's, or ""
// for an answer that is no redirect.
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function redirectOf(p) {
  if (!REDIRECTS.has(p.responseStatusCode)) return "";
  const location = (p.responseHeaders || []).find((header) => String(header.name).toLowerCase() === "location");
  try {
    return location ? new URL(String(location.value), String((p.request && p.request.url) || "")).href : "";
  } catch {
    return "";
  }
}

// The event a tab gets when a document of its own was not loaded because
// the run's guard refuses its address (see guardBrowser()): {url, why,
// main, window}, main when it was the page itself, window when it was a
// window the page opened, and neither for a frame in the page.
const BARRED = "easyscreenshotkit.addressRefused";

// The rule for the addresses a run's pages may open (chrome.guard, see
// address.js), held for every document the browser loads for them: the
// page, each frame in it, one that runs in a process of its own too, and
// each window a page opens, with every redirect and every move of any of
// them. The browser asks before it sends each such request, on its own
// connection, which sees the requests of every tab, frame and window; a
// request the guard refuses is not sent, and the tab it belongs to is told
// (BARRED). The kit's own tabs open files the kit made, and a page that is
// no tab's, nor a frame or a window of one, is Chrome's own and opens what
// is not a web address as Chrome lets it. A frame inside a frame of another
// site can belong to no tab the kit can tell: what it opens is judged all
// the same, and then no tab is told. A page's pictures, scripts, styles and
// the data it fetches are not documents: the browser's own rules hold for
// them.
// The answer to each such request is held a moment too, before the browser
// reads it: one that redirects to an address of another kind, as a 302 to
// mailto:, is not followed, on any system, and the tab is told of it as of
// a move there, one the browser was not asked to open (no asked, see
// openTab()). Followed, it had the browser hand the address to a program
// of the machine, and a page that redirected there was said to fail in the
// browser's bare words (net::ERR_ABORTED), or, for a frame or a page that
// moved there once it had loaded, went without a note.
// Turned on once for a browser, when its first tab opens with the guard
// set; timeoutMs: how long the browser has to take it. A turn-on that
// failed, as one that ran out of time on a busy machine, is not kept: the
// next window asks the browser again, where every window after it failed
// at once with the first one's error and the browser was never asked again.
// The listeners go on once for the browser, so a request is not continued
// or failed twice.
const QUICK = { fixed: true, watched: false };

function guardBrowser(chrome, timeoutMs) {
  if (chrome.guarding) return chrome.guarding;
  const { browser, owners } = chrome;
  if (!chrome.guardHeard) {
    chrome.guardHeard = true;
    // A frame of a tab that runs in a process of its own, and a window a
    // page of it opens, belong to that tab.
    const adopt = ({ targetInfo: t = {} }) => {
      if (!t.targetId || owners.has(t.targetId)) return;
      const from = owners.get(t.type === "page" ? t.openerId || "" : t.parentFrameId || "");
      if (from) owners.set(t.targetId, { tab: from.tab, own: from.own, window: t.type === "page" || from.window });
    };
    // Such a frame is a target of its own, and what it commits never
    // reaches its tab's session, where sendInput() hears the tab's page
    // move on. An input event on its way to it, as a turn of the wheel
    // over another site's frame or a sandboxed one, as an ad is, went
    // unanswered at times as the frame moved on to another document, and
    // the run, or a demo's step, waited 30 s and failed in the words
    // "Input.dispatchMouseEvent timed out". So the tab's input events under
    // way are told when the browser says such a frame has changed, which
    // it does as the frame commits another document, the same address
    // again included, and when it goes or crashes.
    const frameMoved = (targetId) => {
      const known = owners.get(targetId);
      if (!known || known.window || !known.tab || known.tab.targetId === targetId || !known.tab.inputs) return;
      for (const moved of [...known.tab.inputs]) moved();
    };
    browser.on("Target.targetCreated", adopt);
    browser.on("Target.targetInfoChanged", (p) => {
      adopt(p);
      if (p.targetInfo && p.targetInfo.type === "iframe") frameMoved(p.targetInfo.targetId);
    });
    browser.on("Target.targetCrashed", ({ targetId }) => frameMoved(targetId));
    browser.on("Target.targetDestroyed", ({ targetId }) => {
      frameMoved(targetId);
      const known = owners.get(targetId);
      if (known && known.tab.targetId !== targetId) owners.delete(targetId);
    });
    browser.on("Fetch.requestPaused", async (p) => {
      const go = () => void browser.send("Fetch.continueRequest", { requestId: p.requestId }, 10_000, QUICK).catch(() => {});
      const url = String((p.request && p.request.url) || "");
      const owner = owners.get(p.frameId);
      if (p.responseStatusCode !== undefined || p.responseErrorReason !== undefined) {
        const to = redirectOf(p);
        if (!to || !outside(to) || (owner && owner.own)) return go();
        if (owner && owner.tab) owner.tab.emit(BARRED, { url: to, why: NOT_WEB, main: p.frameId === owner.tab.targetId, window: Boolean(owner.window), stays: true });
        return void browser.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Aborted" }, 10_000, QUICK).catch(() => {});
      }
      if ((owner && owner.own) || (!owner && !/^https?:/i.test(url))) return go();
      const why = chrome.guard ? await chrome.guard.refuses(url).catch(() => NOT_WEB) : "";
      if (!why) return go();
      // Asked again: a frame can be known by the time its address is judged.
      const known = owners.get(p.frameId) || owner;
      if (known && known.tab) known.tab.emit(BARRED, { url, why, main: p.frameId === known.tab.targetId, window: Boolean(known.window) });
      browser.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Aborted" }, 10_000, QUICK).catch(() => {});
    });
  }
  const turning = (async () => {
    await browser.send("Target.setDiscoverTargets", { discover: true }, timeoutMs);
    const documents = (requestStage) => ({ urlPattern: "*", resourceType: "Document", requestStage });
    await browser.send("Fetch.enable", { patterns: [documents("Request"), documents("Response")] }, timeoutMs);
  })();
  chrome.guarding = turning;
  turning.catch(() => {
    if (chrome.guarding === turning) chrome.guarding = null;
  });
  return turning;
}

// A new window holding one tab, set up as the device: its screen, touch,
// user agent and language, light or dark, and reduced motion when asked.
// The browser has WINDOW_MS for all of it, or what the run has left: one
// that has not done it by then fails it with a sentence that says so, and
// reason, its short form for a page or a window left out over it. One that
// has stopped answering altogether fails it with that (see start()). own:
// a tab for the kit's own pages (the sheet, the demo's frames), which opens
// files the kit made; any other opens web addresses only, and with the
// run's guard set (chrome.guard) every document it loads is judged by the
// guard first (see guardBrowser()): one it refuses is not loaded, and the
// page stays where it was, as for a download.
async function openTab(chrome, device, { lang = "", theme = "light", reducedMotion = false, own = false } = {}) {
  const wait = waitOf(WINDOW_MS);
  const until = Date.now() + wait.ms;
  const left = () => Math.max(1, until - Date.now());
  let cdp = null;
  let targetId = "";
  const owners = chrome.owners || (chrome.owners = new Map());
  try {
    if (chrome.guard) {
      // A browser that did not take the order in its time is said so, by
      // the time it had: it opened no window, and had not had 60 s.
      const had = left();
      try {
        await guardBrowser(chrome, had);
      } catch (err) {
        if (!err.timedOut || (chrome.stalled && chrome.stalled())) throw err;
        const stopped = chrome.watch ? await chrome.watch() : null;
        if (stopped) throw stopped;
        const s = Math.max(1, Math.round(Math.max(1_000, Math.min(had, timeLeft())) / 1000));
        const said = `the browser did not take the order that holds its pages to the addresses the run opens in ${s} s`;
        throw Object.assign(new Error(`${said.charAt(0).toUpperCase()}${said.slice(1)}. ${busy(wait.cut)}`), { reason: said });
      }
    }
    ({ targetId } = await chrome.browser.send("Target.createTarget", { url: "about:blank", newWindow: true }, left()));
    const { sessionId } = await chrome.browser.send("Target.attachToTarget", { targetId, flatten: true }, left());
    cdp = chrome.browser.session(sessionId);
    cdp.targetId = targetId;
    cdp.own = own;
    cdp.guard = own ? null : chrome.guard || null;
    const tab = cdp;
    owners.set(targetId, { tab, own });
    // The tab's frames, one that runs in a process of its own too, which
    // keeps its id as it moves there.
    cdp.on("Page.frameAttached", ({ frameId }) => owners.set(frameId, { tab, own }));
    cdp.on("Page.frameDetached", ({ frameId, reason }) => {
      if (reason !== "swap" && frameId !== targetId) owners.delete(frameId);
    });
    // The input events under way, each told when the tab's page commits
    // another document (see sendInput()).
    cdp.inputs = new Set();
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (frame && !frame.parentId) for (const moved of [...cdp.inputs]) moved();
    });
    // A tab whose page crashed, as one killed for its memory does, answers
    // nothing more while the browser goes on: its calls fail at once, with
    // why, where each waited out its whole time limit and was called too
    // slow.
    cdp.on("Inspector.targetCrashed", () => cdp.fail(CRASHED));
    // A dialog a page opens (an alert while it loads, a question before it
    // is left) holds the tab until someone answers it, and nothing else does.
    cdp.on("Page.javascriptDialogOpening", () => cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {}));
    // The page, a frame of it or a window it opens going to an address of
    // another kind, as mailto:, which the browser hands to a program of the
    // machine (see standIns), is named to the tab as a refused document is:
    // it is no page to open, and the page stays where it was. handed: on a
    // system where no program could be put in the way, it may have gone to
    // one. asked: the browser itself was asked to open it, as it is not for
    // a redirect to one, which the guard does not follow (see
    // guardBrowser()).
    if (!own) {
      const handed = process.platform !== "linux";
      cdp.on("Page.frameRequestedNavigation", (p) => {
        if (outside(p.url) && (!p.disposition || p.disposition === "currentTab")) cdp.emit(BARRED, { url: p.url, why: NOT_WEB, main: p.frameId === targetId, window: false, stays: true, handed, asked: true });
      });
      cdp.on("Page.windowOpen", (p) => {
        if (outside(p.url)) cdp.emit(BARRED, { url: p.url, why: NOT_WEB, main: false, window: true, stays: true, handed, asked: true });
      });
    }
    await cdp.send("Inspector.enable", {}, left()).catch(() => {});
    await cdp.send("Page.enable", {}, left());
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.scale,
        mobile: device.mobile,
        screenWidth: device.width,
        screenHeight: device.height,
        ...(device.mobile ? { screenOrientation: { type: "portraitPrimary", angle: 0 } } : {}),
      },
      left(),
    );
    if (device.touch) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, left());
    await cdp.send("Emulation.setUserAgentOverride", { ...userAgentFor(device, chrome.userAgent), ...(lang ? { acceptLanguage: lang } : {}) }, left());
    if (lang) await cdp.send("Emulation.setLocaleOverride", { locale: lang }, left()).catch(() => {});
    const features = [{ name: "prefers-color-scheme", value: theme === "dark" ? "dark" : "light" }];
    if (reducedMotion) features.push({ name: "prefers-reduced-motion", value: "reduce" });
    await cdp.send("Emulation.setEmulatedMedia", { features }, left());
    // Under a page that paints no background of its own, the browser's own
    // (white, or dark grey in the dark theme): otherwise those pixels come
    // out see-through, and one screen of a page is RGBA while the next is
    // RGB.
    const ground = theme === "dark" ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: ground }, left()).catch(() => {});
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, left()).catch(() => {});
  } catch (err) {
    // A browser that stopped answering has been ended: there is no window
    // of it to close, and asking it to cost the run 5 s more.
    if (chrome.stalled && chrome.stalled()) throw err;
    if (cdp) await closeTab(chrome, cdp);
    else if (targetId) await chrome.browser.send("Target.closeTarget", { targetId }, 5_000).catch(() => {});
    if (!err.timedOut) throw err;
    // A window that did not open in its time is said so only of a browser
    // that still answers: one that does not has stopped answering.
    const stopped = chrome.watch ? await chrome.watch() : null;
    if (stopped) throw stopped;
    const s = Math.round(wait.ms / 1000);
    throw Object.assign(new Error(`The browser did not open a window in ${s} s. ${busy(wait.cut)}`), { reason: `the browser did not open a window in ${s} s` });
  }
  return cdp;
}

async function closeTab(chrome, cdp) {
  cdp.close();
  await chrome.browser.send("Target.closeTarget", { targetId: cdp.targetId }, 5_000).catch(() => {});
  if (!chrome.owners) return;
  for (const [id, known] of chrome.owners) if (known.tab === cdp) chrome.owners.delete(id);
}

// An input event for a tab, a turn of the wheel, a move of the mouse, a
// press of its button or of a key (Input.dispatchMouseEvent and
// Input.dispatchKeyEvent), which the browser answers once the page has taken
// it. A page that moves on to another document while one is on its way can
// leave it with no answer at all: Chrome drops it with the page, at times,
// as when a wheel turns the moment a page leaves for another and its
// pagehide holds it a little. Such a call waited out its whole time, 30 s,
// and then failed the run, or the demo's step, in the words
// "Input.dispatchMouseEvent timed out". So once the tab's page has
// committed another document, or a frame of it that runs in a process of
// its own has (see guardBrowser()), a call still under way is waited for
// MOVED_MS more and then let go, resolving to { unanswered: true }: the
// document it was for is gone, and the run goes on with the one that
// came, as after any move. A tab that has not moved waits for the answer
// as long as before.
const MOVED_MS = 1_000;

function sendInput(tab, method, params, timeoutMs = 30_000) {
  if (!tab.inputs) return tab.send(method, params, timeoutMs);
  let moved;
  const until = new Promise((resolve) => {
    moved = () => {
      tab.inputs.delete(moved);
      setTimeout(resolve, MOVED_MS).unref();
    };
  });
  tab.inputs.add(moved);
  return tab.send(method, params, timeoutMs, { until }).finally(() => tab.inputs.delete(moved));
}

// Opens the address and waits for its load event, at most 20 s: a page that
// never finishes loading (a stuck tracking script) is read as it stands.
// Another #route of the page already open loads nothing (Chrome answers
// with no loader for it), so there is no load event to wait for: only for
// the page to move to it, which comes after the answer, 2 s at most.
// Returns the address the tab ended on, after any redirects, and the HTTP
// status the page came with. An address that answers with a file to
// download, at once or after a redirect, is refused: the browser saves
// nothing (see launch()), and there is no page to take. One with no answer
// in ANSWER_MS, or in what the run has left, is said so. In a tab for a
// site (see openTab), an address that is no web address is never opened,
// and neither is one the run's guard refuses, nor one a redirect leads to:
// refused says what it is, for a page left out over it.
//
// A page that moves on by itself before its load event, as a local app
// sends a visitor who has not signed in to its sign-in server, has left
// its own load: no load event comes. When the guard refuses where it moves
// to, it is refused as a redirect there is, at once: waited for, it held
// the run 20 s for a load that never came, and every capture after it
// failed. One that moves to a file the browser does not download, or to an
// address of another kind such as mailto:, stays where it was: one with
// something drawn by then, as a page that thanks for a download and sends
// the browser to the file from the end of its body, is taken as it is
// drawn, and only the notes say what it tried; one with nothing drawn, as
// one whose head sends the browser on, has stopped before its body, and is
// refused at once too. A move after the load event leaves the page as it
// was, drawn, and only the tab's BARRED says so.
//
// The tab's stopped says where a page taken as it is drawn went before its
// load event, { url, why }, or is null: the browser stops loading a page
// that leaves its load, so what is drawn of it is all there will be, and
// nothing is waited for to come (see waitForContent). A page that thanks for
// a download and sends the browser to the file from the middle of its body
// was waited for 20 s as a loading screen, and said to be one.
const NOT_A_PAGE = "a file to download instead of a page";

// Whether a page that stopped where it was has something drawn: words or a
// picture, a field or a frame in its body. Asked a few times over a moment.
const DRAWN_SO_FAR = `(() => {
  const body = document.body;
  if (!body) return false;
  if (body.innerText.trim()) return true;
  return [...body.querySelectorAll("img, svg, video, canvas, picture, input, button, select, textarea, iframe")].some((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
})()`;

async function drawnSoFar(cdp) {
  for (let i = 0; i < 5; i++) {
    const { result } = await cdp.send("Runtime.evaluate", { expression: DRAWN_SO_FAR, returnByValue: true }, 5_000).catch(() => ({ result: {} }));
    if (result && result.value === true) return true;
    if (cdp.closed && cdp.closed()) return false;
    await sleep(200);
  }
  return false;
}

async function navigate(cdp, url) {
  cdp.stopped = null;
  if (!cdp.own) {
    const why = cdp.guard ? await cdp.guard.refuses(url) : /^https?:$/i.test(protocolOf(url)) ? "" : NOT_WEB;
    if (why) throw Object.assign(new Error(`Could not open ${url}: it is ${why}.`), { refused: why });
  }
  let timer;
  const off = [];
  const listen = (method, listener) => {
    cdp.on(method, listener);
    off.push(() => cdp.off(method, listener));
  };
  // barred: the first refusal of a document of the page itself; stayed:
  // the first of a move that leaves the page where it was, as one to an
  // address of another kind, which is why an address that redirects there
  // fails. left: where the page went, before its load event, that it may
  // not go; stays, when that left the page where it was (a file, an address
  // of another kind).
  let barred = null;
  let stayed = null;
  let left = null;
  let loadedYet = false;
  let asked = false;
  let leave;
  const leaving = new Promise((resolve) => (leave = resolve));
  const loaded = new Promise((resolve) =>
    listen("Page.loadEventFired", () => {
      loadedYet = true;
      resolve();
    }),
  );
  const moved = new Promise((resolve) => listen("Page.navigatedWithinDocument", resolve));
  const goes = (where) => {
    if (loadedYet || left) return;
    left = where;
    leave();
  };
  listen(BARRED, (b) => {
    if (!b.main) return;
    if (!b.stays) barred = barred || b;
    else stayed = stayed || b;
    goes(b);
  });
  // A download the page itself went to as it loaded. One a link with a
  // download attribute starts leaves the page to load on, and is no move.
  listen("Page.frameRequestedNavigation", (p) => {
    if (p.frameId === cdp.targetId && (!p.disposition || p.disposition === "currentTab")) asked = true;
  });
  listen("Page.downloadWillBegin", (p) => {
    if (p.frameId === cdp.targetId && asked) goes({ url: p.url, why: NOT_A_PAGE, stays: true });
  });
  try {
    const wait = waitOf(ANSWER_MS);
    const { errorText, loaderId, isDownload } = await cdp.send("Page.navigate", { url }, wait.ms).catch((err) => {
      if (!err.timedOut) throw err;
      const s = Math.round(wait.ms / 1000);
      throw Object.assign(new Error(`Could not open ${url}: no answer in ${s} s. The site may be down or slow, or the machine too busy: try again${wait.cut ? ", or give the run more time with --timeout" : ""}.`), { reason: `no answer in ${s} s` });
    });
    if (isDownload) throw Object.assign(new Error(`Could not open ${url}: it answers with ${NOT_A_PAGE}.`), { refused: NOT_A_PAGE });
    const refusal = barred || stayed;
    if (errorText && refusal) {
      const why = `it leads to ${refusal.url}, which is ${refusal.why}`;
      throw Object.assign(new Error(`Could not open ${url}: ${why}.`), { refused: why });
    }
    // reason: the browser's own words, for a page left out over it.
    if (errorText) throw Object.assign(new Error(`Could not open ${url}: ${errorText}`), { reason: errorText });
    // The wait is cleared once the page has loaded: left running, it kept
    // the process alive that long after the last page.
    const limit = loaderId ? Math.max(1_000, Math.min(20_000, timeLeft() - 60_000)) : 2_000;
    // A tab that crashed, or a browser that ended, fires no such event: the
    // calls that come next say which.
    await Promise.race([loaderId ? loaded : moved, leaving, cdp.over, new Promise((resolve) => (timer = setTimeout(resolve, limit)))]);
    if (left && !loadedYet) {
      if (!(left.stays && (await drawnSoFar(cdp)))) {
        const why = `it leads to ${left.url}, which is ${left.why}`;
        throw Object.assign(new Error(`Could not open ${url}: ${why}.`), { refused: why });
      }
      cdp.stopped = { url: left.url, why: left.why };
    }
  } finally {
    clearTimeout(timer);
    for (const stop of off) stop();
  }
  const finalUrl = await currentUrl(cdp, url);
  const { result } = await cdp
    .send("Runtime.evaluate", { expression: "(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0", returnByValue: true }, 5_000)
    .catch(() => ({ result: {} }));
  return { url: finalUrl, status: Number(result && result.value) || 0 };
}

function protocolOf(url) {
  try {
    return new URL(url).protocol;
  } catch {
    return "";
  }
}

// The address the tab shows now: an app can move to another #route of its
// own after the page has loaded (a sign-in check that answers late).
async function currentUrl(cdp, fallback = "") {
  try {
    const { currentIndex, entries } = await cdp.send("Page.getNavigationHistory", {}, 5_000);
    return (entries[currentIndex] || {}).url || fallback;
  } catch {
    return fallback;
  }
}

// For a process that is being stopped and has no time to ask its browsers
// to quit: each one is killed at once. Returns their profiles with their
// lock folders, for removeProfiles() once the browsers' helper processes
// have ended too, about a tenth of a second later: removed sooner, a
// profile fills up again.
function killBrowsers() {
  const browsers = [];
  for (const { child, profile, lock, fetching } of open) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
    browsers.push({ profile, lock: lock || lockFolderOf(profile), fetching });
  }
  open.clear();
  return browsers;
}

// The folder a browser keeps its single-instance lock in (on Linux and
// macOS, com.google.Chrome.XXXXXX and the like, in the temp folder): the
// browser removes it as it quits, but one killed outright cannot. Read from
// the link its profile holds to the lock's socket, and only when that leads
// to a folder right in the temp folder; "" otherwise.
function lockFolderOf(profile) {
  try {
    const socket = fs.readlinkSync(path.join(profile, "SingletonSocket"));
    if (path.basename(socket) !== "SingletonSocket") return "";
    const folder = path.dirname(socket);
    return path.dirname(fs.realpathSync(folder)) === fs.realpathSync(os.tmpdir()) ? folder : "";
  } catch {
    return "";
  }
}

// The names in the temp folder that such a folder can have.
const LOCK_FOLDER = /^[a-z]+(\.[A-Za-z]+)+\.[A-Za-z0-9]{6}$/;

function lockFolders(dir = os.tmpdir()) {
  try {
    return new Set(fs.readdirSync(dir).filter((name) => LOCK_FOLDER.test(name)));
  } catch {
    return new Set();
  }
}

// Removes such a folder, when all it holds is the lock.
function removeLockFolder(folder) {
  if (!folder) return;
  try {
    if (fs.readdirSync(folder).every((name) => /^Singleton(Socket|Cookie|Lock)$/.test(name))) fs.rmSync(folder, { recursive: true, force: true });
  } catch {
    // Gone already.
  }
}

// Synchronous, with no retries that wait long: a stopped process may have a
// second left before it is killed outright. Each browser's lock folder goes
// too.
function removeProfiles(browsers) {
  for (const { profile, lock, fetching } of browsers) {
    for (let tries = 0; tries < 2; tries++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        // Something still wrote to it: once more a moment later, then it is
        // left for the system's temp clean-up.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
    removeLockFolder(lock);
    removeFetchFolders(fetching);
  }
}

module.exports = { findChrome, browserProblem, onPath, launch, startWait, openTab, closeTab, sendInput, guardBrowser, navigate, drawnSoFar, currentUrl, killBrowsers, removeProfiles, removeStrayLocks, removeFetchFolders, fetchFolders, roomIn, lockFolderOf, userAgentFor, busy, CRASHED, BARRED, NOT_A_PAGE };
