// 🌍 Outside EU in a real browser, on phone and desktop, against the Worker on an in-memory D1. Skipped without
// Playwright. CHROME_PATH: use this browser. SHOTS=/some/dir: screenshots saved there.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle } from '../worker/src/app.mjs';
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

const product = (key, id, o) => ({ product_key: key, ad_id: id, active: 1, product_title: 'Product ' + id, price: 79, compare_at_price: 129, currency: 'AUD', image_url: `https://cdn.shopify.com/${id}.jpg`, store_url: `https://${key.split('/')[0]}/`,
  product_url: `https://${key}`, ad_library_url: `https://www.facebook.com/ads/library/?id=${id}`, advertiser: 'Shop ' + id, page_id: '77', likes: 900, keyword: 'pillow', markets: '{"AU":{"ads":1,"days":12,"new14":1}}', ads: 1, creatives: 1, days: 12, new14: 1, shop_ads: null, in_eu: null,
  store_products: 12, first_seen: new Date(NOW - 5 * 864e5).toISOString(), last_seen: new Date(NOW - 3600e3).toISOString(), ...o });

async function worldEnv() {
  const env = await seededEnv();
  const put = (p) => env.db.prepare(`INSERT INTO world_products (${Object.keys(p).join(',')}) VALUES (${Object.keys(p).map(() => '?').join(',')})`).run(...Object.values(p));
  put(product('strong.test/products/pod', '1001', { product_title: 'Pillow Pod', days: 210, ads: 12, creatives: 4, shop_ads: 89, in_eu: 0, new14: 3,
    markets: JSON.stringify({ AU: { ads: 9, days: 210, new14: 2 }, NZ: { ads: 3, days: 90, new14: 1 } }) }));
  put(product('flag.test/products/food', '1002', { product_title: 'Grain free dog food', in_eu: 1, days: 40, markets: '{"US":{"ads":2,"days":40,"new14":0}}', ads: 2, currency: 'USD' }));
  put(product('swiss.test/products/kissen', '1003', { product_title: '<img src=x onerror=alert(1)>', days: 9, markets: '{"CH":{"ads":1,"days":9,"new14":1}}', currency: 'CHF' }));
  env.db.prepare("INSERT INTO bestseller (product_key, store, rank, ok, checked_at, history) VALUES ('strong.test/products/pod', 'strong.test', 2, 1, 'x', '[]')").run();
  env.db.prepare("INSERT INTO store_trust (store, status, score, reviews, profile) VALUES ('strong.test', 'page', 4.6, 900, 'strong.test')").run();
  env.db.prepare("INSERT INTO state (key, value, updated_at) VALUES ('world_run', ?, ?)").run(JSON.stringify({ status: 'done', health: 'ok', finished_at: new Date(NOW - 3600e3).toISOString(), ads: 4210, new_products: 96, blocked: 0 }), new Date(NOW).toISOString());
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
  return chromium.launch(path ? { executablePath: path } : {}).catch(() => null);
}

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 1000 }]]) {
  test(`🌍 on a ${name}: opens outside the EU, radar with seven markets, proof on the cards, filters, reject, then the EU tab`, { skip: !chromium && 'Playwright not installed', timeout: 90000 }, async (t) => {
    const browser = await launch();
    if (!browser) return t.skip('no browser');
    const env = await worldEnv();
    const server = await serve(env);
    const base = `http://127.0.0.1:${server.address().port}`;
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'image/png', body: PIXEL }));
    const { makeToken } = await import('../worker/src/app.mjs');
    await page.setExtraHTTPHeaders({ cookie: `__Host-wh=${await makeToken(env.BOARD_PIN, NOW)}` });
    try {
      await page.goto(base + '/');
      await page.waitForSelector('.card');
      assert.strictEqual(await page.getAttribute('[data-scope="world"]', 'aria-pressed'), 'true', 'outside the EU comes first');
      assert.strictEqual(await page.getAttribute('[data-view="all"]', 'aria-pressed'), 'true');
      assert.strictEqual(await page.locator('[data-view="starred"], [data-act="star"], [data-tri="keep"]').count(), 0, 'the star is gone (Connor, 2026-10-31)');
      await page.waitForSelector('#radar:not([hidden]) #rlist .mk');
      assert.strictEqual(await page.locator('#rlist .mk').count(), 17, 'every market, also the empty ones');
      assert.match(await page.textContent('#radar'), /Dubai \/ UAE/);
      assert.doesNotMatch(await page.textContent('#radar'), /reach \/ day/);
      assert.match(await page.textContent('#run'), /Last scan/);
      // The strongest product first, its proof in plain view; no reach anywhere.
      const first = page.locator('.card').first();
      assert.match(await first.textContent(), /Pillow Pod/);
      assert.match(await first.locator('.hero').textContent(), /5\/6|6\/6/);
      assert.match(await first.textContent(), /Not in EU/);
      assert.doesNotMatch(await first.textContent(), /reach/i);
      assert.match(await page.textContent('#grid'), /<img src=x/, 'text stays text');
      assert.strictEqual(await page.locator('[data-f="r2500"]').isHidden(), true);
      assert.strictEqual(await page.locator('[data-f="noteu"]').isVisible(), true);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll');
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/world-${name}.png`, fullPage: false });
      // The selling rules sit under each country; opening them does not filter, and they stay open.
      const rules = page.locator('details[data-rules="NZ"]');
      assert.match(await rules.locator('summary').textContent(), /NZ\$/);
      assert.strictEqual(await rules.locator('li').first().isVisible(), false);
      await rules.locator('summary').click();
      assert.strictEqual(await rules.locator('li').first().isVisible(), true);
      assert.match(await rules.locator('li').first().textContent(), /Fact|Estimate|Unverified/);
      assert.ok((await rules.locator('a').first().getAttribute('href')).startsWith('https://'));
      assert.strictEqual(await page.locator('.card').count(), 3, 'no filter from opening the rules');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll with the rules open');
      if (SHOTS) await page.locator('#radar').screenshot({ path: `${SHOTS}/world-rules-${name}.png` });
      // One market.
      await page.click('#rlist .mk[data-cc="NZ"]');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
      assert.ok(await page.locator('details[data-rules="NZ"]').evaluate((d) => d.open), 'still open after the radar redraws');
      await page.click('#ccChip');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 3);
      // Filter.
      await page.click('[data-f="noteu"]');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
      await page.click('[data-f="noteu"]');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 3);
      // A plain sort.
      await page.selectOption('#sort', 'days');
      await page.waitForFunction(() => /Pillow Pod/.test(document.querySelector('.card').textContent));
      // Reject: gone here, saved in the same tables as the EU decisions.
      await page.locator('.card', { hasText: 'Grain free dog food' }).locator('[data-act="rejected"]').click();
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
      assert.strictEqual(env.db.prepare("SELECT status FROM hidden WHERE ad_id = '1002'").get().status, 'rejected');
      // The inbox, one product at a time, data only.
      await page.click('[data-view="inbox"]');
      await page.waitForSelector('.proofl li');
      assert.match(await page.textContent('.card'), /Oldest ad running/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll in the inbox');
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/world-inbox-${name}.png` });
      // The EU board is still there and unchanged, and remembered.
      await page.click('[data-scope="eu"]');
      await page.waitForFunction(() => document.querySelector('[data-view="inbox"]').getAttribute('aria-pressed') === 'true');
      await page.click('[data-view="all"]');
      await page.waitForSelector('#radar:not([hidden]) #rlist .mk');
      assert.match(await page.textContent('#rsub'), /reach \/ day/);
      assert.strictEqual(await page.locator('[data-f="r2500"]').isVisible(), true);
      assert.doesNotMatch(await page.textContent('#grid'), /Pillow Pod/);
      await page.reload();
      await page.waitForSelector('.card');
      assert.strictEqual(await page.getAttribute('[data-scope="eu"]', 'aria-pressed'), 'true', 'your choice stays');
      assert.deepStrictEqual(errors, []);
    } finally {
      await browser.close();
      server.close();
    }
  });
}
