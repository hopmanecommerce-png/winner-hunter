// 🛡 The risk radar in a real browser (Chromium via Playwright) at iPhone size, against the Worker served locally on an
// in-memory D1 with the 36 approved products of test/fixtures/approved-36.json: Block hidden by default in the Inbox and
// Browse, a tap shows them, the reasons and your checks on a card (saved in D1), ✓ with the levels of what you approved, the
// TikTok list and a launch card. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/risk.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { loadApproved } from './helpers/risk-seed.mjs';

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

test('🛡 risk radar on an iPhone: Block hidden by default, the reasons and your checks on a card, ✓ scored, the TikTok list and a launch card; no sideways scroll, no errors', { skip: !chromium && 'Playwright not installed', timeout: 150000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await seededEnv();
  // P1-P36 of the review: the 34 from the EU and outside the EU approved (✓, 33 cards: P16 and P35 are one jacket), the 2 from
  // TikTok not yet; and the hunts' products never approved (outside the EU, and Lilo & Stitch on TikTok)
  await loadApproved(env, NOW, { approve: 'board', others: true });
  const server = await serve(env);
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base }).catch(() => {});
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => (errors.push('dialog: ' + d.message()), d.dismiss()));
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ cookie });
  await page.route(/^https:\/\//, (r) => (/\.(jpe?g|png)(\?|$)/.test(r.request().url()) ? r.fulfill({ contentType: 'image/png', body: PIXEL }) : r.fulfill({ status: 204, body: '' })));
  await page.addInitScript(() => localStorage.setItem('wh-scope', 'eu'));
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/risk-${name}.png`, fullPage: false });
  const noSideScroll = async (where) => {
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
  };
  const check = (k) => { const r = env.db.prepare('SELECT value FROM state WHERE key = ?').get('risk:' + k); return r ? JSON.parse(r.value) : null; };
  const card = (id) => page.locator(`#grid .card[data-id="${id}"]`);
  let ctx2 = null;
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(base + '/');
    await page.waitForSelector('#grid .card .crl');
    // Inbox: one line on the card (the data only: no button or link), the blocked product is out and counted
    const ic = page.locator('#grid .card');
    assert.match(await ic.locator('.crl').innerText(), /^OK\s+Risk radar · no flags$/);
    assert.strictEqual(await ic.locator('.crl button, .crl a').count(), 0, 'the Inbox card: data only');
    assert.strictEqual(await page.textContent('#nin'), '26', '27 seeded, the anti-snoring mouthpiece hidden');
    assert.match(await page.innerText('#crbar'), /^1 product the risk radar blocks is hidden\s+Show$/);
    await noSideScroll('Inbox');
    await shot('1-inbox');

    // Browse: a badge on every card; the blocked one only after a tap on Show
    await page.click('[data-view=all]');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 26);
    assert.strictEqual(await page.locator('#grid .card .crl').count(), 26);
    assert.strictEqual(await card('9011').count(), 0);
    assert.match(await card('9001').locator('.crb').innerText(), /^Docs\s+Claims$/, 'Posture Corrector Pro: a claims caution');
    assert.match(await card('9019').locator('.crb').innerText(), /^Docs\s+CE · Battery · Food contact$/, 'Portable Blender');
    assert.match(await card('9000').locator('.crret').innerText(), /^↩ Sizes$/, 'a dress: a return risk beside an OK');
    await noSideScroll('Browse');
    await shot('2-browse');
    await page.click('#crbar [data-crshow="1"]');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 27);
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('wh-risk')), 'all', 'kept on this phone');
    assert.match(await page.innerText('#crbar'), /are shown, with their badge\s+Hide them$/);
    const snore = card('9011');
    assert.match(await snore.locator('.crb').innerText(), /^Block\s+Medical claim$/);
    // The reasons: a tap opens them (the ad does not open behind it), the card takes the row
    await snore.locator('.crb').click();
    await snore.locator('.crp').waitFor();
    assert.strictEqual(ctx.pages().length, 1, 'no ad opened');
    assert.strictEqual(await snore.locator('.crb').getAttribute('aria-expanded'), 'true');
    assert.match(await snore.locator('.crr').innerText(), /Medical promise in its name \(pain, a condition, snoring\): EU medical device rules \(MDR\)[\s\S]*name: “anti snoring”/);
    await snore.locator('.crr li').first().click();
    assert.strictEqual(ctx.pages().length, 1, 'a tap on the reasons opens nothing either');
    assert.match(await snore.locator('.crp').innerText(), /Shopify Payments: no prohibited group found[\s\S]*GPSR \(since 13 Dec 2024\)[\s\S]*about €5 an order/);
    assert.match(await snore.locator('.crp a', { hasText: 'TMview' }).getAttribute('href'), /^https:\/\/www\.tmdn\.org\/tmview\/#\/tmview\/results\?.*basicSearch=Anti%20Snoring%20Mouthpiece$/);
    const width = await page.evaluate(() => [document.querySelector('#grid .card[data-id="9011"]').getBoundingClientRect().width, document.querySelector('#grid').getBoundingClientRect().width]);
    assert.ok(width[0] >= width[1] - 1, `the open card takes the row (${width})`);
    await noSideScroll('a card with its radar open');
    await shot('3-reasons');
    // Your checks, saved at once: a clear trademark, then your own call
    await snore.locator('[data-crset=tm][data-crval=clear]').click();
    await page.waitForFunction(() => document.querySelector('#grid .card[data-id="9011"] [data-crval=clear]').getAttribute('aria-pressed') === 'true');
    await page.waitForFunction(() => document.getElementById('toastMsg').textContent === 'Saved');
    assert.deepStrictEqual(check('page:shop11.test/products/item-11'), { tm: 'clear', title: 'Anti-Snoring Mouthpiece' });
    await snore.locator('select[data-crset=level]').selectOption('ok');
    await page.waitForFunction(() => /^OK\s+your call · Medical claim$/.test(document.querySelector('#grid .card[data-id="9011"] .crb').innerText));
    await page.waitForFunction(() => document.getElementById('toastMsg').textContent === 'Not blocked any more');
    assert.deepStrictEqual(check('page:shop11.test/products/item-11'), { tm: 'clear', title: 'Anti-Snoring Mouthpiece', level: 'ok' });
    // The supplier request, in English and Chinese
    await snore.locator('[data-crcopy]').click();
    await page.waitForFunction(() => /^(Request copied|Copy the request below)/.test(document.getElementById('toastMsg').textContent));
    const copied = (await page.textContent('#toastMsg')).startsWith('Request copied')
      ? await page.evaluate(() => navigator.clipboard.readText()) : await snore.locator('.crtext').inputValue();
    assert.match(copied, /^Hello, before I order "Anti-Snoring Mouthpiece": could you send these documents\?[\s\S]*您好，下单前请提供此产品的以下文件：/);
    // Hide again: your call keeps it on the board
    await page.click('#crbar [data-crshow="0"]');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 27 && !document.querySelector('#crbar [data-crshow="1"]'));
    assert.ok(await card('9011').count(), 'OK by your call: shown with Block hidden');
    // Your call Block on another one: it leaves Browse at once
    await card('9002').locator('.crb').click();
    await card('9002').locator('select[data-crset=level]').selectOption('block');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 26 && !document.querySelector('#grid .card[data-id="9002"]'));
    assert.match(await page.textContent('#toastMsg'), /Blocked: it leaves the Inbox and Browse/);
    assert.match(await page.innerText('#crbar'), /^1 product the risk radar blocks is hidden/);
    for (const w of [360, 320]) {
      await page.setViewportSize({ width: w, height: 740 });
      await card('9011').locator('.crp').waitFor();
      await noSideScroll(`Browse with a radar open at ${w}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });

    // ✓ Approved: every approved product, blocked ones too, scored
    await page.click('[data-view=made]');
    await page.waitForFunction(() => document.querySelectorAll('#grid .card').length === 33);
    assert.match(await page.innerText('#crbar'), /^Risk radar on the 33 you approved: 9 Block · 8 Docs · 16 OK$/);
    assert.strictEqual(await page.locator('#grid .card .crl.block').count(), 9, "the review's 9 restricted approvals");
    assert.strictEqual(await page.locator('#grid .card .crl .crret', { hasText: 'Sizes' }).count(), 11, 'its 12 with sizes (P16 and P35: one card)');
    const tens = page.locator('#grid .card', { hasText: 'TENS Pijnverlichting' });
    assert.match(await tens.locator('.crb').innerText(), /^Block\s+Medical claim · CE$/, 'the claims caution goes with the medical block');
    await noSideScroll('✓ Approved');
    await page.evaluate(() => scrollTo(0, 0));
    await shot('4-approved');

    // 🚀 A launch card for a blocked product says so
    await page.click('#lnseg');
    await page.waitForSelector('#lnbox .lnpick [data-start]');
    await page.locator('#lnbox .lnpick .lnrow', { hasText: 'TENS Pijnverlichting' }).locator('[data-start]').click();
    await page.waitForSelector('#lnbox .lncard .crl');
    assert.match(await page.locator('#lnbox .lncard .crb').innerText(), /^Block\s+Medical claim/);
    await page.click('#lnbox .lncard .crb');
    await page.locator('#lnbox .lncard .crp').waitFor();
    assert.match(await page.locator('#lnbox .lncard .crr').innerText(), /Medical promise in its name[\s\S]*name: “pijnverlichting”[\s\S]*Electric or electronic[\s\S]*Jev: yes/);
    assert.doesNotMatch(await page.locator('#lnbox .lncard .crr').innerText(), /Jev \d+%/, "a launch card keeps Jev's yes, not its percentage");
    await noSideScroll('a launch card with its radar open');
    await shot('5-launch');

    // TikTok: its list is filtered on the phone, the same rules
    await page.click('[data-scope="tiktok"]');
    await page.waitForSelector('#ttgrid .card');
    await page.click('[data-tf="clean"]'); // all of Jev's blockers, not only "no blocker"
    await page.waitForFunction(() => /^2 of 3/.test(document.getElementById('ttcount').textContent));
    assert.strictEqual(await page.getAttribute('[data-tf="riskAll"]', 'aria-pressed'), 'false', 'hidden, as you left it on the board');
    await ctx.close();

    // A fresh phone: Block hidden on the TikTok tab as well (Lilo & Stitch, a Disney character)
    ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => errors.push(e.message));
    await p2.setExtraHTTPHeaders({ cookie });
    await p2.route(/^https:\/\//, (r) => r.fulfill({ status: 204, body: '' }));
    await p2.addInitScript(() => localStorage.setItem('wh-scope', 'tiktok'));
    await p2.goto(base + '/');
    await p2.waitForSelector('#ttgrid .card .crl');
    await p2.click('[data-tf="clean"]');
    await p2.waitForFunction(() => /^2 of 3/.test(document.getElementById('ttcount').textContent) && document.getElementById('crttn').textContent === '1');
    assert.strictEqual(await p2.locator('#ttgrid .card', { hasText: 'Lilo' }).count(), 0);
    assert.strictEqual(await p2.getAttribute('[data-tf="riskAll"]', 'aria-pressed'), 'false');
    await p2.click('[data-tf="riskAll"]');
    await p2.waitForFunction(() => /^3 of 3/.test(document.getElementById('ttcount').textContent));
    const lilo = p2.locator('#ttgrid .card', { hasText: 'Lilo' });
    assert.match(await lilo.locator('.crb').innerText(), /^Block\s+Brand risk · Kids$/);
    await lilo.locator('.crb').click();
    await lilo.locator('.crp').waitFor();
    assert.match(await lilo.locator('.crp').innerText(), /Shopify Payments prohibits it: Counterfeit products/);
    await lilo.locator('[data-crset=tm][data-crval=conflict]').click();
    await p2.waitForFunction(() => document.getElementById('toastMsg').textContent === 'Saved');
    assert.deepStrictEqual(check('tiktok:1729000000000000039'), { tm: 'conflict', title: 'Lilo & Stitch Plush Toy 30cm' });
    const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `TikTok: no sideways scroll (${overflow}px)`);
    if (SHOTS) await p2.screenshot({ path: `${SHOTS}/risk-6-tiktok.png` });
    // Desktop
    await p2.setViewportSize({ width: 1280, height: 900 });
    await p2.click('[data-scope="eu"]');
    await p2.click('[data-view=all]');
    await p2.waitForFunction(() => document.querySelectorAll('#grid .card .crl').length > 20);
    if (SHOTS) await p2.screenshot({ path: `${SHOTS}/risk-7-desktop.png` });
    assert.deepStrictEqual(errors, []);
  } finally {
    if (ctx2) await ctx2.close().catch(() => {});
    await ctx.close().catch(() => {});
    await browser.close();
    server.close();
  }
});
