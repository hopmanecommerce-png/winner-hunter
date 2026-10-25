// Outside the EU / EU on the board in a real browser (Chromium via Playwright) at iPhone size, against the Worker
// handler served locally on an in-memory D1. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/markets.e2e.test.mjs    (screenshots of both scopes saved there)
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

test('Outside EU / EU switch: products from outside the EU lead with active ads, the choice is remembered', { skip: !chromium && 'Playwright not installed', timeout: 60000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await seededEnv({ world: true });
  const server = await serve(env);
  const base = `http://localhost:${server.address().port}`;
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route(/^https:\/\//, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' }));
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  try {
    await page.goto(base + '/');
    await page.fill('input[name=pin]', '482913');
    await Promise.all([page.waitForURL(base + '/'), page.click('button[type=submit]')]);
    await page.waitForSelector('.card');
    // outside the EU first: most active ads, no reach on the card, where the ad aims
    assert.strictEqual(await page.getAttribute('[data-scope=world]', 'aria-pressed'), 'true');
    assert.deepStrictEqual((await page.locator('#scope button').allInnerTexts()).map((x) => x.replace(/\s+/g, ' ')), ['🌍 Outside EU 2', '🇪🇺 EU 27']);
    const c = page.locator('.card');
    assert.strictEqual(await c.getAttribute('data-id'), '8001');
    assert.match(await c.locator('.meta').innerText(), /^300\s+shop ads\s+\d+d\s+live\s+\d+\s+copies$/i, 'no reach stat outside the EU');
    assert.match(await c.locator('.facts').innerText(), /aims at Worldwide/);
    assert.ok(!/EU reach/.test(await c.locator('.facts').innerText()));
    assert.strictEqual(await page.textContent('#ileft'), '2 left');
    assert.ok(!(await wide()), 'no sideways scroll');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/markets-world.png` });
    // the EU: reach a day as before; remembered after a reload
    await page.click('[data-scope=eu]');
    await page.waitForFunction(() => document.querySelector('[data-scope=eu]').getAttribute('aria-pressed') === 'true');
    await page.waitForFunction(() => document.querySelector('#ileft').textContent === '27 left');
    assert.match(await page.locator('.card .meta').innerText(), /reach \/ day/i);
    await page.reload();
    await page.waitForSelector('.card');
    assert.strictEqual(await page.getAttribute('[data-scope=eu]', 'aria-pressed'), 'true');
    // ★ and ✓ list every scope, but the Inbox and Browse badges stay counted in the EU you picked
    assert.deepStrictEqual([await page.textContent('#nin'), await page.textContent('#nall')], ['27', '27']);
    for (const v of ['made', 'starred']) {
      await Promise.all([page.waitForResponse((r) => r.url().includes('/api/ads?view=' + v)), page.click(`[data-view=${v}]`)]);
      await page.waitForTimeout(100);
      assert.deepStrictEqual([await page.textContent('#nin'), await page.textContent('#nall')], ['27', '27'], 'badges in ' + v);
    }
    await page.click('[data-view=inbox]');
    await page.waitForSelector('#tri:not([hidden])');
    // Browse outside the EU: most shop ads first, no reach filters or EU radar
    await page.click('[data-scope=world]');
    await page.click('[data-view=all]');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 2);
    assert.deepStrictEqual(await page.locator('.card').evaluateAll((els) => els.map((e) => e.dataset.id)), ['8001', '8002']);
    assert.match(await page.locator('.card .hero').first().innerText(), /300\s+shop ads/i);
    assert.ok(await page.locator('[data-f=r2500]').isHidden() && await page.locator('#radar').isHidden());
    assert.strictEqual(await page.inputValue('#sort'), 'ads');
    assert.ok(!(await wide()), 'no sideways scroll in Browse');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/markets-browse.png` });
    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
