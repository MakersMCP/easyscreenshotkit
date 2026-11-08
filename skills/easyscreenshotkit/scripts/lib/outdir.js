"use strict";

// The folder a run saves in, and what a run that does not end well leaves
// there: what was there before, and nothing more.
//
// A run builds its files in a part folder inside the folder it saves in,
// .easyscreenshotkit-part-<pid>-<8 hex digits>, so they are on that disk
// and get the access its default ACL gives, as files written there directly
// would. Once the run has ended well, commit() puts them in place: the
// earlier run's files go aside into the part folder, the new ones come in,
// and the new manifest (manifest.json, or steps.json for a demo) takes the
// place of the old one in one rename, last. Only then do the earlier files
// go, with the part folder. So at no moment is the folder without a
// manifest, or without the files of one run or the other. A run that fails,
// is refused or is stopped removes its part folder and leaves the rest as
// it was. commit() is synchronous: Node runs a signal's handler between two
// synchronous steps, never in the middle of one.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { killBrowsers, removeProfiles } = require("./chrome");
const { killChildren } = require("./ffmpeg");

// A run's part folder, named by the process that made it.
const PART = /^\.easyscreenshotkit-part-(\d+)-[0-9a-f]{8}$/;
// A run killed outright (kill -9) cannot remove its part folder. A later run
// that ends well in that folder removes it once its process is gone and
// nothing in it has changed for this long: longer than a run can take, so a
// run on another machine or in a container, whose process this machine does
// not see, keeps its own while it works in a shared folder.
const STALE = 30 * 60 * 1000;

