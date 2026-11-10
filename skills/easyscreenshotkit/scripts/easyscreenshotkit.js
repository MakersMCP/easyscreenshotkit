#!/usr/bin/env node
"use strict";

const fs = require("fs");
const { takeShots, normalizeUrl } = require("./lib/shots");
const { pathOf, printable } = require("./lib/pick");
const { stopOnSignals } = require("./lib/outdir");
const { checkManifest, describeCheck } = require("./lib/pwa");
const version = require("./lib/version");

const USAGE = `Usage: easyscreenshotkit <url> [options]
       easyscreenshotkit --pwa-check <manifest>
       easyscreenshotkit demo <url> [options]

Opens a website the way a browser draws it, picks the pages worth showing
(home, pricing, features and the like), hides cookie banners, chat bubbles
and other floating boxes, and saves desktop, phone and whole-page
screenshots in one folder. manifest.json is for tools, SCREENSHOTS.md for
people and coding agents, sheet.png shows every page on one picture.

Options:
  --out <dir>       where to save (default: ./easyscreenshotkit-<host>)
  --pages <n>       how many pages, the home page included (default: 5, at
                    most 12); each --page is taken even past it
  --page <path>     take this page too, e.g. --page /pricing, or a view of an
                    app such as '/app/#/plants' (repeat for more)
  --sizes <list>    desktop, mobile, iphone, full, mobile-full or WxH, each with
                    an optional @scale (default: desktop,mobile,full)
  --theme <name>    light, dark or both (default: light)
  --lang <code>     the site's version in this language, when it has one
  --hide <css>      hide one more element (repeat for more)
  --reduced-motion  ask the site for its reduced-motion version
  --no-clean        take the pages as they come, banners and bubbles included
  --pwa             also save screenshots for a web app manifest, in pwa/
  --pwa-check <m>   check the screenshots of a web app manifest instead: give
                    the manifest's file or address, or the site's address
  --json            print manifest.json instead of a summary
  --timeout <s>     give up after this many seconds (default: 300)
  -h, --help        show this help
  -v, --version     show the version

Sizes: desktop is 1600x900 at 2x, mobile 360x640 at 3x (1080x1920), iphone
440x956 at 3x (1320x2868), full the whole page at 1x, mobile-full the whole
phone page at 2x. 1270x760@2 is a Product Hunt gallery image.

A #route (#/ or #!) in the address or in --page is kept: the page opens on
that view, waits in each window until the view's data has come and it shows
no loading sign, 10 s at most in the first and 2 s in the others when it
was not ready by then (a note says so when it was not, and --pwa leaves
that window's capture out; a view that looks drawn with a request still
open, as a long poll keeps one, is kept, with a note), and is named after
it, 02-app-plants-desktop.png for /app/#/plants. A --page that is only a
route, such as '#/plants', is that view of the address given, with its
query, and a --page with a query and a route keeps both. Any other
fragment, such as #pricing or #inbox, is left out, with a note. The tour
follows paths only: the #route links on the home page, the address given
and each --page, and the #routes in the site's sitemap, are listed with the
pages it left out. An address that answers with a file to download is
refused and named in the report, and the browser saves nothing.

From the address given the run opens web addresses on the public internet
only, and that host and port when the address given is on this machine or
its network, as a site you run there is: a page, a redirect or a sitemap
at localhost, 127.0.0.1, a private network or another address of that kind
is not opened, and the report names it with the reason, and neither is a
frame or a window a page opens there. A page that moves on to one, or to a
file, before it has loaded is refused as a redirect there is. --pwa and
--pwa-check read a manifest and its screenshots by the same rule, and from
a manifest file no screenshot at such an address. The rule is for the
pages the run opens and the files it reads itself: a page's own pictures,
styles, scripts and the data it fetches are left to the browser's own
rules, and on a site you run on your machine they can come from other
ports of it.

When the address given is another page than the home page, or a #route of
it, a home page that answers an error or a bot check, or cannot be opened,
is left out with a note, and the run starts at the address given. An
address given that is itself the home page still fails.

The folder has to be new, empty or hold an earlier run. A run builds its
files in a folder whose name starts with a dot, inside the folder it saves
in, and moves them into place once it has ended well, replacing the earlier
run's. A run that fails or is stopped with Ctrl-C or a TERM signal leaves
the earlier run's files as they were and adds nothing.

--pwa takes each page's first screen at 1920x1080 and on a phone at
1080x1920, checks them against Chrome's rules for its richer install
dialog, and writes pwa/manifest-screenshots.json with the entries for them.
--pwa-check needs no browser; it exits with 1 when something needs fixing.

For a demo video of the site instead, run easyscreenshotkit demo <url>; see
easyscreenshotkit demo --help.

Needs Node 22 or newer and Chrome, Chromium, Edge or Brave. Set CHROME_PATH
to pick the browser. The run drives it over a pipe, so it opens no port.`;

