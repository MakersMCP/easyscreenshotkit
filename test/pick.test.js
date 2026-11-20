"use strict";

// Page selection without a browser: kinds, reasons to leave a page out,
// ranking, robots.txt and sitemaps.

const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const test = require("node:test");
const pick = require("../skills/easyscreenshotkit/scripts/lib/pick");
const { serve, withRebinding } = require("./helpers");

const HOME = "https://acme.com/";
const page = (path) => new URL(path, HOME);
const kind = (path, text = "") => (pick.kindOf(page(path), text) || {}).kind || "";
const reason = (path, text = "", homeLocale = "") => pick.excludedBecause(page(path), text, { homeLocale });

test("kinds come from the address first, then from the link's words, in six languages", () => {
  assert.equal(kind("/pricing"), "pricing");
  assert.equal(kind("/plans-and-pricing"), "pricing");
  assert.equal(kind("/fiyatlar"), "pricing");
  assert.equal(kind("/preise"), "pricing");
  assert.equal(kind("/features"), "product");
  assert.equal(kind("/ozellikler"), "product");
  assert.equal(kind("/how-it-works"), "tour");
  assert.equal(kind("/integrations"), "integrations");
  assert.equal(kind("/changelog"), "changelog");
  assert.equal(kind("/hakkimizda"), "about");
  assert.equal(kind("/customers"), "customers");
  assert.equal(kind("/blog"), "blog");
  // An address that says nothing: the link's words decide.
  assert.equal(kind("/x", "Product"), "product");
  assert.equal(kind("/start", "How it works"), "tour");
  assert.equal(kind("/x", "Hakkımızda"), "about");
  assert.equal(kind("/x", "Something else"), "");
  assert.equal(kind("/x", "Plans and pricing"), "pricing");
  assert.equal(kind("/changes/en", "Product updates"), "changelog");
  // A teaser's words are not a menu label.
  assert.equal(kind("/isim-icin/kampanyalar", "DHL eCommerce Avantajlı Fiyatlar!"), "");
  // Only the first part of the path names the kind.
  assert.equal(kind("/now/why-is-quality-so-rare"), "");
  assert.equal(kind("/features/sso"), "product");
  // The address wins over the words.
  assert.equal(kind("/pricing", "Sign up free"), "pricing");
});

test("sign-in, legal and other pages are left out with a reason", () => {
  assert.equal(reason("/login", "Log in"), "sign-in or sign-up page");
  assert.equal(reason("/start", "Sign up"), "sign-in or sign-up page");
  assert.equal(reason("/giris"), "sign-in or sign-up page");
  // An app of the site's own, or an account page, is no sign-in page,
  // though it often needs one: it was said to be one, of an app with none.
  for (const at of ["/app/", "/dashboard", "/account/settings", "/my-account"]) assert.equal(reason(at), "the app itself or an account page, which often needs a sign-in", at);
  assert.equal(reason("/account/login"), "sign-in or sign-up page");
  // The same in the languages the sign-in words are read in, where an
  // account page was still said to be a sign-in page and a page of one's
  // own account was taken.
  for (const at of ["/konto", "/mein-konto/bestellungen", "/compte", "/mon-compte", "/cuenta", "/mi-cuenta", "/conta", "/minha-conta", "/hesap", "/hesabim/siparislerim"]) assert.equal(reason(at), "the app itself or an account page, which often needs a sign-in", at);
  for (const at of ["/konto/anmelden", "/compte/connexion", "/cuenta/iniciar-sesion", "/conta/entrar", "/hesap/giris"]) assert.equal(reason(at), "sign-in or sign-up page", at);
  assert.equal(reason("/privacy-policy"), "legal page");
  assert.equal(reason("/kvkk"), "legal page");
  assert.equal(reason("/impressum"), "legal page");
  assert.equal(reason("/company/careers"), "not a product page");
  assert.equal(reason("/contact-sales", "Contact sales"), "not a product page");
  assert.equal(reason("/blog/first-post"), "a single post");
  assert.equal(reason("/customers/openai"), "a single post");
  assert.equal(reason("/changelog/2026-09-14-loops"), "a single post");
  assert.equal(reason("/2024/05/hello"), "a single post");
  assert.equal(reason("/this-is-a-very-long-post-title-slug"), "a single post");
  assert.equal(reason("/de/pricing"), "another language");
  assert.equal(reason("/tr/fiyatlar", "", "tr"), "");
  // A page under a product section is a product page, whatever its name.
  assert.equal(reason("/features/sso"), "");
  assert.equal(reason("/features/account-sync"), "");
  // A button whose words say "Sign up" but that leads to the pricing page.
  assert.equal(reason("/pricing", "Sign up free"), "");
  assert.equal(reason("/blog"), "");
});

