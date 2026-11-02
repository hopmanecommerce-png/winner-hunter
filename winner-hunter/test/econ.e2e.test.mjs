// € Unit economics in a real browser (Chromium via Playwright) at iPhone size, against the Worker served locally on an
// in-memory D1: the Decision card on top of the Inbox (its numbers follow as you type a 1688 price), Approved and its line
// in the decision log, the margin on the cards and the two sorts in Browse, the € view (the table sorted by a column, a
// product's prices typed there, the decision log and Undo, the settings), outside the EU, small phones and a desktop.
// Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/econ.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import * as app from '../worker/src/app.mjs';
import { NOW } from './helpers/seed.mjs';
import { econEnv } from './helpers/econ-seed.mjs';

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (e) {
  // no Playwright: skipped
}
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const SHOTS = process.env.SHOTS || '';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64');
const DOG_MAT = 'eu|shop5.test/products/item-5';
const { handle } = app;
// The login cookie as the board makes it (tokenFor where the board has it, makeToken from the PIN before).
const token = (env, now) => (app.tokenFor ? app.tokenFor(env, now) : app.makeToken(env.BOARD_PIN, now));

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

// "€22.90" or "−€3.20" as a number
const euros = (t) => Number(String(t).replace(/[^\d.−-]/g, '').replace('−', '-'));

