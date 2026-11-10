"use strict";

// The tour a demo takes when no steps are given. Its pages are the ones the
// screenshots would take: the home page, then the pages its menu puts
// forward (features, pricing and the like), each opened first to make sure
// it is a page of its own and not a sign-in redirect, a bot check or a page
// already taken. Pricing goes last, as a visitor's tour would end there.
//
// On each page: a moment on the first screen, a scroll down to a section or
// two, and on to the next page through the link in the site's own menu (a
// cut when the menu has none).

const { openTab, closeTab, navigate } = require("./chrome");
const { waitForContent, settle, walk, watchRequests } = require("./page");
const { readInfo, readLinks, rejectAtOnce, rejectReason, slugOf, siteName, identity, pagesAsked, waitForView, notOpened } = require("./shots");
const { homeOf, pageKey, routeOf, viewKey, pathOf, readable, siteOf, rankLinks, routeLinks, visitOrder, readSiteIndex, kindOf, alternateFor } = require("./pick");
const { TOP_COVER } = require("./record");
const { timeLeft } = require("./time");

const PROBE = { width: 1600, height: 900, scale: 1, mobile: false, touch: false, agent: "desktop" };

// Opens a candidate in a window of its own and says whether it is a page
// worth showing: {nav, info, links}, or {rejected: reason}. A view of a
// single page app is waited for as the screenshots wait for it. links: read
// the page's links too, for the #routes in its menu.
async function probe(chrome, url, check, ctx, { links = false } = {}) {
  const tab = await openTab(chrome, PROBE, ctx);
  try {
    await watchRequests(tab);
    const nav = await navigate(tab, url);
    const glance = await readInfo(tab);
    const early = rejectAtOnce({ asked: url, nav, info: glance }, check);
    if (early) return { rejected: early };
    await waitForView(tab, nav, url, false);
    const loaded = await waitForContent(tab, 15_000);
    await settle(tab, 4_000);
    const info = await readInfo(tab);
    const reason = rejectReason({ asked: url, nav, info, loaded }, check);
    return reason ? { rejected: reason } : { nav, info, links: links ? await readLinks(tab) : [] };
  } finally {
    await closeTab(chrome, tab);
  }
}

