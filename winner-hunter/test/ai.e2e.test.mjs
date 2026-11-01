// The AI read in a real browser (Chromium via Playwright) at iPhone size, against the Worker served locally on an in-memory
// D1 with AI reads: closed on the card until you open it (hidden first), opening it is saved once, the read's text is
// shown as text (never as HTML), a flagged read warns, a tap inside it never opens the ad, and the board works around it.
// Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/ai.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, makeToken } from '../worker/src/app.mjs';
import { READ, readEnv, addRead } from './helpers/ai-reads.mjs';
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

async function launch() {
  try {
    return await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  } catch (e) {
    return chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => null);
  }
}

test('AI read on an iPhone: closed until you open it, saved once when opened, text never HTML, a flagged read warns, a tap inside never opens the ad; no sideways scroll, no errors', { skip: !chromium && 'Playwright not installed', timeout: 120000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await readEnv();
  // The Inbox's first product (the most reach a day): a read whose text tries HTML, from data that tried to instruct the AI.
  addRead(env.db, 'eu|703|stale old winner', 'ok', { ...READ, product: '<img src=x onerror="window.__xss=1">Neck brace', fit: 81, pros: ['Solves a felt problem', 'Light to ship'], cons: ['<b>bold</b> claims'] }, '["injection"]');
  const cookie = `__Host-wh=${await makeToken(env.BOARD_PIN, NOW)}`;
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
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/ai-${name}.png`, fullPage: false });
  const noSideScroll = async (where) => {
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
  };
  const opened = (key) => env.db.prepare('SELECT opened_at FROM ai_checks WHERE product_key = ?').get(key).opened_at;
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(base + '/');
    await page.waitForSelector('#grid .card .airead');
    // Inbox: the read is there, closed: no fit, no verdict until you open it.
    const read = page.locator('#grid .card .airead');
    assert.strictEqual(await read.count(), 1);
    assert.strictEqual(await read.evaluate((d) => d.open), false, 'closed: you decide on your own first');
    assert.match((await read.locator('summary').innerText()).trim(), /^AI read\s+experimental$/i, 'labelled experimental');
    assert.strictEqual(await read.locator('.aifit').isVisible(), false);
    assert.strictEqual(opened('eu|703|stale old winner'), null);
    await noSideScroll('the Inbox with a closed AI read');
    await shot('1-inbox-closed');

    await read.locator('summary').click();
    assert.strictEqual(await read.evaluate((d) => d.open), true);
    assert.strictEqual(await read.locator('.aifit').innerText(), '81');
    assert.match(await read.locator('.aitop').innerText(), /81\s*fit of 100\s*· low confidence/, 'a flagged read shows low confidence');
    assert.strictEqual(await read.locator('.aiwhat b').innerText(), '<img src=x onerror="window.__xss=1">Neck brace', 'the text as text');
    assert.strictEqual(await read.locator('img, b:not(.aifit):not(.aiwhat b)').count(), 0, 'no HTML from the read');
    assert.strictEqual(await page.evaluate(() => window.__xss), undefined);
    assert.match(await read.locator('.aiwarn').innerText(), /tried to give the AI instructions/);
    assert.deepStrictEqual(await read.locator('li.pro').allInnerTexts(), ['Solves a felt problem', 'Light to ship']);
    assert.deepStrictEqual(await read.locator('li.con').allInnerTexts(), ['<b>bold</b> claims']);
    assert.match(await read.locator('dl').innerText(), /Hook\s+Stand straight again in two weeks/);
    assert.match(await read.locator('dl').innerText(), /Claims risk\s+medium: “relieves back pain”/);
    assert.match(await read.locator('.ainote').innerText(), /^Claude Haiku 5\.5 · \d+ Oct · Not measured against your decisions yet\. Experimental: it can be wrong, and nothing is sorted or hidden by it\.$/);
    await page.waitForFunction(() => window.AI_READ && window.AI_READ.sent.size === 1);
    for (let i = 0; i < 200 && !opened('eu|703|stale old winner'); i++) await new Promise((r) => setTimeout(r, 25)); // the POST on its way
    assert.strictEqual(opened('eu|703|stale old winner'), new Date(NOW).toISOString(), 'opening it is saved, for the blind eval');
    await noSideScroll('the Inbox with the AI read open');
    await shot('2-inbox-open');
    // Closing and opening again sends nothing new.
    await read.locator('summary').click();
    await read.locator('summary').click();
    assert.strictEqual(await page.evaluate(() => window.AI_READ.sent.size), 1);

    // Decide: the next Inbox product comes with its own read, closed again.
    await page.keyboard.press('d');
    await page.waitForFunction(() => document.querySelector('#grid .card') && document.querySelector('#grid .card').dataset.id !== '9500');
    const next = await page.locator('#grid .card').getAttribute('data-id');
    const reads = await page.evaluate(() => [...window.AI_READ.reads.entries()].filter(([, r]) => r).map(([id]) => id));
    if (reads.includes(next)) assert.strictEqual(await page.locator('#grid .card .airead').evaluate((d) => d.open), false, 'another product: closed');

    // Browse: every card with a read has it, closed; a tap inside it never opens the ad, a tap on the card still does.
    await page.click('[data-view=all]');
    await page.waitForSelector('#grid .card .airead');
    const shown = await page.locator('#grid .card').evaluateAll((cs) => cs.map((c) => [c.dataset.id, !!c.querySelector('.airead')]));
    const withRead = shown.filter(([, has]) => has).map(([id]) => id).sort();
    assert.deepStrictEqual(withRead, ['9000', '9001', '9002'].sort(), 'only the products with a valid read (the tampered one is not shown)');
    await page.evaluate(() => { window.__opens = []; window.open = (u) => { window.__opens.push(String(u)); return null; }; });
    const card = page.locator('#grid .card[data-id="9001"]');
    await card.locator('.airead summary').click();
    assert.strictEqual(await card.locator('.airead').evaluate((d) => d.open), true);
    assert.deepStrictEqual(await page.evaluate(() => window.__opens), [], 'the tap opened the read, not the ad');
    await card.locator('.aiwhat').click();
    assert.deepStrictEqual(await page.evaluate(() => window.__opens), [], 'not inside the read either');
    await card.locator('h2.t').click();
    assert.deepStrictEqual(await page.evaluate(() => window.__opens), ['https://www.facebook.com/ads/library/?id=9001'], 'the card\'s own tap still opens the ad');
    assert.match(await page.locator('#grid .card[data-id="9002"] .aitop').evaluate((x) => x.textContent), /updating/, 'a read being asked again says so');
    await noSideScroll('Browse with AI reads');
    await shot('3-browse');
    // The cards are drawn again (another sort): the open read stays open.
    await page.selectOption('#sort', 'new');
    await page.waitForFunction(() => document.querySelector('#grid .card[data-id="9001"] .airead'));
    assert.strictEqual(await page.locator('#grid .card[data-id="9001"] .airead').evaluate((d) => d.open), true);
    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
