// Momentum in a real browser (Chromium via Playwright) at iPhone size, against the Worker on an in-memory D1 after the
// momentum job ran on four days: the rows on the cards (arrow, sparkline, the move, rivals), the Momentum sort, the panel
// with the weights, the Inbox block with its ranking factor, the EU board without new numbers, the TikTok tab; and the
// photo fingerprints the job makes in the runner's Chrome. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/momentum.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle } from '../worker/src/app.mjs';
import { WEIGHTS } from '../worker/src/momentum.mjs';
import { hashInPage, hamming } from '../lib/momentum.mjs';
import { NOW } from './helpers/seed.mjs';
import { momentumEnv, TT_UP } from './helpers/momentum.mjs';

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

async function launch() {
  try {
    return await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  } catch (e) {
    return chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => null);
  }
}

/** The board's cookie, from its PIN form (as a phone gets it). */
async function cookieOf(env) {
  const res = await handle(new Request('https://board.test/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.8' }, body: 'pin=' + env.BOARD_PIN }), env, { now: NOW });
  return /__Host-wh=[^;]+/.exec(res.headers.get('set-cookie') || '')[0];
}

test('📈 Momentum on an iPhone: rows and sparklines on the cards, the Momentum sort, the panel, the Inbox block, EU and TikTok; no errors, no sideways scroll', { skip: !chromium && 'Playwright not installed', timeout: 120000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await momentumEnv();
  const server = await serve(env);
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ cookie: await cookieOf(env) });
  await page.route(/^https:\/\//, (r) => (/\.(jpe?g|png)(\?|$)/.test(r.request().url()) ? r.fulfill({ contentType: 'image/png', body: PIXEL }) : r.fulfill({ status: 204, body: '' })));
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/momentum-${name}.png`, fullPage: false });
  const noSideScroll = async (where) => {
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
  };
  const card = (title) => page.locator('#grid .card', { has: page.locator('.t', { hasText: title }) });
  try {
    await page.goto(base + '/');
    // Outside the EU (the first tab), Browse: every product has its row.
    await page.waitForSelector('#grid .card .mo');
    assert.ok(await page.evaluate(() => !!window.MOMENTUM && [...document.querySelectorAll('style')].some((s) => s.textContent.includes('.mo1'))), 'the kit ran and its styles were let in by the CSP');
    const riser = card('Bladeless Neck Fan');
    assert.match(await riser.locator('.mo').innerText(), /↑ Rising\s+ads 3 → 11 in 8d\s+3 rivals\s+Ads survived 69d/);
    assert.strictEqual(await riser.locator('.mo svg.msp polyline').count(), 1, 'a sparkline');
    assert.match(await riser.locator('.mo .mcr').getAttribute('title'), /^Getting crowded: 3 other stores sell the same or a similar item \(1 new in 14d\)$/);
    assert.match(await card('Sunset Projection Lamp').locator('.mo').innerText(), /↓ Falling\s+ads 14 → 6 in 8d/);
    assert.match(await card('Cooling Dog Mat').locator('.mo').innerText(), /→ Steady/);
    assert.strictEqual(await page.locator('#grid .card .mo style, #grid .card [style]').count(), 0, 'no style attributes on the cards (the CSP)');
    // The panel: how many rise and fall, the weights.
    await page.waitForSelector('#mobox:not([hidden])');
    assert.strictEqual(await page.textContent('#moboxN'), '1 rising · 1 falling · 0 crowded');
    await page.click('#mobox summary');
    assert.strictEqual(await page.locator('#mobody .mopw tr').count(), Object.keys(WEIGHTS).length, 'every weight in the table');
    assert.match(await page.textContent('#mobody'), /Numbers from 17 Oct, 4 days of history[\s\S]*Rising most \(1\)\s*Bladeless Neck Fan \+0\.87 · ads 3 → 11 in 8d/);
    await shot('1-panel');
    await page.click('#mobox summary');
    await noSideScroll('Browse with momentum');
    // The Momentum sort: rising first, falling last.
    assert.ok((await page.locator('#sort option').allInnerTexts()).includes('Momentum'));
    await page.selectOption('#sort', 'mom');
    await page.waitForFunction(() => /[?&]sort=mom(&|$)/.test(document.querySelector('#csv').href) && document.querySelector('#grid .card .t').textContent === 'Bladeless Neck Fan');
    const titles = await page.locator('#grid .card .t').allInnerTexts();
    assert.deepStrictEqual([titles[0], titles[titles.length - 1]], ['Bladeless Neck Fan', 'Sunset Projection Lamp']);
    await riser.scrollIntoViewIfNeeded();
    await shot('2-browse-sorted');
    // The Inbox outside the EU: the riser first, its block says why and how it ranks.
    await page.click('[data-view=inbox]');
    await page.waitForSelector('#grid .card.open .mob');
    const block = await page.locator('#grid .card.open .mob').innerText();
    assert.match(block, /^↑ Rising \+0\.87\s+ads 3 → 11 in 8d/);
    assert.match(block, /Momentum \+0\.87: Ads \+1\.00 × 0\.35 · Best-seller rank \+0\.90 × 0\.25 · New ads \+1\.00 × 0\.15/);
    assert.match(block, /Ranks it × 1\.135 in the Inbox: Rising \+0\.87 × 1\.261 · Getting crowded × 0\.9/);
    assert.match(block, /Ads survived 69 days: its longest-running ad, from its start to the last time it was seen · 2 of its ads ran 30\+ days/);
    assert.match(block, /Getting crowded: 3 other stores sell the same or a similar item \(1 new in 14d\): rival-one\.test, rival-three\.test, rival-two\.test/);
    assert.match(block, /Tracking since 9 Oct \(4 days of numbers\)/);
    assert.strictEqual(await page.locator('#grid .card.open').locator('.ph, img, .acts, .star').count(), 0, 'still no photo or buttons on the Inbox card');
    await shot('3-inbox');
    await noSideScroll('Inbox with momentum');
    // The EU board: not hunted since, so no trend, and it says why; its small cards only show what is known.
    await page.click('[data-scope=eu]');
    await page.waitForSelector('#grid .card.open .mob');
    assert.match(await page.locator('#grid .card.open .mob').innerText(), /^No trend yet\s+No new numbers since 17 Sep: the EU hunt only runs by hand\s+Ads survived 11 days/);
    await page.click('[data-view=all]');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length > 20);
    const eu = await page.locator('#grid .card .mo').allInnerTexts();
    assert.ok(eu.length > 20 && eu.every((x) => !/No trend yet|Tracking/.test(x)) && eu.some((x) => /^Ads survived \d+d/.test(x)), 'no empty labels on the small cards');
    assert.match(await page.textContent('#moboxN'), /0 rising · 0 falling · 0 crowded · 27 no trend yet/);
    await noSideScroll('EU Browse');
    // TikTok: rows on its cards, its own Momentum sort.
    await page.click('[data-scope=tiktok]');
    await page.waitForSelector('#ttgrid .card .mo');
    const up = page.locator('#ttgrid .card', { hasText: 'Magnetic Phone Holder' });
    assert.match(await up.locator('.mo').innerText(), /↑ Rising\s+≈4\.8K sold a day/);
    assert.match(await page.locator('#ttgrid .card', { hasText: 'Wrinkle Release' }).locator('.mo').innerText(), /↓ Falling\s+≈20 sold a day/);
    await page.selectOption('#ttsort', 'low');
    assert.match(await page.locator('#ttgrid .card .t').first().innerText(), /Wrinkle Release/);
    await page.selectOption('#ttsort', 'mom');
    assert.match(await page.locator('#ttgrid .card .t').first().innerText(), /Magnetic Phone Holder/, 'rising first');
    assert.match(await page.textContent('#ttcount'), /by momentum/);
    assert.strictEqual(await page.locator(`#ttgrid .card[data-id="${TT_UP}"] .mo svg.msp`).count(), 1, 'three imports: two sales speeds, a line');
    await shot('4-tiktok');
    await noSideScroll('TikTok with momentum');
    // A desktop: the same, wider.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('[data-scope=world]');
    await page.waitForSelector('#grid .card .mo svg.msp');
    await noSideScroll('desktop');
    await shot('5-desktop');
    assert.deepStrictEqual(errors, [], 'no errors in the console');
  } finally {
    await browser.close();
    server.close();
  }
});

