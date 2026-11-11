"use strict";

// The programs a run starts, the browser and, for a demo, ffmpeg: where each
// one is, as a shell would find it, and, when one cannot be started, what is
// wrong with it in words a person can act on. The system says little:
// ENOENT for a script whose interpreter or a program whose loader is not
// there, EACCES for a folder, and a file it cannot run as a program it hands
// to /bin/sh, which reads it as a script and fails with words of its own. So
// a program is looked at before any work, ffmpeg is asked its version, and
// one that did not start is looked at again, more closely. It finds them as
// easycaptionkit 0.1.3 does, and says the same of them.

const fs = require("node:fs");
const path = require("node:path");
const { getSystemErrorMap } = require("node:util");

const WINDOWS = process.platform === "win32";

const exe = (name) => (WINDOWS ? `${name}.exe` : name);

// A name with no folder in it, which is looked up on PATH.
const bare = (value) => !(value.includes("/") || (WINDOWS && value.includes("\\")));

// The system's words for an error, as "too many symbolic links
// encountered", else its code.
const worded = (err) => (getSystemErrorMap().get(err.errno) || [])[1] || err.code || String(err.message || err);

// A file this user may run, as a shell would take one: a file, not a
// folder, with the permission to run it. On Windows that permission is not
// looked at, and any file passes.
function runnable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// Whether anything is at a path, a link that leads nowhere too.
function there(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

// On PATH, the first program by a name that this user may run, as a shell
// finds it, and the first thing by that name that is none, such as a
// folder or a file without the permission to run it, which a shell passes
// over: { file, other }, each "" when there is none. A folder of PATH given
// from the current folder is taken from the folder the run started in, so
// the program is found when it runs in another folder. Folders `skip`
// passes over are not looked in.
function lookOnPath(name, { skip = () => false } = {}) {
  let other = "";
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir || skip(dir)) continue;
    const file = path.resolve(dir, name);
    if (runnable(file)) return { file, other };
    if (!other && there(file)) other = file;
  }
  return { file: "", other };
}

const onPath = (name, options) => lookOnPath(name, options).file;

// ─── what is at a path ────────────────────────────────────────────────────