test("home pages: the site's root, or its language root", () => {
  assert.equal(pick.homeOf("https://acme.com/pricing"), "https://acme.com/");
  assert.equal(pick.homeOf("https://acme.com/tr/fiyatlar"), "https://acme.com/tr/");
  assert.equal(pick.homeOf("https://www.acme.com"), "https://www.acme.com/");
  assert.equal(pick.pageKey("https://www.acme.com/Pricing/?a=1#x"), "acme.com/pricing");
  assert.equal(pick.pageKey("https://acme.com"), "acme.com/");
});

test("ranking: menu links first, a sitemap only as a fallback, reasons kept for the links left out", () => {
  const links = [
    { href: "/pricing", text: "Pricing", where: "header" },
    { href: "/features", text: "Features", where: "header" },
    { href: "/login", text: "Log in", where: "header" },
    { href: "/start", text: "How it works", where: "hero" },
    { href: "/about", text: "About", where: "footer" },
    { href: "/careers", text: "Careers", where: "footer" },
    { href: "https://other.com/x", text: "Partner", where: "header" },
    { href: "/pricing", text: "Sign up", where: "hero" },
    { href: "/terms.pdf", text: "Terms", where: "footer" },
    { href: "mailto:hi@acme.com", text: "Mail", where: "footer" },
  ];
  const robots = pick.parseRobots("User-agent: *\nDisallow: /about\n");
  const { candidates, skipped } = pick.rankLinks(links, ["https://acme.com/changelog", "https://acme.com/blog/post-1"], { home: HOME, robots });
  assert.deepEqual(
    candidates.map((c) => [new URL(c.url).pathname, c.kind, c.score, c.where]),
    [
      ["/pricing", "pricing", 110, "header"],
      ["/features", "product", 100, "header"],
      ["/start", "tour", 75, "hero"],
      ["/changelog", "changelog", 35, "sitemap"],
    ],
  );
  assert.equal(candidates[0].why, 'menu link "Pricing"');
  assert.deepEqual(
    skipped.map((s) => [new URL(s.url).pathname, s.reason]),
    [
      ["/login", "sign-in or sign-up page"],
      ["/about", "robots.txt asks crawlers to stay out"],
      ["/careers", "not a product page"],
    ],
  );
});

// The page's key has no port: a menu's link to a page on another port of
// the site, which the run does not open, outranked the footer's link to the
// same page on 443, and the page was lost though the run could open it. The
// link the run opens is kept; one on another port alone stays, for the
// run's rule to refuse with its reason. A site given on another port keeps
// its own links there, and https of an http one.
test("of two links to one page, the one the run opens by its port is kept", () => {
  const links = [
    { href: "https://dup.example:8443/pricing", text: "Pricing", where: "header" },
    { href: "https://dup.example:8443/features", text: "Features", where: "header" },
    { href: "https://dup.example:8443/customers", text: "Customers", where: "header" },
    { href: "/pricing", text: "Pricing", where: "footer" },
    { href: "https://www.dup.example/features", text: "Features", where: "footer" },
  ];
  const { candidates } = pick.rankLinks(links, ["https://dup.example:9443/integrations", "https://dup.example/integrations"], { home: "https://dup.example/" });
  assert.deepEqual(candidates.map((c) => c.url).sort(), ["https://dup.example/integrations", "https://dup.example/pricing", "https://dup.example:8443/customers", "https://www.dup.example/features"]);
  // Given on 8443: that port is the site's own, and another one is not.
  const onPort = pick.rankLinks([{ href: "/pricing", text: "Pricing", where: "header" }, { href: "https://dup.example:9443/pricing", text: "Pricing", where: "header" }, { href: "https://dup.example/pricing", text: "Pricing", where: "footer" }], [], { home: "https://dup.example:8443/" });
  assert.deepEqual(onPort.candidates.map((c) => c.url), ["https://dup.example:8443/pricing"]);
  const upgraded = pick.rankLinks([{ href: "http://dup.example:9443/pricing", text: "Pricing", where: "header" }, { href: "https://dup.example:8080/pricing", text: "Pricing", where: "footer" }], [], { home: "http://dup.example:8080/" });
  assert.deepEqual(upgraded.candidates.map((c) => c.url), ["https://dup.example:8080/pricing"]);
});

