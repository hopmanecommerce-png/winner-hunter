// Today's winners in a real browser (Chromium via Playwright) at iPhone size, against the Worker handler served locally on
// an in-memory D1: the first screen, the cards, Keep / Reject / Launch test and Undo mirrored to the board's own endpoints
// (checked in D1), #today/<id>, a failed run's banner, the other tabs. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/today.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { UPSERT_SQL } from '../lib/tiktok.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

let chromium = null;
// The repository's own Playwright (the tests workflow installs it), else the one kept on the VPS for proof-shot.
for (const from of [import.meta.url, process.env.HOME ? `${process.env.HOME}/.local/share/proof-shot/package.json` : '']) {
  if (chromium || !from) continue;
  try {
    ({ chromium } = createRequire(from)('playwright'));
  } catch (e) {
    // no Playwright here: skipped
  }
}
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const SHOTS = process.env.SHOTS || '';
const COLORS = ['#e9b8a6', '#a6c8e9', '#b8e9a6', '#e9e0a6', '#d2a6e9', '#a6e9de'];
const launch = () => chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}).catch(() => null);

const DAY = '2026-10-17'; // NOW (08:00 UTC) is 15:00 in Bangkok
const TT_ID = '1700000000000000001';
const ID = {
  pillow: 'world-strong-test-products-pillow-a1b2c3',
  posture: 'eu-shop1-test-products-item-1-d4e5f6',
  fryer: 'tiktok-1700000000000000001-4fb989',
  bed: 'world-calm-test-products-bed-0c9d8e',
  mat: 'eu-shop5-test-products-item-5-7f6e5d',
  towel: 'research-car-drying-towel-0a1b2c',
  lamp: 'world-old-test-products-lamp-123abc',
};
const ev = (signal, value, kind, source, link) => ({ signal, value, kind, source, date: '2026-10-16', ...(link ? { link } : {}) });
const econ = (price, margin, roas) => ({ price_eur: price, margin_eur: margin, breakeven_cpa_eur: margin, breakeven_roas: roas, landed_eur: 20, supplier_cost_eur: 12, supplier: 'est', vat_pct: 21, level: 'amber' });
const ladder = (paid, sustained, selling, profitable) => ({ paid, sustained, selling, profitable });

