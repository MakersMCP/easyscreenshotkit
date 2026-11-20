"use strict";

// easyscreenshotkit demo: a short video of a website. A tour of the pages the
// screenshots would take, or the steps written in a file, recorded in the
// user's own Chrome and encoded with their own ffmpeg. What comes out, in
// one folder:
//
//   demo.mp4     1920x1080, H.264: the page in a browser window on a
//                backdrop, with a pointer, smooth scrolling and a zoom on
//                each click
//   demo.gif     the same, small enough for a README
//   poster.png   a still of the first page, for a video's cover
//   steps.json   every step with where it starts and ends, in seconds and in
//                frames, for narration, music or captions laid over it
//   demo.yaml    the tour as steps, to edit and record again (tours only)

const fs = require("fs");
const path = require("path");
const { launch, browserProblem, busy, CRASHED } = require("./chrome");
const { normalizeUrl, fragmentNotes, siteName, unreadNote } = require("./shots");
const { homeOf, siteOf, routeOf, viewKey, viewOf, pathOf, readable, printable } = require("./pick");
const { Recorder } = require("./record");
const { loadSteps, toYaml, targetText, hideRefusal } = require("./steps");
const { pickPages, tourSteps } = require("./tour");
const { layoutOf, LOOKS, backdropOf, checkBackdrop, renderVideo, renderStill } = require("./compose");
const { cameraAt } = require("./motion");
const { ffmpegReady, pickEncoder, startVideo, makeGif } = require("./ffmpeg");
const { tagPng, pngSize, pngFileIsWhole } = require("./png");
const { setTimeLimit, timeLeft } = require("./time");
const { guardFor, hostRefusals, refusalsProblem, unresolvedError, refusedError } = require("./address");
const { begin, checkDir, stopOnSignals } = require("./outdir");
const programs = require("./programs");
const version = require("./version");

