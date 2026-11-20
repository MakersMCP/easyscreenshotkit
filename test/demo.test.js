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
const { pickPages, tourSteps, SECTIONS } = require("../skills/easyscreenshotkit/scripts/lib/tour");
const { setTimeLimit } = require("../skills/easyscreenshotkit/scripts/lib/time");
const { readSteps } = require("../skills/easyscreenshotkit/scripts/lib/steps");
const { findChrome, launch, openTab, closeTab, navigate } = require("../skills/easyscreenshotkit/scripts/lib/chrome");
const { findFfmpeg, makeGif, startVideo, gifIsWhole, mp4Frames } = require("../skills/easyscreenshotkit/scripts/lib/ffmpeg");
const { checkBackdrop } = require("../skills/easyscreenshotkit/scripts/lib/compose");
const { readPng, pngOf, serve, near, descendants, relayBrowser, runUntilOver, tempProblem, sh } = require("./helpers");
const { noBus, privateBus, fakePortal } = require("./bus");

const CLI = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
const ffmpeg = findFfmpeg();
// A temp folder the kit starts no browser from skips every test that
// starts one, with the kit's own reason (see helpers.js tempProblem).
const noTemp = tempProblem();
const missing = !findChrome() ? "no Chrome, Chromium, Edge or Brave installed" : !ffmpeg ? "no ffmpeg installed" : noTemp;

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
  // A page no frame shows is no page of the video: one that came as the
  // video ended, and one that another took the place of before the next
  // frame. They were listed, with a start on the video's last frame or
  // past it, and a caption timed from them landed on another page.
  const late = { urls: [{ t: 0, url: "https://acme.com/app/#/today" }, { t: 1.004, url: "https://acme.com/app/#/light" }], pages: [], duration: 1.004 };
  assert.deepEqual(pageEntries(late, { fps: 30, frames: 30 }).map((p) => [p.url, p.start, p.end, p.startFrame, p.endFrame]), [["https://acme.com/app/#/today", 0, 1.004, 0, 30]]);
  const passing = { urls: [{ t: 0, url: "https://acme.com/a" }, { t: 1.002, url: "https://acme.com/b" }, { t: 1.01, url: "https://acme.com/c" }], pages: [], duration: 3 };
  assert.deepEqual(pageEntries(passing, { fps: 30, frames: 90 }).map((p) => [p.url, p.start, p.end]), [["https://acme.com/a", 0, 1.01], ["https://acme.com/c", 1.01, 3]]);
  // A page that comes back after one no frame showed is still one page.
  const back = { urls: [{ t: 0, url: "https://acme.com/a" }, { t: 1.002, url: "https://acme.com/b" }, { t: 1.01, url: "https://acme.com/a" }], pages: [], duration: 3 };
  assert.deepEqual(pageEntries(back, { fps: 30, frames: 90 }).map((p) => [p.url, p.start, p.end]), [["https://acme.com/a", 0, 3]]);
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