function parse(argv) {
  const options = { pages: 5, extra: [], hide: [], sizes: "desktop,mobile,full", theme: "light", lang: "", reducedMotion: false, clean: true, pwa: false, pwaCheck: "", json: false, timeout: 300 };
  const rest = [];
  const VALUED = new Set(["--out", "--pages", "--page", "--sizes", "--theme", "--lang", "--hide", "--pwa-check", "--timeout"]);
  const set = (name, value) => {
    if (name === "--out") options.out = value;
    else if (name === "--pwa-check") options.pwaCheck = value;
    else if (name === "--pages") options.pages = Number(value);
    else if (name === "--page") options.extra.push(value);
    else if (name === "--sizes") options.sizes = value;
    else if (name === "--theme") options.theme = value.toLowerCase();
    else if (name === "--lang") options.lang = value;
    else if (name === "--hide") options.hide.push(value);
    else if (name === "--timeout") options.timeout = Number(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-clean") options.clean = false;
    else if (arg === "--reduced-motion") options.reducedMotion = true;
    else if (arg === "--pwa") options.pwa = true;
    else if (VALUED.has(name)) {
      const value = name !== arg ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (name === arg && value.startsWith("--"))) throw new Error(`${name} needs a value`);
      set(name, value);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (!(Number.isInteger(options.pages) && options.pages >= 1 && options.pages <= 12)) throw new Error("--pages takes 1 to 12");
  if (!(options.timeout >= 30 && options.timeout <= 900)) throw new Error("--timeout takes 30 to 900 seconds");
  if (!["light", "dark", "both"].includes(options.theme)) throw new Error("--theme takes light, dark or both");
  if (options.lang && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(options.lang)) throw new Error(`--lang takes a language code such as tr or pt-BR, not ${options.lang}`);
  if (options.pwaCheck && (rest.length || options.pwa)) throw new Error("--pwa-check takes the manifest, or the site's address, as its value and runs on its own, for example: easyscreenshotkit --pwa-check acme.com");
  if (!options.help && !options.version && !options.pwaCheck && rest.length !== 1) throw new Error("Give one website address, for example: easyscreenshotkit acme.com");
  return { ...options, url: rest[0] };
}

// What --pwa-check reads: a manifest file on this machine, else a web
// address. A path whose file is not there is still a path, not an address
// on a host named after its first folder: one that starts with /, ., ~ or
// a drive letter, holds a backslash, starts with a folder name with no dot
// in it (public/manifest.json), or is a file's name alone
// (manifest.json). Any other value with no scheme, such as acme.com,
// acme.com/manifest.json or localhost:3000, is an address.
function manifestTarget(value) {
  if (fs.existsSync(value) && fs.statSync(value).isFile()) return { file: value };
  const text = String(value);
  let local = false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const first = text.split("/")[0];
    if (/^([/.~\\]|[a-z]:)/i.test(text) || text.includes("\\")) local = true;
    else if (first === text) local = /\.(json|webmanifest)$/i.test(text);
    else local = !first.includes(".") && !first.includes(":") && first.toLowerCase() !== "localhost";
  }
  return local ? { file: value } : { url: normalizeUrl(value) };
}

// --pwa-check: a manifest file on this machine, else a web address.
async function pwaCheck(options) {
  let report;
  try {
    report = await checkManifest(manifestTarget(options.pwaCheck));
  } catch (err) {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`easyscreenshotkit: ${printable(err.message)}\n`);
    process.exit(1);
  }
  process.stdout.write(options.json ? JSON.stringify(report, null, 2) + "\n" : printable(describeCheck(report)) + "\n");
  process.exitCode = report.ok ? 0 : 1;
}