const USAGE = `Usage: easyscreenshotkit demo <url> [options]

Records a short demo video of a website: a tour of the pages worth showing,
or the steps you write in a file. The page plays in a browser window on a
backdrop, with a visible pointer, smooth scrolling and a zoom on each
click. Cookie banners and chat bubbles are hidden, never clicked. Saves
demo.mp4 (1920x1080, H.264), demo.gif, poster.png and steps.json, which
says where every step starts and ends, in seconds and in frames.

Options:
  --steps <file>      follow the steps in this YAML or JSON file instead of
                      a tour: visit, scroll, click, type, wait, hover, key
  --out <dir>         where to save (default: ./easyscreenshotkit-demo-<host>)
  --pages <n>         pages in the tour, the home page included (default: 4,
                      at most 8)
  --page <path>       take this page in the tour, e.g. --page /pricing, or a
                      view of an app such as '/app/#/plants'
  --zoom <n>          how far a click zooms in, 1 to 2.5 (default: 1.5)
  --no-zoom           no zoom on clicks
  --background <bg>   behind the window: a colour, two colours for a
                      gradient, or a picture file
  --no-frame          the page alone, filling the video
  --fps <n>           frames a second, 24 to 60 (default: 30)
  --theme <name>      light or dark (default: light)
  --lang <code>       the site's version in this language, when it has one
  --hide <css>        hide one more element (repeat for more)
  --reduced-motion    ask the site for its reduced-motion version
  --no-clean          keep the banners and bubbles; --hide still hides what it
                      names
  --no-gif            skip demo.gif
  --json              print steps.json instead of a summary
  --timeout <s>       give up after this many seconds (default: 900)
  -h, --help          show this help

--hide takes a CSS selector, as .cookie-bar or '#chat, .promo', and so does
each item of a steps file's hide: each is a rule of its own on the page,
and one that opens a comment, a quote, a bracket or a parenthesis it does
not close, or holds {, }, ; or @ outside its quotes, is refused before any
work. One the browser does not read as a selector hides nothing, with a
note in steps.json.

A #route (#/ or #!) in the address, in --page or in a visit step is kept,
and every view the video shows, one a click opened included, is a page of
its own in steps.json. A --page that is only a route, such as '#/plants',
is that view of the address given, with its query, and a --page with a
query and a route keeps both. Any other fragment in the address or in
--page, such as #pricing or #inbox, is left out, with a note; a visit step
keeps it. A tour follows paths only: the notes in steps.json name the
#route links on the home page, the address given and each --page, and the
#routes in the site's sitemap. An address that answers with a file to
download is refused: a tour leaves it out and says so, a visit step to one
stops the demo, and the browser saves nothing. A visit or a click to a page
that moves on to a file before anything of it is drawn stops the demo too;
one drawn before it does, as a page that thanks for a download, is shown as
it is drawn, with a note in steps.json.

From the address given a demo opens web addresses on the public internet
only, on port 80 or 443 unless they are on the scheme, host and port
given, and that host and port when the address given is on this machine or
its network, as a site you run there is; a steps file's url is the address
given when the command line gives none. A visit step to localhost,
127.0.0.1, a private network or another address of that kind, to another
port of a host on the public internet, or to a page that redirects to one
or moves on to one before it has loaded, stops the demo, and so does
a click on a link to a page that moves on so; a click on a link to one, or
to a page that redirects to one, leaves the page where it was, with a note
in steps.json, and a frame or a window a page opens there is not loaded; a
tour leaves such a page out and says so. A host whose name does not
resolve here, or gives no answer in 10 s, is not opened either, and an
address given on one stops the demo. The rule is for the pages the demo
opens: a page's own pictures, styles, scripts and the data it fetches are
left to the browser's own rules, and on a site you run on your machine
they can come from other ports of it.

MAKERSMCP_REFUSE_ADDRESSES, a comma list of IP addresses and CIDR ranges,
names addresses the machine refuses besides, as a service that runs the
kit for others names its own: no page is opened at one, the address given
included, which then stops the demo. Empty or unset, it refuses nothing
more; a value that does not parse stops the demo before any work, with
exit code 2.

A click on a link to an address of another kind, such as mailto:, or to
a page that redirects to one, or a page that goes to one, leaves the page
where it is, with a note in steps.json: on Linux the browser hands it to
no program of the machine, and on macOS and Windows it can hand it to the
mail program there; a redirect to one is not followed. A visit to an
address that redirects to one, or a visit or a click to a page that goes
to one before anything of it is drawn, stops the demo, as one that goes
to a file then does, and a tour leaves such a page out and says so. Some
versions of Chrome take no more clicks or keys in the tab once a page of
it has tried to open a tel: or news: address, and the demo then stops at
the next step that clicks, types, presses a key or hovers, and says so.

When the address given is another page than the home page, or a #route of
it, a tour whose home page answers an error or a bot check, or cannot be
opened, leaves it out with a note and starts at the address given. An
address given that is itself the home page still fails.

A tour looks for pages of its own only while more than 4 minutes of
--timeout are left, so a shorter one takes the home page, the address
given and each --page. Short of time as it records, it leaves out the
scrolls and then the pages it picked itself, names each page it left out
in steps.json, and fails when it has no time to show the address given.
So does a tour that has none of the pages asked for, the address given and
each --page, to show, as when the address answers an error.

A demo builds its files inside the folder it saves in and moves them into
place once it has ended well, replacing an earlier demo's. One that fails or
is stopped with Ctrl-C or a TERM signal leaves an earlier demo there as it
was and adds nothing.

Needs Node 22 or newer, Chrome, Chromium, Edge or Brave, and ffmpeg. Set
CHROME_PATH or FFMPEG_PATH to pick them, as a path or a name on PATH; one
the system cannot start stops the demo before any work, with what is wrong
with it, and so does a browser that preloads pages though its profile asks
it not to, as a Chrome policy can make it. The demo drives the browser over
a pipe, so it opens no port.`;

function parseDemo(argv) {
  const options = { pages: 4, extra: [], hide: [], zoom: 1.5, frame: true, background: "", fps: 30, theme: "light", lang: "", reducedMotion: false, clean: true, gif: true, json: false, timeout: 900 };
  const rest = [];
  const VALUED = new Set(["--steps", "--out", "--pages", "--page", "--zoom", "--background", "--fps", "--theme", "--lang", "--hide", "--timeout"]);
  const set = (name, value) => {
    if (name === "--steps") options.steps = value;
    else if (name === "--out") options.out = value;
    else if (name === "--pages") options.pages = Number(value);
    else if (name === "--page") options.extra.push(value);
    else if (name === "--zoom") options.zoom = Number(value);
    else if (name === "--background") options.background = value;
    else if (name === "--fps") options.fps = Number(value);
    else if (name === "--theme") options.theme = value.toLowerCase();
    else if (name === "--lang") options.lang = value;
    else if (name === "--hide") {
      const refused = hideRefusal(value.trim(), "--hide takes a CSS selector");
      if (refused) throw new Error(refused);
      options.hide.push(value);
    } else if (name === "--timeout") options.timeout = Number(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "-v" || arg === "--version") options.version = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--no-zoom") options.zoom = 1;
    else if (arg === "--no-frame") options.frame = false;
    else if (arg === "--no-gif") options.gif = false;
    else if (arg === "--no-clean") options.clean = false;
    else if (arg === "--reduced-motion") options.reducedMotion = true;
    else if (VALUED.has(name)) {
      const value = name !== arg ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (name === arg && value.startsWith("--"))) throw new Error(`${name} needs a value`);
      set(name, value);
    } else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else rest.push(arg);
  }
  if (!(Number.isInteger(options.pages) && options.pages >= 1 && options.pages <= 8)) throw new Error("--pages takes 1 to 8");
  if (!(options.zoom >= 1 && options.zoom <= 2.5)) throw new Error("--zoom takes 1 to 2.5");
  if (!(Number.isInteger(options.fps) && options.fps >= 24 && options.fps <= 60)) throw new Error("--fps takes 24 to 60");
  if (!(options.timeout >= 60 && options.timeout <= 1800)) throw new Error("--timeout takes 60 to 1800 seconds");
  if (!["light", "dark"].includes(options.theme)) throw new Error("--theme takes light or dark");
  if (options.lang && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(options.lang)) throw new Error(`--lang takes a language code such as tr or pt-BR, not ${options.lang}`);
  if (options.steps && (options.extra.length || argv.some((arg) => arg === "--pages" || arg.startsWith("--pages=")))) throw new Error("--pages and --page are for the tour; a steps file says which pages to visit");
  if (!options.help && !options.version && (rest.length > 1 || (!rest.length && !options.steps))) throw new Error("Give one website address, for example: easyscreenshotkit demo acme.com");
  return { ...options, url: rest[0] || "" };
}

