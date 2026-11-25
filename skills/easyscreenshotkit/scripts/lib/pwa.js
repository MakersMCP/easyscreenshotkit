"use strict";

// Screenshots for a web app manifest. Chrome shows a manifest's screenshots
// in its richer install dialog; a manifest without them gets the plain one,
// and DevTools warns "Richer PWA Install UI won't be available". The rules
// below are Chrome's own, read from its source (the installable data
// fetcher, the manifest icon downloader and the webapps constants) and from
// the warnings DevTools gives:
//
//   - each side from 320 to 3840 pixels, the long side at most 2.3 times
//     the short one; web.dev names JPEG and PNG as the formats
//   - a desktop shows the screenshots whose form_factor is "wide", a phone
//     all the others ("narrow" or none)
//   - Chrome looks at the first 8 entries of the list and no further,
//     whatever their form factor, and leaves out one whose shape is not the
//     first one's it kept; DevTools warns past 5 on a phone
//   - Chrome scales a screenshot down to the first of its sizes, and to 320
//     pixels high when it has none; DevTools checks sizes against the file
//   - the description shows above the screenshots, about 300 characters
//
// checkScreenshots() applies them to any list of screenshots; planPwa()
// turns the captures of a run with --pwa into a list that keeps them; and
// checkManifest() reads a manifest from a file or the web for --pwa-check,
// with no browser.

const fs = require("fs");
const net = require("net");
const path = require("path");
const { pngSize } = require("./png");
const { oneLine } = require("./pick");
const { guardFor, getChecked, otherPort, NOT_PUBLIC, NOT_WEB, UNRESOLVED } = require("./address");
const version = require("./version");

const MIN_SIDE = 320;
const MAX_SIDE = 3840;
const MAX_RATIO = 2.3;
const LOOKED_AT = 8;
const PHONE_SHOWS = 5;
const DESCRIPTION_SHOWN = 300;

// What --pwa takes of each page: the first screen of the 1600x900 desktop
// at 1.2x, 1920x1080 (the full menu, in about a third of the pixels of the
// 2x desktop capture), and of the phone at 3x, 1080x1920. Both are 16:9,
// well inside the 2.3 limit.
const PWA_SHOTS = {
  wide: { width: 1600, height: 900, scale: 1.2, mobile: false },
  narrow: { width: 360, height: 640, scale: 3, mobile: true },
};

const NAMES = { png: "PNG", jpeg: "JPEG", gif: "GIF", webp: "WebP", avif: "AVIF", heic: "HEIC", svg: "SVG" };
const MIME = { png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", heic: "image/heic", svg: "image/svg+xml" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The format and size of an image from its first bytes. Sizes are read for
// PNG, JPEG, GIF and WebP; AVIF, HEIC and SVG are only named.
function imageInfo(buf) {
  const none = { format: "", width: 0, height: 0 };
  if (!Buffer.isBuffer(buf) || buf.length < 12) return none;
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG) && buf.toString("latin1", 12, 16) === "IHDR") {
    return { format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { format: "jpeg", ...jpegSize(buf) };
  const head = buf.toString("latin1", 0, 12);
  if (/^GIF8[79]a/.test(head)) return { format: "gif", width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (head.startsWith("RIFF") && head.slice(8) === "WEBP") return { format: "webp", ...webpSize(buf) };
  if (head.slice(4, 8) === "ftyp") {
    const brand = head.slice(8, 12);
    if (/^avi[fs]$/.test(brand)) return { format: "avif", width: 0, height: 0 };
    if (/^(heic|heix|hevc|mif1)$/.test(brand)) return { format: "heic", width: 0, height: 0 };
  }
  const text = buf.toString("utf8", 0, Math.min(buf.length, 2048)).replace(/^\uFEFF/, "").trimStart().toLowerCase();
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return { format: "svg", width: 0, height: 0 };
  return none;
}

// The size in a JPEG's start-of-frame segment.
function jpegSize(buf) {
  for (let at = 2; at + 9 < buf.length; ) {
    if (buf[at] !== 0xff) {
      at++;
      continue;
    }
    const marker = buf[at + 1];
    // Fill bytes, and the markers that carry no length.
    if (marker === 0xff) at++;
    else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) at += 2;
    else if (marker === 0xd9 || marker === 0xda) break;
    else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
    } else at += 2 + buf.readUInt16BE(at + 2);
  }
  return { width: 0, height: 0 };
}

