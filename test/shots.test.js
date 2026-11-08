"use strict";

// The whole run in a real headless browser (skipped when none is installed),
// against a small site served from this process: which pages are picked and
// which are left out, what the clean-up hides, the sizes, themes and
// languages, and the files written.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { takeShots, DEVICES } = require("../skills/easyscreenshotkit/scripts/lib/shots");
const { findChrome, launch, openTab, closeTab, navigate } = require("../skills/easyscreenshotkit/scripts/lib/chrome");
const { setTimeLimit, sleep } = require("../skills/easyscreenshotkit/scripts/lib/time");
const { watchRequests, networkQuiet } = require("../skills/easyscreenshotkit/scripts/lib/page");
const { LOCATE } = require("../skills/easyscreenshotkit/scripts/lib/record");
const { pngText } = require("../skills/easyscreenshotkit/scripts/lib/png");
const { readPng, serve, near } = require("./helpers");

const CLI = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/easyscreenshotkit.js");
const noBrowser = !findChrome() && "no Chrome, Chromium, Edge or Brave installed";

const RED = [200, 0, 0];
const GREEN = [0, 160, 0];
const ORANGE = [255, 140, 0];
const BLUE = [0, 0, 220];
const MAGENTA = [255, 0, 255];
const WHITE = [255, 255, 255];
const PURPLE = [120, 0, 200];
const PICTURE = [230, 120, 0];
const SKY = [0, 120, 255];
const TEAL = [0, 200, 200];

const page = (title, body, { head = "", lang = "en", style = "" } = {}) =>
  `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${head}<style>body{margin:0;font-family:sans-serif}${style}</style></head><body>${body}</body></html>`;

// The home page: a fixed red header with the menu, a static consent banner
// with a known tool's id, a green hero with a button, a picture that gets
// its address only once it is seen, a bar that counts up when it comes into
// view, a dark footer, and floating over it all a blue cookie bar and a
// magenta chat bubble.
const HOME = page(
  "Acme | Tools for teams",
  `<header><a href="/">Acme</a><nav>
    <a href="/pricing">Pricing</a><a href="/features">Features</a><a href="/old-features">Product tour</a>
    <a href="/customers">Customers</a><a href="/blog">Blog</a><a href="/docs">Docs</a><a href="/login">Log in</a>
    <div class="drop"><a href="/integrations">Integrations</a></div>
  </nav></header>
  <div id="onetrust-banner-sdk">We use cookies</div>
  <div class="hero"><h1>Tools for teams</h1><a class="btn" href="/start">How it works</a></div>
  <section id="s1"><img class="lazy" alt=""></section>
  <section id="s2"><h2>Fast</h2><div class="counter"><div class="fill"></div></div></section>
  <footer><a href="/about">About</a><a href="/careers">Careers</a><a href="/privacy">Privacy</a><a href="/blog/first-post">First post</a><a href="/pricing">Pricing</a></footer>
  <div class="cookie">We use cookies. Accept?</div><div class="chat"></div>
  <script>
    const img = document.querySelector(".lazy");
    new IntersectionObserver((entries, io) => { if (entries[0].isIntersecting) { img.src = "/picture.svg"; io.disconnect(); } }).observe(img);
    const fill = document.querySelector(".fill");
    new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      let width = 0;
      const timer = setInterval(() => { width += 30; fill.style.width = Math.min(300, width) + "px"; if (width >= 300) clearInterval(timer); }, 90);
    }).observe(fill);
  </script>`,
  {
    head: '<meta name="description" content="Acme makes tools for teams."><meta property="og:site_name" content="Acme"><link rel="alternate" hreflang="tr" href="/tr/"><link rel="manifest" href="/app.webmanifest">',
    style: `
    header{position:fixed;top:0;left:0;right:0;height:60px;background:rgb(200,0,0);z-index:10}
    header a{color:#fff;margin:0 6px}
    .drop{display:none}
    #onetrust-banner-sdk{height:120px;background:rgb(255,140,0)}
    .hero{height:700px;background:rgb(0,160,0);padding-top:60px;box-sizing:border-box}
    .hero h1{margin:0}
    .btn{display:inline-block;padding:14px 20px;background:rgb(0,0,0);color:#fff}
    section{height:900px;background:rgb(255,255,255);overflow:hidden}
    section h2{margin:0;height:40px}
    .lazy{display:block;width:400px;height:300px;margin:100px auto 0}
    .counter{width:300px;height:20px;background:rgb(235,235,235)}
    .fill{width:0;height:20px;background:rgb(120,0,200)}
    footer{height:200px;background:rgb(30,30,30)}
    .cookie{position:fixed;left:0;right:0;bottom:0;height:70px;background:rgb(0,0,220);z-index:20}
    .chat{position:fixed;right:20px;bottom:90px;width:60px;height:60px;border-radius:30px;background:rgb(255,0,255);z-index:20}
    @media (prefers-color-scheme: dark){ body{background:rgb(10,10,10)} .hero{background:rgb(0,60,0)} }
    @media (max-width: 600px){ .hero{background:rgb(250,220,0)} }`,
  },
);

