// The TikTok tab: the import's rules, /api/tiktok, and the tab in a real browser at phone and desktop size.
//   SHOTS=/some/dir TIKTOK_ROWS=rows.json node --test test/tiktok.test.mjs    (screenshots, on real rows)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { LIST_SQL } from '../worker/src/tiktok.mjs';
import { COLS, PRUNE_SQL, UPSERT_SQL, validateRows } from '../lib/tiktok.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const ORIGIN = 'https://winner-hunter.example.workers.dev';
const SHOTS = process.env.SHOTS || '';

const row = (i, extra = {}) => ({
  id: String(1700000000000000000n + BigInt(i)), title: `Product ${i}`, shop: `Shop ${i}`, url: `https://www.tiktok.com/shop/pdp/${i}`, image_url: null,
  price_min: 10 + i, price_max: 10 + i, rating: 4.5, reviews: 100, sold_us: 100000 - i, creators: 5, plays: 1000000, category: 'Home', blockers: '',
  meta_status: 'none', meta_url: null, meta_unsure: 0, meta_us: null, meta_au: null, meta_nz: null, updated_at: '2026-11-01T10:00:00Z',
  video_url: null, sold_mixed: 0, price_suspect: 0, ads_mention_n: null, ads_mention_of: null, ads_domain: null, meta_label: null, ...extra,
});
const SAMPLE = [
  row(1, { title: 'Rhino Straps', price_min: 55.77, meta_status: 'matched', meta_url: 'https://www.facebook.com/ads/library/?id=1', meta_us: 225, meta_au: 0, meta_nz: 0 }),
  row(2, { title: 'Cheap Holder', price_min: 11.99 }),
  row(3, { title: 'Hair Brush <img src=x onerror=alert(1)>', price_min: 43.97, blockers: 'electric skin' }),
  row(4, { title: 'Wide Rain Jacket', price_min: 54.98, meta_status: 'matched', meta_url: 'https://www.facebook.com/ads/library/?id=2', meta_us: 199, meta_au: 204, meta_nz: 1, meta_unsure: 1, ads_mention_n: 3, ads_mention_of: 30, ads_domain: 'amazon.com', sold_mixed: 1, category: 'Clothing', video_url: 'https://www.tiktok.com/@a/video/1' }),
  row(5, { title: 'Never Judged Lamp', price_min: 30, blockers: null }),
  row(6, { title: 'Placeholder Serum', price_min: 9878.7, price_suspect: 1 }),
];
const load = (env, rows) => env.DB.prepare(UPSERT_SQL).bind(JSON.stringify(rows)).run();
const cookieOf = async (env) => `__Host-wh=${await tokenFor(env, NOW)}`;
const api = (env, cookie, init = {}) => handle(new Request(ORIGIN + '/api/tiktok', { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } }), env, { html: HTML, now: NOW });
const post = (env, cookie, body, headers = { 'content-type': 'application/json' }) => api(env, cookie, { method: 'POST', headers, body: JSON.stringify(body) });

test('validateRows stops on a row the board cannot show, instead of dropping it', () => {
  assert.strictEqual(validateRows(SAMPLE), SAMPLE);
  assert.throws(() => validateRows([]), /No rows/);
  for (const [extra, why] of [[{ id: 'abc' }, /bad id/], [{ id: 12345 }, /bad id/], [{ title: ' ' }, /no title/], [{ url: 'https://evil.test/' }, /TikTok page/], [{ url: 'javascript:alert(1)' }, /TikTok page/],
    [{ image_url: 'http://x.test/a.jpg' }, /image_url/], [{ meta_url: 'javascript:alert(1)' }, /meta_url/], [{ sold_us: null }, /sold count/], [{ price_min: -1 }, /price_min/], [{ meta_status: 'maybe' }, /meta_status/]]) {
    assert.throws(() => validateRows([row(1, extra)]), why);
  }
  // Ids as numbers in rows.json are rounded before anything can check them: two products would become one row.
  const parsed = JSON.parse(`[${JSON.stringify(row(1)).replace(/"id":"\d+"/, '"id":1729384756102938475')},${JSON.stringify(row(2)).replace(/"id":"\d+"/, '"id":1729384756102938476')}]`);
  assert.strictEqual(String(parsed[0].id), String(parsed[1].id), 'JSON.parse rounds them to the same number');
  assert.throws(() => validateRows(parsed), /Row 0 .*bad id \(must be a string of digits, in quotes\)/);
  assert.throws(() => validateRows([row(1), row(2), row(1, { title: 'Again' })]), /Row 2 .*duplicate id/);
});