// The host given is the site's with or without the one dot that can end a
// name, as the rule for the addresses a run opens reads it: given
// https://dup.example.:8443/, the links and the sitemap's entries at
// https://dup.example:8443/ are the site's and on its port, where the tour
// dropped them as another site's and kept the pages at the dotted host
// alone; and the other way round.
test("the host given is the site's with or without the one dot that can end a name, in links and in the sitemap", () => {
  const links = [
    { href: "/pricing", text: "Pricing", where: "header" },
    { href: "https://dup.example:8443/features", text: "Features", where: "header" },
  ];
  const { candidates } = pick.rankLinks(links, ["https://dup.example:8443/customers"], { home: "https://dup.example.:8443/" });
  assert.deepEqual(candidates.map((c) => c.url).sort(), ["https://dup.example.:8443/pricing", "https://dup.example:8443/customers", "https://dup.example:8443/features"]);
  const plain = pick.rankLinks([{ href: "https://dup.example.:8443/features", text: "Features", where: "header" }], [], { home: "https://dup.example:8443/" });
  assert.deepEqual(plain.candidates.map((c) => c.url), ["https://dup.example.:8443/features"]);
  // Of a menu's link to another port and the footer's on the port given,
  // the footer's, which the run opens.
  const two = pick.rankLinks([{ href: "https://dup.example:9443/pricing", text: "Pricing", where: "header" }, { href: "https://dup.example:8443/pricing", text: "Pricing", where: "footer" }], [], { home: "https://dup.example.:8443/" });
  assert.deepEqual(two.candidates.map((c) => c.url), ["https://dup.example:8443/pricing"]);
  assert.equal(pick.siteOf("https://www.dup.example.:8443/"), "dup.example");
  assert.equal(pick.pageKey("https://dup.example.:8443/features"), pick.pageKey("https://dup.example:8443/features"));
});

test("a #route is a view of its own; #/, #! and an anchor are not", () => {
  assert.equal(pick.routeOf("https://acme.com/app/#/plants"), "#/plants");
  assert.equal(pick.routeOf("https://acme.com/#/plant/Fern"), "#/plant/Fern");
  assert.equal(pick.routeOf("https://acme.com/mail/#!/inbox"), "#!/inbox");
  assert.equal(pick.routeOf("https://acme.com/#!inbox"), "#!inbox");
  for (const anchor of ["https://acme.com/pricing#faq", "https://acme.com/#/", "https://acme.com/#!", "https://acme.com/#!/", "https://acme.com/#", "https://acme.com/", "not an address"]) assert.equal(pick.routeOf(anchor), "", anchor);
  // A view's key is its page's and its route: the route keeps its case,
  // loses a trailing slash; an anchor leaves the page what it is.
  assert.equal(pick.viewKey("https://www.acme.com/App/#/plant/Fern/"), "acme.com/app#/plant/Fern");
  assert.equal(pick.viewKey("https://acme.com/pricing?x=1#faq"), "acme.com/pricing");
  assert.equal(pick.viewOf("https://acme.com/app/?tab=2#/plants"), "https://acme.com/app/?tab=2#/plants");
  assert.equal(pick.viewOf("https://acme.com/app/?tab=2#faq"), "https://acme.com/app/?tab=2");
  assert.equal(pick.pathOf("https://acme.com/app/?tab=2#/plants"), "/app/?tab=2#/plants");
  // A page asked for by name keeps its #route and the query in front of
  // it, which an app can read; with no #route its query goes, and any other
  // fragment, which anchorOf() names.
  assert.equal(pick.pageUrl("/app/?x=1#/plants", HOME).href, "https://acme.com/app/?x=1#/plants");
  assert.equal(pick.pageUrl("#/plants", "https://acme.com/app/").href, "https://acme.com/app/#/plants");
  assert.equal(pick.pageUrl("#/plants", "https://acme.com/app/?mode=a#/today").href, "https://acme.com/app/?mode=a#/plants");
  assert.equal(pick.pageUrl("/pricing?plan=pro", HOME).href, "https://acme.com/pricing");
  assert.equal(pick.pageUrl("/pricing?plan=pro#faq", HOME).href, "https://acme.com/pricing");
  assert.equal(pick.pageUrl("mailto:hi@acme.com", HOME), null);
  const anchor = (raw) => pick.anchorOf(new URL(raw));
  assert.deepEqual(
    ["https://acme.com/pricing#faq", "https://acme.com/#inbox", "https://acme.com/cb#access_token=x&y=z"].map(anchor),
    ["#faq", "#inbox", "#access_token=x&y=z"],
  );
  for (const none of ["https://acme.com/app/#/plants", "https://acme.com/#!inbox", "https://acme.com/#/", "https://acme.com/#!", "https://acme.com/#!/", "https://acme.com/#//", "https://acme.com/#", "https://acme.com/"]) assert.equal(anchor(none), "", none);
});