// The pages of the tour, the home page first: [{url, kind, why, title}],
// with the ones opened and left out and why (skipped), and the #route links
// on the home page, the address given and each --page, and the #routes the
// sitemap lists, which the tour does not follow (routes).
async function pickPages(chrome, asked, { pages: wanted = 4, extra = [], lang = "", theme = "light", reducedMotion = false, log = () => {} } = {}) {
  const ctx = { lang, theme, reducedMotion };
  let home = homeOf(asked);
  // An address deeper than its home page, or a #route of it, is a page of
  // its own in the tour.
  const given = viewKey(asked) !== viewKey(home) ? asked : "";
  const asks = pagesAsked(extra, asked, home);
  log(`Opening ${home}`);
  const indexing = wanted > 1 ? readSiteIndex(new URL(home).origin).catch(() => ({ robots: null, urls: [] })) : Promise.resolve({ robots: null, urls: [] });
  // Opens the page the tour starts at. refused: why it cannot be, in the
  // words of the pages left out. alternates: look for its version in the
  // language asked for.
  const opening = async (url, { alternates = false } = {}) => {
    const tab = await openTab(chrome, PROBE, ctx);
    try {
      await watchRequests(tab);
      let nav = await navigate(tab, url);
      if (nav.status >= 400) throw Object.assign(new Error(`${nav.url} answered ${nav.status}, so no demo was recorded.`), { refused: `the page answered ${nav.status}` });
      await waitForView(tab, nav, url, false);
      await waitForContent(tab, 20_000);
      await settle(tab, 6_000);
      let info = await readInfo(tab);
      if (info.challenge) throw Object.assign(new Error(`${nav.url} answered with a bot check ("${info.title || "a challenge page"}") instead of its page, so no demo was recorded. Open the site in a normal browser to check it.`), { refused: "a bot check instead of the page" });
      // The site's own home page in the language asked for, when it names one.
      const alternate = alternates && alternateFor(info.alternates, lang);
      if (alternate && pageKey(alternate.href) !== pageKey(nav.url) && siteOf(alternate.href) === siteOf(home)) {
        log(`Opening its ${alternate.lang} version, ${alternate.href}`);
        home = homeOf(alternate.href);
        nav = await navigate(tab, alternate.href);
        await waitForContent(tab, 20_000);
        await settle(tab, 6_000);
        info = await readInfo(tab);
      }
      let links = [];
      if (wanted > 1) {
        await walk(tab, 12_000);
        links = await readLinks(tab);
      }
      return { nav, info, links };
    } finally {
      await closeTab(chrome, tab);
    }
  };
  const skipped = [];
  // A home page the tour chose to open by itself is left out when it cannot
  // be taken and the address given is there to start at: what stops a demo
  // is the address the user gave.
  let opened;
  let homeLost = "";
  try {
    opened = await opening(home, { alternates: true });
  } catch (err) {
    if (!given || chrome.gone()) throw err;
    homeLost = notOpened(err);
    skipped.push({ url: home, reason: homeLost });
    home = homeOf(asked);
    log(`Opening ${asked}`);
    opened = await opening(asked);
  }
  const { nav, info, links } = opened;
  const homeKey = pageKey(nav.url);
  const kept = [];
  // asked: a page the user named, the address given or a --page, which a
  // tour short of time shows before the ones it picked itself; given: the
  // address given, without which it has no video to make.
  if (homeLost) {
    const { keys, named } = identity(asked, nav.url, info.canonical);
    kept.push({ url: nav.url, kind: (kindOf(new URL(asked), "") || { kind: "other" }).kind, why: "the address given", title: info.title, slug: slugOf(named, home), textHash: info.textHash, keys, asked: true, given: true });
  } else {
    const homeKeys = identity(home, nav.url, info.canonical).keys;
    kept.push({ url: nav.url, kind: "home", why: "the home page", title: info.title, slug: "home", textHash: info.textHash, keys: homeKeys.add(pageKey(home)), asked: !given, given: !given });
  }
  // The links on the pages given and asked for, for their #routes.
  const namedLinks = [];
  const keep = (url, kind, why, got, flags = {}) => {
    const { keys, named } = identity(url, got.nav.url, got.info.canonical);
    kept.push({ url: got.nav.url, kind, why, title: got.info.title, slug: slugOf(named, home), textHash: got.info.textHash, keys, asked: Boolean(flags.asked), given: Boolean(flags.given) });
    log(`  ${pathOf(got.nav.url)} (${why})`);
  };
  const check = { site: siteOf(home), homeKey, kept };
  // The page given and the ones asked for come whatever they are, unless
  // they fail to open, as a link to a file does; one the tour has already
  // is said so. A page that fails because the browser ended fails the demo.
  for (const [url, why] of [...(given && !homeLost ? [[given, "the address given"]] : []), ...asks.map((url) => [url, "asked for with --page"])]) {
    const same = kept.find((page) => page.keys.has(viewKey(url)));
    if (same) {
      skipped.push({ url, reason: `the same page as ${same.slug}` });
      continue;
    }
    let got;
    try {
      got = await probe(chrome, url, { site: check.site, homeKey: "", kept: [] }, ctx, { links: wanted > 1 });
    } catch (err) {
      if (chrome.gone()) throw err;
      skipped.push({ url, reason: notOpened(err) });
      continue;
    }
    if (got.rejected) skipped.push({ url, reason: got.rejected });
    else {
      keep(url, (kindOf(new URL(url), "") || { kind: "other" }).kind, why, got, { asked: true, given: why === "the address given" });
      namedLinks.push(...got.links);
    }
  }
  const index = await indexing;
  // short: the tour looked for no more pages of its own as time ran short,
  // with fewer than it was asked for.
  let short = false;
  if (wanted > kept.length) {
    const ranked = rankLinks(links, index.urls || [], {
      home: nav.url,
      robots: index.robots,
      alternates: (info.alternates || []).map((alt) => alt.href),
      exclude: kept.map((page) => page.url),
      // A home page left out is not opened again from a link to it.
      keys: [...kept.flatMap((page) => [...page.keys]), ...(homeLost ? [pageKey(home)] : [])],
    });
    const queue = visitOrder(ranked.candidates);
    let visits = 0;
    while (queue.length && kept.length < wanted && visits < wanted * 3 && timeLeft() > 240_000) {
      const candidate = queue.shift();
      if (kept.some((page) => page.keys.has(viewKey(candidate.url)))) continue;
      visits++;
      let got;
      try {
        got = await probe(chrome, candidate.url, check, ctx);
      } catch (err) {
        if (chrome.gone()) throw err;
        skipped.push({ url: candidate.url, reason: notOpened(err) });
        continue;
      }
      if (got.rejected) skipped.push({ url: candidate.url, reason: got.rejected });
      else keep(candidate.url, candidate.kind, candidate.why, got);
    }
    short = queue.length > 0 && kept.length < wanted && visits < wanted * 3;
  }
  // The views of an app that the home page, the address given and each
  // --page link to by #route, and those the sitemap lists, whether the
  // tour still needed pages or not.
  const listed = (index.urls || []).map((href) => ({ href }));
  const routes = wanted > 1 ? routeLinks([...links, ...namedLinks, ...listed], { home: nav.url, keys: kept.flatMap((page) => [...page.keys]) }) : [];
  // A visitor's order: what the product is first, what it costs last.
  const [first, ...rest] = kept;
  const ordered = [first, ...rest.filter((page) => page.kind !== "pricing"), ...rest.filter((page) => page.kind === "pricing")];
  return { pages: ordered.map(({ url, kind, why, title, slug, asked, given }) => ({ url, kind, why, title, slug, asked, given })), skipped, routes, site: siteName(info, nav.url), short };
}