// Where a link leads, as a whole path.
function target(link) {
  try {
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch {
    return link;
  }
}

function real(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

// What keeps the system from looking at a path, on the way to it: a file
// where a folder should be, { file }, or a folder this user may not enter,
// { folder }. null when neither does.
function inTheWay(file) {
  const chain = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    chain.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  for (const dir of chain) {
    let stat;
    try {
      stat = fs.statSync(dir);
    } catch {
      return null;
    }
    if (!stat.isDirectory()) return { file: dir };
    try {
      fs.accessSync(dir, fs.constants.X_OK);
    } catch {
      return { folder: dir };
    }
  }
  return null;
}

// The point a file system that runs no program is mounted at, when `file`
// is on one (mounted noexec, as /tmp and /dev/shm are on some servers).
// Read from /proc/self/mountinfo, so on Linux only; "" elsewhere, and when
// the file system runs programs.
function noexecMount(file) {
  if (process.platform !== "linux") return "";
  let info;
  try {
    info = fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
  const at = real(file);
  let found = null;
  for (const line of info.split("\n")) {
    const fields = line.split(" ");
    if (fields.length < 7) continue;
    // A space, a tab, a line break or a backslash in a mount point is
    // written as \040, \011, \012 and \134.
    const point = fields[4].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const inside = at === point || at.startsWith(point.endsWith("/") ? point : `${point}/`);
    // The deepest mount point holds the file; of two at one point, the one
    // mounted last, which comes last.
    if (inside && (!found || point.length >= found.point.length)) found = { point, noexec: fields[5].split(",").includes("noexec") };
  }
  return found && found.noexec ? found.point : "";
}

const SPECIAL = (stat) => (stat.isFIFO() ? "a named pipe" : stat.isSocket() ? "a socket" : "a device");

// Why a path that cannot be looked at names no program, as words that
// follow it after a comma.
function unreachable(file, err) {
  const way = err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "EACCES" || err.code === "EPERM" ? inTheWay(file) : null;
  if (way && way.file) return `and there is no file there, as ${way.file} is a file, not a folder`;
  if (way && way.folder) return `in ${way.folder}, a folder this user may not enter`;
  if (err.code === "ENOENT" || err.code === "ENOTDIR") return "and there is no file there";
  if (err.code === "ELOOP") return "a path that goes round a loop of links";
  if (err.code === "ENAMETOOLONG") return "a path longer than the system takes";
  return `a path the system cannot look at (${worded(err)})`;
}

// What keeps a path from being a program this user may run, looked at as
// the system would, through links and with this user's permissions, as
// words that follow it after a comma: "a folder, not a program", "and
// there is no file there". "" when nothing does: the file may still not
// start, which only running it shows.
function inspect(file, depth = 0) {
  let link;
  try {
    link = fs.lstatSync(file);
  } catch (err) {
    return unreachable(file, err);
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    if (err.code === "ELOOP") return "a link in a loop of links, which leads to no file";
    const to = target(file);
    if (err.code === "ENOENT" && !there(to)) return `a link to ${to}, where there is no file`;
    const why = depth < 8 && to !== file ? inspect(to, depth + 1) : "";
    return `a link to ${to}, ${why || "which leads to no file"}`;
  }
  if (stat.isDirectory()) return link.isSymbolicLink() ? `a link to the folder ${real(file)}, not to a program` : "a folder, not a program";
  if (!stat.isFile()) return `${SPECIAL(stat)}, not a program`;
  if (!WINDOWS) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      // A file system mounted noexec runs no program, whatever its
      // permissions: chmod +x would not let it run.
      const mount = noexecMount(file);
      if (mount) return `a file on ${mount}, which is mounted noexec, so no program on it may run`;
      if (!(stat.mode & 0o111)) return "a file without the permission to run it, which chmod +x gives";
      // The bit that counts for this user: the owner's, the group's or
      // everyone else's. Where it is set, something else refuses it, as an
      // ACL or the system's security rules.
      const bit = process.getuid && stat.uid === process.getuid() ? 0o100 : process.getgroups && (process.getgroups().includes(stat.gid) || stat.gid === process.getgid()) ? 0o010 : 0o001;
      return stat.mode & bit ? "a file this user may not run" : "a file this user may not run, as only other users have the permission to run it";
    }
  }
  if (stat.size === 0) return "an empty file, not a program";
  return "";
}

// ─── what a file is ───────────────────────────────────────────────────────

// The processors of ELF programs, by their number in the file's header,
// and this machine's, by Node's name for it.
const MACHINES = { 3: "32-bit x86", 8: "MIPS", 20: "32-bit PowerPC", 21: "64-bit PowerPC", 22: "IBM Z (s390x)", 40: "32-bit ARM", 62: "x86-64", 183: "ARM64 (aarch64)", 243: "RISC-V", 258: "LoongArch" };
const ARCH = { ia32: 3, mips: 8, mipsel: 8, ppc: 20, ppc64: 21, s390x: 22, arm: 40, x64: 62, arm64: 183, riscv64: 243, loong64: 258 };
const OS = { linux: "Linux", darwin: "macOS", win32: "Windows" }[process.platform] || process.platform;

function readAt(fd, offset, length) {
  const buffer = Buffer.alloc(Math.max(0, Math.min(length, 1 << 16)));
  return buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, offset));
}

