"use strict";

// ffmpeg, the one already on the machine, for the two encodings a demo
// needs: the drawn frames into an H.264 MP4, and the MP4 into a GIF small
// enough for a README. Nothing is downloaded.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const programs = require("./programs");
const { timeLeft } = require("./time");

// Where package managers put it, for an agent or app whose PATH is short.
const PLACES = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/snap/bin/ffmpeg"];

const INSTALL = "brew install ffmpeg, sudo apt install ffmpeg, winget install ffmpeg";
const NEEDED = "The demo needs ffmpeg";
// Written out whole: a tool that runs the kit holds what it says it refuses
// with to the words of its code, as makersmcp does.
const MISSING = "The demo needs ffmpeg, and none was found. Install it (brew install ffmpeg, sudo apt install ffmpeg, winget install ffmpeg) or point FFMPEG_PATH at it.";

// How to get an ffmpeg that runs, for one FFMPEG_PATH names and for one
// found on the machine.
const FIX = {
  FFMPEG_PATH: "Point FFMPEG_PATH at an ffmpeg that runs, or unset it to use the one on PATH.",
  found: `Install ffmpeg (${INSTALL}), or point FFMPEG_PATH at one that runs.`,
};

// Where this run's ffmpeg is: { name, file, variable, value, where, fix,
// problem } (see programs.js), or null where there is none. FFMPEG_PATH is
// a path, taken from the folder the run starts in, or a name looked up on
// PATH. Else the first ffmpeg on PATH this user may run, or the first thing
// by that name there, to say what is wrong with it, and only where PATH has
// nothing by that name, the one where a package manager puts it. An
// FFMPEG_PATH that names the ffmpeg the run finds with it unset, as one a
// tool sets to what it found does, is told to install another: unset, it
// gives the same one.
function ffmpegPlace() {
  const named = programs.named("FFMPEG_PATH", { name: "ffmpeg", fix: FIX.FFMPEG_PATH });
  return named ? programs.orInstall(named, onMachine(), FIX.found) : onMachine();
}

// The ffmpeg the run finds with FFMPEG_PATH unset.
function onMachine() {
  const seen = programs.lookOnPath(programs.exe("ffmpeg"));
  const where = { name: "ffmpeg", where: "on PATH", fix: FIX.found };
  if (seen.file || seen.other) return programs.found(seen.file || seen.other, where);
  if (process.platform === "win32") return null;
  const file = PLACES.find((at) => programs.runnable(at));
  return file ? programs.found(file, { ...where, where: `in ${path.dirname(file)}` }) : null;
}

function findFfmpeg() {
  const place = ffmpegPlace();
  return place && !place.problem ? place.file : "";
}

// The ffmpeg a demo encodes with, before any work: one that is there and
// that this user may run, asked its version, so that one that cannot be
// started, or is no ffmpeg, stops the demo with what is wrong with it, where
// it ended in the system's words, as spawn /opt/ffmpeg EACCES, or said that
// it had no H.264 encoder. It has VERSION_MS to answer, two minutes, as the
// other kits give it, and as long again to list its encoders (see
// pickEncoder()): on a machine too busy or short of memory even one that
// works can take long, and one that gives no answer in that time is said to
// have given none, with the advice to run again. It had a minute to say its
// version and was then said to have been stopped as it started (SIGKILL),
// and 20 s to list its encoders and was then said to have no H.264 encoder,
// each with the advice to get another. Each wait ends with the run's own
// time (--timeout) too, and one that it cuts short says that time ran out,
// and to give more: a demo given a minute waited out the two minutes past
// it, then failed in words about the recording. limit: for a test.
const VERSION_MS = 120_000;

// How long ffmpeg is waited for: `limit`, or what is left of the run's time
// when that is less (cut).
function waitFor(limit) {
  const left = Math.floor(timeLeft());
  return left < limit ? { ms: Math.max(1, left), cut: true } : { ms: limit, cut: false };
}

// The error for an ffmpeg, found at `place`, that gave no answer when asked
// `what` in the wait it had: `limit` ms, or what was left of the run's time.
function late(place, what, limit, wait) {
  if (wait.cut) return new Error(`time ran out while ffmpeg was asked ${what}; give more with --timeout`);
  const time = limit === VERSION_MS ? "two minutes" : `${limit / 1000} s`;
  return new Error(`${NEEDED}, and ${programs.told(place, `a program that gave no answer in ${time} when asked ${what}, as even one that works can on a machine too busy or short of memory`, { fix: false })} Run the demo again.`);
}