// Where a page is worth stopping on the way down: the tops of its first
// sections (blocks opened by an h2), in CSS px from the page's top.
const SECTIONS = `(() => {
  const doc = document.scrollingElement || document.documentElement;
  const max = Math.max(0, doc.scrollHeight - innerHeight);
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; };
  let heads = [...document.querySelectorAll("h2")].filter(shown);
  if (heads.length < 2) heads = [...document.querySelectorAll("h2, h3")].filter(shown);
  const tops = [];
  for (const el of heads) {
    const text = el.innerText.replace(/\\s+/g, " ").trim();
    if (!text || text.length > 120) continue;
    let block = el.closest("section, article, [class*='section' i]");
    if (block && block.getBoundingClientRect().width < 0.6 * innerWidth) block = null;
    const top = (block || el).getBoundingClientRect().top + scrollY - (block ? 0 : 40);
    tops.push({ top: Math.max(0, Math.round(top)), heading: text.slice(0, 80) });
  }
  tops.sort((a, b) => a.top - b.top);
  return { max, tops };
})()`;

// Up to two stops between half a screen and three and a half screens down,
// at least two thirds of a screen apart; plain screens when the page has
// no sections to stop at.
function chooseStops({ max, tops }, height, cover = 0) {
  if (max < height * 0.3) return [];
  const limit = Math.min(max, height * 3.5);
  const stops = [];
  for (const section of tops) {
    const y = Math.min(max, Math.max(0, section.top - cover - 8));
    if (y < height * 0.5 || y > limit) continue;
    if (stops.length && y - stops[stops.length - 1].y < height * 0.65) continue;
    stops.push({ y, heading: section.heading });
    if (stops.length === 2) break;
  }
  if (!stops.length) {
    for (const k of [0.9, 1.8]) if (height * k <= limit + height * 0.2) stops.push({ y: Math.min(max, Math.round(height * k)), heading: "" });
  }
  return stops.filter((stop, i, all) => i === 0 || stop.y - all[i - 1].y > height * 0.3);
}

// The link to url on the screen as it is, or null.
async function linkOnScreen(recorder, url) {
  const found = await recorder.locate({ href: url }, { timeout: 0, scroll: false });
  if (!found || found.covered) return null;
  const inside = found.top >= 0 && found.top + found.height <= recorder.viewport.height && found.left >= 0 && found.left + found.width <= recorder.viewport.width;
  return inside ? found : null;
}

// Whether a link to url shows on the page's first screen: a menu that
// scrolled away with the page is there again at the top.
async function linkAtTop(recorder, url) {
  const found = await recorder.locate({ href: url }, { timeout: 0, scroll: false });
  if (!found) return false;
  const { y } = await recorder.scrollState();
  return found.top + y >= 0 && found.top + y + found.height <= recorder.viewport.height;
}

// A heading or a link's words in a step's label: whole words, 40
// characters at most.
function quote(text) {
  const words = String(text).replace(/\s+/g, " ").trim();
  if (words.length <= 40) return `"${words}"`;
  const cut = words.slice(0, 40);
  return `"${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : 40).replace(/[\s,;:.-]+$/, "")}…"`;
}