test('€ on an iPhone: the Decision card on top of the Inbox, its numbers as you type, Approved logged; margins and sorts in Browse; the € table, the decision log and Undo, the settings; no sideways scroll, no errors', { skip: !chromium && 'Playwright not installed', timeout: 180000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await econEnv();
  const server = await serve(env);
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => (errors.push('dialog: ' + d.message()), d.dismiss()));
  const posts = []; // every save of a product's numbers, as sent
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/econ')) posts.push(r.postData()); });
  await page.exposeFunction('seenToast', (msg) => { if (/^Could not/.test(msg)) errors.push('toast: ' + msg); });
  await page.addInitScript(() => new MutationObserver(() => { const el = document.getElementById('toastMsg'); if (el && el.textContent) window.seenToast(el.textContent); })
    .observe(document, { subtree: true, childList: true, characterData: true }));
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ cookie: `__Host-wh=${await token(env, NOW)}` });
  await page.route(/^https:\/\//, (r) => (/\.(jpe?g|png)(\?|$)/.test(r.request().url()) ? r.fulfill({ contentType: 'image/png', body: PIXEL }) : r.fulfill({ status: 204, body: '' })));
  await page.addInitScript(() => localStorage.setItem('wh-scope', 'eu'));
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/econ-${name}.png`, fullPage: false });
  const noSideScroll = async (where) => {
    const { sw, cw, right } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      right: Math.max(...['#ecdec', '#ecbox'].map((s) => document.querySelector(s)).filter((el) => el && !el.hidden && el.offsetParent).map((el) => el.getBoundingClientRect().right), 0) }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
    assert.ok(right <= cw, `${where}: the € box ends at ${right}px in a ${cw}px screen`);
  };
  const saved = () => page.waitForFunction(() => EC.timers.size === 0 && EC.saving === 0 && [...document.querySelectorAll('[data-ecsaved]')].some((el) => el.textContent === 'Saved ✓'));
  const inputs = (key) => ({ ...env.db.prepare('SELECT cost_text, weight_g, price FROM econ_inputs WHERE product_key = ?').get(key) });
  const dc = page.locator('#ecdec');
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(base + '/');
    await page.waitForSelector('#ecdec .ecpanel');
    await page.waitForFunction(() => window.ECON && EC.s); // the kit (/econ.js) and the settings, after the board

    // The Decision card: the verdict, four numbers and the reasons on top of the Inbox, Reject and Approved below: one screen.
    assert.match(await dc.locator('.ecpill').innerText(), /^(Green|Amber|Red)$/);
    assert.deepStrictEqual(await dc.locator('.ecn span').allInnerTexts(), ['margin / order', 'break-even ROAS', 'ads live', 'store size']);
    assert.ok((await dc.locator('.ecr li').count()) >= 2, 'its reasons');
    assert.ok(await dc.locator('.ecg').isVisible(), 'estimate: no supplier price typed yet');
    const why = await dc.locator('.ecr').boundingBox();
    const tri = await page.locator('#tri').boundingBox();
    assert.ok(why.y + why.height <= tri.y && tri.y + tri.height <= 844, 'verdict, numbers and reasons above Reject and Approved, on one screen');
    assert.strictEqual(await page.locator('#grid .card').count(), 1, 'the Inbox card below it, as before');
    assert.strictEqual(await page.locator('#grid .card .ecs, #grid .card img').count(), 0, 'no margin line on the Inbox card (the Decision card has it), no photo');
    assert.strictEqual(await page.locator('[data-view]').count(), 4, 'the € button has no data-view: the four views stay as they were');
    const key = await dc.locator('.ecpanel').getAttribute('data-eckey');
    const margin = () => dc.locator('.ecn b').first().innerText();
    const m0 = await margin();
    await noSideScroll('Decision card');
    await shot('1-decision-card');

    // A 1688 price: the numbers follow at once, before the save (held back here) lands.
    await page.route('**/api/econ', async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.continue(); });
    await dc.locator('[data-ecin=cost]').fill('24');
    assert.notStrictEqual(await margin(), m0, 'the margin follows as you type');
    assert.strictEqual(await dc.locator('.ecg').count(), 0, 'no longer an estimate');
    await saved();
    await page.unroute('**/api/econ');
    assert.deepStrictEqual(inputs(key), { cost_text: '24', weight_g: null, price: null }, 'saved as typed: a bare number is in yuan');
    // A weight that cannot be read is never sent, also when a save is already on its way (the supplier price was left: a
    // save at once) and the weight is typed before it goes out: the supplier price saves, the weight stays as typed.
    await page.evaluate(() => {
      const cost = document.querySelector('#ecdec [data-ecin=cost]');
      const weight = document.querySelector('#ecdec [data-ecin=weight]');
      cost.value = '24.5';
      cost.dispatchEvent(new Event('input', { bubbles: true }));
      cost.dispatchEvent(new Event('change', { bubbles: true }));
      weight.value = 'heavy';
      weight.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await saved();
    assert.deepStrictEqual(inputs(key), { cost_text: '24.5', weight_g: null, price: null });
    assert.strictEqual(await dc.locator('[data-ecin=weight]').inputValue(), 'heavy', 'what you typed stays');
    // Marked when you leave the field, and not saved; then one that can be read.
    await dc.locator('[data-ecin=weight]').press('Enter');
    assert.strictEqual(await dc.locator('[data-ecin=weight]').getAttribute('aria-invalid'), 'true');
    await page.waitForTimeout(900);
    assert.strictEqual(inputs(key).weight_g, null);
    assert.ok(!posts.some((b) => /heavy/.test(b)), 'never sent');
    await dc.locator('[data-ecin=weight]').fill('0,2 kg');
    await dc.locator('[data-ecin=weight]').press('Enter');
    await saved();
    assert.strictEqual(inputs(key).weight_g, 200);
    assert.strictEqual(await dc.locator('[data-ecin=weight]').getAttribute('aria-invalid'), null);
    // Every line of the order.
    await dc.locator('.ecbd summary').click();
    assert.match(await dc.locator('.ecbd').innerText(), /VAT 21% \(IOSS\)[\s\S]*Supplier price \(24\.5 CNY\)[\s\S]*Shipping 200 g \(up to 250 g\)[\s\S]*EU customs duty on the parcel[\s\S]*= Margin before ads/);
    await noSideScroll('Decision card with the breakdown');
    await shot('2-typed');

    // Approved (key D): logged with these numbers; the next product gets its own Decision card.
    const title = await page.locator('#grid .card .t').innerText();
    await page.keyboard.press('d');
    await page.waitForFunction((k) => { const p = document.querySelector('#ecdec .ecpanel'); return p && p.dataset.eckey !== k; }, key);
    await page.waitForFunction(() => document.querySelector('#nmade').textContent === '1');
    await page.waitForFunction(() => document.querySelector('#why') && !document.querySelector('#why').hidden);
    const [logged] = env.db.prepare('SELECT * FROM decision_log').all();
    assert.deepStrictEqual([logged.decision, logged.title, JSON.parse(logged.facts).econ.inputs, JSON.parse(logged.facts).econ.key], ['approved', title, { cost_text: '24.5', weight: 200, price: null }, key]);

    // Browse: the margin line on every card; Margin / order sorts the most margin first.
    await page.click('[data-view=all]');
    await page.waitForSelector('#grid .card .ecs');
    assert.strictEqual(await page.locator('#grid .card .ecs').count(), await page.locator('#grid .card').count());
    assert.match(await page.locator('#grid .card .ecs').first().innerText(), /€[\d.]+ \/ order[\s\S]*break-even ROAS/);
    await Promise.all([page.waitForResponse((r) => r.url().includes('sort=profit')), page.selectOption('#sort', 'profit')]);
    await page.waitForTimeout(100);
    const ms = (await page.locator('#grid .card .ecs').evaluateAll((els) => els.map((e) => e.querySelector('b').textContent))).map(euros);
    assert.ok(ms.length > 10 && ms.every((x, i) => !i || ms[i - 1] >= x), `most margin first: ${ms.join(' ')}`);
    assert.deepStrictEqual(await page.locator('#sort option').evaluateAll((os) => os.slice(-2).map((o) => o.textContent)), ['Margin / order', 'Break-even ROAS']);
    await noSideScroll('Browse with margins');
    await shot('3-browse');

    // The € view: every Inbox and ✓ product in a table; the hunt's lists step aside.
    await page.click('#ecseg');
    await page.waitForSelector('#ecbox .ect tbody tr[data-ecrow]');
    assert.strictEqual(await page.getAttribute('#ecseg', 'aria-pressed'), 'true');
    assert.ok((await page.locator('#grid .card').count()) === 0 && (await page.locator('#ibox').isHidden()) && (await page.locator('#csv').isHidden()));
    const total = await page.evaluate(async () => (await (await fetch('/api/econ?limit=1')).json()).total);
    assert.match(await page.textContent('#ecbox .eccount'), new RegExp(`^${total} products`));
    // A tap on a column sorts by it (dispatched: on a phone the sticky product column may cover the header); again: the other way.
    const cells = async (i) => (await page.locator(`#ecbox tr[data-ecrow] td:nth-child(${i})`).allInnerTexts()).map(euros);
    await page.locator('#ecbox [data-ecsort=profit]').dispatchEvent('click');
    await page.waitForSelector('#ecbox th[aria-sort="descending"] [data-ecsort=profit]');
    const down = await cells(5);
    assert.ok(down.every((x, i) => !i || down[i - 1] >= x), 'margin, most first');
    await page.locator('#ecbox [data-ecsort=profit]').dispatchEvent('click');
    await page.waitForSelector('#ecbox th[aria-sort="ascending"] [data-ecsort=profit]');
    const up = await cells(5);
    assert.ok(up.every((x, i) => !i || up[i - 1] <= x), 'margin, least first');
    // A product's prices, typed in the table: saved, its row follows.
    const row = page.locator('#ecbox tr[data-ecrow]', { hasText: 'Cooling Dog Mat' });
    const before = await row.locator('td').nth(4).innerText();
    await row.locator('[data-ecopen]').dispatchEvent('click');
    const panel = page.locator('#ecbox .ecx .ecpanel');
    await panel.waitFor();
    await panel.locator('[data-ecin=cost]').fill('¥1');
    await panel.locator('[data-ecin=cost]').press('Enter');
    await saved();
    assert.strictEqual(inputs(DOG_MAT).cost_text, '¥1');
    assert.notStrictEqual(await page.locator('#ecbox tr[data-ecrow]', { hasText: 'Cooling Dog Mat' }).locator('td').nth(4).innerText(), before, 'its margin in the row follows');
    assert.ok((await page.locator('#ecbox .ecx a', { hasText: 'Search 1688' }).getAttribute('href')).startsWith('https://s.1688.com/'));
    await noSideScroll('€ table with a product open');
    await shot('4-table');

    // The decision log: the Approved from the Inbox with its numbers then; Undo makes it undecided again.
    await page.click('[data-ectab=log]');
    await page.waitForSelector('#ecbox .ect.log tr[data-eclog]');
    assert.match(await page.textContent('#ecbox [data-ecrate]'), /On the board now: 1 approved · 0 rejected \(100% approved\), the TikTok tab included\./, 'every decision the board holds, your approval rate');
    const lr = page.locator('#ecbox tr[data-eclog]').first();
    assert.match(await lr.innerText(), /✓ Approved/);
    assert.match(await lr.locator('.ect1 b').innerText(), new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await lr.locator('[data-eclogopen]').dispatchEvent('click');
    await page.waitForSelector('#ecbox .ect.log .ecx');
    assert.match(await page.locator('#ecbox .ect.log .ecx').innerText(), /On 17 Oct the board showed: price €[\d.]+ · landed cost €[\d.]+ · supplier price €2\.94 · 200 g/);
    await shot('5-log');
    await page.locator('#ecbox [data-ecundo]').first().dispatchEvent('click');
    await page.waitForFunction(() => /^Taken back: /.test(document.querySelector('#toastMsg').textContent));
    assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM hidden').get().n, 0, 'undecided again');
    assert.deepStrictEqual({ ...env.db.prepare('SELECT undo_via FROM decision_log').get() }, { undo_via: 'log' });
    await page.waitForFunction(() => document.querySelector('#ecbox .lnmuted') && /No decisions yet/.test(document.querySelector('#ecbox .lnmuted').textContent));
    await page.locator('#ecbox [data-ecundone]').dispatchEvent('click');
    await page.waitForSelector('#ecbox tr[data-eclog].off');
    assert.match(await page.locator('#ecbox tr[data-eclog]').first().innerText(), /taken back 17 Oct/);
    assert.strictEqual(await page.locator('#ecbox [data-ecundo]').count(), 0, 'once');

    // The settings: VAT 19% saved and every number follows; back to the defaults takes two taps.
    await page.click('[data-ectab=settings]');
    await page.waitForSelector('#ecset');
    assert.strictEqual(await page.inputValue('#ecset [name=duty_from]'), '2026-07-01');
    assert.strictEqual(await page.inputValue('#ecset [name=handling_from]'), '2026-11-01');
    await page.fill('#ecset [name=vat_pct]', '19');
    await page.click('#ecset button[type=submit]');
    await page.waitForFunction(() => /^Settings saved/.test(document.querySelector('#toastMsg').textContent));
    assert.strictEqual(JSON.parse(env.db.prepare('SELECT value FROM econ_settings').get().value).vat_pct, 19);
    await noSideScroll('settings');
    await shot('6-settings');
    await page.click('#ecset [data-ecreset]');
    assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM econ_settings').get().n, 1, 'one tap: nothing changed');
    await page.click('#ecset [data-ecreset]');
    await page.waitForFunction(() => /back to the defaults/.test(document.querySelector('#toastMsg').textContent));
    assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM econ_settings').get().n, 0);

    // Back in the Inbox: the € view steps aside; the product taken back is first again.
    await page.click('[data-view=inbox]');
    await page.waitForSelector('#ecdec .ecpanel');
    assert.ok(await page.locator('#ecbox').isHidden());
    assert.strictEqual(await page.getAttribute('#ecseg', 'aria-pressed'), 'false');
    await page.waitForFunction((x) => document.querySelector('#grid .card .t') && document.querySelector('#grid .card .t').textContent === x, title);
    assert.strictEqual(await dc.locator('[data-ecin=cost]').inputValue(), '24.5', 'its supplier price is still there');
    // The Decision card's link opens the decision log.
    await dc.locator('[data-ecgo=log]').click();
    await page.waitForSelector('#ecbox [data-ectab=log][aria-pressed="true"]');
    await page.click('[data-view=inbox]');
    await page.waitForSelector('#ecdec .ecpanel');

    // Outside the EU: the Decision card there too: the oldest ad, Jev's battery an amber reason.
    await page.click('[data-scope=world]');
    await page.click('[data-view=inbox]');
    await page.waitForFunction(() => document.querySelector('#ecdec .ecpanel') && /oldest ad/.test(document.querySelector('#ecdec').textContent));
    assert.match(await dc.innerText(), /210d[\s\S]*oldest ad[\s\S]*Battery or electric/);
    await noSideScroll('Decision card outside the EU');
    await shot('7-world');

    // The smallest phones and a desktop: nothing pushes the page sideways.
    for (const w of [360, 320]) {
      await page.setViewportSize({ width: w, height: 740 });
      await noSideScroll(`Inbox at ${w}px`);
      await page.click('#ecseg');
      await page.waitForSelector('#ecbox:not([hidden]) .ectabs');
      await noSideScroll(`€ view at ${w}px`);
      await page.click('[data-view=inbox]');
      await page.waitForSelector('#ecdec .ecpanel');
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('#ecseg');
    await page.click('[data-ectab=products]');
    await page.waitForSelector('#ecbox .ect tbody tr[data-ecrow]');
    assert.ok(await page.locator('#ecbox .ectw').evaluate((w) => w.scrollWidth <= w.clientWidth + 1), 'a desktop shows every column');
    await noSideScroll('desktop');
    await shot('8-desktop');
    assert.deepStrictEqual(errors, []);
  } finally {
    await ctx.close();
    await browser.close();
    server.close();
  }
});
