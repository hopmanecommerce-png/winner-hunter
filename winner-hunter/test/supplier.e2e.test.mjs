// 🏭 Suppliers in a real browser (Chromium via Playwright) at iPhone size, against the Worker served locally on an
// in-memory D1 with every migration applied (the showerhead's scorecard is seeded): three suppliers side by side, the
// delivery gate and the weights changed as you type, the first message in English and Chinese, a decision with a backup
// and a re-check, all back after a reload; a scorecard started from a launch card. Skipped when Playwright or Chromium
// is not available.   SHOTS=/some/dir node --test test/supplier.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, tokenFor } from '../worker/src/app.mjs';
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
const SEED = 'own|muravai-filtered-showerhead';
const LAUNCH = 'eu|shop1.test/products/item-1'; // Posture Corrector Pro: its launch card's key

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

test('🏭 Suppliers on an iPhone: the seeded showerhead, 3 suppliers side by side, the gate and the weights as you type, the message in English and Chinese, a decision and a re-check, back after a reload; from a launch card; no sideways scroll, no errors', { skip: !chromium && 'Playwright not installed', timeout: 180000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await seededEnv();
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const api = (path, body) => handle(new Request('https://board.test' + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, { now: NOW });
  // An approved product with a launch card: its Sourcing step opens a scorecard of its own.
  assert.strictEqual((await api('/api/hide', { ad_id: '9001', status: 'seen' })).status, 200);
  assert.strictEqual((await api('/api/launch', { start: LAUNCH })).status, 200);
  // A supplier already in its 🔎 Sourcing panel, priced in yuan
  const sxRes = await api('/api/sourcing', { key: LAUNCH, add: { url: 'https://detail.1688.com/offer/42424242.html', title: 'Factory P', unit_price: 3.4, currency: 'CNY', moq: 100, lead_days: 8 } });
  assert.strictEqual(sxRes.status, 200);
  const sxId = (await sxRes.json()).added;
  const tests = JSON.parse(env.db.prepare('SELECT setup FROM sourcing WHERE product_key = ?').get(SEED).setup).tests;
  const testKey = (re) => tests.find((x) => re.test(x.label)).k;
  const row = (k = SEED) => {
    const r = env.db.prepare('SELECT suppliers, setup, checks, choice FROM sourcing WHERE product_key = ?').get(k);
    return r && { suppliers: JSON.parse(r.suppliers), setup: JSON.parse(r.setup), checks: JSON.parse(r.checks), choice: JSON.parse(r.choice) };
  };
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
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/supplier-${name}.png`, fullPage: false });
  const noSideScroll = async (where) => {
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
  };
  const saved = () => page.waitForFunction(() => SP.timers.size === 0 && SP.saving === 0 && document.querySelector('#spsaved').textContent === 'Saved ✓');
  const verdict = () => page.locator('#spbox .spvt').innerText();
  const ranking = async () => (await page.locator('#spbox .sprank li b').allInnerTexts());
  const sup = (n) => page.locator(`#spbox [data-sps=s${n}]`);
  async function addSupplier(n, o) {
    await page.click('#spbox [data-sp=addsup]');
    await page.waitForSelector(`#spbox [data-sps=s${n}] [data-sk=name]`);
    const s = sup(n);
    for (const [k, v] of Object.entries(o.fields || {})) await s.locator(`[data-sk=${k}]`).fill(v);
    for (const [k, v] of Object.entries(o.choices || {})) await s.locator(`[data-sk=${k}]`).selectOption(v);
    for (const [k, v] of Object.entries(o.gates || {})) await s.locator(`[data-sg=${k}]`).selectOption(v);
    for (const [k, v] of Object.entries(o.tests || {})) await s.locator(`[data-st="${k}"]`).selectOption(v);
    for (const [k, v] of Object.entries(o.scores || {})) await s.locator(`[data-sc=${k}]`).selectOption(String(v));
  }
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(base + '/');
    await page.waitForSelector('#grid .card');
    await page.waitForFunction(() => window.SUPPLIER && window.LAUNCH && LN.list);
    // 🚀, then the Suppliers tab: the seeded showerhead, and the launch card's product to start one
    await page.click('#lnseg');
    await page.waitForSelector('#lnbox .lncard');
    await page.waitForFunction(() => document.querySelector('#lnbox [data-nsup]').textContent === '1');
    await page.click('#lnbox [data-tab=supplier]');
    await page.waitForSelector('#spbox [data-spfocus]');
    assert.strictEqual(await page.locator('#lnbox').innerHTML(), '', 'one tab at a time: the launch cards step aside');
    assert.deepStrictEqual(await page.locator('#spbox .lnother .lnrt b').allInnerTexts(), ['Filtered showerhead (Muravai style)']);
    assert.match(await page.locator('#spbox .lnother .lnrt small').innerText(), /No suppliers yet · checklist 0\/7/);
    assert.deepStrictEqual(await page.locator('#spbox .lnpick .lnrt b').allInnerTexts(), ['Posture Corrector Pro'], 'a launch card without a scorecard can start one');
    await noSideScroll('the list');
    await shot('1-list');

    // The showerhead: nothing to choose yet; its questions and tests are seeded
    await page.click('#spbox [data-spfocus]');
    await page.waitForSelector('#spbox #spverdict');
    assert.strictEqual(await verdict(), 'No suppliers yet');
    assert.deepStrictEqual(await page.locator('#spverdict .lnflags li').allInnerTexts(), ['Add the suppliers you compare: up to 5']);
    assert.ok(await page.locator('#spbox [data-spf=questions]').evaluate((d) => d.open), 'a scorecard without suppliers opens on its questions');
    const en = await page.inputValue('#spmsg-en');
    const zh = await page.inputValue('#spmsg-zh');
    assert.match(en, /^Hello,\n/);
    assert.match(en, /KDF-55/);
    assert.match(zh, /^您好！\n/);
    assert.match(zh, /亚硫酸钙/);
    assert.strictEqual(en.split('\n').filter((l) => /^\d+\. /.test(l)).length, zh.split('\n').filter((l) => /^\d+\. /.test(l)).length, 'the same questions in both');
    await page.click('#spbox [data-spf=questions] summary');
    await noSideScroll('an empty scorecard');
    await shot('2-empty');

    // Three suppliers: a 1688 factory (its leak test passed, the teardown not done yet), one too slow for the gate, one with EU stock
    await addSupplier(1, { fields: { name: 'Yuyao Factory A', unit: '2,10', ship_eu: '6.50', days_eu: '9' }, choices: { route: '1688', from: 'cn' },
      gates: { samples: 'yes', certs: 'yes', identity: 'yes', defects: 'yes' }, tests: { [testKey(/^Leak/)]: 'pass' }, scores: { reliability: 4, compliance: 3, returns: 3, scale: 4 } });
    assert.strictEqual(await page.inputValue('#spbox [data-sps=s1] [data-sk=unit]'), '2,10');
    await addSupplier(2, { fields: { name: 'Slow seller B', unit: '1.2', ship_eu: '4', days_eu: '21' }, gates: { samples: 'yes', identity: 'yes' } });
    await addSupplier(3, { fields: { name: 'EU stock C', unit: '6', ship_eu: '4.5', days_eu: '3' }, choices: { from: 'eu', route: 'local' }, gates: { samples: 'yes', identity: 'yes' } });
    await saved();
    assert.deepStrictEqual(await ranking(), ['Yuyao Factory A', 'EU stock C', 'Slow seller B'], 'the best first, the one that is out last');
    assert.strictEqual(await verdict(), 'Best now: Yuyao Factory A');
    assert.match(await page.locator('#spbox .sprank li').nth(2).innerText(), /✗ out: Delivery days · 21 days/);
    assert.strictEqual(await page.locator('#spbox .sprank li').nth(2).locator('[data-spchoose]').count(), 0, 'no Choose for a supplier that fails a gate');
    assert.deepStrictEqual(await page.locator('#spbox .spt thead th').allInnerTexts(), ['Supplier', '1. Yuyao Factory A', '2. EU stock C', '3. Slow seller B'], 'side by side, best first');
    assert.match(await sup(1).locator('[data-autogate=delivery]').innerText(), /9 days to NL\/DE: within your 12/);
    const s1 = row().suppliers.s1;
    assert.deepStrictEqual([s1.name, s1.unit, s1.ship_eu, s1.days_eu, s1.route, s1.from, s1.gates, s1.scores.reliability], ['Yuyao Factory A', 2.1, 6.5, 9, '1688', 'cn', { samples: 'yes', certs: 'yes', identity: 'yes', defects: 'yes' }, 4]);
    assert.strictEqual(s1.tests[testKey(/^Leak/)], 'pass');
    await noSideScroll('three suppliers');
    await page.evaluate(() => scrollTo(0, 0));
    await shot('3-three');

    // The gate is yours: 25 days lets the slow one in, back to 12 puts it out again
    await page.click('#spbox [data-spf=setup] summary');
    await page.fill('#spbox [data-sf=max_days]', '25');
    await page.waitForFunction(() => !document.querySelector('#spbox .sprank li.fail'));
    assert.match(await sup(2).locator('[data-autogate=delivery]').innerText(), /21 days to NL\/DE: within your 25/);
    await page.fill('#spbox [data-sf=max_days]', '12');
    await page.waitForFunction(() => document.querySelectorAll('#spbox .sprank li.fail').length === 1);
    // The weights: delivery counts double, the total says so, the scores follow
    const before = await page.locator('#spbox .spt .sptot td').allInnerTexts();
    await page.fill('#spbox [data-sw=delivery]', '50');
    await page.waitForFunction(() => document.querySelector('#spbox [data-spw]').textContent === 'Total 125');
    assert.notDeepStrictEqual(await page.locator('#spbox .spt .sptot td').allInnerTexts(), before);
    await page.fill('#spbox [data-sw=delivery]', '');
    await page.waitForFunction(() => document.querySelector('#spbox [data-spw]').textContent === 'Total 100');
    await saved();
    assert.deepStrictEqual([row().setup.max_days, row().setup.weights], [12, undefined], 'saved as typed: back to the defaults');
    assert.ok(row().setup.tests.length === tests.length && row().setup.questions.length >= 8, 'the seeded tests and questions stay');
    await page.click('#spbox [data-spf=setup] summary');
    // The checklist
    await page.click('#spbox [data-spf=checks] summary');
    for (const k of ['shortlist', 'message']) await page.check(`#spbox [data-sck=${k}]`);
    await saved();
    assert.deepStrictEqual(row().checks, { shortlist: true, message: true });
    assert.strictEqual(await page.locator('#spbox [data-spfs=checks]').innerText(), '2/7');

    // The decision: why, the backup (the next best), kept as a record with the next re-check in 90 days
    await page.locator('#spbox [data-spchoose="1"]').click();
    await page.waitForSelector('#spwhy');
    assert.match(await page.locator('#spchoose').innerText(), /Still to confirm before you pay for stock: Sample tests/);
    assert.deepStrictEqual(await page.locator('#spbackup option').allInnerTexts(), [`EU stock C (${(await page.locator('#spbox .sprank li').nth(1).locator('.sps').innerText())}/100)`, 'No backup']);
    await page.fill('#spwhy', 'Best answers and test results; 9 days to NL');
    await page.click('#spbox [data-sp=decide]');
    await page.waitForFunction(() => document.querySelector('#spbox .spvt').textContent === 'Your choice: Yuyao Factory A');
    const c = row().choice.current;
    assert.deepStrictEqual([c.name, c.unit, c.days_eu, c.note, c.backup.name, c.at, c.next, c.open], ['Yuyao Factory A', 2.1, 9, 'Best answers and test results; 9 days to NL', 'EU stock C', new Date(NOW).toISOString(), new Date(NOW + 90 * 864e5).toISOString(), ['Sample tests']]);
    assert.match(await page.locator('#spbox .spvs').first().innerText(), /Chosen 17 Oct 2026 · .* · re-check by 15 Jan 2027: every 90 days and before every reorder/);
    assert.strictEqual(await page.locator('#spbox .sprank li').first().locator('.spchosen').innerText(), '✓ Chosen');
    // A re-check
    assert.ok(await page.locator('#spbox [data-spf=decision]').evaluate((d) => d.open), 'the decision record opens');
    await page.fill('#sprecheck', 'Same price, no new complaints');
    await page.click('#spbox [data-sp=recheck]');
    await page.waitForFunction(() => SP.prod.choice.current.rechecks.length === 1);
    assert.strictEqual(row().choice.current.rechecks[0].note, 'Same price, no new complaints');
    assert.match(await page.locator('#spbox [data-spf=decision] .sphist').innerText(), /Same price, no new complaints/);
    await noSideScroll('the decision');
    await page.evaluate(() => scrollTo(0, 0));
    await shot('4-chosen');

    // A reload: all of it is still there
    await page.reload();
    await page.waitForSelector('#grid .card');
    await page.click('#lnseg');
    await page.waitForSelector('#lnbox .lntabs');
    await page.click('#lnbox [data-tab=supplier]');
    await page.waitForSelector('#spbox [data-spfocus]');
    assert.match(await page.locator('#spbox .lnother .lnrt small').innerText(), /3 suppliers · chosen: Yuyao Factory A · checklist 2\/7/);
    await page.click('#spbox [data-spfocus]');
    await page.waitForSelector('#spbox #spverdict');
    assert.strictEqual(await verdict(), 'Your choice: Yuyao Factory A');
    await page.click('#spbox [data-sps=s1] summary');
    assert.strictEqual(await page.inputValue('#spbox [data-sps=s1] [data-sk=unit]'), '2.1');
    assert.strictEqual(await page.inputValue(`#spbox [data-sps=s1] [data-st="${testKey(/^Leak/)}"]`), 'pass');
    // The chosen one cannot be removed; another one can (two taps)
    await page.click('#spbox [data-sps=s2] summary');
    await page.click('#spbox [data-sps=s2] [data-sp=drop]');
    assert.strictEqual(await page.locator('#spbox [data-sps=s2] [data-sp=drop]').innerText(), 'Tap again to remove');
    await page.click('#spbox [data-sps=s2] [data-sp=drop]');
    await page.waitForFunction(() => !document.querySelector('#spbox [data-sps=s2]'));
    assert.deepStrictEqual(Object.keys(row().suppliers).sort(), ['s1', 's3']);
    for (const w of [360, 320]) {
      await page.setViewportSize({ width: w, height: 740 });
      await noSideScroll(`the scorecard at ${w}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });

    // From a launch card's 🔎 Sourcing panel: its own scorecard, under its key, with its facts and 🔎's candidates
    await page.click('#spbox [data-tab=launch]');
    await page.waitForSelector('#lnbox .lncard');
    assert.strictEqual(await page.locator('#spbox').innerHTML(), '');
    await page.click('#sxbox > summary');
    await page.waitForSelector('#sxpanel [data-sx=score]');
    await page.click('#sxpanel [data-sx=score]');
    await page.waitForFunction(() => document.querySelector('#spbox .lncard h3') && document.querySelector('#spbox .lncard h3').textContent === 'Posture Corrector Pro');
    assert.deepStrictEqual([row(LAUNCH).suppliers, JSON.parse(env.db.prepare('SELECT facts FROM sourcing WHERE product_key = ?').get(LAUNCH).facts).launch], [{}, LAUNCH]);
    assert.strictEqual(await page.getAttribute('#spbox [data-tab=supplier]', 'aria-pressed'), 'true');
    await page.waitForFunction(() => document.querySelector('#spbox [data-nsup]').textContent === '2');
    assert.deepStrictEqual(await page.locator('#spbox .spfromrow b').allInnerTexts(), ['Factory P'], 'the candidate already in 🔎 Sourcing, one tap away');
    assert.match(await page.locator('#spbox .spfromrow small').innerText(), /^€0\.41 a unit · 8 days/, '¥3.40 at 8.3 to the euro');
    await noSideScroll('from a launch card');
    await shot('5-from-launch');
    // Added with one tap, then chosen: 🔎 Sourcing chooses it too, so its shared numbers and the launch card follow
    await page.click('#spbox [data-spfrom]');
    await page.waitForSelector('#spbox [data-sps=s1] [data-sk=name]');
    assert.strictEqual(await page.inputValue('#spbox [data-sps=s1] [data-sk=name]'), 'Factory P');
    assert.strictEqual(await page.locator('#spbox .spfromrow').count(), 0, 'in the scorecard now: no longer offered');
    await page.locator('#spbox [data-sps=s1] [data-sg=samples]').selectOption('yes');
    await page.locator('#spbox [data-sps=s1] [data-sk=lead]').fill('12');
    await saved();
    assert.strictEqual(row(LAUNCH).suppliers.s1.src, sxId, 'an edit keeps where it came from');
    await page.locator('#spbox [data-spchoose="1"]').click();
    await page.waitForSelector('#spwhy');
    assert.deepStrictEqual(await page.locator('#spbackup option').allInnerTexts(), ['No backup'], 'nobody else to fall back on');
    await page.click('#spbox [data-sp=decide]');
    await page.waitForFunction(() => document.querySelector('#spbox .spvt').textContent === 'Your choice: Factory P');
    assert.match(await page.textContent('#toastMsg'), /^Chosen: Factory P, in 🔎 Sourcing too\./);
    assert.match(await page.locator('#spbox [data-spf=decision] .lnout').innerText(), /🔎 Sourcing\s+Chosen there too: the € view and the launch card count it/);
    assert.deepStrictEqual({ ...env.db.prepare('SELECT supplier_id, supplier_cost, supplier_url, lead_days FROM product_sourcing WHERE product_key = ?').get(LAUNCH) },
      { supplier_id: sxId, supplier_cost: 0.41, supplier_url: 'https://detail.1688.com/offer/42424242.html', lead_days: 8 });
    const steps = JSON.parse(env.db.prepare('SELECT steps FROM launches WHERE product_key = ?').get(LAUNCH).steps);
    assert.deepStrictEqual([steps.sourcing.v.supplier, steps.sourcing.v.unit, steps.sourcing.v.moq], ['https://detail.1688.com/offer/42424242.html', 0.41, 100]);
    // Another view: the Suppliers tab steps aside with the launch view
    await page.click('[data-view=all]');
    await page.waitForFunction(() => !document.body.classList.contains('lnv') && document.querySelectorAll('#grid .card').length > 0);
    assert.ok(await page.locator('#spbox').isHidden());
    // Desktop
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.click('#lnseg');
    await page.waitForSelector('#spbox .lncard');
    await noSideScroll('desktop');
    await shot('6-desktop');
    assert.deepStrictEqual(errors, []);
  } finally {
    await ctx.close();
    await browser.close();
    server.close();
  }
});
