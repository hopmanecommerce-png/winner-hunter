// The Google tab in a real browser, on phone and desktop, against the Worker on an in-memory D1 whose Google products the real
// Google hunt wrote from SAMPLE DATA (helpers/google-seed.mjs). Skipped without Playwright. CHROME_PATH: use this browser.
// SHOTS=/some/dir: screenshots saved there.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { googleEnv } from './helpers/google-seed.mjs';
import { NOW } from './helpers/seed.mjs';

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (e) {
  // no Playwright: skipped
}
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const SHOTS = process.env.SHOTS || '';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64');

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

/** fn() once it gives something, asked every 25 ms for at most 5 seconds. */
async function until(fn, ms = 5000) {
  for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 25))) {
    const v = fn();
    if (v || Date.now() > end) return v;
  }
}

async function launch() {
  try {
    return await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  } catch (e) {
    return chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => null);
  }
}

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 1000 }]]) {
  test(`Google tab on a ${name}: the four rules marked exact / approximated / not checked, also on Meta / TikTok, filters, Approve, the Inbox, then the EU card says "Also on Google"`, { skip: !chromium && 'Playwright not installed', timeout: 90000 }, async (t) => {
    const browser = await launch();
    if (!browser) return t.skip('no browser');
    const env = await googleEnv();
    // A product whose name is HTML: it stays text.
    env.db.prepare(`INSERT INTO google_products (product_key, ad_id, active, verdict, rules, product_title, price, currency, store_url, product_url, advertiser_id, creative_id, ads_estimate, ads_window,
      first_shown, last_shown, days, regions, formats, copies, first_seen, last_seen, run_id) SELECT 'nasty.example/products/x', 'gCR10000000000000000999', 1, 'partial', rules, '<img src=x onerror=alert(1)>', 9.5, 'EUR',
      'https://nasty.example/', 'https://nasty.example/products/x', 'AR10000000000000000009', 'CR10000000000000000999', 80, 3, first_shown, last_shown, days, '["FR"]', '["text"]', 1, first_seen, last_seen, run_id
      FROM google_products WHERE product_key LIKE 'glowlamp%'`).run();
    env.db.prepare("UPDATE state SET updated_at = 'e2e' WHERE key = 'google_data'").run();
    const server = await serve(env);
    const base = `http://127.0.0.1:${server.address().port}`;
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://cdn.shopify.com/**', (r) => r.fulfill({ contentType: 'image/png', body: PIXEL }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.setExtraHTTPHeaders({ cookie: `__Host-wh=${await tokenFor(env, NOW)}` });
    const noSideScroll = async (what) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no sideways scroll: ${what}`);
    try {
      await page.goto(base + '/');
      await page.waitForSelector('#grid[aria-busy="false"]', { state: 'attached' }); // the tab outside the EU first: empty here
      await page.click('[data-scope="google"]');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 4 && /Posture Corrector Pro/.test(document.querySelector('.card').textContent));
      assert.strictEqual(await page.getAttribute('[data-scope="google"]', 'aria-pressed'), 'true');
      assert.strictEqual(await page.getAttribute('[data-view="all"]', 'aria-pressed'), 'true', 'Browse first, as outside the EU');
      assert.strictEqual(await page.textContent('#ngoogle'), '4');
      assert.match(await page.textContent('#run'), /Last Google hunt .* · 3 products · 16 of 300 credits/);
      await noSideScroll('four tabs on top');
      // The first card: all four rules, each with its mark; ✓ exact, ≈ approximated.
      const posture = page.locator('.card', { hasText: 'Posture Corrector Pro' });
      assert.match(await posture.locator('.hero').textContent(), /4\/4\s*rules · ✓ ≈ ✓ ≈/);
      assert.deepStrictEqual(await posture.locator('.grules li').evaluateAll((ls) => ls.map((l) => [l.className, l.querySelector('b').textContent])), [['yes', '✓'], ['aprx', '≈'], ['yes', '✓'], ['aprx', '≈']]);
      assert.match(await posture.locator('.grules li[data-rule="ads"]').getAttribute('title'), /Google's estimate.*approximated with Google's data/);
      assert.match(await posture.textContent(), /Not on Meta/);
      assert.match(await posture.textContent(), /€39\.95/);
      assert.match(await posture.locator('.flags').textContent(), /DE.*NL/);
      assert.match(await posture.locator('.meta').textContent(), /20d\s*live/);
      assert.strictEqual(await posture.locator('a.view').getAttribute('href'), 'https://adstransparency.google.com/advertiser/AR10000000000000000001/creative/CR10000000000000000101');
      assert.strictEqual(await posture.locator('.who a', { hasText: 'Advertiser ↗' }).getAttribute('href'), 'https://adstransparency.google.com/advertiser/AR10000000000000000001');
      // Reach not published: ? not checked, never a ✓; the product page is on the Meta board.
      const glow = page.locator('.card', { hasText: 'Glow Sunset Lamp' });
      assert.match(await glow.locator('.hero').textContent(), /3\/4\s*rules · ✓ ≈ ✓ \?/);
      assert.deepStrictEqual(await glow.locator('.grules li[data-rule="reach"]').evaluate((l) => [l.className, l.querySelector('b').textContent]), ['idk', '?']);
      assert.match(await glow.locator('.grules li[data-rule="reach"]').getAttribute('title'), /not checked: Google gives nothing to check it with/);
      assert.match(await glow.locator('.badges').textContent(), /Also on Meta/);
      assert.match(await page.locator('.card', { hasText: 'Sunset Projection Lamp' }).locator('.badges').textContent(), /Also on TikTok/);
      assert.match(await page.textContent('#grid'), /<img src=x onerror=alert\(1\)>/, 'text stays text');
      assert.ok(await page.locator('.card').evaluateAll((cs) => cs.every((c) => c.scrollWidth <= c.clientWidth + 1)), 'nothing runs off a card');
      assert.ok(await page.locator('.acts button').evaluateAll((bs) => bs.every((b) => b.scrollWidth <= b.clientWidth + 1)), 'Approved and Reject fit');
      await noSideScroll('Google cards');
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/google-${name}.png` });
      // Its own filters; the EU's reach filters and the outside-EU proof filter are not here.
      assert.ok(await page.locator('[data-f="r2500"]').isHidden() && await page.locator('[data-f="p4"]').isHidden());
      assert.ok(await page.locator('[data-f="gfull"]').isVisible() && await page.locator('[data-f="gnometa"]').isVisible());
      await page.click('[data-f="gfull"]');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
      assert.match(await page.textContent('#count'), /2 matches · all four rules first/);
      await page.click('[data-f="gfull"]');
      await page.click('[data-f="gmeta"]');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 1 && /Glow Sunset Lamp/.test(document.querySelector('.card').textContent));
      await page.click('[data-f="gnometa"]');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 3);
      assert.strictEqual(await page.getAttribute('[data-f="gmeta"]', 'aria-pressed'), 'false', 'also and not on Meta: one at a time');
      await page.click('[data-f="gnometa"]');
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 4);
      assert.ok((await page.locator('#sort option').allTextContents()).includes('Impressions / day'));
      await page.selectOption('#sort', 'impr');
      await page.waitForFunction(() => /Posture Corrector Pro/.test(document.querySelector('.card').textContent));
      // The countries, as a radar: no reach anywhere.
      await page.waitForSelector('#radar:not([hidden])');
      assert.match(await page.textContent('#rsub'), /5 countries · 4 products · Google Ads Transparency Center/, 'NL, BE, DE, US and the FR of the HTML-named one');
      assert.doesNotMatch(await page.textContent('#rsub'), /reach \/ day/);
      // Approve: gone here, saved in the same tables as every decision.
      await glow.locator('[data-act="seen"]').click();
      await page.waitForFunction(() => document.querySelectorAll('.card').length === 3);
      assert.strictEqual((await until(() => env.db.prepare("SELECT status FROM hidden WHERE ad_id = 'gCR10000000000000000201'").get())).status, 'seen');
      await page.waitForFunction(() => document.getElementById('nmade').textContent === '1');
      // The Inbox: one product at a time, every rule with its words, the legend and the proof.
      await page.click('[data-view="inbox"]');
      await page.waitForSelector('.card .glegend');
      const one = page.locator('.card');
      assert.match(await one.textContent(), /Posture Corrector Pro/);
      assert.match(await one.locator('.glegend').textContent(), /✓ exactly as on Meta · ≈ approximated with Google's data · \? not checked/);
      assert.match(await one.locator('.grules').textContent(), /EU impressions a day/);
      assert.match(await one.locator('.proofl').textContent(), /Shown in 2 countries/);
      assert.strictEqual(await one.locator('.links a.pri').getAttribute('href'), 'https://adstransparency.google.com/advertiser/AR10000000000000000001/creative/CR10000000000000000101');
      await noSideScroll('the Google inbox');
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/google-inbox-${name}.png` });
      await page.click('[data-tri="rejected"]');
      await page.waitForFunction(() => !/Posture Corrector Pro/.test((document.querySelector('.card') || { textContent: '' }).textContent));
      // The Inbox moves on at once and saves after: wait for the row.
      const saved = await until(() => env.db.prepare("SELECT status FROM hidden WHERE ad_id = 'gCR10000000000000000101'").get());
      assert.strictEqual(saved.status, 'rejected');
      // ✓ lists the approved Google product as a Google card.
      await page.click('[data-view="made"]');
      await page.waitForFunction(() => /Glow Sunset Lamp/.test(document.getElementById('grid').textContent));
      assert.strictEqual(await page.locator('.card .grules').count(), 1);
      // The EU tab: the glow lamp's Meta card says it is on Google too.
      await page.click('[data-scope="eu"]');
      await page.click('[data-view="all"]');
      await page.waitForFunction(() => [...document.querySelectorAll('.card')].some((c) => /Glow Sunset Lamp/.test(c.textContent)));
      assert.match(await page.locator('.card', { hasText: 'Glow Sunset Lamp' }).locator('.badges').textContent(), /Also on Google/);
      assert.strictEqual(await page.locator('.card .grules').count(), 0, 'no Google card on the EU tab');
      // The tab you chose stays.
      await page.click('[data-scope="google"]');
      await page.waitForSelector('.card');
      await page.reload();
      await page.waitForSelector('.card');
      assert.strictEqual(await page.getAttribute('[data-scope="google"]', 'aria-pressed'), 'true');
      if (name === 'phone') {
        for (const w of [320, 360]) {
          await page.setViewportSize({ width: w, height: 740 });
          await noSideScroll(`the Google tab at ${w}px`);
        }
      }
      assert.deepStrictEqual(errors, []);
    } finally {
      await browser.close();
      server.close();
    }
  });
}
