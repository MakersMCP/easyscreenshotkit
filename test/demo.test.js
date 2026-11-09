"use strict";

// The demo command: its options and folder without a browser, then whole
// recordings in a real headless browser with ffmpeg (skipped when either is
// missing) against a small site served from this process. The video is
// checked frame by frame by its colours: what was scrolled to, clicked,
// typed and hidden, and that a click zooms in.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { parseDemo, prepareDemoDir, openDemo, makeDemo, routesNote, what, frameAt, stepEntries, pageEntries } = require("../skills/easyscreenshotkit/scripts/lib/demo");
const { pickPages } = require("../skills/easyscreenshotkit/scripts/lib/tour");
const { setTimeLimit } = require("../skills/easyscreenshotkit/scripts/lib/time");
const { readSteps } = require("../skills/easyscreenshotkit/scripts/lib/steps");
const { findChrome, launch, openTab, closeTab, navigate } = require("../skills/easyscreenshotkit/scripts/lib/chrome");
const { findFfmpeg, makeGif } = require("../skills/easyscreenshotkit/scripts/lib/ffmpeg");
const { readPng, serve, near } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
const ffmpeg = findFfmpeg();
const missing = !findChrome() ? "no Chrome, Chromium, Edge or Brave installed" : !ffmpeg ? "no ffmpeg installed" : false;

const GREEN = [0, 160, 0];
const PURPLE = [120, 0, 200];
const RED = [200, 0, 0];
const ORANGE = [255, 140, 0];
const YELLOW = [250, 220, 0];
const BLUE = [0, 0, 220];
const MAGENTA = [255, 0, 255];
const TEAL = [0, 200, 200];

test("demo options: defaults, flags, and what is refused", () => {
  const plain = parseDemo(["acme.com"]);
  assert.equal(plain.url, "acme.com");
  assert.equal(plain.pages, 4);
  assert.equal(plain.zoom, 1.5);
  assert.equal(plain.fps, 30);
  assert.equal(plain.frame, true);
  assert.equal(plain.gif, true);
  const set = parseDemo(["acme.com", "--pages=6", "--page", "/pricing", "--zoom", "2", "--no-frame", "--no-gif", "--background", "#111,#333", "--fps", "60", "--hide", ".promo", "--theme", "Dark", "--json", "--out", "x"]);
  assert.deepEqual([set.pages, set.extra, set.zoom, set.frame, set.gif, set.background, set.fps, set.hide, set.theme, set.json, set.out], [6, ["/pricing"], 2, false, false, "#111,#333", 60, [".promo"], "dark", true, "x"]);
  assert.equal(parseDemo(["acme.com", "--no-zoom"]).zoom, 1);
  // A steps file may carry the address itself.
  assert.equal(parseDemo(["--steps", "demo.yaml"]).url, "");
  assert.throws(() => parseDemo([]), /Give one website address/);
  assert.throws(() => parseDemo(["acme.com", "--pages", "12"]), /--pages takes 1 to 8/);
  assert.throws(() => parseDemo(["acme.com", "--zoom", "4"]), /--zoom takes 1 to 2.5/);
  assert.throws(() => parseDemo(["acme.com", "--fps", "29.97"]), /--fps takes 24 to 60/);
  assert.throws(() => parseDemo(["acme.com", "--steps", "a.yaml", "--page", "/x"]), /a steps file says which pages/);
  assert.throws(() => parseDemo(["acme.com", "--theme", "both"]), /light or dark/);
  assert.throws(() => parseDemo(["acme.com", "--wat"]), /Unknown option/);
});

test("a visit's label reads its address as a person does, the visit a steps file starts with too", () => {
  // The address given, which a steps file that starts with another step
  // opens first, comes escaped from the URL parser.
  assert.equal(
    what({ action: "visit", url: "http://127.0.0.1:19281/uygulama%20%C3%A7al%C4%B1%C5%9Fma/#/%C5%9Fehir/%C4%B0zmir" }),
    "Open http://127.0.0.1:19281/uygulama çalışma/#/şehir/İzmir",
  );
  assert.equal(what({ action: "visit", url: "/uygulama çalışma/#/ayarlar" }), "Open /uygulama çalışma/#/ayarlar");
  assert.equal(what({ action: "visit", url: "/100%-cotton" }), "Open /100%-cotton");
  assert.equal(what({ action: "visit", url: "/pricing", label: "Prices" }), "Prices");
});

test("a step's frame is the one its seconds in steps.json say, also half a frame from the next", () => {
  // 5.6166 s is frame 168.498 at 30 frames a second, written as 5.617 s,
  // which is frame 168.51.
  assert.equal(frameAt(5.6166, 30), 169);
  assert.equal(frameAt(5.6166, 30), Math.round(5.617 * 30));
  assert.equal(frameAt(2, 30), 60);
  assert.equal(frameAt(0, 24), 0);
  for (let t = 0; t < 30; t += 0.0137) assert.equal(frameAt(t, 30), Math.round((Math.round(t * 1000) / 1000) * 30), String(t));
  // steps.json as the demo writes it: every frame of a step and of a page
  // is the one the seconds next to it say.
  const records = [
    { n: 1, step: { action: "visit", url: "https://acme.com/" }, url: "https://acme.com/", start: 0, end: 1.2 },
    { n: 2, step: { action: "click", target: { text: "Pricing" } }, url: "https://acme.com/", start: 5.6166, end: 7.0166, at: { x: 10, y: 20 }, pressed: 5.6166, opened: "https://acme.com/pricing" },
  ];
  const steps = stepEntries(records, { fps: 30, toVideo: () => [100, 200] });
  assert.deepEqual(
    steps.map((s) => [s.start, s.startFrame, s.end, s.endFrame, s.pressedAt, s.pressedFrame]),
    [
      [0, 0, 1.2, 36, undefined, undefined],
      [5.617, 169, 7.017, 211, 5.617, 169],
    ],
  );
  const take = { urls: [{ t: 0, url: "https://acme.com/" }, { t: 5.6166, url: "https://acme.com/pricing" }], pages: [], duration: 9.98335 };
  const pages = pageEntries(take, { fps: 30 });
  assert.deepEqual(
    pages.map((p) => [p.start, p.startFrame, p.end, p.endFrame]),
    [
      [0, 0, 5.617, 169],
      [5.617, 169, 9.983, 299],
    ],
  );
  for (const entry of [...steps, ...pages]) {
    assert.equal(entry.startFrame, Math.round(entry.start * 30));
    assert.equal(entry.endFrame, Math.round(entry.end * 30));
  }
});