// The lines a run with --pwa adds to the summary.
function pwaLines(pwa) {
  const lines = [];
  if (pwa.file) {
    const count = (form) => pwa.screenshots.filter((shot) => shot.form_factor === form).length;
    lines.push(`  PWA     ${pwa.file}: ${count("wide")} wide at 1920x1080 and ${count("narrow")} narrow at 1080x1920, within Chrome's rules`);
  } else lines.push("  PWA     no screenshot for a web app manifest could be taken");
  const left = [...new Set(pwa.leftOut.map((item) => item.reason))];
  for (const reason of left) {
    const pages = pwa.leftOut.filter((item) => item.reason === reason).map((item) => `${String(item.page).padStart(2, "0")} ${item.form_factor}`);
    lines.push(`          left out ${pages.join(", ")}: ${reason}`);
  }
  if (pwa.note) lines.push(`          ${pwa.note}${pwa.site && pwa.site.problems && pwa.site.problems.length ? " SCREENSHOTS.md says what to fix in it." : ""}`);
  return lines;
}

function summary({ dir, manifest }) {
  const lines = [`Saved ${manifest.pages.length === 1 ? "1 page" : `${manifest.pages.length} pages`} of ${new URL(manifest.url).hostname.replace(/^www\./, "")} to ${dir}`, ""];
  const width = Math.max(...manifest.pages.map((page) => page.slug.length));
  for (const page of manifest.pages) {
    const where = pathOf(page.url);
    lines.push(`  ${String(page.n).padStart(2, "0")} ${page.slug.padEnd(width)}  ${where}  (${page.why})`);
    lines.push(`     ${" ".repeat(width)}  ${page.shots.map((shot) => shot.file).join(", ") || "no files"}`);
  }
  if (manifest.sheet) lines.push("", `  Sheet   ${manifest.sheet.file} (${manifest.sheet.width}x${manifest.sheet.height})`);
  if (manifest.pwa) lines.push(...(manifest.sheet ? [] : [""]), ...pwaLines(manifest.pwa));
  // The first pages left out, those with the same reason together.
  const reasons = new Map();
  for (const skip of manifest.skipped.slice(0, 6)) reasons.set(skip.reason, [...(reasons.get(skip.reason) || []), pathOf(skip.url)]);
  const left = [...reasons].map(([reason, paths]) => `${paths.join(", ")} (${reason})`);
  if (left.length) lines.push(`  Skipped ${left.join("; ")}${manifest.skipped.length > 6 ? ` and ${manifest.skipped.length - 6} more` : ""}`);
  for (const note of manifest.notes) lines.push(`  Note    ${note}`);
  lines.push("", `Read ${dir}/SCREENSHOTS.md for the details.`);
  return lines.join("\n");
}

async function main() {
  if (process.argv[2] === "demo") return require("./lib/demo").main(process.argv.slice(3));
  let options;
  try {
    options = parse(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`easyscreenshotkit: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${version}\n`);
  if (options.pwaCheck) return pwaCheck(options);
  stopOnSignals({ name: "easyscreenshotkit", json: options.json });
  try {
    const result = await takeShots(options.url, {
      dir: options.out,
      pages: options.pages,
      extra: options.extra,
      sizes: options.sizes,
      theme: options.theme,
      lang: options.lang,
      hide: options.hide,
      reducedMotion: options.reducedMotion,
      clean: options.clean,
      pwa: options.pwa,
      timeLimit: options.timeout * 1000,
      log: options.json ? () => {} : (line) => process.stderr.write(`${printable(line)}\n`),
    });
    process.stdout.write(options.json ? JSON.stringify(result.manifest, null, 2) + "\n" : printable(summary(result)) + "\n");
  } catch (err) {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`easyscreenshotkit: ${printable(err.message)}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { parse, summary, manifestTarget };