test('/api/tiktok: login needed, biggest sellers first, decisions persist and survive a new import', async () => {
  const env = await seededEnv();
  await load(env, SAMPLE);
  assert.strictEqual((await api(env, '')).status, 401);
  const cookie = await cookieOf(env);
  const j = await (await api(env, cookie)).json();
  assert.deepStrictEqual(j.products.map((p) => p.title.slice(0, 5)), ['Rhino', 'Cheap', 'Hair ', 'Wide ', 'Never', 'Place']);
  assert.strictEqual(j.products[0].us, 225);
  const id = j.products[0].id;

  const ok = await post(env, cookie, { id, decision: 'approved' });
  assert.strictEqual(ok.status, 200);
  let p = (await (await api(env, cookie)).json()).products[0];
  assert.strictEqual(p.d, 'approved');

  // A new import updates the sold count and keeps the decision.
  await load(env, [row(1, { title: 'Rhino Straps', sold_us: 200000 })]);
  p = (await (await api(env, cookie)).json()).products[0];
  assert.strictEqual(p.sold, 200000);
  assert.strictEqual(p.d, 'approved');

  assert.strictEqual((await post(env, cookie, { id, decision: '' })).status, 200);
  p = (await (await api(env, cookie)).json()).products[0];
  assert.strictEqual(p.d, null);
});

test('the import removes undecided products that left the file, and keeps your decisions', async () => {
  const env = await seededEnv();
  await load(env, SAMPLE);
  const cookie = await cookieOf(env);
  await post(env, cookie, { id: SAMPLE[1].id, decision: 'approved' });
  await env.DB.prepare(PRUNE_SQL).bind(JSON.stringify([SAMPLE[0].id])).run();
  const left = (await (await api(env, cookie)).json()).products.map((p) => p.id);
  assert.deepStrictEqual(left.sort(), [SAMPLE[0].id, SAMPLE[1].id].sort());
});

test('/api/tiktok refuses bad input and other origins', async () => {
  const env = await seededEnv();
  await load(env, SAMPLE);
  const cookie = await cookieOf(env);
  const id = SAMPLE[0].id;
  assert.strictEqual((await post(env, '', { id, decision: 'approved' })).status, 401);
  assert.strictEqual((await post(env, cookie, { id: "1' OR 1=1", decision: 'approved' })).status, 400);
  assert.strictEqual((await post(env, cookie, { id, decision: 'nonsense' })).status, 400);
  assert.strictEqual((await post(env, cookie, { id: '999', decision: 'approved' })).status, 404);
  assert.strictEqual((await post(env, cookie, { id, decision: 'approved' }, { 'content-type': 'text/plain' })).status, 415);
  assert.strictEqual((await post(env, cookie, { id, decision: 'approved' }, { 'content-type': 'application/json', origin: 'https://evil.test' })).status, 403);
  assert.strictEqual((await api(env, cookie, { method: 'PUT' })).status, 405);
});

test('the import has no column the table lacks, and never writes a decision', () => {
  assert.ok(!COLS.includes('decision') && !COLS.includes('decided_at'));
  assert.ok(!UPSERT_SQL.includes('decision'));
  assert.match(LIST_SQL, /LIMIT 5000/);
});

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch (e) { /* no Playwright: skipped */ }
const launch = () => chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}).catch(() => null);

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