async function ffmpegReady(limit = VERSION_MS) {
  const place = ffmpegPlace();
  if (!place) throw new Error(MISSING);
  if (place.problem) throw new Error(`${NEEDED}, and ${programs.told(place, place.problem)}`);
  programs.remember(place);
  const wait = waitFor(limit);
  let result;
  try {
    result = await run(place.file, ["-hide_banner", "-version"], { timeout: wait.ms });
  } catch (err) {
    if (programs.SHORT[err.code]) throw new Error(`${NEEDED}, and ${place.file} could not be started: ${programs.SHORT[err.code]}.`);
    throw new Error(`${NEEDED}, and ${programs.told(place, programs.explain(place.file, { error: err }))}`);
  }
  if (result.late) throw late(place, "its version", limit, wait);
  if (!result.signal && result.code === 0 && /^ffmpeg version \S/m.test(result.stdout)) return place.file;
  // A file that is no program of this system, as a text file with no #!
  // line the shell ran to its end, is said to be what it is.
  const what = programs.whatItIs(programs.kindOf(place.file)) || programs.explain(place.file, result, { none: 'a program that printed no "ffmpeg version" line when asked its version, so it is not ffmpeg' });
  throw new Error(`${NEEDED}, and ${programs.told(place, what)}`);
}

// The ffmpeg processes this process has going, for a stop to kill.
const children = new Set();

function track(child) {
  children.add(child);
  const done = () => children.delete(child);
  child.on("close", done);
  child.on("error", done);
  return child;
}

// Kills every ffmpeg still going, at once. Returns how many there were.
function killChildren() {
  const count = children.size;
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Gone already.
    }
  }
  children.clear();
  return count;
}

// Runs ffmpeg to its end: { code, signal, stdout, stderr }, and late when
// it was still running after `timeout` ms and was killed. A program that a
// wrapper script started and left running can hold the output open after
// the script itself has ended: what was read is taken EXIT_GRACE_MS after
// the end, or once `timeout` ms are up if that comes first, and the leftover
// is not waited on. It was, whenever the script ended before the limit, and
// a script that had answered at once was then said to have given no answer
// in that time, or held the demo for as long as its leftover ran. The
// output is let go of then, so the leftover does not hold the run's own
// process either.
const EXIT_GRACE_MS = 1_000;

function run(binary, args, { timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }));
    let stdout = "";
    let stderr = "";
    let late = false;
    // { code, signal } once the program itself has ended.
    let ended = null;
    let grace = null;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      // The result taken, the pipes go: a leftover holding them kept the
      // run's process from exiting until it ended, the run over.
      for (const stream of [child.stdout, child.stderr]) if (stream) stream.destroy();
      resolve(result);
    };
    // With no file descriptor left for them Node makes no pipes, and the
    // error that says why comes a moment later.
    if (child.stdout) child.stdout.on("data", (d) => (stdout += d));
    if (child.stderr) child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
    const timer = setTimeout(() => {
      if (ended) return done({ ...ended, stdout, stderr });
      late = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      ended = { code, signal };
      if (late) return done({ code, signal, stdout, stderr, late });
      grace = setTimeout(() => done({ code, signal, stdout, stderr }), EXIT_GRACE_MS);
    });
    child.on("close", (code, signal) => done({ ...(ended || { code, signal }), stdout, stderr, ...(late ? { late } : {}) }));
  });
}

// What ffmpeg said last. ffmpeg 4 can end on a line with no reason in it
// ("Error initializing output stream 0:0 --"), the reason being on the line
// before.
function lastLine(text) {
  const lines = String(text).trim().split("\n").filter(Boolean);
  const last = lines[lines.length - 1];
  return (/--$/.test(last || "") && lines[lines.length - 2]) || last || "no message";
}

// ffmpeg 4 only logs a file it could not finish, on a full disk as it
// writes the end of the file, and exits with 0: -xerror makes it fail, and
// the file itself is read before a run counts it as made.
const CUT_SHORT = "the file came out cut short (the disk, or your disk quota, may be full)";

