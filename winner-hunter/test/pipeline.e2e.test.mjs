// 🧭 Pipeline in a real browser (Chromium via Playwright), against the Worker served locally on an in-memory D1, with a
// fake photo server behind the Worker's fetch: the view next to 🚀, the stages and filters (stage, country, stuck), a
// product's sourcing request with its copy buttons and agent templates (exact copy text), a 1688 link pasted from the
// app's share text (cleaned, offer id, price and MOQ; the stage follows), price and choose (the launch card follows),
// target markets and their country facts, the photo saved as a JPG under 3 MB, stages forward and back (the launch card's
// ticks follow), a note, everything back after a reload; on a desktop a card dragged to another stage. No sideways
// scroll, no errors. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/pipeline.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { packOf, fieldsOf, copyAllOf } from '../worker/src/pipeline.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (e) {
  // no Playwright: skipped
}
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const SHOTS = process.env.SHOTS || '';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64');
const KEY = 'eu|shop1.test/products/item-1'; // Posture Corrector Pro
const WORLD = 'world|pod.test/products/pillow';
const SHARE = '【1688】护腰带 姿势矫正器 ¥12.50 2-99件 回头率35% 4.8分 源头工厂 https://m.1688.com/offer/695123456789.html?spm=a26352';
const iso = (ms) => new Date(ms).toISOString();

/** A PNG of noise, w × h: it does not compress, so it is bigger than 3 MB at 1100 × 1000. */
function noisePng(w, h) {
  const crc = (b) => zlib.crc32(b);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td) >>> 0);
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = crypto.randomBytes((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0; // each row: filter 0 (none)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

function serve(env) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const out = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env, { html: HTML, now: NOW });
    const headers = {};
    out.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(out.status, headers);
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function launch() {
  try {
    return await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  } catch (e) {
    return chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => null);
  }
}

/** The seeded board with Posture Corrector Pro (EU, approved 5 days ago) and Pod Pillow (outside the EU: ads in AU and US, approved a day ago) approved. */
async function boardEnv() {
  const env = await seededEnv();
  env.db.prepare(`INSERT INTO world_products (product_key, ad_id, active, product_title, price, currency, image_url, store_url, product_url, ad_library_url, advertiser, page_id, keyword, markets, ads, creatives, days, new14, shop_ads, store_products, first_seen, last_seen)
    VALUES ('pod.test/products/pillow', '1001', 1, 'Pod Pillow', 49, 'AUD', 'https://cdn.shopify.com/pod.jpg', 'https://pod.test/', 'https://pod.test/products/pillow', 'https://www.facebook.com/ads/library/?id=1001', 'Pod', '77', 'pillow',
    '{"AU":{"ads":3,"days":40,"new14":1},"US":{"ads":2,"days":12,"new14":2}}', 5, 2, 40, 1, 80, 12, ?, ?)`).run(iso(NOW - 2 * 864e5), iso(NOW - 3600e3));
  for (const [id, at] of [['9001', NOW - 5 * 864e5], ['1001', NOW - 864e5]]) {
    const cookie = `__Host-wh=${await tokenFor(env, at)}`;
    const res = await handle(new Request('https://board.test/api/hide', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ad_id: id, status: 'seen' }) }), env, { now: at });
    assert.strictEqual(res.status, 200);
  }
  return env;
}

async function page0(browser, base, cookie, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, serviceWorkers: 'block', acceptDownloads: true });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => (errors.push('dialog: ' + d.message()), d.dismiss()));
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ cookie });
  await page.route(/^https:\/\//, (r) => (/\.(jpe?g|png)(\?|$)/.test(r.request().url()) ? r.fulfill({ contentType: 'image/png', body: PIXEL }) : r.fulfill({ status: 204, body: '' })));
  await page.addInitScript(() => localStorage.setItem('wh-scope', 'eu'));
  return { ctx, page, errors };
}