// An ELF program's processor and the loader it names, from its header and
// its program headers.
function elfOf(fd, head) {
  const bits = head[4] === 2 ? 64 : 32;
  const little = head[5] !== 2;
  const u16 = (b, at) => (little ? b.readUInt16LE(at) : b.readUInt16BE(at));
  const u32 = (b, at) => (little ? b.readUInt32LE(at) : b.readUInt32BE(at));
  const word = (b, at) => (bits === 64 ? Number(little ? b.readBigUInt64LE(at) : b.readBigUInt64BE(at)) : u32(b, at));
  const machine = u16(head, 18);
  let loader = "";
  try {
    const table = word(head, bits === 64 ? 0x20 : 0x1c);
    const size = u16(head, bits === 64 ? 0x36 : 0x2a);
    const count = Math.min(u16(head, bits === 64 ? 0x38 : 0x2c), 128);
    const headers = readAt(fd, table, size * count);
    for (let i = 0; i < count; i++) {
      // PT_INTERP: the loader that starts the program.
      if (u32(headers, i * size) !== 3) continue;
      const offset = word(headers, i * size + (bits === 64 ? 8 : 4));
      const length = word(headers, i * size + (bits === 64 ? 32 : 16));
      loader = readAt(fd, offset, Math.min(length, 4096)).toString("latin1").replace(/\0[\s\S]*$/, "");
      break;
    }
  } catch {
    // A header cut short: no loader known.
  }
  return { machine, bits, loader };
}

// Whether bytes are text: UTF-8 with no control character but a tab, a
// line break, a form feed or an escape. A letter cut in two at the end of
// the bytes read is no sign of anything.
function textual(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return false;
  }
  return !/[\0-\x08\x0e-\x1a\x1c-\x1f\x7f]/.test(text);
}

// What a file holds, from its first bytes: { empty }, { script: {
// interpreter, cr, args } } from its #! line, { elf: { machine, bits,
// loader } }, { windows } for a Windows program, { macos } for a macOS one,
// { text } for text with no #! line, { binary } for anything else, and {}
// when it cannot be read.
function kindOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = readAt(fd, 0, 4096);
    if (!head.length) return { empty: true };
    if (head[0] === 0x23 && head[1] === 0x21) {
      // The system takes the interpreter up to a space, a tab or the end of
      // the line, and a carriage return as part of its name, and gives it
      // the rest of the line as one word, `args`, a carriage return a file
      // saved on Windows ends it with too. A path is UTF-8, as the one a
      // folder of Japanese or Turkish letters gives.
      const end = head.indexOf(0x0a);
      const line = head.subarray(2, end < 0 ? head.length : end).toString("utf8");
      const [, name, args] = /^[ \t]*([^ \t]*)[ \t]*(.*?)[ \t]*$/s.exec(line);
      return { script: { interpreter: name.replace(/\r$/, ""), cr: name.endsWith("\r"), args } };
    }
    if (head.length >= 52 && head.readUInt32BE(0) === 0x7f454c46) return { elf: elfOf(fd, head) };
    if (head[0] === 0x4d && head[1] === 0x5a) return { windows: true };
    const magic = head.length >= 8 ? head.readUInt32BE(0) : 0;
    // Mach-O, 32 and 64 bits in either byte order, and a universal file of
    // a few of them, which a Java class file, of the same magic, is not.
    if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic) || ((magic === 0xcafebabe || magic === 0xcafebabf) && head.readUInt32BE(4) < 20)) return { macos: true };
    return textual(head) ? { text: true } : { binary: true };
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// What a file made for another system is, or "" for one of this one's: by
// its header, so said only of a file the system could not run.
function foreign(kind) {
  if (kind.elf) {
    if (WINDOWS || process.platform === "darwin") return `a program for Linux or another Unix, not for ${OS}`;
    const mine = ARCH[process.arch];
    if (mine !== undefined && kind.elf.machine !== mine) return `a program for ${MACHINES[kind.elf.machine] || "another processor"}, which this ${MACHINES[mine]} machine cannot run`;
    return "";
  }
  if (kind.windows && !WINDOWS) return `a Windows program, which does not run on ${OS}`;
  if (kind.macos && process.platform !== "darwin") return `a macOS program, which does not run on ${OS}`;
  return "";
}

// A script whose interpreter cannot be started: what its first line names
// and what is wrong with that.
function interpreterTrouble(script) {
  if (script.cr) return "a script with Windows line breaks, so its first line names a program whose name ends in a carriage return, which is not there";
  const name = script.interpreter;
  if (!name) return "a script whose first line, #!, names no program";
  const file = path.resolve(name);
  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    // Not there, or not to be looked at.
  }
  if (!stat) return `a script whose first line names ${name}, which is not on this machine`;
  if (stat.isDirectory()) return `a script whose first line names ${name}, a folder, not a program`;
  if (!runnable(file)) return `a script whose first line names ${name}, a file this user may not run`;
  return `a script whose first line names ${name}, which cannot be started`;
}