// Whether data is a whole GIF, block by block: its blocks lead up to the
// trailer that ends the file. A GIF cut anywhere has none there.
function gifIsWhole(data) {
  if (data.length < 13 || !/^GIF8[79]a$/.test(data.toString("latin1", 0, 6))) return false;
  let at = 13;
  if (data[10] & 0x80) at += 3 << ((data[10] & 7) + 1);
  const subBlocks = () => {
    for (;;) {
      if (at >= data.length) return false;
      const size = data[at++];
      if (!size) return true;
      at += size;
    }
  };
  for (;;) {
    if (at >= data.length) return false;
    const kind = data[at++];
    if (kind === 0x3b) return at === data.length;
    if (kind === 0x21) {
      at++;
      if (!subBlocks()) return false;
    } else if (kind === 0x2c) {
      if (at + 9 > data.length) return false;
      const flags = data[at + 8];
      at += 9;
      if (flags & 0x80) at += 3 << ((flags & 7) + 1);
      at++;
      if (!subBlocks()) return false;
    } else return false;
  }
}

// The contents of the first box of that type among the boxes in data, or
// null.
function boxIn(data, type) {
  for (let at = 0; at + 8 <= data.length; ) {
    const length = data.readUInt32BE(at);
    if (length < 8 || at + length > data.length) return null;
    if (data.toString("latin1", at + 4, at + 8) === type) return data.subarray(at + 8, at + length);
    at += length;
  }
  return null;
}

// The frames an MP4's index says it holds, the first track's, or 0 for a
// file that is cut short or has no index: its boxes run exactly to its end,
// and one of them is the index, which ffmpeg writes last.
function mp4Frames(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const { size } = fs.fstatSync(fd);
    const read = (at, length) => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, at));
    };
    let moov = null;
    for (let at = 0; at < size; ) {
      const head = read(at, 16);
      if (head.length < 8) return 0;
      let length = head.readUInt32BE(0);
      let skip = 8;
      if (length === 1) {
        if (head.length < 16) return 0;
        length = Number(head.readBigUInt64BE(8));
        skip = 16;
      } else if (length === 0) length = size - at;
      if (length < skip || at + length > size) return 0;
      if (head.toString("latin1", 4, 8) === "moov") moov = read(at + skip, length - skip);
      at += length;
    }
    let inside = moov;
    for (const type of ["trak", "mdia", "minf", "stbl", "stsz"]) inside = inside && boxIn(inside, type);
    return inside && inside.length >= 12 ? inside.readUInt32BE(8) : 0;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// The H.264 encoder this ffmpeg has, best first: x264 where it is built in
