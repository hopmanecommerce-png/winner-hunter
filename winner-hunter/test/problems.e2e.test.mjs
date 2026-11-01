// The board's Problems tab in a real browser (Chromium via Playwright), at phone and desktop size, against the Worker
// served locally on an in-memory D1 holding the sample problems (test/fixtures/problems: made up, marked sample).
// Skipped when Playwright or Chromium is not available (CI installs both: a skipped test fails the gate there).
//   SHOTS=/some/dir node --test test/problems.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { problemEnv } from './helpers/problems.mjs';

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (e) {
  // no Playwright: skipped
}
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const SHOTS = process.env.SHOTS || '';

function serve(env, now) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const out = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env, { html: HTML, now });
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

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 1000 }]]) {
  test(`Problems tab on a ${name}: filters, search, sort, quotes with their links, Save / ★ / Ignore kept after a reload, exports, no errors`, { skip: !chromium && 'Playwright not installed', timeout: 120000 }, async (t) => {
    const browser = await launch();
    if (!browser) return t.skip('Chromium not available');
    const { env, now } = await problemEnv();
    const server = await serve(env, now);
    const base = `http://127.0.0.1:${server.address().port}`;
    const phone = name === 'phone';
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
    page.on('dialog', (d) => (errors.push('dialog: ' + d.message()), d.dismiss()));
    await page.clock.setFixedTime(new Date(now));
    await page.setExtraHTTPHeaders({ cookie: `__Host-wh=${await tokenFor(env, now)}` });
    await page.route(/^https:\/\//, (r) => r.fulfill({ status: 204, body: '' }));
    const shot = async (n) => SHOTS && page.screenshot({ path: `${SHOTS}/problems-${name}-${n}.png` });
    const cards = page.locator('#pblist .pbcard');
    const count = () => page.textContent('#pbcount');
    const noSideScroll = async (where) => {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(over <= 0, `${where}: ${over}px sideways`);
    };
    try {
      if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
      await page.goto(base + '/');
      await page.waitForSelector('[data-scope="problems"]');
      await page.click('[data-scope="problems"]');
      await page.waitForSelector('#pblist .pbcard');
      assert.ok(await page.evaluate(() => document.body.classList.contains('pb')));
      assert.strictEqual(await page.isVisible('#grid'), false, 'the hunt cards step aside');
      assert.strictEqual(await page.isVisible('.wrap > .rail'), false, 'the hunt controls step aside');
      assert.strictEqual(await page.isVisible('#pbsample'), true, 'sample data says so');
      assert.match(await count(), /^8 problems · by intensity$/);
      assert.strictEqual(await page.textContent('#npb'), '8');
      assert.match(await page.textContent('#pbnote'), /grouped just now: 8 problems from 44 posts and comments/);
      await noSideScroll('the list');
      await shot('1-list');

      // Filters: a category, a language, a country, a platform, at least 5 mentions, a trend, "would pay", the search.
      await page.selectOption('#pbarea', 'pets');
      await page.waitForFunction(() => /^2 problems/.test(document.getElementById('pbcount').textContent));
      assert.deepStrictEqual(await cards.locator('h2').allInnerTexts(), ['Dog hair · Couch · Vacuum', 'Kattenbak · Stinkt · Stank']);
      assert.match(await page.getAttribute('#pbcsv', 'href'), /^\/problems\.csv\?area=pets$/, 'the export follows the filters');
      assert.match(await page.getAttribute('#pbjson', 'href'), /^\/problems\.json\?area=pets$/);
      await page.selectOption('#pbarea', '');
      await page.selectOption('#pblang', 'de');
      await page.waitForFunction(() => /^2 problems/.test(document.getElementById('pbcount').textContent));
      assert.match(await page.locator('#pblang option[value="de"]').textContent(), /German \(2\)/);
      await page.selectOption('#pblang', '');
      await page.selectOption('#pbcountry', 'NL');
      await page.waitForFunction(() => /^2 problems/.test(document.getElementById('pbcount').textContent));
      await page.selectOption('#pbcountry', '');
      await page.selectOption('#pbplatform', 'tiktok');
      await page.waitForFunction(() => /^6 problems/.test(document.getElementById('pbcount').textContent), null, { timeout: 5000 });
      await page.selectOption('#pbplatform', '');
      await page.selectOption('#pbmin', '5');
      await page.waitForFunction(() => /^5 problems/.test(document.getElementById('pbcount').textContent));
      await page.selectOption('#pbmin', '1');
      await page.selectOption('#pbtrend', 'rising');
      await page.waitForFunction(() => /problems? · by intensity$/.test(document.getElementById('pbcount').textContent) && document.querySelectorAll('#pblist .pbcard').length > 0);
      assert.ok((await cards.locator('.tag.rising').count()) === (await cards.count()), 'only rising problems');
      await page.selectOption('#pbtrend', '');
      await page.click('#pbpay');
      await page.waitForFunction(() => /^2 problems/.test(document.getElementById('pbcount').textContent));
      assert.strictEqual(await page.getAttribute('#pbpay', 'aria-pressed'), 'true');
      await page.click('#pbpay');
      await page.fill('#pbq', 'kondenswasser');
      await page.waitForFunction(() => /^1 problem ·/.test(document.getElementById('pbcount').textContent));
      await page.fill('#pbq', '');
      await page.waitForFunction(() => /^8 problems/.test(document.getElementById('pbcount').textContent));
      await page.selectOption('#pbsort', 'volume');
      await page.waitForFunction(() => /by most mentions$/.test(document.getElementById('pbcount').textContent));
      assert.strictEqual(await cards.first().locator('h2').innerText(), 'Dog hair · Couch · Vacuum');
      assert.match(await cards.first().locator('.pbnums').innerText(), /10\s+mentions/);
      await noSideScroll('filters');

      // Quotes: each with its link (https, a new tab, no referrer); a quote's HTML stays text.
      const dog = cards.first();
      await dog.locator('[data-px]').click();
      await page.waitForSelector('#pblist .pbcard.open .pbquotes');
      const open = page.locator('#pblist .pbcard.open');
      const links = open.locator('.pbq a');
      assert.strictEqual(await links.count(), 8);
      for (const a of await links.all()) {
        assert.match(await a.getAttribute('href'), /^https:\/\/(www\.)?(reddit|youtube|tiktok)\.com\//);
        assert.strictEqual(await a.getAttribute('target'), '_blank');
        assert.strictEqual(await a.getAttribute('rel'), 'noopener noreferrer');
      }
      assert.match(await open.locator('.pbmp').innerText(), /Products: none matched yet/);
      await open.locator('[data-pm]').click();
      await page.waitForFunction(() => document.querySelectorAll('#pblist .pbcard.open .pbq li').length === 10);
      assert.ok(await open.locator('.pbq').innerText().then((s) => s.includes('<img src=x onerror=alert(1)>')), 'the quote shows its HTML as text');
      assert.strictEqual(await page.locator('#pblist img').count(), 0, 'and never becomes an image');
      await noSideScroll('quotes');
      await shot('2-quotes');

      // Decide: star the dog hair problem, save the second, ignore the third. Each leaves Open.
      const titles = (await cards.locator('h2').allInnerTexts()).slice(0, 3);
      await page.locator('#pblist .pbcard', { hasText: titles[0] }).locator('[data-pd="starred"]').click();
      await page.waitForFunction(() => /^7 problems/.test(document.getElementById('pbcount').textContent));
      await page.locator('#pblist .pbcard', { hasText: titles[1] }).locator('[data-pd="saved"]').click();
      await page.waitForFunction(() => /^6 problems/.test(document.getElementById('pbcount').textContent));
      await page.locator('#pblist .pbcard', { hasText: titles[2] }).locator('[data-pd="ignored"]').click();
      await page.waitForFunction(() => /^5 problems/.test(document.getElementById('pbcount').textContent));
      await page.waitForFunction(() => document.getElementById('toastMsg').textContent === 'Ignored');
      await page.waitForTimeout(250);
      assert.deepStrictEqual(env.db.prepare('SELECT decision FROM problem_decisions ORDER BY decision').all().map((r) => r.decision), ['ignored', 'saved', 'starred']);
      // After a reload: on the Problems tab again, the decisions kept.
      await page.reload();
      await page.waitForSelector('#pblist .pbcard');
      assert.match(await count(), /^5 problems/);
      assert.strictEqual(await page.textContent('#pbn-starred'), '1');
      await page.click('[data-pv="starred"]');
      await page.waitForFunction(() => /^1 problem ·/.test(document.getElementById('pbcount').textContent));
      const star = cards.first();
      assert.strictEqual(await star.locator('h2').innerText(), titles[0]);
      assert.strictEqual(await star.locator('[data-pd="starred"]').getAttribute('aria-pressed'), 'true');
      assert.match(await page.getAttribute('#pbcsv', 'href'), /view=starred/);
      // A second tap takes it back: it leaves Starred, and is open again.
      await star.locator('[data-pd="starred"]').click();
      await page.waitForFunction(() => /^0 problems/.test(document.getElementById('pbcount').textContent));
      assert.strictEqual(await page.isVisible('#pbempty'), true);
      await page.click('[data-pv="open"]');
      await page.waitForFunction(() => /^6 problems/.test(document.getElementById('pbcount').textContent));
      await shot('3-decided');

      // Back to the other tabs: their cards return.
      await page.click('[data-scope="world"]');
      await page.waitForFunction(() => !document.body.classList.contains('pb'));
      assert.strictEqual(await page.isVisible('#pbbox'), false);
      await page.click('[data-scope="eu"]');
      await page.waitForFunction(() => document.body.classList.contains('inbox'));
      await page.click('[data-scope="tiktok"]');
      await page.waitForFunction(() => document.body.classList.contains('tt') && !document.body.classList.contains('pb'));
      assert.strictEqual(await page.isVisible('#pbbox'), false);
      await page.click('[data-scope="problems"]');
      await page.waitForSelector('#pblist .pbcard');
      assert.deepStrictEqual(errors, []);
    } finally {
      await ctx.close();
      await browser.close();
      server.close();
    }
  });
}