test('photo fingerprints in Chrome (the job\'s hashInPage): the same picture smaller or as JPEG is a few bits away, another is far, a broken one is ""', { skip: !chromium && 'Playwright not installed', timeout: 60000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  try {
    const page = await browser.newPage();
    // Pictures drawn in the browser: a product on a white background, the same one smaller and as JPEG, and another one.
    const pics = await page.evaluate(async () => {
      const draw = (size, kind, type) => {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, size, size);
        const s = size / 100;
        if (kind === 'fan') {
          g.fillStyle = '#2a6';
          g.beginPath();
          g.arc(50 * s, 45 * s, 30 * s, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#333';
          g.fillRect(45 * s, 70 * s, 10 * s, 25 * s);
        } else {
          g.fillStyle = '#c33';
          g.fillRect(10 * s, 10 * s, 35 * s, 80 * s);
          g.fillStyle = '#36c';
          g.fillRect(60 * s, 50 * s, 30 * s, 40 * s);
        }
        return c.toDataURL(type, 0.8).split(',')[1];
      };
      return { big: draw(400, 'fan', 'image/png'), small: draw(100, 'fan', 'image/jpeg'), other: draw(400, 'lamp', 'image/png') };
    });
    const out = await page.evaluate(hashInPage, [{ k: 'big', b64: pics.big }, { k: 'small', b64: pics.small }, { k: 'other', b64: pics.other }, { k: 'broken', b64: Buffer.from('not a picture').toString('base64') }]);
    const h = Object.fromEntries(out.map((x) => [x.k, x.h]));
    assert.match(h.big, /^[0-9a-f]{16}$/);
    assert.ok(hamming(h.big, h.small) <= 4, `the same picture, smaller and as JPEG: ${hamming(h.big, h.small)} bits apart`);
    assert.ok(hamming(h.big, h.other) >= 16, `another picture: ${hamming(h.big, h.other)} bits apart`);
    assert.strictEqual(h.broken, '');
  } finally {
    await browser.close();
  }
});