// Files a demo run writes, by name. demo.yaml is a tour's: a run from a
// steps file never touches it, since that may be the very file it follows.
const RUN_FILES = ["demo.mp4", "demo.gif", "poster.png", "steps.json"];
const TOUR_FILE = "demo.yaml";
// Where 0.1.1 kept a run's frames, in the folder itself.
const FRAMES = /^\.frames-[A-Za-z0-9]{6}$/;

const isFile = (at) => {
  const s = fs.lstatSync(at, { throwIfNoEntry: false });
  return Boolean(s) && !s.isDirectory();
};

// A file as the disk knows it, whatever path or name reaches it: on a disk
// that ignores letter case (macOS, Windows) Steps.json is steps.json, and a
// link or another spelling of the folder leads to the same file. "" when
// nothing is there, or the disk numbers no files.
function fileId(at) {
  try {
    const s = fs.statSync(at, { bigint: true });
    return s.ino ? `${s.dev}:${s.ino}` : "";
  } catch {
    return "";
  }
}

// The run's folder, for outdir.js: created when missing, used when it is
// empty or an earlier demo made it, whose files the new run's replace once
// it has ended well, refused when it holds anything else, so a run never
// mixes into someone's own files. The steps file the run follows may sit in
// it, under any name the demo does not save: it is never moved, nor
// replaced. It is told by what the disk says it is, not by its path.
function demoSpec({ steps = "", tour = false } = {}) {
  const keep = steps ? path.resolve(steps) : "";
  const keepId = keep ? fileId(keep) : "";
  const isKeep = (at) => Boolean(keep) && (path.resolve(at) === keep || (keepId !== "" && fileId(at) === keepId));
  const names = [...RUN_FILES, ...(tour ? [TOUR_FILE] : [])];
  return {
    marker: "steps.json",
    // Demos from when the tool was called easyscreenshot count too.
    accepts: (old) => old.kind === "demo" && /^easyscreenshot(kit)? /.test(String(old.tool || "")),
    refusal: (dir) => `${dir} is not empty and holds no earlier easyscreenshotkit demo. Pick another folder with --out.`,
    earlier: (target) => names.filter((name) => isFile(path.join(target, name)) && !isKeep(path.join(target, name))),
    ignore: (name, target) => FRAMES.test(name) || isKeep(path.join(target, name)),
    files: names,
    claim: (dir, target) => {
      const name = names.find((name) => isKeep(path.join(target, name)));
      if (name) throw new Error(`${steps} is the steps file this demo follows, and the demo saves its own ${name} in its place. Give the steps file another name, or pick another folder with --out.`);
    },
    leftovers: FRAMES,
  };
}

// Opens a demo's run in dir (see outdir.js).
function openDemo(dir, { steps = "", tour = false } = {}) {
  return begin(dir, demoSpec({ steps, tour }));
}

// Whether a demo may save in dir: it is missing, empty or holds an earlier
// demo. Throws the reason when it may not; changes nothing.
function prepareDemoDir(dir, { steps = "", tour = false } = {}) {
  checkDir(dir, demoSpec({ steps, tour }));
}