// Six picks: outside the EU, the EU with an audience card and a product sheet, TikTok, one decided already, one with a
// category Connor has not decided on, and a research pick with almost nothing (and HTML in its name).
const PICKS = [
  { key: 'world|strong.test/products/pillow', id: ID.pillow, name: 'Orthopedic 4D Pillow', src: 'world', category: 'Sleep and comfort', sub: 'Pillows', score: 67, level: 4,
    ladder: ladder(true, true, true, true), pillars: { proof: 0.951, demand: 0.3, competition: 0.75, margin: 0.603, fit: 0.707 }, coverage: 0.78,
    risk: { mult: 0.93, level: 'docs', gate: null, flags: ['Docs: Claims'], returns: [], undecided: [] }, price: { amount: 89.95, currency: 'EUR', eur: 89.95 }, econ: econ(89.95, 42.72, 2.11),
    why: '#1 in its store, ads 140 days, 5 ads, 12k EU reach a day',
    links: { product_url: 'https://strong.test/products/pillow', store_url: 'https://strong.test/', ad_library: 'https://www.facebook.com/ads/library/?id=1001', tiktok: null },
    ad_ids: ['w1001'], stores: ['strong.test'], markets: ['CH'], image: 'https://cdn.shopify.com/s/files/p1.jpg',
    evidence: [ev('best_seller_rank', 1, 'fact', "Its store's Shopify best-seller order (top 50)", 'https://strong.test/products/pillow'), ev('oldest_ad_days', 140, 'fact', 'Meta Ad Library (public, logged out)', 'https://www.facebook.com/ads/library/?id=1001'),
      ev('breakeven_cpa_eur', 42.72, 'estimate', 'Board unit economics, supplier price guessed'), ev('sold', '10k+', 'claim', 'A creator says so')] },
  { key: 'eu|shop1.test/products/item-1', id: ID.posture, name: 'Posture Corrector Pro', src: 'eu', category: 'Health and body', sub: 'Posture', score: 64, level: 3,
    ladder: ladder(true, true, false, true), pillars: { proof: 0.62, demand: 0.55, competition: 0.4, margin: 0.5, fit: 0.66 }, coverage: 0.7,
    risk: { mult: 0.86, level: 'docs', gate: null, flags: ['Docs: Claims', 'Returns: Sizes'], returns: ['Sizes'], undecided: [] }, price: { amount: 30.95, currency: 'EUR', eur: 30.95 }, econ: econ(30.95, 9.41, 3.29),
    why: 'ads 12 days, 81k EU reach a day', links: { product_url: 'https://shop1.test/products/item-1', ad_library: 'https://www.facebook.com/ads/library/?id=9001' },
    ad_ids: ['9001'], stores: ['shop1.test'], markets: ['NL', 'BE'], image: 'https://cdn.shopify.com/s/files/p2.jpg', evidence: [ev('eu_reach_per_day', 81000, 'fact', 'Meta Ad Library API')],
    audience: { one_line: 'office workers with back pain, 25-54, NZ; pain: aches after a long day', credits_used: 0, missing: ['Jev off: word lists only'],
      card: { problem: { line: 'Aches after a long day (12 of 80 statements)' }, reach_line: '64% women · ages 25-54 hold 70% of reach',
        personas: [{ label: 'Office workers', gender: 'mostly women (64% of reach)', ages: '25-54 (70% of reach)', countries: { launch: ['NZ', 'AU'] }, wants: [{ label: 'No more pain', n: 4 }], fears: [{ label: 'Looks bulky', n: 2 }] }],
        triggers: [{ label: 'After a long day at the desk' }], objections: [{ label: 'Does it really work?', answer: 'Show a 30-day before and after' }],
        words: { phrases: [{ phrase: 'back pain' }, { phrase: 'sit up straight' }] },
        angles: [{ n: 1, first_test: true, angle: 'Problem first', hook: 'Your back after 8 hours at a desk.', persona: 'Office workers' }, { n: 2, angle: 'Answer the doubt', hook: 'What it is made of.' }],
        targeting: { control: { campaign: 'Sales campaign, one ad set per product', countries: ['NZ'], age: '25-65+', gender: 'All', audience: 'Advantage+ audience on, no interests', placements: 'Advantage+ placements' },
          suggestions: { age: '25-54', gender: 'Women' }, interests: { names: ['Office', 'Back pain'], status: 'unverified' } } } },
    sheet: { one_line: 'Margin €19, break-even CPA €19 in NZ (est.). Blocker: none', margin_eur: 19.2, breakeven_cpa_eur: 19.2, main_blocker: 'sizes and returns', market: 'NZ', level: 'amber',
      test: { budget_eur: 140, daily_eur: 20, mode: 'dropship' }, md: '# Posture Corrector Pro\n\n| Market | Margin | Break-even CPA |\n|---|---|---|\n| NZ | €19.20 | €19.20 |\n\n<script>alert(1)</script>\n',
      sheet: { facts: ['Selling price €30.95 (fact)'], assumptions: ['Supplier cost a guess (guess)'] }, missing: ['a shipping quote for New Zealand'] } },
  { key: `tiktok|${TT_ID}`, id: ID.fryer, name: 'Digital Air Fryer with Smart Thermometer', src: 'tiktok', category: 'Kitchen', sub: null, score: 57, level: 3,
    ladder: ladder(true, true, false, true), pillars: { proof: 0.7, demand: 0.5, competition: 0.45, margin: 0.6, fit: 0.5 },
    risk: { mult: 0.93, level: 'docs', gate: null, flags: ['Docs: CE'], returns: [], undecided: [] }, price: { amount: 99.47, currency: 'USD', eur: 85.54 }, econ: econ(85.54, 40.05, 2.14),
    why: 'ads 65 days, break-even CPA €40 (est.)', links: { product_url: `https://www.tiktok.com/shop/pdp/${TT_ID}`, ad_library: 'https://www.facebook.com/ads/library/?view_all_page_id=3004', tiktok: `https://www.tiktok.com/shop/pdp/${TT_ID}` },
    ad_ids: [], stores: ['tiktok shop chefman us'], markets: ['US'], image: 'https://p16-oec.ttcdn-us.com/p3.jpg', evidence: [ev('sold', 52000, 'fact', 'TikTok Shop sold count (US)')] },
  { key: 'world|calm.test/products/bed', id: ID.bed, name: 'CalmBed Calming Dog Bed', src: 'world', category: 'Pets', sub: 'Beds', score: 61, level: 4,
    ladder: ladder(true, true, true, true), pillars: { proof: 0.8, demand: 0.5, competition: 0.6, margin: 0.7, fit: 0.6 },
    risk: { mult: 0.85, level: 'ok', gate: null, flags: ['Returns: Bulky'], returns: ['Bulky'], undecided: [] }, price: { amount: 650, currency: 'NOK', eur: 55.6 }, econ: econ(55.6, 21.3, 2.6),
    why: '#2 in its store, ads 64 days', links: { product_url: 'https://calm.test/products/bed', ad_library: 'https://www.facebook.com/ads/library/?id=1002' },
    ad_ids: ['w1002'], stores: ['calm.test'], markets: ['NO', 'SE'], image: 'https://cdn.shopify.com/s/files/p4.jpg' },
  { key: 'eu|shop5.test/products/item-5', id: ID.mat, name: 'Cooling Pet Mat', src: 'eu', category: 'Pets', sub: 'Pet food bowls', score: 55, level: 2,
    ladder: ladder(true, false, null, true), pillars: { proof: 0.4, demand: 0.6, competition: 0.5, margin: 0.55, fit: 0.45 },
    risk: { mult: 1, level: 'ok', gate: null, flags: [], returns: [], undecided: ['pet food'] }, price: { amount: 34.95, currency: 'EUR', eur: 34.95 }, econ: econ(34.95, 15.1, 2.31),
    why: 'ads 10 days <b>bold</b>', links: { product_url: 'https://shop5.test/products/item-5', ad_library: 'https://www.facebook.com/ads/library/?id=9005' },
    ad_ids: ['9005'], stores: ['shop5.test'], markets: ['NL'], image: null },
  { key: 'research|car-drying-towel', id: ID.towel, name: '<img src=x onerror=alert(1)>Car drying towel', src: 'research', score: 52, level: 1, ladder: { paid: true }, pillars: { proof: 0.4 },
    audience: 'car owners, AU (a plain line, no card)' },
];