function webpSize(buf) {
  const chunk = buf.toString("latin1", 12, 16);
  if (chunk === "VP8X" && buf.length >= 30) return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (chunk === "VP8L" && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  if (chunk === "VP8 " && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  return { width: 0, height: 0 };
}

const isWide = (shot) => shot.formFactor.toLowerCase() === "wide";
const dims = (image) => `${image.width}x${image.height}`;
// 4, "1 and 2", "1, 3 and 5", "2 to 6".
const span = (list) => {
  if (list.length >= 3 && list.every((n, i) => i === 0 || n === list[i - 1] + 1)) return `${list[0]} to ${list[list.length - 1]}`;
  return list.length === 1 ? String(list[0]) : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
};
const numbers = (list) => `${list.length === 1 ? "screenshot" : "screenshots"} ${span(list)}`;

// One entry of the list. image: {format, width, height} as read from its
// file, {error} when it could not be read, {unread} when the check's rule
// for the addresses it reads did not read it, with why (see
// checkManifest), undefined when it was not looked at.
function readEntry(raw, i, image) {
  const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const text = (key) => (typeof entry[key] === "string" ? entry[key].trim() : "");
  return {
    n: i + 1,
    src: text("src"),
    sizes: text("sizes"),
    type: text("type"),
    label: text("label"),
    formFactor: text("form_factor"),
    image: image && !image.error && !image.unread ? image : null,
    error: image && image.error ? image.error : "",
    unread: image && image.unread ? image.unread : "",
    shownOn: [],
    leftOut: "",
    problems: [],
    tips: [],
  };
}

// Why Chrome can show a screenshot nowhere, or "".
function unusable(shot) {
  if (!shot.src) return "no src";
  if (shot.error) return `could not be loaded (${shot.error})`;
  if (!shot.image) return "";
  const { format, width, height } = shot.image;
  if (!format) return "not an image";
  if (!width || !height) return `${NAMES[format]}, whose size this check cannot read`;
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  if (short < MIN_SIDE) return `${dims(shot.image)}, a side under ${MIN_SIDE} pixels`;
  if (long > MAX_SIDE) return `${dims(shot.image)}, a side over ${MAX_SIDE} pixels`;
  if (long > short * MAX_RATIO) return `${dims(shot.image)}, ${(long / short).toFixed(2)} times as ${width > height ? "wide as high" : "high as wide"}, more than ${MAX_RATIO}`;
  return "";
}

// What Chrome scales a picture down to for a size it was told: that many
// pixels high, as wide as its shape makes it. null when it stays as it is.
function scaledTo(image, ideal) {
  if (!image || !image.width || !image.height) return null;
  const width = Math.round((image.width / image.height) * ideal);
  return image.height > ideal || image.width > width ? `${width}x${ideal}` : null;
}

function sizeProblem(shot) {
  const image = shot.image && shot.image.width && shot.image.height ? shot.image : null;
  if (!shot.sizes) {
    const to = scaledTo(image, MIN_SIDE);
    return `no sizes, so Chrome shows a copy scaled down to ${to || `${MIN_SIDE} pixels high`}`;
  }
  const first = shot.sizes.split(/\s+/)[0];
  if (/^any$/i.test(first)) return `sizes starts with "any"; give the size in pixels, ${image ? dims(image) : "WIDTHxHEIGHT"}`;
  const m = /^(\d+)[xX](\d+)$/.exec(first);
  if (!m) return `sizes "${shot.sizes}" is not WIDTHxHEIGHT`;
  if (image && (Number(m[1]) !== image.width || Number(m[2]) !== image.height)) {
    const to = scaledTo(image, Math.max(Number(m[1]), Number(m[2])));
    return `sizes says ${m[1]}x${m[2]} and the file is ${dims(image)}${to ? `, so Chrome shows a copy scaled down to ${to}` : ""}`;
  }
  return "";
}

// Applies Chrome's rules to a manifest's screenshots: which ones a desktop
// and a phone show, and what to fix (problems) or add (tips). images[i] is
// what was read of screenshot i's file (see readEntry); description, the
// manifest's own, when the whole manifest is checked. A screenshot the
// check did not read, as one on another port than 80 and 443 that a
// manifest file names, is one it cannot say Chrome shows or not: unchecked
// says so, and a side with no screenshot shown and one not read is not
// said to get the plain install dialog. It was, and the check failed a
// manifest whose screenshots Chrome shows.
function checkScreenshots(list, images = [], options = {}) {
  const problems = [];
  const tips = [];
  const unchecked = [];
  if (list !== undefined && list !== null && !Array.isArray(list)) problems.push('"screenshots" is not a list, so Chrome reads none of it.');
  const shots = (Array.isArray(list) ? list : []).map((raw, i) => readEntry(raw, i, images[i]));
  for (const shot of shots) {
    if (shot.n > LOOKED_AT) {
      shot.leftOut = `Chrome looks at the first ${LOOKED_AT} screenshots only`;
      continue;
    }
    shot.leftOut = unusable(shot);
    const format = shot.image ? shot.image.format : "";
    if (shot.leftOut) shot.problems.push(shot.leftOut);
    else if (shot.image) {
      if (format !== "png" && format !== "jpeg") shot.problems.push(`${NAMES[format]}, and Chrome's rules take JPEG and PNG`);
      const size = sizeProblem(shot);
      if (size) shot.problems.push(size);
    }
    if (!shot.src) continue;
    if (!shot.type) shot.tips.push(`no type; add "${MIME[format] || "image/png"}"`);
    else if (MIME[format] && shot.type.toLowerCase() !== MIME[format] && !(format === "jpeg" && /^image\/jpg$/i.test(shot.type))) {
      shot.tips.push(`type says ${shot.type} and the file is ${NAMES[format]}`);
    }
    if (!shot.label) shot.tips.push("no label, the text screen readers read out");
    if (shot.formFactor && !/^(wide|narrow)$/i.test(shot.formFactor)) {
      shot.tips.push(`form_factor "${shot.formFactor}" is neither "wide" nor "narrow", which Chrome takes as none: phones only`);
    }
  }
  const shown = { desktop: [], phone: [] };
  for (const platform of ["desktop", "phone"]) {
    let first = null;
    for (const shot of shots.slice(0, LOOKED_AT)) {
      if (isWide(shot) !== (platform === "desktop") || shot.leftOut || !shot.image) continue;
      const { width, height } = shot.image;
      if (first && width * first.image.height !== height * first.image.width) {
        shot.problems.push(`a different shape from screenshot ${first.n} (${dims(first.image)}), the first one ${platform === "desktop" ? "desktops" : "phones"} show, and Chrome shows one shape only`);
        continue;
      }
      if (platform === "phone" && shown.phone.length >= PHONE_SHOWS) {
        shot.problems.push(`past the ${PHONE_SHOWS} that DevTools says a phone shows`);
        continue;
      }
      first = first || shot;
      shown[platform].push(shot.n);
      shot.shownOn.push(platform);
    }
  }
  // The screenshots of each side the check did not read, of those Chrome
  // looks at.
  const unread = (desktop) => shots.slice(0, LOOKED_AT).filter((shot) => shot.unread && isWide(shot) === desktop).map((shot) => shot.n);
  if (!shots.length) problems.push("There are no screenshots, so Chrome shows its plain install dialog on desktops and on phones.");
  else {
    const wide = shots.filter(isWide);
    if (!shown.desktop.length && unread(true).length) unchecked.push(`Desktops: the check did not read ${numbers(unread(true))}, so it cannot say whether they get the richer install dialog.`);
    else if (!shown.desktop.length) {
      problems.push(
        wide.length
          ? "Desktops get the plain install dialog: Chrome can show none of the wide screenshots."
          : 'Desktops get the plain install dialog: no screenshot has form_factor "wide".',
      );
    }
    if (!shown.phone.length && unread(false).length) unchecked.push(`Phones: the check did not read ${numbers(unread(false))}, so it cannot say whether they get the richer install dialog.`);
    else if (!shown.phone.length) {
      problems.push(
        wide.length < shots.length
          ? "Phones get the plain install dialog: Chrome can show none of the screenshots for phones."
          : 'Phones get the plain install dialog: every screenshot is "wide". Add one with form_factor "narrow".',
      );
    }
    if (shots.length > LOOKED_AT) {
      const past = shots.slice(LOOKED_AT).map((shot) => shot.n);
      problems.push(`Chrome looks at the first ${LOOKED_AT} screenshots of the list only, wide and narrow together, so ${numbers(past)} ${past.length === 1 ? "never shows" : "never show"}.`);
    }
  }
  // The same words for several screenshots come once, with their numbers,
  // and speak of them all (worded, given the words and whether there are
  // several).
  const grouped = (of, worded = (text) => text) => {
    const texts = new Map();
    for (const shot of shots) for (const text of of(shot)) texts.set(text, [...(texts.get(text) || []), shot]);
    return [...texts].map(([text, list]) => {
      const one = list.length === 1 && list[0].src ? ` (${list[0].src.length > 60 ? `${list[0].src.slice(0, 57)}...` : list[0].src})` : "";
      const name = numbers(list.map((shot) => shot.n));
      return `${name.charAt(0).toUpperCase()}${name.slice(1)}${one}: ${worded(text, list.length > 1)}.`;
    });
  };
  // A reason as said of one screenshot, "it is ..." or "it leads to ...",
  // said of several.
  const they = (why, many) => (many ? why.replace(/^it is /, "they are ").replace(/^it leads to /, "they lead to ") : why);
  problems.push(...grouped((shot) => shot.problems, (text, many) => text.replace(/^(could not be loaded \()(.*)\)$/s, (all, head, why) => `${head}${they(why, many)})`)));
  tips.push(...grouped((shot) => shot.tips));
  unchecked.push(...grouped((shot) => (shot.unread ? [shot.unread] : []), (why, many) => `not read, as ${they(why, many)}: the check cannot say whether Chrome shows ${many ? "them" : "it"}`));
  if ("description" in options) {
    const text = typeof options.description === "string" ? options.description.trim() : "";
    if (!text) tips.push(`There is no description. Chrome shows it above the screenshots, about ${DESCRIPTION_SHOWN} characters of it.`);
    else if (text.length > DESCRIPTION_SHOWN) tips.push(`The description has ${text.length} characters, and Chrome shows about ${DESCRIPTION_SHOWN} of them.`);
  }
  return { ok: problems.length === 0 && unchecked.length === 0, desktop: shown.desktop, phone: shown.phone, screenshots: shots, problems, tips, unchecked };
}

// A screenshot's label, read out by screen readers: the main heading on that
// screen, else the page's own heading or title. On a view of a web app, the
// view's own heading (viewHeading) when it is on that screen: an app can put
// its own name in an h1 in the bar along its top, on every view the same.
function labelOf(headings, page) {
  const found = (headings || []).filter((heading) => heading && heading.text);
  const own = page.viewHeading ? found.find((heading) => heading.level === 1 && heading.text === page.viewHeading.slice(0, 120)) : null;
  const main = own || found.find((heading) => heading.level === 1) || found.slice().sort((a, b) => a.level - b.level)[0];
  const text = String((main && main.text) || page.heading || page.title || page.slug || "").replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117).trimEnd()}...` : text;
}

// The screenshots a run hands over for a manifest. pages: [{n, slug,
// heading, viewHeading, title, captures: {wide, narrow}}], each capture
// {png, headings, unready}, unready saying why it was taken before its
// view was ready, or "". Every capture is checked with Chrome's rules
// first. Chrome looks at the first 8 entries only, wide and narrow
// together, so at most 8 go in: 4 of each when there are, the room one
// leaves going to the other, and no more than 5 narrow ones. Returns
// {files: [{name, form, page, png, entry}], entries, leftOut: [{page,
// form, reason}], check}.
function planPwa(pages) {
  const leftOut = [];
  const usable = { wide: [], narrow: [] };
  for (const form of ["wide", "narrow"]) {
    let first = null;
    for (const page of pages) {
      const capture = page.captures && page.captures[form];
      if (!capture) continue;
      // Taken while its view still loaded: a loading screen is no
      // screenshot to put in a manifest.
      if (capture.unready) {
        leftOut.push({ page: page.n, form, reason: capture.unready });
        continue;
      }
      const size = pngSize(capture.png);
      const image = size ? { format: "png", ...size } : { format: "", width: 0, height: 0 };
      const reason = unusable({ src: "file", error: "", image });
      if (reason) {
        leftOut.push({ page: page.n, form, reason });
        continue;
      }
      if (first && image.width * first.height !== image.height * first.width) {
        leftOut.push({ page: page.n, form, reason: `a different shape from the first ${form} one (${dims(first)})` });
        continue;
      }
      first = first || image;
      usable[form].push({ page, form, png: capture.png, image, label: labelOf(capture.headings, page) });
    }
  }
  const wide = Math.min(usable.wide.length, LOOKED_AT - Math.min(usable.narrow.length, LOOKED_AT / 2));
  const narrow = Math.min(usable.narrow.length, PHONE_SHOWS, LOOKED_AT - wide);
  const files = [];
  for (const [form, keep] of [["wide", wide], ["narrow", narrow]]) {
    usable[form].forEach((item, i) => {
      if (i >= keep) {
        leftOut.push({ page: item.page.n, form, reason: `Chrome looks at the first ${LOOKED_AT} screenshots of a manifest only, wide and narrow together` });
        return;
      }
      const name = `${form}-${String(i + 1).padStart(2, "0")}.png`;
      const entry = { src: `screenshots/${name}`, sizes: dims(item.image), type: "image/png", form_factor: form, label: item.label };
      files.push({ name, form, page: item.page.n, png: item.png, entry });
    });
  }
  const entries = files.map((file) => file.entry);
  leftOut.sort((a, b) => a.page - b.page || (a.form === "wide" ? -1 : 1));
  return { files, entries, leftOut, check: checkScreenshots(entries, files.map((file) => ({ format: "png", ...pngSize(file.png) }))) };
}

// ─── reading a manifest ────────────────────────────────────────────────────

const FETCH_MS = 15_000;
const MAX_BYTES = 30 * 1024 * 1024;
const AGENT = `easyscreenshotkit/${version} (+https://github.com/MakersMCP/easyscreenshotkit)`;

function reasonOf(err) {
  if (err && (err.name === "TimeoutError" || err.name === "AbortError")) return `no answer in ${FETCH_MS / 1000} s`;
  if (err && err.refused) return err.refused;
  const cause = (err && err.cause) || err;
  if (cause && cause.code === "ENOTFOUND") return `${cause.hostname || "the host"} was not found`;
  if (err && err.code === "ENOENT") return `there is no file ${err.path}`;
  if (cause && cause.code) return cause.code;
  return (err && err.message) || String(err);
}

// A file on this machine that --pwa-check reads, the manifest file it is
// given or a screenshot's file next to it, read as a regular file and
// MAX_BYTES at most, as one from the web is (kit lesson 3.2): what is no
// regular file is named and not opened, and what is opened is looked at
// again before it is read, as something else can have taken its place
// meanwhile. A link is followed, as a server that serves the folder
// follows it. Read as it was, a screenshot's src that named a named pipe
// beside the manifest, as a manifest file the user did not write can, held
// the check for good, past its --timeout, and one that named /dev/zero
// read until the memory was gone.
function readRegular(file) {
  const kind = (stat) => (stat.isFIFO() ? "a named pipe" : stat.isSocket() ? "a socket" : stat.isDirectory() ? "a folder" : stat.isFile() ? "" : "a device");
  const notRegular = (stat) => Object.assign(new Error(`it is ${kind(stat)}, not a file`), { kind: kind(stat) });
  const tooLarge = () => new Error(`over ${MAX_BYTES / 1024 / 1024} MB`);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw notRegular(stat);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw notRegular(opened);
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(1024 * 1024, MAX_BYTES + 1 - size));
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!read) break;
      chunks.push(chunk.subarray(0, read));
      size += read;
      if (size > MAX_BYTES) throw tooLarge();
    }
    return Buffer.concat(chunks);
  } finally {
    fs.closeSync(fd);
  }
}

