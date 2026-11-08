"use strict";

// The command line and the rules that need no browser: options, sizes,
// addresses, file names and the output folder.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { parse, summary } = require("../skills/easyscreenshotkit/scripts/easyscreenshotkit");
const { parseSizes, normalizeUrl, prepareDir, openShots, slugOf, identity, movedOn, pagesAsked, leftOut, siteName } = require("../skills/easyscreenshotkit/scripts/lib/shots");
const { sheetHtml } = require("../skills/easyscreenshotkit/scripts/lib/sheet");

const CLI = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");

test("the skill folder carries its own version, the same as the package's and every plugin manifest's", () => {
  const version = require("../skills/easyscreenshotkit/scripts/lib/version");
  assert.equal(version, require("../package.json").version);
  assert.equal(version, require("../.claude-plugin/marketplace.json").plugins[0].version);
  assert.equal(version, require("../.codex-plugin/plugin.json").version);
  assert.equal(version, require("../plugin.json").version);
});

test("the CLI explains itself and refuses a missing address or a bad option", () => {
  const help = spawnSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: easyscreenshotkit <url>/);
  const none = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Give one website address/);
  const bad = spawnSync(process.execPath, [CLI, "acme.com", "--pages", "40"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--pages takes 1 to 12/);
});

test("options: repeated --page and --hide, = forms, themes and languages", () => {
  const options = parse(["acme.com", "--page", "/pricing", "--page=/about", "--hide", ".promo", "--sizes=desktop,iphone", "--theme", "Both", "--lang", "pt-BR", "--no-clean", "--reduced-motion", "--json"]);
  assert.equal(options.url, "acme.com");
  assert.deepEqual(options.extra, ["/pricing", "/about"]);
  assert.deepEqual(options.hide, [".promo"]);
  assert.equal(options.sizes, "desktop,iphone");
  assert.equal(options.theme, "both");
  assert.equal(options.lang, "pt-BR");
  assert.equal(options.clean, false);
  assert.equal(options.reducedMotion, true);
  assert.equal(options.json, true);
  assert.throws(() => parse(["acme.com", "--theme", "blue"]), /light, dark or both/);
  assert.throws(() => parse(["acme.com", "--lang", "turkish!"]), /language code/);
  assert.throws(() => parse(["acme.com", "--out"]), /--out needs a value/);
  assert.throws(() => parse(["acme.com", "--wat"]), /Unknown option/);
});

test("sizes: devices with their scales, whole pages on the first desktop size or the phone", () => {
  const plain = parseSizes("desktop,mobile,full");
  assert.deepEqual(
    plain.map((group) => [group.key, group.device.width, group.device.height, group.device.scale, group.device.agent, group.shots.map((shot) => shot.size)]),
    [
      ["desktop", 1600, 900, 2, "desktop", ["desktop", "full"]],
      ["mobile", 360, 640, 3, "android", ["mobile"]],
    ],
  );
  const custom = parseSizes("1270x760@2, full@2, iphone, mobile-full, 390x844@3");
  assert.deepEqual(
    custom.map((group) => [group.key, group.device.scale, group.device.mobile, group.shots.map((shot) => `${shot.size}${shot.full ? `@${shot.scale}` : ""}`)]),
    [
      ["1270x760", 2, false, ["1270x760", "full@2"]],
      ["iphone", 3, true, ["iphone"]],
      ["390x844", 3, true, ["390x844"]],
      ["mobile", 3, true, ["mobile-full@2"]],
    ],
  );
  // A whole page alone still opens the desktop.
  assert.deepEqual(parseSizes("full").map((group) => [group.key, group.shots.map((shot) => shot.size)]), [["desktop", ["full"]]]);
  assert.throws(() => parseSizes("desktop,desktop"), /given twice/);
  assert.throws(() => parseSizes("watch"), /Unknown size/);
  assert.throws(() => parseSizes("desktop@9"), /scale goes from 0.5 to 4/);
  assert.throws(() => parseSizes("100x100"), /240 to 3840/);
});