async function todayEnv() {
  const env = await seededEnv();
  const db = env.db;
  // Outside the EU: two products (their ads start with w, as the world hunt saves them).
  const world = (key, ad, title) => db.prepare(`INSERT INTO world_products (product_key, ad_id, active, product_title, price, currency, image_url, store_url, product_url, ad_library_url, advertiser,
    page_id, keyword, markets, ads, creatives, days, new14, store_products, first_seen, last_seen) VALUES (?, ?, 1, ?, 79, 'EUR', ?, ?, ?, ?, ?, '77', 'pillow', '{"CH":{"ads":5,"days":140,"new14":0}}', 5, 2, 140, 0, 13, ?, ?)`)
    .run(key, ad, title, `https://cdn.shopify.com/s/files/${ad}.jpg`, `https://${key.split('/')[0]}/`, `https://${key}`, `https://www.facebook.com/ads/library/?id=${ad}`, 'Shop ' + ad,
      new Date(NOW - 5 * 864e5).toISOString(), new Date(NOW - 3600e3).toISOString());
  world('strong.test/products/pillow', 'w1001', 'Orthopedic 4D Pillow');
  world('calm.test/products/bed', 'w1002', 'CalmBed Calming Dog Bed');
  db.prepare("INSERT INTO state (key, value, updated_at) VALUES ('world_run', ?, ?)").run(JSON.stringify({ status: 'done', health: 'ok', finished_at: new Date(NOW - 3600e3).toISOString(), ads: 4210, new_products: 2, blocked: 0 }), new Date(NOW).toISOString());
  // The TikTok tab's row of the TikTok pick.
  await env.DB.prepare(UPSERT_SQL).bind(JSON.stringify([{ id: TT_ID, title: 'Digital Air Fryer with Smart Thermometer', shop: 'Chefman', url: `https://www.tiktok.com/shop/pdp/${TT_ID}`, image_url: null,
    price_min: 99.47, price_max: 99.47, rating: 4.6, reviews: 900, sold_us: 52000, creators: 40, plays: 3000000, category: 'Kitchen', blockers: '', meta_status: 'none', meta_url: null, meta_unsure: 0,
    meta_us: null, meta_au: null, meta_nz: null, updated_at: '2026-10-16T10:00:00Z', video_url: null, sold_mixed: 0, price_suspect: 0, ads_mention_n: null, ads_mention_of: null, ads_domain: null, meta_label: null }])).run();
  // Three days of runs: today's (6 picks), yesterday's (1), and one that failed.
  const run = db.prepare('INSERT INTO daily_runs (day, status, started_at, finished_at, picks, pool, summary, digest_md, digest_csv, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const summary = JSON.stringify({ stages: [{ stage: 'collect', ok: true, ms: 4000 }], passed_over: { score: 20000, evidence: 3500, decided: 41, 'rotation or duplicate': 321 }, prepare: { audience: 1, sheet: 2, failed: 0, dropped: [{ key: 'eu|x', why: 'product sheet: red' }] } });
  run.run(DAY, 'ok', '2026-10-16T23:01:00Z', '2026-10-16T23:09:00Z', PICKS.length, 24167, summary, `Winners for Sat 17 Oct 2026: 6 picks\n1. Orthopedic 4D Pillow: score 67. {{BOARD}}/#today/${ID.pillow}\n`, `day,pick,board\n${DAY},1,{{BOARD}}/#today/${ID.pillow}\n`, null);
  run.run('2026-10-16', 'ok', '2026-10-15T23:01:00Z', '2026-10-15T23:08:00Z', 1, 23900, '{}', 'Winners for Fri 16 Oct 2026: 1 pick\n', 'day,pick\n', null);
  run.run('2026-10-15', 'failed', '2026-10-14T23:01:00Z', '2026-10-14T23:02:00Z', 0, 0, '{}', 'The run failed at score.\n', 'day,pick\n', 'score: out of time');
  const pick = db.prepare('INSERT INTO daily_picks (day, product_key, rank, id, score, level, title, data, decision, reason, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  PICKS.forEach((p, i) => {
    const decided = p.id === ID.bed;
    pick.run(DAY, p.key, i + 1, p.id, p.score, p.level, p.name, JSON.stringify(p), decided ? 'reject' : null, decided ? 'too expensive' : null, decided ? '2026-10-17T02:30:00.000Z' : null);
  });
  // The decided one is rejected on the board too, as the Today tab leaves it.
  db.prepare("INSERT INTO hidden (ad_id, status, at) VALUES ('w1002', 'rejected', '2026-10-17T02:30:00.000Z')").run();
  pick.run('2026-10-16', 'world|old.test/products/lamp', 1, ID.lamp, 61, 3, 'Sunset Lamp', JSON.stringify({ key: 'world|old.test/products/lamp', id: ID.lamp, name: 'Sunset Lamp', src: 'world', score: 61, level: 3 }), null, null, null);
  return env;
}