// The manifest file given to --pwa-check, read as readRegular() reads one,
// but for a named pipe, as a shell's <(...) or /dev/stdin with a pipe
// behind it gives one: that is read to its end, MAX_BYTES at most, within
// ms, the check's --timeout. It is opened without waiting for a writer and
// read as it is written, so one that nothing writes to, or that does not
// end, stops the check at that time. A named pipe a screenshot's src names
// is still no file to read, as nothing may be writing to it; the manifest
// given is the user's own choice, as the address given is. Refused as no
// regular file, a check that took its manifest from a pipe, as a CI step
// can, stopped, where 0.1.3 read it.
function readGiven(file, ms) {
  if (!fs.statSync(file).isFIFO()) return readRegular(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  let opened;
  try {
    opened = fs.fstatSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
  // Something else took its place since it was looked at.
  if (!opened.isFIFO()) {
    fs.closeSync(fd);
    return readRegular(file);
  }
  return new Promise((resolve, reject) => {
    const pipe = new net.Socket({ fd, readable: true, writable: false });
    const chunks = [];
    let size = 0;
    let over = false;
    const end = (err, body) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      pipe.destroy();
      if (err) reject(err);
      else resolve(body);
    };
    const timer = setTimeout(() => end(new Error(`it is a named pipe that did not end in ${Math.round(ms / 1000)} s; give more with --timeout`)), ms);
    pipe.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) return end(new Error(`over ${MAX_BYTES / 1024 / 1024} MB`));
      chunks.push(chunk);
    });
    pipe.on("end", () => end(null, Buffer.concat(chunks)));
    pipe.on("error", (err) => end(err));
  });
}

