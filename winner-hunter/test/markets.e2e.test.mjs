// Untapped markets outside the EU on the board, in a real browser (Chromium via Playwright): the Market Radar's
// "Outside EU" view, the untapped line on the cards, picking a market (with its Ad Library check link) and the
// "Untapped outside EU" chip. iPhone size and desktop. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/markets.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle } from '../worker/src/app.mjs';
import { FOCUS } from '../lib/markets.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (e) {
  // no Playwright: skipped
}
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const SHOTS = process.env.SHOTS || '';
const COLORS = ['#e9b8a6', '#a6c8e9', '#b8e9a6', '#e9e0a6', '#d2a6e9', '#a6e9de'];

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

// The shops' markets as markets.mjs saves them: shop0 worldwide, shop2 the UK, shop3 Europe, shop5 all but New
// Zealand, shop4 not checked (no active ads), the rest EU only.
function cover(env) {
  const put = env.db.prepare('INSERT INTO market_cover (page_id, aims, sampled, partial, checked_at) VALUES (?, ?, ?, 0, ?)');
  const at = new Date(NOW - 3600e3).toISOString();
  const c = (name) => [name, 'countries', 0];
  const special = { 500: [[['Worldwide', 'country_groups', 0]]], 502: [[c('Ireland'), c('United Kingdom')]], 503: [[['Europe', 'country_groups', 0]]],
    505: [[['New Zealand', 'countries', 1], ['Worldwide', 'country_groups', 0]]] };
  for (let i = 0; i < 25; i++) if (i !== 4) put.run(String(500 + i), JSON.stringify(special[500 + i] ?? [[c('France')]]), 10, at);
  put.run('504', '[]', 0, at);
  put.run('703', JSON.stringify([[c('Netherlands')]]), 12, at); // the Stale Old Winner's shop
}