test("ranking: a link to a #route offers its page to the tour; routeLinks lists each view once, unless it is taken", () => {
  const links = [
    { href: "#/plants", text: "Plants", where: "header" },
    { href: "/#features", text: "Features", where: "header" },
    { href: "/app/#/light", text: "Light", where: "body" },
    { href: "#/", text: "Home", where: "header" },
    { href: "#!", text: "Menu", where: "header" },
    { href: "/login", text: "Log in", where: "header" },
    { href: "/app/#/today", text: "Today", where: "footer" },
    { href: "/pricing", text: "Pricing", where: "header" },
    { href: "/app/#/light/", text: "Light again", where: "footer" },
    { href: "https://other.com/#/x", text: "Partner", where: "footer" },
    { href: "/docs/#/install", text: "Docs", where: "header" },
  ];
  // Each link counts as one to its page, as it did before routes were
  // kept: /docs/ for the docs, /app/ for the app's views, which is left
  // out as an app's own page, and the home page for #/plants.
  const { candidates, skipped } = pick.rankLinks(links, ["https://acme.com/#/from-the-sitemap"], { home: HOME, keys: ["acme.com/app#/today"] });
  assert.deepEqual(candidates.map((c) => [new URL(c.url).pathname, c.kind, c.why]), [["/pricing", "pricing", 'menu link "Pricing"'], ["/docs/", "docs", 'menu link "Docs"']]);
  assert.deepEqual(skipped.map((s) => [s.url, s.reason]), [["https://acme.com/app/", "the app itself or an account page, which often needs a sign-in"], ["https://acme.com/login", "sign-in or sign-up page"]]);
  assert.deepEqual(
    pick.routeLinks(links, { home: HOME, keys: ["acme.com/app#/today"] }).map((s) => [s.url, s.reason]),
    [
      ["https://acme.com/#/plants", "a #route, which the tour does not follow: give it with --page"],
      ["https://acme.com/app/#/light", "a #route, which the tour does not follow: give it with --page"],
      ["https://acme.com/docs/#/install", "a #route, which the tour does not follow: give it with --page"],
    ],
  );
  // The route the home page opened on is the home page.
  const app = pick.routeLinks([{ href: "#/dashboard" }, { href: "#/plants" }], { home: "https://acme.com/#/dashboard" });
  assert.deepEqual(app.map((s) => s.url), ["https://acme.com/#/plants"]);
  // Links read on another page of the site come as the browser wrote them.
  assert.deepEqual(pick.routeLinks([{ href: "https://acme.com/app/#/settings" }], { home: HOME }).map((s) => s.url), ["https://acme.com/app/#/settings"]);
  // A page with a route taken leaves its path to the tour.
  const docs = pick.rankLinks([{ href: "/docs/", text: "Docs", where: "header" }], [], { home: HOME, exclude: ["https://acme.com/docs/#/intro"] });
  assert.deepEqual(docs.candidates.map((c) => new URL(c.url).pathname), ["/docs/"]);
});

test("visit order: the best of each kind first, two product pages, then the rest", () => {
  const c = (path, kind, score) => ({ url: `https://acme.com${path}`, kind, score });
  const order = pick.visitOrder([c("/pricing", "pricing", 110), c("/plans", "pricing", 105), c("/features", "product", 100), c("/platform", "product", 100), c("/solutions", "product", 99), c("/about", "about", 30)]);
  assert.deepEqual(order.map((x) => new URL(x.url).pathname), ["/pricing", "/features", "/platform", "/about", "/plans", "/solutions"]);
});