test("addresses, page names and the site's name", () => {
  assert.equal(normalizeUrl("acme.com"), "https://acme.com/");
  assert.equal(normalizeUrl("http://acme.com/pricing#plans"), "http://acme.com/pricing#plans");
  assert.equal(normalizeUrl("acme.com/app/#/plants"), "https://acme.com/app/#/plants");
  assert.throws(() => normalizeUrl("ftp://acme.com"), /Not a web address/);
  assert.throws(() => normalizeUrl(""), /Give a website address/);
  const home = "https://acme.com/";
  assert.equal(slugOf("https://acme.com/", home), "home");
  assert.equal(slugOf("https://www.acme.com", home), "home");
  assert.equal(slugOf("https://acme.com/product/teams/", home), "product-teams");
  assert.equal(slugOf("https://acme.com/tr/fiyatlar", "https://acme.com/tr/"), "fiyatlar");
  assert.equal(slugOf("https://acme.com/%C3%BCr%C3%BCnler", home), "urunler");
  assert.equal(slugOf("https://acme.com/about.html", home), "about");
  // A view of a single page app is named after its route too; an anchor
  // names nothing.
  assert.equal(slugOf("https://acme.com/app/#/plants", home), "app-plants");
  assert.equal(slugOf("https://acme.com/#/plant/Fiddle%20leaf%20fig", home), "home-plant-fiddle-leaf-fig");
  assert.equal(slugOf("https://acme.com/mail/#!/inbox", home), "mail-inbox");
  assert.equal(slugOf("https://acme.com/pricing#faq", home), "pricing");
  // A route with no letter or digit a file name keeps is told apart by six
  // hex digits of its own, the same for the same route.
  const mark = (route) => `view-${require("node:crypto").createHash("sha1").update(route).digest("hex").slice(0, 6)}`;
  assert.equal(slugOf("https://acme.com/app/#/%F0%9F%8C%BF", home), `app-${mark("🌿")}`);
  assert.equal(slugOf("https://acme.com/app/#/%D1%80%D0%B0%D1%81%D1%82%D0%B5%D0%BD%D0%B8%D1%8F", home), `app-${mark("растения")}`);
  assert.equal(slugOf("https://acme.com/app/#/растения/", home), `app-${mark("растения")}`);
  assert.equal(slugOf("https://acme.com/app/#/растения/кактус", home), `app-${mark("растения/кактус")}`);
  assert.notEqual(mark("растения"), mark("растения/кактус"));
  assert.equal(slugOf("https://acme.com/app/#/растения/42", home), "app-42");
  assert.equal(slugOf("https://acme.com/uygulama%20%C3%A7al%C4%B1%C5%9Fma/#/%C5%9Fehir/%C4%B0zmir", home), "uygulama-calisma-sehir-izmir");
  // The pages asked for with --page keep their route; a fragment alone is a
  // view of the address given.
  assert.deepEqual(pagesAsked(["/app/#/plants", "#/light", "/pricing?plan=pro"], "https://acme.com/app/#/today", home), ["https://acme.com/app/#/plants", "https://acme.com/app/#/light", "https://acme.com/pricing"]);
  assert.throws(() => pagesAsked(["https://other.com/#/x"], "https://acme.com/", home), /is not a page of acme\.com/);
  // Asked with a route, a page is the view it ended on; asked without, its
  // page, whatever route the app went to by itself.
  assert.deepEqual([...identity("https://acme.com/app/#/private", "https://acme.com/app/#/login").keys], ["acme.com/app#/private", "acme.com/app#/login"]);
  assert.equal(identity("https://acme.com/app/#/private", "https://acme.com/app/#/login").named, "https://acme.com/app/#/login");
  assert.equal(identity("https://acme.com/", "https://acme.com/#/dashboard").named, "https://acme.com/");
  assert.ok(identity("https://acme.com/", "https://acme.com/#/dashboard").keys.has("acme.com/#/dashboard"));
  assert.equal(movedOn("https://acme.com/", "https://acme.com/#/dashboard"), false);
  assert.equal(movedOn("https://acme.com/app/#/private", "https://acme.com/app/#/login"), true);
  assert.equal(siteName({ siteName: "Acme Inc", title: "Home" }, home), "Acme Inc");
  assert.equal(siteName({ siteName: "", title: "Acme | Payments for teams" }, home), "Acme");
  assert.equal(siteName({ siteName: "", title: "" }, "https://www.acme.com/"), "Acme");
});