for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 1000 }]]) {
  test(`TikTok tab on a ${name}: opens, filters, decides, comes back, no errors`, { skip: !chromium && 'Playwright not installed' }, async (t) => {
    const browser = await launch();
    if (!browser) return t.skip('no Chromium');
    const env = await seededEnv();
    const real = process.env.TIKTOK_ROWS ? JSON.parse(fs.readFileSync(process.env.TIKTOK_ROWS, 'utf8')) : null;
    if (real) for (let i = 0; i < real.length; i += 200) await load(env, real.slice(i, i + 200));
    else await load(env, SAMPLE);
    const server = await serve(env);
    const base = `http://127.0.0.1:${server.address().port}/`;
    const ctx = await browser.newContext({ viewport, isMobile: name === 'phone', hasTouch: name === 'phone' });
    await ctx.addCookies([{ name: '__Host-wh', value: await tokenFor(env, NOW), url: base }]).catch(() => {});
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
    await page.addInitScript(() => localStorage.setItem('wh-risk', 'all')); // the tab as before: risk.e2e.test.mjs has Block hidden
    try {
      await page.goto(base);
      await page.fill('input[type=password], input[name=pin], input', env.BOARD_PIN);
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-scope="tiktok"]');
      await page.click('[data-scope="tiktok"]');
      await page.waitForSelector('#ttgrid .card');
      assert.strictEqual(await page.isVisible('#grid'), false, 'the hunt cards step aside');
      assert.strictEqual(await page.isVisible('.wrap > .rail'), false, 'the hunt controls step aside');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(overflow <= 0, `no sideways scroll (${overflow}px)`);
      if (SHOTS) {
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.waitForTimeout(2500);
        await page.screenshot({ path: `${SHOTS}/tiktok-${name}.png` });
      }
      if (real) {
        const clean = real.filter((r) => r.blockers === '').length;
        assert.match(await page.textContent('#ttcount'), new RegExp(`^${clean.toLocaleString('en-US')} of ${real.length.toLocaleString('en-US')}`));
        return;
      }
      // Default: Jev read it and flagged no blocker. The XSS title stays hidden until the filter is off, and then stays text.
      assert.match(await page.textContent('#ttcount'), /^4 of 6 · by units sold/);
      assert.strictEqual(await page.locator('#ttgrid .card').first().locator('.t').textContent(), 'Rhino Straps');
      await page.click('[data-tf="clean"]');
      assert.match(await page.textContent('#ttcount'), /^6 of 6/);
      assert.match(await page.locator('#ttgrid .card', { hasText: 'Never Judged' }).locator('.badges').textContent(), /Not checked/);
      assert.strictEqual(await page.locator('#ttgrid img[src="x"]').count(), 0, 'a title never becomes HTML');
      assert.match(await page.locator('#ttgrid .card', { hasText: 'Hair Brush' }).locator('.badges').textContent(), /Battery or electric/);
      await page.click('[data-tf="clean"]');
      await page.click('[data-tf="p25"]');
      assert.match(await page.textContent('#ttcount'), /^2 of 6/, 'the placeholder price stays out of $25+');
      await page.click('[data-tf="gap"]');
      assert.match(await page.textContent('#ttcount'), /^1 of 6/);
      await page.click('[data-tf="gap"]');
      const wide = page.locator('#ttgrid .card', { hasText: 'Wide Rain' });
      assert.match(await wide.locator('.ttads').textContent(), /Shop's Meta ads: US 199 · AU 204 · NZ 1 · 3 of 30 sampled mention this product · ads go to amazon.com · match unsure/);
      assert.match(await wide.locator('.hero').textContent(), /sold, may include non-US/);
      assert.strictEqual(await wide.getByText('Videos').getAttribute('href'), 'https://www.tiktok.com/@a/video/1');
      assert.match(await page.locator('#ttgrid .card', { hasText: 'Rhino' }).getByText('Videos').getAttribute('href'), /tiktok\.com\/search\/video\?q=Rhino%20Straps/);
      await page.selectOption('#ttcat', 'Clothing');
      assert.match(await page.textContent('#ttcount'), /^1 of 6/);
      await page.selectOption('#ttcat', '');
      await page.click('[data-tf="p25"]');
      await page.fill('#ttq', 'cheap');
      await page.waitForFunction(() => /^1 of 6/.test(document.getElementById('ttcount').textContent));
      await page.fill('#ttq', '');
      await page.waitForFunction(() => /^4 of 6/.test(document.getElementById('ttcount').textContent));
      await page.selectOption('#ttsort', 'low');
      assert.strictEqual(await page.locator('#ttgrid .card').first().locator('.t').textContent(), 'Cheap Holder');
      await page.selectOption('#ttsort', 'sold');
      // Approve: leaves the list, stays approved after a reload, on the tab you left.
      await page.locator('#ttgrid .card', { hasText: 'Rhino Straps' }).locator('[data-td="approved"]').click();
      await page.waitForFunction(() => /^3 of 6/.test(document.getElementById('ttcount').textContent));
      await page.waitForTimeout(200);
      await page.reload();
      await page.waitForSelector('#ttgrid .card');
      assert.match(await page.textContent('#ttcount'), /^3 of 6/);
      await page.click('[data-tf="done"]');
      assert.match(await page.locator('#ttgrid .card').first().textContent(), /Rhino Straps/);
      assert.match(await page.locator('#ttgrid .card').first().textContent(), /✓ Approved/);
      // Back to the hunt: its cards return.
      await page.click('[data-scope="world"]');
      await page.waitForFunction(() => !document.body.classList.contains('tt'));
      assert.strictEqual(await page.isVisible('#ttbox'), false);
      assert.notStrictEqual(await page.evaluate(() => getComputedStyle(document.getElementById('grid')).display), 'none', 'the hunt cards are back');
      await page.click('[data-scope="eu"]');
      await page.waitForFunction(() => document.body.classList.contains('inbox'));
      assert.deepStrictEqual(errors, []);
    } finally {
      await ctx.close();
      await browser.close();
      server.close();
    }
  });
}