// A browser or a tab lost in the middle of a demo leaves a video that shows
// the page standing still from that moment on, or a tour that ended early:
// the demo fails, and an earlier one stays as it was. So does a browser that
// stops answering.
const BROWSER_GONE = "The browser ended in the middle of the demo (it crashed, or was killed), so no demo was saved.";
const BROWSER_STALLED = "The browser stopped answering in the middle of the demo, so no demo was saved. The machine may be too busy: try again.";
const TAB_CRASHED = "The browser's tab crashed in the middle of the demo, so no demo was saved.";
// A browser that still answers, but took longer than a frame may take to
// draw one, as on a machine too busy to run it: cut, when the run's time
// made the wait shorter.
const drawnTooSlowly = (cut) => `The browser took too long to draw the demo's frames, so no demo was saved. ${busy(cut)}`;

// steps.json's note on a document the page did not open, as the run does
// not open its address: the page itself, a frame of it, or a window.
// handed: an address of another kind, as mailto:, on a system where the
// browser may have handed it to a program of the machine.
function barredNote({ url, why, kind, handed = false }) {
  const where = String(url).slice(0, 200);
  const end = handed ? "the browser may have handed it to a program of this machine" : "it was not opened";
  if (kind === "frame") return `A frame of the page tried to open ${where}, which is ${why}: ${end}.`;
  if (kind === "window") return `The page tried to open a window at ${where}, which is ${why}: ${end}.`;
  return `The page tried to open ${where}, which is ${why}: ${end}, and the page stayed where it was.`;
}

// steps.json's notes on what the demo's pages tried to open that the run
// does not open, and on the downloads they started: the pages' own moves
// first, then their windows, then their frames, NOTED at most of each, and
// how many more. Taken as they came, a page whose frames were refused first
// had its own move left out of the notes.
const NOTED = 5;

function refusalNotes({ barred = [], refused = [] }) {
  const rank = { page: 0, window: 1, frame: 2 };
  const sorted = [...barred].sort((a, b) => rank[a.kind] - rank[b.kind]);
  const notes = [];
  for (const url of refused.slice(0, NOTED)) notes.push(`The page started a download of ${String(url).slice(0, 200)}, which the browser refused: no file was saved.`);
  if (refused.length > NOTED) notes.push(`The pages started ${refused.length - NOTED} more ${refused.length - NOTED === 1 ? "download" : "downloads"}, which the browser refused: no file was saved.`);
  notes.push(...sorted.slice(0, NOTED).map(barredNote));
  const more = sorted.length - NOTED;
  if (more > 0) notes.push(`The pages, their frames or their windows tried to open ${more === 1 ? "1 more address, which was" : `${more} more addresses, which were`} not opened.`);
  return notes;
}

const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

// How long the page shown last stays on camera at least, in seconds of the
// video, as a tour waits after each page it opens.
const LAST_PAGE = 1.1;

// The frame of the video a moment falls on, counted from the seconds
// steps.json writes for it, so the two always agree: counted from the
// moment itself, one half a frame from the next could name the frame before
// the one its seconds say.
const frameAt = (t, fps) => Math.round(round(t) * fps);

// steps.json's steps: each step the run took, with where it starts and
// ends in seconds and in the frames those seconds fall on. toVideo(t,
// point): where a point of the page is in the video at a moment.
function stepEntries(records, { fps, toVideo }) {
  const frameOf = (t) => frameAt(t, fps);
  return records.map((record) => {
    const { step } = record;
    const written = asWritten(step);
    const entry = { n: record.n, action: step.action, label: what(step) };
    if (step.action === "visit") entry.url = record.url;
    if (written.target) entry.target = targetText(written.target);
    if (step.into) entry.target = targetText(step.into);
    if (step.text !== undefined && step.action === "type") entry.text = step.text;
    if (step.key) entry.key = step.key;
    if (step.note) entry.note = step.note;
    Object.assign(entry, { start: round(record.start), end: round(Math.max(record.start, record.end)), startFrame: frameOf(record.start), endFrame: frameOf(Math.max(record.start, record.end)) });
    // Where and when the pointer pressed, in the video's pixels: for a
    // callout, or a click sound laid on that frame.
    if (record.at && record.pressed !== undefined) Object.assign(entry, { at: toVideo(record.pressed, record.at), pressedAt: round(record.pressed), pressedFrame: frameOf(record.pressed) });
    else if (record.at) entry.at = toVideo(record.end, record.at);
    if (record.opened) entry.opened = record.opened;
    entry.page = record.url;
    return entry;
  });
}