// Pricing: a consent dialog over a backdrop, with the page pinned so it
// cannot scroll until the dialog is answered.
const PRICING = page(
  "Pricing | Acme",
  `<h1>Pricing <a href="/">Home</a></h1><div class="plans"></div><div class="end"></div>
  <div class="backdrop"></div><div class="dialog">We value your privacy <button>Accept</button></div>`,
  {
    style: `
    body{position:fixed;top:0;left:0;right:0;overflow:hidden}
    h1{margin:0;height:100px}
    .plans{height:3000px;background:rgb(0,120,255)}
    .end{height:100px;background:rgb(0,0,0)}
    .backdrop{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:50}
    .dialog{position:fixed;left:500px;top:300px;width:600px;height:300px;background:#fff;z-index:51}`,
  },
);

const simple = (title, color = "rgb(240,240,240)", extra = "") => page(`${title} | Acme`, `<h1>${title}</h1><div style="height:1400px;background:${color}"></div><a href="/">Home</a>${extra}`);

async function fixture() {
  const seen = [];
  let origin = "";
  const { server, origin: base } = await serve((req, res) => {
    const agent = String(req.headers["user-agent"] || "");
    seen.push({ url: req.url, agent, lang: String(req.headers["accept-language"] || "") });
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    const go = (code, to) => res.writeHead(code, { Location: to }).end();
    switch (req.url) {
      case "/":
        return html(HOME);
      case "/pricing":
        return html(PRICING);
      case "/features":
        // The server picks the phone layout by the browser, as some sites do.
        return html(/Android/.test(agent) ? simple("Features", "rgb(0,200,200)") : /iPhone/.test(agent) ? simple("Features", "rgb(0,200,200)") : simple("Features"));
      case "/old-features":
        return go(301, "/features");
      case "/start":
        return go(302, "/login");
      case "/docs":
        return html(page("Just a moment...", "<p>Checking your browser before accessing the site.</p>"));
      case "/integrations":
        return html(simple("Integrations"));
      case "/blog":
        return html(simple("Blog"));
      case "/changelog":
        return html(simple("Changelog"));
      case "/about":
      case "/customers":
      case "/careers":
      case "/privacy":
      case "/login":
        return html(simple(req.url.slice(1)));
      case "/tr/":
        return html(page("Acme | Ekipler için araçlar", '<h1>Ekipler için araçlar</h1><nav><a href="/tr/fiyatlar">Fiyatlar</a><a href="/tr/giris">Giriş</a></nav><div style="height:1400px;background:rgb(0,160,0)"></div>', { lang: "tr" }));
      case "/tr/fiyatlar":
        return html(page("Fiyatlar | Acme", '<h1>Fiyatlar</h1><div style="height:1400px"></div><a href="/tr/">Ana sayfa</a>', { lang: "tr" }));
      case "/picture.svg":
        return setTimeout(() => res.writeHead(200, { "Content-Type": "image/svg+xml" }).end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="rgb(230,120,0)"/></svg>'), 300);
      case "/app.webmanifest":
        return res.writeHead(200, { "Content-Type": "application/manifest+json" }).end(JSON.stringify({ name: "Acme", start_url: "/", display: "standalone" }));
      case "/robots.txt":
        return res.end(`User-agent: *\nDisallow: /customers\n\nSitemap: ${origin}/sitemap.xml\n`);
      case "/sitemap.xml":
        return res.end(`<urlset><url><loc>${origin}/</loc></url><url><loc>${origin}/pricing</loc></url><url><loc>${origin}/changelog</loc></url></urlset>`);
      default:
        res.writeHead(404).end("not found");
    }
  });
  origin = base;
  return { server, origin, seen };
}

// The CLI in a child process. Not spawnSync: the test's own server must go on
// answering while the child runs.
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-run-"));
const css = (png, scale, x, y) => png.pixel(Math.round(x * scale), Math.round(y * scale));

test("picks the pages worth showing and leaves the rest out with reasons", { skip: noBrowser, timeout: 280_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(origin, { dir, timeLimit: 240_000 });
    const pathOf = (url) => new URL(url).pathname;
    assert.deepEqual(
      manifest.pages.map((p) => [p.n, p.slug, pathOf(p.url), p.kind]),
      [
        [1, "home", "/", "home"],
        [2, "pricing", "/pricing", "pricing"],
        [3, "features", "/features", "product"],
        [4, "integrations", "/integrations", "integrations"],
        [5, "blog", "/blog", "blog"],
      ],
    );
    assert.equal(manifest.site, "Acme");
    assert.equal(manifest.pages[1].why, 'menu link "Pricing"');
    const reasons = Object.fromEntries(manifest.skipped.map((s) => [pathOf(s.url), s.reason]));
    assert.equal(reasons["/old-features"], "the same page as features");
    assert.equal(reasons["/start"], "redirected to a sign-in page");
    assert.equal(reasons["/docs"], "a bot check instead of the page");
    assert.equal(reasons["/customers"], "robots.txt asks crawlers to stay out");
    assert.equal(reasons["/login"], "sign-in or sign-up page");
    assert.equal(reasons["/privacy"], "legal page");
    assert.equal(reasons["/careers"], "not a product page");
    assert.equal(reasons["/blog/first-post"], "a single post");
    assert.ok(!seen.some((r) => r.url === "/customers"), "a page robots.txt closes is never opened");
    assert.ok(manifest.candidates.some((c) => pathOf(c.url) === "/changelog"), "the sitemap's page is offered");

    // Every page on the desktop, its whole page, and the phone.
    for (const p of manifest.pages) {
      assert.deepEqual(p.shots.map((s) => s.size), ["desktop", "full", "mobile"], p.slug);
      for (const s of p.shots) assert.ok(fs.existsSync(path.join(dir, s.file)), s.file);
    }
    const home = Object.fromEntries(manifest.pages[0].shots.map((s) => [s.size, s]));
    assert.equal(home.desktop.file, "01-home-desktop.png");
    assert.deepEqual([home.desktop.width, home.desktop.height], [3200, 1800]);
    assert.deepEqual([home.mobile.width, home.mobile.height], [1080, 1920]);
    assert.equal(home.full.width, 1600);

    // The first screen: the header stays; the consent banner, the cookie bar
    // and the chat bubble are gone.
    const desktop = readPng(path.join(dir, home.desktop.file));
    assert.ok(near(css(desktop, 2, 800, 30), RED), "header kept");
    assert.ok(near(css(desktop, 2, 800, 100), GREEN), `consent banner hidden: ${css(desktop, 2, 800, 100)}`);
    assert.ok(!near(css(desktop, 2, 200, 880), BLUE), "cookie bar hidden");
    assert.ok(near(css(desktop, 2, 200, 880), WHITE), `below the hero: ${css(desktop, 2, 200, 880)}`);
    assert.ok(!near(css(desktop, 2, 1550, 780), MAGENTA), "chat bubble hidden");
    assert.ok(manifest.pages[0].hidden >= 3, `hidden: ${manifest.pages[0].hidden}`);
    const h1 = home.desktop.headings.find((h) => h.level === 1);
    assert.equal(h1.text, "Tools for teams");
    assert.equal(h1.box[1], 120, "the heading's box is in the image's pixels");

    // The whole page: the lazy picture, the finished count-up, the header
    // once, the footer at the end.
    const full = readPng(path.join(dir, home.full.file));
    assert.equal(full.height, 2700);
    assert.ok(near(full.pixel(800, 950), PICTURE), `lazy picture: ${full.pixel(800, 950)}`);
    assert.ok(near(full.pixel(290, 1650), PURPLE), `count-up finished: ${full.pixel(290, 1650)}`);
    assert.ok(near(full.pixel(800, 30), RED), "header at the top");
    assert.ok(near(full.pixel(200, 930), WHITE), `header not again further down: ${full.pixel(200, 930)}`);
    assert.ok(near(full.pixel(800, 2650), [30, 30, 30]), "footer at the end");
    assert.ok(home.full.sections.some((s) => s.heading === "Fast"), JSON.stringify(home.full.sections));

    // The phone: the site's phone layout.
    const phone = readPng(path.join(dir, home.mobile.file));
    assert.ok(near(css(phone, 3, 180, 300), [250, 220, 0]), `phone layout: ${css(phone, 3, 180, 300)}`);
    const features = manifest.pages[2].shots.find((s) => s.size === "mobile");
    assert.ok(near(css(readPng(path.join(dir, features.file)), 3, 180, 300), TEAL), "the server saw an Android phone");
    assert.ok(seen.some((r) => r.url === "/features" && /Android 14; Pixel 8/.test(r.agent)));

    // Pricing: the dialog and its backdrop are gone and the page scrolls
    // again, so the whole page is there.
    const pricing = Object.fromEntries(manifest.pages[1].shots.map((s) => [s.size, s]));
    assert.ok(near(css(readPng(path.join(dir, pricing.desktop.file)), 2, 300, 600), SKY), "no backdrop over the first screen");
    const pricingFull = readPng(path.join(dir, pricing.full.file));
    assert.equal(pricingFull.height, 3200);
    assert.ok(near(pricingFull.pixel(800, 3150), [0, 0, 0]), "the end of the pinned page");
    assert.ok(manifest.pages[1].notes.includes("scroll unlocked"));

    // The files tell where they came from; the summary files are written.
    assert.equal(pngText(fs.readFileSync(path.join(dir, home.desktop.file))).Source, `${origin}/`);
    const md = fs.readFileSync(path.join(dir, "SCREENSHOTS.md"), "utf8");
    assert.match(md, /^# Screenshots of Acme/);
    assert.match(md, /## 02 pricing/);
    assert.match(md, /\/docs: a bot check instead of the page/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).pages.length, 5);
    assert.ok(manifest.sheet && manifest.sheet.width === 1600 && fs.existsSync(path.join(dir, "sheet.png")));
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("one page on an iPhone and a custom size, in the dark", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(`${origin}/`, { dir, pages: 1, sizes: "iphone,1270x760@2", theme: "dark", timeLimit: 100_000 });
    assert.equal(manifest.pages.length, 1);
    const shots = Object.fromEntries(manifest.pages[0].shots.map((s) => [s.size, s]));
    assert.equal(shots.iphone.file, "01-home-iphone-dark.png");
    assert.deepEqual([shots.iphone.width, shots.iphone.height], [1320, 2868]);
    assert.deepEqual([shots["1270x760"].width, shots["1270x760"].height], [2540, 1520]);
    assert.ok(seen.some((r) => /iPhone OS/.test(r.agent)), "the server saw an iPhone");
    const wide = readPng(path.join(dir, shots["1270x760"].file));
    assert.ok(near(css(wide, 2, 600, 300), [0, 60, 0]), `dark hero: ${css(wide, 2, 600, 300)}`);
    assert.ok(manifest.notes.some((note) => /prefers-color-scheme/.test(note)));
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("--pwa: screenshots for a web app manifest, cleaned like the rest, and the site's own manifest read", { skip: noBrowser, timeout: 150_000 }, async () => {
  const { server, origin } = await fixture();
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(origin, { dir, pages: 2, sizes: "desktop", pwa: true, timeLimit: 130_000 });
    // The run's own files are what they are without --pwa.
    assert.deepEqual(manifest.sizes.map((s) => s.size), ["desktop"]);
    for (const p of manifest.pages) assert.deepEqual(p.shots.map((s) => s.size), ["desktop"], p.slug);
    const { pwa } = manifest;
    assert.equal(pwa.file, "pwa/manifest-screenshots.json");
    assert.deepEqual(
      pwa.screenshots.map((s) => [s.file, s.page, s.src, s.sizes, s.type, s.form_factor]),
      [
        ["pwa/screenshots/wide-01.png", 1, "screenshots/wide-01.png", "1920x1080", "image/png", "wide"],
        ["pwa/screenshots/wide-02.png", 2, "screenshots/wide-02.png", "1920x1080", "image/png", "wide"],
        ["pwa/screenshots/narrow-01.png", 1, "screenshots/narrow-01.png", "1080x1920", "image/png", "narrow"],
        ["pwa/screenshots/narrow-02.png", 2, "screenshots/narrow-02.png", "1080x1920", "image/png", "narrow"],
      ],
    );
    assert.equal(pwa.screenshots[0].label, "Tools for teams");
    assert.deepEqual(pwa.leftOut, []);
    const written = JSON.parse(fs.readFileSync(path.join(dir, pwa.file), "utf8"));
    assert.deepEqual(written.screenshots, pwa.screenshots.map(({ file, page, ...entry }) => entry));

    // 1920x1080 from the 2x desktop window: the header stays, the consent
    // banner and the cookie bar go.
    const wide = readPng(path.join(dir, "pwa/screenshots/wide-01.png"));
    assert.deepEqual([wide.width, wide.height], [1920, 1080]);
    assert.ok(near(css(wide, 1.2, 800, 30), RED), "header kept");
    assert.ok(near(css(wide, 1.2, 800, 300), GREEN), `consent banner hidden: ${css(wide, 1.2, 800, 300)}`);
    assert.ok(near(css(wide, 1.2, 200, 880), WHITE), `cookie bar hidden: ${css(wide, 1.2, 200, 880)}`);
    // The phone, in a window of its own as --sizes has none: its layout.
    const narrow = readPng(path.join(dir, "pwa/screenshots/narrow-01.png"));
    assert.deepEqual([narrow.width, narrow.height], [1080, 1920]);
    assert.ok(near(css(narrow, 3, 180, 300), [250, 220, 0]), `phone layout: ${css(narrow, 3, 180, 300)}`);
    assert.equal(pngText(fs.readFileSync(path.join(dir, "pwa/screenshots/narrow-01.png"))).Source, `${origin}/`);

    // The site's own manifest, found on the home page and read.
    assert.equal(pwa.site.manifest, `${origin}/app.webmanifest`);
    assert.equal(pwa.site.screenshots, 0);
    assert.match(pwa.note, /lists no screenshots yet\. Put pwa\/screenshots next to it, in \/ on the site/);
    assert.match(fs.readFileSync(path.join(dir, "SCREENSHOTS.md"), "utf8"), /## Screenshots for a web app manifest[\s\S]*\| pwa\/screenshots\/wide-01\.png \| 1920x1080 \| wide \| 01 home \| Tools for teams \|/);
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("a language the site names: its own page in that language, and the browser asks for it", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { server, origin, seen } = await fixture();
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(origin, { dir, pages: 2, sizes: "desktop", lang: "tr", timeLimit: 100_000 });
    assert.deepEqual(manifest.pages.map((p) => new URL(p.url).pathname), ["/tr/", "/tr/fiyatlar"]);
    assert.equal(manifest.pages[1].slug, "fiyatlar");
    assert.equal(manifest.pages[1].kind, "pricing");
    assert.equal(manifest.lang, "tr");
    assert.ok(seen.some((r) => r.url === "/tr/fiyatlar" && /^tr\b/.test(r.lang)), JSON.stringify(seen.map((r) => r.lang)));
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("--no-clean keeps the floating boxes; --hide hides more; --json prints the manifest", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  try {
    const raw = await runCli([origin, "--pages", "1", "--sizes", "desktop", "--no-clean", "--json", "--out", path.join(root, "raw")]);
    assert.equal(raw.status, 0, raw.stderr);
    const manifest = JSON.parse(raw.stdout);
    const kept = readPng(path.join(root, "raw", manifest.pages[0].shots[0].file));
    assert.ok(near(css(kept, 2, 200, 880), BLUE), "cookie bar kept");
    assert.ok(near(css(kept, 2, 800, 100), ORANGE), "consent banner kept");

    const { manifest: hidden } = await takeShots(origin, { dir: path.join(root, "hide"), pages: 1, sizes: "desktop", hide: [".hero", "]bad["], timeLimit: 100_000 });
    const png = readPng(path.join(root, "hide", hidden.pages[0].shots[0].file));
    assert.ok(near(css(png, 2, 200, 300), WHITE), `the hero hidden: ${css(png, 2, 200, 300)}`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A single page app with hash routes. Each view asks /api/<view> for its
// data, which comes after `delay` ms, and draws "Loading…" until then: the
// same few nodes at the same height, so only the requests tell it is not
// done. Each view has a heading and a colour of its own. #/private sends
// itself on to #/login. At the root, the app opens on #/dashboard when the
// address has no route. At /hit/, each view sends a hit with keepalive once
// it is drawn, as an analytics tag does, and does not read the answer:
// answered with no-store, Chrome never says such a request has finished.
// With early, the data's answer sends its headers at once, a first byte of
// its body a second later and the rest at `delay`, as an API that streams,
// or flushes its headers before its slow query, does.
const VIEWS = {
  dashboard: ["Dashboard", [0, 120, 255]],
  today: ["Today", [0, 160, 0]],
  plants: ["Your plants", [200, 0, 0]],
  "plant/Fern": ["Fern", [120, 0, 200]],
  light: ["Light check", [255, 140, 0]],
  login: ["Sign in", [0, 200, 200]],
  settings: ["Settings", [250, 220, 0]],
};
const APP = (root, { hit = false } = {}) =>
  page(
    "App | Acme",
    `<nav><a href="#/today">Today</a> <a href="#/plants">Plants</a> <a href="#/light">Light</a> <a href="#/settings">Settings</a></nav>
    <main id="view"><h1>Loading…</h1><div class="band"></div></main>
    ${root ? "" : '<footer><a href="/app/">App home</a></footer>'}
    <script>
      ${root ? 'if (!location.hash) location.replace("#/dashboard");' : ""}
      const view = document.getElementById("view");
      async function go() {
        const route = (location.hash || "#/today").slice(2);
        if (route === "private") return location.replace("#/login");
        view.innerHTML = '<h1>Loading…</h1><div class="band"></div>';
        const data = await (await fetch("/api/" + route)).json();
        if ((location.hash || "#/today").slice(2) !== route) return;
        view.innerHTML = '<h1>' + data.title + '</h1><div class="band" style="background:' + data.color + '"></div>';
        document.title = data.title + " | Acme";
        ${hit ? 'fetch("/api/hit", { method: "POST", keepalive: true, body: route });' : ""}
      }
      addEventListener("hashchange", go);
      go();
    </script>`,
    { style: "nav{height:60px;background:rgb(30,30,30)} nav a{color:#fff;margin:0 10px} h1{margin:0;height:60px} .band{height:1200px;background:rgb(240,240,240)}" },
  );

async function appFixture({ delay = 5_000, early = false } = {}) {
  const { server, origin } = await serve((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = (body) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(body);
    if (url.pathname === "/") return html(APP(true));
    if (url.pathname === "/app/") return html(APP(false));
    if (url.pathname === "/hit/") return html(APP(false, { hit: true }));
    if (url.pathname === "/api/hit") return res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end("{}");
    if (url.pathname === "/app") return res.writeHead(301, { Location: "/app/" }).end();
    const view = url.pathname.startsWith("/api/") ? VIEWS[decodeURIComponent(url.pathname.slice(5))] : null;
    const answer = view && JSON.stringify({ title: view[0], color: `rgb(${view[1].join(",")})` });
    if (view && early) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      setTimeout(() => res.write(" "), Math.min(1_000, delay / 2));
      return setTimeout(() => res.end(answer), delay);
    }
    if (view) return setTimeout(() => res.writeHead(200, { "Content-Type": "application/json" }).end(answer), delay);
    res.writeHead(404).end("not found");
  });
  return { server, origin };
}

test("a #route in the address and in --page: each view opened, waited for and named after its route", { skip: noBrowser, timeout: 150_000 }, async () => {
  const { server, origin } = await appFixture();
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(`${origin}/app/#/plants`, {
      dir,
      pages: 1,
      sizes: "desktop",
      extra: ["/app/#/plant/Fern", "/app/#/plants", "/app/#/private"],
      timeLimit: 130_000,
    });
    assert.equal(manifest.url, `${origin}/app/#/plants`);
    assert.deepEqual(
      manifest.pages.map((p) => [p.n, p.slug, p.url, p.heading, p.shots.map((s) => s.file)]),
      [
        [1, "app-plants", `${origin}/app/#/plants`, "Your plants", ["01-app-plants-desktop.png"]],
        [2, "app-plant-fern", `${origin}/app/#/plant/Fern`, "Fern", ["02-app-plant-fern-desktop.png"]],
        [3, "app-login", `${origin}/app/#/login`, "Sign in", ["03-app-login-desktop.png"]],
      ],
    );
    assert.deepEqual(manifest.pages[2].notes, [`opened ${origin}/app/#/private and landed on ${origin}/app/#/login`]);
    assert.ok(manifest.notes.includes(`${origin}/app/#/plants was asked for but not taken: the same page as app-plants.`), manifest.notes.join("\n"));
    // Each picture shows its view, drawn once its data had come.
    for (const [p, view] of [[0, "plants"], [1, "plant/Fern"], [2, "login"]]) {
      const png = readPng(path.join(dir, manifest.pages[p].shots[0].file));
      assert.ok(near(css(png, 2, 800, 400), VIEWS[view][1]), `${view}: ${css(png, 2, 800, 400)}`);
    }
    assert.equal(pngText(fs.readFileSync(path.join(dir, "01-app-plants-desktop.png"))).Source, `${origin}/app/#/plants`);
    assert.match(fs.readFileSync(path.join(dir, "SCREENSHOTS.md"), "utf8"), /## 02 app-plant-fern\n\n- Address: http:\/\/127\.0\.0\.1:\d+\/app\/#\/plant\/Fern/);
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

// What the browser says of each request, played to the network wait by
// hand. A request is done once the browser says it ended. Chrome never
// says so of a fetch sent with keepalive, so one whose whole answer came
// by its Content-Length is done too, and one that is not a GET once some
// of its answer came and nothing more for half a second. A GET with no
// length is waited for to its end, whatever came first: its headers, or
// the first part of its data.
test("the network wait: a request is done once it ends or its whole answer came, and a GET whose headers came first is waited for", async () => {
  const listeners = {};
  const cdp = { on: (method, fn) => (listeners[method] = listeners[method] || []).push(fn), send: async () => ({}) };
  const emit = (method, params) => (listeners[method] || []).forEach((fn) => fn(params));
  const sent = (requestId, method, type = "Fetch") => emit("Network.requestWillBeSent", { requestId, type, request: { method } });
  const answer = (requestId, headers = {}, status = 200) => emit("Network.responseReceived", { requestId, response: { status, headers } });
  const data = (requestId, encodedDataLength) => emit("Network.dataReceived", { requestId, dataLength: encodedDataLength, encodedDataLength });
  await watchRequests(cdp);
  // A view's data: its headers come at once, and a first part of its body;
  // another's headers only.
  sent("data", "GET");
  answer("data", { "Content-Type": "application/json" });
  data("data", 1);
  sent("more", "GET");
  answer("more", { "Content-Type": "application/json" });
  // Hits sent with keepalive, which never end: a POST with no length, a
  // GET with one, and a song, which is never waited for.
  sent("post-hit", "POST");
  answer("post-hit");
  data("post-hit", 17);
  sent("get-hit", "GET");
  answer("get-hit", { "content-length": "43" });
  data("get-hit", 43);
  sent("song", "GET", "Media");
  sent("empty", "POST");
  answer("empty", {}, 204);
  await sleep(700);
  assert.equal(networkQuiet(cdp), false, "the data's GETs have not ended");
  data("data", 200);
  emit("Network.loadingFinished", { requestId: "more" });
  await sleep(700);
  assert.equal(networkQuiet(cdp), false, "nor has the first now, with no data for half a second");
  emit("Network.loadingFinished", { requestId: "data" });
  assert.equal(networkQuiet(cdp), false, "half a second after the last request");
  await sleep(600);
  assert.equal(networkQuiet(cdp), true, "the data ended, and every hit is done");
  // A GET whose length says more is to come is waited for.
  sent("part", "GET", "XHR");
  answer("part", { "Content-Length": "1000" });
  data("part", 600);
  await sleep(700);
  assert.equal(networkQuiet(cdp), false, "400 bytes of it are still to come");
  data("part", 400);
  await sleep(600);
  assert.equal(networkQuiet(cdp), true);
  // A POST that has had no answer yet is waited for.
  sent("query", "POST");
  answer("query");
  await sleep(700);
  assert.equal(networkQuiet(cdp), false, "a POST with headers only");
  emit("Network.loadingFailed", { requestId: "query" });
  await sleep(600);
  assert.equal(networkQuiet(cdp), true);
  // A stream's data, an EventSource's messages or a video's, comes and
  // comes: it never keeps the page busy.
  sent("events", "GET", "EventSource");
  sent("film", "GET", "Media");
  answer("events");
  answer("film", { "Content-Length": "9000000" });
  for (let i = 0; i < 5; i++) {
    data("events", 40);
    data("film", 65536);
    await sleep(150);
  }
  assert.equal(networkQuiet(cdp), true, "an EventSource and a video still sending");
});

test("a view that sends a hit with keepalive is not held for the whole wait", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { server, origin } = await appFixture({ delay: 300 });
  const dir = path.join(tempDir(), "shots");
  try {
    const started = Date.now();
    const { manifest } = await takeShots(`${origin}/hit/#/plants`, { dir, pages: 1, sizes: "desktop,mobile", extra: ["#/light"], timeLimit: 100_000 });
    assert.deepEqual(
      manifest.pages.map((p) => [p.slug, p.heading, p.notes]),
      [
        ["hit-plants", "Your plants", []],
        ["hit-light", "Light check", []],
      ],
    );
    // Two views on two sizes: held 10 s and 2 s each, this took over 25 s.
    assert.ok(Date.now() - started < 22_000, `took ${Date.now() - started} ms`);
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("a view whose data sends its headers first and its body seconds later is taken once the body came", { skip: noBrowser, timeout: 120_000 }, async () => {
  // Held 1.5 s after its headers came, or after its first byte, each view
  // was taken while it still said "Loading…".
  const { server, origin } = await appFixture({ delay: 4_000, early: true });
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(`${origin}/hit/#/plants`, { dir, pages: 1, sizes: "desktop", extra: ["#/light"], timeLimit: 100_000 });
    assert.deepEqual(
      manifest.pages.map((p) => [p.slug, p.heading, p.notes]),
      [
        ["hit-plants", "Your plants", []],
        ["hit-light", "Light check", []],
      ],
    );
    for (const [p, view] of [[0, "plants"], [1, "light"]]) {
      const png = readPng(path.join(dir, manifest.pages[p].shots[0].file));
      assert.ok(near(css(png, 2, 800, 400), VIEWS[view][1]), `${view}: ${css(png, 2, 800, 400)}`);
    }
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("an app at the site's root: the home page is home whatever route it opens on, and the #route links are listed", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { server, origin } = await appFixture({ delay: 1_500 });
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(origin, { dir, pages: 3, sizes: "desktop", extra: ["#/plants"], timeLimit: 100_000 });
    assert.deepEqual(
      manifest.pages.map((p) => [p.slug, p.url, p.heading, p.notes]),
      [
        ["home", `${origin}/#/dashboard`, "Dashboard", []],
        ["home-plants", `${origin}/#/plants`, "Your plants", []],
      ],
    );
    assert.equal(manifest.pages[0].shots[0].file, "01-home-desktop.png");
    // The views the tour does not open, with the reason; the one taken is
    // not among them.
    assert.deepEqual(
      manifest.skipped.map((s) => [s.url, s.reason]),
      ["today", "light", "settings"].map((view) => [`${origin}/#/${view}`, "a #route, which the tour does not follow: give it with --page"]),
    );
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("the #route links of the address given are listed with the pages left out, after the home page's, whatever the tour took", { skip: noBrowser, timeout: 120_000 }, async () => {
  const { server, origin } = await appFixture({ delay: 300 });
  const dir = path.join(tempDir(), "shots");
  try {
    const { manifest } = await takeShots(`${origin}/app/`, { dir, pages: 2, sizes: "desktop", timeLimit: 100_000 });
    assert.deepEqual(
      manifest.pages.map((p) => [p.slug, p.url]),
      [
        ["home", `${origin}/#/dashboard`],
        ["app", `${origin}/app/`],
      ],
    );
    const ROUTE = "a #route, which the tour does not follow: give it with --page";
    assert.deepEqual(
      manifest.skipped.map((s) => [s.url.slice(origin.length), s.reason]),
      ["/#/today", "/#/plants", "/#/light", "/#/settings", "/app/#/today", "/app/#/plants", "/app/#/light", "/app/#/settings"].map((view) => [view, ROUTE]),
    );
    assert.match(fs.readFileSync(path.join(dir, "SCREENSHOTS.md"), "utf8"), /- http:\/\/127\.0\.0\.1:\d+\/app\/#\/plants: a #route, which the tour does not follow: give it with --page/);
  } finally {
    server.close();
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("opening another #route of the page already open does not wait for a load that never comes", { skip: noBrowser, timeout: 60_000 }, async () => {
  const { server, origin } = await appFixture({ delay: 100 });
  // Enough time left for the 20 s a load is waited for.
  setTimeLimit(120_000);
  const chrome = await launch();
  try {
    const tab = await openTab(chrome, DEVICES.desktop);
    await navigate(tab, `${origin}/app/#/today`);
    const started = Date.now();
    const nav = await navigate(tab, `${origin}/app/#/plants`);
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
    assert.equal(nav.url, `${origin}/app/#/plants`);
    await closeTab(chrome, tab);
  } finally {
    await chrome.close();
    server.close();
  }
});

test("a demo's link to a #route is to that view, and its link to a page goes before a link to a view of it", { skip: noBrowser, timeout: 60_000 }, async () => {
  const { server, origin } = await appFixture({ delay: 100 });
  setTimeLimit(120_000);
  const chrome = await launch();
  try {
    const tab = await openTab(chrome, DEVICES.desktop);
    await navigate(tab, `${origin}/app/#/today`);
    const find = async (href) => (await tab.send("Runtime.evaluate", { expression: `${LOCATE}(${JSON.stringify({ href })})`, returnByValue: true })).result.value;
    assert.equal((await find(`${origin}/app/#/plants`)).text, "Plants");
    assert.equal((await find(`${origin}/app/#/light/`)).text, "Light");
    assert.equal((await find(`${origin}/app/`)).text, "App home");
    assert.equal(await find(`${origin}/app/#/nowhere`), null);
    await closeTab(chrome, tab);
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
// only, none elsewhere.
function profilesOf(pid) {
  try {
    const kids = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
    return kids.flatMap((kid) => {
      try {
        // Chrome writes its arguments back as one line.
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

// The processes whose command line names a profile, from /proc.
function runningWith(profile) {
  if (process.platform !== "linux") return [];
  return fs.readdirSync("/proc").filter((pid) => {
    try {
      return /^\d+$/.test(pid) && fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(`--user-data-dir=${profile}`);
    } catch {
      return false;
    }
  });
}

// The CLI in a child process, stopped with signal (to it, or to its whole
// process group as a supervisor sends it) once stopAt(stderr, pid) says so.
// profiles: those of the browsers it had going then; locks: their lock
// folders.
function stopCli(args, { stopAt, signal = "SIGTERM", group = false }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { detached: group });
    let stdout = "";
    let stderr = "";
    let sent = false;
    let profiles = [];
    let locks = [];
    const check = () => {
      if (sent || !stopAt(stderr, child.pid)) return;
      sent = true;
      profiles = profilesOf(child.pid);
      locks = profiles.map(lockOf).filter(Boolean);
      process.kill(group ? -child.pid : child.pid, signal);
    };
    const timer = setInterval(check, 100);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      check();
    });
    child.on("close", (status, how) => {
      clearInterval(timer);
      resolve({ status, signal: how, stdout, stderr, sent, profiles, locks });
    });
  });
}

test("a run that fails or is stopped leaves the earlier run's files as they were and adds nothing", { skip: noBrowser, timeout: 280_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "shots");
  try {
    const { manifest } = await takeShots(origin, { dir, pages: 2, sizes: "desktop", timeLimit: 120_000 });
    assert.equal(manifest.pages.length, 2);
    fs.writeFileSync(path.join(dir, "keep-me.txt"), "mine");
    const before = snapshot(dir);
    assert.deepEqual(Object.keys(before).sort(), ["01-home-desktop.png", "02-pricing-desktop.png", "SCREENSHOTS.md", "keep-me.txt", "manifest.json", "sheet.png"]);

    // A home page that answers 404.
    await assert.rejects(takeShots(`${origin}/missing`, { dir, pages: 1, sizes: "desktop", timeLimit: 60_000 }), /answered 404, so no screenshots were taken/);
    assert.deepEqual(snapshot(dir), before);

    // No browser where CHROME_PATH points: nothing changes, and a new folder
    // is not made.
    for (const out of [dir, path.join(root, "new", "shots")]) {
      const none = spawnSync(process.execPath, [CLI, origin, "--out", out], { env: { ...process.env, CHROME_PATH: path.join(root, "no-chrome") }, encoding: "utf8" });
      assert.equal(none.status, 1);
      assert.match(none.stderr, /No Chrome, Chromium, Edge or Brave found/);
    }
    assert.deepEqual(snapshot(dir), before);
    assert.equal(fs.existsSync(path.join(root, "new")), false);

    // Stopped with SIGTERM once a page is taken, sent to the process, then
    // to its whole group as a supervisor sends it (with --json, which logs
    // nothing, once a picture is in the run's part folder): the browser, its
    // profile and the files the run had made go, and it ends by the same
    // signal.
    const pageTaken = (stderr) => /^01 home {2}\/$/m.test(stderr);
    const pictureMade = () => {
      try {
        return fs.readdirSync(dir).some((name) => name.startsWith(".easyscreenshotkit-part-") && fs.readdirSync(path.join(dir, name)).some((file) => file.endsWith(".png")));
      } catch {
        return false;
      }
    };
    for (const group of [false, true]) {
      const stopped = await stopCli([origin, "--out", dir, "--sizes", "desktop,mobile", ...(group ? ["--json"] : [])], { stopAt: group ? pictureMade : pageTaken, group });
      assert.ok(stopped.sent, stopped.stderr);
      if (process.platform === "linux") assert.equal(stopped.profiles.length, 1);
      assert.equal(stopped.signal, "SIGTERM", `${stopped.status} ${stopped.stderr}`);
      assert.match(stopped.stderr, new RegExp(`easyscreenshotkit: stopped\\. ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is as it was before this run\\.`));
      if (group) assert.deepEqual(JSON.parse(stopped.stdout || "null"), { ok: false, error: `stopped. ${dir} is as it was before this run.` });
      assert.deepEqual(snapshot(dir), before, group ? "group" : "process");
      // Nothing of the browser is left in the temp folder: its profile, nor
      // the lock folder that a browser killed outright cannot remove.
      if (process.platform === "linux") assert.equal(stopped.locks.length, 1, "a lock folder to look for");
      for (const left of [...stopped.profiles, ...stopped.locks]) assert.equal(fs.existsSync(left), false, left);
    }
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A process that ends on an uncaught exception, with a run open and a
// browser going: as it ends, the browser is killed and its profile and lock
// folder go, and the run's folder is as it was.
test("a process that ends on an error it did not catch leaves its run's folder as it was, and no browser behind", { skip: noBrowser, timeout: 60_000 }, async () => {
  const root = tempDir();
  const dir = path.join(root, "shots");
  const lib = path.resolve(__dirname, "../skills/easyscreenshotkit/scripts/lib");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, tool: "easyscreenshotkit 0.1.1" }));
  fs.writeFileSync(path.join(dir, "01-home-desktop.png"), "earlier");
  const before = snapshot(dir);
  const script = `
    const { openShots } = require(${JSON.stringify(path.join(lib, "shots"))});
    const { launch } = require(${JSON.stringify(path.join(lib, "chrome"))});
    require(${JSON.stringify(path.join(lib, "time"))}).setTimeLimit(50000);
    (async () => {
      const run = openShots(${JSON.stringify(dir)});
      run.write("01-home-desktop.png", "half");
      await launch();
      process.stdout.write("launched\\n");
      process.stdin.once("data", () => setTimeout(() => { throw new Error("an error nobody caught"); }, 50));
    })();`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  let profiles = [];
  let locks = [];
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    if (!String(d).includes("launched")) return;
    profiles = profilesOf(child.pid);
    locks = profiles.map(lockOf).filter(Boolean);
    child.stdin.write("go\n");
  });
  const status = await new Promise((resolve) => child.on("close", resolve));
  try {
    assert.equal(status, 1, stderr);
    assert.match(stderr, /an error nobody caught/);
    assert.deepEqual(snapshot(dir), before);
    if (process.platform === "linux") assert.deepEqual([profiles.length, locks.length], [1, 1], stderr);
    for (const left of [...profiles, ...locks]) assert.equal(fs.existsSync(left), false, left);
    for (const profile of profiles) assert.deepEqual(runningWith(profile), [], `a browser of ${profile} still runs`);
  } finally {
    // What a failed check would leave running.
    for (const profile of profiles) for (const pid of runningWith(profile)) process.kill(Number(pid), "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a bot check instead of the home page stops the run and leaves nothing behind", { skip: noBrowser, timeout: 60_000 }, async () => {
  const { server, origin } = await fixture();
  const root = tempDir();
  const dir = path.join(root, "shots");
  try {
    await assert.rejects(takeShots(`${origin}/docs`, { dir, pages: 1, timeLimit: 50_000 }), /bot check \("Just a moment\.\.\."\)/);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
