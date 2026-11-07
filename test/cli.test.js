"use strict";

// The command line and the rules that need no browser: options, sizes,
// addresses, file names and the output folder.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { parse, summary } = require("../skills/easyscreenshotkit/scripts/easyscreenshotkit");
const { parseSizes, normalizeUrl, prepareDir, slugOf, identity, movedOn, pagesAsked, siteName } = require("../skills/easyscreenshotkit/scripts/lib/shots");
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
  assert.equal(slugOf("https://acme.com/app/#/%F0%9F%8C%BF", home), "app");
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
    skipped: [{ url: "https://acme.com/app/#/light", reason: "a #route, which the tour does not follow: give it with --page" }],
    notes: [],
  };
  const text = summary({ dir: "shots", manifest });
  assert.match(text, /01 app-plants {2}\/app\/#\/plants {2}\(the address given\)/);
  assert.match(text, /Skipped \/app\/#\/light \(a #route, which the tour does not follow: give it with --page\)/);
  assert.match(sheetHtml(manifest, "shots"), /<span>\/app\/#\/plants<\/span>/);
});

test("never writes into a folder that holds someone else's files, and replaces an earlier run's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-dir-"));
  try {
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    assert.throws(() => prepareDir(dir), /not empty/);
    fs.rmSync(path.join(dir, "notes.txt"));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, tool: "easyscreenshotkit 0.1.0" }));
    fs.writeFileSync(path.join(dir, "01-home-desktop.png"), "old");
    fs.writeFileSync(path.join(dir, "keep-me.txt"), "mine");
    prepareDir(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["keep-me.txt"]);
    // A run from when the tool was called easyscreenshot counts too, another
    // tool's does not.
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, tool: "easyscreenshot 0.1.0" }));
    fs.writeFileSync(path.join(dir, "01-home-desktop.png"), "old");
    prepareDir(dir);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["keep-me.txt"]);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, tool: "easyscreenshotter 1.0.0" }));
    assert.throws(() => prepareDir(dir), /no earlier easyscreenshotkit run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
