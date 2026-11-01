// The "Lasso checkout" filter in a real browser (Chromium via Playwright), on a phone and a desktop, against the Worker on
// an in-memory D1 with the research list (migration 0080) and a few sample Lasso stores. Skipped without Playwright.
// CHROME_PATH: use this browser. SHOTS=/some/dir: screenshots saved there.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, tokenFor } from '../worker/src/app.mjs';
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

// The EU sample (shop0.test … shop24.test), shop1.test (3 products) and shop4.test (1) on Lasso; outside the EU, a
// FasciaBlaster product (the research list, through www.) and one from another store.
async function lassoEnv() {
  const env = await seededEnv();
  const put = (p) => env.db.prepare(`INSERT INTO world_products (${Object.keys(p).join(',')}) VALUES (${Object.keys(p).map(() => '?').join(',')})`).run(...Object.values(p));
  const product = (key, id, o) => ({ product_key: key, ad_id: id, active: 1, product_title: 'Product ' + id, price: 79, compare_at_price: 129, currency: 'AUD', image_url: `https://cdn.shopify.com/${id}.jpg`,
    store_url: `https://${key.split('/')[0]}/`, product_url: `https://${key}`, ad_library_url: `https://www.facebook.com/ads/library/?id=${id}`, advertiser: 'Shop ' + id, page_id: '77', likes: 900,
    keyword: 'pillow', markets: '{"AU":{"ads":1,"days":12,"new14":1}}', ads: 1, creatives: 1, days: 12, new14: 1, shop_ads: null, in_eu: null, store_products: 12,
    first_seen: new Date(NOW - 5 * 864e5).toISOString(), last_seen: new Date(NOW - 3600e3).toISOString(), ...o });
  put(product('www.fasciablaster.com/products/tool', '1001', { product_title: 'FasciaBlaster Original Tool', in_eu: 1 }));
  put(product('strong.test/products/pod', '1002', { product_title: 'Pillow Pod', in_eu: 0 }));
  env.db.prepare("INSERT INTO lasso_stores (store, confidence, live, aliases, checked_at) VALUES ('shop1.test', 'high', 1, NULL, '2026-10-30T09:00:00.000Z'), ('shop4-main.test', 'medium', 1, 'shop4.test', NULL)").run();
  return env;
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
  const path = process.env.CHROME_PATH;
  return chromium.launch(path ? { executablePath: path } : {}).catch(() => chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => null));
}

async function open(browser, env, server, { viewport, phone, scope, before }) {
  const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.setFixedTime(new Date(NOW));
  await ctx.route(/^https:\/\//, (r) => r.fulfill({ contentType: 'image/png', body: PIXEL }));
  await page.setExtraHTTPHeaders({ cookie: `__Host-wh=${await tokenFor(env, NOW)}` });
  await page.addInitScript((s) => localStorage.setItem('wh-scope', s), scope);
  await page.addInitScript(() => localStorage.setItem('wh-risk', 'all')); // every seeded product: risk.e2e.test.mjs has Block hidden
  if (before) await before(page);
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'commit' }); // not "load": that waits for every deferred script
  await page.waitForSelector('.card');
  return { ctx, page, errors };
}

const chip = (page, where) => page.locator(`.lchip.${where}`);
const count = (page, where) => chip(page, where).locator('small').innerText();
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