// The Worker on a local port; clock.now is the Worker's "now" (moved forward for the failed run). POST bodies are kept.
function serve(env, clock) {
  const posts = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    if (req.method === 'POST') {
      let j = null;
      try { j = JSON.parse(String(body || '')); } catch (e) { /* not JSON */ }
      posts.push({ path: req.url, body: j });
    }
    const out = await handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env, { html: HTML, now: clock.now });
    const headers = {};
    out.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(out.status, headers);
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, posts })));
}

// What D1 holds now, polled until it is what the board should have saved.
async function until(what, fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('Timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 40));
  }
}
const row = (env, sql, ...args) => { const r = env.db.prepare(sql).get(...args); return r ? { ...r } : null; };
const pickRow = (env, key, day = DAY) => row(env, 'SELECT decision, reason FROM daily_picks WHERE day = ? AND product_key = ?', day, key);

async function page0(browser, env, base, viewport, o = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: SHOTS ? (o.dpr || 3) : 1, isMobile: o.mobile !== false, hasTouch: o.mobile !== false, serviceWorkers: 'block' });
  // Photos come from the stores' CDNs: answered here with a colored square (nothing leaves this machine).
  await ctx.route(/^https:\/\//, (route) => {
    const n = Number((route.request().url().match(/p(\d+)\.jpg/) || [0, 0])[1]);
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="${COLORS[n % COLORS.length]}"/><circle cx="200" cy="200" r="${90 + (n % 4) * 15}" fill="#fff" fill-opacity=".55"/></svg>` });
  });
  const page = await ctx.newPage();
  await page.setExtraHTTPHeaders({ cookie: `__Host-wh=${await tokenFor(env, NOW)}` });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
  return { ctx, page, errors };
}
const card = (page, id) => page.locator(`#td-${id}`);
const noSideScroll = async (page, where) => {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw, `${where}: the page is ${sw}px wide in a ${cw}px screen`);
};