// A file from the web, every address on the way held to guard, the rule of
// the check (see checkManifest).
async function get(url, accept, guard) {
  const res = await getChecked(url, { guard, headers: { "user-agent": AGENT, accept }, timeoutMs: FETCH_MS, maxBytes: MAX_BYTES + 1 });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  if (res.body.length > MAX_BYTES) throw new Error(`over ${MAX_BYTES / 1024 / 1024} MB`);
  return { url: res.url, type: res.type, body: res.body };
}

function parseJson(text, where) {
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(`${where} is not JSON, so it is not a web app manifest`);
  }
}

// The manifest a page links with <link rel="manifest">, as an address.
function manifestLink(html, base) {
  const attr = (tag, name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/g, "&").trim() : "";
  };
  for (const [tag] of String(html).matchAll(/<link\b[^>]*>/gi)) {
    if (!attr(tag, "rel").toLowerCase().split(/\s+/).includes("manifest")) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    try {
      return new URL(href, base).href;
    } catch {
      return "";
    }
  }
  return "";
}

// What a refusal to read a manifest says of the address that reads it: a
// manifest on another port of a host on the public internet is read when
// the check is given its own address, as the host and port of the address
// it is given are the check's own, and the words name it then, as the
// report does for a screenshot there (see checkManifest()), where the
// check stopped with the reason alone; "" for any other refusal, and for a
// redirect from there to another port.
function readsAt(err, url) {
  let at;
  try {
    at = new URL(url);
  } catch {
    return "";
  }
  if (!err || !err.refused || err.at !== at.href || err.why !== otherPort(at.port, true)) return "";
  return ` To have it read, give the check the manifest's own address, ${at.href}: the host and port of the address it is given are the check's own.`;
}