test("frames that cannot be saved are told by the folder the demo saves in, not the part of it that is gone by then", async () => {
  const { Recorder } = require("../skills/easyscreenshotkit/scripts/lib/record");
  const root = tempDir();
  try {
    const run = openDemo(path.join(root, "demo"));
    const recorder = new Recorder(null, { dir: path.join(run.file("frames"), "missing"), out: path.join(root, "demo"), base: "https://acme.com/" });
    recorder.keep({ data: "" }, 0);
    await Promise.all(recorder.writes);
    assert.match(recorder.writeError, /^Could not save the video's frames in .*demo: ENOENT/);
    assert.ok(!recorder.writeError.startsWith(`Could not save the video's frames in ${run.part}`));
    // Any other path in the part folder, in what went wrong, is told by the
    // folder itself once the part folder is gone.
    const err = new Error(`ffmpeg could not write demo.mp4: ${run.file("demo.mp4")}: No space left on device`);
    run.abort();
    assert.equal(run.told(err).message, `ffmpeg could not write demo.mp4: ${path.join(root, "demo", "demo.mp4")}: No space left on device`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ffmpeg reads a % in the path of a picture as a frame number: the GIF's
// palette, made in the run's folder, failed under a folder named like
// these, "Q3 100%" with ffmpeg 4 only, and ffmpeg 4 wrote it outside, at
// the path cut short at its %.
test("demo.gif is made in a folder whose path holds a %, and nothing is written outside it", { skip: !ffmpeg && "no ffmpeg installed", timeout: 120_000 }, async () => {
  const root = tempDir();
  try {
    for (const name of ["Q3 100%", "run%dx", "a%20b%dx"]) {
      const frames = path.join(root, name, "frames");
      fs.mkdirSync(frames, { recursive: true });
      const video = path.join(root, name, "demo.mp4");
      const made = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=10:duration=1", "-pix_fmt", "yuv420p", video], { encoding: "utf8" });
      assert.equal(made.status, 0, made.stderr);
      const before = fs.readdirSync(root).sort();
      const gif = await makeGif(ffmpeg, video, path.join(root, name, "demo.gif"), { dir: frames });
      assert.equal(fs.readFileSync(path.join(root, name, "demo.gif")).subarray(0, 6).toString(), "GIF89a", name);
      assert.deepEqual([gif.width, gif.height], [960, 540], name);
      assert.deepEqual(fs.readdirSync(frames), [], `${name}: the palette is gone`);
      assert.deepEqual(fs.readdirSync(root).sort(), before, `${name}: nothing was written next to the folder`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A demo from a steps file leaves the demo.yaml an earlier tour wrote in its
// folder, as it may be the file it follows: that is not one of its files.
test("the summary lists demo.yaml after a tour, which wrote it, not after a steps run that left an earlier tour's there", () => {
  const { summary } = require("../skills/easyscreenshotkit/scripts/lib/demo");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-demo-summary-"));
  try {
    fs.writeFileSync(path.join(dir, "demo.yaml"), "steps:\n  - wait: 1\n");
    fs.writeFileSync(path.join(dir, "demo.mp4"), "video");
    const manifest = { url: "https://acme.com/", video: { width: 1920, height: 1080, fps: 30, duration: 4 }, gif: null, poster: { width: 1920, height: 1080 }, steps: [{ start: 0, label: "Open acme.com" }], notes: [] };
    assert.doesNotMatch(summary({ dir, manifest, tour: false }), /demo\.yaml/);
    assert.match(summary({ dir, manifest, tour: true }), /\n {2}demo\.yaml {3}the tour as steps: edit it and record again with --steps\n/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI hands demo to its own command, with its own help", () => {
  const help = spawnSync(process.execPath, [CLI, "demo", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: easyscreenshotkit demo <url>/);
  assert.match(help.stdout, /^A #route \(#\/ or #!\) in the address, in --page or in a visit step is kept/m);
  const none = spawnSync(process.execPath, [CLI, "demo"], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /easyscreenshotkit demo: Give one website address/);
  assert.match(spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }).stdout, /easyscreenshotkit demo <url>/);
});

test("a demo never writes into a folder that holds someone else's files, and its files take an earlier demo's place once it has ended well", () => {
  // Absolute, so a link made to a folder in it leads there under a TMPDIR
  // given as a relative path too.
  const dir = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-demo-dir-")));
  const earlier = () => fs.writeFileSync(path.join(dir, "steps.json"), JSON.stringify({ version: 1, kind: "demo", tool: "easyscreenshotkit 0.1.0" }));
  const record = (options, files) => {
    const run = openDemo(dir, options);
    for (const [name, text] of Object.entries(files)) run.write(name, text);
    run.write("steps.json", JSON.stringify({ version: 1, kind: "demo", tool: "easyscreenshotkit 0.1.2" }));
    run.commit([...Object.keys(files), "steps.json"]);
  };
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8");
  const hourAgo = new Date(Date.now() - 3_600_000);
  try {
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    // A folder of someone else's is refused, and nothing in it is touched,
    // not even a folder that looks like the frames of a run.
    fs.mkdirSync(path.join(dir, ".frames-cache"));
    assert.throws(() => openDemo(dir), /not empty/);
    assert.throws(() => prepareDemoDir(dir), /not empty/);
    assert.deepEqual(fs.readdirSync(dir).sort(), [".frames-cache", "notes.txt"]);
    fs.rmSync(path.join(dir, "notes.txt"));
    fs.rmSync(path.join(dir, ".frames-cache"), { recursive: true });
    earlier();
    fs.writeFileSync(path.join(dir, "demo.mp4"), "old");
    fs.writeFileSync(path.join(dir, "demo.gif"), "old");
    fs.writeFileSync(path.join(dir, "demo.yaml"), "steps:\n  - wait: 1\n");
    fs.writeFileSync(path.join(dir, "keep-me.txt"), "mine");
    // The frames a run of 0.1.1 left when it was stopped: they go once a
    // run ends well and they are half an hour old.
    fs.mkdirSync(path.join(dir, ".frames-abc123"));
    fs.writeFileSync(path.join(dir, ".frames-abc123", "f000001.jpg"), "x");
    // A run that does not end well leaves the earlier demo as it was.
    const stopped = openDemo(dir, { tour: true });
    stopped.write("demo.mp4", "half");
    stopped.abort();
    assert.deepEqual(fs.readdirSync(dir).sort(), [".frames-abc123", "demo.gif", "demo.mp4", "demo.yaml", "keep-me.txt", "steps.json"]);
    assert.equal(read("demo.mp4"), "old");
    // Recording again from the tour's own demo.yaml, edited: it stays, and
    // the earlier GIF goes, as this run makes none.
    record({ steps: path.join(dir, "demo.yaml") }, { "demo.mp4": "new", "poster.png": "new" });
    assert.deepEqual(fs.readdirSync(dir).sort(), [".frames-abc123", "demo.mp4", "demo.yaml", "keep-me.txt", "poster.png", "steps.json"]);
    assert.deepEqual([read("demo.mp4"), read("demo.yaml")], ["new", "steps:\n  - wait: 1\n"]);
    // A new tour replaces the old tour's demo.yaml.
    for (const at of [path.join(dir, ".frames-abc123", "f000001.jpg"), path.join(dir, ".frames-abc123")]) fs.utimesSync(at, hourAgo, hourAgo);
    record({ tour: true }, { "demo.mp4": "tour", "demo.yaml": "steps:\n  - wait: 2\n" });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["demo.mp4", "demo.yaml", "keep-me.txt", "steps.json"]);
    assert.equal(read("demo.yaml"), "steps:\n  - wait: 2\n");
    // A steps file that sits where the demo saves its steps.json is refused.
    fs.mkdirSync(path.join(dir, "inner"));
    fs.writeFileSync(path.join(dir, "inner", "steps.json"), JSON.stringify({ steps: [{ wait: 1 }] }));
    assert.throws(() => openDemo(path.join(dir, "inner"), { steps: path.join(dir, "inner", "steps.json") }), /inner\/steps\.json is the steps file this demo follows, and the demo saves its own steps\.json in its place\./);
    // A folder that holds only the steps file is the run's to use, and so is
    // one that Explorer has shown.
    fs.rmSync(path.join(dir, "inner", "steps.json"));
    fs.writeFileSync(path.join(dir, "inner", "flow.yaml"), "steps:\n  - wait: 1\n");
    fs.writeFileSync(path.join(dir, "inner", "desktop.ini"), "[.ShellClassInfo]");
    openDemo(path.join(dir, "inner"), { steps: path.join(dir, "inner", "flow.yaml") }).abort();
    assert.deepEqual(fs.readdirSync(path.join(dir, "inner")).sort(), ["desktop.ini", "flow.yaml"]);
    // The steps file is told by what the disk says it is, not by its path:
    // reached through a link to its folder it is still the steps file, and
    // under a name the demo saves (here a second name of the same file, as
    // Steps.json is steps.json on a disk that ignores letter case) it is
    // refused.
    let linked = true;
    try {
      fs.symlinkSync(path.join(dir, "inner"), path.join(dir, "through"), "junction");
    } catch {
      // Windows without the right to make links.
      linked = false;
    }
    if (linked) openDemo(path.join(dir, "inner"), { steps: path.join(dir, "through", "flow.yaml") }).abort();
    fs.linkSync(path.join(dir, "inner", "flow.yaml"), path.join(dir, "inner", "steps.json"));
    assert.throws(() => openDemo(path.join(dir, "inner"), { steps: path.join(dir, "inner", "flow.yaml") }), /inner\/flow\.yaml is the steps file this demo follows, and the demo saves its own steps\.json in its place\./);
    assert.deepEqual(fs.readdirSync(path.join(dir, "inner")).sort(), ["desktop.ini", "flow.yaml", "steps.json"]);
    fs.rmSync(path.join(dir, "inner"), { recursive: true });
    fs.rmSync(path.join(dir, "through"), { force: true });
    // A demo from when the tool was called easyscreenshot counts too.
    fs.writeFileSync(path.join(dir, "steps.json"), JSON.stringify({ version: 1, kind: "demo", tool: "easyscreenshot 0.1.0" }));
    openDemo(dir, { steps: path.join(dir, "demo.yaml") }).abort();
    // A screenshots run is not a demo.
    fs.writeFileSync(path.join(dir, "steps.json"), JSON.stringify({ version: 1, tool: "easyscreenshotkit 0.1.0" }));
    assert.throws(() => openDemo(dir), /no earlier easyscreenshotkit demo/);
    // A file where the folder goes, or a folder above it, is refused by
    // what it is and stays as it was.
    assert.throws(() => openDemo(path.join(dir, "keep-me.txt")), /^Error: .*keep-me\.txt is a file, and this run saves its files in a folder of that name\. Move it, or pick another folder with --out\.$/);
    assert.throws(() => prepareDemoDir(path.join(dir, "keep-me.txt", "demo")), /keep-me\.txt\/demo cannot be made: .*keep-me\.txt is a file\. Move it, or pick another folder with --out\./);
    assert.throws(() => openDemo(path.join(dir, "keep-me.txt", "demo")), /keep-me\.txt\/demo cannot be made: .*keep-me\.txt is a file\./);
    assert.equal(read("keep-me.txt"), "mine");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const page = (title, body, style = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;font-family:sans-serif}${style}</style></head><body>${body}</body></html>`;

// The home page: a menu, a green hero with a black button that turns it
// purple and a form, a red and an orange section, and floating over it a
// blue cookie bar and a magenta chat bubble.
const HOME = page(
  "Acme | Tools for teams",
  `<header><a href="/">Acme</a><nav><a href="/features">Features</a><a href="/pricing">Pricing</a><a href="/login">Log in</a><a class="fern" href="/app/#/plant/Fern" aria-label=""><i></i></a></nav></header>
  <div class="hero"><h1>Tools for teams</h1><button id="go" aria-label="Go"></button>
  <form action="/thanks"><input id="email" name="email" placeholder="Email"></form></div>
  <section class="fast"><h2>Fast</h2></section>
  <section class="simple"><h2>Simple</h2></section>
  <footer>Acme</footer>
  <div class="cookie">We use cookies</div><div class="chat"></div>
  <script>document.getElementById("go").onclick = () => { document.querySelector(".hero").style.background = "rgb(120,0,200)"; };</script>`,
  `header{height:70px;display:flex;align-items:center;gap:40px;padding:0 40px;font-size:22px;background:#fff}
  nav{display:flex;gap:30px}
  .fern{display:inline-block;width:28px;height:28px;background:rgb(120,0,200)}
  .hero{height:820px;background:rgb(0,160,0);position:relative}
  h1{margin:0;padding:40px;font-size:48px}
  #go{position:absolute;left:200px;top:300px;width:240px;height:80px;background:rgb(0,0,0);border:0}
  form{position:absolute;left:200px;top:500px}
  input{width:400px;height:50px;font-size:24px}
  section{height:900px}
  h2{margin:0;padding:40px}
  .fast{background:rgb(200,0,0)}
  .simple{background:rgb(255,140,0)}
  footer{height:300px;background:rgb(30,30,30)}
  .cookie{position:fixed;left:0;right:0;bottom:0;height:70px;background:rgb(0,0,220);z-index:9}
  .chat{position:fixed;right:24px;bottom:100px;width:60px;height:60px;border-radius:30px;background:rgb(255,0,255);z-index:9}`,
);

const plain = (title, color) => page(`${title} | Acme`, `<header><a href="/">Acme</a> <a href="/features">Features</a> <a href="/pricing">Pricing</a></header><h1>${title}</h1><div style="height:2400px;background:${color}"><h2 style="margin:0;padding-top:900px">More</h2></div>`, "header{height:70px;font-size:22px}");

// A single page app at /app/ with hash routes. Each view asks /api/<view>
// for its data, which comes after 800 ms, or 3 s for the report Today links
// to. Today names no plant; Your plants links to each one. Its menu ends
// with a link with no words to a view whose route is in Cyrillic.
const APP = page(
  "Today | Plants",
  `<nav><a href="#/today">Today</a> <a href="#/plants">Plants</a> <a href="#/light">Light</a> <a class="cacti" href="#/растения" aria-label=""><i></i></a></nav><main id="view"><h1>Loading…</h1><div class="band"></div></main>
  <script>
    const view = document.getElementById("view");
    async function go() {
      const route = (location.hash || "#/today").slice(2);
      view.innerHTML = '<h1>Loading…</h1><div class="band"></div>';
      const data = await (await fetch("/api/" + route)).json();
      if ((location.hash || "#/today").slice(2) !== route) return;
      view.innerHTML = "<h1>" + data.title + "</h1>" + data.body + '<div class="band" style="background:' + data.color + '"></div>';
      document.title = data.title + " | Plants";
    }
    addEventListener("hashchange", go);
    go();
  </script>`,
  "nav{height:60px;display:flex;gap:30px;align-items:center;padding:0 40px;font-size:22px} .cacti{display:inline-block;width:28px;height:28px;background:rgb(0,200,200)} h1{margin:0;height:60px;padding:0 40px} .plants{margin:0;height:60px;padding:0 40px;font-size:22px} .band{height:1600px;background:rgb(240,240,240)}",
);
const APP_VIEWS = {
  today: ["Today", "rgb(0,160,0)", '<p class="plants">Nothing to water today. <a href="#/report">Report</a></p>'],
  report: ["Report", "rgb(250,220,0)", '<p class="plants">Watered 12 times this week</p>', 3_000],
  plants: ["Your plants", "rgb(200,0,0)", '<p class="plants"><a href="#/plant/Fern">Fern</a> <a href="#/plant/Calathea">Calathea</a></p>'],
  light: ["Light check", "rgb(255,140,0)", '<p class="plants">1,850 lux</p>'],
  "plant/Fern": ["Fern", "rgb(120,0,200)", '<p class="plants">Water today</p>'],
  растения: ["Растения", "rgb(0,200,200)", '<p class="plants">Cacti</p>'],
};

// sitemap: the addresses the site's sitemap lists, as paths; it has none
// without.
async function fixture({ sitemap = null } = {}) {
  const seen = [];
  let origin = "";
  const { server, origin: base } = await serve((req, res) => {
    seen.push(req.url);
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/sitemap.xml" && sitemap) return res.writeHead(200, { "Content-Type": "application/xml" }).end(`<urlset>${sitemap.map((at) => `<url><loc>${origin}${at}</loc></url>`).join("")}</urlset>`);
    if (url.pathname === "/") return html(HOME);
    if (url.pathname === "/features") return html(plain("Features", "rgb(0,200,200)"));
    if (url.pathname === "/pricing") return html(plain("Pricing", "rgb(0,120,255)"));
    if (url.pathname === "/login") return html(plain("Log in", "#eee"));
    if (url.pathname === "/report.csv") return res.writeHead(200, { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="report.csv"' }).end("a,b\n1,2\n");
    if (url.pathname === "/thanks") return html(page("Thanks | Acme", `<h1>Thanks, ${String(url.searchParams.get("email")).replace(/[<>&]/g, "")}</h1><div style="height:1400px"></div>`, "body{background:rgb(250,220,0)}"));
    if (url.pathname === "/app/") return html(APP);
    const view = url.pathname.startsWith("/api/") ? APP_VIEWS[decodeURIComponent(url.pathname.slice(5))] : null;
    if (view) return setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ title: view[0], color: view[1], body: view[2] })), view[3] || 800);
    res.writeHead(404).end("not found");
  });
  origin = base;
  return { server, origin, seen };
}

// A frame of the video as a PNG, decoded by ffmpeg.
function frameOf(video, t) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"]);
    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.on("close", (code) => (code === 0 ? resolve(readPng(Buffer.concat(chunks))) : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

function probe(video) {
  const ffprobe = path.join(path.dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  const out = spawnSync(fs.existsSync(ffprobe) ? ffprobe : "ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=codec_name,width,height,r_frame_rate,pix_fmt,nb_read_frames", "-of", "json", video], { encoding: "utf8" });
  return JSON.parse(out.stdout).streams[0];
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-demo-run-"));
// The page's CSS pixel (x, y) in the video when it is not zoomed: the
// window's content starts at (160, 112), one video pixel per CSS pixel.
const unzoomed = (png, x, y) => png.pixel(160 + x, 112 + y);

test("a scripted demo: scroll, click, type and a form sent with Enter, in an MP4, a GIF, a poster and steps.json", { skip: missing, timeout: 300_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const steps = path.join(root, "demo.yaml");
  fs.writeFileSync(
    steps,
    `steps:
  - visit: /
  - wait: 0.6
  - scroll: { to: "text=Simple" }
  - wait: 0.6
  - scroll: top
  - click: "#go"
  - type: ada@example.com
    into: "#email"
  - key: Enter
  - wait: "text=Thanks"
  - wait: 0.6
`,
  );
  try {
    const { manifest } = await makeDemo(origin, { dir, steps, timeLimit: 280_000 });
    assert.deepEqual(fs.readdirSync(dir).sort(), ["demo.gif", "demo.mp4", "poster.png", "steps.json"]);

    // The video: H.264, 1920x1080, 30 frames a second, as long as steps.json says.
    const stream = probe(path.join(dir, "demo.mp4"));
    assert.deepEqual([stream.codec_name, stream.width, stream.height, stream.r_frame_rate, stream.pix_fmt], ["h264", 1920, 1080, "30/1", "yuv420p"]);
    assert.equal(Number(stream.nb_read_frames), manifest.video.frames);
    assert.equal(manifest.video.duration, Math.round((manifest.video.frames / 30) * 1000) / 1000);

    // Every step with its start and end, in seconds and frames, in order.
    assert.deepEqual(manifest.steps.map((s) => s.action), ["visit", "wait", "scroll", "wait", "scroll", "click", "type", "key", "wait", "wait"]);
    for (const [i, s] of manifest.steps.entries()) {
      assert.ok(s.start <= s.end, `${s.n} ${s.label}`);
      assert.equal(s.startFrame, Math.round(s.start * 30));
      assert.equal(s.endFrame, Math.round(s.end * 30));
      if (i) assert.ok(s.start >= manifest.steps[i - 1].start, `${s.n} starts after the step before it`);
    }
    const [, firstWait, , scrolled, , click, typed, enter] = manifest.steps;
    assert.ok(Math.abs(firstWait.end - firstWait.start - 0.6) < 0.05, "a wait lasts its seconds in the video");
    assert.equal(enter.opened, `${origin}/thanks?email=ada%40example.com`);
    assert.deepEqual(manifest.pages.map((p) => new URL(p.url).pathname), ["/", "/thanks"]);
    assert.ok(seen.includes("/thanks?email=ada%40example.com"), "the form was sent with what was typed");

    // The poster: the home page, the cookie bar and the chat bubble hidden.
    const poster = readPng(path.join(dir, "poster.png"));
    assert.deepEqual([poster.width, poster.height], [1920, 1080]);
    assert.ok(near(unzoomed(poster, 800, 400), GREEN), `hero: ${unzoomed(poster, 800, 400)}`);
    assert.ok(!near(unzoomed(poster, 800, 870), BLUE), "cookie bar hidden");
    assert.ok(!near(unzoomed(poster, 1546, 770), MAGENTA), "chat bubble hidden");

    // Scrolled to the orange section, and held there.
    const held = await frameOf(path.join(dir, "demo.mp4"), (scrolled.start + scrolled.end) / 2);
    assert.ok(near(unzoomed(held, 800, 450), ORANGE), `scrolled to Simple: ${unzoomed(held, 800, 450)}`);
    assert.ok(!near(unzoomed(held, 800, 870), BLUE), "cookie bar still hidden");

    // The click: zoomed in 1.5 times by the time it lands, so the 240 px
    // button is 360 px wide in the video, then the hero turns purple and a
    // white ring shows where it landed.
    const [x, y] = click.at;
    assert.ok(x > 160 && x < 1760 && y > 112 && y < 1012, `the click is inside the window: ${click.at}`);
    assert.ok(click.pressedAt > click.start && click.pressedAt < click.end && click.pressedFrame === Math.round(click.pressedAt * 30));
    const zoomed = await frameOf(path.join(dir, "demo.mp4"), click.pressedAt - 0.05);
    let left = x;
    let right = x;
    while (left > 160 && near(zoomed.pixel(left - 1, y - 20), [0, 0, 0], 40)) left--;
    while (right < 1759 && near(zoomed.pixel(right + 1, y - 20), [0, 0, 0], 40)) right++;
    assert.ok(Math.abs(right - left + 1 - 360) <= 12, `the button is ${right - left + 1} px wide`);
    assert.ok(near(zoomed.pixel(x, y - 75), GREEN), `the hero before the click: ${zoomed.pixel(x, y - 75)}`);
    const ring = await frameOf(path.join(dir, "demo.mp4"), click.pressedAt + 0.2);
    assert.ok(near(ring.pixel(x, y - 75), PURPLE), `the hero turned purple: ${ring.pixel(x, y - 75)}`);
    // Over the black button, the fading white ring is the only light thing
    // on either side of where the click landed.
    const light = (dx) => ring.pixel(x + dx, y).reduce((sum, v) => sum + v, 0) / 3 > 70;
    assert.ok([...Array(60).keys()].some((i) => light(20 + i)) && [...Array(60).keys()].some((i) => light(-20 - i)), "a ring is drawn around the click");

    // Typing went into the field, zoomed in on it.
    assert.ok(typed.end - typed.start > 1, "typing takes its time");
    // The end: the thank-you page.
    const end = await frameOf(path.join(dir, "demo.mp4"), manifest.video.duration - 0.1);
    assert.ok(near(unzoomed(end, 800, 600), YELLOW), `the thank-you page: ${unzoomed(end, 800, 600)}`);

    // The GIF.
    const gif = fs.readFileSync(path.join(dir, "demo.gif"));
    assert.equal(gif.toString("latin1", 0, 6), "GIF89a");
    assert.equal(gif.readUInt16LE(6), manifest.gif.width);
    assert.ok(manifest.gif.bytes <= 8 * 1024 * 1024);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tour: the pages the menu puts forward, clicked through the menu, pricing last, and the tour written as steps", { skip: missing, timeout: 300_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "tour");
  try {
    const { manifest } = await makeDemo(origin, { dir, pages: 3, gif: false, timeLimit: 280_000 });
    assert.deepEqual(manifest.pages.map((p) => new URL(p.url).pathname), ["/", "/features", "/pricing"]);
    assert.ok(!seen.includes("/login"), "a sign-in page is never opened");
    const clicks = manifest.steps.filter((s) => s.action === "click");
    assert.deepEqual(clicks.map((s) => s.label), ['Click "Features"', 'Click "Pricing"']);
    assert.ok(manifest.steps.some((s) => s.action === "scroll" && s.label === 'Scroll to "Fast"'), manifest.steps.map((s) => s.label).join(", "));
    assert.equal(manifest.gif, null);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["demo.mp4", "demo.yaml", "poster.png", "steps.json"]);
    // The tour as a steps file, which reads back as the same steps.
    const again = readSteps(path.join(dir, "demo.yaml"));
    assert.equal(again.url, `${origin}/`);
    assert.deepEqual(again.steps.map((s) => s.action), manifest.steps.map((s) => s.action));
    assert.deepEqual(again.steps.filter((s) => s.action === "click").map((s) => s.target), [{ text: "Features" }, { text: "Pricing" }]);
    // The features page, in the middle of the video.
    const middle = await frameOf(path.join(dir, "demo.mp4"), (manifest.pages[1].start + manifest.pages[1].end) / 2);
    assert.ok(near(unzoomed(middle, 800, 700), TEAL) || near(unzoomed(middle, 800, 400), TEAL), `features: ${unzoomed(middle, 800, 700)}`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a #route in the address and in a steps file: each view opened on its route, a route clicked to is a page of its own", { skip: missing, timeout: 300_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const steps = path.join(root, "app.yaml");
  fs.writeFileSync(
    steps,
    `steps:
  - click: "text=Fern"
    zoom: false
  - visit: /app/#/today
  - click: "text=Plants"
    zoom: false
  - wait: 0.5
`,
  );
  try {
    const { manifest } = await makeDemo(`${origin}/app/#/plants`, { dir, steps, gif: false, timeLimit: 280_000 });
    assert.equal(manifest.url, `${origin}/app/#/plants`);
    assert.deepEqual(
      manifest.pages.map((p) => [p.url.slice(origin.length), p.title]),
      [
        ["/app/#/plants", "Your plants | Plants"],
        ["/app/#/plant/Fern", "Fern | Plants"],
        ["/app/#/today", "Today | Plants"],
        ["/app/#/plants", "Your plants | Plants"],
      ],
    );
    const clicks = manifest.steps.filter((s) => s.action === "click");
    assert.deepEqual(clicks.map((s) => s.opened), [`${origin}/app/#/plant/Fern`, `${origin}/app/#/plants`]);
    // Each view on camera once its data had come.
    for (const [i, color] of [[0, RED], [1, PURPLE], [2, GREEN], [3, RED]]) {
      const shown = manifest.pages[i];
      const frame = await frameOf(path.join(dir, "demo.mp4"), shown.end - 0.15);
      assert.ok(near(unzoomed(frame, 800, 700), color), `${shown.url}: ${unzoomed(frame, 800, 700)}`);
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// An address copied from the browser after a sign-in can end in what the
// sign-in left there. Kept, it would open the app on a view that is not
// there (Loading… for good, here) and be written into steps.json.
test("a fragment that is no #route is left out of the address, with a note that does not repeat it", { skip: missing, timeout: 120_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const steps = path.join(root, "rest.yaml");
  fs.writeFileSync(steps, "steps:\n  - wait: 0.5\n");
  try {
    const { manifest } = await makeDemo(`${origin}/app/#sid=SECRET&next=%2F`, { dir, steps, gif: false, timeLimit: 100_000 });
    assert.equal(manifest.url, `${origin}/app/`);
    assert.equal(manifest.notes[0], "The address given ends in a fragment, which is no #route (#/ or #!): it was left out, and the page opens at its top.");
    assert.deepEqual(manifest.pages.map((p) => p.title), ["Today | Plants"]);
    for (const name of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, name)).includes("SECRET"), name);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a click to a #route whose data comes late shows the view drawn before the next page or the end", { skip: missing, timeout: 300_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const steps = path.join(root, "report.yaml");
  fs.writeFileSync(steps, "steps:\n  - click: \"text=Report\"\n    zoom: false\n  - visit: /app/#/today\n  - click: \"text=Report\"\n    zoom: false\n");
  try {
    const { manifest } = await makeDemo(`${origin}/app/#/today`, { dir, steps, gif: false, timeLimit: 280_000 });
    assert.deepEqual(
      manifest.pages.map((p) => [p.url.slice(origin.length), p.title]),
      [
        ["/app/#/today", "Today | Plants"],
        ["/app/#/report", "Report | Plants"],
        ["/app/#/today", "Today | Plants"],
        ["/app/#/report", "Report | Plants"],
      ],
    );
    // The report, drawn off camera, is up for half a second at least before
    // the visit cuts away and before the video ends, not its loading screen.
    const video = path.join(dir, "demo.mp4");
    for (const t of [manifest.pages[1].end - 0.5, manifest.pages[1].end - 0.1, manifest.video.duration - 0.5, manifest.video.duration - 0.05]) {
      const frame = await frameOf(video, t);
      assert.ok(near(unzoomed(frame, 800, 700), YELLOW), `at ${t} s: ${unzoomed(frame, 800, 700)}`);
    }
    const clicks = manifest.steps.filter((s) => s.action === "click");
    assert.ok(clicks.every((s) => s.end - s.start > 0.8), JSON.stringify(clicks.map((s) => [s.start, s.end])));
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tour with #routes asked for with --page: clicked to through their links, and written so in demo.yaml", { skip: missing, timeout: 300_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "tour");
  try {
    const { manifest } = await makeDemo(origin, { dir, pages: 3, extra: ["/app/#/plant/Fern", "/app/#/растения"], gif: false, timeLimit: 280_000 });
    assert.deepEqual(manifest.pages.map((p) => decodeURI(p.url.slice(origin.length))), ["/", "/app/#/plant/Fern", "/app/#/растения"]);
    assert.equal(manifest.pages[1].why, "asked for with --page");
    const clicks = manifest.steps.filter((s) => s.action === "click");
    assert.deepEqual(clicks.map((s) => s.label), ["Open /app/#/plant/Fern", "Open /app/#/растения"]);
    assert.deepEqual(clicks.map((s) => decodeURI(s.opened.slice(origin.length))), ["/app/#/plant/Fern", "/app/#/растения"]);
    // The icon links have no words: the steps file finds each by its href
    // as the page wrote it, the Cyrillic one too, and that finds it again.
    const again = readSteps(path.join(dir, "demo.yaml"));
    const targets = again.steps.filter((s) => s.action === "click").map((s) => s.target);
    assert.deepEqual(targets, [{ css: 'a[href="/app/#/plant/Fern"]' }, { css: 'a[href="#/растения"]' }]);
    setTimeLimit(120_000);
    const chrome = await launch();
    try {
      for (const [at, target] of [[`${origin}/`, targets[0]], [`${origin}/app/#/plant/Fern`, targets[1]]]) {
        const tab = await openTab(chrome, { width: 1600, height: 900, scale: 1, mobile: false, touch: false, agent: "desktop" });
        await navigate(tab, at);
        const { result } = await tab.send("Runtime.evaluate", { expression: `!!document.querySelector(${JSON.stringify(target.css)})`, returnByValue: true });
        assert.equal(result.value, true, `${target.css} on ${at}`);
        await closeTab(chrome, tab);
      }
    } finally {
      await chrome.close();
    }
    for (const [i, color] of [[1, PURPLE], [2, TEAL]]) {
      const middle = await frameOf(path.join(dir, "demo.mp4"), (manifest.pages[i].start + manifest.pages[i].end) / 2);
      assert.ok(near(unzoomed(middle, 800, 700), color), `${manifest.pages[i].url}: ${unzoomed(middle, 800, 700)}`);
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tour lists the #route links of the home page and the address given, and the #routes its sitemap lists, in one note, also when it needs no more pages", { skip: !findChrome() && "no Chrome, Chromium, Edge or Brave installed", timeout: 120_000 }, async () => {
  const { server, origin } = await fixture({ sitemap: ["/", "/app/#/x", "/app/#/plants"] });
  setTimeLimit(110_000);
  const chrome = await launch();
  try {
    const tour = await pickPages(chrome, `${origin}/app/`, { pages: 2 });
    assert.deepEqual(tour.pages.map((p) => p.url.slice(origin.length)), ["/", "/app/"]);
    assert.deepEqual(tour.skipped, []);
    assert.deepEqual(
      tour.routes.map((r) => decodeURI(r.url.slice(origin.length))),
      ["/app/#/plant/Fern", "/app/#/today", "/app/#/plants", "/app/#/light", "/app/#/растения", "/app/#/report", "/app/#/x"],
    );
    assert.equal(routesNote(tour.routes), "Left out /app/#/plant/Fern, /app/#/today, /app/#/plants, /app/#/light, /app/#/растения, /app/#/report and /app/#/x: #routes, which the tour does not follow: give one with --page.");
  } finally {
    await chrome.close();
    server.close();
  }
  const route = (view) => ({ url: `https://acme.com/app/#/${view}`, reason: "a #route, which the tour does not follow: give it with --page" });
  assert.equal(routesNote([route("plants")]), "Left out /app/#/plants: a #route, which the tour does not follow: give it with --page.");
  assert.equal(
    routesNote(Array.from({ length: 15 }, (_, i) => route(`item/${i + 1}`))),
    `Left out ${Array.from({ length: 12 }, (_, i) => `/app/#/item/${i + 1}`).join(", ")} and 3 more: #routes, which the tour does not follow: give one with --page.`,
  );
});

// A --page the browser cannot open, such as a link to a file, is left out
// of the tour with the reason, and the tour goes on: it stopped the demo.
test("a tour leaves out a --page that cannot be opened, and goes on", { skip: !findChrome() && "no Chrome, Chromium, Edge or Brave installed", timeout: 60_000 }, async () => {
  const { server, origin } = await fixture();
  setTimeLimit(50_000);
  const chrome = await launch();
  try {
    const tour = await pickPages(chrome, origin, { pages: 2, extra: ["/report.csv"] });
    assert.deepEqual(tour.pages.map((p) => p.url.slice(origin.length)), ["/"]);
    assert.equal(tour.skipped.length, 1);
    assert.equal(tour.skipped[0].url, `${origin}/report.csv`);
    assert.match(tour.skipped[0].reason, /^could not be opened: net::ERR_[A-Z_]+$/);
  } finally {
    await chrome.close();
    server.close();
  }
});

// Every file and folder under dir, with each file's bytes, hidden ones too.
function snapshot(dir) {
  const out = {};
  const walk = (at, rel) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[`${name}/`] = "";
        walk(path.join(at, entry.name), name);
      } else out[name] = fs.readFileSync(path.join(at, entry.name)).toString("base64");
    }
  };
  if (fs.existsSync(dir)) walk(dir, "");
  return out;
}

// The profiles of the browsers a process has started, from /proc: Linux
// only, none elsewhere. Chrome writes its arguments back as one line.
function profilesOf(pid) {
  try {
    const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    return kids.flatMap((kid) => {
      try {
        return [...fs.readFileSync(`/proc/${kid}/cmdline`, "utf8").matchAll(/--user-data-dir=([^\s\0]+)/g)].map((m) => m[1]);
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

// The folder a browser keeps its single-instance lock in, in the temp
// folder, from the link its profile holds: "" when there is none (Windows).
function lockOf(profile) {
  try {
    return path.dirname(fs.readlinkSync(path.join(profile, "SingletonSocket")));
  } catch {
    return "";
  }
}

test("a demo that fails or is stopped leaves an earlier demo as it was and adds nothing", { skip: missing, timeout: 300_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const good = path.join(root, "good.yaml");
  const bad = path.join(root, "bad.yaml");
  fs.writeFileSync(good, "steps:\n  - visit: /\n  - wait: 0.6\n  - scroll: { to: \"text=Simple\" }\n  - wait: 0.6\n");
  fs.writeFileSync(bad, "steps:\n  - visit: /\n  - click: 'text=Not on this page'\n");
  try {
    await makeDemo(origin, { dir, steps: good, timeLimit: 200_000 });
    const before = snapshot(dir);
    assert.deepEqual(Object.keys(before).sort(), ["demo.gif", "demo.mp4", "poster.png", "steps.json"]);

    // A step that points at nothing.
    await assert.rejects(makeDemo(origin, { dir, steps: bad, gif: false, timeLimit: 100_000 }), /step 2 \(click\): nothing on the page matches/);
    assert.deepEqual(snapshot(dir), before);

    // Stopped with SIGTERM to its whole process group while the video is
    // drawn, as a supervisor stops a job: the partial demo.mp4, the frames
    // and the browser's profile go, and it ends by the same signal.
    const child = spawn(process.execPath, [CLI, "demo", origin, "--steps", good, "--out", dir], { detached: true });
    let stderr = "";
    let profiles = [];
    let locks = [];
    child.stderr.on("data", (d) => {
      const first = !/^Drawing /m.test(stderr);
      stderr += d;
      if (first && /^Drawing /m.test(stderr)) {
        profiles = profilesOf(child.pid);
        locks = profiles.map(lockOf).filter(Boolean);
        process.kill(-child.pid, "SIGTERM");
      }
    });
    const how = await new Promise((resolve) => child.on("close", (status, signal) => resolve(signal || status)));
    assert.equal(how, "SIGTERM", stderr);
    assert.match(stderr, /easyscreenshotkit demo: stopped\. .*demo is as it was before this run\./);
    if (process.platform === "linux") assert.deepEqual([profiles.length, locks.length], [1, 1], stderr);
    for (const left of [...profiles, ...locks]) assert.equal(fs.existsSync(left), false, left);
    assert.deepEqual(snapshot(dir), before);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A step that clicks a link to a file served as an attachment. Chrome on
// Linux saves a download in the Downloads folder of the home it runs with;
// the demo's browser saves nothing, there or anywhere else.
test("a click on a download link saves no file", { skip: missing || (process.platform !== "linux" && "Chrome reads where it saves a download from HOME on Linux only"), timeout: 180_000 }, async () => {
  const seen = [];
  const { server, origin } = await serve((req, res) => {
    seen.push(req.url);
    if (req.url === "/") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Get it | Acme", '<h1>Get it</h1><p style="font-size:32px;padding:0 40px"><a href="/file.bin">Get the file</a></p><div style="height:1400px;background:rgb(0,160,0)"></div>'));
    if (req.url === "/file.bin") return res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="from-the-site.txt"' }).end("written by the site\n");
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const steps = path.join(root, "get.yaml");
  fs.writeFileSync(steps, 'steps:\n  - visit: /\n  - click: "text=Get the file"\n    zoom: false\n  - wait: 1\n');
  const env = { ...process.env, HOME: home };
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DOWNLOAD_DIR;
  // Every file under root that the site sent, by its name or its bytes.
  const fromTheSite = () => {
    const found = [];
    const walk = (at) => {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const file = path.join(at, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && (/from-the-site|\.crdownload$/.test(entry.name) || fs.readFileSync(file, "utf8") === "written by the site\n")) found.push(path.relative(root, file));
      }
    };
    walk(root);
    return found;
  };
  try {
    const child = spawn(process.execPath, [CLI, "demo", origin, "--steps", steps, "--out", path.join(root, "demo"), "--no-gif"], { env });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const status = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(status, 0, stderr);
    assert.ok(seen.includes("/file.bin"), "the click sent the browser to the file");
    assert.deepEqual(fromTheSite(), []);
    assert.deepEqual(fs.readdirSync(path.join(root, "demo")).sort(), ["demo.mp4", "poster.png", "steps.json"]);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a step that points at nothing stops the run with its number and leaves nothing behind", { skip: missing, timeout: 120_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const steps = path.join(root, "demo.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - click: 'text=Not on this page'\n");
  try {
    await assert.rejects(makeDemo(origin, { dir, steps, timeLimit: 100_000 }), /step 2 \(click\): nothing on the page matches text=Not on this page/);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