// What is at a path, or undefined when nothing is (a file where a folder of
// the path should be included).
const lstat = (at) => {
  try {
    return fs.lstatSync(at, { throwIfNoEntry: false });
  } catch (err) {
    if (err.code === "ENOTDIR") return undefined;
    throw err;
  }
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// The runs of this process that have begun and not ended.
const live = new Set();
// The folder the last run that ended well saved in.
let saved = "";
let hooked = false;

// Opens a run in dir, which is made when it is missing. spec says what the
// run saves there:
//   marker    the manifest that marks the folder as a run's, put in place last
//   accepts   whether a marker read from the folder is an earlier run's
//   refusal   the error for a folder that holds anything else
//   earlier   the earlier run's files in the folder, as paths inside it
//   ignore    names in the folder that do not count, (name, folder) => bool
//   files     names the run saves as files, refused when they are folders
//   folders   names the run saves as folders, refused when they are files
//   claim     more checks before the run starts, (dir, folder) => void
//   tidy      folders to remove once a run that ended well left them empty
//   leftovers names of an older version's leftovers, removed once stale
// Returns the run: file(rel) is where a file of it is written, write(rel,
// data) writes one, commit(outputs) puts them in place, abort() takes them
// away and told(err) names, in what went wrong, the folder instead of the
// part folder. Until commit(), the run's part folder is all it adds to the
// folder.
function begin(dir, spec) {
  const target = path.resolve(dir);
  // The folders made for the run, deepest first, removed again when it
  // does not end well.
  const made = toMake(target);
  let part = "";
  try {
    makeFolder(dir, target);
    check(dir, target, spec);
    claim(dir, target, spec);
    // mkdirSync and not mkdtempSync: under a default ACL the part folder
    // gets the access the out folder gives, where mkdtemp's 0700 would shut
    // out the others the ACL lets in.
    part = path.join(target, `.easyscreenshotkit-part-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      fs.mkdirSync(part);
    } catch (err) {
      if (!refused(err)) throw err;
      throw new Error(`${dir} cannot be written to: ${refused(err)}. Pick another folder with --out.`);
    }
  } catch (err) {
    removeMade(made);
    throw err;
  }
  const run = { dir, target, part, spec, made, existed: made.length === 0, ended: false };
  run.file = (rel) => path.join(part, rel);
  run.write = (rel, data) => write(run, rel, data);
  run.commit = (outputs) => commit(run, outputs);
  run.abort = () => abort(run);
  run.told = (err) => told(run, err);
  live.add(run);
  if (!hooked) {
    hooked = true;
    // However the process ends, a run that has not ended leaves no part
    // folder, and no browser or ffmpeg of it runs on.
    process.on("exit", () => stopAll());
  }
  return run;
}

// The folders that are not there yet on the way to target, deepest first:
// up to the first one that is there, or to the root of its disk, which
// cannot be made. On Windows a drive or a network share that is not there
// (E:\ with no E: drive) is such a root.
function toMake(target, { exists = fs.existsSync, paths = path } = {}) {
  const missing = [];
  for (let at = target; !exists(at); at = paths.dirname(at)) {
    if (paths.dirname(at) === at) break;
    missing.push(at);
  }
  return missing;
}

// Why the disk refuses a folder made in a place, as a person says it. A
// full quota comes from Node as UNKNOWN (errno -122) on Linux.
const REFUSED = {
  EACCES: "permission to write there is denied",
  EPERM: "permission to write there is denied",
  EROFS: "its disk is read-only",
  ENOSPC: "the disk is full",
  EDQUOT: "your disk quota is full",
};
const refused = (err) => REFUSED[err.errno === -122 ? "EDQUOT" : err.code];

// Makes the folder a run saves in, with the folders above it.
function makeFolder(dir, target) {
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    const root = path.parse(target).root;
    if (err.code === "ENOENT" && root && !fs.existsSync(root)) throw new Error(`${dir} cannot be made: ${root} is not there. Check the drive, or pick another folder with --out.`);
    // A link that leads nowhere fails as ENOENT.
    const file = ["EEXIST", "ENOTDIR", "ENOENT"].includes(err.code) && inTheWay(target);
    if (file) throw new Error(notAFolder(dir, target, file));
    if (refused(err)) throw new Error(`${dir} cannot be made: ${refused(err)}. Pick another folder with --out.`);
    throw err;
  }
}

// What stands where the folder a run saves in, or a folder above it, has
// to be: the first path on the way that is there and is no folder, with
// what it is, or null.
function inTheWay(target) {
  const way = [];
  for (let at = target; ; at = path.dirname(at)) {
    way.unshift(at);
    if (path.dirname(at) === at) break;
  }
  for (const at of way) {
    const s = lstat(at);
    if (!s) return null;
    if (s.isDirectory()) continue;
    if (!s.isSymbolicLink()) return { at, what: "a file" };
    let real;
    try {
      real = fs.statSync(at);
    } catch {
      return { at, what: "a link that leads nowhere" };
    }
    if (!real.isDirectory()) return { at, what: "a link to a file" };
  }
  return null;
}

// The refusal for a folder that a file stands in the way of. The path is
// told the way dir is, from the current folder when dir is.
function notAFolder(dir, target, { at, what }) {
  if (at === target) return `${dir} is ${what}, and this run saves its files in a folder of that name. Move it, or pick another folder with --out.`;
  const shown = path.isAbsolute(dir) ? at : path.relative(process.cwd(), at) || at;
  return `${dir} cannot be made: ${shown} is ${what}. Move it, or pick another folder with --out.`;
}

// Files a file browser leaves in a folder it has shown (Finder, Windows
// Explorer): they make no folder anyone's, and a run leaves them be.
const SHOWN = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

// The folder holds nothing, or an earlier run of the same kind.
function check(dir, target, spec) {
  const names = fs.readdirSync(target).filter((name) => !PART.test(name) && name !== LOCK && !SHOWN.has(name.toLowerCase()) && !(spec.ignore && spec.ignore(name, target)));
  if (!names.length) return;
  let earlier = null;
  try {
    earlier = JSON.parse(fs.readFileSync(path.join(target, spec.marker), "utf8"));
  } catch {
    // Not a run of ours.
  }
  if (!earlier || !spec.accepts(earlier)) throw new Error(spec.refusal(dir));
}

// Whether rel is a folder inside root, each folder on the way a folder of
// its own and not a link to one elsewhere (or a Windows junction): a run
// moves and removes nothing outside the folder it saves in.
function realFolder(root, rel) {
  let at = root;
  for (const name of String(rel).split(/[\\/]/).filter(Boolean)) {
    at = path.join(at, name);
    const s = lstat(at);
    if (!s || !s.isDirectory()) return false;
  }
  return true;
}

// Checked before any work, so a run does not fail at its end over a name it
// cannot save under.
function claim(dir, target, spec) {
  for (const name of spec.folders || []) {
    const s = lstat(path.join(target, name));
    if (s && !s.isDirectory()) throw new Error(`${path.join(dir, name)} is ${s.isSymbolicLink() ? "a link" : "a file"}, and this run saves a folder of that name there. Move it, or pick another folder with --out.`);
  }
  for (const name of spec.files || []) {
    const s = lstat(path.join(target, name));
    if (s && s.isDirectory()) throw new Error(`${path.join(dir, name)} is a folder, and this run saves its ${name.split(path.sep).join("/")} there. Move it, or pick another folder with --out.`);
  }
  if (spec.claim) spec.claim(dir, target);
}

// Whether a run may save in dir, as begin() decides it, without changing
// anything. A folder that is not there yet may.
function checkDir(dir, spec) {
  const target = path.resolve(dir);
  const file = inTheWay(target);
  if (file) throw new Error(notAFolder(dir, target, file));
  if (!fs.existsSync(target)) return;
  check(dir, target, spec);
  claim(dir, target, spec);
}

// Makes the folders of rel inside root one at a time, never root itself: a
// write that comes after the run was stopped finds no part folder and
// fails, instead of making it again. made, when given, gets the ones made.
function folders(root, rel, made = null) {
  let at = root;
  for (const name of String(rel).split(/[\\/]/).filter((part) => part && part !== ".")) {
    at = path.join(at, name);
    try {
      fs.mkdirSync(at);
      if (made) made.push(at);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
  }
}

// A file of the run, written whole in its part folder. A full disk or quota
// comes back from Node as "UNKNOWN: unknown error, write" (EDQUOT), which
// says nothing; this says what.
function write(run, rel, data) {
  if (run.ended) throw new Error(`This run has stopped, so nothing more is saved in ${run.dir}.`);
  try {
    folders(run.part, path.dirname(rel));
    fs.writeFileSync(path.join(run.part, rel), data);
  } catch (err) {
    const full = err.code === "ENOSPC" || err.code === "EDQUOT" || err.errno === -122;
    throw new Error(`Could not save ${rel.split(path.sep).join("/")} in ${run.dir}: ${full ? "the disk, or your disk quota, is full" : err.message}`);
  }
}

// Windows can refuse a rename for a moment while a virus scanner or a sync
// client reads a file that was just written, so it is tried again for up
// to two seconds there. Synchronous, like the whole commit.
function rename(from, to) {
  for (let waited = 0; ; waited += 50) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(err.code) || waited >= 2_000) throw err;
      pause(50);
    }
  }
}

// What a move that failed says.
const WHY = {
  EBUSY: "it is held open by another program",
  EPERM: "it is held open by another program, or may not be changed",
  EACCES: "it may not be changed",
  ENOENT: "it is not there any more",
  ENOTDIR: "a file is in the way",
  EISDIR: "a folder of that name is in the way",
  ENOTEMPTY: "a folder of that name is in the way",
  EEXIST: "something of that name is in the way",
  ENOSPC: "the disk is full",
  EDQUOT: "your disk quota is full",
};

function reasonOf(run, err) {
  const name = err.rel ? path.join(run.dir, err.rel) : run.dir;
  return `${name}: ${WHY[err.code] || err.message}`;
}

// Puts the run's files in place of the earlier run's: outputs are the
// paths of its files in the part folder, its manifest among them. Any move
// that fails puts back what was moved, and the error says where things are.
function commit(run, outputs) {
  if (run.ended) throw new Error(`This run has stopped, so nothing more is saved in ${run.dir}.`);
  const { target, part, spec } = run;
  const marker = spec.marker;
  const fresh = [...new Set(outputs)].filter((rel) => rel !== marker);
  let held;
  try {
    held = lock(run);
  } catch (err) {
    abort(run);
    throw err;
  }
  const aside = path.join(part, "earlier");
  const moved = [];
  const madeHere = [];
  const move = (from, to, rel) => {
    try {
      rename(from, to);
    } catch (err) {
      throw Object.assign(err, { rel });
    }
    moved.push([from, to]);
  };
  try {
    // Read once the lock is held: a run that put its files in place a
    // moment ago left them, not the ones there when this run began.
    const before = spec.earlier(target).filter((rel) => rel !== marker);
    fs.mkdirSync(aside);
    for (const rel of before) {
      folders(aside, path.dirname(rel));
      move(path.join(target, rel), path.join(aside, rel), rel);
    }
    for (const rel of fresh) {
      try {
        folders(target, path.dirname(rel), madeHere);
      } catch (err) {
        throw Object.assign(err, { rel: path.dirname(rel) });
      }
      const there = lstat(path.join(target, rel));
      if (there) throw Object.assign(new Error(there.isDirectory() ? WHY.EISDIR : "a file of that name came there while the run worked"), { rel });
      move(path.join(part, rel), path.join(target, rel), rel);
    }
    // The commit point: the new manifest takes the old one's place.
    move(path.join(part, marker), path.join(target, marker), marker);
  } catch (err) {
    try {
      undo(run, moved, madeHere, err);
    } finally {
      remove(held);
    }
  }
  end(run);
  saved = run.dir;
  // The earlier files go with the part folder. From here on, nothing fails
  // the run: what cannot be removed now, a later run removes.
  remove(part);
  for (const rel of spec.tidy || []) {
    if (!realFolder(target, rel)) continue;
    try {
      fs.rmdirSync(path.join(target, rel));
    } catch {
      // Not empty: what is left there is not a run's.
    }
  }
  remove(held);
  sweep(target, spec);
}

// The lock a run holds in its folder while it puts its files in place, so
// that two runs ending at the same moment do not mix their files there: a
// folder, made in one step, that names the machine and the process holding
// it. A run that finds it waits; one left by a process that is gone, on
// this machine, or older than LOCK_STALE (a process elsewhere, or a number
// used again since), is taken over.
const LOCK = ".easyscreenshotkit-commit";
const LOCK_WAIT = 5_000;
const LOCK_STALE = 60_000;

function lock(run) {
  const at = path.join(run.target, LOCK);
  for (const started = Date.now(); ; pause(50)) {
    try {
      fs.mkdirSync(at);
      try {
        fs.writeFileSync(path.join(at, "holder.json"), JSON.stringify({ host: os.hostname(), pid: process.pid }) + "\n");
      } catch {
        // The folder is the lock; the name in it only tells who holds it.
      }
      return at;
    } catch (err) {
      if (err.code !== "EEXIST") throw new Error(`Could not move this run's files into ${run.dir}: ${reasonOf(run, Object.assign(err, { rel: LOCK }))}. What the folder held before this run is as it was.`);
    }
    if (stale(at)) {
      remove(at);
      continue;
    }
    if (Date.now() - started >= LOCK_WAIT) throw new Error(`Could not move this run's files into ${run.dir}: another run was still putting its files there after ${LOCK_WAIT / 1000} s. This run added nothing to the folder.`);
  }
}

// Whether a lock is left over from a process that cannot release it.
function stale(at) {
  const s = lstat(at);
  if (!s) return false;
  const age = Date.now() - s.mtimeMs;
  if (age > LOCK_STALE) return true;
  let holder;
  try {
    holder = JSON.parse(fs.readFileSync(path.join(at, "holder.json"), "utf8"));
  } catch {
    // Made a moment ago, or by a process killed before it named itself.
    return age > LOCK_WAIT;
  }
  return Boolean(holder) && holder.host === os.hostname() && Number.isInteger(holder.pid) && !running(holder.pid);
}

// Puts back what a commit moved before it failed, and throws.
function undo(run, moved, madeHere, err) {
  const earlier = [];
  const fresh = [];
  for (const [from, to] of moved.reverse()) {
    try {
      rename(to, from);
    } catch {
      (to.startsWith(run.part) ? earlier : fresh).push(to);
    }
  }
  for (const folder of madeHere.reverse()) {
    try {
      fs.rmdirSync(folder);
    } catch {
      // Not empty: a file of this run could not be taken out of it.
    }
  }
  const head = `Could not move this run's files into ${run.dir}: ${reasonOf(run, err)}.`;
  if (!earlier.length && !fresh.length) {
    abort(run);
    throw new Error(`${head} What the folder held before this run is as it was.`);
  }
  // What could not be put back stays, with a note, in a folder no later run
  // removes.
  end(run);
  const lines = [];
  if (earlier.length) lines.push(`Some of the earlier files could not be put back: they are in ${keep(run, earlier, fresh)}.`);
  else remove(run.part);
  if (fresh.length) lines.push(`Some of this run's files could not be taken out again: ${fresh.map((file) => path.relative(run.target, file)).join(", ")}.`);
  throw new Error(`${head} ${lines.join(" ")}`);
}

function keep(run, earlier, fresh) {
  const to = path.join(run.target, path.basename(run.part).replace(/^\.easyscreenshotkit-part-/, "easyscreenshotkit-kept-"));
  try {
    const note = [
      `An easyscreenshotkit run could not put these files back in ${run.target}:`,
      ...earlier.map((file) => `  ${path.relative(path.join(run.part, "earlier"), file)}`),
      ...(fresh.length ? ["and these files of the run that failed are still there:", ...fresh.map((file) => `  ${path.relative(run.target, file)}`)] : []),
      "They are in the earlier folder here. Move them where they belong, then remove this folder: easyscreenshotkit leaves it alone.",
      "",
    ];
    fs.writeFileSync(path.join(run.part, "README.txt"), note.join("\n"));
    rename(run.part, to);
    return to;
  } catch {
    return run.part;
  }
}

function end(run) {
  run.ended = true;
  live.delete(run);
}

// Synchronous and short: a process that is being stopped may have a second
// left before it is killed outright.
function remove(at) {
  for (let tries = 0; tries < 3; tries++) {
    try {
      fs.rmSync(at, { recursive: true, force: true });
      return;
    } catch {
      // Something was still being written in it: once more a moment later.
      pause(50);
    }
  }
}

// The folders begin() made, deepest first, as far as they are empty.
function removeMade(made) {
  for (const folder of made) {
    try {
      fs.rmdirSync(folder);
    } catch (err) {
      if (err.code !== "ENOENT") break;
    }
  }
}

// An error as the user reads it, once the run's part folder is gone: a
// path in that folder is told by the folder the run saves in.
function told(run, err) {
  if (err && typeof err.message === "string" && err.message.includes(run.part)) err.message = err.message.split(run.part).join(run.dir);
  return err;
}

// Takes away what the run built, and the folders it made when they are
// empty. Nothing else in the folder is touched.
function abort(run) {
  if (run.ended) return;
  end(run);
  remove(run.part);
  removeMade(run.made);
}

// Stops everything this process has going, at once and synchronously, for a
// process that is being stopped or is ending: its browsers and its ffmpeg
// are killed, and every run that has not ended takes its part folder away,
// so its folder is as it was. Then, once the browsers' helper processes
// have ended too, their profiles go. Returns the runs stopped.
function stopAll() {
  const browsers = killBrowsers();
  const children = killChildren();
  const stopped = [...live];
  for (const run of stopped) abort(run);
  if (browsers.length || children) {
    // A browser's helpers end about a tenth of a second after it, and write
    // to its profile meanwhile; a write of ffmpeg's may still be on its way.
    pause(300);
    removeProfiles(browsers);
    for (const run of stopped) {
      if (fs.existsSync(run.part)) remove(run.part);
      removeMade(run.made);
    }
  }
  return stopped.map((run) => ({ dir: run.dir, existed: run.existed }));
}

// Whether a process of that number runs on this machine.
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// The newest time anything in a folder was changed, two levels down.
function touched(folder) {
  let newest = 0;
  const look = (at, depth) => {
    const s = lstat(at);
    if (!s) return;
    newest = Math.max(newest, s.mtimeMs);
    if (depth > 0 && s.isDirectory()) {
      let names = [];
      try {
        names = fs.readdirSync(at);
      } catch {
        return;
      }
      for (const name of names) look(path.join(at, name), depth - 1);
    }
  };
  look(folder, 2);
  return newest;
}

// Removes the part folders of runs killed outright in this folder, once
// their process is gone and they have not changed for STALE, and an older
// version's leftovers once stale.
function sweep(target, spec) {
  let entries = [];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return;
  }
  const ours = new Set([...live].map((run) => run.part));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const at = path.join(target, entry.name);
    const m = PART.exec(entry.name);
    if (m) {
      // One under this process's own number that is not one of its runs is
      // a leftover of an earlier process that had the same number.
      if (ours.has(at) || (Number(m[1]) !== process.pid && running(Number(m[1])))) continue;
    } else if (!(spec.leftovers && spec.leftovers.test(entry.name))) continue;
    if (Date.now() - touched(at) < STALE) continue;
    remove(at);
  }
}

