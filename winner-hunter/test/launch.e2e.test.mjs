// 🚀 Launch in a real browser (Chromium via Playwright) at iPhone size, against the Worker served locally on an in-memory
// D1: start a launch card from an approved product, fill the checklist (the margin is worked out as you type), reload,
// a second card, move the pin, No go and Go. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/launch.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, makeToken } from '../worker/src/app.mjs';
import { UPSERT_SQL as TIKTOK_UPSERT } from '../lib/tiktok.mjs';
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
const TT_ID = '1700000000000000001';
const A = 'eu|501|posture corrector pro';
const T = `tiktok|${TT_ID}`;

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

test('🚀 Launch on an iPhone: start from an approved product, the margin as you type, saved and back after a reload, the pin, No go and Go; no sideways scroll, no errors', { skip: !chromium && 'Playwright not installed', timeout: 120000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await seededEnv();
  // Approved: two products on the EU board (✓) and one on the TikTok tab, a second apart (the last one first).
  await env.DB.prepare(TIKTOK_UPSERT).bind(JSON.stringify([{ id: TT_ID, title: '【Hot】 Rhino Straps', shop: 'Rhino Shop', url: 'https://www.tiktok.com/shop/pdp/1', image_url: 'https://cdn.shopify.com/tt1.jpg', price_min: 55.77, price_max: 55.77, rating: 4.6,
    reviews: 120, sold_us: 152000, creators: 5, plays: 1000000, category: 'Car', blockers: 'bulky', meta_status: 'none', meta_url: null, meta_unsure: 0, meta_us: null, meta_au: null, meta_nz: null, updated_at: '2026-10-16T10:00:00Z' }])).run();
  const cookie = `__Host-wh=${await makeToken(env.BOARD_PIN, NOW)}`;
  const api = (path, body, now) => handle(new Request('https://board.test' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, { now });
  assert.strictEqual((await api('/api/hide', { ad_id: '9001', status: 'seen' }, NOW - 2000)).status, 200);
  assert.strictEqual((await api('/api/hide', { ad_id: '9003', status: 'seen' }, NOW - 1000)).status, 200);
  assert.strictEqual((await api('/api/tiktok', { id: TT_ID, decision: 'approved' }, NOW)).status, 200);
  const server = await serve(env);
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => (errors.push('dialog: ' + d.message()), d.dismiss()));
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ cookie });
  await page.route(/^https:\/\//, (r) => (/\.(jpe?g|png)(\?|$)/.test(r.request().url()) ? r.fulfill({ contentType: 'image/png', body: PIXEL }) : r.fulfill({ status: 204, body: '' })));
  await page.addInitScript(() => localStorage.setItem('wh-scope', 'eu'));
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/launch-${name}.png`, fullPage: false });
  const noSideScroll = async (where) => {
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
  };
  const saved = () => page.waitForFunction(() => LN.timers.size === 0 && LN.saving === 0 && document.querySelector('#lnsaved').textContent === 'Saved ✓');
  const row = (k) => ({ ...env.db.prepare('SELECT pinned, decision, steps FROM launches WHERE product_key = ?').get(k) });
  const card = () => page.locator('#lnbox .lncard');
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(base + '/');
    await page.waitForSelector('#grid .card');
    await page.waitForFunction(() => window.LAUNCH && LN.list); // the kit (/launch.js) and the count, after the board
    assert.strictEqual(await page.textContent('#nlaunch'), '', 'no launch cards yet');
    // 🚀 sits with the views; the inbox steps aside
    await page.click('#lnseg');
    await page.waitForSelector('#lnbox .lnpick [data-start]');
    assert.strictEqual(await page.getAttribute('#lnseg', 'aria-pressed'), 'true');
    assert.strictEqual(await page.getAttribute('[data-view=inbox]', 'aria-pressed'), 'false');
    assert.ok(await page.locator('#tri').isHidden() && (await page.locator('#grid .card').count()) === 0 && (await page.locator('#pnote').isHidden()), 'the inbox card, buttons and note step aside');
    assert.deepStrictEqual(await page.locator('#lnbox .lnpick .lnrt b').allInnerTexts(), ['Rhino Straps', 'Pet Hair Remover Roller', 'Posture Corrector Pro'], 'every approved product, the last approved first');
    assert.match(await page.locator('#lnbox .lnpick .lnrow').nth(2).innerText(), /EU · approved 17 Oct · ads 11d/);
    assert.match(await page.locator('#lnbox .lnpick .lnrow').first().innerText(), /TikTok · approved 17 Oct · 152K sold/);
    await noSideScroll('pick an approved product');
    await shot('1-pick');

    // Start: the decision card on top, pinned (nothing else is), the first step open
    await page.locator('#lnbox .lnpick .lnrow', { hasText: 'Posture Corrector Pro' }).locator('[data-start]').click();
    await page.waitForSelector('#lnbox .lncard');
    assert.strictEqual(await card().locator('h3').innerText(), 'Posture Corrector Pro');
    assert.strictEqual(await page.getAttribute('[data-ln=pin]', 'aria-pressed'), 'true', 'the first card is the launch pin');
    assert.match(await page.textContent('#toastMsg'), /started and pinned/);
    assert.strictEqual(await page.textContent('#nlaunch'), '1');
    const nums = page.locator('.lnnums .m');
    assert.deepStrictEqual((await nums.allInnerTexts()).map((x) => x.replace(/\s+/g, ' ')), ['– margin', '– break-even ROAS', '11d ads live', '– store products']);
    assert.deepStrictEqual(await page.locator('.lnflags li').allInnerTexts(), ['No margin yet: fill in the selling price and the unit cost', 'Compliance: 4 of 4 checks open', 'Its ads only run 11 days']);
    assert.match(await page.textContent('.lnprog'), /0 of 7 steps done/);
    assert.deepStrictEqual(await page.locator('.lnstep').evaluateAll((ds) => ds.map((d) => d.open)), [true, false, false, false, false, false, false], 'Sourcing open, the other steps folded');
    assert.ok((await card().locator('.lnlinks a', { hasText: 'Ad ↗' }).getAttribute('href')).startsWith('https://www.facebook.com/ads/library/?id=9001'));
    await noSideScroll('a new launch card');
    await shot('2-card');

    // 1 Sourcing: a decimal comma, a link without https://, a tick, a note
    const src = page.locator('[data-step=sourcing]');
    await src.locator('[data-f=supplier]').fill('detail.1688.com/offer/123.html');
    await src.locator('[data-f=unit]').fill('8,50');
    assert.strictEqual(await src.locator('[data-f=supplier]').inputValue(), 'https://detail.1688.com/offer/123.html', 'https:// added when you leave the field');
    await src.locator('[data-f=ship]').fill('4.20');
    await src.locator('[data-f=lead]').fill('12');
    await src.locator('[data-f=moq]').fill('lots');
    await src.locator('[data-f=sample]').check();
    assert.strictEqual(await src.locator('[data-f=moq]').getAttribute('aria-invalid'), 'true', 'not a number: marked, not saved');
    await src.locator('[data-f=moq]').fill('');
    assert.strictEqual(await src.locator('[data-f=moq]').getAttribute('aria-invalid'), null);
    await src.locator('[data-note]').fill('Sample <b>ordered</b>, 9 days to NL');
    assert.strictEqual(await src.locator('[data-fill]').innerText(), '5/6');
    // 2 Margin: worked out as you type, before anything is saved
    await page.click('[data-step=margin] summary');
    const mg = page.locator('[data-step=margin]');
    assert.strictEqual(await mg.locator('[data-f=cogs]').getAttribute('placeholder'), '8.5 from Sourcing');
    assert.strictEqual(await mg.locator('[data-f=fees]').getAttribute('placeholder'), '3');
    assert.strictEqual(await mg.locator('[data-f=vat]').getAttribute('placeholder'), '21');
    assert.match(await mg.locator('#lncalc').innerText(), /Fill in the selling price/);
    await mg.locator('[data-f=price]').fill('39,95');
    assert.strictEqual(await mg.locator('[data-out=be_roas]').innerText(), '2.09×');
    assert.strictEqual(await mg.locator('[data-out=profit]').innerText(), 'add a target CPA');
    await mg.locator('[data-f=cpa]').fill('12');
    assert.strictEqual(await mg.locator('[data-out=profit]').innerText(), '€7.12 at a €12 CPA');
    assert.strictEqual(await mg.locator('[data-out=contribution]').innerText(), '€19.12 (47.9%)');
    assert.strictEqual(await mg.locator('[data-out=be_cpa]').innerText(), '€19.12');
    assert.deepStrictEqual((await nums.allInnerTexts()).slice(0, 2).map((x) => x.replace(/\s+/g, ' ')), ['€19.12 margin · 47.9%', '2.09× break-even ROAS'], 'the decision card follows at once');
    assert.ok(!(await page.textContent('.lnflags')).includes('No margin yet'));
    await mg.locator('[data-done]').check();
    await noSideScroll('margin step');
    await shot('3-margin');
    // 3 Compliance: every check ticked, the flag goes
    await page.click('[data-step=compliance] summary');
    for (const k of ['restricted', 'trademark', 'claims', 'ce']) await page.check(`[data-step=compliance] [data-f=${k}]`);
    await page.check('[data-step=compliance] [data-done]');
    assert.deepStrictEqual(await page.locator('.lnflags li').allInnerTexts(), ['Its ads only run 11 days']);
    assert.match(await page.textContent('.lnprog'), /2 of 7 steps done/);
    assert.strictEqual(await page.locator('.lnmeter i.on').count(), 2);
    // 7 Launch: the kill rule worked out from the margin, one tap
    await page.click('[data-step=launch] summary');
    await page.click('[data-use=kill]');
    assert.strictEqual(await page.inputValue('[data-step=launch] [data-f=kill]'), 'No sale after €38.24 spent (2× the break-even CPA): stop the ad');
    await saved();
    const steps = JSON.parse(row(A).steps);
    assert.deepStrictEqual(steps.sourcing, { done: false, note: 'Sample <b>ordered</b>, 9 days to NL', v: { supplier: 'https://detail.1688.com/offer/123.html', unit: 8.5, ship: 4.2, lead: 12, sample: true } });
    assert.deepStrictEqual(steps.margin, { done: true, note: '', v: { price: 39.95, cpa: 12 } });
    assert.deepStrictEqual(steps.compliance.v, { restricted: true, trademark: true, claims: true, ce: true });
    assert.match(steps.launch.v.kill, /^No sale after €38\.24 spent/);
    await page.evaluate(() => scrollTo(0, 0));
    await shot('4-filled');

    // A reload: everything is still there, the note stays text
    await page.reload();
    await page.waitForSelector('#grid .card');
    await page.click('#lnseg');
    await page.waitForSelector('#lnbox .lncard');
    assert.strictEqual(await card().locator('h3').innerText(), 'Posture Corrector Pro', 'the launch pin opens first');
    await page.click('[data-step=sourcing] summary');
    await page.click('[data-step=margin] summary');
    assert.strictEqual(await page.inputValue('[data-step=sourcing] [data-f=unit]'), '8.5');
    assert.strictEqual(await page.inputValue('[data-step=sourcing] [data-note]'), 'Sample <b>ordered</b>, 9 days to NL');
    assert.strictEqual(await page.locator('#lnbox .lnstep b').count(), 0, 'no HTML from a note');
    assert.strictEqual(await page.innerText('[data-out=be_roas]'), '2.09×');
    assert.ok(await page.isChecked('[data-step=margin] [data-done]'));

    // A second card from TikTok: not pinned (the first one is); pin it, the pin moves
    await page.click('[data-ln=pick]');
    await page.waitForSelector('#lnbox .lnpick [data-start]');
    assert.deepStrictEqual(await page.locator('#lnbox .lnpick .lnrt b').allInnerTexts(), ['Rhino Straps', 'Pet Hair Remover Roller'], 'a product with a card is not offered again');
    await page.locator('#lnbox .lnpick .lnrow', { hasText: 'Rhino Straps' }).locator('[data-start]').click();
    await page.waitForFunction(() => document.querySelector('#lnbox .lncard h3').textContent === 'Rhino Straps');
    assert.strictEqual(await page.getAttribute('[data-ln=pin]', 'aria-pressed'), 'false');
    assert.deepStrictEqual((await nums.allInnerTexts()).slice(2).map((x) => x.replace(/\s+/g, ' ')), ['– ads live', '– store products'], 'TikTok gives no ad dates or store size');
    assert.strictEqual(await page.locator('.lnflags li').first().innerText(), 'Big or heavy', "the TikTok tab's blocker");
    assert.match(await card().innerText(), /\$55\.77 on TikTok · Rhino Shop · 152K sold in the US/);
    await page.click('[data-ln=pin]');
    await page.waitForFunction(() => document.querySelector('[data-ln=pin]').getAttribute('aria-pressed') === 'true');
    assert.deepStrictEqual(env.db.prepare('SELECT product_key FROM launches WHERE pinned = 1').all().map((r) => r.product_key), [T], 'one launch pin: it moved');
    assert.match(await page.locator('.lnother .lnrow').innerText(), /Posture Corrector Pro[\s\S]*EU · break-even ROAS 2\.09 · 2 of 7 steps/);
    await noSideScroll('second card');
    // No go: off the pin, and it cannot be pinned
    await page.click('[data-ld=no]');
    await page.waitForFunction(() => document.querySelector('[data-ld=no]').getAttribute('aria-pressed') === 'true');
    assert.ok(await page.locator('[data-ln=pin]').isDisabled());
    assert.deepStrictEqual(row(T).decision, 'no');
    assert.strictEqual(row(T).pinned, null);
    assert.strictEqual(await page.textContent('#toastMsg'), 'No go: off the launch pin');
    assert.strictEqual(await page.textContent('#nlaunch'), '1', 'the count leaves out a no-go');
    await shot('5-no-go');
    // Back to the first card: pin it again and Go
    await page.locator('.lnother .lnrow', { hasText: 'Posture Corrector Pro' }).click();
    await page.waitForFunction(() => document.querySelector('#lnbox .lncard h3').textContent === 'Posture Corrector Pro');
    await page.click('[data-ln=pin]');
    await page.waitForFunction(() => document.querySelector('[data-ln=pin]').getAttribute('aria-pressed') === 'true');
    await page.click('[data-ld=go]');
    await page.waitForFunction(() => document.querySelector('[data-ld=go]').getAttribute('aria-pressed') === 'true');
    assert.deepStrictEqual([row(A).decision, row(A).pinned], ['go', 1]);
    assert.ok(await card().evaluate((c) => c.classList.contains('go')));
    // The smallest phones: nothing pushes the page sideways
    for (const w of [360, 320]) {
      await page.setViewportSize({ width: w, height: 740 });
      await page.click('[data-step=margin] summary');
      await noSideScroll(`launch card at ${w}px`);
      await page.click('[data-step=margin] summary');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => scrollTo(0, 0));
    await shot('6-go');
    // Another view: the launch view steps aside, the cards come back
    await page.click('[data-view=all]');
    await page.waitForFunction(() => !document.body.classList.contains('lnv') && document.querySelectorAll('#grid .card').length > 0);
    assert.ok(await page.locator('#lnbox').isHidden());
    assert.strictEqual(await page.getAttribute('#lnseg', 'aria-pressed'), 'false');
    assert.strictEqual(await page.getAttribute('[data-view=all]', 'aria-pressed'), 'true');
    // Desktop: the same view, centred
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('#lnseg');
    await page.waitForSelector('#lnbox .lncard');
    await noSideScroll('desktop');
    await shot('7-desktop');
    assert.deepStrictEqual(errors, []);
  } finally {
    await ctx.close();
    await browser.close();
    server.close();
  }
});