// steps.json's pages: the pages in the order the video shows them, each
// #route a page of its own, with where each starts and ends in seconds and
// in frames; an address that comes again right after itself, or with
// another anchor, is the same page. A page no frame of the video shows is
// not one of them: frames, how many the video has. tour: the tour's pages,
// for why each was taken.
function pageEntries(take, { fps, tour = null, frames = Infinity }) {
  const frameOf = (t) => frameAt(t, fps);
  const same = (a, b) => viewOf(a.url) === viewOf(b.url);
  const views = take.urls.filter((change, i) => i === 0 || !same(change, take.urls[i - 1]));
  // The first frame drawn at or after a moment: frame k shows what came by
  // k / fps (see compose.js).
  const firstAt = (t) => Math.max(0, Math.ceil((t - 1e-6) * fps));
  const shown = views.filter((change, i) => firstAt(change.t) < Math.min(frames, i + 1 < views.length ? firstAt(views[i + 1].t) : Infinity));
  const changes = shown.filter((change, i) => i === 0 || !same(change, shown[i - 1]));
  return changes.map((change, i) => {
    const end = i + 1 < changes.length ? changes[i + 1].t : take.duration;
    const known = take.pages.find((page) => page.url === change.url);
    const picked = tour && tour.pages.find((page) => viewKey(page.url) === viewKey(change.url));
    return {
      n: i + 1,
      url: change.url,
      title: known ? known.title : "",
      ...(picked ? { kind: picked.kind, why: picked.why } : {}),
      start: round(change.t),
      end: round(end),
      startFrame: frameOf(change.t),
      endFrame: frameOf(end),
    };
  });
}

function what(step) {
  if (step.label) return step.label;
  if (step.action === "visit") return `Open ${readable(step.url)}`;
  if (step.action === "scroll") return step.by !== undefined ? `Scroll ${step.by > 0 ? "down" : "up"} ${Math.abs(step.by)} px` : typeof step.to === "object" ? `Scroll to ${targetText(step.to)}` : `Scroll to ${step.to}`;
  if (step.action === "click") return `Click ${targetText(step.target)}`;
  if (step.action === "hover") return `Point at ${targetText(step.target)}`;
  if (step.action === "type") return `Type "${step.text.length > 30 ? `${step.text.slice(0, 30)}…` : step.text}"`;
  if (step.action === "key") return `Press ${step.key}`;
  if (step.action === "wait") return step.for ? `Wait for ${targetText(step.for)}` : `Wait ${step.seconds} s`;
  return step.action;
}

// A tour's internal steps as a steps file writes them: a click on a link by
// its words when it has some, else by its href as the page wrote it
// (a[href="#/plants"]), so a route in other letters is matched as the page
// has it, not escaped as in the address. Without that, by its #route
// (a[href$="#/plants"]), else by its path.
function asWritten(step) {
  if (step.action !== "click" || !step.target.href) return step;
  const route = readable(routeOf(step.target.href));
  const quoted = (text) => `"${text.replace(/["\\]/g, "\\$&")}"`;
  let target;
  if (step.text) target = { text: step.text };
  else if (step.attribute) target = { css: `a[href=${quoted(step.attribute)}]` };
  else target = { css: route ? `a[href$=${quoted(route)}]` : `a[href*=${quoted(readable(new URL(step.target.href).pathname))}]` };
  return { action: "click", target, label: step.label };
}

// The path and the #route of an address, to tell whether a link led where
// the tour meant it to.
const placeOf = (url) => `${new URL(url).pathname}${routeOf(url)}`;

const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

// The #route links a tour left out, in one note: their paths and routes,
// the first 12 of them, and how many more.
function routesNote(routes) {
  const shown = routes.slice(0, 12).map((route) => pathOf(route.url));
  const more = routes.length - shown.length;
  const list = more ? `${shown.join(", ")} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : shown[0];
  return routes.length === 1 ? `Left out ${list}: a #route, which the tour does not follow: give it with --page.` : `Left out ${list}: #routes, which the tour does not follow: give one with --page.`;
}

