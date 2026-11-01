// 🔎 Sourcing in a real browser (Chromium via Playwright) at iPhone size, against the Worker served locally on an
// in-memory D1, with a fake CJ Dropshipping API behind the Worker's fetch: the panel on a launch card, search links,
// paste and fill in suppliers, compare, choose one (the launch card's numbers follow), the checklists, the first message,
// CJ by photo with its freight, and everything back after a reload. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/sourcing.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { fakeCj, CJ_KEY } from './helpers/fake-cj.mjs';

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (e) {
  // no Playwright: skipped
}
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const SHOTS = process.env.SHOTS || '';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64');
const KEY = 'eu|shop1.test/products/item-1';
const SHARE = '【1688】护腰带 姿势矫正器 ¥12.50 2-99件 回头率35% 4.8分 源头工厂 https://m.1688.com/offer/695123456789.html?spm=a26352';

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

test('🔎 Sourcing on an iPhone: links, paste and compare suppliers, choose one (the launch card follows), checklists, message, CJ; back after a reload; no sideways scroll, no errors', { skip: !chromium && 'Playwright not installed', timeout: 150000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await seededEnv();
  env.CJ_API_KEY = CJ_KEY;
  const cj = fakeCj();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => (String(url).startsWith('https://developers.cjdropshipping.com/') ? cj.fetch(url, init) : realFetch(url, init)); // the Worker's calls to CJ
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const api = (path, body) => handle(new Request('https://board.test' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, { now: NOW });
  // Approved, its launch card started, a selling price in its Margin step: the margin waits for a unit cost.
  assert.strictEqual((await api('/api/hide', { ad_id: '9001', status: 'seen' })).status, 200);
  assert.strictEqual((await api('/api/launch', { start: KEY })).status, 200);
  assert.strictEqual((await api('/api/launch', { key: KEY, step: 'margin', v: { price: 39.95 } })).status, 200);
  const server = await serve(env);
  const base = `http://127.0.0.1:${server.address().port}`;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_|Failed to load/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => (errors.push('dialog: ' + d.message()), d.dismiss()));
  await page.clock.setFixedTime(new Date(NOW));
  await page.setExtraHTTPHeaders({ cookie });
  await page.route(/^https:\/\//, (r) => (/\.(jpe?g|png)(\?|$)/.test(r.request().url()) ? r.fulfill({ contentType: 'image/png', body: PIXEL }) : r.fulfill({ status: 204, body: '' })));
  await page.addInitScript(() => localStorage.setItem('wh-scope', 'eu'));
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/sourcing-${name}.png`, fullPage: false });
  const noSideScroll = async (where) => {
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
  };
  const idle = () => page.waitForFunction(() => SX.busy === 0 && LN.saving === 0);
  const row = (k) => ({ ...env.db.prepare('SELECT * FROM product_sourcing WHERE product_key = ?').get(k) });
  const item = (text) => page.locator('#sxlist .sxs', { hasText: text });
  const href = (label) => page.locator('#sxlinks a', { hasText: label }).getAttribute('href');
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(base + '/');
    await page.waitForSelector('#grid .card');
    await page.click('#lnseg');
    await page.waitForSelector('#lnbox .lncard');
    // The panel sits between the decision card and the checklist, folded, with what it holds
    await page.waitForFunction(() => document.querySelector('#sxsum') && SX.data);
    assert.strictEqual(await page.locator('#lnbox > .lncard + #sxpanel + .lnsteps').count(), 1);
    assert.strictEqual(await page.textContent('#sxsum'), 'No supplier yet: find, compare, vet, sample');
    assert.strictEqual(await page.evaluate(() => document.querySelector('#sxbox').open), false);
    await page.click('#sxbox > summary');
    assert.strictEqual(await href('1688'), 'https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=Posture%20Corrector%20Pro');
    assert.strictEqual(await href('Google Lens'), 'https://lens.google.com/uploadbyurl?url=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2Fp1.jpg%3Fwidth%3D400');
    assert.strictEqual(await href('CJ'), 'https://cjdropshipping.com/?searchValue=Posture%20Corrector%20Pro&selectedTabKey=cj');
    assert.strictEqual(await page.locator('#sxlinks a[target=_blank][rel="noopener noreferrer"]').count(), 7);
    assert.match(await page.textContent('#sxfees'), /€3 duty \+ €2 handling from 1 Nov 2026/, 'on 17 Oct 2026 the handling fee is still to come');
    // Chinese words for 1688: saved when you leave the field, and the 1688 link takes them
    await page.fill('[data-sx-info=zh]', '姿势矫正器');
    await page.locator('[data-sx-info=zh]').blur();
    await idle();
    assert.strictEqual(await href('1688'), 'https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=%E5%A7%BF%E5%8A%BF%E7%9F%AB%E6%AD%A3%E5%99%A8');
    assert.strictEqual(row(KEY).zh, '姿势矫正器');
    await noSideScroll('the panel open');
    await shot('1-find');

    // Paste what the 1688 app shares: price, MOQ, rating, repeat buyers and factory come along; its form opens for the rest
    await page.fill('#sxpaste', SHARE);
    await page.click('[data-sx=add]');
    await page.waitForSelector('#sxlist .sxedit');
    assert.strictEqual(await page.inputValue('#sxpaste'), '');
    assert.deepStrictEqual(await Promise.all(['url', 'title', 'unit_price', 'currency', 'moq', 'rating', 'repeat_rate', 'kind'].map((k) => page.inputValue(`.sxedit [data-sx-f=${k}]`))),
      ['https://detail.1688.com/offer/695123456789.html', '护腰带 姿势矫正器', '12.5', 'CNY', '2', '4.8', '35', 'factory']);
    await page.fill('.sxedit [data-sx-f=ship_price]', '30');
    await page.fill('.sxedit [data-sx-f=weight_g]', '320');
    await page.fill('.sxedit [data-sx-f=lead_days]', '12');
    await page.click('.sxedit [data-sx=save]');
    await page.waitForFunction(() => !document.querySelector('#sxlist .sxedit'));
    assert.match(await item('护腰带').innerText(), /€8\.12\s*at the door[\s\S]*€1\.51 unit \+ €3\.61 shipping \+ €3 EU fees \(¥12\.50 \+ ¥30\)[\s\S]*MOQ 2 · ★ 4\.8 · Factory · 35% repeat buyers · 12 days · 320 g/);
    // A second supplier: a link alone, then its numbers. A typo is marked and not saved.
    await page.fill('#sxpaste', 'https://www.aliexpress.com/item/1005006123456789.html?spm=a2g0o');
    await page.click('[data-sx=add]');
    await page.waitForSelector('#sxlist .sxedit');
    await page.fill('.sxedit [data-sx-f=unit_price]', '4,99');
    await page.fill('.sxedit [data-sx-f=ship_price]', '2.50');
    await page.selectOption('.sxedit [data-sx-f=kind]', 'trader');
    await page.fill('.sxedit [data-sx-f=repeat_rate]', '12');
    await page.fill('.sxedit [data-sx-f=moq]', 'lots');
    await page.click('.sxedit [data-sx=save]');
    assert.strictEqual(await page.getAttribute('.sxedit [data-sx-f=moq]', 'aria-invalid'), 'true');
    assert.strictEqual(await page.textContent('#toastMsg'), 'Not saved: check the marked fields');
    await page.fill('.sxedit [data-sx-f=moq]', '');
    await page.click('.sxedit [data-sx=save]');
    await page.waitForFunction(() => !document.querySelector('#sxlist .sxedit'));
    await idle();
    assert.deepStrictEqual(await page.locator('#sxlist .sxs .sxp').allInnerTexts(), ['1688', 'AliExpress'], 'cheapest at the customer’s door first');
    assert.strictEqual(await page.locator('#sxlist .sxs').first().locator('.sxbest').innerText(), 'Cheapest');
    assert.deepStrictEqual(await item('aliexpress').locator('.sxflags li').allInnerTexts(), ['A trader, not the factory', 'Few repeat buyers: 12%']);
    assert.strictEqual(await page.textContent('#sxsum'), '2 suppliers, none chosen yet');
    await noSideScroll('two suppliers');
    await shot('2-compare');

    // Choose the 1688 supplier: its cost lands in the launch card's Sourcing step, and the decision card's margin follows
    assert.deepStrictEqual((await page.locator('.lnnums .m').allInnerTexts()).slice(0, 2).map((x) => x.replace(/\s+/g, ' ')), ['– margin', '– break-even ROAS']);
    await item('护腰带').locator('[data-sx=choose]').click();
    await page.waitForFunction(() => document.querySelector('#sxlist .sxs.on [data-sx=choose]')?.getAttribute('aria-pressed') === 'true');
    await idle();
    assert.strictEqual(await page.textContent('#toastMsg'), 'On the launch card: €1.51 a unit + €3.61 shipping');
    assert.strictEqual(await page.locator('#lnbox > .lncard + #sxpanel').count(), 1, 'the panel is back after the launch card rendered again');
    assert.strictEqual(await page.evaluate(() => document.querySelector('#sxbox').open), true, 'still open');
    assert.strictEqual(await page.textContent('#sxsum'), 'Chosen: 1688, €8.12 at the door');
    assert.deepStrictEqual((await page.locator('.lnnums .m').allInnerTexts()).slice(0, 2).map((x) => x.replace(/\s+/g, ' ')), ['€26.70 margin · 66.8%', '1.5× break-even ROAS']);
    await page.click('[data-step=sourcing] summary');
    assert.deepStrictEqual(await Promise.all(['supplier', 'unit', 'ship', 'moq', 'lead'].map((k) => page.inputValue(`[data-step=sourcing] [data-f=${k}]`))),
      ['https://detail.1688.com/offer/695123456789.html', '1.51', '3.61', '2', '12'], 'the launch card’s own fields');
    assert.deepStrictEqual([row(KEY).supplier_cost, row(KEY).supplier_url, row(KEY).weight_g], [1.51, 'https://detail.1688.com/offer/695123456789.html', 320], 'the shared columns');
    // Your rate for the yuan: the chosen supplier's euros follow on the launch card
    await page.fill('[data-sx-info=eur_cny]', '8');
    await page.locator('[data-sx-info=eur_cny]').blur();
    await page.waitForFunction(() => document.querySelector('[data-step=sourcing] [data-f=unit]')?.value === '1.56');
    await idle();
    assert.strictEqual(row(KEY).supplier_cost, 1.56);
    await page.click('[data-step=sourcing] summary');
    await page.evaluate(() => document.querySelector('#sxpanel').scrollIntoView());
    await shot('3-chosen');

    // The vetting and sample checklists: a tick saves at once
    await page.click('[data-sx-fold=vet] > summary');
    await page.check('[data-sx-check=vet][value=video]');
    await page.check('[data-sx-check=vet][value=certs]');
    await idle();
    assert.strictEqual(await page.textContent('#sxn-vet'), '2/10');
    await page.click('[data-sx-fold=sample] > summary');
    await page.check('[data-sx-check=sample][value=qc]');
    await idle();
    assert.deepStrictEqual(JSON.parse(row(KEY).checks), { vet: { video: true, certs: true }, sample: { qc: true } });
    // The first message: to an agent in English, then to the chosen supplier in Chinese, with your name; copied
    await page.click('[data-sx-fold=msg] > summary');
    let msg = await page.inputValue('#sxmsgt');
    assert.match(msg, /^Hello! I run an online shop in the Netherlands[\s\S]*\nPosture Corrector Pro\nPhoto: https:\/\/cdn\.shopify\.com\/s\/files\/1\/p1\.jpg\?width=400\nSold here: https:\/\/shop1\.test\/products\/item-1\nChinese search words: 姿势矫正器\n/);
    await page.click('[data-sx-to=supplier]');
    await page.click('[data-sx-lang=zh]');
    await page.fill('#sxname', 'Connor');
    await page.fill('#sxqty', '30');
    msg = await page.inputValue('#sxmsgt');
    assert.match(msg, /^您好！我叫Connor，在荷兰开网店[\s\S]*\nhttps:\/\/detail\.1688\.com\/offer\/695123456789\.html\n\n我想先拿1–2个样品，然后先试单约30个/);
    assert.strictEqual(await page.getAttribute('[data-sx-lang=zh]', 'aria-pressed'), 'true');
    await page.click('[data-sx=copy]');
    await page.waitForFunction(() => document.querySelector('#toastMsg').textContent === 'Message copied');
    assert.strictEqual(await page.evaluate(() => navigator.clipboard.readText()), msg);
    await noSideScroll('checklists and message');
    await shot('4-message');

    // CJ: by photo, its freight to NL/DE/FR, then added: from its German stock it lands cheapest
    await page.click('[data-sx=cj-photo]');
    await page.waitForSelector('#sxcj .sxcjp');
    assert.strictEqual(await page.locator('#sxcj .sxcjp').count(), 1);
    assert.match(await page.locator('#sxcj .sxcjp').innerText(), /Adjustable Posture Corrector Back Brace[\s\S]*\$4\.20 · 180 g · 13K in stock/);
    await page.click('#sxcj [data-sx=cj-quote]');
    await page.waitForSelector('#sxcj [data-sx=cj-quote]:text("Freight again")');
    assert.match(await page.locator('#sxcj .sxcjp').innerText(), /\$4\.20 a unit, 210 g · 12K in stock, 120 in the EU\s+NL \$3\.95 \(8-12 d\) · DE \$3\.70 \(7-11 d\) · FR \$4\.10 \(8-13 d\) · NL \$4\.90 \(2-4 d\) from DE/);
    await page.click('#sxcj [data-sx=cj-add]');
    await page.waitForFunction(() => document.querySelectorAll('#sxlist .sxs').length === 3);
    await idle();
    assert.deepStrictEqual(await page.locator('#sxlist .sxs .sxp').allInnerTexts(), ['CJ', '1688', 'AliExpress'], 'from EU stock, no import fees: cheapest at the door');
    assert.match(await page.locator('#sxlist .sxs').first().innerText(), /€7\.84\s*at the door[\s\S]*€3\.62 unit \+ €4\.22 shipping \(\$4\.20 \+ \$4\.90\)[\s\S]*EU stock/);
    assert.ok(cj.calls.every((c) => c.host === 'developers.cjdropshipping.com'));
    await page.evaluate(() => document.querySelector('#sxcj').scrollIntoView());
    await shot('5-cj');

    // A reload: suppliers, the choice, the ticks and the words are all still there
    await page.reload();
    await page.waitForSelector('#grid .card');
    await page.click('#lnseg');
    await page.waitForFunction(() => document.querySelector('#sxsum') && SX.data);
    assert.strictEqual(await page.textContent('#sxsum'), 'Chosen: 1688, €8.31 at the door', 'at your rate of ¥8 for €1: €1.56 + €3.75 + €3');
    await page.click('#sxbox > summary');
    assert.deepStrictEqual(await page.locator('#sxlist .sxs .sxp').allInnerTexts(), ['CJ', '1688', 'AliExpress']);
    assert.strictEqual(await page.inputValue('[data-sx-info=zh]'), '姿势矫正器');
    assert.strictEqual(await page.inputValue('[data-sx-info=eur_cny]'), '8');
    await page.click('[data-sx-fold=vet] > summary');
    assert.ok(await page.isChecked('[data-sx-check=vet][value=video]'));
    assert.strictEqual(await page.locator('#sxlist .sxs.on .sxp').innerText(), '1688');
    // Remove takes two taps
    const ali = item('aliexpress');
    await ali.locator('[data-sx=remove]').click();
    assert.strictEqual(await ali.locator('[data-sx=remove]').innerText(), 'Tap again to remove');
    await ali.locator('[data-sx=remove]').click();
    await page.waitForFunction(() => document.querySelectorAll('#sxlist .sxs').length === 2);
    assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM product_suppliers').get().n, 2);
    // The smallest phones, then the desktop: nothing pushes the page sideways
    for (const w of [360, 320]) {
      await page.setViewportSize({ width: w, height: 740 });
      await noSideScroll(`the panel at ${w}px`);
    }
    await item('护腰带').locator('[data-sx=edit]').click();
    await noSideScroll('a supplier’s form at 320px');
    await page.setViewportSize({ width: 1280, height: 900 });
    await noSideScroll('desktop');
    await page.evaluate(() => document.querySelector('#sxpanel').scrollIntoView());
    await shot('6-desktop');
    // Another view: the launch view and its panel step aside
    await page.click('[data-view=all]');
    await page.waitForFunction(() => !document.body.classList.contains('lnv'));
    assert.ok(await page.locator('#sxpanel').isHidden());
    assert.deepStrictEqual(errors, []);
  } finally {
    globalThis.fetch = realFetch;
    await ctx.close();
    await browser.close();
    server.close();
  }
});