test('board: untapped markets outside the EU (radar, cards, pick a market, the chip) on an iPhone and a desktop', { skip: !chromium && 'Playwright not installed', timeout: 120000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await seededEnv();
  cover(env);
  const server = await serve(env);
  const base = `http://localhost:${server.address().port}`;
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await ctx.route(/^https:\/\//, (route) => {
    const n = Number((route.request().url().match(/p(\d+)\.jpg/) || [0, 0])[1]);
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="${COLORS[n % COLORS.length]}"/></svg>` });
  });
  const shot = async (p, name, full = false) => SHOTS && p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full });
  const noSideScroll = async (p, where) => {
    const { sw, cw } = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
  };
  const cardIds = (p) => p.locator('.card').evaluateAll((els) => els.map((e) => e.dataset.id));
  try {
    await page.goto(base + '/');
    await page.fill('input[name=pin]', '482913');
    await Promise.all([page.waitForURL(base + '/'), page.click('button[type=submit]')]);
    await page.waitForSelector('.card');

    // Inbox: the worldwide shop's product is not in it; the card says what is untapped
    const inboxCard = page.locator('.card').first();
    assert.notStrictEqual(await inboxCard.getAttribute('data-id'), '9000');
    assert.match(await inboxCard.locator('.opn').textContent(), /^Not in its ads/);
    await shot(page, 'm1-inbox');

    // Browse: the radar opens on "Outside EU" (shops are checked), #1 market and the ranking of markets
    await page.click('[data-view=all]');
    await page.waitForSelector('#radar:not([hidden]) .mk[data-open]');
    assert.strictEqual(await page.getAttribute('#radar', 'data-mode'), 'out');
    assert.strictEqual(await page.getAttribute('[data-rm=out]', 'aria-pressed'), 'true');
    assert.match(await page.textContent('#rtop'), /#1 open market/);
    assert.ok(await page.locator('#hexmap').isHidden(), 'no EU map in the Outside EU view');
    const first = await page.locator('.mk[data-open]').first().getAttribute('data-open');
    assert.ok(['US', 'CA', 'AU', 'NZ'].includes(first), `a market every EU-only shop leaves open first: ${first}`);
    assert.match(await page.textContent('#rnote'), /invisible to Meta's API/);
    assert.match(await page.textContent('#rsub'), /products checked · 1 shop already worldwide/);
    await noSideScroll(page, 'radar outside EU');
    await shot(page, 'm2-radar-outside');

    // the cards: untapped flags; the worldwide shop's product left out until the chip is off
    await page.waitForFunction(() => document.querySelectorAll('.card').length > 20);
    let ids = await cardIds(page);
    assert.ok(!ids.includes('9000'), 'shop0 advertises worldwide: left out');
    const c1 = page.locator('.card[data-id="9001"] .opn');
    assert.strictEqual(await c1.textContent(), 'Not in its ads🇺🇸🇬🇧🇨🇦🇦🇺🇳🇿🇨🇭+11Check 🇺🇸 ↗');
    assert.match(await c1.getAttribute('title'), /^None of this shop's ads seen by Meta's API \(they run in the EU or UK\) aim at: United States, United Kingdom, Canada/);
    const usLink = new URL(await c1.locator('a').getAttribute('href'));
    assert.deepStrictEqual([usLink.searchParams.get('country'), usLink.searchParams.get('view_all_page_id'), usLink.searchParams.get('search_type')], ['US', '501', 'page'],
      'a check link on every card: this shop\'s own ads in its first open market');
    assert.doesNotMatch(await page.locator('.card[data-id="9002"] .opn').textContent(), /🇬🇧/, 'shop2 aims at the UK');
    assert.strictEqual(await page.locator('.card[data-id="9004"] .opn').count(), 0, 'not checked: no line');
    assert.strictEqual(await page.getAttribute('#worldChip', 'aria-pressed'), 'true');
    await page.locator('.card[data-id="9001"]').scrollIntoViewIfNeeded();
    await noSideScroll(page, 'cards');
    await shot(page, 'm3-cards');

    await page.click('#worldChip');
    await page.waitForSelector('.card[data-id="9000"]');
    assert.strictEqual(await page.getAttribute('#worldChip', 'aria-pressed'), 'false');
    assert.strictEqual(await page.locator('.card[data-id="9000"] .opn').textContent(), '🌍 Worldwideits ads aim everywhere');
    await page.locator('.card[data-id="9000"]').scrollIntoViewIfNeeded();
    await shot(page, 'm4-worldwide-shown');
    await page.click('#worldChip');
    await page.waitForFunction(() => !document.querySelector('.card[data-id="9000"]'));
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('wh-world')), '', 'the choice is kept');

    // pick New Zealand on the radar: only products whose shop leaves it open, each with a check link for the Ad Library there
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('.mk[data-open="NZ"]');
    await page.waitForSelector('#openChip:not([hidden])');
    assert.match(await page.textContent('#openChip'), /🇳🇿Open in New Zealand ✕/);
    await page.waitForFunction(() => [...document.querySelectorAll('.card .opn')].every((o) => /Check 🇳🇿/.test(o.textContent)) && document.querySelectorAll('.card').length > 0);
    ids = await cardIds(page);
    assert.ok(ids.includes('9005') && !ids.includes('9000') && !ids.includes('9004'), ids.join(','));
    assert.strictEqual(await page.locator('.card[data-id="9005"] .opn').textContent(), 'Not in its ads🇳🇿Check 🇳🇿 ↗');
    const link = page.locator('.card[data-id="9001"] .opn a');
    const href = new URL(await link.getAttribute('href'));
    assert.strictEqual(href.origin + href.pathname, 'https://www.facebook.com/ads/library/');
    assert.deepStrictEqual([href.searchParams.get('country'), href.searchParams.get('view_all_page_id'), href.searchParams.get('active_status')], ['NZ', '501', 'active']);
    assert.strictEqual(await link.getAttribute('target'), '_blank');
    assert.match(await page.locator('.card[data-id="9001"] .opn .fx').textContent(), /^🇳🇿/, 'the picked market first');
    assert.match(await page.textContent('#count'), /matches/);
    await noSideScroll(page, 'New Zealand');
    await shot(page, 'm5-new-zealand');
    await page.click('#openChip');
    await page.waitForSelector('#openChip', { state: 'hidden' });

    // the EU reach view is one tap away (and kept)
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('[data-rm=eu]');
    await page.waitForSelector('.mk[data-cc]');
    assert.strictEqual(await page.getAttribute('#radar', 'data-mode'), 'eu');
    assert.match(await page.textContent('#rtop'), /#1 market\s*Netherlands/);
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('wh-rm')), 'eu');
    await shot(page, 'm6-radar-eu');
    // on a phone, having looked at the EU map does not hide the Outside EU list
    await page.click('[data-rv=map]');
    await page.waitForSelector('#hexmap svg');
    assert.ok(await page.locator('#rlist').isHidden(), 'EU map: the list is hidden (as before)');
    await page.click('[data-rm=out]');
    await page.waitForSelector('.mk[data-open]', { state: 'visible' });
    assert.ok(await page.locator('#rlist').isVisible(), 'Outside EU: the list shows');

    // desktop: the radar list beside the #1 market, no EU map column
    const desk = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
    desk.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    desk.on('pageerror', (e) => errors.push(e.message));
    await desk.context().addCookies(await ctx.cookies());
    await desk.goto(base + '/');
    await desk.evaluate(() => localStorage.setItem('wh-rm', 'out'));
    await desk.click('[data-view=all]');
    await desk.waitForSelector('#radar:not([hidden]) .mk[data-open]');
    assert.ok(await desk.locator('#hexmap').isHidden());
    assert.ok(await desk.locator('[data-rm=out]').isVisible(), 'the Outside EU / EU reach tabs show on a desktop too');
    const cols = await desk.$eval('.rbody', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.strictEqual(cols, 2, 'two columns: #1 market and the list');
    await noSideScroll(desk, 'desktop');
    await shot(desk, 'm7-desktop', false);
    await desk.close();

    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