test("robots.txt: the longest rule wins, Allow on a tie, wildcards and $", () => {
  const robots = pick.parseRobots(
    ["User-agent: Googlebot", "Disallow: /", "", "User-agent: *", "Disallow: /admin", "Allow: /admin/public", "Disallow: /*.pdf$", "Disallow:", "Sitemap: https://acme.com/sitemap.xml"].join("\n"),
  );
  assert.deepEqual(robots.sitemaps, ["https://acme.com/sitemap.xml"]);
  assert.equal(pick.robotsAllows("/pricing", robots.rules), true);
  assert.equal(pick.robotsAllows("/admin/users", robots.rules), false);
  assert.equal(pick.robotsAllows("/admin/public/page", robots.rules), true);
  assert.equal(pick.robotsAllows("/files/a.pdf", robots.rules), false);
  assert.equal(pick.robotsAllows("/files/a.pdfx", robots.rules), true);
  const ours = pick.parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: easyscreenshotkit\nAllow: /\n");
  assert.equal(pick.robotsAllows("/pricing", ours.rules), true);
});

test("sitemaps: url sets, indexes, CDATA and entities; the pages' own sitemap first", () => {
  assert.deepEqual(pick.parseSitemap("<urlset><url><loc>https://a.com/x?a=1&amp;b=2</loc></url><url><loc><![CDATA[https://a.com/y]]></loc></url></urlset>"), {
    urls: ["https://a.com/x?a=1&b=2", "https://a.com/y"],
    sitemaps: [],
  });
  assert.deepEqual(pick.parseSitemap("<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap></sitemapindex>"), { urls: [], sitemaps: ["https://a.com/s1.xml"] });
  assert.deepEqual(pick.sitemapOrder(["https://a.com/post-sitemap.xml", "https://a.com/page-sitemap.xml", "https://a.com/sitemap-0.xml", "https://a.com/product-sitemap.xml"]), [
    "https://a.com/page-sitemap.xml",
    "https://a.com/sitemap-0.xml",
    "https://a.com/post-sitemap.xml",
    "https://a.com/product-sitemap.xml",
  ]);
});

test("the site index reads robots.txt and a gzipped sitemap index, and stops at its limits", async () => {
  let origin = "";
  const { server, origin: base } = await serve((req, res) => {
    if (req.url === "/robots.txt") return res.end(`User-agent: *\nDisallow: /secret\nSitemap: ${origin}/sitemap_index.xml\n`);
    if (req.url === "/sitemap_index.xml") return res.end(`<sitemapindex><sitemap><loc>${origin}/post-sitemap.xml.gz</loc></sitemap><sitemap><loc>${origin}/page-sitemap.xml.gz</loc></sitemap></sitemapindex>`);
    if (req.url === "/page-sitemap.xml.gz") return res.end(zlib.gzipSync(`<urlset><url><loc>${origin}/pricing</loc></url><url><loc>${origin}/features</loc></url></urlset>`));
    if (req.url === "/post-sitemap.xml.gz") return res.end(zlib.gzipSync(`<urlset>${Array.from({ length: 900 }, (_, i) => `<url><loc>${origin}/blog/post-${i}</loc></url>`).join("")}</urlset>`));
    res.statusCode = 404;
    res.end();
  });
  origin = base;
  try {
    const index = await pick.readSiteIndex(origin);
    assert.equal(index.robots.rules[0].path, "/secret");
    assert.deepEqual(index.urls.slice(0, 2), [`${origin}/pricing`, `${origin}/features`]);
    assert.equal(index.urls.length, 500);
  } finally {
    server.close();
  }
});

// A sitemap robots.txt names is read at the address its host was judged
// by, a host written with two dots at its end too, which the rule reads
// with one dot taken off: the request's lookup asks for that name too, and
// the DNS is asked once. It took off a second dot, asked the DNS again, and
// the request went to that later answer, 127.0.0.1 (see helpers.js
// withRebinding). The site is a server of this machine, given as the
// address.
test("a sitemap robots.txt names on a host written with two dots at its end is read at the address its host was judged by", async () => {
  const { server, origin } = await serve((req, res) => {
    if (req.url === "/robots.txt") return res.end("User-agent: *\nSitemap: http://two-dots-map.example../sitemap.xml\n");
    res.statusCode = 404;
    res.end();
  });
  try {
    await withRebinding(["two-dots-map.example"], async ({ reached, asked }) => {
      const index = await pick.readSiteIndex(origin);
      assert.deepEqual(index.urls, []);
      assert.deepEqual(await reached(), ["93.184.215.14"]);
      assert.deepEqual(asked(), ["two-dots-map.example."]);
    });
  } finally {
    server.close();
  }
});
