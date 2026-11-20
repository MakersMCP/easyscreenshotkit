"use strict";

// A site's pages worth showing, captured clean on the devices asked for.
// What comes out, in one folder:
//
//   SCREENSHOTS.md        every page: why it was picked, its files and the
//                         headings on its first screen, for people and agents
//   manifest.json         the same, for scripts
//   sheet.png             all pages on one picture
//   01-home-desktop.png   the first screen at 2x, 3200x1800
//   01-home-mobile.png    the first screen on a phone, 1080x1920
//   01-home-full.png      the whole page, 1600 wide
//   02-pricing-…          the same for every page picked
//   pwa/                  with --pwa, screenshots for a web app manifest
//                         and the manifest entries for them (see pwa.js)
//
// The home page comes first. Its links (and the sitemap, as a fallback) give
// the other candidates; each one is opened, and kept only when it is a page
// of its own: not a redirect to a sign-in page or to the home page, not a
// bot check, not the same page as one already kept.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { launch, browserProblem, openTab, closeTab, navigate, currentUrl, CRASHED, BARRED } = require("./chrome");
const { AROUND, metrics, scrollTo, walk, showsContent, waitForContent, settle, watchRequests, networkQuiet, waitForDrawn, showsLoadingSign, looksEmpty, waitForFonts, clearHover, resetPictureWait, capture, captureScreen, capturePage } = require("./page");
const { clean } = require("./clean");
const { homeOf, pageKey, routeOf, viewKey, pathOf, pageUrl, anchorOf, siteOf, fold, wordsOf, kindOf, rankLinks, routeLinks, visitOrder, readSiteIndex, indexNotes, localeOf, alternateFor, oneLine, ROUTE_LINK } = require("./pick");
const { pngFileIsWhole, pngSize, tagPng } = require("./png");
const { PWA_SHOTS, LOOKED_AT, planPwa, checkManifest } = require("./pwa");
const { renderSheet } = require("./sheet");
const { begin, checkDir, realFolder } = require("./outdir");
const { setTimeLimit, timeLeft, sleep } = require("./time");
const { guardFor, hostRefusals, unresolvedError, refusedError } = require("./address");
const { hideRefusal, shownSelector } = require("./steps");
const programs = require("./programs");
const version = require("./version");

// The devices a size names. Desktop at 1600x900 shows a site's full menu
// (narrower windows hide it behind a button); 2x keeps small text sharp for
// image and video models. A phone is 9:16, the shape of a vertical video and
// of Google Play's screenshots; an iPhone is the App Store's 6.9" size.
const DEVICES = {
  desktop: { width: 1600, height: 900, scale: 2, mobile: false, touch: false, agent: "desktop" },
  mobile: { width: 360, height: 640, scale: 3, mobile: true, touch: true, agent: "android" },
  iphone: { width: 440, height: 956, scale: 3, mobile: true, touch: true, agent: "iphone" },
};
const SIZE_WORDS = { desktop: "first screen, desktop", mobile: "first screen, phone", iphone: "first screen, iPhone", full: "whole page, desktop", "mobile-full": "whole page, phone" };
// A whole page stops here: an endless feed would otherwise never end.
const MAX_HEIGHT = 15_000;

// "desktop,mobile,full" as the devices to open each page on and what to
// take on each: [{key, device, shots: [{size, full, scale}]}]. A whole page
// is taken on the first desktop size listed (or the desktop), a phone's whole
// page on the phone.
function parseSizes(text) {
  const names = String(text || "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (!names.length) throw new Error("--sizes needs at least one size");
  const groups = new Map();
  const wholes = [];
  let firstDesktop = "";
  for (const name of names) {
    const m = /^(desktop|mobile|iphone|full|mobile-full|(\d{3,4})x(\d{3,4}))(?:@(\d+(?:\.\d+)?)x?)?$/.exec(name);
    if (!m) throw new Error(`Unknown size: ${name}. Use desktop, mobile, iphone, full, mobile-full or WxH, each with an optional @scale`);
    const scale = m[4] === undefined ? null : Number(m[4]);
    if (scale !== null && !(scale >= 0.5 && scale <= 4)) throw new Error(`${name}: a scale goes from 0.5 to 4`);
    if (m[1] === "full" || m[1] === "mobile-full") {
      if (wholes.some((whole) => whole.size === m[1])) throw new Error(`${m[1]} is given twice in --sizes`);
      wholes.push({ size: m[1], scale: scale || (m[1] === "full" ? 1 : 2) });
      continue;
    }
    let device;
    let size;
    if (DEVICES[m[1]]) {
      size = m[1];
      device = { ...DEVICES[size], ...(scale ? { scale } : {}) };
    } else {
      const width = Number(m[2]);
      const height = Number(m[3]);
      if (width < 240 || width > 3840 || height < 240 || height > 3840) throw new Error(`${name}: width and height go from 240 to 3840`);
      const phone = width < 600;
      size = `${width}x${height}`;
      device = { width, height, scale: scale || 1, mobile: phone, touch: phone, agent: phone ? "android" : "desktop" };
    }
    if (groups.has(size)) throw new Error(`${size} is given twice in --sizes`);
    groups.set(size, { key: size, device, shots: [{ size, full: false }] });
    if (!device.mobile && !firstDesktop) firstDesktop = size;
  }
  for (const whole of wholes) {
    const key = whole.size === "mobile-full" ? "mobile" : firstDesktop || "desktop";
    if (!groups.has(key)) groups.set(key, { key, device: { ...DEVICES[key] }, shots: [] });
    groups.get(key).shots.push({ size: whole.size, full: true, scale: whole.scale });
  }
  return [...groups.values()];
}

// --pwa adds a capture for a web app manifest to the windows the run opens
// anyway when it can: the wide one to a 1600x900 desktop (taken at 1.2x
// whatever the window's own scale), the narrow one to the 360x640 phone at
// 3x. Otherwise each gets a window of its own. It is taken before a whole
// page, which scrolls the page.
function addPwaShots(groups) {
  for (const [form, want] of Object.entries(PWA_SHOTS)) {
    const shot = { size: `pwa-${form}`, full: false, pwa: form, scale: want.scale };
    const host = groups.find(
      ({ device }) =>
        device.width === want.width &&
        device.height === want.height &&
        device.mobile === want.mobile &&
        (!want.mobile || (device.scale === want.scale && device.agent === "android")),
    );
    if (!host) {
      groups.push({ key: shot.size, device: { ...(want.mobile ? DEVICES.mobile : DEVICES.desktop), scale: want.scale }, shots: [shot] });
      continue;
    }
    const whole = host.shots.findIndex((other) => other.full);
    host.shots.splice(whole < 0 ? host.shots.length : whole, 0, shot);
  }
  return groups;
}

// "acme.com", "www.acme.com/pricing" and "https://acme.com" all mean a web
// address; anything that is not http(s) is refused.
function parseAddress(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("Give a website address, for example: easyscreenshotkit acme.com");
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`Not a web address: ${text}`);
  }
  if (!/^https?:$/.test(url.protocol) || !url.hostname) throw new Error(`Not a web address: ${text}`);
  return url;
}

// The address to open. A #route stays: it opens a view of a single page
// app. Any other fragment goes, as it always did: an anchor is a place on
// the page, and what a sign-in leaves there (#access_token=…) is not for
// the files a run writes. fragmentNotes() says so.
function normalizeUrl(raw) {
  const url = parseAddress(raw);
  if (!routeOf(url.href)) url.hash = "";
  return url.href;
}