// The program a script's #! line has env start by its name, as in
// "#!/usr/bin/env node", or "": env takes the rest of the line as one name,
// unless -S has it split the line, as "#!/usr/bin/env -S node --flag" does.
function envProgram(script) {
  if (path.basename(script.interpreter) !== "env" || !script.args) return "";
  if (!script.args.startsWith("-")) return script.args;
  if (!script.args.startsWith("-S")) return "";
  return script.args.slice(2).split(/[ \t]+/).find((word) => word && !word.startsWith("-") && !word.includes("=")) || "";
}

// What kept env from starting the program a script's #! line names, for a
// script that ended as env does when it cannot start one, with code 127 or
// 126: no program by that name on PATH, or only one this user may not run.
// "" when there is one env could start: the script's own work failed then.
function envTrouble(kind, code) {
  const name = kind.script ? envProgram(kind.script) : "";
  if (!name || (code !== 127 && code !== 126)) return "";
  if (name.endsWith("\r")) return "a script with Windows line breaks, so its first line names a program whose name ends in a carriage return, which is not there";
  const runs = `a script whose first line runs ${name} through env`;
  if (!bare(name)) {
    const seen = inspect(path.resolve(name));
    return seen ? `${runs}, ${seen}` : "";
  }
  const seen = lookOnPath(name);
  if (seen.file) return "";
  if (!seen.other) return `${runs}, and no program by that name is on PATH`;
  return `${runs}, and ${seen.other}, the ${name} on PATH, is ${inspect(seen.other) || "no program this user may run"}`;
}

// ─── what a program said ──────────────────────────────────────────────────

// The words of a line that says what went wrong, as "No such file or
// directory" or ffmpeg 8's "Impossible to convert between the formats
// supported by" two filters.
const WRONG = /error|\b(?:invalid|unable|cannot|can't|could not|couldn't|failed|not found|no such|unknown|unrecognized|not supported|impossible|denied|no space|refused|undefined)\b/i;

// The lines a program printed, but those that start with a space, as the
// lines of a stack trace or of a summary do, each without the "[name @
// 0x...]" that starts it.
function linesOf(stderr) {
  return String(stderr || "")
    .split(/\r?\n|\r/)
    .filter((line) => line.trim() && !/^\s/.test(line))
    .map((line) => line.replace(/^(?:\[[^\]]*\]\s*)+/, "").trim())
    .filter(Boolean);
}

// Of such lines, the last that names what went wrong, as a script's "Error:
// the wrapper could not find its config" above the version of Node.js that
// Node prints last; else the last. "" for none.
const telling = (lines) => lines.filter((line) => WRONG.test(line)).pop() || lines[lines.length - 1] || "";

