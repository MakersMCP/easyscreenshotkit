"use strict";

// The browser: a Chrome, Chromium, Edge or Brave already on this machine,
// started headless with a throwaway profile and driven over the DevTools
// protocol with the WebSocket built into Node 22. Nothing is downloaded.
// Finding, starting and closing the browser come from easybrandkit 0.2.1;
// every page here opens in a window of its own, set up as the device it is
// captured on.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { timeLeft, sleep } = require("./time");

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

function onPath(name) {
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not in this directory.
    }
  }
  return "";
}

function findChrome() {
  if (process.env.CHROME_PATH) return fs.existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : "";
  if (process.platform === "darwin") return MAC.find((file) => fs.existsSync(file)) || "";
  if (process.platform === "win32") {
    for (const [root, rest] of WINDOWS) {
      const file = process.env[root] ? path.join(process.env[root], rest) : "";
      if (file && fs.existsSync(file)) return file;
    }
    return "";
  }
  for (const name of LINUX) {
    const file = onPath(name);
    if (file) return file;
  }
  return "";
}

// onClose: called once the connection has closed, whoever closed it.
function connect(wsUrl, { onClose = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = new Map();
    let nextId = 0;
    // Set by fail(): every call goes on failing with it.
    let failure = "";
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg && msg.method) {
        for (const listener of listeners.get(msg.method) || []) listener(msg.params || {});
        return;
      }
      const waiter = msg && pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message || "DevTools protocol error"));
      else waiter.resolve(msg.result || {});
    };
    ws.onerror = () => reject(new Error("The browser connection failed."));
    ws.onclose = () => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("The browser connection closed."));
      }
      pending.clear();
      onClose();
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}, timeoutMs = 30_000) {
          // A call on a connection that is closing or closed would get no
          // answer, and waited out its whole time limit: it fails at once.
          if (failure) return Promise.reject(new Error(failure));
          if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("The browser connection closed."));
          const id = ++nextId;
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} timed out`));
            }, Math.max(1_000, Math.min(timeoutMs, timeLeft())));
            pending.set(id, { resolve: res, reject: rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, listener) {
          listeners.set(method, [...(listeners.get(method) || []), listener]);
        },
        off(method, listener) {
          listeners.set(method, (listeners.get(method) || []).filter((known) => known !== listener));
        },
        close() {
          ws.close();
        },
        closed() {
          return Boolean(failure) || ws.readyState !== WebSocket.OPEN;
        },
        // Fails every call under way and every call to come with message.
        fail(message) {
          failure = message;
          for (const waiter of pending.values()) {
            clearTimeout(waiter.timer);
            waiter.reject(new Error(message));
          }
          pending.clear();
        },
      });
  });
}

// The browsers this process has started and not closed yet, each with its
// profile, from the moment it is spawned.
const open = new Set();

// --use-mock-keychain and --password-store=basic keep Chrome on macOS from
// asking for the login keychain, which it does for a fresh profile. The
// profile is a temp folder; the user's own home and browser are untouched.
// Windows in the background keep drawing (the three --disable-*background*
// flags), so a page waiting its turn is not left half loaded, and colors are
// written in sRGB whatever the machine's display. args: more switches for
// this run (a demo draws its pages at a higher pixel density).
async function launch({ lang = "", args = [] } = {}) {
  const binary = findChrome();
  if (!binary) {
    throw new Error("No Chrome, Chromium, Edge or Brave found. Install one, or point CHROME_PATH at its binary.");
  }
  // A browser whose lock has a longer name than room was left for in its
  // profile (see roomIn) does not start there: it starts again with the
  // temp folder as its own.
  let tried = await start(binary, { lang, args, own: true });
  if (tried.tooDeep && tried.own) tried = await start(binary, { lang, args, own: false });
  if (tried.chrome) return tried.chrome;
  if (tried.tooDeep) throw new Error(`${path.basename(binary)} did not start: the temp folder's path, ${os.tmpdir()}, is too long for the socket it opens there. Point TMPDIR at a folder with a shorter path.`);
  throw new Error(`${path.basename(binary)} did not start. Try again, or point CHROME_PATH at another browser.`);
}