// (Homebrew, most Linux packages), the Mac's own, then Cisco's and
// Windows' own. No B-frames: with them the file starts two frames late
// behind an edit list, and a tool that reads frames without it would be
// two frames off steps.json. Without them the file is about 6% bigger.
async function pickEncoder(binary, limit = VERSION_MS) {
  const wait = waitFor(limit);
  const { stdout, late: slow } = await run(binary, ["-hide_banner", "-encoders"], { timeout: wait.ms });
  if (slow) throw late(programs.places.get(binary) || { name: "ffmpeg", file: binary, where: "", fix: "" }, "its encoders", limit, wait);
  const has = (name) => new RegExp(`^\\s*V\\S*\\s+${name}\\s`, "m").test(stdout);
  if (has("libx264")) return { name: "libx264", args: ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-bf", "0"] };
  if (has("h264_videotoolbox")) return { name: "h264_videotoolbox", args: ["-c:v", "h264_videotoolbox", "-b:v", "14M", "-profile:v", "high", "-bf", "0"] };
  if (has("libopenh264")) return { name: "libopenh264", args: ["-c:v", "libopenh264", "-b:v", "14M"] };
  if (has("h264_mf")) return { name: "h264_mf", args: ["-c:v", "h264_mf", "-b:v", "14M"] };
  return null;
}

// An MP4 written from JPEG frames piped in one after the other. The frames
// are sRGB; the video is tagged BT.709, which players expect of HD.
// Returns {write(buffer), end()}; both wait for ffmpeg.
function startVideo(binary, file, { fps, encoder, title = "" }) {
  const child = track(spawn(
    binary,
    [
      "-hide_banner", "-loglevel", "error", "-xerror", "-y",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-vf", "scale=in_range=full:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709,format=yuv420p",
      ...encoder.args,
      "-r", String(fps),
      "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
      "-movflags", "+faststart",
      ...(title ? ["-metadata", `title=${title}`] : []),
      "-metadata", "comment=Recorded with easyscreenshotkit",
      file,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  ));
  let stderr = "";
  let failed = null;
  let written = 0;
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
  const closed = new Promise((resolve) => {
    child.on("error", (err) => {
      failed = err;
      resolve(-1);
    });
    child.on("close", resolve);
  });
  child.stdin.on("error", () => {});
  return {
    async write(buffer) {
      if (failed || child.exitCode !== null || child.signalCode !== null) throw new Error(`ffmpeg stopped: ${failed ? failed.message : lastLine(stderr)}`);
      written++;
      // An ffmpeg that stops while its input is full never drains it.
      if (!child.stdin.write(buffer)) await Promise.race([new Promise((resolve) => child.stdin.once("drain", resolve)), closed]);
    },
    async end() {
      child.stdin.end();
      const code = await closed;
      if (code !== 0) throw new Error(`ffmpeg could not write ${path.basename(file)}: ${failed ? failed.message : lastLine(stderr)}`);
      if (mp4Frames(file) !== written) throw new Error(`ffmpeg could not write ${path.basename(file)}: ${CUT_SHORT}`);
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
}

// The GIF: the MP4 made smaller step by step (width, then frames a second)
// until it fits the budget, 8 MB by default: GitHub shows bigger ones, but
// a README loads slowly with them. One palette for the whole video, a fine
// ordered dither (a gradient does not band, and it compresses better than
// error diffusion), and only the part of each frame that changed stored.
const GIF_TRIES = [
  { width: 960, fps: 12 },
  { width: 800, fps: 12 },
  { width: 800, fps: 10 },
  { width: 720, fps: 10 },
  { width: 640, fps: 10 },
  { width: 560, fps: 8 },
  { width: 480, fps: 8 },
];

// The palette is a PNG file of its own, written as one picture and read
// back as one: ffmpeg otherwise reads a % in its path as a frame number
// (frame%03d.png), so a folder named like "run%dx", with a d or a digit
// after its %, failed the GIF with any ffmpeg, and ffmpeg 4 failed under
// any % ("Q3 100%") and wrote the palette outside the folder, at the path
// cut short at its %.
async function makeGif(binary, video, file, { budget = 8 * 1024 * 1024, dir }) {
  const palette = path.join(dir, "palette.png");
  let last = null;
  try {
    for (const { width, fps } of GIF_TRIES) {
      const scale = `fps=${fps},scale=${width}:-2:flags=lanczos`;
      const made = await run(binary, ["-hide_banner", "-loglevel", "error", "-xerror", "-y", "-i", video, "-vf", `${scale},palettegen=max_colors=256:stats_mode=full`, "-update", "1", palette]);
      if (made.code !== 0) throw new Error(`ffmpeg could not make the GIF's palette: ${lastLine(made.stderr)}`);
      const gif = await run(binary, ["-hide_banner", "-loglevel", "error", "-xerror", "-y", "-i", video, "-f", "png_pipe", "-i", palette, "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, "-loop", "0", file]);
      if (gif.code !== 0) throw new Error(`ffmpeg could not write ${path.basename(file)}: ${lastLine(gif.stderr)}`);
      const data = fs.readFileSync(file);
      if (!gifIsWhole(data)) throw new Error(`ffmpeg could not write ${path.basename(file)}: ${CUT_SHORT}`);
      last = { width: data.readUInt16LE(6), height: data.readUInt16LE(8), fps, bytes: data.length };
      if (last.bytes <= budget) return last;
    }
    return { ...last, overBudget: true };
  } finally {
    fs.rmSync(palette, { force: true });
  }
}

module.exports = { findFfmpeg, ffmpegReady, pickEncoder, startVideo, makeGif, gifIsWhole, mp4Frames, run, killChildren, MISSING, GIF_TRIES, VERSION_MS };