// Written at once: a pipe can be asynchronous, and the process ends next.
function say(fd, text) {
  try {
    fs.writeSync(fd, text);
  } catch {
    // Nobody is reading.
  }
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", ...(process.platform === "win32" ? ["SIGBREAK"] : [])];
let stopping = false;

// For the command line: a run stopped with Ctrl-C or a signal kills its
// browsers and ffmpeg, leaves its folder as it was, says so, and ends by
// the same signal, as a process with no handler would, so whatever started
// it sees how it ended. The handler stays on until all that is done: a
// supervisor that sends the signal twice (to the group, then to the
// process) would otherwise end it halfway. name: the command's name in the
// message; json: say it on stdout as {"ok":false,"error":...} too.
function stopOnSignals({ name, json = false }) {
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      const stopped = stopAll();
      let message = "stopped.";
      if (stopped.length) message = stopped.map(({ dir, existed }) => (existed ? `stopped. ${dir} is as it was before this run.` : "stopped. Nothing was saved.")).join(" ");
      else if (saved) message = `stopped after the run had saved its files in ${saved}.`;
      if (json) say(1, JSON.stringify({ ok: false, error: message }) + "\n");
      say(2, `${name}: ${message}\n`);
      for (const other of SIGNALS) process.removeAllListeners(other);
      const code = 128 + (os.constants.signals[signal] || 1);
      try {
        process.kill(process.pid, signal);
      } catch {
        // Windows cannot raise every signal.
        process.exit(code);
      }
      // Only reached where that signal does not end a process.
      setTimeout(() => process.exit(code), 100);
    });
  }
}

module.exports = { begin, checkDir, stopAll, stopOnSignals, sweep, toMake, realFolder, PART, STALE, LOCK };