test('🧭 Pipeline on an iPhone: stages and filters, the request pack with its copy buttons and templates, a 1688 link pasted and chosen, markets and their facts, the photo under 3 MB, stages forward and back, a note; back after a reload; no sideways scroll, no errors', { skip: !chromium && 'Playwright not installed', timeout: 180000 }, async (t) => {
  const BIG = noisePng(1100, 1000);
  assert.ok(BIG.length > 3 * 1024 * 1024, 'the photo is bigger than an agent’s form takes');
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await boardEnv();
  const realFetch = globalThis.fetch;
  const photos = [];
  globalThis.fetch = (url, init) => { // the Worker's fetch of the product photo
    if (!/^https:\/\/cdn\.shopify\.com\//.test(String(url))) return realFetch(url, init);
    photos.push(String(url));
    return Promise.resolve(new Response(BIG, { headers: { 'content-type': 'image/png', 'content-length': String(BIG.length) } }));
  };
  const server = await serve(env);
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const { ctx, page, errors } = await page0(browser, base, cookie, { width: 390, height: 844 });
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/pipeline-${name}.png`, fullPage: false });
  const noSideScroll = async (where) => {
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
  };
  const idle = () => page.waitForFunction(() => PL.busy === 0 && PL.timers.size === 0);
  const db = (sql, ...a) => ({ ...env.db.prepare(sql).get(...a) });
  const stageOf = (key) => (db('SELECT stage FROM pipeline_items WHERE product_key = ?', key) || {}).stage;
  const steps = (key) => JSON.parse(db('SELECT steps FROM launches WHERE product_key = ?', key).steps);
  const card = (key) => page.locator(`#plboard .plcard[data-key="${key}"]`);
  const col = (k) => page.locator(`#plboard [data-pl-col="${k}"]`);
  const field = (k) => page.locator(`#plout [data-pl-field="${k}"]`);
  const clip = () => page.evaluate(() => navigator.clipboard.readText());
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(base + '/');
    await page.waitForSelector('#grid .card');
    // The button sits next to 🚀; the view: eight stages, every approved product in Approved, the longest waiting first
    assert.strictEqual(await page.locator('#lnseg + #plseg').count(), 1);
    await page.click('#plseg');
    await page.waitForSelector('#plboard .plcard');
    assert.strictEqual(await page.getAttribute('#plseg', 'aria-pressed'), 'true');
    assert.ok(await page.locator('#grid').isHidden() && await page.locator('#lnbox').isHidden());
    assert.strictEqual(await page.locator('#plboard .plcol').count(), 8);
    assert.deepStrictEqual(await col('approved').locator('.plcard').evaluateAll((cs) => cs.map((c) => c.dataset.key)), [KEY, WORLD]);
    assert.match(await card(KEY).locator('.plnext').textContent(), /Next: Check and copy the request · You\s+5d/);
    assert.strictEqual(await page.textContent('#npipe'), '2');
    await noSideScroll('the pipeline');
    await shot('1-board');
    // Filters: a stage, a country (suggested from where it runs ads), stuck for 3+ days
    await page.click('#plbar [data-pl-stage="link"]');
    assert.strictEqual(await page.textContent('#plboard'), 'Nothing here with these filters.');
    await page.click('#plbar [data-pl-stage="approved"]');
    assert.strictEqual(await page.locator('#plboard .plcol').count(), 1);
    await page.selectOption('#plcc', 'AU');
    assert.deepStrictEqual(await page.locator('#plboard .plcard').evaluateAll((cs) => cs.map((c) => c.dataset.key)), [KEY, WORLD], 'Pod Pillow runs ads in AU; the other has the first four of the list');
    await page.selectOption('#plcc', 'GB');
    assert.deepStrictEqual(await page.locator('#plboard .plcard').evaluateAll((cs) => cs.map((c) => c.dataset.key)), [KEY], 'Pod Pillow’s ads run in AU and the US only');
    await page.selectOption('#plcc', '');
    await page.selectOption('#plstuck', '3');
    assert.deepStrictEqual(await page.locator('#plboard .plcard').evaluateAll((cs) => cs.map((c) => c.dataset.key)), [KEY], 'approved 5 days ago');
    await page.selectOption('#plstuck', '0');
    await page.click('#plbar [data-pl-stage=""]');

    // A product: its stage, what to do next and who, and its sourcing request ready to copy
    await card(KEY).locator('.plopen').click();
    await page.waitForSelector('#pldet .pldet');
    assert.match(await page.textContent('#plnowsec'), /Stage 1 of 8 · since 12 Oct \(5 days\) · not on a launch card yet/);
    assert.match(await page.textContent('#plnowsec'), /Who: You/);
    assert.strictEqual(await field('title').locator('.plfv').textContent(), 'Posture Corrector Pro');
    assert.strictEqual(await field('zh').locator('.plfv').textContent(), '姿势矫正器');
    assert.match(await field('zh').locator('small').textContent(), /Guessed from the English words/);
    assert.strictEqual(await field('price').locator('.plfv').textContent(), 'Under ¥118 per unit (€14.33)', 'their €30.95: €25.58 without VAT (21%), €0.93 fees (3%), a third of the price for ROAS 3: €14.33, ¥118 at ¥8.3');
    assert.strictEqual(await field('link').locator('.plfv').textContent(), 'https://shop1.test/products/item-1', 'no 1688 link yet: the shop that sells it');
    await field('title').locator('button').click();
    assert.strictEqual(await clip(), 'Posture Corrector Pro');
    await noSideScroll('a product open');
    await shot('2-pack');
    // Kungfubuy: its four fields in its order; Copy all is exact, and moves Approved on to Request ready
    await page.click('[data-pl-tpl="kungfubuy"]');
    assert.deepStrictEqual(await page.locator('#plout .plfield b').allTextContents(), ['Product Link', 'Product Image', 'Country', 'Remark']);
    await page.fill('[data-pl-pack="variants"]', 'Black, Beige · S/M/L');
    await page.click('[data-pl="copyall"]');
    await idle();
    const item = () => page.evaluate((k) => JSON.parse(JSON.stringify(PL.data.items.find((i) => i.key === k))), KEY);
    const names = await page.evaluate(() => PL.data.countries);
    const want = copyAllOf(fieldsOf(packOf(await item(), names), 'kungfubuy', 'en'));
    assert.strictEqual(await clip(), want);
    assert.match(want, /^Product Link: https:\/\/shop1\.test\/products\/item-1\nCountry: United States\nRemark:\nPlease find this product on 1688 \(the same as in the link\): Posture Corrector Pro\.\nVariants: Black, Beige · S\/M\/L\./);
    assert.strictEqual(stageOf(KEY), 'request', 'copied: Request ready');
    assert.deepStrictEqual(JSON.parse(db('SELECT pack FROM pipeline_items WHERE product_key = ?', KEY).pack), { variants: 'Black, Beige · S/M/L' });
    assert.strictEqual(db('SELECT value FROM pipeline_settings WHERE key = ?', 'template').value, '"kungfubuy"', 'the template is remembered');
    await page.click('[data-pl-lang="zh"]');
    await field('remark').locator('button').click();
    assert.match(await clip(), /^请在1688上找同款（与链接里的产品一致）：姿势矫正器。\n款式：Black, Beige · S\/M\/L。\n请帮忙确认：/);
    await page.click('[data-pl-lang="en"]');

    // The 1688 link from the app's share text: read as you paste, cleaned, priced; Link found follows
    await page.fill('#plpaste', SHARE);
    assert.match(await page.textContent('#plparse'), /1688 offer #695123456789: detail\.1688\.com\/offer\/695123456789\.html · ¥12\.5 · MOQ 2/);
    await page.click('[data-pl="add"]');
    await page.waitForSelector('#pllinksec .pll');
    await idle();
    assert.strictEqual(await page.getAttribute('#pllinksec .pll1 a', 'href'), 'https://detail.1688.com/offer/695123456789.html');
    assert.strictEqual(await page.textContent('#pllinksec .ploid'), '#695123456789');
    assert.deepStrictEqual(await Promise.all(['unit_price', 'currency', 'moq'].map((k) => page.inputValue(`#pllinksec [data-pl-lf="${k}"]`))), ['12.5', 'CNY', '2']);
    assert.strictEqual(stageOf(KEY), 'link');
    assert.strictEqual(await field('link').locator('.plfv').textContent(), 'https://detail.1688.com/offer/695123456789.html', 'the pack takes the 1688 link');
    // MOQ edited; Choose: Supplier confirmed, and the launch card's Sourcing step has the cost in euros
    await page.fill('#pllinksec [data-pl-lf="moq"]', '10');
    await page.locator('#pllinksec [data-pl-lf="moq"]').blur();
    await idle();
    assert.strictEqual(db('SELECT moq FROM product_suppliers WHERE product_key = ?', KEY).moq, 10);
    await page.click('#pllinksec [data-pl="choose"]');
    await idle();
    assert.strictEqual(stageOf(KEY), 'supplier');
    assert.deepStrictEqual([steps(KEY).sourcing.v.unit, steps(KEY).sourcing.v.supplier, steps(KEY).sourcing.v.moq], [1.51, 'https://detail.1688.com/offer/695123456789.html', 10]);
    assert.strictEqual(await page.getAttribute('#pllinksec [data-pl="choose"]', 'aria-pressed'), 'true');
    await shot('3-link');

    // Target markets: suggested until you pick; the country's facts under it
    await page.click('#pldet [data-pl-fold="markets"] > summary');
    assert.strictEqual(await page.locator('#plmktsec .plcc.sug').count(), 4, 'ads only in the EU: the first four of your list, suggested');
    await page.click('#plmktsec [data-pl-cc="CA"]');
    await page.click('#plmktsec [data-pl-cc="AU"]');
    await page.click('#plmktsec [data-pl-cc="SA"]');
    await idle();
    assert.deepStrictEqual(JSON.parse(db('SELECT markets FROM pipeline_items WHERE product_key = ?', KEY).markets), ['US', 'GB', 'SA']);
    assert.match(await page.textContent('#plmktsec .plradar'), /^Risk radar \(EU rules\): Docs.*Claims: Health claim in its name/, 'the risk radar’s verdict (risk.mjs)');
    await page.click('#plmktsec [data-pl-cf="GB"] > summary');
    assert.match(await page.textContent('#plmktsec [data-pl-cf="GB"]'), /£135/);
    assert.match(await page.textContent('#plmktsec [data-pl-cf="GB"]'), /3–5 business days \(YunExpress Standard Express\)estimate/);
    assert.match(await page.textContent('#plmktsec [data-pl-cf="GB"]'), /Type G · 230 V, 50 Hz/);
    assert.strictEqual(await page.locator('#plmktsec [data-pl-cf="GB"] a[href^="https://www.gov.uk/"]').count() >= 1, true, 'with its sources');
    assert.match(await field('country1').locator('.plfv').textContent(), /^United States$/, 'Kungfubuy: one country per request');
    assert.match(await field('country1').locator('small').textContent(), /send another for United Kingdom and Saudi Arabia/);
    await noSideScroll('markets open');
    await shot('4-markets');

    // The photo: bigger than 3 MB, saved as a JPG under 3 MB
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#plform [data-pl="img"]')]);
    const file = await dl.path();
    const bytes = fs.readFileSync(file);
    assert.strictEqual(dl.suggestedFilename(), 'posture-corrector-pro.jpg');
    assert.ok(bytes.length <= 3 * 1024 * 1024 && bytes.length > 1000, `${bytes.length} bytes`);
    assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPG');
    assert.match(await page.textContent('#plimgst'), /^The photo was 3\.\d MB: saved as posture-corrector-pro\.jpg, a \d+ KB JPG under 3 MB\.$/);
    assert.deepStrictEqual(photos, ['https://cdn.shopify.com/s/files/1/p1.jpg?width=400'], 'the Worker fetched the product’s own photo');

    // Stages: forward to Sample ordered (the launch card's tick follows), a note, back again (the tick goes)
    await page.click('#plnowsec [data-pl-act="next"]');
    await idle();
    assert.strictEqual(stageOf(KEY), 'sample');
    assert.strictEqual(steps(KEY).sourcing.v.sample, true);
    await page.fill('#plnote', 'Lily ordered 2, paid on 1688');
    await idle();
    assert.deepStrictEqual(JSON.parse(db('SELECT notes FROM pipeline_items WHERE product_key = ?', KEY).notes), { sample: 'Lily ordered 2, paid on 1688' });
    await page.click('#plnowsec [data-pl-act="back"]');
    await idle();
    assert.strictEqual(stageOf(KEY), 'supplier');
    assert.strictEqual(steps(KEY).sourcing.v.sample, undefined);
    assert.match(await page.textContent('#plhistsec'), /Sample ordered → Supplier confirmed/);
    // The data says more than the stage: a suggestion to move on
    env.db.prepare("UPDATE launches SET steps = json_set(steps, '$.launch', json('{\"done\":false,\"note\":\"\",\"v\":{\"campaign\":true}}')) WHERE product_key = ?").run(KEY);
    await page.reload();
    await page.waitForSelector('#grid .card');
    await page.click('#plseg');
    await page.waitForSelector('#plboard .plcard');
    // Everything is still there after the reload; the product's own panel comes back with a tap
    assert.strictEqual(await col('supplier').locator(`.plcard[data-key="${KEY}"]`).count(), 1);
    await card(KEY).locator('.plopen').click();
    await page.waitForSelector('#pldet .plsug');
    assert.match(await page.textContent('#pldet .plsug'), /The data says Test ads: “Test campaign set up” is ticked on the launch card\./);
    await page.click('#pldet .plsug button');
    await idle();
    assert.strictEqual(stageOf(KEY), 'ads');
    assert.strictEqual(steps(KEY).sourcing.v.sample, true, 'past Sample ordered: its tick too');
    assert.strictEqual(await page.locator('#pllinksec .pll.on').count(), 1);
    assert.strictEqual(await page.inputValue('[data-pl-pack="variants"]'), 'Black, Beige · S/M/L');
    // No go takes it off the pipeline (a No go on the launch card), Restore brings it back
    await page.click('#plnowsec [data-pl-act="drop"]');
    await idle();
    assert.strictEqual(db('SELECT decision FROM launches WHERE product_key = ?', KEY).decision, 'no');
    assert.strictEqual(await page.locator(`#plboard .plcard[data-key="${KEY}"]`).count(), 0);
    await page.click('#plbar [data-pl-stage="dropped"]');
    assert.strictEqual(await page.locator(`#plboard .plcard[data-key="${KEY}"]`).count(), 1);
    await page.click('#plnowsec [data-pl-act="restore"]');
    await idle();
    assert.strictEqual(db('SELECT decision FROM launches WHERE product_key = ?', KEY).decision, null);
    assert.strictEqual(await page.textContent('#plboard'), 'Nothing here with these filters.', 'restored: off the No go list');
    await page.click('#plbar [data-pl-stage=""]');
    assert.strictEqual(await page.locator(`#plboard [data-pl-col="ads"] .plcard[data-key="${KEY}"]`).count(), 1, 'back where it was: Test ads');
    // 🚀 Launch card: the launch view opens on this card
    await page.click('#pltop [data-pl="launch"]');
    await page.waitForSelector('#lnbox .lncard');
    assert.strictEqual(await page.getAttribute('#lnbox .lncard', 'data-key'), KEY);
    assert.ok(await page.locator('#plbox').isHidden());
    assert.strictEqual(await page.getAttribute('#plseg', 'aria-pressed'), 'false');
    // The € view and the pipeline: each steps aside for the other
    await page.click('#ecseg');
    await page.waitForFunction(() => document.body.classList.contains('ecv'));
    await page.click('#plseg');
    await page.waitForSelector('#plboard .plcard');
    assert.ok(await page.locator('#ecbox').isHidden(), 'the € view left');
    assert.deepStrictEqual(await Promise.all(['#ecseg', '#lnseg', '#plseg'].map((x) => page.getAttribute(x, 'aria-pressed'))), ['false', 'false', 'true']);
    await page.click('#ecseg');
    await page.waitForFunction(() => document.body.classList.contains('ecv'));
    assert.ok(await page.locator('#plbox').isHidden(), 'the pipeline left for the € view');
    await page.click('[data-view="all"]');
    await page.waitForSelector('#grid .card');
    assert.ok(await page.locator('#plbox').isHidden() && await page.locator('#lnbox').isHidden(), 'another view: the pipeline steps aside');
    await noSideScroll('back on the board');
    assert.deepStrictEqual(errors, []);
  } finally {
    globalThis.fetch = realFetch;
    await ctx.close();
    await browser.close();
    server.close();
  }
});

test('🧭 Pipeline on a desktop: the stages side by side, a card dragged to another stage (and back by its button), a stage chip as a drop target', { skip: !chromium && 'Playwright not installed', timeout: 120000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await boardEnv();
  const server = await serve(env);
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const { ctx, page, errors } = await page0(browser, base, cookie, { width: 1280, height: 860 });
  const stageOf = (key) => ({ ...env.db.prepare('SELECT stage FROM pipeline_items WHERE product_key = ?').get(key) }).stage;
  const idle = () => page.waitForFunction(() => PL.busy === 0);
  try {
    await page.goto(base + '/');
    await page.waitForSelector('#grid .card');
    await page.click('#plseg');
    await page.waitForSelector('#plboard .plcard');
    // Side by side: the columns sit in one row (the board scrolls sideways, the page does not)
    const tops = await page.locator('#plboard .plcol').evaluateAll((cs) => [...new Set(cs.map((c) => Math.round(c.getBoundingClientRect().top)))]);
    assert.strictEqual(tops.length, 1, 'one row of stages');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pipeline-5-desktop.png` });
    await page.dragAndDrop(`#plboard .plcard[data-key="${WORLD}"]`, '#plboard [data-pl-col="link"]');
    await idle();
    assert.strictEqual(stageOf(WORLD), 'link', 'dragged to Link found');
    assert.strictEqual(await page.locator(`#plboard [data-pl-col="link"] .plcard[data-key="${WORLD}"]`).count(), 1);
    await page.click(`#plboard .plcard[data-key="${WORLD}"] [data-pl-act="back"]`);
    await idle();
    assert.strictEqual(stageOf(WORLD), 'request', 'one stage back by its button');
    await page.dragAndDrop(`#plboard .plcard[data-key="${WORLD}"]`, '#plbar [data-pl-stage="sample"]');
    await idle();
    assert.strictEqual(stageOf(WORLD), 'sample', 'dropped on a stage chip');
    assert.strictEqual(JSON.parse(env.db.prepare('SELECT steps FROM launches WHERE product_key = ?').get(WORLD).steps).sourcing.v.sample, true);
    assert.deepStrictEqual(errors, []);
  } finally {
    await ctx.close();
    await browser.close();
    server.close();
  }
});
