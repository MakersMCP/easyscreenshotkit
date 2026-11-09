"use strict";

// ffmpeg, the one already on the machine, for the two encodings a demo
// needs: the drawn frames into an H.264 MP4, and the MP4 into a GIF small
// enough for a README. Nothing is downloaded.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { onPath } = require("./chrome");

// Where package managers put it, for an agent or app whose PATH is short.
const PLACES = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/snap/bin/ffmpeg"];

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return fs.existsSync(process.env.FFMPEG_PATH) ? process.env.FFMPEG_PATH : "";
  const found = onPath(process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (found) return found;
  return process.platform === "win32" ? "" : PLACES.find((file) => fs.existsSync(file)) || "";
}

const MISSING = "The demo needs ffmpeg, and none was found. Install it (brew install ffmpeg, sudo apt install ffmpeg, winget install ffmpeg) or point FFMPEG_PATH at it.";

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

function run(binary, args, { timeout = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-20_000)));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const lastLine = (text) => String(text).trim().split("\n").filter(Boolean).slice(-1)[0] || "no message";

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
async function pickEncoder(binary) {
  const { stdout } = await run(binary, ["-hide_banner", "-encoders"], { timeout: 20_000 });
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

module.exports = { findFfmpeg, pickEncoder, startVideo, makeGif, gifIsWhole, mp4Frames, run, killChildren, MISSING, GIF_TRIES };