async function makeDemo(rawUrl, options = {}) {
  const {
    dir,
    steps: stepsFile = "",
    pages: wanted = 4,
    extra = [],
    zoom = 1.5,
    frame = true,
    background = "",
    fps = 30,
    theme = "light",
    lang = "",
    hide = [],
    reducedMotion = false,
    clean: tidy = true,
    gif = true,
    timeLimit = 900_000,
    log = () => {},
  } = options;
  setTimeLimit(timeLimit);
  // The addresses the host that runs the kit refuses: a setting that does
  // not parse stops the demo before any work (see address.js).
  hostRefusals();
  // A selector to hide that could reach past its own rule stops the demo
  // before any work too (see steps.js).
  for (const selector of hide) {
    const refused = hideRefusal(String(selector).trim(), "hide takes CSS selectors");
    if (refused) throw new Error(refused);
  }
  // The programs an earlier run in this process found are found again.
  programs.forget();
  // Read without holding the process: a named pipe that nothing writes to
  // yet waits for as long as it takes, and a stop has to be heard meanwhile.
  const script = stepsFile ? await loadSteps(stepsFile) : null;
  const asked = normalizeUrl(rawUrl || (script && script.url) || "");
  const backdrop = backdropOf(background);
  // ffmpeg before any work: one that is not there, or that cannot be
  // started, is named with what is wrong with it.
  const ffmpeg = await ffmpegReady();
  const encoder = await pickEncoder(ffmpeg);
  if (!encoder) throw new Error(`${ffmpeg} has no H.264 encoder (x264, VideoToolbox, OpenH264 or Media Foundation). Install a full build of ffmpeg.`);
  const target = dir || `easyscreenshotkit-demo-${siteOf(asked)}`;
  // Every file is made in the run's part folder, the frames too, and put in
  // place once the run has ended well (see outdir.js). A folder the demo may
  // not save in is refused before the browser and the name of the address's
  // host are looked at, as it was before.
  const run = openDemo(target, { steps: stepsFile, tour: !script });
  const frames = run.file("frames");
  const viewport = { width: 1600, height: 900 };
  // Drawn at least as sharp as the zoom goes deep, so a zoomed-in view is
  // not blown up: 1.5 pixels per CSS pixel for the default zoom.
  const density = Math.min(2, Math.max(zoom, frame ? 1 : 1.2));
  // A fragment that is no #route, in the address or in --page, is left
  // out, and said so; a visit step keeps whatever it is given.
  const notes = fragmentNotes(rawUrl || (script && script.url) || "", script ? [] : extra, asked, homeOf(asked));
  const records = [];
  let take;
  let tour = null;
  let name = "";
  let gifInfo = null;
  let manifest;
  let chrome = null;
  let composer = null;
  let recorder = null;
  // Whether the frames are being drawn: a call that ran out of time then is
  // a browser too slow to draw them.
  let drawing = false;
  const lostWhy = () => {
    const lost = [chrome, composer].find((browser) => browser && browser.gone());
    if (lost) return lost.stalled() ? BROWSER_STALLED : BROWSER_GONE;
    return recorder && recorder.crashed ? TAB_CRASHED : "";
  };
  const alive = () => {
    if (lostWhy()) throw new Error(lostWhy());
  };
  try {
    // The browser before it opens anything: one that is not there, or that
    // is no program this user may run, is named with what is wrong with it.
    const noBrowser = browserProblem();
    if (noBrowser) throw new Error(noBrowser);
    // The pages the demo opens, by a step, a click or the tour, are of the
    // address given or on the public internet, on port 80 or 443 away from
    // it (see address.js). One whose host's name cannot be looked up here,
    // or that MAKERSMCP_REFUSE_ADDRESSES refuses, opens nothing, and the demo
    // stops before it starts the browser.
    const guard = await guardFor(asked);
    if (guard.unresolved) throw unresolvedError(asked, guard);
    if (guard.refused) throw refusedError(asked, guard);
    fs.mkdirSync(frames);
    chrome = await launch({ lang, args: [`--force-device-scale-factor=${density}`] });
    chrome.guard = guard;
    recorder = new Recorder(chrome, { dir: frames, out: target, base: asked, fps, viewport, hide: [...hide, ...(script ? script.hide : [])], clean: tidy, theme, lang, reducedMotion, log });
    try {
      await checkBackdrop(chrome, background, frames);
      if (!script) {
        tour = await pickPages(chrome, asked, { pages: wanted, extra, lang, theme, reducedMotion, log });
        alive();
        name = tour.site;
        for (const skip of tour.skipped) notes.push(`Left out ${skip.url}: ${skip.reason}.`);
        notes.push(...tour.notes);
        if (tour.routes.length) notes.push(routesNote(tour.routes));
        if (tour.short) notes.push(`Time ran out after ${tour.pages.length === 1 ? "1 page" : `${tour.pages.length} pages`}: a tour looks for more only while 4 minutes of the run are left; give more with --timeout.`);
      }
      await recorder.open();
      log("Recording");
      // A step starts while a minute of the run is left, or a quarter of
      // the run for one given less than four minutes: with a minute in all,
      // the least --timeout takes, no step could start. A tour keeps that
      // time too, and leaves out the pages it has no time for (see
      // tourSteps).
      const reserve = Math.min(60_000, timeLimit / 4);
      const outOfTime = [];
      // A steps file that does not start somewhere starts at the address
      // given; its own steps keep their numbers in what goes wrong.
      const added = script && script.steps[0].action !== "visit" ? 1 : 0;
      const steps = script ? [...(added ? [{ action: "visit", url: asked }] : []), ...script.steps] : tourSteps(recorder, tour.pages, { reserve, left: outOfTime });
      let n = 0;
      for await (const step of steps) {
        n++;
        if (script && timeLeft() < reserve) throw new Error("time ran out while recording; give more with --timeout");
        log(`${added && n === 1 ? "  " : String(n - added).padStart(2, "0")} ${what(step)}`);
        let record;
        try {
          record = await recorder.run(step);
        } catch (err) {
          alive();
          throw new Error(added && n === 1 ? `opening ${asked}: ${err.message}` : `step ${n - added} (${step.action}): ${err.message}`);
        }
        alive();
        records.push({ n: n - added, step, ...record });
        if (step.expect && record.opened && placeOf(record.opened) !== placeOf(step.expect)) notes.push(`The link for ${step.expect} led to ${record.opened}.`);
      }
      for (const skip of outOfTime) notes.push(`Left out ${skip.url}: ${skip.reason}.`);
      // The page shown last stays up a moment, as a tour's pages do.
      await recorder.linger(LAST_PAGE);
      alive();
      take = await recorder.finish();
      alive();
      // A steps file's demo names the site by its first page, as a tour
      // does by the page it starts at.
      if (!name) name = (take.pages[0] && take.pages[0].site) || siteName({ title: "" }, asked);
    } finally {
      await recorder.close();
      await chrome.close();
    }
    if (!take.frames.length) throw new Error("No frame was recorded.");
    notes.push(...refusalNotes(take));
    for (const selector of recorder.unread) notes.push(unreadNote(selector));
    if (take.slow) notes.push("A page drew slowly in this browser, so it was recorded in slow motion and played back at speed; its own animations look right, scripted ones may run fast.");

    // The video.
    const look = { ...LOOKS[take.lightness < 0.45 ? "dark" : "light"], ...(backdrop ? { backdrop } : {}) };
    const layout = layoutOf({ frame, viewport });
    // Drawing the frames has time of its own, however much of the run the
    // recording took, and so has the start of the browser it draws them in.
    if (timeLeft() < 120_000) setTimeLimit(Math.max(120_000, take.duration * 6_000));
    drawing = true;
    composer = await launch();
    let drawn;
    let poster;
    const video = run.file("demo.mp4");
    try {
      const sink = startVideo(ffmpeg, video, { fps, encoder, title: `${name} demo` });
      try {
        drawn = await renderVideo(composer, take, { layout, look, zoom, dir: frames, sink, log });
        log("Encoding demo.mp4");
        await sink.end();
      } catch (err) {
        sink.kill();
        throw err;
      }
      // The poster: the first page at rest, before anything moves on it.
      const still = Math.min(take.duration, ...take.scrolls.map((s) => s.t0), ...take.cuts.map((c) => c.t), take.shownAt === null ? Infinity : take.shownAt);
      const posterAt = Math.max(0, Math.min(1, still - 0.05, take.duration - 1 / fps));
      poster = { at: round(posterAt), png: await renderStill(composer, take, { layout, look, zoom, dir: frames, t: posterAt }) };
      drawing = false;
    } finally {
      await composer.close();
    }
    const png = tagPng(poster.png, { Title: `${name} demo`, Source: asked, "Creation Time": new Date().toISOString(), Software: `easyscreenshotkit ${version}` });
    run.write("poster.png", png);
    if (!pngFileIsWhole(run.file("poster.png"))) throw new Error("poster.png came out cut short (the disk, or your disk quota, may be full), so no demo was saved.");
    if (gif) {
      log("Making demo.gif");
      gifInfo = await makeGif(ffmpeg, video, run.file("demo.gif"), { dir: frames });
      if (gifInfo.overBudget) notes.push(`demo.gif is ${(gifInfo.bytes / 1048576).toFixed(1)} MB even at ${gifInfo.width} px wide; a shorter demo makes a smaller GIF.`);
    }

    // Where each step lands in the video.
    const toVideo = (t, point) => {
      const cam = cameraAt(drawn.regions, t, viewport);
      const k = layout.scale * cam.z;
      return [Math.round(layout.content.x + (point.x - cam.x) * k), Math.round(layout.content.y + (point.y - cam.y) * k)];
    };
    const total = drawn.frames;
    const steps = stepEntries(records, { fps, toVideo });
    const pagesShown = pageEntries(take, { fps, tour, frames: total });
    manifest = {
      version: 1,
      kind: "demo",
      tool: `easyscreenshotkit ${version}`,
      url: asked,
      site: name,
      madeAt: new Date().toISOString(),
      video: { file: "demo.mp4", width: layout.width, height: layout.height, fps, frames: total, duration: round(total / fps), codec: "h264", encoder: encoder.name },
      gif: gifInfo ? { file: "demo.gif", width: gifInfo.width, height: gifInfo.height, fps: gifInfo.fps, bytes: gifInfo.bytes } : null,
      poster: { file: "poster.png", ...pngSize(png), at: poster.at },
      page: { viewport, density, box: [layout.content.x, layout.content.y, layout.content.width, layout.content.height], framed: layout.frame },
      zoom,
      pages: pagesShown,
      steps,
      notes,
    };
    run.write("steps.json", JSON.stringify(manifest, null, 2) + "\n");
    if (tour) {
      const header = [`The tour easyscreenshotkit ${version} took of ${new URL(asked).hostname.replace(/^www\./, "")}.`, "Edit it and record again: easyscreenshotkit demo --steps demo.yaml"];
      run.write(TOUR_FILE, toYaml({ url: asked, steps: records.map((record) => asWritten(record.step)) }, header));
    }
  } catch (err) {
    // Whatever failed first, a browser or a tab that was lost is why: the
    // recording's, or a tab that picked the tour's pages or drew the frames.
    // A call that ran out of time as the frames were drawn is said so.
    const why = lostWhy() || (err.message === CRASHED ? TAB_CRASHED : "") || (drawing && err.timedOut ? drawnTooSlowly(err.cut) : "");
    run.abort();
    throw run.told(why ? new Error(why) : err);
  }
  // The run has ended well: its files take the place of the earlier demo's,
  // and the frames go with the part folder.
  run.commit(["demo.mp4", ...(gifInfo ? ["demo.gif"] : []), "poster.png", ...(tour ? [TOUR_FILE] : []), "steps.json"]);
  return { dir: target, manifest, tour: Boolean(tour) };
}