test("the summary and the sheet show a view's #route with its path", () => {
  const shot = (file, width, height) => ({ file, size: "desktop", full: false, theme: "light", width, height });
  const manifest = {
    url: "https://acme.com/app/#/plants",
    site: "Acme",
    pages: [{ n: 1, slug: "app-plants", url: "https://acme.com/app/#/plants", why: "the address given", shots: [shot("01-app-plants-desktop.png", 3200, 1800)] }],
    sheet: null,
    pwa: null,
    skipped: [
      { url: "https://acme.com/start", reason: "redirected to a sign-in page" },
      { url: "https://acme.com/app/#/light", reason: "a #route, which the tour does not follow: give it with --page" },
      { url: "https://acme.com/app/#/settings", reason: "a #route, which the tour does not follow: give it with --page" },
    ],
    notes: [],
  };
  manifest.pages.push({ n: 2, slug: "uygulama-calisma-sehir-izmir", url: "https://acme.com/uygulama%20%C3%A7al%C4%B1%C5%9Fma/#/%C5%9Fehir/%C4%B0zmir", why: "asked for with --page", shots: [shot("02-uygulama-calisma-sehir-izmir-desktop.png", 3200, 1800)] });
  const text = summary({ dir: "shots", manifest });
  assert.match(text, /01 app-plants {20}\/app\/#\/plants {2}\(the address given\)/);
  // A path and a route in other letters read as they are written.
  assert.match(text, /02 uygulama-calisma-sehir-izmir {2}\/uygulama çalışma\/#\/şehir\/İzmir {2}\(asked for with --page\)/);
  assert.match(sheetHtml(manifest, "shots"), /<span>\/uygulama çalışma\/#\/şehir\/İzmir<\/span>/);
  // The pages left out with the same reason come together.
  assert.match(text, /Skipped \/start \(redirected to a sign-in page\); \/app\/#\/light, \/app\/#\/settings \(a #route, which the tour does not follow: give it with --page\)\n/);
  assert.match(sheetHtml(manifest, "shots"), /<span>\/app\/#\/plants<\/span>/);
});

test("the pages left out: those opened first, then the #route links, then the other links, 40 at most, with the #route links past them counted", () => {
  const ROUTE = "a #route, which the tour does not follow: give it with --page";
  const rejected = [{ url: "https://acme.com/start", reason: "redirected to a sign-in page" }, { url: "https://acme.com/app/#/private", reason: "the page answered 404" }];
  const routes = ["today", "plants", "private"].map((view) => ({ url: `https://acme.com/app/#/${view}`, reason: ROUTE }));
  const posts = Array.from({ length: 45 }, (_, i) => ({ url: `https://acme.com/blog/2025/post-number-${i + 1}`, reason: "a single post" }));
  const left = leftOut(rejected, routes, posts);
  assert.equal(left.skipped.length, 40);
  assert.deepEqual(
    left.skipped.slice(0, 5).map((s) => [s.url.slice(16), s.reason]),
    [
      ["/start", "redirected to a sign-in page"],
      ["/app/#/private", "the page answered 404"],
      ["/app/#/today", ROUTE],
      ["/app/#/plants", ROUTE],
      ["/blog/2025/post-number-1", "a single post"],
    ],
  );
  assert.equal(left.routesPast, 0);
  // More #route links than the list holds: counted, for a note.
  const many = Array.from({ length: 50 }, (_, i) => ({ url: `https://acme.com/app/#/item/${i}`, reason: ROUTE }));
  assert.deepEqual([leftOut(rejected, many, posts).skipped.length, leftOut(rejected, many, posts).routesPast], [40, 12]);
});

test("two runs that put their files in one folder at the same moment take turns, and the later one's replace the earlier one's whole", async () => {
  const { LOCK } = require("../skills/easyscreenshotkit/scripts/lib/outdir");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-dir-"));
  const dir = path.join(root, "shots");
  const lock = path.join(dir, LOCK);
  const runOf = (id, pictures) => {
    const run = openShots(dir);
    const files = pictures.map((n) => `0${n}-p${n}-desktop.png`);
    for (const file of files) run.write(file, id);
    run.write("manifest.json", JSON.stringify({ version: 1, tool: "easyscreenshotkit 0.1.2", id }));
    return { run, files: [...files, "manifest.json"] };
  };
  const names = () => fs.readdirSync(dir).sort();
  try {
    const earlier = runOf("earlier", [1, 2, 3, 4, 5]);
    earlier.run.commit(earlier.files);
    // Another run holds the lock for a second: this one waits for it, then
    // its files take the place of what that run left.
    const other = spawn(process.execPath, ["-e", `const fs = require("fs");
      fs.mkdirSync(${JSON.stringify(lock)});
      fs.writeFileSync(${JSON.stringify(path.join(lock, "holder.json"))}, JSON.stringify({ host: require("os").hostname(), pid: process.pid }));
      fs.writeFileSync(${JSON.stringify(path.join(dir, "06-p6-desktop.png"))}, "other");
      console.log("held");
      setTimeout(() => fs.rmSync(${JSON.stringify(lock)}, { recursive: true }), 1000);`]);
    await new Promise((resolve) => other.stdout.once("data", resolve));
    const later = runOf("later", [1, 2]);
    const started = Date.now();
    later.run.commit(later.files);
    assert.ok(Date.now() - started >= 800, `waited ${Date.now() - started} ms`);
    await new Promise((resolve) => (other.exitCode === null ? other.once("exit", resolve) : resolve()));
    assert.deepEqual(names(), ["01-p1-desktop.png", "02-p2-desktop.png", "manifest.json"]);
    // A lock left by a process that is gone is taken over at once.
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "holder.json"), JSON.stringify({ host: os.hostname(), pid: 99999999 }));
    const next = runOf("next", [1]);
    const at = Date.now();
    next.run.commit(next.files);
    assert.ok(Date.now() - at < 1_000, `took ${Date.now() - at} ms`);
    assert.deepEqual(names(), ["01-p1-desktop.png", "manifest.json"]);
    // One whose process runs on is waited for 5 s, and then the run fails
    // and adds nothing.
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "holder.json"), JSON.stringify({ host: os.hostname(), pid: process.pid }));
    const held = snapshot(dir);
    const blocked = runOf("blocked", [1, 2, 3]);
    assert.throws(() => blocked.run.commit(blocked.files), /^Error: Could not move this run's files into .*shots: another run was still putting its files there after 5 s\. This run added nothing to the folder\.$/);
    assert.deepEqual(snapshot(dir), held);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the folders a run makes for its folder: up to the first that is there, never a drive or share that is not", () => {
  const { toMake } = require("../skills/easyscreenshotkit/scripts/lib/outdir");
  // Windows says a drive that is not there, and a share it cannot reach,
  // is not there: the walk stops at its root instead of going on for ever.
  const nothing = () => {
    let calls = 0;
    return () => {
      if (++calls > 100) throw new Error("the walk does not stop");
      return false;
    };
  };
  assert.deepEqual(toMake("E:\\shots", { exists: nothing(), paths: path.win32 }), ["E:\\shots"]);
  assert.deepEqual(toMake("\\\\nas\\share\\shots\\demo", { exists: nothing(), paths: path.win32 }), ["\\\\nas\\share\\shots\\demo", "\\\\nas\\share\\shots"]);
  assert.deepEqual(toMake("/srv/files/job1/shots", { exists: (at) => ["/", "/srv", "/srv/files"].includes(at), paths: path.posix }), ["/srv/files/job1/shots", "/srv/files/job1"]);
});

// Every file and folder under dir, with each file's bytes, hidden ones too:
// to tell a folder is exactly as it was.
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

const hourAgo = () => new Date(Date.now() - 3_600_000);

test("a run's folder: refused when it holds someone else's files, and an earlier run's files stay until a new run has ended well", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-dir-"));
  const dir = path.join(root, "shots");
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  try {
    // A new folder that Finder or Explorer has shown is still new; what they
    // left there stays.
    put(".DS_Store", "finder");
    put("Thumbs.db", "explorer");
    openShots(dir).abort();
    assert.deepEqual(fs.readdirSync(dir).sort(), [".DS_Store", "Thumbs.db"]);
    put("notes.txt", "mine");
    assert.throws(() => openShots(dir), /not empty and holds no earlier easyscreenshotkit run\. Pick another folder with --out\./);
    assert.throws(() => prepareDir(dir), /not empty/);
    assert.deepEqual(fs.readdirSync(dir).sort(), [".DS_Store", "Thumbs.db", "notes.txt"]);
    for (const name of [".DS_Store", "Thumbs.db", "notes.txt"]) fs.rmSync(path.join(dir, name));
    // A run from 0.1.1, with files of the user's next to it and in pwa/.
    put("manifest.json", JSON.stringify({ version: 1, tool: "easyscreenshotkit 0.1.1" }));
    for (const file of ["01-home-desktop.png", "02-pricing-desktop.png", "sheet.png", "SCREENSHOTS.md", "pwa/manifest-screenshots.json", "pwa/screenshots/wide-01.png"]) put(file, `old ${file}`);
    put("keep-me.txt", "mine");
    put("pwa/screenshots/mine.png", "mine");
    const before = snapshot(dir);
    prepareDir(dir);
    assert.deepEqual(snapshot(dir), before, "prepareDir only checks");

    // A run that is stopped or fails leaves the folder exactly as it was.
    const stopped = openShots(dir, { pwa: true });
    assert.equal(path.dirname(stopped.part), path.resolve(dir));
    assert.match(path.basename(stopped.part), /^\.easyscreenshotkit-part-\d+-[0-9a-f]{8}$/);
    stopped.write("01-home-desktop.png", "new");
    stopped.write("pwa/screenshots/wide-01.png", "new");
    assert.deepEqual(snapshot(dir)["01-home-desktop.png"], before["01-home-desktop.png"]);
    stopped.abort();
    stopped.abort();
    assert.deepEqual(snapshot(dir), before);
    assert.throws(() => stopped.write("02-x-desktop.png", "late"), /stopped/);
    assert.deepEqual(snapshot(dir), before, "a write after the stop does not make the part folder again");

    // A folder named like a picture of a run is refused before the run, as
    // the pictures' names are known only as their pages are found.
    put("03-features-desktop.png/inside.txt", "a folder named like a file of the run");
    assert.throws(() => openShots(dir), /shots\/03-features-desktop\.png is a folder named like the pictures this run saves there\. Move it, or pick another folder with --out\./);
    put("pwa/screenshots/narrow-02.png/inside.txt", "the same in pwa/screenshots");
    fs.renameSync(path.join(dir, "03-features-desktop.png"), path.join(root, "aside"));
    assert.throws(() => openShots(dir, { pwa: true }), /shots\/pwa\/screenshots\/narrow-02\.png is a folder named like the pictures this run saves there\./);
    openShots(dir).abort();
    fs.rmSync(path.join(dir, "pwa", "screenshots", "narrow-02.png"), { recursive: true });

    // A commit that cannot finish puts back what it moved: here a folder
    // that came, while the run worked, where it saves one of its files.
    const held = snapshot(dir);
    const blocked = openShots(dir);
    fs.renameSync(path.join(root, "aside"), path.join(dir, "03-features-desktop.png"));
    const heldNow = Object.fromEntries(Object.entries(snapshot(dir)).filter(([rel]) => !rel.startsWith(".easyscreenshotkit-part-")));
    blocked.write("01-home-desktop.png", "new home");
    blocked.write("03-features-desktop.png", "new features");
    blocked.write("manifest.json", "{}");
    assert.throws(
      () => blocked.commit(["01-home-desktop.png", "03-features-desktop.png", "manifest.json"]),
      /^Error: Could not move this run's files into .*shots: .*03-features-desktop\.png: a folder of that name is in the way\. What the folder held before this run is as it was\.$/,
    );
    assert.deepEqual(snapshot(dir), heldNow);
    fs.rmSync(path.join(dir, "03-features-desktop.png"), { recursive: true });
    assert.deepEqual(snapshot(dir), held);

    // The part folder of a run killed outright an hour ago goes once a run
    // ends well; one whose process still runs, or that changed lately, stays.
    const dead = path.join(dir, ".easyscreenshotkit-part-99999999-0123abcd");
    const busy = path.join(dir, ".easyscreenshotkit-part-99999999-4567cdef");
    const alive = path.join(dir, `.easyscreenshotkit-part-${process.ppid}-89abcdef`);
    for (const folder of [dead, busy, alive]) {
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder, "01-home-desktop.png"), "left");
      if (folder !== busy) for (const at of [path.join(folder, "01-home-desktop.png"), folder]) fs.utimesSync(at, hourAgo(), hourAgo());
    }
    // A run that ends well: its files in place of the earlier run's, the
    // user's files and folders as they were.
    const good = openShots(dir);
    good.write("01-home-desktop.png", "new home");
    good.write("SCREENSHOTS.md", "new md");
    good.write("manifest.json", JSON.stringify({ version: 1, tool: "easyscreenshotkit 0.1.2" }));
    good.commit(["01-home-desktop.png", "SCREENSHOTS.md", "manifest.json"]);
    const after = snapshot(dir);
    const text = (rel) => Buffer.from(after[rel], "base64").toString();
    assert.deepEqual(
      Object.keys(after).filter((rel) => !rel.startsWith(".easyscreenshotkit-part-")).sort(),
      ["01-home-desktop.png", "SCREENSHOTS.md", "keep-me.txt", "manifest.json", "pwa/", "pwa/screenshots/", "pwa/screenshots/mine.png"],
    );
    assert.deepEqual([text("01-home-desktop.png"), text("SCREENSHOTS.md"), text("keep-me.txt"), text("pwa/screenshots/mine.png")], ["new home", "new md", "mine", "mine"]);
    assert.deepEqual([fs.existsSync(dead), fs.existsSync(busy), fs.existsSync(alive)], [false, true, true]);
    fs.rmSync(busy, { recursive: true });
    fs.rmSync(alive, { recursive: true });

    // With --pwa, a file where its folder goes is refused before the run.
    fs.rmSync(path.join(dir, "pwa"), { recursive: true });
    put("pwa", "a file");
    assert.throws(() => openShots(dir, { pwa: true }), /shots\/pwa is a file, and this run saves a folder of that name there\. Move it, or pick another folder with --out\./);
    assert.throws(() => openShots(path.join(dir, "keep-me.txt")), /EEXIST|ENOTDIR/);
    fs.rmSync(path.join(dir, "pwa"));

    // A pwa that is a link to a folder elsewhere: a run without --pwa ends
    // well and leaves the link and what it leads to alone; one with --pwa is
    // refused before it starts.
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(path.join(elsewhere, "screenshots"), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, "manifest-screenshots.json"), "mine");
    fs.writeFileSync(path.join(elsewhere, "screenshots", "wide-01.png"), "mine");
    let linked = true;
    try {
      fs.symlinkSync(elsewhere, path.join(dir, "pwa"), "junction");
    } catch {
      // Windows without the right to make links.
      linked = false;
    }
    if (linked) {
      const theirs = snapshot(elsewhere);
      const through = openShots(dir);
      through.write("01-home-desktop.png", "through");
      through.write("manifest.json", JSON.stringify({ version: 1, tool: "easyscreenshotkit 0.1.2" }));
      through.commit(["01-home-desktop.png", "manifest.json"]);
      assert.deepEqual(snapshot(elsewhere), theirs);
      assert.ok(fs.lstatSync(path.join(dir, "pwa")).isSymbolicLink());
      assert.throws(() => openShots(dir, { pwa: true }), /shots\/pwa is a link, and this run saves a folder of that name there\./);
      fs.rmSync(path.join(dir, "pwa"));
    }

    // A run from when the tool was called easyscreenshot counts too, another
    // tool's does not.
    put("manifest.json", JSON.stringify({ version: 1, tool: "easyscreenshot 0.1.0" }));
    openShots(dir).abort();
    put("manifest.json", JSON.stringify({ version: 1, tool: "easyscreenshotter 1.0.0" }));
    assert.throws(() => openShots(dir), /no earlier easyscreenshotkit run/);

    // A new folder is made for the run, and goes again, with the folders
    // made for it, when the run does not end well.
    const fresh = path.join(root, "a", "b", "shots");
    const run = openShots(fresh);
    assert.ok(fs.existsSync(run.part));
    run.abort();
    assert.equal(fs.existsSync(path.join(root, "a")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