test('Today on an iPhone: the first screen, the cards, Keep / Reject / Launch test and Undo on the board too, #today/<id>, a failed run, the other tabs', { skip: !chromium && 'Playwright not installed', timeout: 180000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await todayEnv();
  const clock = { now: NOW };
  const { server, posts } = await serve(env, clock);
  const base = `http://127.0.0.1:${server.address().port}`;
  const { ctx, page, errors } = await page0(browser, env, base, { width: 390, height: 844 });
  const shot = async (name, o = {}) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, ...o }); };
  try {
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
    await page.goto(base + '/');
    await page.waitForSelector('#today .tdc');
    // The first screen: Today, first in the tabs and pressed; the hunt's controls and cards step aside.
    assert.strictEqual(await page.locator('.scope button').first().getAttribute('data-scope'), 'today');
    assert.strictEqual(await page.getAttribute('[data-scope="today"]', 'aria-pressed'), 'true');
    assert.strictEqual(await page.getAttribute('[data-scope="world"]', 'aria-pressed'), 'false');
    for (const sel of ['#grid', '.wrap > .rail', '#runbox', '#radar', '#csv']) assert.strictEqual(await page.isVisible(sel), false, sel + ' steps aside');
    // The five tabs fit on a phone (390 and 375 px), and the three buttons keep their words on one line.
    const tabsFit = () => page.evaluate(() => { const s = document.querySelector('.scope'); return s.scrollWidth <= s.clientWidth; });
    assert.ok(await tabsFit(), 'the five tabs fit at 390 px');
    assert.ok((await page.locator(`#td-${ID.pillow} [data-tdd="launch"]`).boundingBox()).height <= 46, 'Launch test on one line');
    await page.setViewportSize({ width: 375, height: 812 });
    assert.ok(await tabsFit(), 'the five tabs fit at 375 px');
    assert.ok((await page.locator(`#td-${ID.pillow} [data-tdd="launch"]`).boundingBox()).height <= 46, 'Launch test on one line at 375 px');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.strictEqual(await page.textContent('#today h2'), 'Winners for Sat 17 Oct 2026');
    assert.strictEqual(await page.textContent('#today .tdstat'), '6 picks · 24,167 scored · ready 06:09');
    assert.strictEqual(await page.textContent('#ntoday'), '5', 'the undecided picks');
    // Six cards in rank order.
    assert.deepStrictEqual(await page.locator('#today .tdc .tdrk').allInnerTexts(), ['1', '2', '3', '4', '5', '6']);
    assert.deepStrictEqual((await page.locator('#today .tdc h3').allInnerTexts()).map((x) => x.slice(0, 22)),
      ['Orthopedic 4D Pillow', 'Posture Corrector Pro', 'Digital Air Fryer with', 'CalmBed Calming Dog Be', 'Cooling Pet Mat', '<img src=x onerror=ale']);
    assert.strictEqual(await page.locator('#today img[src="x"], #today .tdwhy b').count(), 0, 'text from the data stays text');
    // A card: the score, the ladder, five pillar bars, the money, the risk.
    const c1 = card(page, ID.pillow);
    assert.strictEqual(await c1.locator('.tdsc b').textContent(), '67');
    assert.deepStrictEqual(await c1.locator('.tdlad li').evaluateAll((ls) => ls.map((l) => l.className + ':' + l.querySelector('b').textContent)), ['yes:✓', 'yes:✓', 'yes:✓', 'yes:✓']);
    assert.deepStrictEqual(await card(page, ID.mat).locator('.tdlad li b').allInnerTexts(), ['✓', '✗', '?', '✓'], 'yes, no, not known');
    assert.deepStrictEqual(await c1.locator('.tdpil li span').allInnerTexts(), ['Proof', 'Demand', 'Competition', 'Margin', 'Fit']);
    assert.deepStrictEqual(await c1.locator('.tdpil li b').allInnerTexts(), ['0.95', '0.30', '0.75', '0.60', '0.71']);
    // The bars grow in (CSSOM widths: the CSP blocks style attributes): proof 95% full, demand 30%.
    const fill = (id, k) => page.evaluate(([i, p]) => { const b = document.querySelector(`#td-${i} [data-pillar="${p}"] i`); return parseFloat(getComputedStyle(b, '::before').width) / b.getBoundingClientRect().width; }, [id, k]);
    await page.waitForFunction((id) => { const b = document.querySelector(`#td-${id} [data-pillar="proof"] i`); return Math.abs(parseFloat(getComputedStyle(b, '::before').width) / b.getBoundingClientRect().width - 0.951) < 0.02; }, ID.pillow);
    assert.ok(Math.abs((await fill(ID.pillow, 'demand')) - 0.3) < 0.02, 'the demand bar is 30% full'); // a CSP refusal would be a console error: none below
    assert.match(await c1.locator('.tdm').innerText(), /€89\.95[\s\S]*price[\s\S]*€42\.72[\s\S]*margin · est\.[\s\S]*€42\.72[\s\S]*break-even CPA · est\.[\s\S]*2\.11×[\s\S]*break-even ROAS/);
    assert.match(await c1.locator('.tdrisk').innerText(), /Risk × 0\.93\s*Docs: Claims/);
    assert.match(await c1.locator('.tdwhy').innerText(), /#1 in its store, ads 140 days/);
    assert.deepStrictEqual(await c1.locator('.tdlinks a').allInnerTexts(), ['Ad Library ↗', 'Product page ↗']);
    assert.deepStrictEqual(await card(page, ID.fryer).locator('.tdlinks a').allInnerTexts(), ['Ad Library ↗', 'TikTok ↗'], 'the TikTok listing once');
    assert.match(await card(page, ID.mat).locator('.tdund').innerText(), /^Connor hasn't decided: pet food$/);
    assert.match(await card(page, ID.towel).innerText(), /no price known yet[\s\S]*Audience car owners, AU \(a plain line, no card\)[\s\S]*Product sheet not prepared yet/, 'a pick with almost nothing still shows');
    // Evidence: each item with its kind, source, date and link.
    await c1.locator('details[data-tdo="ev"] summary').click();
    assert.match(await c1.locator('details[data-tdo="ev"] summary').innerText(), /Evidence\s+4 · 2 facts/);
    assert.deepStrictEqual(await c1.locator('.tdevl .rt').allInnerTexts(), ['Fact', 'Fact', 'Estimate', 'Claim']);
    assert.match(await c1.locator('.tdevl li').first().innerText(), /^Store best-seller rank 1 Fact\s+Its store's Shopify best-seller order \(top 50\) · 16 Oct 2026 · open ↗$/);
    assert.strictEqual(await c1.locator('.tdevl li').first().locator('a').getAttribute('href'), 'https://strong.test/products/pillow');
    await noSideScroll(page, 'Today');
    await page.evaluate(() => scrollTo(0, 0));
    await shot('today-mobile');

    // The audience card and the product sheet: one line each, the rest one tap away (the sheet's Markdown stays text).
    const c2 = card(page, ID.posture);
    assert.match(await c2.locator('.tdln').first().innerText(), /^Audience office workers with back pain, 25-54, NZ/);
    assert.match(await c2.innerText(), /Product sheet Margin €19, break-even CPA €19 in NZ \(est\.\)\. Blocker: none\s+Main blocker sizes and returns · market NZ · level amber · test €140 at €20 a day \(dropship\)/);
    await c2.locator('details[data-tdo="aud"] summary').click();
    await c2.locator('details[data-tdo="sheet"] summary').click();
    const aud = await c2.locator('details[data-tdo="aud"]').innerText();
    for (const x of [/Problem\s+Aches after a long day/, /Office workers mostly women \(64% of reach\) · 25-54 \(70% of reach\) · NZ, AU/, /Wants: No more pain/, /First test · Problem first: “Your back after 8 hours at a desk\.”/,
      /Campaign Sales campaign/, /Suggested age: 25-54 · gender: Women/, /Interests Office, Back pain · unverified/, /Missing\s+Jev off/]) assert.match(aud, x);
    assert.match(await c2.locator('.tdmd').textContent(), /<script>alert\(1\)<\/script>/);
    assert.strictEqual(await page.locator('#today .tdmd script').count(), 0);
    await c2.scrollIntoViewIfNeeded();
    await c2.locator('details[data-tdo="ev"] summary').click();
    await noSideScroll(page, 'an open card');
    if (SHOTS) await c2.screenshot({ path: `${SHOTS}/today-card-expanded.png` });

    // Keep, then a reason: the pick (daily_picks) and the board's own ✓ (hidden 'seen' for its ad, its reason on the decision row).
    await c1.locator('[data-tdd="keep"]').click();
    await c1.locator('.tdwy [data-tdr="my niche"]:not([disabled])').waitFor();
    assert.strictEqual(await c1.locator('.tdwy [data-tdr="too expensive"]').count(), 0, 'Keep gets the good reasons');
    assert.strictEqual(await c1.locator('.tdwy [data-tdr="other"]').count(), 1);
    await c1.locator('.tdwy [data-tdr="my niche"]').click();
    await until('Keep with its reason', () => JSON.stringify(pickRow(env, PICKS[0].key)) === '{"decision":"keep","reason":"my niche"}');
    assert.deepStrictEqual(row(env, "SELECT status FROM hidden WHERE ad_id = 'w1001'"), { status: 'seen' });
    await until('the reason on the board', () => (row(env, "SELECT reasons FROM feedback WHERE ad_id = 'w1001' AND action = 'seen'") || {}).reasons === '["niche"]');
    await c1.locator('.tdst [data-tdu]:not([disabled])').waitFor();
    assert.match(await c1.locator('.tdst').innerText(), /✓ Kept · my niche/);
    assert.match(await c1.getAttribute('class'), /\bdone\b/, 'decided: dimmed, still there');
    assert.strictEqual(await page.textContent('#ntoday'), '4');
    await shot('today-mobile-kept', { fullPage: false });

    // Reject on the TikTok pick, without a reason: /api/tiktok is called and the TikTok tab has it.
    const c3 = card(page, ID.fryer);
    await c3.locator('[data-tdd="reject"]').click();
    await c3.locator('.tdwy [data-tdr="not my niche"]').waitFor();
    assert.strictEqual(await c3.locator('.tdwy [data-tdr="my niche"]').count(), 0, 'Reject gets the bad reasons');
    await c3.locator('.tdwy [data-tdx]:not([disabled])').click();
    await until('Reject on the TikTok pick', () => JSON.stringify(pickRow(env, PICKS[2].key)) === '{"decision":"reject","reason":null}');
    await until('the TikTok tab', () => (row(env, 'SELECT decision FROM tiktok_products WHERE id = ?', TT_ID) || {}).decision === 'rejected');
    assert.ok(posts.some((x) => x.path === '/api/tiktok' && x.body && x.body.id === TT_ID && x.body.decision === 'rejected'), 'POST /api/tiktok');
    await c3.locator('.tdst [data-tdu]:not([disabled])').waitFor();
    // Undo: the pick and the TikTok tab are undecided again.
    await c3.locator('.tdst [data-tdu]').click();
    await until('Undo on the TikTok pick', () => JSON.stringify(pickRow(env, PICKS[2].key)) === '{"decision":null,"reason":null}');
    await until('Undo on the TikTok tab', () => (row(env, 'SELECT decision FROM tiktok_products WHERE id = ?', TT_ID) || {}).decision === null);
    assert.ok(posts.some((x) => x.path === '/api/tiktok' && x.body && x.body.decision === ''), 'POST /api/tiktok { decision: "" }');
    await c3.locator('[data-tdd="keep"]:not([disabled])').waitFor();

    // The pick decided before this visit: dimmed with its decision and reason; Undo clears it here and on the board.
    const c4 = card(page, ID.bed);
    assert.match(await c4.getAttribute('class'), /\bdone\b/);
    assert.match(await c4.locator('.tdst').innerText(), /✗ Rejected · too expensive/);
    await c4.locator('.tdst [data-tdu]').click();
    await until('Undo of the earlier decision', () => JSON.stringify(pickRow(env, PICKS[3].key)) === '{"decision":null,"reason":null}');
    await until('the board undecided too', () => row(env, "SELECT status FROM hidden WHERE ad_id = 'w1002'") === null);
    await c4.locator('[data-tdd="keep"]:not([disabled])').waitFor();
    assert.doesNotMatch(await c4.getAttribute('class'), /\bdone\b/);
    assert.strictEqual(await page.textContent('#ntoday'), '5');

    // Launch test: approved on the board and its launch card started (/api/launch); Open 🚀 shows it; Undo takes both back.
    const c5 = card(page, ID.mat);
    await c5.locator('[data-tdd="launch"]').click();
    await c5.locator('.tdwy [data-tdx]:not([disabled])').click();
    await until('Launch test', () => JSON.stringify(pickRow(env, PICKS[4].key)) === '{"decision":"launch","reason":null}');
    await until('approved on the board', () => (row(env, "SELECT status FROM hidden WHERE ad_id = '9005'") || {}).status === 'seen');
    await until('its launch card', () => row(env, 'SELECT product_key FROM launches WHERE product_key = ?', PICKS[4].key));
    assert.match(await c5.locator('.tdst').innerText(), /🚀 Launch test[\s\S]*its launch card is in 🚀/);
    await c5.locator('.tdst [data-tdln]').click();
    await page.waitForSelector('body.lnv #lnbox .lncard');
    assert.match(await page.locator('#lnbox .lncard').first().innerText(), /Cooling|item 5|Shop 5/i);
    assert.strictEqual(await page.isVisible('#today'), false, 'the launch view, not Today');
    await page.click('[data-scope="today"]');
    await card(page, ID.mat).locator('.tdst [data-tdu]:not([disabled])').waitFor();
    assert.strictEqual(await page.isVisible('#lnbox'), false);
    await card(page, ID.mat).locator('.tdst [data-tdu]').click();
    await until('Undo of the launch test', () => JSON.stringify(pickRow(env, PICKS[4].key)) === '{"decision":null,"reason":null}');
    await until('its untouched launch card gone', () => row(env, 'SELECT product_key FROM launches WHERE product_key = ?', PICKS[4].key) === null);
    assert.strictEqual(row(env, "SELECT status FROM hidden WHERE ad_id = '9005'"), null);

    // #today/<id> (the digest's links): that card, highlighted and on screen; also a pick of an earlier day.
    await page.goto(base + '/#today/' + ID.towel);
    await page.waitForSelector(`#td-${ID.towel}.hi`);
    await page.waitForFunction((id) => { const r = document.getElementById('td-' + id).getBoundingClientRect(); return r.top >= -1 && r.top < innerHeight / 2; }, ID.towel);
    assert.strictEqual(await page.locator('#today .tdc.hi').count(), 1);
    await shot('today-mobile-deeplink');
    const deep = await page0(browser, env, base, { width: 390, height: 844 });
    await deep.page.goto(base + '/#today/' + ID.lamp);
    await deep.page.waitForSelector(`#td-${ID.lamp}.hi`);
    assert.strictEqual(await deep.page.textContent('#today h2'), 'Winners for Fri 16 Oct 2026');
    assert.strictEqual(await deep.page.getAttribute('[data-tday="2026-10-16"]', 'aria-pressed'), 'true');
    await deep.page.click('[data-tday="2026-10-17"]');
    await deep.page.waitForFunction(() => document.querySelectorAll('#today .tdc').length === 6);
    assert.deepStrictEqual(deep.errors, []);
    await deep.ctx.close();
    // The day switcher: every day with its status; the digest of the day as Markdown and CSV.
    assert.deepStrictEqual(await page.locator('#today .tddays button').evaluateAll((bs) => bs.map((b) => b.dataset.tday + ':' + b.querySelector('.tddot').className.replace('tddot', '').trim())),
      ['2026-10-17:ok', '2026-10-16:ok', '2026-10-15:failed']);
    const md = await page.evaluate(async (h) => (await fetch(h)).text(), await page.getAttribute('#today .tdtools a[href*="format=md"]', 'href'));
    assert.match(md, new RegExp(`^Winners for Sat 17 Oct 2026[\\s\\S]*${base.replace(/[.:/]/g, '\\$&')}/#today/${ID.pillow}`));
    assert.match(await page.getAttribute('#today .tdtools a[href*="format=csv"]', 'href'), /^\/api\/today\/digest\?day=2026-10-17&format=csv$/);

    // 375 px wide: nothing scrolls sideways either.
    await page.setViewportSize({ width: 375, height: 812 });
    await noSideScroll(page, 'Today at 375 px');

    // A failed run today: a red banner, yesterday's picks stay below it.
    env.db.prepare("INSERT INTO daily_runs (day, status, started_at, finished_at, picks, pool, summary, error) VALUES ('2026-10-18', 'failed', '2026-10-17T23:01:00Z', '2026-10-17T23:02:00Z', 0, 0, '{}', 'collect: D1 500')").run();
    clock.now = Date.parse('2026-10-18T02:00:00Z'); // 09:00 in Bangkok
    await page.goto(base + '/');
    await page.waitForSelector('#today .tdban');
    assert.match(await page.getAttribute('#today .tdban', 'class'), /\balert\b.*\bred\b/);
    assert.match(await page.textContent('#today .tdban'), /^Today's run failed: collect: D1 500\. Yesterday's picks stay below until the next run\.$/);
    assert.strictEqual(await page.textContent('#today h2'), 'Winners for Sat 17 Oct 2026');
    assert.strictEqual(await page.locator('#today .tdc').count(), 6);
    assert.strictEqual(await page.getAttribute('#today .tddays button:first-child', 'data-tday'), '2026-10-18');
    await shot('today-mobile-failed-run');

    // The other tabs work as before, and Today comes back.
    await page.click('[data-scope="world"]');
    await page.waitForSelector('#grid .card');
    assert.strictEqual(await page.evaluate(() => document.body.classList.contains('td')), false);
    assert.strictEqual(await page.isVisible('#today'), false);
    assert.strictEqual(await page.isVisible('.wrap > .rail'), true);
    await page.click('[data-scope="eu"]');
    await page.waitForFunction(() => document.querySelector('[data-view="inbox"]').getAttribute('aria-pressed') === 'true' && document.body.classList.contains('inbox'));
    await page.click('[data-scope="tiktok"]');
    await page.waitForSelector('#ttgrid .card');
    assert.strictEqual(await page.isVisible('#today'), false);
    await page.click('[data-scope="today"]');
    await page.waitForFunction(() => document.querySelectorAll('#today .tdc').length === 6 && document.body.classList.contains('td'));
    assert.strictEqual(await page.isVisible('#ttbox'), false);
    assert.deepStrictEqual(errors, []);
  } finally {
    await ctx.close();
    await browser.close();
    server.close();
  }
});

test('Today on a desktop, and before the first daily run: the board opens as before, Today says when it starts', { skip: !chromium && 'Playwright not installed', timeout: 120000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = await todayEnv();
  const clock = { now: NOW };
  const { server } = await serve(env, clock);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    // Desktop, 1280 x 900.
    const desk = await page0(browser, env, base, { width: 1280, height: 900 }, { mobile: false, dpr: 2 });
    await desk.page.goto(base + '/');
    await desk.page.waitForSelector('#today .tdc');
    await noSideScroll(desk.page, 'Today on a desktop');
    const box = await desk.page.locator('#today').boundingBox();
    assert.ok(box.width <= 822, `one column, centred (${box.width}px)`);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await desk.page.waitForTimeout(600);
      await desk.page.screenshot({ path: `${SHOTS}/today-desktop.png` });
    }
    assert.deepStrictEqual(desk.errors, []);
    await desk.ctx.close();

    // No daily run yet: the board opens on the hunt you used last (here the EU), as before; Today is one tap away.
    env.db.exec('DELETE FROM daily_picks; DELETE FROM daily_runs;');
    const none = await page0(browser, env, base, { width: 390, height: 844 });
    await none.page.addInitScript(() => localStorage.setItem('wh-scope', 'eu'));
    await none.page.goto(base + '/');
    await none.page.waitForSelector('#grid .card');
    assert.strictEqual(await none.page.getAttribute('[data-scope="eu"]', 'aria-pressed'), 'true');
    assert.strictEqual(await none.page.getAttribute('[data-scope="today"]', 'aria-pressed'), 'false');
    assert.strictEqual(await none.page.getAttribute('[data-view="inbox"]', 'aria-pressed'), 'true');
    await none.page.click('[data-scope="today"]');
    await none.page.waitForSelector('#today .tdempty');
    assert.match(await none.page.textContent('#today .tdempty'), /No daily run yet: today's winners start after the first daily run\./);
    // Before the migration (no tables): the same, and what is still to come.
    env.db.exec('DROP TABLE daily_picks; DROP TABLE daily_runs;');
    await none.page.reload();
    await none.page.waitForSelector('#grid .card');
    await none.page.click('[data-scope="today"]');
    await none.page.waitForFunction(() => /start after the next deploy and the first daily run/.test(document.querySelector('#today').textContent));
    assert.strictEqual(await none.page.locator('#today .tdc').count(), 0);
    assert.deepStrictEqual(none.errors, []);
    await none.ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
});