// The files a run saved, and what it did. tour: whether it was a tour,
// which writes demo.yaml; a run from a steps file leaves an earlier tour's
// demo.yaml in the folder as it was, and it is not this run's.
function summary({ dir, manifest, tour = false }) {
  const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
  const size = (file) => {
    try {
      return mb(fs.statSync(path.join(dir, file)).size);
    } catch {
      return "";
    }
  };
  const lines = [`Recorded a ${Math.round(manifest.video.duration)} s demo of ${new URL(manifest.url).hostname.replace(/^www\./, "")} in ${dir}`, ""];
  lines.push(`  demo.mp4    ${manifest.video.width}x${manifest.video.height}, ${manifest.video.fps} fps, ${size("demo.mp4")}`);
  if (manifest.gif) lines.push(`  demo.gif    ${manifest.gif.width}x${manifest.gif.height}, ${manifest.gif.fps} fps, ${mb(manifest.gif.bytes)}`);
  lines.push(`  poster.png  ${manifest.poster.width}x${manifest.poster.height}`);
  lines.push(`  steps.json  ${manifest.steps.length} steps with their start and end, in seconds and frames`);
  if (tour) lines.push("  demo.yaml   the tour as steps: edit it and record again with --steps");
  lines.push("");
  for (const step of manifest.steps) lines.push(`  ${clock(step.start).padStart(5)}  ${step.label}`);
  for (const note of manifest.notes) lines.push("", `  Note: ${note}`);
  return lines.join("\n");
}