// Starts the browser once. On Linux, with own, its profile is its temp
// folder too, when there is room for its lock's socket there: the browser
// makes its lock in its temp folder, and in its first seconds a folder for
// what it downloads for itself, which it leaves behind when it quits or is
// killed before the download has ended. Both go with the profile then.
// Returns {chrome} once it answers, else {own, tooDeep}: whether its profile
// was its temp folder, and whether it ended because its lock's socket did
// not fit in that folder.
async function start(binary, { lang, args, own }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-chrome-"));
  const inProfile = own && process.platform === "linux" && roomIn(profile);
  const locksBefore = lockFolders();
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--remote-debugging-port=0",
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
    { stdio: "ignore", env: inProfile ? { ...process.env, TMPDIR: profile } : process.env },
  );
  let exited = false;
  // Whether the browser ended, or its connection closed, before close()
  // asked it to quit: it crashed, or something outside the run killed it,
  // and every page and window the run had still to take went with it.
  let lost = false;
  let closing = false;
  child.on("exit", () => {
    exited = true;
    if (!closing) lost = true;
  });
  child.on("error", () => (exited = true));
  // lock: its lock folder, read once it answers (see lockFolderOf).
  const started = { child, profile, lock: "" };
  open.add(started);
  let base = "";
  let browser = null;
  // Chrome is asked to quit first: killed outright, its helper processes go
  // on writing to the profile for a while and the folder cannot be removed.
  // A profile that still cannot be removed is left in the temp folder; the
  // screenshots are not lost over it.
  const close = async () => {
    closing = true;
    if (browser && !exited) {
      await browser.send("Browser.close", {}, 3_000).catch(() => {});
      for (let i = 0; i < 50 && !exited; i++) await sleep(100);
    }
    if (browser) browser.close();
    if (!exited) child.kill("SIGKILL");
    for (let i = 0; i < 20 && !exited; i++) await sleep(100);
    open.delete(started);
    const lock = started.lock || lockFolderOf(profile);
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Left for the system's temp clean-up.
    }
    removeLockFolder(lock);
  };
  // Chrome writes the port it picked to DevToolsActivePort in the profile.
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let waited = 0; waited < 20_000 && !exited; waited += 100) {
    try {
      const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
      if (/^\d+$/.test(port)) {
        base = `http://127.0.0.1:${port}`;
        const version = await (await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(5_000) })).json();
        browser = await connect(version.webSocketDebuggerUrl, {
          onClose: () => {
            if (!closing) lost = true;
          },
        });
        // A page cannot make the browser save a file: a download it starts
        // (a link to an attachment, a redirect to one) is refused before
        // anything is written, in the Downloads folder or anywhere else.
        // Said once, for the whole browser: Page.setDownloadBehavior on a
        // tab lifts this for every tab as soon as that tab's connection
        // closes, and a tab closed right after a download began saved it.
        await browser.send("Browser.setDownloadBehavior", { behavior: "deny" }, 5_000).catch(() => {});
        // Read now: a browser that is quitting removes the link to it
        // before the folder, and a stop can land in between. In a profile
        // that is the browser's temp folder, it goes with the profile.
        started.lock = lockFolderOf(profile);
        const { userAgent = "" } = await browser.send("Browser.getVersion").catch(() => ({}));
        // gone(): whether the browser ended in the middle of the run.
        return { chrome: { base, browser, userAgent, close, gone: () => lost } };
      }
    } catch {
      // Not written yet, or not answering yet.
    }
    await sleep(100);
  }
  // A browser that ends before it answers, as Chrome does in a temp folder
  // whose path leaves no room for its lock's socket, leaves its lock folder
  // there, empty and with no link to it in the profile, and one of its
  // helpers can make the profile again a moment after it went. Both go once
  // the helpers have ended too.
  const deep = inProfile && removeStrayLocks(new Set(), { dir: profile });
  await close();
  await sleep(300);
  fs.rmSync(profile, { recursive: true, force: true });
  return { own: inProfile, tooDeep: removeStrayLocks(locksBefore) || deep };
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

