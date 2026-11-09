"use strict";

// Joining screens into one image and the text written into it, without a
// browser.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { joinScreens, tagPng, pngText, pngSize, pngFileIsWhole } = require("../skills/easyscreenshotkit/scripts/lib/png");
const { screenTops, capturePage } = require("../skills/easyscreenshotkit/scripts/lib/page");
const { readPng, pngOf } = require("./helpers");

// A page 100 px tall whose every row has its own color, captured as
// overlapping screens written with a different filter on every row; each
// screen's first row uses another of the five filters.
const PAGE_COLOR = (x, y) => [(y * 7) % 256, (x * 13 + y) % 256, (1000 - y * 3) % 256];

test("screens join row for row, whatever filter each row was written with", async () => {
  const width = 24;
  const tops = [0, 20, 40, 55, 70];
  const shots = tops.map((top, i) => ({ top, png: pngOf(width, 30, (x, y) => PAGE_COLOR(x, top + y), (y) => (y + i) % 5) }));
  const joined = await joinScreens(shots, width, 100);
  assert.equal(joined.height, 100);
  const png = readPng(joined.png);
  assert.equal(png.width, width);
  assert.equal(png.height, 100);
  for (let y = 0; y < 100; y++) {
    for (const x of [0, 5, 23]) assert.deepEqual(png.pixel(x, y), PAGE_COLOR(x, y), `row ${y}, column ${x}`);
  }
});

test("screens at 2x join at the right rows", async () => {
  const shots = [0, 30].map((top) => ({ top, png: pngOf(20, 60, (x, y) => PAGE_COLOR(x, top * 2 + y), () => 4) }));
  const joined = await joinScreens(shots, 10, 60);
  const png = readPng(joined.png);
  assert.equal(png.height, 120);
  assert.equal(joined.height, 60);
  for (let y = 0; y < 120; y++) assert.deepEqual(png.pixel(3, y), PAGE_COLOR(3, y));
});

test("a screen that came back as RGBA joins the RGB ones, its see-through pixels on white", async () => {
  const rgb = (top) => pngOf(10, 20, (x, y) => PAGE_COLOR(x, top + y), (y) => y % 5);
  // The first screen as RGBA: the top-left pixel half see-through black.
  const rgba = (() => {
    const png = pngOf(10, 20, (x, y) => PAGE_COLOR(x, y), () => 0);
    const { width, height } = { width: 10, height: 20 };
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = x === 0 && y === 0 ? [0, 0, 0] : PAGE_COLOR(x, y);
        raw.set([r, g, b, x === 0 && y === 0 ? 128 : 255], y * (1 + width * 4) + 1 + x * 4);
      }
    }
    const zlib = require("node:zlib");
    const { pngChunk } = require("../skills/easyscreenshotkit/scripts/lib/png");
    const header = Buffer.from(png.subarray(16, 29));
    header[9] = 6;
    return Buffer.concat([png.subarray(0, 8), pngChunk("IHDR", header), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
  })();
  const joined = await joinScreens([{ top: 0, png: rgba }, { top: 20, png: rgb(20) }], 10, 40);
  const png = readPng(joined.png);
  assert.equal(png.height, 40);
  assert.deepEqual(png.pixel(0, 0), [127, 127, 127]);
  for (let y = 1; y < 40; y++) assert.deepEqual(png.pixel(4, y), PAGE_COLOR(4, y), `row ${y}`);
});

// A long page took seconds to join in one go, in which a stop was not handled.
test("joining screens leaves the event loop free for a stop that comes meanwhile", async () => {
  const noise = (x, y) => [(x * x + y * 31) % 256, (y * y + x * 17) % 256, (x * y) % 256];
  const shots = [0, 200, 400, 600].map((top) => ({ top, png: pngOf(400, 200, (x, y) => noise(x, top + y), (y) => (y + top) % 5) }));
  let turns = 0;
  const timer = setInterval(() => turns++, 0);
  const joined = await joinScreens(shots, 400, 800);
  clearInterval(timer);
  assert.equal(readPng(joined.png).height, 800);
  assert.ok(turns >= 3, `${turns} turns of the event loop`);
});

// A tab that stops answering partway down a whole page: one too busy keeps
// the screens taken so far and says it was cut, one that crashed is no page
// cut short, as it would be saved as one.
test("a whole page whose tab crashed partway is lost, and one too busy to answer is cut", { timeout: 30_000 }, async () => {
  const tab = (dead) => {
    let shots = 0;
    return {
      closed: () => dead && shots >= 1,
      async send(method) {
        if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 10, clientHeight: 20 }, cssVisualViewport: { pageY: 0, clientWidth: 10, clientHeight: 20 }, cssContentSize: { height: 50 } };
        if (method === "Page.captureScreenshot") {
          if (++shots > 1) throw new Error("Page.captureScreenshot timed out");
          return { data: pngOf(10, 20, (x, y) => PAGE_COLOR(x, y)).toString("base64") };
        }
        return { result: { value: 0 } };
      },
    };
  };
  const busy = await capturePage(tab(false));
  assert.equal(busy.truncated, true);
  assert.equal(readPng(busy.png).height, 20);
  await assert.rejects(capturePage(tab(true)), /timed out/);
});

test("a PNG file is whole only when it starts and ends as a PNG does", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "easyscreenshotkit-png-"));
  try {
    const file = path.join(dir, "a.png");
    const png = pngOf(10, 10, (x, y) => PAGE_COLOR(x, y));
    fs.writeFileSync(file, png);
    assert.equal(pngFileIsWhole(file), true);
    fs.writeFileSync(file, tagPng(png, { Title: "A page" }));
    assert.equal(pngFileIsWhole(file), true);
    for (const data of [Buffer.alloc(0), png.subarray(0, 20), png.subarray(0, png.length - 1), png.subarray(1), Buffer.concat([png, Buffer.from([0])])]) {
      fs.writeFileSync(file, data);
      assert.equal(pngFileIsWhole(file), false, `${data.length} bytes`);
    }
    assert.equal(pngFileIsWhole(path.join(dir, "no-such.png")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("screen tops: the first screen whole, then three quarters of each, the last one at the page's end", () => {
  assert.deepEqual(screenTops(900, 900), [0]);
  assert.deepEqual(screenTops(2000, 900), [0, 900, 1100]);
  assert.deepEqual(screenTops(4000, 900), [0, 900, 1575, 2250, 2925, 3100]);
  for (const [height, viewport] of [[5000, 640], [1234, 900], [30, 40]]) {
    const tops = screenTops(height, viewport);
    assert.equal(tops[0], 0);
    assert.ok(tops.at(-1) + viewport >= height, "reaches the end");
    for (let i = 1; i < tops.length; i++) assert.ok(tops[i] <= tops[i - 1] + viewport, "no gap");
  }
});

test("the source, the time and the tool go into the PNG as UTF-8 text, and the image stays readable", () => {
  const png = pngOf(8, 8, () => [10, 20, 30]);
  const tagged = tagPng(png, { Title: "Fiyatlar – Acme Şirketi", Source: "https://acme.com/fiyatlar", Empty: "" });
  assert.deepEqual(pngText(tagged), { Title: "Fiyatlar – Acme Şirketi", Source: "https://acme.com/fiyatlar" });
  assert.deepEqual(pngSize(tagged), { width: 8, height: 8 });
  assert.deepEqual(readPng(tagged).pixel(4, 4), [10, 20, 30]);
  assert.equal(pngSize(Buffer.from("not a png")), null);
  assert.equal(tagPng(Buffer.from("not a png"), { A: "b" }).toString(), "not a png");
});