// A whole GIF and MP4 as ffmpeg writes them, and the same files cut short at
// any point: what the run reads before it counts a file as made.
test("a GIF or a video cut short is told from a whole one, by its blocks and by its index", { skip: !ffmpeg && "no ffmpeg installed", timeout: 60_000 }, () => {
  const root = tempDir();
  try {
    const video = path.join(root, "whole.mp4");
    const gif = path.join(root, "whole.gif");
    const lavfi = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10:duration=1"];
    for (const args of [[...lavfi, "-pix_fmt", "yuv420p", "-movflags", "+faststart", video], [...lavfi, gif]]) {
      const made = spawnSync(ffmpeg, args, { encoding: "utf8" });
      assert.equal(made.status, 0, made.stderr);
    }
    assert.equal(mp4Frames(video), 10);
    const bytes = fs.readFileSync(video);
    for (const at of [0, 4, 7, 200, bytes.length >> 1, bytes.length - 1]) {
      const cut = path.join(root, "cut.mp4");
      fs.writeFileSync(cut, bytes.subarray(0, at));
      assert.equal(mp4Frames(cut), 0, `cut at ${at}`);
    }
    assert.equal(mp4Frames(path.join(root, "no-such.mp4")), 0);
    const whole = fs.readFileSync(gif);
    assert.equal(gifIsWhole(whole), true);
    for (const at of [0, 5, 12, 13, 400, whole.length >> 1, whole.length - 1]) assert.equal(gifIsWhole(whole.subarray(0, at)), false, `cut at ${at}`);
    // Cut where the last byte happens to be the trailer's.
    const lookalike = Buffer.from(whole.subarray(0, whole.length - 1));
    lookalike[lookalike.length - 1] = 0x3b;
    assert.equal(gifIsWhole(lookalike), false);
    assert.equal(gifIsWhole(Buffer.concat([whole, Buffer.from([0])])), false, "more after its trailer");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ffmpeg 4, on a full disk, only logs that it could not write the end of the
// file and exits with 0, and a GIF or a video cut short replaced the earlier
// demo. Here a stand-in that does the same: every call asks it to fail, and
// what it leaves is read and refused.
test("a GIF or a video that ffmpeg cut short while exiting with 0 is no output", { skip: process.platform === "win32" && "the stand-in for ffmpeg is a shell script", timeout: 30_000 }, async () => {
  const root = tempDir();
  const log = path.join(root, "args.txt");
  const fake = path.join(root, "ffmpeg");
  fs.writeFileSync(fake, `#!/bin/sh\necho "$*" >> ${sh(log)}\nfor last; do :; done\nprintf 'GIF89a\\001\\000\\001\\000\\000\\000\\000' > "$last"\ncat > /dev/null\nexit 0\n`, { mode: 0o755 });
  try {
    await assert.rejects(makeGif(fake, path.join(root, "in.mp4"), path.join(root, "out.gif"), { dir: root }), /^Error: ffmpeg could not write out\.gif: the file came out cut short \(the disk, or your disk quota, may be full\)$/);
    const sink = startVideo(fake, path.join(root, "out.mp4"), { fps: 30, encoder: { name: "x", args: [] } });
    await sink.write(Buffer.from("a frame"));
    await assert.rejects(sink.end(), /^Error: ffmpeg could not write out\.mp4: the file came out cut short/);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    assert.equal(calls.length, 3, calls.join("\n"));
    for (const call of calls) assert.match(call, /(^| )-xerror( |$)/, call);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ffmpeg 4 on a full disk says why on one line and ends on another with
// nothing after its "--": the kit printed only that one.
test("what ffmpeg said of why it stopped is told, when its last line ends with no reason", { skip: process.platform === "win32" && "the stand-in for ffmpeg is a shell script", timeout: 30_000 }, async () => {
  const root = tempDir();
  const fake = path.join(root, "ffmpeg");
  const WHY = "Could not write header for output file #0 (incorrect codec parameters ?): No space left on device";
  fs.writeFileSync(fake, `#!/bin/sh\necho '${WHY}' >&2\necho 'Error initializing output stream 0:0 -- ' >&2\nexit 1\n`, { mode: 0o755 });
  const told = (text) => new RegExp(`^Error: ${text}${WHY.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}$`);
  try {
    await assert.rejects(makeGif(fake, path.join(root, "in.mp4"), path.join(root, "out.gif"), { dir: root }), told("ffmpeg could not make the GIF's palette: "));
    const ended = startVideo(fake, path.join(root, "out.mp4"), { fps: 30, encoder: { name: "x", args: [] } });
    await assert.rejects(ended.end(), told("ffmpeg could not write out\\.mp4: "));
    const stopped = startVideo(fake, path.join(root, "out.mp4"), { fps: 30, encoder: { name: "x", args: [] } });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await assert.rejects(stopped.write(Buffer.from("a frame")), told("ffmpeg stopped: "));
    await stopped.end().catch(() => {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Whether a --background file can be drawn is the browser's to say: it
// draws nothing for one that is no picture, and the backdrop came out plain
// grey with no word of why. A check of its first bytes passed what the
// browser cannot draw and refused the BMP and the ICO it can. A picture cut
// short is one the browser draws a strip of, over grey, and says it loaded:
// it is read to its end. The JPEG, the GIF and the WebP come from ffmpeg,
// when there is one that makes them.
test("a --background file is judged by the browser: what it draws is taken, what it does not is refused, and a picture cut short too", { skip: (!findChrome() && "no Chrome, Chromium, Edge or Brave installed") || noTemp, timeout: 60_000 }, async () => {
  const root = tempDir();
  const png = pngOf(32, 32, () => [0, 170, 119]);
  const bmp = Buffer.alloc(70);
  bmp.write("BM", 0, "latin1");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(2, 18);
  bmp.writeInt32LE(2, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = 32;
  ico[7] = 32;
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14);
  ico.writeUInt32LE(22, 18);
  const svg = (attributes = 'width="10" height="10"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attributes}><rect width="10" height="10" fill="#00aa77"/></svg>`;
  const pictures = {
    "a.png": png,
    "bmp-named.png": bmp,
    "ico-named.png": Buffer.concat([ico, png]),
    "a.svg": svg(),
    "viewbox.svg": svg('viewBox="0 0 10 10"'),
    "no-size.svg": svg(""),
    "long-head.svg": `<?xml version="1.0"?>\n<!-- ${"a long comment ".repeat(400)} -->\n${svg()}`,
    "prefixed.svg": '<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="10" height="10"><svg:rect width="10" height="10"/></svg:svg>',
    "utf16.svg": Buffer.from(`\ufeff<?xml version="1.0" encoding="UTF-16"?>\n${svg()}`, "utf16le"),
  };
  const notPictures = {
    "sound.png": Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(64)]),
    "empty.png": "",
    "cut.png": png.subarray(0, 40),
    "text.webp": "not a picture at all",
    "raster.svg": png,
    "drawing.png": svg(),
    "no-xmlns.svg": '<svg width="10" height="10"><rect width="10" height="10"/></svg>',
    "html-with-svg.svg": `<!doctype html><html><body>${svg()}</body></html>`,
    "comment-only.svg": `<?xml version="1.0"?>\n<!-- ${svg()} -->\n`,
  };
  const noisy = pngOf(200, 150, (x, y) => [(x * 37 + y * 11) % 256, (x * y) % 256, (x * 13 + y * 7) % 256]);
  pictures["noisy.png"] = noisy;
  // Bytes after a picture's end are no part of it: the browser draws it.
  pictures["trailing.png"] = Buffer.concat([noisy, Buffer.alloc(4)]);
  const cut = { "cut-half.png": noisy.subarray(0, Math.floor(noisy.length / 2)) };
  for (const [name, args] of ffmpeg ? [["cut.jpg", []], ["cut.gif", []], ["cut.webp", ["-c:v", "libwebp"]], ["cut.avif", ["-c:v", "libaom-av1", "-still-picture", "1"]]] : []) {
    const whole = path.join(root, `whole-${name}`);
    if (spawnSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240", "-frames:v", "1", ...args, whole]).status !== 0) continue;
    const data = fs.readFileSync(whole);
    pictures[`whole-${name}`] = data;
    cut[name] = data.subarray(0, Math.floor(data.length / 2));
  }
  // Whole pictures that were refused as cut short, though the browser draws
  // them whole: a JPEG with bytes of padding between two of its segments,
  // as some writers leave, a GIF whose last picture's data is all there and
  // whose one-byte trailer is not, and an AVIF with a few bytes after its
  // last box.
  if (pictures["whole-cut.jpg"]) {
    const jpeg = pictures["whole-cut.jpg"];
    const after = 4 + jpeg.readUInt16BE(4);
    pictures["padded.jpg"] = Buffer.concat([jpeg.subarray(0, after), Buffer.alloc(2), jpeg.subarray(after)]);
    pictures["trailing.jpg"] = Buffer.concat([jpeg, Buffer.alloc(4)]);
  }
  if (pictures["whole-cut.gif"]) pictures["no-trailer.gif"] = pictures["whole-cut.gif"].subarray(0, pictures["whole-cut.gif"].length - 1);
  if (pictures["whole-cut.avif"]) pictures["trailing.avif"] = Buffer.concat([pictures["whole-cut.avif"], Buffer.alloc(4)]);
  setTimeLimit(50_000);
  const chrome = await launch();
  const file = (name, data) => {
    const at = path.join(root, name);
    fs.writeFileSync(at, data);
    return at;
  };
  try {
    // Colours and gradients are no files: the browser says whether each is a
    // colour. A word CSS does not know drew a plain white backdrop.
    await checkBackdrop(chrome, "#0f172a, rgb(1, 2, 3)", root);
    await checkBackdrop(chrome, "", root);
    for (const color of ["slategray", "SlateGray", "rgb(10 20 30 / 50%)", "hsl(200, 50%, 40%), tomato"]) await checkBackdrop(chrome, color, root);
    for (const color of ["notacolour", "charcoal", "#12345", "red, slate", "none", "inherit", "red, inherit"]) await assert.rejects(checkBackdrop(chrome, color, root), { message: `--background takes a colour, two colours for a gradient, or a picture file, not ${color}` }, color);
    for (const [name, data] of Object.entries(pictures)) await checkBackdrop(chrome, file(name, data), root);
    for (const [name, data] of Object.entries(notPictures)) await assert.rejects(checkBackdrop(chrome, file(name, data), root), new RegExp(`^Error: --background: .*${name} is no picture the browser can draw: PNG, JPEG, WebP, GIF, AVIF or SVG\\.$`), name);
    // ffmpeg makes a JPEG and a GIF with encoders of its own; a WebP only
    // when it was built with libwebp.
    if (ffmpeg) for (const name of ["cut.jpg", "cut.gif"]) assert.ok(name in cut, name);
    for (const [name, data] of Object.entries(cut)) await assert.rejects(checkBackdrop(chrome, file(name, data), root), new RegExp(`^Error: --background: .*${name} is cut short, so the browser would draw only part of it\\.$`), name);
  } finally {
    await chrome.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a demo is refused a --background the browser cannot draw, or one cut short, before it records, and draws one it can", { skip: missing, timeout: 200_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - wait: 0.3\n");
  const out = path.join(root, "out");
  // A 2x2 BMP in one colour, under a picture's name.
  const bmp = Buffer.alloc(70);
  bmp.write("BM", 0, "latin1");
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(2, 18);
  bmp.writeInt32LE(2, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  for (const at of [54, 57, 62, 65]) Buffer.from([119, 170, 0]).copy(bmp, at);
  const bad = path.join(root, "no-xmlns.svg");
  fs.writeFileSync(bad, '<svg width="10" height="10"><rect width="10" height="10"/></svg>');
  const good = path.join(root, "bmp-named.png");
  fs.writeFileSync(good, bmp);
  // A picture of a backdrop, cut short: the browser draws its first rows.
  const noisy = pngOf(400, 300, (x, y) => [(x * 37 + y * 11) % 256, (x * y) % 256, (x * 13 + y * 7) % 256]);
  const cut = path.join(root, "kırık.png");
  fs.writeFileSync(cut, noisy.subarray(0, Math.floor(noisy.length / 3)));
  try {
    for (const [file, why] of [[bad, "is no picture the browser can draw"], [cut, "is cut short, so the browser would draw only part of it."]]) {
      const refused = spawnSync(process.execPath, [CLI, "demo", origin, "--steps", steps, "--background", file, "--no-gif", "--out", out], { encoding: "utf8", timeout: 60_000 });
      // In a child process that cannot reach this one's server while this
      // one is held: the refusal comes before anything is opened.
      assert.equal(refused.status, 1, refused.stderr);
      assert.ok(refused.stderr.includes(`easyscreenshotkit demo: --background: ${file} ${why}`), refused.stderr);
      assert.equal(fs.existsSync(out), false);
      assert.deepEqual(seen, []);
    }
    await makeDemo(origin, { dir: out, steps, background: good, gif: false, timeLimit: 150_000 });
    const poster = readPng(path.join(out, "poster.png"));
    assert.ok(near(poster.pixel(20, 20), [0, 170, 119], 30), `backdrop: ${poster.pixel(20, 20)}`);
    // A word that is no colour is refused before anything is recorded, and
    // the earlier demo stays as it was, where it drew a white backdrop and
    // replaced it.
    const before = snapshot(out);
    const visits = seen.length;
    const word = spawnSync(process.execPath, [CLI, "demo", origin, "--steps", steps, "--background", "charcoal", "--no-gif", "--out", out], { encoding: "utf8", timeout: 60_000 });
    assert.equal(word.status, 1, word.stderr);
    assert.equal(word.stderr, "easyscreenshotkit demo: --background takes a colour, two colours for a gradient, or a picture file, not charcoal\n");
    assert.deepEqual(snapshot(out), before);
    assert.equal(seen.length, visits);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The least --timeout a demo takes, a minute, could record no step: each
// step needed a minute of the run left, and the browser's start had taken
// some of it before the first one.
test("a demo given a minute records its steps", { skip: missing, timeout: 200_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - wait: 0.5\n  - scroll: 300\n");
  try {
    const { manifest } = await makeDemo(origin, { dir: path.join(root, "out"), steps, gif: false, timeLimit: 60_000 });
    assert.deepEqual(manifest.steps.map((step) => step.action), ["visit", "wait", "scroll"]);
    assert.ok(fs.existsSync(path.join(root, "out", "demo.mp4")));
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// An ffmpeg that a wrapper script starts, which leaves a program of its own
// running as it is asked its version and its encoders: that program holds
// the other ends of the pipes the demo read them on, and the demo's process
// waited for it to end before it exited, its files saved and its summary
// printed, where 0.1.1 waited for it before it recorded.
test("a demo exits once it is over, while a program an ffmpeg wrapper left running goes on", { skip: missing || (process.platform === "win32" && "the wrapper is a shell script"), timeout: 200_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - wait: 0.5\n");
  const pids = path.join(root, "leftovers.pid");
  const wrapper = path.join(root, "ffmpeg-leftover");
  fs.writeFileSync(wrapper, `#!/bin/sh\ncase " $* " in *" -version "*|*" -encoders "*) sleep 600 & echo $! >> ${sh(pids)};; esac\nexec ${sh(ffmpeg)} "$@"\n`, { mode: 0o755 });
  const leftovers = () => (fs.existsSync(pids) ? fs.readFileSync(pids, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
  try {
    const run = await runUntilOver(CLI, ["demo", origin, "--steps", steps, "--no-gif", "--json", "--out", path.join(root, "out")], { env: { ...process.env, FFMPEG_PATH: wrapper } });
    assert.equal(run.held, undefined, `the demo printed steps.json and had not exited 20 s later\n${run.stderr}`);
    assert.equal(run.status, 0, run.stderr);
    assert.ok(fs.existsSync(path.join(root, "out", "demo.mp4")));
    // Not waited for: both are still running.
    assert.equal(leftovers().length, 2);
    for (const pid of leftovers()) assert.doesNotThrow(() => process.kill(pid, 0));
  } finally {
    for (const pid of leftovers()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ended already.
      }
    }
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Drawing the frames has time of its own, however much of the run the
// recording took, and the browser they are drawn in starts in that time: it
// started in what the recording had left, as little as a second for each of
// its calls, and on a busy machine the demo failed after the whole
// recording with "started but did not answer in 20 s". A preload notes the
// time the run has left at each start of a browser.
test("the browser a demo's frames are drawn in starts in the time the drawing has, not in what the recording left", { skip: missing, timeout: 200_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - wait: 0.3\n");
  const notes = path.join(root, "starts.txt");
  const preload = path.join(root, "starts.js");
  const lib = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/lib");
  fs.writeFileSync(preload, `const chrome = require(${JSON.stringify(path.join(lib, "chrome"))});\nconst { timeLeft } = require(${JSON.stringify(path.join(lib, "time"))});\nconst launch = chrome.launch;\nchrome.launch = (...args) => {\n  require("fs").appendFileSync(${JSON.stringify(notes)}, timeLeft() + "\\n");\n  return launch(...args);\n};\n`);
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--require", preload, CLI, "demo", origin, "--steps", steps, "--timeout", "90", "--no-gif", "--out", path.join(root, "out")]);
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    const [recording, drawing] = fs.readFileSync(notes, "utf8").trim().split("\n").map(Number);
    assert.ok(recording > 80_000 && recording <= 90_000, `recording: ${recording}`);
    assert.ok(drawing > 115_000, `drawing: ${drawing}`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A browser that still answers but takes longer than a frame may take to
// draw one, as on a machine too busy to run it, fails the demo in a sentence
// that says so and what to do, where it failed in the bare words of the call
// that ran out of time, "Page.captureScreenshot timed out". A preload makes
// each capture of a drawn frame wait for what never comes, for 3 s.
test("a demo whose frames the browser draws too slowly says so", { skip: missing, timeout: 200_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - wait: 0.3\n");
  const preload = path.join(root, "slow.js");
  const lib = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/lib");
  fs.writeFileSync(
    preload,
    `const chrome = require(${JSON.stringify(path.join(lib, "chrome"))});
const openTab = chrome.openTab;
chrome.openTab = async (browser, device, options = {}) => {
  const tab = await openTab(browser, device, options);
  if (!options.own) return tab;
  const send = tab.send;
  tab.send = (method, params, timeoutMs, more) => (method === "Page.captureScreenshot" ? send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, 3_000, more) : send(method, params, timeoutMs, more));
  return tab;
};
`,
  );
  try {
    const out = path.join(root, "out");
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--require", preload, CLI, "demo", origin, "--steps", steps, "--no-gif", "--out", out]);
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stderr }));
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /^easyscreenshotkit demo: The browser took too long to draw the demo's frames, so no demo was saved\. The machine may be too busy: try again\.$/m);
    assert.equal(fs.existsSync(out), false);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A named pipe nothing writes to holds a read of it for as long as it takes,
// and a synchronous one held the process so that only SIGKILL ended it. A
// read that is not synchronous lets a stop through, and a pipe that is
// written to, as --steps <(a generator) gives, is read as before.
test("a --steps file that is a named pipe waits for its writer, and a stop ends the wait", { skip: (process.platform === "win32" && "no named pipes of that kind on Windows") || (!ffmpeg && "no ffmpeg installed"), timeout: 60_000 }, async () => {
  const root = tempDir();
  const pipe = path.join(root, "steps.yaml");
  try {
    assert.equal(spawnSync("mkfifo", [pipe]).status, 0);
    const stopped = spawn(process.execPath, [CLI, "demo", "--steps", pipe, "--out", path.join(root, "out")]);
    let stderr = "";
    stopped.stderr.on("data", (d) => (stderr += d));
    setTimeout(() => stopped.kill("SIGTERM"), 1_000);
    // The check below waits no longer than this for a process that is held.
    const kill = setTimeout(() => stopped.kill("SIGKILL"), 8_000);
    const how = await new Promise((resolve) => stopped.on("close", (status, signal) => resolve(signal || status)));
    clearTimeout(kill);
    assert.equal(how, "SIGTERM", stderr);
    assert.equal(stderr, "easyscreenshotkit demo: stopped.\n");
    assert.equal(fs.existsSync(path.join(root, "out")), false);

    // What is written to it is read: here a step that is not one, which
    // stops the demo before a browser is started.
    const reading = spawn(process.execPath, [CLI, "demo", "--steps", pipe, "--out", path.join(root, "out")]);
    let told = "";
    reading.stderr.on("data", (d) => (told += d));
    const writer = spawnSync("sh", ["-c", 'printf "steps:\\n  - jump: 1\\n" > "$1"', "sh", pipe], { timeout: 10_000 });
    assert.equal(writer.status, 0);
    const status = await new Promise((resolve) => reading.on("close", resolve));
    assert.equal(status, 1, told);
    assert.match(told, /steps\.yaml: step 1: no action; use one of visit/);
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
async function fixture({ sitemap = null, home = null } = {}) {
  const seen = [];
  let origin = "";
  const { server, origin: base } = await serve((req, res) => {
    seen.push(req.url);
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/sitemap.xml" && sitemap) return res.writeHead(200, { "Content-Type": "application/xml" }).end(`<urlset>${sitemap.map((at) => `<url><loc>${origin}${at}</loc></url>`).join("")}</urlset>`);
    if (url.pathname === "/") return home ? home(res) : html(HOME);
    if (url.pathname === "/features") return html(plain("Features", "rgb(0,200,200)"));
    if (url.pathname === "/pricing") return html(plain("Pricing", "rgb(0,120,255)"));
    if (url.pathname === "/login") return html(plain("Log in", "#eee"));
    if (url.pathname === "/nothing") return res.writeHead(204).end();
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

// --hide with --no-clean hides what it names, and only that, where it was
// dropped without a word.
test("a demo with --no-clean hides what --hide names, and only that", { skip: missing, timeout: 200_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - wait: 1\n");
  try {
    await makeDemo(origin, { dir: path.join(root, "out"), steps, gif: false, clean: false, hide: [".chat"], timeLimit: 150_000 });
    const poster = readPng(path.join(root, "out", "poster.png"));
    assert.ok(near(unzoomed(poster, 800, 870), BLUE), `cookie bar kept: ${unzoomed(poster, 800, 870)}`);
    assert.ok(!near(unzoomed(poster, 1546, 770), MAGENTA), `chat bubble hidden: ${unzoomed(poster, 1546, 770)}`);
    assert.ok(near(unzoomed(poster, 800, 400), GREEN), `hero: ${unzoomed(poster, 800, 400)}`);
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
    // The site is named by its first page as a tour names it, where a demo
    // from a steps file took the host's name, 127.0.0.1.
    assert.equal(manifest.site, "Plants");
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

// A tour given the least --timeout, a minute, of a #route view with a
// --page: it recorded the home page alone, the view given and the --page
// dropped without a word, and said it was done. Every page asked for is in
// the video or named in the notes, the view given is in it or the demo
// fails, and the tour says why it looked for no more pages.
test("a tour given a minute shows the #route view given or fails, and names every page it left out", { skip: missing, timeout: 200_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "tour");
  const asked = [`${origin}/app/#/plants`, `${origin}/app/#/light`];
  try {
    let manifest = null;
    try {
      ({ manifest } = await makeDemo(asked[0], { dir, pages: 4, extra: ["#/light"], gif: false, timeLimit: 60_000 }));
    } catch (err) {
      assert.equal(err.message, "time ran out while recording; give more with --timeout");
      assert.equal(fs.existsSync(dir), false);
      return;
    }
    const shown = manifest.pages.map((p) => p.url);
    assert.ok(shown.includes(asked[0]), shown.join(", "));
    for (const url of asked) assert.ok(shown.includes(url) || manifest.notes.includes(`Left out ${url}: time ran out; give more with --timeout.`), `${url}\n${manifest.notes.join("\n")}`);
    assert.ok(manifest.notes.includes("Time ran out after 3 pages: a tour looks for more only while 4 minutes of the run are left; give more with --timeout."), manifest.notes.join("\n"));
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A steps file that ends on a visit, or on a wait for what the page shows
// already: the video ended as the view came in, and steps.json listed the
// view with no frame of it. It stays up a moment, as a tour's pages do.
test("a demo that ends on a visit shows the view it opened, and steps.json lists only views the video shows", { skip: missing, timeout: 300_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const ends = {
    visit: "steps:\n  - visit: /app/#/today\n  - wait: 1\n  - visit: /app/#/light\n",
    met: "steps:\n  - visit: /app/#/today\n  - wait: 1\n  - visit: /app/#/light\n  - wait: h1\n",
  };
  try {
    for (const [name, text] of Object.entries(ends)) {
      const steps = path.join(root, `${name}.yaml`);
      fs.writeFileSync(steps, text);
      const dir = path.join(root, name);
      const { manifest } = await makeDemo(origin, { dir, steps, gif: false, timeLimit: 200_000 });
      assert.deepEqual(manifest.pages.map((p) => p.url.slice(origin.length)), ["/app/#/today", "/app/#/light"], name);
      const last = manifest.pages[1];
      assert.ok(last.end - last.start >= 1, `${name}: ${last.start} to ${last.end}`);
      assert.ok(last.startFrame < manifest.video.frames, `${name}: frame ${last.startFrame} of ${manifest.video.frames}`);
      const frame = await frameOf(path.join(dir, "demo.mp4"), manifest.video.duration - 0.2);
      assert.ok(near(unzoomed(frame, 800, 700), ORANGE), `${name}: ${unzoomed(frame, 800, 700)}`);
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

test("a tour lists the #route links of the home page and the address given, and the #routes its sitemap lists, in one note, also when it needs no more pages", { skip: (!findChrome() && "no Chrome, Chromium, Edge or Brave installed") || noTemp, timeout: 120_000 }, async () => {
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

// A --page the browser cannot open, here one that answers with nothing, is
// left out of the tour with the reason, and the tour goes on: it stopped
// the demo.
test("a tour leaves out a --page that cannot be opened, and goes on, and fails with none of the pages asked for", { skip: (!findChrome() && "no Chrome, Chromium, Edge or Brave installed") || noTemp, timeout: 150_000 }, async () => {
  const { server, origin } = await fixture();
  setTimeLimit(50_000);
  const chrome = await launch();
  try {
    const tour = await pickPages(chrome, origin, { pages: 2, extra: ["/nothing"] });
    assert.deepEqual(tour.pages.map((p) => p.url.slice(origin.length)), ["/"]);
    assert.equal(tour.skipped.length, 1);
    assert.equal(tour.skipped[0].url, `${origin}/nothing`);
    assert.match(tour.skipped[0].reason, /^could not be opened: net::ERR_[A-Z_]+$/);
    // A tour that has none of the pages the user named to show fails: one
    // that showed the home page and pages it picked itself took the place
    // of an earlier demo. With one of them, it goes on.
    setTimeLimit(120_000);
    await assert.rejects(pickPages(chrome, `${origin}/missing`, { pages: 2 }), { message: `${origin}/missing was asked for but not taken: the page answered 404. No demo was recorded.` });
    await assert.rejects(pickPages(chrome, `${origin}/missing`, { pages: 1, extra: ["/nothing"] }), new RegExp(`^Error: ${origin}/missing was asked for but not taken: the page answered 404\\. ${origin}/nothing was asked for but not taken: could not be opened: net::ERR_[A-Z_]+\\. No demo was recorded\\.$`));
    const one = await pickPages(chrome, `${origin}/missing`, { pages: 2, extra: ["/pricing"] });
    assert.deepEqual(one.pages.map((p) => [p.url.slice(origin.length), p.why]), [["/", "the home page"], ["/pricing", "asked for with --page"]]);
    assert.deepEqual(one.skipped, [{ url: `${origin}/missing`, reason: "the page answered 404" }]);
    // A --page that is a page the tour has already, here the home page, is
    // one of the pages asked for that it shows.
    const same = await pickPages(chrome, `${origin}/missing`, { pages: 2, extra: ["/"] });
    assert.deepEqual(same.pages.map((p) => p.url.slice(origin.length)), ["/"]);
    assert.deepEqual(same.skipped, [{ url: `${origin}/missing`, reason: "the page answered 404" }, { url: `${origin}/`, reason: "the same page as home" }]);
  } finally {
    await chrome.close();
    server.close();
  }
});

// A --page the tour could not take is named once, with why: a #route link
// to it, here in the sitemap, is not listed again with the #route links the
// tour does not follow, whose note says to give one with --page, as it was
// given. One nobody asked for still is.
test("a tour does not list a --page it could not take with the #route links to give with --page", { skip: (!findChrome() && "no Chrome, Chromium, Edge or Brave installed") || noTemp, timeout: 120_000 }, async () => {
  const { server, origin } = await fixture({ sitemap: ["/", "/missing/#/gone", "/app/#/x"] });
  setTimeLimit(110_000);
  const chrome = await launch();
  try {
    const tour = await pickPages(chrome, origin, { pages: 2, extra: ["/missing/#/gone"] });
    assert.deepEqual(tour.skipped, [{ url: `${origin}/missing/#/gone`, reason: "the page answered 404" }]);
    const routes = tour.routes.map((route) => route.url.slice(origin.length));
    assert.ok(routes.includes("/app/#/x"), routes.join(", "));
    assert.ok(!routes.includes("/missing/#/gone"), routes.join(", "));
  } finally {
    await chrome.close();
    server.close();
  }
});

// A page whose own script keeps it busy once it has loaded. One busy from
// the moment it loads does not answer as the tour opens it to check it, and
// is left out as too slow to answer, as the screenshots leave it out. One
// that stops answering a moment later is kept, as the tour's check goes on
// reading it with calls that let a timeout go, and the demo then fails when
// it records it. That one makes the moment certain: it stops answering as
// the check first counts its elements, after its first look at the page
// (settle() counts them with getElementsByTagName), and tells the server so
// first. The README said a tour left out such a page as the screenshots do.
test("a tour leaves out a --page that does not answer as it opens it, and can keep one that stops answering a moment later, as the README says", { skip: (!findChrome() && "no Chrome, Chromium, Edge or Brave installed") || noTemp, timeout: 180_000 }, async () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.match(readme, /In the screenshots, a `--page` or a page of the tour is left out as too slow to answer, with those words\. A demo's tour leaves out such a page in the same words when the page does not answer as the tour opens it to check it, but can keep one that stops answering a moment later, and the demo then fails in those words when it records it\./);
  const hang = "setTimeout(() => { const s = Date.now(); while (Date.now() - s < 60000); });";
  const busy = (title, script) => page(`${title} | Acme`, `<h1>${title}</h1><div style="height:2400px;background:rgb(0,120,255)"></div><script>${script}</script>`);
  const seen = [];
  const { server, origin } = await serve((req, res) => {
    seen.push(req.url);
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    if (req.url === "/") return html(plain("Tools for teams", "rgb(0,160,0)"));
    if (req.url === "/early") return html(busy("Early", `addEventListener("load", () => { ${hang} });`));
    if (req.url === "/late") {
      return html(busy("Late", `const count = document.getElementsByTagName.bind(document); document.getElementsByTagName = (name) => { if (!window.hung) { window.hung = true; navigator.sendBeacon("/late-hangs"); ${hang} } return count(name); };`));
    }
    res.writeHead(404).end("not found");
  });
  setTimeLimit(170_000);
  const chrome = await launch();
  try {
    const tour = await pickPages(chrome, origin, { pages: 1, extra: ["/early", "/late"] });
    assert.deepEqual(tour.pages.map((p) => [p.url.slice(origin.length), p.why]), [["/", "the home page"], ["/late", "asked for with --page"]]);
    assert.deepEqual(tour.skipped, [{ url: `${origin}/early`, reason: "too slow to answer (Page.getLayoutMetrics timed out)" }]);
    assert.ok(seen.includes("/late-hangs"), seen.join(" "));
  } finally {
    await chrome.close();
    server.close();
  }
});

// A link to a #route goes by the query of the page it is on: clicked, a view
// asked for with a query of its own would open on the page's query.
test("a tour clicks to a view by its link only when the view has the query of the page before it", async () => {
  const recorder = {
    viewport: { width: 1600, height: 900 },
    eval: async () => 0,
    locate: async () => ({ left: 10, top: 10, width: 50, height: 20, covered: false, text: "Next", attribute: "#/two" }),
    scrollState: async () => ({ y: 0 }),
  };
  setTimeLimit(300_000);
  const moves = async (pages) => {
    const found = [];
    for await (const step of tourSteps(recorder, pages)) if (step.action === "click" || step.action === "visit") found.push(step.action);
    return found;
  };
  const at = (url) => ({ url: `https://acme.com${url}` });
  assert.deepEqual(await moves([at("/spa/?mode=a#/one"), at("/spa/?mode=a#/two")]), ["visit", "click"]);
  assert.deepEqual(await moves([at("/spa/?mode=a#/one"), at("/spa/?mode=b#/two")]), ["visit", "visit"]);
  // A page with no #route is the link's whatever query the page before has.
  assert.deepEqual(await moves([at("/spa/?mode=a#/one"), at("/pricing")]), ["visit", "click"]);
  // The first step opens the site by its name at the home page, and the
  // page the tour starts at by its path and route otherwise: a tour whose
  // home page was left out said it opened the host while it showed a view.
  const first = async (page) => (await tourSteps(recorder, [page]).next()).value.label;
  assert.equal(await first({ ...at("/"), kind: "home" }), "Open acme.com");
  assert.equal(await first({ url: "https://www.acme.com/en/", kind: "home" }), "Open acme.com");
  assert.equal(await first({ ...at("/app/#/plants"), kind: "other" }), "Open /app/#/plants");
  assert.equal(await first({ ...at("/docs/start"), kind: "docs" }), "Open /docs/start");
});

// A tour short of time ended after its first page when less than 150 s
// were left, and left out the address given and each --page without a
// word. Here each step takes as long as a stand-in clock says, and the
// run's time goes down with it: the tour keeps the reserve, leaves out the
// scrolls and then the pages it picked itself so that the ones the user
// named are shown, says which it left out, and fails when it cannot show
// the address given.
test("a tour short of time shows the pages the user named first, says which it left out, and fails without the address given", async () => {
  const recorder = {
    viewport: { width: 1600, height: 900 },
    factor: 1,
    eval: async (expression) => (expression === SECTIONS ? { max: 5000, tops: [{ top: 1000, heading: "Fast" }, { top: 2000, heading: "Simple" }] } : 0),
    locate: async () => null,
    scrollState: async () => ({ y: 0 }),
  };
  const at = (url, flags = {}) => ({ url: `https://acme.com${url}`, kind: "other", ...flags });
  const pages = [at("/", { kind: "home" }), at("/features"), at("/app/#/plants", { asked: true, given: true }), at("/app/#/light", { asked: true })];
  // What each step takes, in ms: a page opens in 5 s, a scroll takes 2 s.
  const costs = { visit: 5_000, click: 5_000, scroll: 2_000 };
  const tour = async (start, { reserve = 15_000 } = {}) => {
    let now = 0;
    let left = start;
    const out = { steps: [], left: [], error: null };
    try {
      setTimeLimit(left);
      for await (const step of tourSteps(recorder, pages, { reserve, left: out.left, clock: () => now })) {
        out.steps.push(step.action === "wait" ? `wait ${step.seconds}` : `${step.action} ${step.url || (step.target && step.target.href) || step.to}`.replace("https://acme.com", ""));
        const ms = costs[step.action] || step.seconds * 1000;
        now += ms;
        left -= ms;
        setTimeLimit(left);
      }
    } catch (err) {
      out.error = err.message;
    } finally {
      setTimeLimit(120_000);
    }
    return out;
  };
  // Time for all of it: every page with its scrolls, in the tour's order.
  const plenty = await tour(300_000);
  assert.equal(plenty.error, null);
  assert.deepEqual(plenty.steps.filter((s) => /^(visit|scroll)/.test(s)), ["visit /", "scroll 992", "scroll 1992", "visit /features", "scroll 992", "scroll 1992", "visit /app/#/plants", "scroll 992", "scroll 1992", "visit /app/#/light", "scroll 992", "scroll 1992"]);
  assert.deepEqual(plenty.left, []);
  // 40 s with 15 kept: no scrolls where the pages named after them would
  // not fit, the features page the tour picked itself left out, the address
  // given and the --page shown.
  const short = await tour(40_000);
  assert.equal(short.error, null);
  assert.deepEqual(short.steps.filter((s) => /^(visit|scroll)/.test(s)), ["visit /", "visit /app/#/plants", "visit /app/#/light", "scroll 992", "scroll 1992"]);
  assert.deepEqual(short.left, [{ url: "https://acme.com/features", reason: "time ran out; give more with --timeout" }]);
  // Each page it shows stays up for its wait.
  assert.deepEqual(short.steps.slice(0, 4), ["visit /", "wait 1.6", "visit /app/#/plants", "wait 1.1"]);
  // 22 s: no room for the address given after the home page. The demo
  // fails, as it would show none of what was asked for.
  const none = await tour(22_000);
  assert.equal(none.error, "time ran out while recording; give more with --timeout");
  assert.deepEqual(none.steps, ["visit /", "wait 1.6"]);
  // With less than the reserve before it starts, nothing.
  const late = await tour(10_000);
  assert.equal(late.error, "time ran out while recording; give more with --timeout");
  assert.deepEqual(late.steps, []);
  // A tour that has shown the address given leaves out a --page it has no
  // time for, and says so.
  const tail = await tour(31_000);
  assert.equal(tail.error, null);
  assert.deepEqual(tail.steps.filter((s) => /^visit/.test(s)), ["visit /", "visit /app/#/plants"]);
  assert.deepEqual(tail.left, [{ url: "https://acme.com/features", reason: "time ran out; give more with --timeout" }, { url: "https://acme.com/app/#/light", reason: "time ran out; give more with --timeout" }]);
});

// A home page the tour chose to open by itself is left out when it cannot
// be taken and the address given is another page: a project site's root is
// often a 404. It stopped the demo, with --pages 1 too. What stops a demo is
// the address the user gave.
const HOME_LOST = [
  ["the page answered 404", (res) => res.writeHead(404).end("not found")],
  ["a bot check instead of the page", (res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Just a moment...", "<p>Checking your browser.</p>", ""))],
  [/^could not be opened: net::ERR_[A-Z_]+$/, (res) => res.socket.destroy()],
  ["a file to download instead of a page", (res) => res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="x.bin"' }).end("x")],
];

test("a tour starts at the address given when the home page cannot be taken, and says what it answered", { skip: (!findChrome() && "no Chrome, Chromium, Edge or Brave installed") || noTemp, timeout: 200_000 }, async () => {
  setTimeLimit(180_000);
  const chrome = await launch();
  try {
    for (const [reason, home] of HOME_LOST) {
      const { server, origin } = await fixture({ home });
      try {
        const tour = await pickPages(chrome, `${origin}/app/#/plants`, { pages: 2 });
        assert.deepEqual(tour.pages.map((p) => [p.url.slice(origin.length), p.why]), [["/app/#/plants", "the address given"]], String(reason));
        assert.equal(tour.skipped.length, 1);
        assert.equal(tour.skipped[0].url, `${origin}/`);
        assert.match(tour.skipped[0].reason, typeof reason === "string" ? new RegExp(`^${reason}$`) : reason);
      } finally {
        server.close();
      }
    }
    // A deeper page that is the address given, and the pages found on it.
    // Every page links to the home page, which is not opened again.
    const deep = await fixture({ home: HOME_LOST[0][1] });
    // A tour looks for pages while four minutes of the run are left.
    setTimeLimit(300_000);
    try {
      const tour = await pickPages(chrome, `${deep.origin}/features`, { pages: 3 });
      assert.deepEqual(tour.pages.map((p) => [p.url.slice(deep.origin.length), p.kind, p.why]), [["/features", "product", "the address given"], ["/pricing", "pricing", 'menu link "Pricing"']]);
      assert.deepEqual(tour.skipped, [{ url: `${deep.origin}/`, reason: "the page answered 404" }]);
      assert.equal(deep.seen.filter((url) => url === "/").length, 1, deep.seen.join(" "));
    } finally {
      deep.server.close();
    }
    // An address given that is the home page, or that cannot be taken
    // either, still stops the demo.
    const { server, origin } = await fixture({ home: HOME_LOST[0][1] });
    try {
      await assert.rejects(pickPages(chrome, origin, { pages: 2 }), new RegExp(`^Error: ${origin}/ answered 404, so no demo was recorded\\.$`));
      await assert.rejects(pickPages(chrome, `${origin}/nowhere/#/x`, { pages: 2 }), new RegExp(`^Error: ${origin}/nowhere/#/x answered 404, so no demo was recorded\\.$`));
    } finally {
      server.close();
    }
  } finally {
    await chrome.close();
  }
});

// A tour whose home page names a version in another language that answers
// an error or cannot be opened starts at the home page, with a note, where
// the demo failed over it.
test("a tour whose home page names a version in another language that answers an error or cannot be opened takes the home page, with a note", { skip: (!findChrome() && "no Chrome, Chromium, Edge or Brave installed") || noTemp, timeout: 200_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/") {
      const head = '<link rel="alternate" hreflang="es" href="/es/"><link rel="alternate" hreflang="fr" href="/fr/">';
      return res.writeHead(200, html).end(page("Acme | Tools for teams", '<header><a href="/pricing">Pricing</a></header><h1>Acme</h1><div style="height:1400px;background:rgb(0,160,0)"></div>').replace("</head>", `${head}</head>`));
    }
    if (req.url === "/pricing") return res.writeHead(200, html).end(page("Pricing | Acme", '<header><a href="/">Acme</a></header><h1>Pricing</h1><div style="height:1400px;background:rgb(200,0,0)"></div>'));
    if (req.url === "/fr/") return req.socket.destroy();
    res.writeHead(404).end("not found");
  });
  const chrome = await launch();
  try {
    for (const [lang, why] of [["es", /^the page answered 404$/], ["fr", /^could not be opened: net::ERR_[A-Z_]+$/]]) {
      // A tour looks for pages while four minutes of the run are left.
      setTimeLimit(300_000);
      const tour = await pickPages(chrome, `${origin}/`, { pages: 2, lang });
      assert.deepEqual(tour.pages.map((p) => [p.url, p.why]), [[`${origin}/`, "the home page"], [`${origin}/pricing`, 'menu link "Pricing"']], lang);
      const prefix = `The home page names its ${lang} version at ${origin}/${lang}/, which was left out (`;
      const suffix = `), and the home page was taken with ${lang} as the browser's language.`;
      const note = tour.notes.find((text) => text.startsWith(prefix) && text.endsWith(suffix));
      assert.ok(note, `${lang}\n${tour.notes.join("\n")}`);
      assert.match(note.slice(prefix.length, -suffix.length), why, lang);
      assert.deepEqual(tour.skipped, [], lang);
    }
  } finally {
    await chrome.close();
    server.close();
  }
});

// A view that draws late with no request of its own would come in on its
// loading screen: it is recorded once it no longer shows one.
test("a recording of a #route view waits while it shows a loading sign", { skip: missing, timeout: 200_000 }, async () => {
  const { server, origin } = await serve((req, res) => {
    if (req.url !== "/timed/") return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Timed", '<nav><a href="#/one">One</a></nav><h1 id="h">Loading…</h1><div id="band" style="height:800px"></div><script>setTimeout(() => { document.getElementById("h").textContent = "Drawn"; document.getElementById("band").style.background = "rgb(0,160,0)"; document.documentElement.style.background = "rgb(0,160,0)"; }, 8000);</script>', ""));
  });
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /timed/#/one\n  - wait: 0.3\n");
  try {
    await makeDemo(origin, { dir: path.join(root, "out"), steps, gif: false, timeLimit: 150_000 });
    const poster = readPng(path.join(root, "out", "poster.png"));
    assert.ok(near(unzoomed(poster, 800, 500), GREEN), `the first frame: ${unzoomed(poster, 800, 500)}`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a demo of a #route view on a site whose root is a 404, with --pages 1", { skip: missing, timeout: 240_000 }, async () => {
  const { server, origin } = await fixture({ home: HOME_LOST[0][1] });
  const root = tempDir();
  try {
    const { manifest } = await makeDemo(`${origin}/app/#/plants`, { dir: path.join(root, "demo"), pages: 1, gif: false, timeLimit: 200_000 });
    assert.deepEqual(manifest.pages.map((p) => [p.url.slice(origin.length), p.why]), [["/app/#/plants", "the address given"]]);
    assert.deepEqual(manifest.notes.filter((note) => !/slow motion/.test(note)), [`Left out ${origin}/: the page answered 404.`]);
    assert.equal(manifest.site, "Plants");
    assert.deepEqual(fs.readdirSync(path.join(root, "demo")).sort(), ["demo.mp4", "demo.yaml", "poster.png", "steps.json"]);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
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

    // An ffmpeg that exits with 0 and leaves a GIF cut short, as ffmpeg 4
    // does on a full disk.
    const cutting = path.join(root, "ffmpeg-that-cuts");
    fs.writeFileSync(cutting, `#!${process.execPath}\nconst { spawnSync } = require("child_process");\nconst fs = require("fs");\nconst args = process.argv.slice(2);\nconst done = spawnSync(${JSON.stringify(ffmpeg)}, args, { stdio: "inherit" });\nconst last = args[args.length - 1];\nif (last.endsWith(".gif")) fs.truncateSync(last, fs.statSync(last).size - 99);\nprocess.exit(done.status);\n`, { mode: 0o755 });
    const realFfmpeg = process.env.FFMPEG_PATH;
    process.env.FFMPEG_PATH = cutting;
    try {
      await assert.rejects(makeDemo(origin, { dir, steps: good, timeLimit: 100_000 }), /ffmpeg could not write demo\.gif: the file came out cut short/);
    } finally {
      if (realFfmpeg === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = realFfmpeg;
    }
    assert.deepEqual(snapshot(dir), before);

    // A poster that reached the disk cut short does not take the place of
    // the earlier one.
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, data, ...rest) => write(file, /poster\.png$/.test(String(file)) ? data.subarray(0, data.length - 7) : data, ...rest);
    try {
      await assert.rejects(makeDemo(origin, { dir, steps: good, gif: false, timeLimit: 100_000 }), /^Error: poster\.png came out cut short \(the disk, or your disk quota, may be full\), so no demo was saved\.$/);
    } finally {
      fs.writeFileSync = write;
    }
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

// The recording browser killed, or the page's own process killed as the
// system kills one for its memory, while a step waits: no frame comes after
// that. A demo went on, wrote a video of the page standing still (a steps
// file) or cut the tour short (a tour), and replaced the earlier demo.
test("a demo whose browser ends or whose tab crashes in the middle of it fails, and leaves an earlier demo as it was", { skip: missing || (process.platform !== "linux" && "the browser's processes are read from /proc"), timeout: 300_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const steps = path.join(root, "wait.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - wait: 6\n");
  const browser = /The browser ended in the middle of the demo \(it crashed, or was killed\), so no demo was saved\./;
  const tab = /The browser's tab crashed in the middle of the demo, so no demo was saved\./;
  const renderers = (all) => all.filter(({ args }) => /--type=renderer/.test(args));
  // ready: what has to be running before the kill is timed, as a tab that
  // is not there yet cannot crash. delay: from then.
  const cases = [
    // A steps file, the browser killed in its long wait.
    { args: ["--steps", steps], line: /^02 Wait 6 s$/m, delay: 1_000, kill: (all) => all.filter(({ args }) => /--user-data-dir/.test(args) && !/--type=/.test(args)), told: browser },
    // A steps file, the tab's renderer killed in its long wait.
    { args: ["--steps", steps], line: /^02 Wait 6 s$/m, delay: 1_000, kill: (all) => all.filter(({ args }) => /--type=renderer/.test(args)), told: tab },
    // A tour, the browser killed in the wait on its first page: the tour
    // then read no sections and no link, and ended there.
    { args: ["--pages", "1"], line: /^02 Wait 1\.6 s$/m, delay: 300, kill: (all) => all.filter(({ args }) => /--user-data-dir/.test(args) && !/--type=/.test(args)), told: browser },
    // The browser that draws the frames, killed as it starts.
    { args: ["--steps", steps], line: /^Drawing \d+ frames/m, delay: 50, kill: (all) => all.filter(({ args }) => /--user-data-dir/.test(args) && !/--type=/.test(args)), told: browser },
    // The tab that reads the home page for the tour, its page killed: the
    // browser's first page and this tab's.
    { args: ["--pages", "2"], line: /^Opening http/m, ready: (all) => renderers(all).length >= 2, delay: 300, kill: renderers, told: tab },
    // The tabs that draw the frames, their pages killed once a second one
    // is there, so the first has its page.
    { args: ["--steps", steps], line: /^Drawing \d+ frames/m, ready: (all) => renderers(all).length >= 3, delay: 100, kill: renderers, told: tab },
  ];
  try {
    await makeDemo(origin, { dir, steps, gif: false, timeLimit: 200_000 });
    const before = snapshot(dir);
    for (const [i, { args, line, ready, delay, kill, told }] of cases.entries()) {
      const child = spawn(process.execPath, [CLI, "demo", origin, ...args, "--no-gif", "--out", dir]);
      let stderr = "";
      let killed = [];
      let profiles = [];
      let sent = false;
      child.stderr.on("data", (d) => {
        stderr += d;
        if (!sent && line.test(stderr)) {
          sent = true;
          const act = () => {
            const all = descendants(child.pid);
            profiles = [...new Set(all.flatMap(({ args }) => [...args.matchAll(/--user-data-dir=([^\s\0]+)/g)].map((m) => m[1])))];
            killed = kill(all);
            for (const { pid } of killed) process.kill(pid, "SIGKILL");
          };
          const whenReady = () => {
            if (child.exitCode !== null) return;
            if (!ready || ready(descendants(child.pid))) setTimeout(act, delay);
            else setTimeout(whenReady, 30);
          };
          whenReady();
        }
      });
      const status = await new Promise((resolve) => child.on("close", resolve));
      assert.ok(killed.length >= 1, `case ${i}: something to kill\n${stderr}`);
      assert.equal(status, 1, `case ${i}\n${stderr}`);
      assert.match(stderr, told, `case ${i}`);
      assert.deepEqual(snapshot(dir), before, `case ${i}`);
      // Its helpers go on for a moment after a browser is killed, and made
      // the profile again after it was removed.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.ok(profiles.length >= 1, `case ${i}: a profile to look for`);
      for (const profile of profiles) assert.equal(fs.existsSync(profile), false, `case ${i}: ${profile}`);
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The browser that draws the frames stopped as it starts drawing, as one
// that hangs stops answering, whatever call the stop lands in, the opening
// of a window included: the demo fails within half a minute or so, says
// why, ends the browser and leaves an earlier demo as it was.
test("a demo whose browser stops answering as it draws the frames fails, and leaves an earlier demo as it was", { skip: missing || (process.platform !== "linux" && "the browser's processes are read from /proc"), timeout: 300_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "demo");
  const steps = path.join(root, "short.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - wait: 2\n");
  let stopped = [];
  const gone = async (pid) => {
    for (let i = 0; i < 30; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  };
  try {
    await makeDemo(origin, { dir, steps, gif: false, timeLimit: 200_000 });
    const before = snapshot(dir);
    for (const delay of [50, 600]) {
      const child = spawn(process.execPath, [CLI, "demo", origin, "--steps", steps, "--no-gif", "--out", dir]);
      let stderr = "";
      let sent = 0;
      child.stderr.on("data", (d) => {
        stderr += d;
        if (sent || !/^Drawing \d+ frames/m.test(stderr)) return;
        sent = -1;
        setTimeout(() => {
          stopped = descendants(child.pid).filter(({ args }) => /--user-data-dir/.test(args) && !/--type=/.test(args));
          for (const { pid } of stopped) process.kill(pid, "SIGSTOP");
          sent = Date.now();
        }, delay);
      });
      const status = await new Promise((resolve) => child.on("close", resolve));
      const seconds = (Date.now() - sent) / 1000;
      assert.equal(stopped.length, 1, `${delay} ms: the drawing browser to stop\n${stderr}`);
      assert.equal(status, 1, `${delay} ms\n${stderr}`);
      assert.match(stderr, /^easyscreenshotkit demo: The browser stopped answering in the middle of the demo, so no demo was saved\. The machine may be too busy: try again\.$/m);
      assert.ok(seconds < 45, `${delay} ms: ${seconds} s after the stop`);
      assert.deepEqual(snapshot(dir), before, `${delay} ms`);
      for (const { pid } of stopped) assert.ok(await gone(pid), `${delay} ms: the browser is still there`);
      stopped = [];
    }
  } finally {
    // A browser the demo left stopped is ended here.
    for (const { pid } of stopped) {
      for (const signal of ["SIGCONT", "SIGKILL"]) {
        try {
          process.kill(pid, signal);
        } catch {
          // Gone.
        }
      }
    }
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
    if (req.url === "/get") return res.writeHead(302, { Location: "/file.bin" }).end();
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
    const { notes } = JSON.parse(fs.readFileSync(path.join(root, "demo", "steps.json"), "utf8"));
    assert.deepEqual(notes.filter((note) => /download/.test(note)), [`The page started a download of ${origin}/file.bin, which the browser refused: no file was saved.`]);

    // An address that answers with a file is no page to record: a tour
    // leaves it out and says so, and a visit step to one stops the demo,
    // with the demo before it as it was.
    const dir = path.join(root, "demo");
    const before = snapshot(dir);
    const run = (args) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, "demo", ...args], { env });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ code, err }));
      });
    const visit = path.join(root, "visit.yaml");
    fs.writeFileSync(visit, "steps:\n  - visit: /\n  - visit: /get\n");
    const refused = await run([origin, "--steps", visit, "--out", dir, "--no-gif"]);
    assert.equal(refused.code, 1, refused.err);
    assert.match(refused.err, /^easyscreenshotkit demo: step 2 \(visit\): Could not open .*\/get: it answers with a file to download instead of a page\.$/m);
    assert.deepEqual(snapshot(dir), before);
    const tour = await run([origin, "--pages", "2", "--page", "/get", "--no-gif", "--out", path.join(root, "tour")]);
    assert.equal(tour.code, 0, tour.err);
    const toured = JSON.parse(fs.readFileSync(path.join(root, "tour", "steps.json"), "utf8"));
    assert.ok(toured.notes.includes(`Left out ${origin}/get: a file to download instead of a page.`), toured.notes.join("\n"));
    assert.deepEqual(fromTheSite(), []);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A demo's command line run with the machine's programs and the desktop cut
// off: stand-ins on PATH for the programs the browser hands an address of
// another kind to, and for xdg-settings and xdg-mime, which it asks first
// which program opens one, each writing down that it was started; a session
// bus of the test's own with a stand-in for the desktop's portal that
// writes down what it is asked to open (see bus.js), or one where nothing
// listens, never the user's own, which a program given no bus can find in
// XDG_RUNTIME_DIR; and no display. Resolves to { demo(args): the run's
// status, stdout and stderr; node(args): the same for node with args, as a
// script of the test's own; started(): what the stand-ins wrote; opened:
// what the portal was asked; close() }.
async function cutOff(root) {
  const dir = path.join(root, "handlers");
  fs.mkdirSync(dir);
  const log = path.join(root, "started.log");
  for (const name of ["xdg-open", "xdg-email", "x-www-browser", "www-browser", "sensible-browser", "xdg-settings", "xdg-mime", "gio", "kde-open", "gnome-open", "exo-open"]) fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "$0 $*" >> ${sh(log)}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` };
  for (const name of ["DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION", "BROWSER"]) delete env[name];
  const bus = noBus(root) ? null : await privateBus(fs.mkdtempSync(path.join(root, "bus-")));
  const portal = bus ? await fakePortal(bus.address) : null;
  Object.assign(env, bus ? { DBUS_SESSION_BUS_ADDRESS: bus.address, XDG_RUNTIME_DIR: bus.dir, XDG_CURRENT_DESKTOP: "GNOME" } : { DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(root, "no-bus")}`, XDG_RUNTIME_DIR: root });
  // Not spawnSync: this process's server answers the browser.
  const node = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, args, { env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  return {
    demo: (args) => node([CLI, "demo", ...args]),
    node,
    started: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : ""),
    opened: portal ? portal.opened : [],
    close: async () => {
      if (portal) portal.close();
      if (bus) await bus.close();
    },
  };
}

// No click of a demo makes the browser start a program of this machine: a
// click on a mailto: or a news: link, or on a button that opens a window at
// mailto:, had the browser start the user's own mail program, through the
// desktop's portal on the session bus or through xdg-email on PATH, and so
// did a click on a link to a page that redirects to mailto:, which went
// without a note too. The stand-ins on PATH, and the one for the portal on
// a bus of the test's own, write down any start, so no test starts a real
// one (see cutOff).
test("no click of a demo makes the browser start a program of this machine", { skip: missing || (process.platform !== "linux" && "the browser starts these programs through PATH and the session bus on Linux only"), timeout: 200_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/bounce") return res.writeHead(302, { Location: "mailto:bounce@example.com" }).end();
    if (req.url !== "/") return res.writeHead(404).end("not found");
    res.writeHead(200, html).end(page("Contact | Acme", '<h1>Contact</h1><p style="font-size:32px;padding:0 40px"><a href="mailto:sales@example.com?subject=Hello">Write to us</a> <a href="news:comp.lang.c">News</a> <a href="/bounce">Bounce</a> <button onclick="window.open(\'mailto:open@example.com\')">Open a window</button></p><div style="height:1400px;background:rgb(0,160,0)"></div>'));
  });
  const root = tempDir();
  const cut = await cutOff(root);
  const steps = path.join(root, "steps.yaml");
  // The window first: once the browser has handed out an address, it opens
  // no window for the next one, and says nothing of it. A redirect to
  // mailto: is not followed, so it hands out nothing.
  fs.writeFileSync(steps, 'steps:\n  - visit: /\n  - click: "text=Open a window"\n    zoom: false\n  - click: "text=Bounce"\n    zoom: false\n  - click: "text=Write to us"\n    zoom: false\n  - click: "text=News"\n    zoom: false\n  - wait: 1\n');
  try {
    const run = await cut.demo([origin, "--steps", steps, "--no-gif", "--json", "--out", path.join(root, "demo")]);
    assert.equal(run.status, 0, run.stderr);
    const { notes, pages } = JSON.parse(run.stdout);
    for (const note of [
      "The page tried to open mailto:bounce@example.com, which is not a web address: it was not opened, and the page stayed where it was.",
      "The page tried to open mailto:sales@example.com?subject=Hello, which is not a web address: it was not opened, and the page stayed where it was.",
      "The page tried to open news:comp.lang.c, which is not a web address: it was not opened, and the page stayed where it was.",
      "The page tried to open a window at mailto:open@example.com, which is not a web address: it was not opened.",
    ]) {
      assert.ok(notes.includes(note), `${note}\n${notes.join("\n")}`);
    }
    assert.deepEqual(pages.map((p) => p.url), [`${origin}/`]);
    assert.equal(cut.started(), "");
    assert.deepEqual(cut.opened, []);
  } finally {
    await cut.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Some versions of Chrome, 155 among them, take no more input in a tab once
// a page of it tried to open an address of another kind that they ask
// before they open, as tel:: every later click and key did nothing, while
// steps.json listed each as done and the demo ended well without the page
// the next click opens. A demo that meets such a tab stops at the next step
// that needs input and says why; with a version that does not do so, the
// next click opens its page.
test("a demo's click after one on a tel: link opens its page, or the demo says the browser took no more clicks", { skip: missing || (process.platform !== "linux" && "the browser starts these programs through PATH and the session bus on Linux only"), timeout: 200_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/") return res.writeHead(200, html).end(page("Contact | Acme", '<h1>Contact</h1><p style="font-size:32px;padding:0 40px"><a href="tel:+15551234567">Call us</a> <a href="/pricing">Pricing</a></p><div style="height:1400px;background:rgb(0,160,0)"></div>'));
    if (req.url === "/pricing") return res.writeHead(200, html).end(page("Pricing | Acme", '<h1>Pricing</h1><div style="height:1400px;background:rgb(0,0,220)"></div>'));
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const cut = await cutOff(root);
  const steps = path.join(root, "steps.yaml");
  fs.writeFileSync(steps, 'steps:\n  - visit: /\n  - click: "text=Call us"\n    zoom: false\n  - click: "text=Pricing"\n    zoom: false\n  - wait: 1\n');
  try {
    const run = await cut.demo([origin, "--steps", steps, "--no-gif", "--json", "--out", path.join(root, "demo")]);
    if (run.status === 0) {
      const { steps: done, pages } = JSON.parse(run.stdout);
      assert.equal(done[2].opened, `${origin}/pricing`, run.stdout);
      assert.deepEqual(pages.map((p) => p.url), [`${origin}/`, `${origin}/pricing`]);
    } else {
      assert.equal(run.status, 1, run.stderr);
      assert.equal(run.stderr.trim().split("\n").pop(), "easyscreenshotkit demo: step 3 (click): the browser took no more clicks or keys after the page tried to open tel:+15551234567, as some versions of Chrome do. Leave out the step that goes there, or make it the last click or key of the steps.");
      assert.equal(fs.existsSync(path.join(root, "demo")), false);
    }
    assert.equal(cut.started(), "");
    assert.deepEqual(cut.opened, []);
  } finally {
    await cut.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The check that a tab still takes clicks and keys after a page of it tried
// to open an address of another kind moves the real mouse where the page
// itself hears it. A frame, as a map or a video is, takes the moves over it
// in a document of its own: with one under the pointer, as a scroll can
// put it there, the page heard nothing, and a demo whose next click was
// fine stopped after a click on a mailto: link, which leaves the tab as it
// was, with a sentence that blamed the browser. The frames under the
// pointer are set aside for the moment of the check, one of the page's
// process and one of a process of its own (a sandboxed frame) alike, also
// where they cover the whole screen.
const contactPage = (link, frame) => page("Contact | Acme", `<h1>Contact</h1><p style="font-size:32px;padding:0 40px">${link}</p>${frame}<p style="font-size:32px;padding:0 40px"><a href="/pricing">See pricing</a></p><div style="height:1400px;background:rgb(0,160,0)"></div>`);
const mapFrame = (height, sandboxed = false) => `<iframe${sandboxed ? " sandbox" : ""} src="/map" style="display:block;width:100vw;height:${height}px;border:0;margin:0"></iframe>`;
// A frame in a shadow root the page keeps closed, which the page's own
// elementFromPoint gives as its host: an element of its own, as a map's
// is, or a div.
const closedFrame = (tag, frame) => {
  const id = `holder-${tag}`;
  const fill = (el) => `${el}.attachShadow({ mode: "closed" }).innerHTML = ${JSON.stringify(frame)};`;
  if (tag.includes("-")) return `<${tag} style="display:block;width:100vw;height:2400px"></${tag}><script>customElements.define("${tag}", class extends HTMLElement { constructor() { super(); ${fill("this")} } });</script>`;
  return `<${tag} id="${id}" style="display:block;width:100vw;height:2400px"></${tag}><script>${fill(`document.getElementById("${id}")`)}</script>`;
};

test("a demo's click after one on a mailto: link opens its page with a frame under the pointer, and with frames all over the screen", { skip: missing || (process.platform !== "linux" && "the browser starts these programs through PATH and the session bus on Linux only"), timeout: 500_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const write = '<a href="mailto:hello@example.com">Write to us</a>';
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/") return res.writeHead(200, html).end(contactPage(write, mapFrame(900)));
    if (req.url === "/wall") return res.writeHead(200, html).end(contactPage(write, mapFrame(2400)));
    if (req.url === "/boxed") return res.writeHead(200, html).end(contactPage(write, mapFrame(2400, true)));
    if (req.url === "/shadow") return res.writeHead(200, html).end(contactPage(write, closedFrame("x-map", mapFrame(2400))));
    if (req.url === "/shadow-box") return res.writeHead(200, html).end(contactPage(write, closedFrame("div", mapFrame(2400, true))));
    if (req.url === "/map") return res.writeHead(200, html).end(page("Map", '<div style="height:2400px;background:rgb(200,200,255)"></div>'));
    if (req.url === "/pricing") return res.writeHead(200, html).end(page("Pricing | Acme", '<h1>Pricing</h1><div style="height:1400px;background:rgb(0,0,220)"></div>'));
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const cut = await cutOff(root);
  try {
    // The scroll puts the frame under the pointer, which the click on the
    // mailto: link left at the top; on /wall and /boxed the frame then fills
    // the screen, and on /shadow and /shadow-box one in a shadow root that
    // the page keeps closed does.
    for (const [at, by] of [["/", 300], ["/wall", 500], ["/boxed", 500], ["/shadow", 500], ["/shadow-box", 500]]) {
      const steps = path.join(root, `steps-${at.slice(1) || "home"}.yaml`);
      fs.writeFileSync(steps, `steps:\n  - visit: ${at}\n  - click: "text=Write to us"\n    zoom: false\n  - scroll: ${by}\n  - click: "text=See pricing"\n    zoom: false\n  - wait: 1\n`);
      const run = await cut.demo([origin, "--steps", steps, "--no-gif", "--json", "--out", path.join(root, `demo-${at.slice(1) || "home"}`)]);
      assert.equal(run.status, 0, `${at}: ${run.stderr}`);
      const { steps: done, pages, notes } = JSON.parse(run.stdout);
      assert.equal(done[3].opened, `${origin}/pricing`, `${at}: ${run.stdout}`);
      assert.deepEqual(pages.map((p) => p.url), [`${origin}${at}`, `${origin}/pricing`], at);
      assert.ok(notes.includes("The page tried to open mailto:hello@example.com, which is not a web address: it was not opened, and the page stayed where it was."), notes.join("\n"));
    }
    assert.equal(cut.started(), "");
    assert.deepEqual(cut.opened, []);
  } finally {
    await cut.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The same after a click on a tel: link, once a frame fills the screen: the
// check was left out there, as it was where frames covered the whole
// screen, and with a browser that takes no more input after tel:, as Chrome
// 155 and 157 do, the next click did nothing while steps.json listed it as
// done and the demo ended well. The demo now stops at it with its sentence,
// or, with a browser that still takes input, the click opens its page.
test("a demo's click after one on a tel: link opens its page, or the demo says the browser took no more clicks, with frames all over the screen", { skip: missing || (process.platform !== "linux" && "the browser starts these programs through PATH and the session bus on Linux only"), timeout: 450_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const call = '<a href="tel:+15551234567">Call us</a>';
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/wall") return res.writeHead(200, html).end(contactPage(call, mapFrame(2400)));
    if (req.url === "/boxed") return res.writeHead(200, html).end(contactPage(call, mapFrame(2400, true)));
    if (req.url === "/shadow") return res.writeHead(200, html).end(contactPage(call, closedFrame("x-map", mapFrame(2400))));
    if (req.url === "/map") return res.writeHead(200, html).end(page("Map", '<div style="height:2400px;background:rgb(200,200,255)"></div>'));
    if (req.url === "/pricing") return res.writeHead(200, html).end(page("Pricing | Acme", '<h1>Pricing</h1><div style="height:1400px;background:rgb(0,0,220)"></div>'));
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const cut = await cutOff(root);
  try {
    for (const at of ["/wall", "/boxed", "/shadow"]) {
      const steps = path.join(root, `steps-${at.slice(1)}.yaml`);
      fs.writeFileSync(steps, `steps:\n  - visit: ${at}\n  - click: "text=Call us"\n    zoom: false\n  - scroll: 500\n  - click: "text=See pricing"\n    zoom: false\n  - wait: 1\n`);
      const out = path.join(root, `demo-${at.slice(1)}`);
      const run = await cut.demo([origin, "--steps", steps, "--no-gif", "--json", "--out", out]);
      if (run.status === 0) {
        const { steps: done, pages } = JSON.parse(run.stdout);
        assert.equal(done[3].opened, `${origin}/pricing`, `${at}: ${run.stdout}`);
        assert.deepEqual(pages.map((p) => p.url), [`${origin}${at}`, `${origin}/pricing`], at);
      } else {
        assert.equal(run.status, 1, `${at}: ${run.stderr}`);
        assert.equal(run.stderr.trim().split("\n").pop(), "easyscreenshotkit demo: step 4 (click): the browser took no more clicks or keys after the page tried to open tel:+15551234567, as some versions of Chrome do. Leave out the step that goes there, or make it the last click or key of the steps.", at);
        assert.equal(fs.existsSync(out), false, at);
      }
    }
    assert.equal(cut.started(), "");
    assert.deepEqual(cut.opened, []);
  } finally {
    await cut.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The frames set aside for the check get their pointer events back after
// it, also when the page did not answer it in time, as one whose main
// thread is held: they took none for the rest of the page, a map no more
// drags and a video no more clicks. The page's answer is let go here as a
// late one is, after it ran.
test("the check that a demo's tab still takes clicks gives the frames their pointer events back, also when the page did not answer it in time", { skip: missing, timeout: 150_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const write = '<a href="mailto:hello@example.com">Write to us</a>';
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/wall") return res.writeHead(200, html).end(contactPage(write, mapFrame(2400)));
    if (req.url === "/shadow-box") return res.writeHead(200, html).end(contactPage(write, closedFrame("div", mapFrame(2400, true))));
    if (req.url === "/map") return res.writeHead(200, html).end(page("Map", '<div style="height:2400px;background:rgb(200,200,255)"></div>'));
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const { Recorder } = require("../skills/easyscreenshotkit/scripts/lib/record");
  const { guardFor } = require("../skills/easyscreenshotkit/scripts/lib/address");
  setTimeLimit(140_000);
  const chrome = await launch();
  try {
    chrome.guard = await guardFor(`${origin}/`);
    const recorder = new Recorder(chrome, { dir: root, base: `${origin}/` });
    await recorder.open();
    try {
      for (const at of ["/wall", "/shadow-box"]) {
        await recorder.run({ action: "visit", url: at });
        recorder.cursor = { x: 800, y: 600 };
        const tab = recorder.tab;
        // What is under the pointer as the browser routes the mouse: the
        // frame, hit inside or as the element that holds it.
        const hit = async () => {
          const [x, y] = (await tab.send("Runtime.evaluate", { expression: "[scrollX, scrollY]", returnByValue: true })).result.value;
          const at = await tab.send("DOM.getNodeForLocation", { x: 800 + x, y: 600 + y });
          if (at.frameId !== tab.targetId) return "the frame";
          const { node } = await tab.send("DOM.describeNode", { backendNodeId: at.backendNodeId });
          return node.nodeName === "IFRAME" ? "the frame" : node.nodeName;
        };
        assert.equal(await hit(), "the frame", at);
        const style = (await tab.send("Runtime.evaluate", { expression: "String(document.querySelector('iframe') && document.querySelector('iframe').style.cssText)", returnByValue: true })).result.value;
        const real = recorder.eval.bind(recorder);
        recorder.eval = async (expression, timeout) => {
          const value = await real(expression, timeout);
          return /__easyscreenshotkitMoved = false/.test(expression) ? undefined : value;
        };
        try {
          assert.equal(await recorder.inputReaches(), true, at);
        } finally {
          delete recorder.eval;
        }
        assert.equal(await hit(), "the frame", at);
        assert.equal((await tab.send("Runtime.evaluate", { expression: "String(document.querySelector('iframe') && document.querySelector('iframe').style.cssText)", returnByValue: true })).result.value, style, at);
      }
    } finally {
      await recorder.close();
    }
  } finally {
    await chrome.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A redirect to an address of another kind is not followed (see
// guardBrowser() in chrome.js): the browser never sees the address, and the
// tab takes clicks and keys after it as before. So the demo checks that the
// tab still takes them after a page asked the browser to open such an
// address, as a click on a tel: link does, and not after a click on a link
// that redirects to one, where it checked and, on a page it misjudged,
// stopped with a sentence that blamed the browser for an address it was
// never given. The recorder runs in a process cut off from the machine's
// programs, as a demo does (see cutOff).
test("a demo checks the tab after a click on a tel: link, and not after one on a link that redirects to tel:", { skip: missing || (process.platform !== "linux" && "the browser starts these programs through PATH and the session bus on Linux only"), timeout: 120_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/") return res.writeHead(200, html).end(page("Contact | Acme", '<h1>Contact</h1><p style="font-size:32px;padding:0 40px"><a href="/call">Call the office</a> <a href="tel:+15551234567">Call us</a></p><div style="height:1400px;background:rgb(0,160,0)"></div>'));
    if (req.url === "/call") return res.writeHead(302, { Location: "tel:+15550000000" }).end();
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const cut = await cutOff(root);
  const lib = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/lib");
  const frames = path.join(root, "frames");
  fs.mkdirSync(frames);
  // The address of another kind the recorder holds to check the tab by,
  // after each click.
  const script = `
    const { launch } = require(${JSON.stringify(path.join(lib, "chrome"))});
    const { guardFor } = require(${JSON.stringify(path.join(lib, "address"))});
    const { Recorder } = require(${JSON.stringify(path.join(lib, "record"))});
    require(${JSON.stringify(path.join(lib, "time"))}).setTimeLimit(100000);
    (async () => {
      const chrome = await launch();
      const held = [];
      try {
        chrome.guard = await guardFor(${JSON.stringify(`${origin}/`)});
        const recorder = new Recorder(chrome, { dir: ${JSON.stringify(frames)}, base: ${JSON.stringify(`${origin}/`)} });
        await recorder.open();
        await recorder.run({ action: "visit", url: "/" });
        for (const text of ["Call the office", "Call us"]) {
          await recorder.run({ action: "click", target: { text }, zoom: 1 });
          held.push(recorder.outside);
        }
        await recorder.close();
      } finally {
        await chrome.close();
      }
      process.stdout.write(JSON.stringify(held));
    })().catch((err) => {
      console.error(err.stack);
      process.exit(1);
    });`;
  try {
    const run = await cut.node(["-e", script]);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ["", "tel:+15551234567"]);
    assert.equal(cut.started(), "");
    assert.deepEqual(cut.opened, []);
  } finally {
    await cut.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// An input event on its way as the page moves on can go unanswered: Chrome
// drops such an event with the page at times. The demo waited 30 s for the
// answer, and its step failed in the words "Input.dispatchMouseEvent timed
// out": a turn of the wheel as a visit's page is walked, and a press of the
// mouse whose page moves on from inside its mousedown. It lets such a call
// go once the page has moved on, and shows the page that came. The browser
// behind a relay that drops each such answer (see relayBrowser()) makes the
// moments certain: each page moves on from inside the event, and holds its
// main thread a moment after, so the move comes ahead of the answer.
test("a demo goes on when an input event is left unanswered as the page moves on", { skip: missing || (process.platform === "win32" && "the relay is started by a shell script"), timeout: 200_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const hold = "const s = Date.now(); while (Date.now() - s < 300);";
  const tall = '<div style="height:1400px;background:rgb(0,160,0)"></div>';
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/") return res.writeHead(200, html).end(page("Acme | Tools", `<h1>Acme</h1><p style="font-size:32px;padding:0 40px"><button onmousedown='location.replace("/pricing"); ${hold}'>Pricing</button></p>${tall}`));
    if (req.url === "/wheel") return res.writeHead(200, html).end(page("Wheel | Acme", `<h1>Wheel</h1>${tall}<script>addEventListener("wheel", () => { location.replace("/next"); ${hold} }, { passive: false, once: true });</script>`));
    if (req.url === "/next") return res.writeHead(200, html).end(page("Next | Acme", `<h1>Next</h1>${tall}`));
    if (req.url === "/pricing") return res.writeHead(200, html).end(page("Pricing | Acme", `<h1>Pricing</h1>${tall}`));
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const relay = relayBrowser(root, findChrome());
  const steps = path.join(root, "steps.yaml");
  // The page the first visit moved on to is shown a second: with the next
  // visit at once it was on camera for a millisecond or none, and steps.json,
  // which lists the pages a frame shows, listed it or not by chance.
  fs.writeFileSync(steps, 'steps:\n  - visit: /wheel\n  - wait: 1\n  - visit: /\n  - click: "text=Pricing"\n    zoom: false\n  - wait: 1\n');
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, "demo", origin, "--steps", steps, "--no-gif", "--json", "--out", path.join(root, "demo")], { env: { ...process.env, CHROME_PATH: relay.browser } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(relay.dropped(), [`Input.dispatchMouseEvent mouseWheel as the page moved on to ${origin}/next`, `Input.dispatchMouseEvent mousePressed as the page moved on to ${origin}/pricing`]);
    const { pages, steps: done } = JSON.parse(run.stdout);
    assert.deepEqual(pages.map((p) => new URL(p.url).pathname), ["/next", "/", "/pricing"]);
    assert.equal(done[3].opened, `${origin}/pricing`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The same over a frame that runs in a process of its own, as a sandboxed
// one or another site's does: its move to another document never reaches
// the tab's session, and a demo's visit, whose walk turns the wheel over
// it, waited 30 s and failed in the words "Input.dispatchMouseEvent timed
// out". The relay holds each answer a moment and drops the one under way
// as the browser says the frame has moved.
test("a demo goes on when an input event is left unanswered as a frame in a process of its own moves on", { skip: missing || (process.platform === "win32" && "the relay is started by a shell script"), timeout: 200_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/") return res.writeHead(200, html).end(page("Acme | Tools", `<h1>Acme</h1><div style="height:2000px;background:rgb(0,160,0)"></div><iframe sandbox="allow-scripts" src="/ad" style="position:fixed;left:25%;top:25%;width:50%;height:50%;border:0"></iframe>`));
    if (req.url === "/ad") return res.writeHead(200, html).end(page("Ad", `<div style="height:100vh;background:rgb(255,200,0)"></div><script>addEventListener("wheel", () => location.replace("/ad-next"), { once: true });</script>`));
    if (req.url === "/ad-next") return res.writeHead(200, html).end(page("Ad", '<div style="height:100vh;background:rgb(255,120,0)"></div>'));
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const relay = relayBrowser(root, findChrome(), { holdMs: 2_000 });
  const steps = path.join(root, "steps.yaml");
  fs.writeFileSync(steps, "steps:\n  - visit: /\n  - wait: 1\n");
  try {
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, "demo", origin, "--steps", steps, "--no-gif", "--json", "--out", path.join(root, "demo")], { env: { ...process.env, CHROME_PATH: relay.browser } });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(relay.dropped(), [`Input.dispatchMouseEvent mouseWheel as a frame of the page moved on to ${origin}/ad-next`]);
    const { pages } = JSON.parse(run.stdout);
    assert.deepEqual(pages.map((p) => [new URL(p.url).pathname, p.title]), [["/", "Acme | Tools"]]);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A page that thanks for a download and sends the browser to the file once
// it is drawn, from the end of its body, is shown as it is drawn, by a
// click on a link to it and by a visit, with a note that no file was saved,
// where the demo stopped over it.
test("a demo shows a page that thanks for a download as it is drawn, by a click and by a visit", { skip: missing, timeout: 200_000 }, async () => {
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/") return res.writeHead(200, html).end(page("Get it | Acme", '<h1>Get it</h1><p style="font-size:32px;padding:0 40px"><a href="/thanks">Get it for Mac</a></p><div style="height:1400px;background:rgb(0,160,0)"></div>'));
    if (req.url === "/thanks") return res.writeHead(200, html).end(page("Thanks | Acme", '<h1>Thanks for downloading</h1><div style="height:1400px;background:rgb(200,0,0)"></div><script>location.href = "/file.bin";</script>'));
    if (req.url === "/file.bin") return res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="from-the-site.bin"' }).end("bytes");
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  try {
    fs.writeFileSync(steps, 'steps:\n  - visit: /\n  - click: "text=Get it for Mac"\n    zoom: false\n  - wait: 1\n  - visit: /\n  - wait: 0.5\n  - visit: /thanks\n  - wait: 1\n');
    const { manifest } = await makeDemo(origin, { dir: path.join(root, "demo"), steps, gif: false, timeLimit: 180_000 });
    assert.deepEqual(manifest.pages.map((p) => new URL(p.url).pathname), ["/", "/thanks", "/", "/thanks"]);
    assert.equal(manifest.steps[1].opened, `${origin}/thanks`);
    assert.deepEqual(manifest.notes.filter((note) => /download/.test(note)), [`The page started a download of ${origin}/file.bin, which the browser refused: no file was saved.`]);
    for (const shown of [manifest.pages[1], manifest.pages[3]]) {
      const frame = await frameOf(path.join(root, "demo", "demo.mp4"), (shown.start + shown.end) / 2);
      assert.ok(near(unzoomed(frame, 800, 500), RED), `the page drawn: ${unzoomed(frame, 800, 500)}`);
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A demo opens no address on this machine but the host and port it was
// given: not by a visit step, nor by a click on a link, nor by its tour's
// menu, which a site or a steps file could point at the machine's other
// ports, as at the DevTools of another job's browser. A click's page stays
// where it was, as for a download, and the demo says so; a visit step to
// one stops the demo, with the demo before it as it was.
test("a demo opens no other address on this machine than the one it was given", { skip: missing, timeout: 480_000 }, async () => {
  const seen = [];
  const other = await serve((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Inside", "<h1>Inside</h1>"));
  });
  const elsewhere = other.origin;
  const NOT_GIVEN = "not on the public internet, and not on the host and port given";
  const html = { "Content-Type": "text/html; charset=utf-8" };
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/robots.txt") return res.writeHead(200, { "Content-Type": "text/plain" }).end(`User-agent: *\nSitemap: ${elsewhere}/sitemap.xml\n`);
    if (req.url === "/") {
      return res.writeHead(200, html).end(
        page("Acme | Tools", `<header><nav><a href="${elsewhere}/pricing">Pricing</a><a href="/features">Features</a></nav></header><h1>Acme</h1><p style="font-size:32px;padding:0 40px"><a href="${elsewhere}/inside">Go inside</a> <a href="/early">Early access</a></p>${[1, 2, 3, 4, 5, 6].map((n) => `<iframe src="${elsewhere}/framed${n}" style="width:100px;height:60px"></iframe>`).join("")}<div style="height:1400px;background:rgb(0,160,0)"></div>`).replace(
          "</head>",
          `<link rel="alternate" hreflang="de" href="${elsewhere}/de/"></head>`,
        ),
      );
    }
    // A local app sends a visitor who has not signed in to its sign-in
    // server as the page loads.
    if (req.url === "/early" || req.url === "/features") return res.writeHead(200, html).end(page("Early | Acme", "<h1>Early</h1>").replace("</head>", `<script>location.href = "${elsewhere}/login";</script></head>`));
    res.writeHead(404).end("not found");
  });
  const root = tempDir();
  const dir = path.join(root, "demo");
  const run = (args) =>
    new Promise((resolve) => {
      const started = Date.now();
      const child = spawn(process.execPath, [CLI, "demo", ...args]);
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code, err, secs: (Date.now() - started) / 1000 }));
    });
  const early = `Could not open ${origin}/early: it leads to ${elsewhere}/login, which is ${NOT_GIVEN}\\.`;
  try {
    const click = path.join(root, "click.yaml");
    fs.writeFileSync(click, 'steps:\n  - visit: /\n  - click: "text=Go inside"\n    zoom: false\n  - wait: 1\n');
    const clicked = await run([origin, "--steps", click, "--out", dir, "--no-gif"]);
    assert.equal(clicked.code, 0, clicked.err);
    const { notes, pages } = JSON.parse(fs.readFileSync(path.join(dir, "steps.json"), "utf8"));
    // The page's own first, though its six frames were refused before it,
    // then four of the frames, and how many more.
    const tried = notes.filter((note) => /tried to open/.test(note));
    assert.equal(tried[0], `The page tried to open ${elsewhere}/inside, which is ${NOT_GIVEN}: it was not opened, and the page stayed where it was.`, tried.join("\n"));
    for (const note of tried.slice(1, 5)) assert.match(note, new RegExp(`^A frame of the page tried to open ${elsewhere}/framed[1-6], which is ${NOT_GIVEN}: it was not opened\\.$`));
    assert.deepEqual(tried.slice(5), ["The pages, their frames or their windows tried to open 2 more addresses, which were not opened."]);
    assert.deepEqual(pages.map((shown) => shown.url), [`${origin}/`]);

    const before = snapshot(dir);
    const visit = path.join(root, "visit.yaml");
    fs.writeFileSync(visit, `steps:\n  - visit: /\n  - visit: ${elsewhere}/visited\n`);
    const refused = await run([origin, "--steps", visit, "--out", dir, "--no-gif"]);
    assert.equal(refused.code, 1, refused.err);
    assert.match(refused.err, new RegExp(`^easyscreenshotkit demo: step 2 \\(visit\\): Could not open ${elsewhere}/visited: it is ${NOT_GIVEN}\\.$`, "m"));
    assert.deepEqual(snapshot(dir), before);

    // A page that moves on before it has loaded is refused at once, by a
    // visit or by a click, where the demo waited for it and failed 80 s
    // later in a bare protocol message.
    const visitEarly = path.join(root, "visit-early.yaml");
    fs.writeFileSync(visitEarly, "steps:\n  - visit: /\n  - visit: /early\n");
    const visited = await run([origin, "--steps", visitEarly, "--out", dir, "--no-gif"]);
    assert.equal(visited.code, 1, visited.err);
    assert.match(visited.err, new RegExp(`^easyscreenshotkit demo: step 2 \\(visit\\): ${early}$`, "m"));
    assert.ok(visited.secs < 75, `${visited.secs} s`);
    const clickEarly = path.join(root, "click-early.yaml");
    fs.writeFileSync(clickEarly, 'steps:\n  - visit: /\n  - click: "text=Early access"\n    zoom: false\n  - wait: 1\n');
    const followed = await run([origin, "--steps", clickEarly, "--out", dir, "--no-gif"]);
    assert.equal(followed.code, 1, followed.err);
    assert.match(followed.err, new RegExp(`^easyscreenshotkit demo: step 2 \\(click\\): ${early}$`, "m"));
    assert.ok(followed.secs < 75, `${followed.secs} s`);
    assert.deepEqual(snapshot(dir), before);

    const tour = await run([origin, "--pages", "2", "--lang", "de", "--no-gif", "--out", path.join(root, "tour")]);
    assert.equal(tour.code, 0, tour.err);
    const toured = JSON.parse(fs.readFileSync(path.join(root, "tour", "steps.json"), "utf8"));
    for (const note of [
      `Left out ${elsewhere}/pricing: ${NOT_GIVEN}.`,
      `Left out ${origin}/features: it leads to ${elsewhere}/login, which is ${NOT_GIVEN}.`,
      `The home page names its de version at ${elsewhere}/de/, which is ${NOT_GIVEN}: it was not opened, and the home page was taken with de as the browser's language.`,
      `The sitemap ${elsewhere}/sitemap.xml, which robots.txt names, was not read: it is ${NOT_GIVEN}.`,
    ]) {
      assert.ok(toured.notes.includes(note), `${note}\n${toured.notes.join("\n")}`);
    }
    assert.deepEqual(seen, []);
  } finally {
    server.close();
    other.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Names that resolve here as a DNS server answers them, for the run's rule:
// `answers`, by name, an address or an error code.
async function withNames(answers, body) {
  const dns = require("node:dns");
  const lookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (typeof options === "function") [options, callback] = [{}, options];
    const answer = answers[host];
    if (answer === undefined) return lookup(host, options, callback);
    if (!/^\d/.test(answer)) return process.nextTick(callback, Object.assign(new Error(`getaddrinfo ${answer} ${host}`), { code: answer, hostname: host }));
    process.nextTick(callback, null, options && options.all ? [{ address: answer, family: 4 }] : answer, 4);
  };
  try {
    return await body();
  } finally {
    dns.lookup = lookup;
  }
}

// A name the demo cannot look up is not opened, whatever the browser's own
// lookup would answer: not as the address given, by a visit step, or by a
// window a click opens. The demo given one stops before any work.
test("a demo opens no address on a host whose name it cannot look up", { skip: missing, timeout: 200_000 }, () => withNames({ "nowhere.example": "ENOTFOUND" }, async () => {
  const UNRESOLVED = "on a host whose name could not be looked up";
  let port = "";
  const { server, origin } = await serve((req, res) => {
    if (req.url !== "/") return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Acme | Tools", `<h1>Acme</h1><p style="font-size:32px;padding:0 40px"><button onclick="window.open('http://nowhere.example:${port}/window')">Open a window</button></p><div style="height:1400px;background:rgb(0,160,0)"></div>`));
  });
  port = new URL(origin).port;
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  try {
    const given = `http://nowhere.example:${port}/`;
    await assert.rejects(makeDemo(given, { dir: path.join(root, "given"), gif: false, timeLimit: 100_000 }), { message: `Could not open ${given}: it is ${UNRESOLVED} (no such name).` });
    assert.equal(fs.existsSync(path.join(root, "given")), false);
    fs.writeFileSync(steps, 'steps:\n  - visit: /\n  - click: "text=Open a window"\n    zoom: false\n  - wait: 1\n');
    const { manifest } = await makeDemo(origin, { dir: path.join(root, "demo"), steps, gif: false, timeLimit: 150_000 });
    assert.ok(manifest.notes.includes(`The page tried to open a window at http://nowhere.example:${port}/window, which is ${UNRESOLVED}: it was not opened.`), manifest.notes.join("\n"));
    fs.writeFileSync(steps, `steps:\n  - visit: /\n  - visit: http://nowhere.example:${port}/visited\n`);
    await assert.rejects(makeDemo(origin, { dir: path.join(root, "visit"), steps, gif: false, timeLimit: 100_000 }), { message: `step 2 (visit): Could not open http://nowhere.example:${port}/visited: it is ${UNRESOLVED}.` });
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

// Away from the address given a demo opens port 80 and 443 only: a visit
// step, or a window a click opens, on another port of a host on the public
// internet is not opened, and the demo says why, where 0.1.3 opened it. A
// demo given an address MAKERSMCP_REFUSE_ADDRESSES names, or with a setting
// that does not parse, stops before any work.
test("a demo opens no other port than 80 and 443 away from the address given, and no address MAKERSMCP_REFUSE_ADDRESSES names", { skip: missing, timeout: 200_000 }, () => withNames({ "public.example": "93.184.215.14" }, async () => {
  const OTHER_PORT = "on port 8080, not 80 or 443, and not on the scheme, host and port given";
  const { server, origin } = await serve((req, res) => {
    if (req.url !== "/") return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Acme | Tools", `<h1>Acme</h1><p style="font-size:32px;padding:0 40px"><button onclick="window.open('http://public.example:8080/window')">Open a window</button></p><div style="height:1400px;background:rgb(0,160,0)"></div>`));
  });
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  const saved = process.env.MAKERSMCP_REFUSE_ADDRESSES;
  const savedFfmpeg = process.env.FFMPEG_PATH;
  try {
    fs.writeFileSync(steps, 'steps:\n  - visit: /\n  - click: "text=Open a window"\n    zoom: false\n  - wait: 1\n');
    const { manifest } = await makeDemo(origin, { dir: path.join(root, "demo"), steps, gif: false, timeLimit: 150_000 });
    assert.ok(manifest.notes.includes(`The page tried to open a window at http://public.example:8080/window, which is ${OTHER_PORT}: it was not opened.`), manifest.notes.join("\n"));
    fs.writeFileSync(steps, "steps:\n  - visit: /\n  - visit: http://public.example:8080/visited\n");
    await assert.rejects(makeDemo(origin, { dir: path.join(root, "visit"), steps, gif: false, timeLimit: 100_000 }), { message: `step 2 (visit): Could not open http://public.example:8080/visited: it is ${OTHER_PORT}.` });
    process.env.MAKERSMCP_REFUSE_ADDRESSES = "127.0.0.1";
    await assert.rejects(makeDemo(origin, { dir: path.join(root, "refused"), pages: 1, gif: false, timeLimit: 100_000 }), { message: `Could not open ${origin}/: it is at 127.0.0.1, an address MAKERSMCP_REFUSE_ADDRESSES refuses.` });
    assert.equal(fs.existsSync(path.join(root, "refused")), false);
    process.env.MAKERSMCP_REFUSE_ADDRESSES = "127.0.0.1;10.0.0.1";
    const unread = 'MAKERSMCP_REFUSE_ADDRESSES takes IP addresses and CIDR ranges, separated by commas, such as 192.0.2.7,198.51.100.0/24, and "127.0.0.1;10.0.0.1" is neither. Correct it, or leave it empty to refuse no more addresses.';
    await assert.rejects(makeDemo(origin, { dir: path.join(root, "unread"), pages: 1, gif: false, timeLimit: 100_000 }), { message: unread });
    assert.equal(fs.existsSync(path.join(root, "unread")), false);
    // Before ffmpeg is looked at too.
    process.env.FFMPEG_PATH = path.join(root, "no-ffmpeg");
    await assert.rejects(makeDemo(origin, { dir: path.join(root, "unread"), pages: 1, gif: false, timeLimit: 100_000 }), { message: unread });
  } finally {
    if (saved === undefined) delete process.env.MAKERSMCP_REFUSE_ADDRESSES;
    else process.env.MAKERSMCP_REFUSE_ADDRESSES = saved;
    if (savedFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = savedFfmpeg;
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}));

// The demo's browser preloads nothing: a click on a link to a page a
// speculation rule of the site had the browser prefetch, at another port of
// this machine, was served from that copy, the browser's interception never
// held it, and the demo recorded that program's page as the site's. And it
// connected to the address of a link under the pointer and of a click
// before the demo had judged it, though the page stayed where it was. Here
// the other program sees no request and no connection, and each click
// leaves the page where it is, with a note.
test("a demo's click opens no address the run does not open that a page had the browser preload, and the browser connects to none for a link it hovers or clicks", { skip: missing, timeout: 200_000 }, async () => {
  const seen = [];
  let connections = 0;
  const other = await serve((req, res) => {
    seen.push(`${req.url} ${req.headers["sec-purpose"] || ""}`.trim());
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Admin", "<h1>Admin</h1>"));
  });
  other.server.on("connection", () => connections++);
  const fetched = `${other.origin}/admin`;
  const away = `${other.origin}/away`;
  const { server, origin } = await serve((req, res) => {
    if (req.url !== "/") return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      page(
        "Acme | Tools",
        `<h1>Acme</h1><script type="speculationrules">{"prefetch":[{"source":"list","urls":[${JSON.stringify(fetched)}]}]}</script><p style="font-size:32px;padding:0 40px"><a id="go" href="${fetched}">Admin</a> <a id="away" href="${away}">Away</a></p><div style="height:1400px;background:rgb(0,160,0)"></div>`,
      ),
    );
  });
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  try {
    fs.writeFileSync(steps, 'steps:\n  - visit: /\n  - wait: 3\n  - click: "#go"\n    zoom: false\n  - wait: 1\n  - hover: "#away"\n    zoom: false\n  - wait: 1\n  - click: "#away"\n    zoom: false\n  - wait: 1\n');
    const { manifest } = await makeDemo(origin, { dir: path.join(root, "demo"), steps, gif: false, timeLimit: 180_000 });
    const why = "not on the public internet, and not on the host and port given";
    for (const url of [fetched, away]) assert.ok(manifest.notes.includes(`The page tried to open ${url}, which is ${why}: it was not opened, and the page stayed where it was.`), manifest.notes.join("\n"));
    assert.deepEqual(manifest.pages.map((p) => p.url), [`${origin}/`]);
    assert.deepEqual(seen, []);
    assert.equal(connections, 0, "connections to the other program");
  } finally {
    server.close();
    other.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A steps file's hide is held to the rule --hide is: a selector that could
// reach past its own rule in the page, as one opening a comment that the
// next closes in a quote, stops the demo as the file is read, before any
// work, where the text between them became rules of their own that had
// the page ask another program of this machine for a picture. A selector
// the browser does not read hides nothing, and the notes name it.
test("a steps file's hide refuses a selector that could reach past its rule before any work, and one the browser does not read is named in the notes", { skip: missing, timeout: 200_000 }, async () => {
  const seen = [];
  const other = await serve((req, res) => {
    seen.push(req.url);
    res.writeHead(404).end();
  });
  const { server, origin } = await serve((req, res) => {
    if (req.url !== "/") return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Acme | Tools", '<h1>Acme</h1><p class="promo" style="height:80px;background:rgb(200,0,0)">Sale</p><div style="height:1400px;background:rgb(0,160,0)"></div>'));
  });
  const root = tempDir();
  const steps = path.join(root, "steps.yaml");
  try {
    fs.writeFileSync(steps, `hide:\n  - "x-none /*"\n  - ${JSON.stringify(`[a="*/x-none{} *{background-image:url(${other.origin}/x.png)} [b="]`)}\nsteps:\n  - visit: /\n  - wait: 1\n`);
    await assert.rejects(makeDemo(origin, { dir: path.join(root, "refused"), steps, gif: false, timeLimit: 100_000 }), { message: 'steps.yaml: hide takes CSS selectors, and "x-none /*" is not one: it holds a comment' });
    assert.equal(fs.existsSync(path.join(root, "refused")), false);
    fs.writeFileSync(steps, 'hide:\n  - "div:nope"\n  - ".promo"\nsteps:\n  - visit: /\n  - wait: 1\n');
    const { manifest } = await makeDemo(origin, { dir: path.join(root, "demo"), steps, gif: false, timeLimit: 150_000 });
    assert.deepEqual(manifest.notes.filter((note) => /to hide/.test(note)), ['The selector "div:nope" to hide hid nothing: the browser does not read it as a CSS selector.']);
    assert.deepEqual(seen, []);
  } finally {
    server.close();
    other.server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A demo of an address written without a scheme, which a plain http server
// answers, says to give http://, as the screenshots do.
test("a demo of an address with no scheme that a plain http server answers says to give http://", { skip: missing, timeout: 120_000 }, async () => {
  const { server, origin } = await serve((req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(page("Dev", "<h1>Dev</h1>")));
  const port = new URL(origin).port;
  const root = tempDir();
  try {
    await assert.rejects(makeDemo(`localhost:${port}`, { dir: path.join(root, "demo"), pages: 1, gif: false, timeLimit: 100_000 }), { message: `Could not open https://localhost:${port}/: net::ERR_SSL_PROTOCOL_ERROR. An address written without a scheme is read as https://, and http://localhost:${port}/ is the one to give if the site has no https.` });
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