// What a tour says when it cannot show the address given, and of each page
// it leaves out as time runs short.
const RAN_OUT = "time ran out while recording; give more with --timeout";
const LEFT_FOR_TIME = "time ran out; give more with --timeout";

// How long a scroll down to a stop and the second spent there take, in
// seconds of the video, before the tour has seen what a page takes.
const STOP_SECONDS = 2.5;

// The tour as steps, made one page at a time: what a page shows is only
// known once it is open. Its first step opens the site by its host's name
// when it starts at the home page, and the page it starts at by its path
// and route otherwise, as a tour whose home page was left out does.
//
// It keeps reserve of the run's time for its end, as a demo's steps do,
// and goes on to a page only while the time left over would take a page
// as long as the longest one it showed so far, from the step that opened
// it to its last. Short of time, it shows the pages the user named first:
// a page's scrolls are left out when they would leave no room for the ones
// still to come, and so is a page it picked itself. Each page it does not
// show goes in left, with why, and a tour that cannot show the address
// given fails. clock: what the time is, in ms.
async function* tourSteps(recorder, pages, { reserve = 60_000, left = [], clock = Date.now } = {}) {
  const host = new URL(pages[0].url).hostname.replace(/^www\./, "");
  const placeOf = (url) => readable(`${new URL(url).pathname}${routeOf(url)}`);
  const spare = () => timeLeft() - reserve;
  // The pages from the one at index on that the user named.
  const owed = (from) => pages.slice(from).filter((page) => page.asked).length;
  const leave = (from, to = pages.length) => {
    for (const page of pages.slice(from, to)) left.push({ url: page.url, reason: LEFT_FOR_TIME });
    if (pages.slice(from, to).some((page) => page.given)) throw new Error(RAN_OUT);
  };
  if (spare() < 0) throw new Error(RAN_OUT);
  let longest = 0;
  let opened = clock();
  yield { action: "visit", url: pages[0].url, label: `Open ${pages[0].kind === "home" ? host : placeOf(pages[0].url)}` };
  for (let i = 0; i < pages.length; i++) {
    yield { action: "wait", seconds: i === 0 ? 1.6 : 1.1 };
    const cover = (await recorder.eval(TOP_COVER)) || 0;
    let stops = chooseStops((await recorder.eval(SECTIONS)) || { max: 0, tops: [] }, recorder.viewport.height, cover);
    // A page with its scrolls, as this one would take with them, or as
    // long as the longest so far.
    const scrolls = stops.length * STOP_SECONDS * 1000 * (recorder.factor || 1);
    const whole = Math.max(longest, clock() - opened + scrolls);
    if (stops.length && spare() < scrolls + whole * owed(i + 1)) stops = [];
    for (const stop of stops) {
      yield { action: "scroll", to: stop.y, label: stop.heading ? `Scroll to ${quote(stop.heading)}` : "Scroll down" };
      yield { action: "wait", seconds: 1 };
    }
    longest = Math.max(longest, clock() - opened);
    // The next page: one the tour picked is left out while showing it
    // would leave no room for the ones the user named after it.
    let j = i + 1;
    while (j < pages.length && !pages[j].asked && spare() < longest * (1 + owed(j + 1))) j++;
    leave(i + 1, j);
    const next = pages[j];
    const room = spare();
    if (next && room < longest) leave(j);
    if (!next || room < longest) {
      yield { action: "wait", seconds: stops.length ? 0.6 : 1.2 };
      return;
    }
    opened = clock();
    // A link to a #route goes by the query of the page it is on: a view
    // asked for with a query of its own is visited.
    const linkable = !routeOf(next.url) || new URL(next.url).search === new URL(pages[i].url).search;
    let link = linkable ? await linkOnScreen(recorder, next.url) : null;
    if (!link && linkable && stops.length && (await linkAtTop(recorder, next.url))) {
      yield { action: "scroll", to: "top", label: "Back to the top" };
      link = await linkOnScreen(recorder, next.url);
    }
    const where = placeOf(next.url);
    if (link) yield { action: "click", target: { href: next.url }, label: link.text ? `Click ${quote(link.text)}` : `Open ${where}`, text: link.text, attribute: link.attribute, expect: next.url };
    else yield { action: "visit", url: next.url, label: `Open ${where}` };
    // The pages left out on the way are passed over.
    i = j - 1;
  }
}

module.exports = { pickPages, tourSteps, chooseStops, SECTIONS, RAN_OUT, LEFT_FOR_TIME };