async function main(argv) {
  let options;
  try {
    options = parseDemo(argv);
  } catch (err) {
    process.stderr.write(`easyscreenshotkit demo: ${err.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (options.help) return void process.stdout.write(`${USAGE}\n`);
  if (options.version) return void process.stdout.write(`${version}\n`);
  // A MAKERSMCP_REFUSE_ADDRESSES that does not parse is refused as an
  // argument is, before any work.
  const unread = refusalsProblem();
  if (unread) {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: unread }) + "\n");
    process.stderr.write(`easyscreenshotkit demo: ${printable(unread)}\n`);
    process.exit(2);
  }
  stopOnSignals({ name: "easyscreenshotkit demo", json: options.json });
  try {
    const result = await makeDemo(options.url, {
      dir: options.out,
      steps: options.steps,
      pages: options.pages,
      extra: options.extra,
      zoom: options.zoom,
      frame: options.frame,
      background: options.background,
      fps: options.fps,
      theme: options.theme,
      lang: options.lang,
      hide: options.hide,
      reducedMotion: options.reducedMotion,
      clean: options.clean,
      gif: options.gif,
      timeLimit: options.timeout * 1000,
      log: options.json ? () => {} : (line) => process.stderr.write(`${printable(line)}\n`),
    });
    process.stdout.write(options.json ? JSON.stringify(result.manifest, null, 2) + "\n" : printable(summary(result)) + "\n");
  } catch (err) {
    if (options.json) process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
    process.stderr.write(`easyscreenshotkit demo: ${printable(err.message)}\n`);
    process.exit(1);
  }
}

module.exports = { main, makeDemo, parseDemo, prepareDemoDir, openDemo, routesNote, barredNote, refusalNotes, what, frameAt, stepEntries, pageEntries, summary, USAGE };