// A new window holding one tab, set up as the device: its screen, touch,
// user agent and language, light or dark, and reduced motion when asked.
async function openTab(chrome, device, { lang = "", theme = "light", reducedMotion = false } = {}) {
  const { targetId } = await chrome.browser.send("Target.createTarget", { url: "about:blank", newWindow: true });
  const cdp = await connect(`${chrome.base.replace(/^http/, "ws")}/devtools/page/${targetId}`);
  cdp.targetId = targetId;
  // A tab whose page crashed, as one killed for its memory does, answers
  // nothing more while the browser goes on: its calls fail at once, with why,
  // where each waited out its whole time limit and was called too slow.
  cdp.on("Inspector.targetCrashed", () => cdp.fail("the browser's tab crashed"));
  try {
    await cdp.send("Inspector.enable").catch(() => {});
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.scale,
      mobile: device.mobile,
      screenWidth: device.width,
      screenHeight: device.height,
      ...(device.mobile ? { screenOrientation: { type: "portraitPrimary", angle: 0 } } : {}),
    });
    if (device.touch) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await cdp.send("Emulation.setUserAgentOverride", { ...userAgentFor(device, chrome.userAgent), ...(lang ? { acceptLanguage: lang } : {}) });
    if (lang) await cdp.send("Emulation.setLocaleOverride", { locale: lang }).catch(() => {});
    const features = [{ name: "prefers-color-scheme", value: theme === "dark" ? "dark" : "light" }];
    if (reducedMotion) features.push({ name: "prefers-reduced-motion", value: "reduce" });
    await cdp.send("Emulation.setEmulatedMedia", { features });
    // Under a page that paints no background of its own, the browser's own
    // (white, or dark grey in the dark theme): otherwise those pixels come
    // out see-through, and one screen of a page is RGBA while the next is
    // RGB.
    const ground = theme === "dark" ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    await cdp.send("Emulation.setDefaultBackgroundColorOverride", { color: ground }).catch(() => {});
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  } catch (err) {
    await closeTab(chrome, cdp);
    throw err;
  }
  return cdp;
}

async function closeTab(chrome, cdp) {
  cdp.close();
  await chrome.browser.send("Target.closeTarget", { targetId: cdp.targetId }, 5_000).catch(() => {});
}

// Opens the address and waits for its load event, at most 20 s: a page that
// never finishes loading (a stuck tracking script) is read as it stands.
// Another #route of the page already open loads nothing (Chrome answers
// with no loader for it), so there is no load event to wait for: only for
// the page to move to it, which comes after the answer, 2 s at most.
// Returns the address the tab ended on, after any redirects, and the HTTP
// status the page came with. An address that answers with a file to
// download, at once or after a redirect, is refused: the browser saves
// nothing (see launch()), and there is no page to take.
const NOT_A_PAGE = "a file to download instead of a page";

async function navigate(cdp, url) {
  let onLoad;
  let onMove;
  let timer;
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", (onLoad = resolve)));
  const moved = new Promise((resolve) => cdp.on("Page.navigatedWithinDocument", (onMove = resolve)));
  try {
    const { errorText, loaderId, isDownload } = await cdp.send("Page.navigate", { url });
    if (isDownload) throw Object.assign(new Error(`Could not open ${url}: it answers with ${NOT_A_PAGE}.`), { refused: NOT_A_PAGE });
    // reason: the browser's own words, for a page left out over it.
    if (errorText) throw Object.assign(new Error(`Could not open ${url}: ${errorText}`), { reason: errorText });
    // The wait is cleared once the page has loaded: left running, it kept
    // the process alive that long after the last page.
    const limit = loaderId ? Math.max(1_000, Math.min(20_000, timeLeft() - 60_000)) : 2_000;
    await Promise.race([loaderId ? loaded : moved, new Promise((resolve) => (timer = setTimeout(resolve, limit)))]);
  } finally {
    clearTimeout(timer);
    cdp.off("Page.loadEventFired", onLoad);
    cdp.off("Page.navigatedWithinDocument", onMove);
  }
  const finalUrl = await currentUrl(cdp, url);
  const { result } = await cdp
    .send("Runtime.evaluate", { expression: "(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0", returnByValue: true }, 5_000)
    .catch(() => ({ result: {} }));
  return { url: finalUrl, status: Number(result && result.value) || 0 };
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
  for (const { child, profile, lock } of open) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
    browsers.push({ profile, lock: lock || lockFolderOf(profile) });
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
  for (const { profile, lock } of browsers) {
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
  }
}

module.exports = { findChrome, onPath, launch, connect, openTab, closeTab, navigate, currentUrl, killBrowsers, removeProfiles, removeStrayLocks, roomIn, lockFolderOf, userAgentFor };