// target: {file} or {url}. A web address may be the manifest itself or a
// page that links it. guard: the rule for the addresses the check reads.
// timeLimit: how long a manifest given as a named pipe may take to end, in
// ms (see readGiven()).
async function loadManifest(target, guard, timeLimit) {
  if (target.file) {
    let text;
    try {
      text = (await readGiven(target.file, timeLimit)).toString("utf8");
    } catch (err) {
      const why = err.code === "ENOENT" ? "there is no such file" : err.code === "EISDIR" || err.kind === "a folder" ? "it is a folder; give the manifest's file in it" : reasonOf(err);
      throw new Error(`Could not read ${target.file}: ${why}`);
    }
    return { where: target.file, base: { dir: path.dirname(path.resolve(target.file)) }, json: parseJson(text, target.file) };
  }
  let got;
  try {
    got = await get(target.url, "application/manifest+json, application/json;q=0.9, text/html;q=0.8, */*;q=0.5", guard);
  } catch (err) {
    const hint = readsAt(err, target.url);
    throw new Error(`Could not read ${target.url}: ${reasonOf(err)}${hint ? `.${hint}` : ""}`);
  }
  const text = got.body.toString("utf8").replace(/^\uFEFF/, "");
  if (/^\s*\{/.test(text) || (!/html/i.test(got.type) && !/^\s*</.test(text))) return { where: got.url, base: { url: got.url }, json: parseJson(text, got.url) };
  const href = manifestLink(text, got.url);
  if (!href) throw new Error(`${got.url} links no web app manifest (no <link rel="manifest"> in its HTML). Give the manifest's own address or file.`);
  let manifest;
  try {
    manifest = await get(href, "application/manifest+json, application/json;q=0.9, */*;q=0.5", guard);
  } catch (err) {
    const hint = readsAt(err, href);
    throw new Error(`Could not read ${href}, the manifest ${got.url} links: ${reasonOf(err)}${hint ? `.${hint}` : ""}`);
  }
  return { where: manifest.url, page: got.url, base: { url: manifest.url }, json: parseJson(manifest.body.toString("utf8"), manifest.url) };
}

// A screenshot's src written as a data: address, whose picture it holds.
const DATA = /^data:([^,]*?)(;base64)?,(.*)$/is;

// Whether a screenshot's src is read from the web: one of a manifest read
// from the web, or a web address. A data: address holds its picture:
// loadImage() reads one before it asks, and in a manifest file one is no
// web address.
const fromWeb = (src, base) => Boolean(base.url || /^https?:\/\//i.test(src));

// A screenshot's file, from the web or next to a manifest file. Next to a
// file, a src that starts with "/" is taken from the manifest's folder: a
// manifest usually sits at the site's root.
async function loadImage(src, base, guard) {
  const data = DATA.exec(src);
  if (data) return imageInfo(data[2] ? Buffer.from(data[3], "base64") : Buffer.from(decodeURIComponent(data[3]), "utf8"));
  if (fromWeb(src, base)) {
    const url = new URL(src, base.url).href;
    if (!/^https?:/i.test(url)) throw new Error(`${url} is not a web address`);
    return imageInfo((await get(url, "image/png,image/jpeg;q=0.9,image/*;q=0.8,*/*;q=0.5", guard)).body);
  }
  let name = src.split(/[?#]/)[0];
  try {
    name = decodeURIComponent(name);
  } catch {
    // Kept as written.
  }
  return imageInfo(readRegular(path.join(base.dir, name.replace(/^\/+/, ""))));
}

// Whether a screenshot the check's rule refused is one it did not read, or
// one that could not be loaded. Not read: one Chrome could load by rules of
// its own, where the check cannot say whether it shows it, on another port,
// at an address MAKERSMCP_REFUSE_ADDRESSES names, on this machine or its
// network named by a manifest file, or at another address of this machine
// named by a manifest of a site given there, one on a host whose name
// answers both on the public internet and off it (see address.js
// mixedWhy()), and one on a host whose lookup gave no answer in time.
// Could not be loaded: one no visitor's Chrome loads either, on a host
// whose name does not exist, as a typo in a CDN's host, not on the public
// internet in a manifest of a site on it, as a localhost address left from
// development, or that leads to an address that is no web address. Each
// was listed as not read, with nothing to fix.
async function unreadAs(err, guard, target) {
  if (!err || !err.refused) return false;
  if (err.why === NOT_WEB) return false;
  if (err.why === NOT_PUBLIC) return Boolean(target.file);
  if (err.why === UNRESOLVED) return (await guard.lookupWhy(err.at)) !== "no such name";
  return true;
}

// --pwa-check: the manifest read, its screenshots' files read (the first 8,
// as Chrome does), and Chrome's rules applied. The check reads the address
// it is given, and from there web addresses on the public internet only, or
// on the host and port given when that is not on it, as a run opens its
// pages (see address.js): a manifest, the page that links it or a redirect
// cannot send it to this machine or its network. A manifest read from a
// file reads no such address at all. guard: the rule of a run that reads
// the manifest its home page links (--pwa), by which that address is judged
// too, as it is the page's and not the one the run was given. timeLimit:
// the check's --timeout, in ms, for a manifest given as a named pipe.
//
// A manifest file and the screenshots' files next to it are read from the
// disk with no rule, and the rule is made only for a manifest file that
// names a screenshot at a web address, of those Chrome looks at: where this
// machine's network interfaces cannot be read, the rule is not made and
// the check stops before it reads one (see address.js guardFor()). Made up
// front, it stopped the check of every manifest file there, one whose
// screenshots are all files too, as in a container whose seccomp profile
// refuses a netlink socket, where 0.1.3 checked it.
async function checkManifest(target, { guard: given = null, timeLimit = 300_000 } = {}) {
  let guard = given || (target.file ? null : await guardFor(target.url || ""));
  const found = await loadManifest(target, guard, timeLimit);
  const json = found.json && typeof found.json === "object" && !Array.isArray(found.json) ? found.json : {};
  const list = Array.isArray(json.screenshots) ? json.screenshots : [];
  const srcs = list.slice(0, LOOKED_AT).map((entry) => (entry && typeof entry.src === "string" ? entry.src.trim() : ""));
  if (!guard && srcs.some((src) => src && fromWeb(src, found.base))) guard = await guardFor("");
  const images = await Promise.all(srcs.map((src) => (src ? loadImage(src, found.base, guard).catch(async (err) => ((await unreadAs(err, guard, target)) ? { unread: reasonOf(err) } : { error: reasonOf(err) })) : undefined)));
  // A file with screenshots and nothing else, such as the
  // manifest-screenshots.json of a run, is a part of a manifest: its
  // description is not looked for.
  const whole = ["name", "short_name", "description", "start_url", "icons"].some((key) => key in json);
  const report = checkScreenshots(json.screenshots, images, whole ? { description: json.description } : {});
  // From a manifest file the check reads port 80 and 443 of hosts on the
  // public internet only; given the manifest's own address on another
  // port, or on this machine, it reads the screenshots on that host and
  // port too, as a run given that address opens its pages. Not one that a
  // redirect leads away from, nor one MAKERSMCP_REFUSE_ADDRESSES refuses or
  // whose name cannot be looked up, which that address would not read
  // either.
  if (target.file) {
    const elsewhere = new Set();
    for (const shot of report.screenshots) {
      if (!shot.unread || !/^https?:\/\//i.test(shot.src)) continue;
      try {
        const url = new URL(shot.src);
        if (shot.unread === `it is ${NOT_PUBLIC}` || /^it is at \S+, (?:an address|on a network) of this machine$/.test(shot.unread) || (url.port && shot.unread === `it is ${otherPort(url.port, false)}`)) elsewhere.add(url.origin);
      } catch {
        // No address to name.
      }
    }
    if (elsewhere.size) report.unchecked.push(`To have a screenshot on ${[...elsewhere].join(" or ")} read, give the check the manifest's own address on its host and port: the host and port of the address it is given are the check's own.`);
  }
  return {
    manifest: found.where,
    page: found.page || "",
    name: String(json.name || json.short_name || ""),
    ...report,
  };
}

// A check as text, for people.
function describeCheck(report) {
  const lines = [`Checked ${report.manifest}${report.page ? `, the manifest of ${report.page}` : ""}`, ""];
  // A side with none shown and one not read: the check cannot say.
  const unreadOn = (desktop) => report.screenshots.filter((shot) => shot.unread && isWide(shot) === desktop && shot.n <= LOOKED_AT).map((shot) => shot.n);
  const dialog = (shown, desktop) => (shown.length ? `the richer install dialog, with ${numbers(shown)}` : unreadOn(desktop).length ? `not known: the check did not read ${numbers(unreadOn(desktop))}` : "the plain install dialog");
  lines.push(`  Desktop  ${dialog(report.desktop, true)}`, `  Phone    ${dialog(report.phone, false)}`);
  if (report.screenshots.length) {
    lines.push("");
    // A line for each screenshot Chrome looks at, the first LOOKED_AT, and
    // one for the rest, which "To fix" names: with a line for each, a
    // manifest of 600 screenshots made a report longer than the 48,000
    // characters makersmcp keeps of it from its start, and the check's
    // verdict, which comes after them, never reached the assistant. The
    // longest src, read one by one: spread into the arguments of
    // Math.max(), which Node.js holds to its stack, a manifest's 200,000
    // screenshots stopped the check with "Maximum call stack size exceeded".
    const looked = report.screenshots.slice(0, LOOKED_AT);
    let longest = 3;
    for (const shot of looked) longest = Math.max(longest, shot.src.length);
    const width = Math.min(44, longest);
    for (const shot of looked) {
      const src = shot.src.length > width ? `${shot.src.slice(0, width - 3)}...` : shot.src || "(no src)";
      const file = shot.image ? `${shot.image.width && shot.image.height ? dims(shot.image) : "?"} ${NAMES[shot.image.format] || "not an image"}` : shot.error ? "not loaded" : "not read";
      const where = shot.shownOn.length ? `shown on ${shot.shownOn.map((platform) => `${platform}s`).join(" and ")}` : shot.unread ? "not known" : "left out";
      lines.push(`  ${String(shot.n).padStart(2)}  ${src.padEnd(width)}  ${file.padEnd(14)}  ${(shot.formFactor || "none").padEnd(6)}  ${where}`);
    }
    const past = report.screenshots.slice(LOOKED_AT).map((shot) => shot.n);
    if (past.length) {
      const which = numbers(past);
      lines.push(`  ${which.charAt(0).toUpperCase()}${which.slice(1)}: not read, as Chrome looks at the first ${LOOKED_AT} only`);
    }
  }
  const unchecked = report.unchecked || [];
  if (unchecked.length) lines.push("", "Not checked:", ...unchecked.map((text) => `  - ${text}`));
  if (report.problems.length) lines.push("", "To fix:", ...report.problems.map((text) => `  - ${text}`));
  else lines.push("", unchecked.length ? "Nothing to fix in the screenshots the check read." : "Nothing to fix: Chrome shows them as they are.");
  if (report.tips.length) lines.push("", "Worth adding:", ...report.tips.map((text) => `  - ${text}`));
  // What the manifest says (a src, a type) stays on its line.
  return lines.map(oneLine).join("\n");
}

module.exports = {
  PWA_SHOTS,
  LOOKED_AT,
  PHONE_SHOWS,
  imageInfo,
  checkScreenshots,
  labelOf,
  planPwa,
  manifestLink,
  checkManifest,
  describeCheck,
};
