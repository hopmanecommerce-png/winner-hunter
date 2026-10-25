// Store best sellers on the board in a real browser (Chromium via Playwright) at iPhone size, against the Worker
// handler served locally on an in-memory D1. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/bestsellers.e2e.test.mjs    (a screenshot of the Inbox card saved there)
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

function serve(env) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
    const out = await handle(request, env, { html: HTML, now: NOW });
    const headers = {};
    out.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(out.status, headers);
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function launch() {
  try {
    return await chromium.launch();
  } catch (e) {
    return chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => null);
  }
}

test('store best sellers and Trustpilot on the cards: rank and weekly move, Trustpilot score + reviews in the stats block, "not in top 50", sort in Browse', { skip: !chromium && 'Playwright not installed', timeout: 60000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await seededEnv();
  // item-1 (the Inbox's first product) climbed from #5 to #2 in 8 days; item-3 is checked but not in its store's top 50.
  env.db.prepare(`INSERT INTO bestseller (product_key, store, product_id, rank, ok, checked_at, history) VALUES
    ('shop1.test/products/item-1', 'shop1.test', '12', 2, 1, 'x', '[["2026-10-09",5],["2026-10-17",2]]'),
    ('shop3.test/products/item-3', 'shop3.test', '30', NULL, 1, 'x', '[["2026-10-17",null]]')`).run();
  // Trustpilot: shop1 has a real widget (4.2 from 1,252 reviews); shop3 only shows a Trustpilot logo.
  env.db.prepare(`INSERT INTO store_trust (store, status, score, reviews, profile, checked_at) VALUES
    ('shop1.test', 'widget', 4.2, 1252, 'shop1.test', 'x'), ('shop3.test', 'badge', NULL, NULL, NULL, 'x')`).run();
  const server = await serve(env);
  const base = `http://localhost:${server.address().port}`;
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route(/^https:\/\//, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  try {
    await page.goto(base + '/');
    await page.fill('input[name=pin]', '482913');
    await Promise.all([page.waitForURL(base + '/'), page.click('button[type=submit]')]);
    await page.waitForSelector('.card');
    assert.strictEqual(await page.locator('.card .bs.top').innerText(), '🏆 #2 best seller in its store · ↑3 in 8d');
    const tp = page.locator('.card .meta .mtp');
    assert.match(await tp.innerText(), /^4\.2 ★\s+trustpilot\s+1\.3K\s+reviews$/i, 'score and reviews inside the stats block');
    assert.strictEqual(await tp.locator('.good').count(), 1, '4+ is green');
    assert.match(await tp.getAttribute('title'), /Trustpilot 4\.2 from 1,252 reviews/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/bestseller-inbox.png` });
    await page.click('[data-view=all]');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 27);
    assert.strictEqual(await page.locator('.bs.no').first().innerText(), "Not in its store's top 50");
    assert.match(await page.locator('.mtp.mid').first().innerText(), /Badge only\s+Trustpilot named, no real widget/i);
    await page.selectOption('#sort', 'best');
    await page.waitForFunction(() => /#\d+ best seller/.test(document.querySelector('.card .bs')?.textContent || ''));
    assert.match(await page.locator('.card').first().locator('.bs').innerText(), /#2 best seller/);
    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