// Whether a fragment reads as a plain name (#pricing, #section-2, #L42,
// #2024-recap, #Installation), which a note may repeat, and not as a key or
// a token: a sign-in's access_token=…, a UUID, a hex or base64 string. Each
// of its words, between the - . _ and ~ in it, is letters in one case or
// capitalized, with at most three digits after them, or a number of at most
// four digits, and 20 characters at most. A key mixes the case of its
// letters, or its digits and letters, within a word.
const PLAIN_WORD = /^(?:(?:[a-z]+|[A-Z][a-z]*|[A-Z]+)\d{0,3}|\d{1,4})$/;
const plainName = (fragment) => {
  if (!/^#[A-Za-z0-9._~-]{1,40}$/.test(fragment)) return false;
  const words = fragment.slice(1).split(/[._~-]/).filter(Boolean);
  return words.length > 0 && words.every((word) => word.length <= 20 && PLAIN_WORD.test(word));
};

// A note for the address and for each --page that came with a fragment
// left out (see normalizeUrl): the page opens at its top. The fragment is
// shown only when it reads as a plain name, so what a sign-in or a shared
// link left there is not written into the report.
function fragmentNotes(rawUrl, extra, asked, home) {
  const notes = [];
  const note = (where, url) => {
    const fragment = anchorOf(url);
    if (!fragment) return;
    const shown = plainName(fragment) ? fragment : "a fragment";
    notes.push(`${where} ends in ${shown}, which is no #route (#/ or #!): it was left out, and the page opens at its top.`);
  };
  note("The address given", parseAddress(rawUrl));
  for (const raw of extra) {
    const base = String(raw).trim().startsWith("#") ? asked : home;
    const url = pageUrl(raw, base);
    if (url) note(`--page ${pathOf(url.href)}`, new URL(String(raw).trim(), base));
  }
  return notes;
}

// Files a run writes, by name: a manifest someone edited cannot point the
// run at anything else in the folder. With --pwa, also these in pwa/ and
// pwa/screenshots/.
const RUN_FILE = /^(\d{2}-[a-z0-9-]+\.png|sheet\.png|manifest\.json|SCREENSHOTS\.md)$/;
const PICTURE = /^\d{2}-[a-z0-9-]+\.png$/;
const PWA_DIR = "pwa";
const PWA_PICTURE = /^(wide|narrow)-\d{2}\.png$/;
const PWA_FILES = [
  [path.join(PWA_DIR, "screenshots"), PWA_PICTURE],
  [PWA_DIR, /^manifest-screenshots\.json$/],
];

// An earlier run's files in dir, as paths inside it. Those in pwa/ only
// when pwa and pwa/screenshots are folders of their own: through a link,
// they would be someone's files elsewhere.
function earlierFiles(dir) {
  const files = (sub, name) => {
    if (sub && !realFolder(dir, sub)) return [];
    try {
      return fs.readdirSync(path.join(dir, sub), { withFileTypes: true }).filter((entry) => !entry.isDirectory() && name.test(entry.name)).map((entry) => path.join(sub, entry.name));
    } catch {
      return [];
    }
  };
  return [...files("", RUN_FILE), ...PWA_FILES.flatMap(([sub, name]) => files(sub, name))];
}

// The run's folder, for outdir.js: created when missing, used when it is
// empty or an earlier easyscreenshotkit run made it, whose files the new
// run's replace once it has ended well, refused when it holds anything
// else, so a run never mixes into or overwrites someone's own files.
function shotsSpec({ pwa = false } = {}) {
  return {
    marker: "manifest.json",
    // Runs from when the tool was called easyscreenshot count too.
    accepts: (old) => old.version === 1 && /^easyscreenshot(kit)? /.test(String(old.tool || "")),
    refusal: (dir) => `${dir} is not empty and holds no earlier easyscreenshotkit run. Pick another folder with --out.`,
    earlier: earlierFiles,
    files: ["manifest.json", "SCREENSHOTS.md", "sheet.png", ...(pwa ? [path.join(PWA_DIR, "manifest-screenshots.json")] : [])],
    folders: pwa ? [PWA_DIR, path.join(PWA_DIR, "screenshots")] : [],
    // A picture's name is known only once its page is found, so a folder
    // named like any of them is in the way, found before the run and not
    // at its end.
    claim: (dir, target) => {
      for (const [sub, name] of [["", PICTURE], ...(pwa ? [[path.join(PWA_DIR, "screenshots"), PWA_PICTURE]] : [])]) {
        let entries = [];
        try {
          entries = fs.readdirSync(path.join(target, sub), { withFileTypes: true });
        } catch {
          continue;
        }
        const folder = entries.find((entry) => entry.isDirectory() && name.test(entry.name));
        if (folder) throw new Error(`${path.join(dir, sub, folder.name)} is a folder named like the pictures this run saves there. Move it, or pick another folder with --out.`);
      }
    },
    tidy: [path.join(PWA_DIR, "screenshots"), PWA_DIR],
  };
}

// Opens a run of the screenshots in dir (see outdir.js).
function openShots(dir, { pwa = false } = {}) {
  return begin(dir, shotsSpec({ pwa }));
}

// Whether a run of the screenshots may save in dir: it is missing, empty or
// holds an earlier run. Throws the reason when it may not. Since 0.1.2 it
// changes nothing: an earlier run's files stay until a new run has ended
// well, and a run that does not end well leaves them as they were.
function prepareDir(dir, { pwa = false } = {}) {
  checkDir(dir, shotsSpec({ pwa }));
}

const decoded = (part) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

const slugWords = (text) =>
  fold(text)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

// A page's name in file names: home, pricing, product-teams. A view of a
// single page app adds its #route: app-plants for /app/#/plants,
// home-plant-fern for /#/plant/Fern. A route with letters or digits a file
// name does not keep adds view and six hex digits of its own, alone
// (#/растения, #/植物) or after the words it does keep (#/plant/Фикус), so
// it is told from its page and from the app's other views.
function slugOf(url, home) {
  let slug = "home";
  if (pageKey(url) !== pageKey(home)) {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const inner = localeOf(new URL(url).pathname) ? parts.slice(1) : parts;
    slug = slugWords(fold(inner.map(decoded).join("-")).replace(/\.[a-z0-9]+$/, "")) || "page";
  }
  const route = routeOf(url);
  if (!route) return slug;
  const parts = route.replace(/^#(?:\/|!\/?)/, "").split("/").filter(Boolean).map(decoded);
  const words = slugWords(parts.join("-"));
  const lost = /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(fold(parts.join("-")).replace(/[a-z0-9]/g, ""));
  const own = `view-${crypto.createHash("sha1").update(parts.join("/")).digest("hex").slice(0, 6)}`;
  return [slug, ...(words ? [words] : []), ...(lost || !words ? [own] : [])].join("-");
}

// The keys a page kept is known by, so another address for it is not taken
// again, and the address its files are named after. A page asked for with
// a #route is the view it ended on. One asked for without is its page,
// whatever route the app went to by itself.
function identity(asked, landed, canonical = "") {
  if (routeOf(asked)) return { keys: new Set([viewKey(asked), viewKey(landed)]), named: landed };
  const keys = new Set([pageKey(asked), pageKey(landed), viewKey(landed)]);
  try {
    if (canonical) keys.add(pageKey(canonical));
  } catch {
    // A canonical link that is not an address says nothing.
  }
  return { keys, named: landed.split("#")[0] };
}

// The pages asked for with --page, as the addresses to open, each with its
// fragment. A path is read from the home page, a fragment alone
// ("#/plants") from the address given, as a view of that page.
function pagesAsked(extra, asked, home) {
  return extra.map((raw) => {
    const url = pageUrl(raw, String(raw).trim().startsWith("#") ? asked : home);
    if (!url || siteOf(url.href) !== siteOf(home)) throw new Error(`--page ${raw} is not a page of ${siteOf(home)}`);
    return url.href;
  });
}

// Whether a page went somewhere other than the address asked: another view
// for an address with a #route, another page for one without.
function movedOn(asked, landed) {
  return routeOf(asked) ? viewKey(landed) !== viewKey(asked) : pageKey(landed) !== pageKey(asked);
}

// The parts of a title, at a separator with spaces on both sides or a colon
// with one after it: "Acme | Payments for teams" and "Acme: Payments for
// teams" are Acme and Payments for teams.
const titleParts = (title) => String(title || "").split(/\s+[|·•:–—-]\s+|:\s+/);

// The site's name: og:site_name, else a part of the title, else the first
// part of og:title, else the host name: its first label, or the whole of an
// address by number, with its port. A part over 40 characters is no name.
// A title names its page or view too, before the site or after it. So the
// part that says the site's own name is the site, when one does (see
// ownPart): "Brightmoss · Settings" on #/settings/profile has the shape of
// "Projects · Acme" on #/acme/board, with the site on the other side, and
// only such a name tells the two apart. Else, of a page below the home
// page, it is the first part that does not name the page, by its own
// heading, the first h1 outside the bars around it, where a site can put
// its own name, or by the last word of its path: "Today · Brightmoss" on
// /app/ whose heading is Today, and "Pricing · Brightmoss" on
// /pricing.html, are both Brightmoss. Of a home page it is the first part,
// as "Acme | Payments for teams" is Acme. Of a #route view, whose title
// names the view mostly first, it is the last part that does not name the
// view: "Plants · Brightmoss" and "Brightmoss · Plants" on #/plants are
// both Brightmoss. A part names the view when it says the route's last
// word, or the view's own heading. The route's other words count only once
// its last word is named: on #/acme/board, "Projects · Acme" is Acme, and
// on #/plant/Fern, "Brightmoss · Plant · Fern" is Brightmoss. When they
// leave no part, they do not count ("Acme · Projects" on #/acme/projects is
// Acme), and when the last word and the heading leave none either, it is
// the title's last part, as an app can be called what its route is: "Your
// plants | Plants".
function siteName(info, url) {
  if (info.siteName) return info.siteName;
  const parts = titleParts(info.title);
  let part = parts[0];
  const route = routeOf(url);
  const named = (text) => wordsOf(text).join(" ");
  // The words that name the page: its route's, for a view, or the last
  // part of its path, without its extension or a language in front of it.
  // A home page has none, and its heading does not name it: a site can
  // have its own name as the heading of its home page.
  const words = route ? route.replace(/^#(?:\/|!\/?)/, "").split("?")[0].split("/").filter(Boolean).map(decoded).map(named) : pathWords(url);
  const heading = route || words.length ? named(info.viewHeading || "") : "";
  const namesPage = (text) => Boolean(named(text)) && (named(text) === words.at(-1) || named(text) === heading);
  const own = ownPart(parts, url, info.appName, namesPage);
  if (own) part = own;
  else if (!route) {
    const fewer = parts.filter((text) => !namesPage(text));
    part = (fewer.length ? fewer : parts)[0];
  } else {
    const last = words.length > 0 && parts.some((text) => named(text) === words.at(-1));
    const without = (view) => parts.filter((text) => !view.has(named(text)));
    const fewer = without(new Set([...(last ? [words.at(-1)] : []), heading].filter(Boolean)));
    const fewest = last ? without(new Set([...words, heading].filter(Boolean))) : fewer;
    part = (fewest.length ? fewest : fewer.length ? fewer : parts).at(-1);
  }
  part = part.trim();
  if (part && part.length <= 40) return part;
  const og = titleParts(info.ogTitle)[0].trim();
  if (og && og.length <= 40) return og;
  // 127.0.0.1 is not named 127.
  const { hostname, host } = new URL(url);
  if (/^\d+(\.\d+){3}$/.test(hostname) || hostname.startsWith("[")) return host;
  const label = hostname.replace(/^www\./, "").split(".")[0];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// The part of a title that says a site's own name, or "": the page's
// application-name, or a label of the host's name, the one nearest its
// top-level label first (acme before app in app.acme.com), told by their
// letters and digits. A label can be the page's own name too, as on
// plants.example/#/plants or dashboard.acme.com/#/dashboard: a part that
// names the page (namesPage) is not taken for a label's.
function ownPart(parts, url, appName = "", namesPage = () => false) {
  const bare = (text) => wordsOf(text).join("");
  const app = bare(appName);
  const declared = app && parts.find((text) => bare(text) === app);
  if (declared) return declared;
  const { hostname } = new URL(url);
  const byNumber = /^\d+(\.\d+){3}$/.test(hostname) || hostname.startsWith("[");
  const labels = byNumber ? [] : hostname.split(".").slice(0, -1).filter((label) => label !== "www").reverse();
  for (const name of labels.map(bare).filter(Boolean)) {
    const found = parts.find((text) => bare(text) === name && !namesPage(text));
    if (found) return found;
  }
  return "";
}

// The words of the last part of a page's path, as a title would say them:
// /pricing.html is pricing, /plans-and-pricing/ is plans and pricing, and a
// home page, at the site's root or its language's, has none.
function pathWords(url) {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const inner = localeOf(new URL(url).pathname) ? segments.slice(1) : segments;
  if (!inner.length) return [];
  return [wordsOf(decoded(inner.at(-1)).replace(/\.[a-z0-9]+$/i, "")).join(" ")].filter(Boolean);
}

// A bot check served instead of the page (a CAPTCHA, "Just a moment…"). A
// form's reCAPTCHA or Turnstile script on a real page is common, so a script
// counts only on a short page with almost no links.
const CHALLENGE_TITLE = /human verification|just a moment|attention required|access denied|verify you are human|are you a robot|security check|checking your browser|pardon our interruption|ddos-guard|one more step|request blocked|captcha/i;
const CHALLENGE_SRC = /challenges\.cloudflare\.com|hcaptcha\.com|google\.com\/recaptcha|recaptcha\.net|captcha-delivery\.com|px-cdn\.net|perimeterx|awswaf/i;
const SIGN_IN = /(^|[./])(log-?in|sign-?in|sign-?up|auth|oauth|sso|accounts?|giris|oturum|register|session)([./?#_-]|$)/i;

// A heading that carries its words twice (once for the eye, once for screen
// readers) is read once.
const ONCE = `((text) => {
  const words = text.split(" ");
  const half = words.length / 2;
  return words.length % 2 === 0 && words.slice(0, half).join(" ") === words.slice(half).join(" ") ? words.slice(0, half).join(" ") : text;
})`;

const READ_INFO = `(() => {
  const once = ${ONCE};
  // A page's own words, on one line as the title and the heading are: a
  // line break in a meta tag's content would make a line of its own where
  // the site's name and the description are written.
  const meta = (selector) => ((document.querySelector(selector) || {}).content || "").replace(/\\s+/g, " ").trim();
  const words = (el) => (el ? once(el.innerText.replace(/\\s+/g, " ").trim()).slice(0, 200) : "");
  const h1 = document.querySelector("h1");
  // The view's own heading: the first h1 that is not in a bar around it
  // (a menu, a side pane, the page's header or footer), where an app can
  // put its own name.
  const own = [...document.querySelectorAll("h1")].find((el) => !el.closest(${JSON.stringify(AROUND)}));
  const text = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim();
  return {
    title: document.title.trim(),
    description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
    siteName: meta('meta[property="og:site_name"]'),
    ogTitle: meta('meta[property="og:title"]'),
    appName: meta('meta[name="application-name"]'),
    heading: words(h1),
    viewHeading: words(own),
    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || "",
    manifest: (document.querySelector('link[rel~="manifest" i][href]') || {}).href || "",
    lang: (document.documentElement.lang || "").replace(/\\s+/g, " ").trim(),
    text: text.slice(0, 20000),
    scripts: [...document.querySelectorAll("script[src], iframe[src]")].map((el) => el.src).join(" ").slice(0, 20000),
    height: document.documentElement.scrollHeight,
    links: document.links.length,
    alternates: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((link) => ({ lang: link.hreflang, href: link.href })),
  };
})()`;

async function readInfo(cdp) {
  const { result } = await cdp.send("Runtime.evaluate", { expression: READ_INFO, returnByValue: true }, 10_000).catch(() => ({ result: {} }));
  const info = (result && result.value) || { title: "", description: "", siteName: "", ogTitle: "", appName: "", heading: "", viewHeading: "", canonical: "", manifest: "", lang: "", text: "", scripts: "", height: 0, links: 0, alternates: [] };
  const challenge =
    (CHALLENGE_TITLE.test(info.title) && (info.height < 1500 || info.links < 15)) || (CHALLENGE_SRC.test(info.scripts) && info.height < 1200 && info.links < 10);
  return { ...info, challenge, textHash: info.text ? crypto.createHash("sha1").update(info.text).digest("hex") : "" };
}

// Every link on the page with its words and where it sits: the header and
// menus, a big button on the first screen, the body, the footer. Links in a
// closed dropdown count: they are in the menu.
const READ_LINKS = `(() => {
  const out = [];
  const textOf = (a) => (a.innerText || a.textContent || a.getAttribute("aria-label") || a.title || (a.querySelector("img[alt]") || {}).alt || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  for (const a of document.querySelectorAll("a[href]")) {
    if (!/^https?:/i.test(a.href)) continue;
    let where = "body";
    if (a.closest('header, [role="banner"], nav, [role="navigation"]')) where = "header";
    else if (a.closest('footer, [role="contentinfo"]')) where = "footer";
    if (where === "body") {
      const r = a.getBoundingClientRect();
      const top = r.top + scrollY;
      if (r.width > 0 && r.height >= 28 && top < innerHeight) {
        const s = getComputedStyle(a);
        const filled = s.backgroundColor && s.backgroundColor !== "transparent" && !/^rgba\\(.*,\\s*0\\)$/.test(s.backgroundColor);
        if (filled || parseFloat(s.borderTopWidth) > 0 || /btn|button|cta/i.test(a.className)) where = "hero";
      }
    }
    out.push({ href: a.href, text: textOf(a), where });
  }
  return out;
})()`;

async function readLinks(cdp) {
  const { result } = await cdp.send("Runtime.evaluate", { expression: READ_LINKS, returnByValue: true }, 15_000).catch(() => ({ result: {} }));
  return (result && result.value) || [];
}

// The headings on the first screen, with their boxes in the image's own
// pixels (x, y, width, height), so a crop or a zoom does not have to guess.
const READ_HEADINGS = `((scale) => {
  const once = ${ONCE};
  const out = [];
  for (const el of document.querySelectorAll("h1, h2, h3, [role='heading']")) {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || parseFloat(s.opacity) === 0) continue;
    const text = once(el.innerText.replace(/\\s+/g, " ").trim());
    if (!text || text.length > 200) continue;
    const level = /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : Number(el.getAttribute("aria-level")) || 2;
    const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(innerWidth, r.right), y1 = Math.min(innerHeight, r.bottom);
    out.push({ text: text.slice(0, 120), level, box: [x0, y0, x1 - x0, y1 - y0].map((v) => Math.round(v * scale)) });
    if (out.length >= 20) break;
  }
  return out;
})`;

// Where each section of a whole page starts and ends, in the image's own
// pixels: a section is the block its heading opens (an h2, or h1 to h3 on a
// page with fewer than two h2s), down to where the next one starts.
const READ_SECTIONS = `((scale, limit) => {
  const once = ${ONCE};
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden"; };
  let heads = [...document.querySelectorAll("h2")].filter(shown);
  if (heads.length < 2) heads = [...document.querySelectorAll("h1, h2, h3")].filter(shown);
  const seen = new Set();
  const tops = [];
  for (const el of heads) {
    const text = once(el.innerText.replace(/\\s+/g, " ").trim());
    if (!text || text.length > 160) continue;
    let block = el.closest("section, article, [class*='section' i]");
    if (block && block.getBoundingClientRect().width < 0.6 * innerWidth) block = null;
    if (block && seen.has(block)) continue;
    if (block) seen.add(block);
    const top = Math.max(0, (block || el).getBoundingClientRect().top + scrollY - (block ? 0 : 24));
    if (top >= limit) continue;
    tops.push({ heading: text.slice(0, 120), top });
  }
  tops.sort((a, b) => a.top - b.top);
  return tops.slice(0, 40).map((s, i, all) => ({
    heading: s.heading,
    top: Math.round(s.top * scale),
    height: Math.round(((i + 1 < all.length ? all[i + 1].top : limit) - s.top) * scale),
  })).filter((s) => s.height > 0);
})`;

async function evaluate(cdp, expression, fallback) {
  const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true }, 15_000).catch(() => ({ result: {} }));
  return result && result.value !== undefined ? result.value : fallback;
}

// Why a page found by easyscreenshotkit is not kept, or "". What the address
// and the first look tell is checked at once; whether the page loaded and
// whether it repeats a page already kept, once it has settled.
function rejectAtOnce({ asked, nav, info }, { site, homeKey }) {
  if (nav.status >= 400) return `the page answered ${nav.status}`;
  if (info.challenge) return "a bot check instead of the page";
  if (siteOf(nav.url) !== site) return `redirected to ${new URL(nav.url).hostname}`;
  const landed = pageKey(nav.url);
  if (landed !== pageKey(asked)) {
    const where = new URL(nav.url);
    if (SIGN_IN.test(`${where.hostname}${where.pathname}`)) return "redirected to a sign-in page";
    if (landed === homeKey) return "redirected to the home page";
  }
  return "";
}

function rejectReason({ asked, nav, info, loaded }, check) {
  const first = rejectAtOnce({ asked, nav, info }, check);
  if (first) return first;
  if (loaded === false) return "still loading after 20 s";
  if (loaded === null) return "still loading as time ran short";
  const landed = pageKey(nav.url);
  let canonical = "";
  try {
    canonical = info.canonical ? pageKey(info.canonical) : "";
  } catch {
    // A canonical link that is not an address says nothing.
  }
  const same = check.kept.find((page) => page.keys.has(landed) || (canonical && page.keys.has(canonical)) || (info.textHash && page.textHash === info.textHash));
  return same ? `the same page as ${same.slug}` : "";
}

// A visit takes its first screenshot while FIRST_CAPTURE_MS of the run's
// time is left, so a run short of time still has its page, and each other
// one while CAPTURE_MS is, or the share of it a short run keeps (see
// reserveOf). Before the first one it hides what floats over the page and
// waits for the fonts, which with the end of a walk down the page can take
// BEFORE_CAPTURE_MS.
const FIRST_CAPTURE_MS = 5_000;
const CAPTURE_MS = 20_000;
const BEFORE_CAPTURE_MS = 7_000;

// What a run keeps of its time to open a page the user named, the address
// given or a --page, and a window of a page: PAGE_MS and WINDOW_MS, and in
// a run given less than RESERVE_FROM less of them, in step with its
// --timeout, so a page keeps a third of it at most. A run given 30 s kept
// 45 s for each page it was asked for, so it took none of them, and saved
// the home page alone.
const PAGE_MS = 45_000;
const WINDOW_MS = 30_000;
const RESERVE_FROM = 135_000;
const reserveOf = (ms, timeLimit) => Math.min(ms, (ms * timeLimit) / RESERVE_FROM);

// A view of a single page app, the address asked or the one the app went
// to, draws once its data has come: up to VIEW_WAIT_MS for that, but never
// into the time its screenshots need, then the address it shows by then.
// busy: the page still had requests going when an earlier window of it was
// taken, so this one waits BUSY_WAIT_MS at most. started: when the wait
// began, for a wait that goes on after the app went to another route.
// Returns "quiet", "busy" when it was still loading at the limit, or
// "short" when it still was as the run's time ran short.
const VIEW_WAIT_MS = 10_000;
const BUSY_WAIT_MS = 2_000;

async function waitForView(tab, nav, asked, busy, started = Date.now()) {
  if (!routeOf(asked) && !routeOf(nav.url)) return "quiet";
  const state = await waitForDrawn(tab, { limitMs: busy ? BUSY_WAIT_MS : VIEW_WAIT_MS, reserveMs: FIRST_CAPTURE_MS + BEFORE_CAPTURE_MS, started });
  nav.url = await currentUrl(tab, nav.url);
  return state;
}

// The note on a page's version in the language asked for that was not
// taken (what: why, after its address), as the home page was taken instead.
function alternateNote(alternate, lang, what) {
  return `The home page names its ${alternate.lang} version at ${alternate.href}, ${what}, and the home page was taken with ${lang} as the browser's language.`;
}

// Why a page that could not be opened is left out.
// The note for a selector given to hide that the browser did not read as a
// CSS selector: it hid nothing.
function unreadNote(selector) {
  return `The selector ${shownSelector(selector)} to hide hid nothing: the browser does not read it as a CSS selector.`;
}

function notOpened(err) {
  if (err.refused) return err.refused;
  return /timed out/.test(err.message) ? `too slow to answer (${err.message})` : `could not be opened: ${err.reason || err.message}`;
}

// What the wait for a #route view's data saw by the time a window of it
// was taken, as a note: "" when the data had come, or the view looks drawn.
// A window taken before it had come shows the view's loading screen.
function dataNote(result) {
  if (result.busy) return `still loading data after ${result.waited / 1000} s`;
  if (result.short) return "taken before its data had come: time ran short; give more with --timeout";
  return "";
}

// The same for a view that looks drawn while a request of it stays open, as
// a long poll keeps one for as long as the page is there.
function openNote(result) {
  if (result.open === "busy") return `a request was still open after ${result.waited / 1000} s`;
  if (result.open === "short") return "a request was still open as time ran short; give more with --timeout";
  return "";
}

// A page's note on what it tried to open that the run does not open: the
// page itself, by moving on once it had loaded, a frame of it, or a window
// it opened.
// handed: an address of another kind, as mailto:, on a system where the
// browser may have handed it to a program of the machine (see standIns in
// chrome.js).
function barredNote(b) {
  const url = String(b.url).slice(0, 200);
  const end = b.handed ? "the browser may have handed it to a program of this machine" : "it was not opened";
  if (b.main) return `it tried to open ${url}, which is ${b.why}: ${end}`;
  if (b.window) return `it tried to open a window at ${url}, which is ${b.why}: ${end}`;
  return `a frame of it tried to open ${url}, which is ${b.why}: ${end}`;
}

// The notes on the downloads a page started, which the browser refused:
// BARRED_SHOWN at most, and how many more.
function downloadNotes(downloads = []) {
  const notes = downloads.slice(0, BARRED_SHOWN).map((url) => `it started a download of ${String(url).slice(0, 200)}, which the browser refused: no file was saved`);
  const more = downloads.length - BARRED_SHOWN;
  if (more > 0) notes.push(`it started ${more === 1 ? "1 more download" : `${more} more downloads`}, which the browser refused: no file was saved`);
  return notes;
}

// Of what a page tried to open that the run does not open, the notes it
// gets: the page's own first, then its windows, then its frames, BARRED_SHOWN
// at most, and how many more. Taken as they came, a page whose frames were
// refused first had its own move left out of its notes.
const BARRED_SHOWN = 3;

function barredNotes(barred = []) {
  const rank = (b) => (b.main ? 0 : b.window ? 1 : 2);
  const sorted = [...barred].sort((a, b) => rank(a) - rank(b));
  const notes = sorted.slice(0, BARRED_SHOWN).map(barredNote);
  const more = sorted.length - BARRED_SHOWN;
  if (more > 0) notes.push(`it, its frames or its windows tried to open ${more === 1 ? "1 more address, which was" : `${more} more addresses, which were`} not opened`);
  return notes;
}

// What the waits for a window of a page saw by the time it was taken, as
// notes, and only what they waited for: a run short of time waits less.
function waitNotes(result) {
  const notes = [];
  if (result.loaded === false) notes.push("still showed a loading screen after 20 s");
  const data = dataNote(result) || openNote(result);
  if (data) notes.push(data);
  if (!result.short && result.loaded === null) notes.push("taken while it still showed a loading screen: time ran short; give more with --timeout");
  return notes;
}

// Opens one page on one device in one theme and takes the captures the
// device holds. check: decide first whether the page is kept (see
// rejectReason); links: read the page's links too, after a walk down it
// so lazy parts are there; routes: read its links as it stands, for the
// #routes in its menu.
//
// A page can move on by itself to another document once it has loaded, as
// one that sends the visitor on to a welcome page a second later does, or
// one that moves on as the run turns the wheel: navigate() follows a page
// only to its load event. Such a page was saved under its own address, name
// and reason, with no note, while the pictures showed the page it moved to,
// or a mix of the two. So the document taken is known by its loader, the one
// that fired the page's first load event, and the page's commits are heard
// from before it is opened: a page that commits another document after that,
// before navigate() has returned, as one that moves on the moment it has
// loaded does, before it is taken or while it is, is waited for again and
// taken as the page it moved to, by that page's own address, title and
// heading, which keep() names in a note (movedFrom: where it was). A page
// the run picked itself is then judged by where it moved to, as one that
// redirects is, so a second address for a page already taken is left out. A
// page that moves on again is followed MOVES times; after that it is taken
// as it stands, as one that reloads itself every few seconds is, its address
// and its words read again as it is taken.
const MOVES = 2;

async function visit(chrome, page, group, theme, ctx, { check = null, links = false, routes = false } = {}) {
  const tab = await openTab(chrome, group.device, { lang: ctx.lang, theme, reducedMotion: ctx.reducedMotion });
  try {
    resetPictureWait(tab);
    await watchRequests(tab);
    // What the page, a frame of it or a window it opens tried to open at an
    // address the run does not open, which was not loaded (see openTab):
    // its notes say so. Heard from before the page is opened, as a page can
    // move on the moment it has loaded. One that moved on before it had
    // loaded is not taken at all (see navigate()).
    const barred = [];
    tab.on(BARRED, (b) => {
      if (!barred.some((known) => known.url === b.url)) barred.push(b);
    });
    // The downloads the page started, which the browser refused (see
    // launch()): a page that thanks for a download and sends the browser to
    // the file is taken as it is drawn, and its notes say so.
    const downloads = [];
    tab.on("Page.downloadWillBegin", (p) => {
      if (p.url && !downloads.includes(p.url)) downloads.push(p.url);
    });
    // The document the main frame shows, by its loader, and the address of
    // each it committed; the one taken (doc), at first the one that fired
    // the first load event.
    let current = "";
    let doc = "";
    const urls = new Map();
    tab.on("Page.frameNavigated", ({ frame }) => {
      if (!frame || frame.parentId || !frame.loaderId) return;
      current = frame.loaderId;
      urls.set(current, `${frame.url}${frame.urlFragment || ""}`);
    });
    tab.on("Page.loadEventFired", () => (doc = doc || current));
    let nav = await navigate(tab, page.url);
    doc = doc || current;
    let movedFrom = "";
    for (let round = 0; ; round++) {
      const last = round >= MOVES;
      const taken = doc;
      const moved = () => !last && current !== taken;
      const got = await takeOpen(tab, nav, page, group, theme, ctx, { check, links, routes, moved });
      if (got !== MOVED) {
        // The last round takes the page as it stands: one that moved on
        // meanwhile is named as it is now.
        if (last && current !== taken && got.shots) {
          got.nav.url = await currentUrl(tab, got.nav.url);
          const now = await readInfo(tab);
          Object.assign(got.info, { title: now.title, heading: now.heading, viewHeading: now.viewHeading, description: now.description, lang: now.lang, textHash: now.textHash });
        }
        return { ...got, barred, downloads, ...(movedFrom && movedOn(movedFrom, got.nav.url) ? { movedFrom } : {}) };
      }
      movedFrom = movedFrom || urls.get(taken) || nav.url;
      // The page it moved to is a new one: none of the waits, the clean-up
      // or what was drawn of the one before holds for it. It is taken by
      // the document there is as it is waited for: one it moves on to in
      // turn makes another round.
      tab.stopped = null;
      resetPictureWait(tab);
      doc = current;
      nav = await movedTo(tab, nav.url);
    }
  } finally {
    await closeTab(chrome, tab);
  }
}

// What takeOpen() gives for a page that moved on to another document before
// it was taken, or while it was.
const MOVED = Symbol("moved");

// The page a visit's page moved on to once it had loaded, waited for as
// navigate() waits for a page: until it has loaded, 20 s at most and never
// into the last minute of the run, and read as navigate() reads one, its
// address and the HTTP status it came with.
async function movedTo(tab, fallback) {
  const until = Date.now() + Math.max(1_000, Math.min(20_000, timeLeft() - 60_000));
  while (Date.now() < until && !(tab.closed && tab.closed())) {
    const { result } = await tab.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, 5_000).catch(() => ({ result: {} }));
    if (result && result.value === "complete") break;
    await sleep(250);
  }
  const url = await currentUrl(tab, fallback);
  const { result } = await tab.send("Runtime.evaluate", { expression: "(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0", returnByValue: true }, 5_000).catch(() => ({ result: {} }));
  return { url, status: Number(result && result.value) || 0 };
}

// The part of a visit once its page is open: the waits, the clean-up and the
// captures, and what decides whether a page the run picked is kept.
// moved(): whether the page has committed another document since this part
// began, as it is asked before each step whose outcome the page it moved to
// would change: then MOVED, and the visit starts this part over.
async function takeOpen(tab, nav, page, group, theme, ctx, { check, links, routes, moved }) {
  // A bot check, an error or a redirect to a sign-in page is known at once:
  // no need to wait for it to settle.
  const glance = await readInfo(tab);
  if (moved()) return MOVED;
  if (check) {
    const reason = rejectAtOnce({ asked: page.url, nav, info: glance }, check);
    if (reason) return { rejected: reason, nav, info: glance };
  } else if (glance.challenge || nav.status >= 400) {
    return { nav, info: glance, loaded: false, links: [], shots: [], cleaned: { hidden: 0, signs: 0, unlocked: false, badSelectors: [] } };
  }
  const opened = Date.now();
  let view = await waitForView(tab, nav, page.url, page.busy, opened);
  let loaded = await waitForContent(tab, 20_000);
  await settle(tab, 6_000);
  const info = await readInfo(tab);
  if (moved()) return MOVED;
  if (check) {
    const reason = rejectReason({ asked: page.url, nav, info, loaded }, check);
    if (reason) return { rejected: reason, nav, info };
  }
  const full = group.shots.some((shot) => shot.full);
  // Lazy parts render, footers load, and boxes that come up on scrolling
  // come up before the clean-up. A first screen alone needs no walk.
  if (full || links) await walk(tab, MAX_HEIGHT);
  else await scrollTo(tab, 0);
  const found = links || routes ? await readLinks(tab) : null;
  const m0 = await metrics(tab);
  // With --no-clean only what --hide names is hidden. A selector of hide
  // the browser does not read as one hides nothing, and the run's notes
  // say so.
  const tidy = async () => {
    const done = ctx.clean || ctx.hide.length ? await clean(tab, { hide: ctx.hide, viewport: { width: m0.width, height: m0.viewportHeight }, auto: ctx.clean }) : { hidden: 0, signs: 0, unlocked: false, badSelectors: [] };
    for (const selector of done.badSelectors || []) if (ctx.unread && ctx.hide.includes(selector)) ctx.unread.add(selector);
    return done;
  };
  // Whether a view whose wait ended before it was ready shows a loading
  // sign by then, read before the clean-up: that hides a fixed box that
  // says Loading as it hides any other.
  const signAfterWait = async () => view !== "quiet" && (await showsLoadingSign(tab));
  let sign = await signAfterWait();
  let cleaned = await tidy();
  // The loading signs among the boxes the clean-up hid after the sign was
  // last read: a sign gone since may only be hidden. A box that showed
  // none, a chat bubble say, says nothing of it, and nor does one hidden
  // before.
  let signsHidden = cleaned.signs;
  await waitForFonts(tab);
  await scrollTo(tab, 0);
  await sleep(400);
  // An app can go to another route of its own after the waits, as one
  // whose sign-in check answers late does: the address is read again, and
  // the view it went to is waited for within the same wait.
  let routeMoved = false;
  if (routeOf(page.url) || routeOf(nav.url)) {
    const before = viewKey(nav.url);
    nav.url = await currentUrl(tab, nav.url);
    routeMoved = viewKey(nav.url) !== before;
  }
  if (routeMoved) {
    view = await waitForView(tab, nav, page.url, page.busy, opened);
    await settle(tab, 6_000);
    sign = await signAfterWait();
    // The first clean-up's boxes stay hidden, and this one counts only
    // what came since. The report adds the two up.
    const again = await tidy();
    signsHidden = again.signs;
    cleaned = { ...again, hidden: cleaned.hidden + again.hidden, unlocked: cleaned.unlocked || again.unlocked };
    await waitForFonts(tab);
    await scrollTo(tab, 0);
    await sleep(400);
  }
  // A page whose waits ended before it was ready, at their limit or as the
  // run's time ran short, may have had its data and drawn its content
  // since. It counts as taken before them when it showed a loading sign
  // as they ended and that has not gone by itself (with a box that showed
  // one hidden since, it may only be hidden), or when a request is still
  // out and, as it is taken, it is a bare loading screen or looks empty.
  // One that looks drawn with a request still out is only said to have
  // one. Its title and heading are read again, as it is taken.
  if (moved()) return MOVED;
  let short = false;
  let busy = false;
  let open = "";
  if (view !== "quiet" || loaded === null || routeMoved) {
    if (loaded === null && (await showsContent(tab).catch(() => false))) loaded = true;
    if (view !== "quiet") {
      const out = !networkQuiet(tab, 0);
      if ((sign && (signsHidden > 0 || (await showsLoadingSign(tab)))) || (out && (loaded !== true || (await looksEmpty(tab))))) {
        short = view === "short";
        busy = view === "busy";
      } else if (out) open = view;
    }
    const now = await readInfo(tab);
    Object.assign(info, { title: now.title, heading: now.heading, viewHeading: now.viewHeading });
  }
  const shots = [];
  // One capture of the screen serves every size taken at the device's own
  // scale: the phone's first screen and the narrow one for a manifest.
  let screen = null;
  for (const shot of group.shots) {
    if (shot.pwa && theme !== ctx.pwaTheme) continue;
    if (moved()) return MOVED;
    if (timeLeft() < (shots.length ? ctx.captureMs || CAPTURE_MS : FIRST_CAPTURE_MS)) break;
    const m = await metrics(tab);
    // A phone page wider than the screen (no viewport tag, or content that
    // overflows) is shown zoomed out, as a phone shows it: the first screen
    // is the screen itself, and a whole page is fitted to its width.
    const fit = Math.min(1, group.device.width / m.visualWidth);
    if (!shot.full) {
      const scale = shot.scale || group.device.scale;
      let png;
      if (scale === group.device.scale) {
        if (!screen) {
          await clearHover(tab, m.width, m.viewportHeight);
          screen = Buffer.from((await captureScreen(tab)).data || "", "base64");
        }
        png = screen;
      } else {
        // The screen at another scale: 1920x1080 from the 2x desktop.
        await clearHover(tab, m.width, m.viewportHeight);
        const data = await capture(tab, 0, m.scrollY, group.device.width, group.device.height, scale / group.device.scale);
        png = Buffer.from(data.data || "", "base64");
      }
      if (!pngSize(png)) continue;
      const headings = await evaluate(tab, `${READ_HEADINGS}(${scale * fit})`, []);
      shots.push({ size: shot.size, full: false, pwa: shot.pwa, png, scale, cssWidth: m.width, cssHeight: m.viewportHeight, headings });
    } else {
      const whole = await capturePage(tab, { scale: (shot.scale / group.device.scale) * fit, maxHeight: MAX_HEIGHT });
      if (!whole || !pngSize(whole.png)) continue;
      const sections = await evaluate(tab, `${READ_SECTIONS}(${shot.scale * fit}, ${whole.height})`, []);
      shots.push({ size: shot.size, full: true, png: whole.png, scale: shot.scale, cssWidth: m.width, cssHeight: whole.height, truncated: whole.truncated, sections });
    }
  }
  if (moved()) return MOVED;
  return { nav, info, loaded, busy, open, waited: page.busy ? BUSY_WAIT_MS : VIEW_WAIT_MS, short, links: found, shots, cleaned };
}

// Writes a visit's captures as files of the page and records them.
function saveShots(page, result, theme, run, written) {
  for (const shot of result.shots) {
    // A capture for a web app manifest waits for the end of the run, when
    // the ones that go in are picked and numbered. One taken before its
    // #route view's data had come is left out then, with the reason (see
    // planPwa). Any other goes in, that of a page drawn with no link and no
    // picture that fits the screen too, which the wait for a page's content
    // takes for a loading screen.
    if (shot.pwa) {
      page.pwa[shot.pwa] = { png: shot.png, headings: shot.headings, unready: dataNote(result) };
      continue;
    }
    const file = `${String(page.n).padStart(2, "0")}-${page.slug}-${shot.size}${theme === "dark" ? "-dark" : ""}.png`;
    const png = tagPng(shot.png, {
      Title: page.title || "",
      Source: result.nav.url,
      "Creation Time": new Date().toISOString(),
      Software: `easyscreenshotkit ${version}`,
    });
    run.write(file, png);
    written.push(file);
    const { width, height } = pngSize(png);
    const entry = { file, size: shot.size, full: Boolean(shot.full), theme, width, height, scale: shot.scale, cssWidth: shot.cssWidth, cssHeight: shot.cssHeight };
    if (shot.full) Object.assign(entry, { truncated: Boolean(shot.truncated), sections: shot.sections });
    else entry.headings = shot.headings;
    page.shots.push(entry);
  }
  page.hidden = Math.max(page.hidden || 0, result.cleaned.hidden);
  if (result.cleaned.unlocked && !page.notes.includes("scroll unlocked")) page.notes.push("scroll unlocked");
}

// Writes the screenshots for a web app manifest, pwa/screenshots/*.png, and
// pwa/manifest-screenshots.json, whose src paths hold when the screenshots
// folder sits next to the manifest.
function savePwa(kept, run) {
  const plan = planPwa(kept.map((page) => ({ n: page.n, slug: page.slug, heading: page.heading, viewHeading: page.viewHeading, title: page.title, captures: page.pwa })));
  const out = {
    file: "",
    screenshots: [],
    leftOut: plan.leftOut.map((item) => ({ page: item.page, form_factor: item.form, reason: item.reason })),
    problems: plan.check.problems,
    site: null,
    note: "",
  };
  if (!plan.files.length) return out;
  for (const file of plan.files) {
    const page = kept.find((other) => other.n === file.page);
    const png = tagPng(file.png, { Title: page.title || "", Source: page.url, "Creation Time": new Date().toISOString(), Software: `easyscreenshotkit ${version}` });
    run.write(path.join(PWA_DIR, "screenshots", file.name), png);
    out.screenshots.push({ file: `${PWA_DIR}/screenshots/${file.name}`, page: file.page, ...file.entry });
  }
  run.write(path.join(PWA_DIR, "manifest-screenshots.json"), JSON.stringify({ screenshots: plan.entries }, null, 2) + "\n");
  out.file = `${PWA_DIR}/manifest-screenshots.json`;
  return out;
}

// The site's own manifest, read as --pwa-check reads it: where it is and
// what Chrome makes of the screenshots it lists already. One sentence on it
// goes in the summary. added: how many screenshots the run made for it.
// guard: the run's rule for the addresses it opens, which the manifest and
// its screenshots are read by, as the pages are opened by it.
async function checkSite(href, home, added, guard) {
  if (!href) {
    return { site: null, note: `The home page links no web app manifest, so Chrome does not offer to install the site yet.${added ? " The screenshots in pwa/ are ready for when it has one." : ""}` };
  }
  let report;
  try {
    report = await checkManifest({ url: href }, { guard });
  } catch (err) {
    return { site: { manifest: href, error: err.message }, note: `The site's manifest could not be checked: ${err.message}` };
  }
  const site = { manifest: report.manifest, screenshots: report.screenshots.length, desktop: report.desktop, phone: report.phone, problems: report.problems, tips: report.tips };
  const folder = new URL(".", report.manifest);
  const where = folder.origin === new URL(home).origin ? `${folder.pathname} on the site` : folder.href;
  if (!site.screenshots) {
    return { site, note: `The site's manifest, ${report.manifest}, lists no screenshots yet.${added ? ` Put pwa/screenshots next to it, in ${where}, and add the entries of pwa/manifest-screenshots.json to it.` : ""}` };
  }
  // Added after the ones there, the new ones could fall past the first 8.
  const room = added && site.screenshots + added > LOOKED_AT ? ` Chrome looks at the first ${LOOKED_AT} entries of the list only, so put the new ones before the old ones, or in their place.` : "";
  return {
    site,
    note: `The site's manifest, ${report.manifest}, lists ${site.screenshots === 1 ? "1 screenshot" : `${site.screenshots} screenshots`} already: Chrome shows ${site.desktop.length} on desktops and ${site.phone.length} on phones.${room}`,
  };
}

function pwaMarkdown(pwa, pages) {
  const name = (n) => {
    const page = pages.find((other) => other.n === n);
    return page ? `${String(n).padStart(2, "0")} ${page.slug}` : String(n);
  };
  const lines = ["## Screenshots for a web app manifest", ""];
  if (!pwa.file) lines.push("No screenshot for a web app manifest could be taken.", "");
  else {
    lines.push(
      "`pwa/manifest-screenshots.json` lists them as the `screenshots` of a web app manifest, checked against Chrome's rules for its richer install dialog. Put the `pwa/screenshots` folder next to the manifest and add the entries to it. Each label is the main heading on that screen: change it where it does not say what the screen shows.",
      "",
      "| File | Size | Form factor | Page | Label |",
      "| --- | --- | --- | --- | --- |",
      ...pwa.screenshots.map((shot) => `| ${shot.file} | ${shot.sizes} | ${shot.form_factor} | ${name(shot.page)} | ${shot.label.replace(/\|/g, "\\|")} |`),
      "",
    );
  }
  if (pwa.leftOut.length) lines.push("Left out:", "", ...pwa.leftOut.map((item) => `- ${name(item.page)}, ${item.form_factor}: ${item.reason}`), "");
  if (pwa.problems.length) lines.push("Against Chrome's rules:", "", ...pwa.problems.map((text) => `- ${text}`), "");
  if (pwa.note) lines.push(pwa.note, "");
  if (pwa.site && pwa.site.problems && pwa.site.problems.length) lines.push("To fix in the site's manifest:", "", ...pwa.site.problems.map((text) => `- ${text}`), "");
  if (pwa.site && pwa.site.tips && pwa.site.tips.length) lines.push("Worth adding to it:", "", ...pwa.site.tips.map((text) => `- ${text}`), "");
  return lines;
}

function describeSizes(groups) {
  const out = [];
  for (const group of groups) {
    for (const shot of group.shots) {
      if (shot.pwa) continue;
      const scale = shot.full ? shot.scale : group.device.scale;
      out.push({ size: shot.size, width: group.device.width, height: shot.full ? null : group.device.height, scale, device: group.device.agent, full: shot.full });
    }
  }
  return out;
}

// SCREENSHOTS.md. clean and hide: what the run was asked to hide, which its
// first lines say as it was done: the pages as they came with --no-clean,
// where they said the banners and bubbles were hidden all the same.
function writeMarkdown(manifest, run, { clean: tidied = true, hide = [] } = {}) {
  const date = manifest.takenAt.slice(0, 10);
  const lines = [`# Screenshots of ${manifest.site}`, "", `Taken from ${manifest.url} on ${date} by easyscreenshotkit ${version}.`, ""];
  const pages = tidied
    ? "they are the real pages, with cookie banners, chat bubbles and other floating boxes hidden"
    : `they are the real pages as they came, banners and bubbles included${hide.length ? ", with only what --hide names hidden" : ""}`;
  lines.push(`Use the files as they are: ${pages}. Do not redraw the interface, and do not present them as another product's. Boxes are in each image's own pixels: x, y, width, height.`, "");
  for (const page of manifest.pages) {
    const label = `${String(page.n).padStart(2, "0")} ${page.slug}`;
    lines.push(`## ${label}`, "", `- Address: ${page.url}`, `- Why: ${page.why}`);
    if (page.title) lines.push(`- Title: ${page.title}`);
    if (page.heading) lines.push(`- Main heading: ${page.heading}`);
    if (page.notes.length) lines.push(`- Notes: ${page.notes.join("; ")}`);
    lines.push("", "| File | Size | What |", "| --- | --- | --- |");
    for (const shot of page.shots) {
      const what = `${SIZE_WORDS[shot.size] || `first screen, ${shot.size}`}${shot.theme === "dark" ? ", dark" : ""}${shot.truncated ? ", cut at its first 15,000 px" : ""}`;
      lines.push(`| ${shot.file} | ${shot.width}x${shot.height} | ${what} |`);
    }
    const first = page.shots.find((shot) => !shot.full && shot.headings && shot.headings.length);
    if (first) {
      lines.push("", `Headings on the first screen of ${first.file}:`, "");
      for (const heading of first.headings.slice(0, 8)) lines.push(`- H${heading.level} "${heading.text}" at ${heading.box.join(", ")}`);
    }
    const whole = page.shots.find((shot) => shot.full && shot.sections && shot.sections.length);
    if (whole) {
      lines.push("", `Sections of ${whole.file} (top and height):`, "");
      for (const section of whole.sections.slice(0, 12)) lines.push(`- "${section.heading}" at ${section.top}, ${section.height} high`);
    }
    lines.push("");
  }
  if (manifest.sheet) lines.push("## All pages on one picture", "", `- ${manifest.sheet.file} (${manifest.sheet.width}x${manifest.sheet.height})`, "");
  if (manifest.pwa) lines.push(...pwaMarkdown(manifest.pwa, manifest.pages));
  if (manifest.skipped.length) {
    lines.push("## Left out", "");
    for (const skip of manifest.skipped) lines.push(`- ${skip.url}: ${skip.reason}`);
    lines.push("");
  }
  if (manifest.candidates.length) {
    lines.push("## Other pages it could take", "", "Run again with `--page <path>` to add one.", "");
    for (const candidate of manifest.candidates.slice(0, 10)) lines.push(`- ${candidate.url} (${candidate.kind}, ${candidate.why})`);
    lines.push("");
  }
  if (manifest.notes.length) lines.push("## Notes", "", ...manifest.notes.map((note) => `- ${note}`), "");
  run.write("SCREENSHOTS.md", lines.map(oneLine).join("\n"));
}

// A browser that ends in the middle of a run, as a crash or a kill from
// outside ends it, takes with it every page and window the run had still to
// take: the run fails, and its folder stays as it was. So does one that
// stops answering, as one that hung or was stopped does: each page and
// window still to take would wait out its time for nothing, and the run
// would put the few it had in place of a whole earlier run.
const BROWSER_GONE = "The browser ended in the middle of the run (it crashed, or was killed), so no screenshots were saved.";
const BROWSER_STALLED = "The browser stopped answering in the middle of the run, so no screenshots were saved. The machine may be too busy: try again.";
// A tab that crashes on the first page opened leaves the run with no page.
// On any other it costs that page or window, named in the notes.
const TAB_CRASHED = "The browser's tab crashed in the middle of the run, so no screenshots were saved.";

async function takeShots(rawUrl, options = {}) {
  const {
    dir,
    pages: wanted = 5,
    extra = [],
    sizes = "desktop,mobile,full",
    theme = "light",
    lang = "",
    hide = [],
    reducedMotion = false,
    clean: tidy = true,
    pwa = false,
    timeLimit = 300_000,
    log = () => {},
  } = options;
  setTimeLimit(timeLimit);
  // The addresses the host that runs the kit refuses: a setting that does
  // not parse stops the run before any work (see address.js).
  hostRefusals();
  // A selector to hide that could reach past its own rule stops the run
  // before any work too (see steps.js).
  for (const selector of hide) {
    const refused = hideRefusal(String(selector).trim(), "hide takes CSS selectors");
    if (refused) throw new Error(refused);
  }
  // The programs an earlier run in this process found are found again.
  programs.forget();
  const pageMs = reserveOf(PAGE_MS, timeLimit);
  const windowMs = reserveOf(WINDOW_MS, timeLimit);
  const groups = parseSizes(sizes);
  if (pwa) addPwaShots(groups);
  const themes = theme === "both" ? ["light", "dark"] : [theme === "dark" ? "dark" : "light"];
  const asked = normalizeUrl(rawUrl);
  let home = homeOf(asked);
  // An address deeper than its home page, or a #route of it, is a page of
  // its own to take.
  const given = viewKey(asked) !== viewKey(home) ? asked : "";
  const asks = pagesAsked(extra, asked, home);
  const fragments = fragmentNotes(rawUrl, extra, asked, home);
  const target = dir || `easyscreenshotkit-${siteOf(asked)}`;
  // Every file is made in the run's part folder and put in place once the
  // run has ended well (see outdir.js). A folder the run may not save in is
  // refused first, as it was before the browser and the name of the
  // address's host were looked at.
  const run = openShots(target, { pwa });
  // The screenshots for a manifest are taken in the first theme only.
  // unread: the selectors of hide the browser did not read as one, each
  // named once in the notes (see visit()).
  const ctx = { lang, hide, reducedMotion, clean: tidy, pwaTheme: pwa ? themes[0] : "", captureMs: reserveOf(CAPTURE_MS, timeLimit), unread: new Set() };
  const notes = [...fragments];
  // Pages opened and left out come first in the manifest's list, then the
  // links left out without opening.
  const rejected = [];
  const skipped = [];
  const kept = [];
  const written = [];
  let leftover = [];
  let routes = [];
  let name = "";
  let siteManifest = "";
  let pwaSaved = null;
  let manifest = null;
  let saved = [];
  let chrome = null;
  // The first file that could not be saved, a full disk's above all. A run
  // that lost one has not ended well, whichever window or page it was for.
  let unsaved = null;
  // The other devices and themes of a page kept are taken in windows of
  // their own while the next pages are being found.
  const pool = makePool(2);
  const lostWhy = () => (chrome && chrome.gone() ? (chrome.stalled() ? BROWSER_STALLED : BROWSER_GONE) : "");
  const alive = () => {
    if (lostWhy()) throw new Error(lostWhy());
    if (unsaved) throw unsaved;
  };
  try {
    // The browser before it opens anything: one that is not there, or that
    // is no program this user may run, is named with what is wrong with it.
    const noBrowser = browserProblem();
    if (noBrowser) throw new Error(noBrowser);
    // The pages the run opens, and the sitemaps it reads, are of the address
    // given or on the public internet, on port 80 or 443 away from it (see
    // address.js). One whose host's name cannot be looked up here, or that
    // MAKERSMCP_REFUSE_ADDRESSES refuses, opens nothing, and the run stops
    // before it starts the browser.
    const guard = await guardFor(asked);
    if (guard.unresolved) throw unresolvedError(asked, guard);
    if (guard.refused) throw refusedError(asked, guard);
    chrome = await launch({ lang });
    chrome.guard = guard;
    const [first] = groups;
    const firstTheme = themes[0];
    // The #route views whose other windows are still to be taken.
    let views = 0;
    const others = (page) => {
      const windows = [];
      for (const themeName of themes) {
        for (const group of groups) {
          if (group === first && themeName === firstTheme) continue;
          if (group.shots.every((shot) => shot.pwa && themeName !== ctx.pwaTheme)) continue;
          windows.push(async () => {
            // The run fails over a browser that ended or a file that could
            // not be saved: no note on it, and no more windows.
            if (unsaved || chrome.gone()) return;
            const label = `${group.key}${themeName === "dark" ? " (dark)" : ""}`;
            if (timeLeft() < windowMs) {
              page.notes.push(`${label} not taken: time ran out`);
              return;
            }
            log(`${String(page.n).padStart(2, "0")} ${page.slug}  ${label}`);
            try {
              const got = await visit(chrome, { ...page }, group, themeName, ctx);
              if (got.info.challenge || got.nav.status >= 400) page.notes.push(`${label} not taken: ${got.info.challenge ? "the site answered with a bot check" : `the page answered ${got.nav.status}`}`);
              // What this window's waits saw, by its size and theme, and
              // another page it landed on, by a redirect or by moving on
              // once it had loaded: the page's own notes tell of its first
              // window.
              else {
                for (const note of waitNotes(got)) page.notes.push(`${label}: ${note}`);
                if (movedOn(page.url, got.nav.url)) page.notes.push(`${label}: opened ${page.url} and landed on ${got.nav.url}`);
              }
              saveShots(page, got, themeName, run, written);
            } catch (err) {
              if (err.saveFailed) unsaved = unsaved || err;
              else if (!chrome.gone()) page.notes.push(`${label} could not be taken: ${err.reason || err.message}`);
            }
          });
        }
      }
      // A view of an app draws once its data has come, and the browser
      // sends a second request for the same address only once the answer
      // to the first has begun to come: two windows of the view at once
      // would each wait for both answers. So its windows are taken one
      // after another, and no other page is opened meanwhile (see alone()).
      if (routeOf(page.asked) || routeOf(page.url)) {
        views++;
        pool.add(async () => {
          try {
            for (const take of windows) await take();
          } finally {
            views--;
          }
        });
      } else for (const take of windows) pool.add(take);
    };
    // Before a page is opened. Views of one app often ask one address for
    // their data (the signed-in user, the app's settings), so a window of
    // another view, or of another page, loading at the same time holds a
    // view's data back as long as its own takes, past the view's wait. So a
    // #route view's windows load alone: a page with a #route is opened once
    // every window before it is taken, and no page is opened while a #route
    // view's windows are being taken.
    const alone = async (url) => {
      if (views || routeOf(url)) await pool.drain();
    };
    const keep = (page, result) => {
      page.n = kept.length + 1;
      const { keys, named } = identity(page.asked, result.nav.url, result.info.canonical);
      // A view of a web app is told by its own heading, the first h1 outside
      // the bars around it: an app can put its own name in an h1 in the bar
      // along its top, the same on every view.
      const view = Boolean(routeOf(page.asked) || routeOf(result.nav.url));
      const taken = new Set(kept.map((other) => other.slug));
      const base = page.slug || slugOf(named, home);
      let slug = base;
      for (let k = 2; taken.has(slug); k++) slug = `${base}-${k}`;
      page.slug = slug;
      Object.assign(page, {
        url: result.nav.url,
        title: result.info.title,
        heading: (view && result.info.viewHeading) || result.info.heading,
        viewHeading: view ? result.info.viewHeading : "",
        description: result.info.description,
        lang: result.info.lang,
        textHash: result.info.textHash,
        keys,
        busy: result.busy || result.open === "busy",
      });
      page.notes.push(...waitNotes(result));
      // A page that moved on by itself once it had loaded is the page it
      // moved to (see visit()), and its note says so.
      if (movedOn(page.asked, result.nav.url)) page.notes.push(result.movedFrom ? `opened ${page.asked}, which moved on to ${result.nav.url} once it had loaded` : `opened ${page.asked} and landed on ${result.nav.url}`);
      page.notes.push(...barredNotes(result.barred), ...downloadNotes(result.downloads));
      kept.push(page);
      saveShots(page, result, firstTheme, run, written);
      log(`${String(page.n).padStart(2, "0")} ${page.slug}  ${pathOf(result.nav.url)}`);
      others(page);
    };
    const newPage = (url, kind, why) => ({ asked: url, url, kind, why, slug: "", shots: [], notes: [], hidden: 0, pwa: {} });

    // The home page, or only the address given when one page is asked for.
    const startUrl = wanted === 1 ? asked : home;
    log(`Opening ${startUrl}`);
    const indexing = wanted > 1 ? readSiteIndex(new URL(home).origin, { guard: chrome.guard }).catch(() => ({ robots: null, urls: [] })) : Promise.resolve({ robots: null, urls: [] });
    let start = newPage(startUrl, wanted === 1 && given ? "given" : "home", wanted === 1 && given ? "the address given" : "the home page");
    let begun = Date.now();
    let result = null;
    // Why the home page is left out, when it is one the run chose to open
    // by itself: the address given is there to start at, and what stops a
    // run is the address the user gave.
    let homeLost = "";
    const spare = wanted > 1 && given;
    const failure = (got) => (got.nav.status >= 400 ? `the page answered ${got.nav.status}` : got.info.challenge ? "a bot check instead of the page" : "");
    try {
      result = await visit(chrome, start, first, firstTheme, ctx, { links: wanted > 1 });
      // The site's own page in the language asked for, when it names one.
      // One the run does not open, or that is left out as it is opened, as
      // one that answers an error or a bot check or cannot be opened is,
      // leaves the home page as it was taken, with a note: the home page
      // answered, and a stale link to a version that is gone is no reason to
      // lose it. A browser that ended or stopped answering fails the run.
      if (lang && wanted > 1 && !(spare && failure(result))) {
        const alternate = alternateFor(result.info.alternates, lang);
        if (alternate && pageKey(alternate.href) !== pageKey(result.nav.url) && siteOf(alternate.href) === siteOf(home)) {
          const barred = chrome.guard ? await chrome.guard.refuses(alternate.href) : "";
          if (barred) notes.push(alternateNote(alternate, lang, `which is ${barred}: it was not opened`));
          else {
            log(`Opening its ${alternate.lang} version, ${alternate.href}`);
            const page = newPage(alternate.href, "home", `the home page in ${alternate.lang}`);
            const opened = Date.now();
            let got = null;
            let why = "";
            try {
              got = await visit(chrome, page, first, firstTheme, ctx, { links: true });
              why = failure(got);
            } catch (err) {
              if (chrome.gone()) throw err;
              why = timeLeft() < windowMs ? "time ran out; give more with --timeout" : notOpened(err);
            }
            if (why) notes.push(alternateNote(alternate, lang, `which was left out (${why})`));
            else {
              home = homeOf(alternate.href);
              start = page;
              begun = opened;
              result = got;
            }
          }
        } else if (!alternate) {
          notes.push(`The home page names no ${lang} version of itself, so it was opened with ${lang} as the browser's language.`);
        }
      }
      if (spare) homeLost = failure(result);
    } catch (err) {
      if (!spare || chrome.gone()) throw err;
      homeLost = notOpened(err);
    }
    if (homeLost) {
      rejected.push({ url: start.url, reason: homeLost });
      notes.push(`The home page, ${start.url}, was left out (${homeLost}), and the run started at the address given.`);
      home = homeOf(asked);
      log(`Opening ${asked}`);
      start = newPage(asked, "given", "the address given");
      begun = Date.now();
      result = await visit(chrome, start, first, firstTheme, ctx, { links: true });
    }
    if (result.nav.status >= 400) throw new Error(`${result.nav.url} answered ${result.nav.status}, so no screenshots were taken.`);
    if (result.info.challenge) {
      throw new Error(`${result.nav.url} answered with a bot check ("${result.info.title || "a challenge page"}") instead of its page, so no screenshots were taken. Open the site in a normal browser to check it.`);
    }
    const lastVisit = Date.now() - begun;
    name = siteName(result.info, result.nav.url);
    siteManifest = result.info.manifest || "";
    keep(start, result);
    if (start.kind === "home") start.keys.add(pageKey(home));

    // The page given, when it is not the page opened first, and the pages
    // asked for with --page, even past --pages: taken whatever they are,
    // unless they fail to open (an address that answers with a file, which
    // the browser does not save, a host that does not answer). One that is
    // not taken is named in the notes, and the run goes on while it has
    // taken one of them; one that took none of the pages the user named
    // has not ended well, and fails, as one of a single page does over the
    // address given, where it put the home page and pages it picked itself
    // in the place of an earlier run. With a tour, the #route links on each
    // are listed with the pages left out, as the home page's are.
    const namedLinks = [];
    const named = [...(given && start.kind !== "given" ? [[given, "the address given"]] : []), ...asks.map((url) => [url, "asked for with --page"])];
    // Whether a page the user named is in the run: the page it started at
    // is one when that is the address given.
    let tookNamed = !given || start.kind === "given";
    const missed = [];
    const notTaken = (url, reason) => {
      missed.push({ url, reason });
      notes.push(`${url} was asked for but not taken: ${reason}.`);
    };
    const LEFT_FOR_TIME = "time ran out; give more with --timeout";
    // The address given, left out for want of time, fails the run there, as
    // a demo's tour fails when it has no time to show it.
    const outOfTime = (url, why) => {
      notTaken(url, LEFT_FOR_TIME);
      if (why === "the address given") throw new Error(`${url} was asked for but not taken: ${LEFT_FOR_TIME}. No screenshots were saved.`);
    };
    for (const [url, why] of named) {
      const same = kept.find((page) => page.keys.has(viewKey(url)));
      if (same) {
        notes.push(`${url} was asked for but not taken: the same page as ${same.slug}.`);
        tookNamed = true;
        continue;
      }
      await alone(url);
      alive();
      if (timeLeft() < pageMs) {
        outOfTime(url, why);
        continue;
      }
      const kind = (kindOf(new URL(url), "") || { kind: "other" }).kind;
      const page = newPage(url, kind, why);
      log(`Opening ${url}`);
      let got;
      try {
        got = await visit(chrome, page, first, firstTheme, ctx, { routes: wanted > 1 });
      } catch (err) {
        alive();
        // One that failed because the run's time ran out is said so, and
        // not left out as a page that could not be opened.
        if (timeLeft() < windowMs) {
          outOfTime(url, why);
          continue;
        }
        const reason = notOpened(err);
        rejected.push({ url, reason });
        notTaken(url, reason);
        continue;
      }
      const failed = got.nav.status >= 400 ? `the page answered ${got.nav.status}` : got.info.challenge ? "a bot check instead of the page" : "";
      if (failed) {
        rejected.push({ url, reason: failed });
        notTaken(url, failed);
      } else {
        keep(page, got);
        tookNamed = true;
        namedLinks.push(...(got.links || []));
      }
    }
    if (!tookNamed) throw new Error(`${missed.map(({ url, reason }) => `${url} was asked for but not taken: ${reason}.`).join(" ")} No screenshots were saved.`);

    if (wanted > 1) {
      const site = siteOf(home);
      const homeKey = pageKey(kept[0].url);
      // Then the pages found on the home page and in the sitemap.
      const index = await indexing;
      notes.push(...indexNotes(index.refused));
      const ranked = rankLinks(result.links || [], index.urls || [], {
        home: kept[0].url,
        robots: index.robots,
        alternates: (result.info.alternates || []).map((alt) => alt.href),
        exclude: kept.map((page) => page.url),
        // A home page left out is not opened again from a link to it.
        keys: [...kept.flatMap((page) => [...page.keys]), ...(homeLost ? [pageKey(home)] : [])],
      });
      skipped.push(...ranked.skipped);
      const queue = visitOrder(ranked.candidates);
      let visits = 0;
      // A page is opened only when there is time to take it: as long as the
      // pages taken so far took on average, and a margin.
      const took = [lastVisit];
      while (queue.length && kept.length < wanted && visits < wanted * 3) {
        await alone(queue[0].url);
        alive();
        const expected = took.reduce((sum, ms) => sum + ms, 0) / took.length;
        if (timeLeft() < Math.max(60_000, expected * 1.3 + 20_000)) {
          notes.push(`Time ran out after ${kept.length === 1 ? "1 page" : `${kept.length} pages`}; give more with --timeout.`);
          break;
        }
        const candidate = queue.shift();
        if (kept.some((page) => page.keys.has(viewKey(candidate.url)))) continue;
        visits++;
        const page = newPage(candidate.url, candidate.kind, candidate.why);
        log(`Opening ${candidate.url}`);
        let got;
        const started = Date.now();
        try {
          got = await visit(chrome, page, first, firstTheme, ctx, { check: { site, homeKey, kept } });
          if (!got.rejected) took.push(Date.now() - started);
        } catch (err) {
          // A page that failed because the browser ended is no page left
          // out: the run fails.
          alive();
          // A call that failed because the run's time is up is no reason
          // to leave the page out.
          if (timeLeft() < 30_000) {
            notes.push(`Time ran out after ${kept.length === 1 ? "1 page" : `${kept.length} pages`}; give more with --timeout.`);
            break;
          }
          rejected.push({ url: candidate.url, reason: notOpened(err) });
          continue;
        }
        if (got.rejected) rejected.push({ url: candidate.url, reason: got.rejected });
        else keep(page, got);
      }
      leftover = queue.slice(0, 20).map(({ url, kind, score, why }) => ({ url, kind, score, why }));
      // The views of an app that the home page, the address given and each
      // --page link to by #route, and those the sitemap lists: the tour
      // does not follow them, so they are listed for --page. A page the
      // user named is not one of them, taken or not: one left out for want
      // of time was listed so, with the words to give it with --page.
      const listed = (index.urls || []).map((href) => ({ href }));
      routes = routeLinks([...(result.links || []), ...namedLinks, ...listed], { home: kept[0].url, keys: [...kept.flatMap((page) => [...page.keys]), ...named.map(([url]) => viewKey(url))] });
    }

    await pool.drain();
    alive();
    // Each page's files in the order the sizes were asked for, light first.
    const order = describeSizes(groups).map((size) => size.size);
    for (const page of kept) page.shots.sort((a, b) => themes.indexOf(a.theme) - themes.indexOf(b.theme) || order.indexOf(a.size) - order.indexOf(b.size));
    if (!kept.some((page) => page.shots.length)) throw new Error("No page could be captured.");
    if (kept.some((page) => page.notes.some((note) => /time ran out/.test(note)))) notes.push("Time ran out before every size was taken; give more with --timeout.");
    const left = leftOut(rejected, routes, skipped);
    if (left.routesPast) notes.push(`${left.routesPast === 1 ? "1 more #route link was" : `${left.routesPast} more #route links were`} left out past the ${LEFT_OUT} listed; give one with --page to take it.`);
    for (const selector of ctx.unread) notes.push(unreadNote(selector));
    if (themes.includes("dark")) notes.push("Dark captures use the page's own dark theme, through prefers-color-scheme. A site without one looks the same in both.");
    if (pwa) pwaSaved = savePwa(kept, run);
    manifest = {
      version: 1,
      tool: `easyscreenshotkit ${version}`,
      url: asked,
      site: name,
      takenAt: new Date().toISOString(),
      sizes: describeSizes(groups),
      themes,
      lang: lang || (kept[0] && kept[0].lang) || "",
      pages: kept.map((page) => ({
        n: page.n,
        slug: page.slug,
        url: page.url,
        kind: page.kind,
        why: page.why,
        title: page.title,
        heading: page.heading,
        description: page.description,
        lang: page.lang,
        hidden: page.hidden,
        notes: page.notes,
        shots: page.shots,
      })),
      sheet: null,
      pwa: pwaSaved,
      candidates: leftover,
      skipped: left.skipped,
      notes,
    };
    // The site's own manifest is read while the sheet is drawn: no browser
    // needed.
    const siteCheck = pwaSaved ? checkSite(siteManifest, kept[0].url, pwaSaved.screenshots.length, chrome.guard) : null;
    log("Drawing the sheet");
    // The sheet takes a few seconds and is drawn even when the pages used up
    // the run's time. One that cannot be drawn is said so: the pages are
    // there all the same. Over a browser that ended, or a sheet that was
    // drawn and could not be saved, the run fails.
    if (timeLeft() < 90_000) setTimeLimit(90_000);
    try {
      manifest.sheet = await renderSheet(chrome, manifest, run);
    } catch (err) {
      alive();
      if (err.saveFailed) throw err;
      notes.push(`sheet.png could not be drawn: ${err.reason || run.told(err).message.replace(/\.$/, "")}.`);
    }
    await chrome.close();
    chrome = null;
    if (siteCheck) Object.assign(manifest.pwa, await siteCheck);
    run.write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    writeMarkdown(manifest, run, { clean: tidy, hide });
    // A run ends well only with whole files: each picture is read back
    // before it can take the place of an earlier run's.
    saved = [...written, ...(manifest.sheet ? ["sheet.png"] : []), ...(pwaSaved && pwaSaved.file ? [...pwaSaved.screenshots.map((shot) => shot.file), pwaSaved.file] : []), "SCREENSHOTS.md", "manifest.json"];
    const cut = saved.find((file) => file.endsWith(".png") && !pngFileIsWhole(run.file(file)));
    if (cut) throw new Error(`${cut} came out cut short (the disk, or your disk quota, may be full), so no screenshots were saved.`);
  } catch (err) {
    // Whatever failed first, a browser that ended or stopped answering is why.
    const why = lostWhy() || (err.message === CRASHED ? TAB_CRASHED : "");
    await pool.drain();
    if (chrome) await chrome.close();
    run.abort();
    throw run.told(why ? new Error(why) : err);
  }
  // The run has ended well: its files take the place of the earlier run's.
  run.commit(saved);
  return { dir: target, manifest };
}

// Runs jobs, at most limit at a time; drain() waits for all of them.
function makePool(limit) {
  const waiting = [];
  const idle = [];
  let running = 0;
  const next = () => {
    while (running < limit && waiting.length) {
      const job = waiting.shift();
      running++;
      Promise.resolve()
        .then(job)
        .catch(() => {})
        .finally(() => {
          running--;
          next();
        });
    }
    if (!running && !waiting.length) idle.splice(0).forEach((resolve) => resolve());
  };
  return {
    add(job) {
      waiting.push(job);
      next();
    },
    drain() {
      return new Promise((resolve) => {
        idle.push(resolve);
        next();
      });
    },
  };
}

// The pages left out, each once, as manifest.json lists them: the pages
// opened and left out first, then the #route links the tour does not
// follow, which --page can take, then the links left out by their address
// or their words. LEFT_OUT at most; routesPast: the #route links past it.
const LEFT_OUT = 40;

function leftOut(rejected, routes, links) {
  const seen = new Set();
  const all = [];
  for (const skip of [...rejected, ...routes, ...links]) {
    let key;
    try {
      key = viewKey(skip.url);
    } catch {
      key = skip.url;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(skip);
  }
  return { skipped: all.slice(0, LEFT_OUT), routesPast: all.slice(LEFT_OUT).filter((skip) => skip.reason === ROUTE_LINK).length };
}

module.exports = { takeShots, unreadNote, parseSizes, addPwaShots, normalizeUrl, fragmentNotes, prepareDir, openShots, slugOf, identity, movedOn, pagesAsked, waitForView, leftOut, siteName, readInfo, readLinks, rejectAtOnce, rejectReason, notOpened, alternateNote, barredNote, barredNotes, writeMarkdown, DEVICES, MAX_HEIGHT };