// What the loader said of a program it could not start, a library it did
// not find or one too old, in a line that starts with the name the program
// was started by, as glibc's loader starts it. A line that names another
// program, as one a script runs, is that program's. "" otherwise.
function loaderSaid(file, stderr) {
  for (const line of String(stderr).split(/\r?\n/)) {
    if (!line.startsWith(`${file}: `)) continue;
    const rest = line.slice(file.length + 2);
    const library = /^error while loading shared libraries: ([^:]+): cannot open shared object file/.exec(rest);
    if (library) return `a program that needs the shared library ${library[1].trim()}, which is not on this machine`;
    const old = /^([^:\s]+): version [`']([^']+)' not found \(required by /.exec(rest);
    if (old) return `a program made for a newer system: it needs ${old[2]} of ${path.basename(old[1])}, which this machine's is too old to have`;
  }
  return "";
}

// Whether /bin/sh read the file as a script and failed on it, as the system
// has it do with a file it cannot run as a program: the shell starts what
// it says with the file's name and then the line, as dash and BusyBox do,
// or with the name again, as bash does of a file that is no script. A
// command of the file's own that the shell could not run, as "exec:
// /opt/ffmpeg/ffmpeg: not found", is no sign of it.
function readByShell(file, stderr) {
  const said = String(stderr);
  if (!said.startsWith(`${file}: `)) return false;
  const rest = said.slice(file.length + 2);
  return (/^(?:line )?\d+: /.test(rest) && !/^(?:line )?\d+: exec: /.test(rest)) || rest.startsWith(`${file}: `);
}

// What a file the system could not run as a program is, from its kind: one
// for another system, an empty file, text with no #! line or bytes that are
// no program. "" for a script, and for a program of this system's.
function whatItIs(kind) {
  if (foreign(kind)) return foreign(kind);
  if (kind.empty) return "an empty file, not a program";
  if (kind.text) return "a text file with no #! line, not a program";
  if (kind.binary) return "not a program this system can run";
  return "";
}

// ─── why a program did not start ──────────────────────────────────────────

// The errors that say the system is short of something to start a program
// with, not that the program is wrong, and what each means.
const SHORT = {
  EMFILE: "this process has as many files open as it may (too many open files). Raise that limit, as ulimit -n does, and run again",
  ENFILE: "the system has as many files open as it may (file table overflow). Run fewer jobs at once",
  EAGAIN: "the system starts no more processes for this user now (resource temporarily unavailable). Run fewer jobs at once",
  ENOMEM: "the system has no memory left to start it. Run fewer jobs at once",
};

// Why a program the system started ended at once without running, as
// words that follow it after a comma, or "" when nothing says it did not
// run: what the loader said of it, and what the file is where the shell
// read it as a script and failed (see readByShell()). A file made for
// another system, or no program at all, the system hands to /bin/sh. What
// the file is is not looked at where `kinds` is false, as for a Chrome
// that answered when asked its version and stopped later for a reason of
// its own.
function unrun(file, { stderr = "" } = {}, { kinds = true, kind = null } = {}) {
  const loader = loaderSaid(file, stderr);
  if (loader) return loader;
  if (!kinds || !readByShell(file, stderr)) return "";
  return whatItIs(kind || (there(file) ? kindOf(file) : {}));
}

// The signals a program ends by when it crashes.
const CRASHES = ["SIGSEGV", "SIGBUS", "SIGILL", "SIGABRT", "SIGFPE"];

// Why `file` did not start, as words that follow it after a comma: from
// the error the system gave as it was started, `error`, or from how it
// ended at once, its `code`, `signal` and what it printed, and what the
// file is. `none` is what to say of a program that ran and printed no
// version.
function explain(file, { error = null, code = 0, signal = null, stderr = "" } = {}, { none = "" } = {}) {
  const kind = there(file) ? kindOf(file) : {};
  if (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "EACCES", "EPERM"].includes(error.code)) {
      const seen = inspect(file);
      if (seen) return seen;
    }
    if (kind.script && ["ENOENT", "EACCES", "EPERM", "ENOEXEC"].includes(error.code)) return interpreterTrouble(kind.script);
    if (error.code === "ENOENT") {
      if (kind.elf && kind.elf.loader && !there(kind.elf.loader)) return `a program that needs the loader ${kind.elf.loader}, which is not on this machine`;
      return "a program that cannot start, as its interpreter or loader is missing";
    }
    // macOS refuses such a file where Linux hands it to /bin/sh.
    if (error.code === "ENOEXEC" || error.code === "EFTYPE") return whatItIs(kind) || "not a program this system can run";
    if (error.code === "EACCES" || error.code === "EPERM") return "a file this user may not run";
    return `a program that cannot be started (${worded(error)})`;
  }
  const not = unrun(file, { stderr }, { kind }) || envTrouble(kind, code);
  if (not) return not;
  if (signal) return `a program that ${CRASHES.includes(signal) ? "crashed" : "was stopped"} as it started (${signal})`;
  if (code !== 0) {
    const said = telling(linesOf(stderr));
    return `a program that failed when asked its version, with code ${code}${said ? `: ${said}` : ""}`;
  }
  return none;
}