test('Lasso checkout on a phone: the chip in the Inbox and in Browse, its count, the filter, the tag, the CSV; Inbox zero keeps it in reach', { skip: !chromium && 'Playwright not installed', timeout: 90000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no browser');
  const env = await lassoEnv();
  const server = await serve(env);
  try {
    const { page, errors } = await open(browser, env, server, { viewport: { width: 390, height: 844 }, phone: true, scope: 'eu' });
    // The Inbox: no filter row, so the chip sits where Browse has its search.
    assert.strictEqual(await page.getAttribute('[data-view="inbox"]', 'aria-pressed'), 'true');
    await page.waitForFunction(() => document.querySelector('.lchip.lin small').textContent === '4');
    assert.ok(await chip(page, 'lin').isVisible());
    assert.ok(await chip(page, 'lbr').isHidden(), 'the Browse chip stays with the Browse filters');
    assert.strictEqual(await chip(page, 'lin').getAttribute('aria-pressed'), 'false');
    assert.strictEqual(await chip(page, 'lin').getAttribute('title'), 'Only products from stores that use the Lasso checkout (lassocommerce.com)');
    assert.strictEqual(await page.textContent('#ileft'), '27 left');
    assert.strictEqual(await page.textContent('#inew'), '26 new today');
    assert.ok(await noSideScroll(page), 'no sideways scroll in the Inbox');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/lasso-inbox-phone.png` });

    await chip(page, 'lin').click();
    await page.waitForFunction(() => document.getElementById('ileft').textContent === '4 left');
    assert.strictEqual(await chip(page, 'lin').getAttribute('aria-pressed'), 'true');
    assert.strictEqual(await count(page, 'lin'), '4');
    assert.strictEqual(await page.textContent('#nin'), '4');
    assert.strictEqual(await page.textContent('#inew'), '3 new today', 'new today among the Lasso products');
    assert.match(await page.getAttribute('#csv', 'href'), /^\/export\.csv\?view=inbox&lasso=1$/);
    const tag = page.locator('.card .tags .tag.lasso');
    assert.strictEqual(await tag.innerText(), 'Lasso');
    assert.match(await tag.getAttribute('title'), /^shop1\.test uses the Lasso checkout \(lassocommerce\.com\): sure, its Lasso script and checkout were found, checked 2026-10-30$/);
    // Decide: the Inbox and the chip count down together, without asking the server again.
    await page.click('[data-tri="rejected"]');
    await page.waitForFunction(() => document.getElementById('ileft').textContent === '3 left');
    assert.strictEqual(await count(page, 'lin'), '3');
    await page.click('[data-tri="seen"]');
    await page.waitForFunction(() => document.getElementById('ileft').textContent === '2 left');
    assert.strictEqual(await count(page, 'lin'), '2');
    await page.click('[data-tri="rejected"]');
    await page.waitForFunction(() => document.getElementById('ileft').textContent === '1 left');
    await page.click('[data-tri="rejected"]');
    // Inbox zero for Lasso stores: the chip is still there to show every store again.
    await page.waitForSelector('#zero:not([hidden])');
    assert.ok(await chip(page, 'lin').isVisible());
    assert.strictEqual(await count(page, 'lin'), '0');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/lasso-inbox-zero-phone.png` });
    await chip(page, 'lin').click();
    await page.waitForFunction(() => document.getElementById('ileft').textContent === '23 left');
    assert.strictEqual(await chip(page, 'lin').getAttribute('aria-pressed'), 'false');
    assert.strictEqual(await count(page, 'lin'), '0', 'all four decided');

    // Browse: the chip among the filters, next to Jev's; the Inbox chip steps aside.
    await page.click('[data-view="all"]');
    await page.waitForSelector('#allrow2:not([hidden])');
    assert.ok(await chip(page, 'lin').isHidden());
    assert.strictEqual(await page.locator('#opts .lchip.lbr + [data-f="hidden"]').count(), 1, 'before "Approved & rejected"');
    await page.click('[data-f="hidden"]');
    await page.waitForFunction(() => document.querySelector('.lchip.lbr small').textContent === '4');
    await chip(page, 'lbr').click();
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 4);
    assert.strictEqual(await page.locator('#grid .card .badges .tag.lasso').count(), 4, 'every card has its tag, on the photo');
    assert.match(await page.textContent('#count'), /^4 matches · /);
    assert.match(await page.getAttribute('#csv', 'href'), /[?&]lasso=1(&|$)/);
    await page.click('[data-f="hidden"]');
    await page.waitForFunction(() => !document.querySelector('#grid .card'));
    assert.strictEqual(await page.textContent('#empty'), 'No products match.');
    await chip(page, 'lbr').click();
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 23);
    assert.strictEqual(await page.locator('#grid .card .tag.lasso').count(), 0, 'the four Lasso products were decided');
    assert.ok(await page.locator('#count').isHidden());
    assert.ok(await noSideScroll(page), 'no sideways scroll in Browse');

    // Outside the EU: the same chip, the count of that tab.
    await page.click('[data-scope="world"]');
    await page.waitForFunction(() => document.querySelector('.lchip.lbr small').textContent === '1');
    assert.strictEqual(await page.locator('#grid .card .tag.lasso').count(), 1);
    assert.match(await page.locator('#grid .card', { hasText: 'FasciaBlaster' }).locator('.tag.lasso').getAttribute('title'), /^fasciablaster\.com uses the Lasso checkout .*checked 2026-11-01$/);
    await chip(page, 'lbr').click();
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 1);
    assert.match(await page.textContent('#grid'), /FasciaBlaster Original Tool/);
    await page.click('[data-f="noteu"]');
    await page.waitForFunction(() => !document.querySelector('#grid .card'));
    assert.strictEqual(await count(page, 'lbr'), '0', 'with "Not in EU": none');
    await page.click('[data-f="noteu"]');
    await page.click('[data-view="inbox"]');
    await page.waitForFunction(() => document.getElementById('ileft').textContent === '1 left');
    assert.strictEqual(await chip(page, 'lin').getAttribute('aria-pressed'), 'true', 'one chip state across the views');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/lasso-world-inbox-phone.png` });
    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test('Lasso checkout on a desktop: the Inbox chip beside the views; /lasso.js that comes after the first products still gets its count', { skip: !chromium && 'Playwright not installed', timeout: 90000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('no browser');
  const env = await lassoEnv();
  const server = await serve(env);
  try {
    // /lasso.js held back until the board shows its first products.
    let release;
    const held = new Promise((ok) => (release = ok));
    const { page, errors } = await open(browser, env, server, {
      viewport: { width: 1280, height: 900 }, phone: false, scope: 'eu',
      before: (p) => p.route('**/lasso.js', async (route) => { await held; await route.continue(); }),
    });
    assert.strictEqual(await page.locator('.lchip').count(), 0, 'not there yet');
    release();
    await page.waitForFunction(() => document.querySelector('.lchip.lin small') && document.querySelector('.lchip.lin small').textContent === '4');
    const seg = await page.locator('.bar2 > .seg').boundingBox();
    const box = await chip(page, 'lin').boundingBox();
    assert.ok(box.x >= seg.x + seg.width && Math.abs(box.y + box.height / 2 - (seg.y + seg.height / 2)) < 4, 'on the row of the views, right of them');
    await chip(page, 'lin').click();
    await page.waitForFunction(() => document.getElementById('ileft').textContent === '4 left');
    assert.strictEqual(await page.locator('#grid .card .tag.lasso').count(), 1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/lasso-inbox-desktop.png` });
    await page.click('[data-view="all"]');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 4);
    const opts = await page.locator('#opts').boundingBox();
    const lbr = await chip(page, 'lbr').boundingBox();
    assert.ok(lbr.x >= opts.x && lbr.y >= opts.y && lbr.y < opts.y + opts.height, 'among the filters');
    assert.strictEqual(await page.locator('#grid .card .badges .tag.lasso').count(), 4);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/lasso-browse-desktop.png` });
    assert.ok(await noSideScroll(page));
    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