// ─── where a program is, and the words that name it ───────────────────────

// The programs found for this run, by their files, so that a start that
// fails during the work names the program as its check did. A file keeps
// the role it was first found for, ffmpeg, ffprobe or Chrome: a check
// names the place it asked, and a file named for two roles, as an
// FFMPEG_PATH that names ffprobe, is not named for the other.
const places = new Map();

// A program named by a variable: { name, role, variable, value, file, fix,
// problem }, `problem` being what keeps it from being one this user may
// run ("" when nothing does), and `fix` how to point to one that works.
// null when the variable is not set.
function named(variable, { name, role = name, fix }) {
  const value = process.env[variable];
  if (!value) return null;
  if (bare(value)) {
    const found = lookOnPath(value);
    const other = WINDOWS && !found.file ? lookOnPath(exe(value)) : { file: "", other: "" };
    const file = found.file || other.file || found.other || other.other;
    return { name, role, variable, value, file, fix, problem: file ? inspect(file) : "and no program by that name is on PATH" };
  }
  const file = path.resolve(value);
  return { name, role, variable, value, file, fix, problem: inspect(file) };
}

// A program found where it was looked for, `where` ("on PATH", "next to
// /opt/ffmpeg/ffmpeg").
const found = (file, { name, role = name, where, fix }) => ({ name, role, file, where, fix, problem: inspect(file) });

// A program named by a variable that leads to the file the run would take
// with the variable unset, `unset`, ends with how to get another, `fix`:
// to unset the variable would give the same file.
function orInstall(place, unset, fix) {
  return place && place.file && unset && unset.file && real(place.file) === real(unset.file) ? { ...place, fix } : place;
}

// The sentence that names a program and says what is wrong with it,
// `what`, ending with how to point to one that works unless `fix` is
// false: "FFMPEG_PATH is /opt/ffmpeg, a folder, not a program. Set it
// ...", or "/usr/bin/ffmpeg, the ffmpeg on PATH, is a program that ...".
function told(place, what, { fix = true } = {}) {
  const end = fix && place.fix ? ` ${place.fix}` : "";
  if (place.variable) {
    const at = bare(place.value) && place.file ? `, found on PATH at ${place.file}` : "";
    return `${place.variable} is ${place.value}${at}, ${what}.${end}`;
  }
  // A file that was found is there, unless it went since.
  const is = what.startsWith("and ") ? `gone: ${what.slice(4)}` : what;
  if (!place.where) return `${place.file} could not be started: it is ${is}.${end}`;
  return `${place.file}, the ${place.name} ${place.where}, is ${is}.${end}`;
}

function remember(place) {
  const had = place && place.file ? places.get(place.file) : null;
  if (place && place.file && (!had || had.role === place.role)) places.set(place.file, place);
  return place;
}

// A run starts with no program found, so a file an earlier run in this
// process found for another role is found for its own.
const forget = () => places.clear();

const placeOf = (file) => places.get(file) || { name: path.basename(file), file, where: "", fix: "" };

// The error for a program at `file` that did not start, with what is wrong
// with it, `what`, named as `place`, by default the place the run found it
// at. Marked `unstarted`, with its place and `what`, for words that leave
// out how to fix it.
function notStarted(file, what, place = placeOf(file)) {
  return Object.assign(new Error(told(place, what)), { unstarted: true, place, what });
}

// The error for a program at `file` that could not be started, from the
// error the system gave: what is wrong with it, or what the system is
// short of.
function startError(file, error, place = placeOf(file)) {
  const short = SHORT[error.code];
  if (short) return Object.assign(new Error(`${place.name} (${file}) could not be started: ${short}.`), { unstarted: true, code: error.code });
  return Object.assign(notStarted(file, explain(file, { error }), place), { code: error.code });
}

module.exports = { exe, bare, runnable, lookOnPath, onPath, inspect, kindOf, whatItIs, explain, unrun, named, found, orInstall, told, remember, forget, notStarted, startError, places, noexecMount, worded, SHORT };
