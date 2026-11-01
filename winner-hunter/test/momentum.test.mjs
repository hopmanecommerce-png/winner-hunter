// Momentum (momentum.mjs, lib/momentum.mjs, worker/src/momentum.mjs, migrations/0018_momentum.sql): the trend maths, the
// same item in other stores, Google Trends, the daily job on an in-memory D1 (node:sqlite), what the board reads and how
// it ranks with it, and the D1 budget: a day costs a few writes, the board reads a few rows, not one per product.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { handle } from '../worker/src/app.mjs';
import { statements, migrate, d1Client } from '../lib/d1.mjs';
import { d1Rest } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { momentumEnv, RISER, FALLER, STEADY, GONE, TT_UP, TT_DOWN, SUPPLIER, DAY } from './helpers/momentum.mjs';
import {
  dayOf, trend, rankTrend, rankPoints, soldTrend, priceChange, sparkOf, tokensOf, sameWords, supplierImageId, dhash, hamming, usableHash,
  rivalsOf, trendsQuery, trendsUrl, trendsOf, summaryOf, partsOf, splitMap, historyOf, itemsOf,
} from '../lib/momentum.mjs';
import { run, askTrends, hashPhotos, DAILY_SQL } from '../momentum.mjs';
import { momentumKit, scoreOf, crowdOf, factorOf, cardOf, readMomentum, attachMomentum, momentumX, MOMENTUM_JS, WEIGHTS, PARTS_SQL } from '../worker/src/momentum.mjs';

const ORIGIN = 'https://winner-hunter.example.workers.dev';
const d = (n) => dayOf(NOW - n * DAY);
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

/** Logs in through the PIN form (as a phone does), so the test holds whatever cookie the board hands out. */
async function login(env, now = NOW) {
  const res = await handle(new Request(ORIGIN + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '203.0.113.7' }, body: 'pin=' + env.BOARD_PIN }), env, { now });
  const m = /__Host-wh=[^;]+/.exec(res.headers.get('set-cookie') || '');
  assert.ok(m, 'the PIN form hands out a cookie');
  const call = (path, init = {}) => handle(new Request(ORIGIN + path, { ...init, headers: { cookie: m[0], ...init.headers } }), env, { html: '<html></html>', now });
  return { call, get: async (path) => (await call(path)).json() };
}

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------
test('migration 0018: only CREATE … IF NOT EXISTS, safe again and again, and the history view expands a day into rows', () => {
  const st = statements(fs.readFileSync(new URL('../worker/migrations/0018_momentum.sql', import.meta.url), 'utf8'));
  assert.deepStrictEqual(st.map((x) => x.split('\n')[0].split('(')[0].trim()), ['CREATE TABLE IF NOT EXISTS momentum_daily', 'CREATE VIEW IF NOT EXISTS momentum_history AS', 'CREATE TABLE IF NOT EXISTS momentum']);
  assert.ok(st.every((x) => !/\b(DROP|DELETE|ALTER|UPDATE|INSERT)\b/i.test(x)), 'nothing that drops, changes or fills data');
  const db = new DatabaseSync(':memory:');
  for (let i = 0; i < 3; i++) for (const x of st) db.exec(x);
  db.prepare('INSERT INTO momentum_daily (day, part, body) VALUES (?, 0, ?)').run('2026-11-01', JSON.stringify({ 'world|a.test/products/x': { a: 12, s: 90, b: 3, r: 2 }, 'tiktok|9': { o: 5000, t: '2026-10-30' } }));
  const rows = db.prepare('SELECT product_key, ads, shop_ads, best_seller_rank, rivals, tiktok_sold FROM momentum_history ORDER BY product_key').all().map((r) => ({ ...r }));
  assert.deepStrictEqual(rows, [
    { product_key: 'tiktok|9', ads: null, shop_ads: null, best_seller_rank: null, rivals: null, tiktok_sold: 5000 },
    { product_key: 'world|a.test/products/x', ads: 12, shop_ads: 90, best_seller_rank: 3, rivals: 2, tiktok_sold: null },
  ]);
});

// ---------------------------------------------------------------------------
// The trend maths
// ---------------------------------------------------------------------------
test('trend: now against about a week ago (the newest point 7+ days back, else the oldest 3+ back); none without one', () => {
  assert.deepStrictEqual(trend([[d(9), 4], [d(7), 5], [d(2), 7], [d(0), 9]], 3), { c: 0.8, from: 5, to: 9, days: 7 }, 'the point a week back, not the oldest');
  assert.deepStrictEqual(trend([[d(5), 10], [d(4), 11], [d(0), 8]], 3), { c: -0.2, from: 10, to: 8, days: 5 }, 'under a week: the oldest 3+ days back');
  assert.strictEqual(trend([[d(2), 4], [d(0), 9]], 3), null, 'two days of numbers: no trend yet');
  assert.strictEqual(trend([[d(30), 4], [d(0), 9]], 3), null, 'a month back is too far');
  assert.strictEqual(trend([[d(8), 1], [d(0), 2]], 3).c, 0.33, 'small numbers are measured against the floor (1 → 2 is not +100%)');
  assert.strictEqual(trend([[d(8), 2], [d(0), 40]], 3).c, 1, 'at most +1');
  assert.strictEqual(trend([[d(8), 40], [d(0), 0]], 3).c, -1, 'at least −1');
  assert.strictEqual(trend([[d(8), 5, d(20)], [d(0), 5, d(20)]], 3), null, 'the same measurement twice (EU board not hunted): nothing new');
  assert.strictEqual(trend([[d(8), 5, d(20)], [d(0), 9, d(1)]], 3).c, 0.8, 'a new measurement: a trend');
  assert.strictEqual(trend([[d(8), null], [d(0), 9]], 3), null, 'no number then');
});

test('rankTrend: climbing, entering and leaving the store\'s top 50, from the store signals\' history and the daily rows', () => {
  assert.deepStrictEqual(rankTrend([[d(8), 12], [d(0), 5]]), { c: 0.7, from: 12, to: 5, days: 8 });
  assert.strictEqual(rankTrend([[d(8), 5], [d(0), 25]]).c, -1, 'down 20 places: −1');
  assert.strictEqual(rankTrend([[d(8), null], [d(0), 4]]).c, 0.75, 'into the top 10');
  assert.strictEqual(rankTrend([[d(8), 0], [d(0), 30]]).c, 0.5, 'into the top 50 (0: checked, not in it)');
  assert.strictEqual(rankTrend([[d(8), 30], [d(0), null]]).c, -0.5, 'out of the top 50');
  assert.strictEqual(rankTrend([[d(8), null], [d(0), null]]).c, 0, 'outside both times: no move');
  assert.strictEqual(rankTrend([[d(1), 9], [d(0), 3]]), null, 'one day: too short');
  const pts = rankPoints([[d(3), 7], [d(1), null]], [[d(3), { b: 9 }], [d(2), { b: 8 }], [d(0), { b: 0 }]]);
  assert.deepStrictEqual(pts, [[d(3), 7], [d(2), 8], [d(1), null], [d(0), null]], 'the store signals win on a day both have; 0 is outside the top 50');
});

test('soldTrend: one count per TikTok import; the pace against lifetime sales, and speeding up or slowing down', () => {
  const s = soldTrend([[d(20), 100000, d(20)], [d(19), 100000, d(20)], [d(10), 110000, d(10)], [d(0), 130000, d(0)]]);
  assert.deepStrictEqual({ v: s.v, speeds: s.speeds }, { v: 2000, speeds: [1000, 2000] }, 'repeated days of one import count once');
  assert.ok(s.c > 0.9, `46% of its lifetime sales in 30 days and twice as fast: rising (${s.c})`);
  assert.ok(Math.abs(soldTrend([[d(10), 1000000, d(10)], [d(0), 1000000 + 16667, d(0)]]).c) <= 0.01, 'about 5% of lifetime sales a month: steady');
  assert.ok(soldTrend([[d(10), 1000000, d(10)], [d(0), 1001000, d(0)]]).c <= -0.9, '0.3% a month: falling');
  assert.strictEqual(soldTrend([[d(10), 500, d(10)], [d(0), 400, d(0)]]), null, 'a count that went down is no trend');
  assert.strictEqual(soldTrend([[d(10), 500, d(10)]]), null, 'one import: nothing yet');
});

test('price change over 14 days, and a sparkline of the last 14 days with gaps', () => {
  assert.strictEqual(priceChange([[d(20), 50], [d(12), 40], [d(0), 30]]), -25, 'from the oldest price within 14 days');
  assert.strictEqual(priceChange([[d(0), 30]]), null);
  assert.deepStrictEqual(sparkOf([[d(20), 1], [d(5), 3], [d(3), 4], [d(0), 9]], d(0)), [3, null, 4, null, null, 9], 'starts at the first day it has, inside the 14');
});

// ---------------------------------------------------------------------------
// The same item in other stores
// ---------------------------------------------------------------------------
test('tokensOf / sameWords: what the product is, not the sales words, sizes, colours or the store\'s brand', () => {
  assert.deepStrictEqual([...tokensOf('【Black Friday】 Portable Neck Fan, Bladeless 4000mAh USB Rechargeable (2 Pack) Black', 'glowify.com')], ['portable', 'neck', 'fan', 'bladeless', 'usb', 'rechargeable']);
  assert.deepStrictEqual([...tokensOf('Glowify Sunset Lamps', 'getglowify.com')], ['sunset', 'lamp'], 'the store\'s brand out, plurals singular');
  assert.deepStrictEqual([...tokensOf('Neck Fan', 'fan.com')], ['neck', 'fan'], 'a store named after its product keeps the word');
  assert.deepStrictEqual([...tokensOf('Crème Hydratante Visage')], ['creme', 'hydratante', 'visage'], 'accents off');
  assert.ok(tokensOf('ネックファン 首掛け扇風機').has('ネッ'), 'Japanese as pairs of characters');
  const same = (a, b) => sameWords(tokensOf(a), tokensOf(b));
  assert.ok(same('Bladeless Neck Fan', 'Portable Neck Fan Bladeless Hanging USB Rechargeable 4000mAh'), 'a short title inside a long one');
  assert.ok(same('No-Pull Dog Harness', 'Dog Harness No Pull Reflective'));
  assert.ok(same('LED Sunset Lamp', 'Sunset Projection Lamp LED'));
  assert.ok(same('Rhino Straps Heavy Duty Ratchet Tie Down Straps 2 Pack 1500lbs Cargo Straps for Moving', 'Ratchet Tie Down Straps'), 'TikTok\'s long titles against a store\'s');
  assert.ok(!same('Dog Harness', 'Cat Harness'), 'one word in common is not the same item');
  assert.ok(!same('Heated Neck Pillow', 'Heated Knee Pillow'));
  assert.ok(!same('Heavy Duty Cargo Net', 'Rhino Straps Heavy Duty Ratchet Tie Down Straps Cargo'), '3 words of 4 are not enough when one title is long');
  assert.ok(!same('Smart Water Bottle', 'Smart Watch'));
});

test('supplierImageId: the AliExpress / 1688 photo id in a file name, through Shopify\'s size and copy suffixes; else nothing', () => {
  const id = SUPPLIER.toLowerCase();
  assert.strictEqual(supplierImageId(`https://cdn.shopify.com/s/files/1/0612/files/${SUPPLIER}.jpg?v=171`), id);
  assert.strictEqual(supplierImageId(`https://cdn.shopify.com/s/files/1/0099/products/${SUPPLIER}_1a2b3c4d-1111-2222-3333-444455556666.jpg?v=9&width=400`), id, 'Shopify\'s copy suffix');
  assert.strictEqual(supplierImageId(`https://ae01.alicdn.com/kf/${SUPPLIER}.jpg_640x640.jpg`), id, 'AliExpress\'s own resize');
  assert.strictEqual(supplierImageId(`https://shop.test/cdn/shop/files/${SUPPLIER}_800x.webp`), id, 'a size suffix');
  assert.strictEqual(supplierImageId('https://cbu01.alicdn.com/img/ibank/O1CN01abcdEF1x2y3z4Q_!!2207712345678-0-cib.jpg'), 'o1cn01abcdef1x2y3z4q', '1688');
  for (const u of ['https://cdn.shopify.com/s/files/1/files/lamp-front.jpg', 'https://cdn.shopify.com/s/files/1/IMG_2041.jpg', 'not a url', '']) assert.strictEqual(supplierImageId(u), '', u);
});

test('dHash: a fingerprint of 64 bits; pictures that look alike are a few bits apart; a flat picture says nothing', () => {
  const ramp = (f) => Array.from({ length: 72 }, (_, i) => f(i % 9, Math.floor(i / 9)));
  const a = dhash(ramp((x, y) => (x * 31 + y * 17) % 97));
  const b = dhash(ramp((x, y) => ((x * 31 + y * 17) % 97) + 12)); // the same picture, brighter
  const b2 = dhash(ramp((x, y) => ((x * 31 + y * 17) % 97) * 1.1)); // more contrast
  const noisy = dhash(ramp((x, y) => ((x * 31 + y * 17) % 97) + ((x * 7 + y * 3) % 3) - 1)); // a grey level of noise either way
  const c = dhash(ramp((x, y) => (y * 53 + x * 7) % 89));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.strictEqual(hamming(a, b), 0, 'brighter: the same fingerprint');
  assert.ok(hamming(a, b2) <= 4 && hamming(a, noisy) <= 4, `more contrast ${hamming(a, b2)}, noise ${hamming(a, noisy)} bits`);
  assert.strictEqual(dhash([0, 2, ...Array(70).fill(0)]), '0000000000000000', 'differences of 3 grey levels or less are flat');
  assert.strictEqual(dhash([0, 4, ...Array(70).fill(0)]), '8000000000000000');
  assert.ok(hamming(a, c) > 12, `another picture: far apart (${hamming(a, c)})`);
  assert.strictEqual(hamming('ffffffffffffffff', '0000000000000000'), 64);
  assert.ok(usableHash(a));
  assert.ok(!usableHash(dhash(ramp(() => 128))), 'a flat picture');
  assert.ok(!usableHash('xyz'));
});

test('rivalsOf: other live stores with the same item, by words, supplier photo or look; new ones, names, TikTok shops', () => {
  const now = NOW;
  const it = (key, store, title, o = {}) => ({ key, store, title, img: '', first: new Date(now - 30 * DAY).toISOString(), live: true, tracked: false, ...o });
  const h = '0f0f0f0f33cc33cc';
  const near = '0f0f0f0f33cc33c3'; // 4 bits apart
  const far = '0f0f0f0f33cc3c03'; // 10 bits apart
  const items = [
    it('w|me', 'me.test', 'Bladeless Neck Fan', { tracked: true, img: `https://cdn.shopify.com/s/files/1/${SUPPLIER}.jpg`, hash: h }),
    it('w|a', 'a.test', 'Portable Neck Fan Bladeless USB', { first: new Date(now - 3 * DAY).toISOString() }),
    it('w|a2', 'a.test', 'Neck Fan Bladeless', { first: new Date(now - 40 * DAY).toISOString() }), // the same store twice: one rival, its first day
    it('w|b', 'b.test', 'Personal Cooler', { img: `https://cdn.shopify.com/s/files/2/${SUPPLIER}_800x.jpg` }),
    it('w|c', 'c.test', 'Hals Ventilator', { hash: near }),
    it('w|d', 'd.test', 'Ventilateur de cou', { hash: far }),
    it('w|own', 'me.test', 'Bladeless Neck Fan 2', {}), // the same store: no rival
    it('w|dead', 'e.test', 'Bladeless Neck Fan', { live: false }), // stopped selling
    it('tiktok|1', 'tiktok:fan shop', 'Neck Fan Bladeless Hanging Rechargeable', { first: '' }),
  ];
  const r = rivalsOf(items, { now }).get('w|me');
  assert.deepStrictEqual({ r: r.r, rn: r.rn, rt: r.rt, how: r.how }, { r: 4, rn: 0, rt: 1, how: { words: 2, supplier: 1, look: 1 } }, 'a.test, b.test, c.test and the TikTok shop');
  assert.deepStrictEqual(r.rs, ['b.test', 'c.test', 'a.test'], 'up to three, the newest first (a.test\'s first day is its oldest product\'s)');
  const fresh = rivalsOf(items.filter((x) => x.key !== 'w|a2'), { now }).get('w|me');
  assert.deepStrictEqual({ rn: fresh.rn, first: fresh.rs[0] }, { rn: 1, first: 'a.test' }, 'first seen 3 days ago: a new rival, named first');
  assert.ok(!rivalsOf(items, { now }).has('w|a'), 'only the items asked about (tracked)');
  // A fingerprint shared by many photos (a placeholder) finds nobody.
  const many = Array.from({ length: 30 }, (_, i) => it('p|' + i, `p${i}.test`, 'Thing ' + i, { hash: h, tracked: i === 0 }));
  assert.strictEqual(rivalsOf(many, { now }).get('p|0').r, 0);
  // White backgrounds: 300 photos share their top rows (no edges there). A look-alike still meets through a rarer row,
  // and the common rows do not make every photo a candidate of every other (that took 40 s for 8,000 products).
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  const white = Array.from({ length: 300 }, (_, i) => it('wb|' + i, `wb${i}.test`, 'Item ' + i, { hash: '000000' + hex(Math.imul(i + 1, 2654435761)) + 'a5', tracked: i === 0 }));
  white.push(it('wb|copy', 'copy.test', 'Gadget', { hash: white[0].hash.slice(0, 14) + (0xa5 ^ 0b111).toString(16) }));
  const t0 = Date.now();
  const got = rivalsOf(white, { now }).get('wb|0');
  assert.deepStrictEqual({ r: got.r, look: got.how.look }, { r: 1, look: 1 }, 'the copy, 3 bits apart');
  assert.ok(Date.now() - t0 < 1000);
});

// ---------------------------------------------------------------------------
// Google Trends through SerpApi
// ---------------------------------------------------------------------------
const weeks = (values, { partial = false } = {}) => ({ interest_over_time: { timeline_data: values.map((v, i) => ({ date: 'w' + i, timestamp: String(Date.UTC(2025, 10, 2) / 1000 + i * 7 * 86400), values: [{ query: 'q', value: String(v), extracted_value: v }] }))
  .concat(partial ? [{ date: 'now', timestamp: String(Date.UTC(2026, 10, 1) / 1000), partial_data: true, values: [{ extracted_value: 0 }] }] : []) } });

test('trendsQuery, trendsUrl and trendsOf: three words, the market, and the answer in a few numbers', () => {
  assert.strictEqual(trendsQuery('【Hot】 Glowify Bladeless Neck Fan 4000mAh (2 pack)', 'glowify.com'), 'bladeless neck fan');
  assert.strictEqual(trendsQuery('New Dog Harness No-Pull'), 'dog harness no-pull');
  const u = new URL(trendsUrl('neck fan', 'AU', 'k3y'));
  assert.deepStrictEqual([u.host, u.searchParams.get('engine'), u.searchParams.get('q'), u.searchParams.get('geo'), u.searchParams.get('date'), u.searchParams.get('api_key')], ['serpapi.com', 'google_trends', 'neck fan', 'AU', 'today 12-m', 'k3y']);
  assert.strictEqual(new URL(trendsUrl('x', 'ALL', 'k')).searchParams.get('geo'), null, 'no market: worldwide');
  // 52 weeks: low in the winter, a peak in the summer, rising the last month.
  const year = Array.from({ length: 52 }, (_, i) => (i === 36 ? 100 : i >= 48 ? 40 : i >= 44 ? 20 : 10));
  const t = trendsOf(weeks(year, { partial: true }));
  assert.deepStrictEqual({ ch: t.ch, yoy: t.yoy, now: t.now, n: t.s.length }, { ch: 100, yoy: 300, now: 40, n: 13 }, 'the last 4 full weeks against the 4 before; the partial week left out');
  assert.strictEqual(t.pk, new Date(Date.UTC(2025, 10, 2) + 36 * 7 * DAY).getUTCMonth() + 1, 'the month of the peak');
  assert.strictEqual(trendsOf(weeks([1, 2, 3])), null, 'too few weeks');
  assert.strictEqual(trendsOf({ error: 'x' }), null);
});

test('askTrends: SerpApi\'s answer, too few searches, and errors that stop the run; the key only goes to SerpApi', async () => {
  const item = { title: 'Bladeless Neck Fan', store: 'fan.test', geo: 'AU' };
  const asked = [];
  const ok = await askTrends(item, { key: 'SECRET', now: () => NOW, doFetch: async (url) => { asked.push(url); return json(weeks(Array.from({ length: 12 }, (_, i) => (i < 8 ? 10 : 15)))); } });
  assert.strictEqual(new URL(asked[0]).host, 'serpapi.com');
  assert.deepStrictEqual({ q: ok.q, geo: ok.geo, ch: ok.ch }, { q: 'bladeless neck fan', geo: 'AU', ch: 50 });
  const none = await askTrends(item, { key: 'SECRET', now: () => NOW, doFetch: async () => json({ error: "Google Trends hasn't returned any results for this query." }) });
  assert.strictEqual(none.none, 1, 'no results is an answer: too few searches');
  const out = await askTrends(item, { key: 'SECRET', now: () => NOW, doFetch: async () => json({ error: 'Your account has run out of searches.' }, 429) });
  assert.deepStrictEqual([out.stop, /SECRET/.test(JSON.stringify(out))], [true, false], 'out of searches: stop; the key is nowhere in the answer');
  const down = await askTrends(item, { key: 'SECRET', now: () => NOW, doFetch: async () => { throw new Error('ECONNRESET SECRET'); } });
  assert.deepStrictEqual([down.error, /SECRET/.test(JSON.stringify(down))], ['network', false]);
});

// ---------------------------------------------------------------------------
// The scoring the board ranks with (worker/src/momentum.mjs)
// ---------------------------------------------------------------------------
test('scoreOf / crowdOf / factorOf: shared-out weights, new ads only next to a real trend, crowding, the ranking factor', () => {
  assert.deepStrictEqual(scoreOf({ c: { ads: 0.6, rank: 0.2, fresh: 0.5 } }), { m: 0.45, label: 'up', used: ['ads', 'rank', 'fresh'] }, '(0.6×0.35 + 0.2×0.25 + 0.5×0.15) / 0.75 = 0.447');
  assert.strictEqual(scoreOf({ c: { ads: -0.5 } }).label, 'down');
  assert.strictEqual(scoreOf({ c: { ads: 0.1 } }).label, 'flat');
  assert.deepStrictEqual(scoreOf({ c: { fresh: 1 } }), { m: 0, label: 'new', used: [] }, 'new ads alone: no trend yet');
  assert.deepStrictEqual(scoreOf({ c: {}, stop: 1 }), { m: -1, label: 'stopped', used: [] });
  assert.deepStrictEqual([crowdOf({ r: 1 }), crowdOf({ r: 2 }), crowdOf({ r: 1, rn: 2 }), crowdOf({ r: 5 }), crowdOf(null)], [0, 1, 1, 2, 0]);
  assert.deepStrictEqual(factorOf(null), { x: 1, why: [] }, 'no summary: the order stays');
  assert.deepStrictEqual(factorOf({ c: { fresh: 1 }, r: 0 }), { x: 1, why: [] }, 'no trend yet and not crowded: the order stays');
  assert.deepStrictEqual(factorOf({ c: { ads: 1 }, r: 6 }), { x: 0.975, why: [{ text: 'Rising +1.00', x: 1.3 }, { text: 'Crowded', x: 0.75 }] });
  assert.strictEqual(factorOf({ c: {}, stop: 1 }).x, 0.7, 'stopped: × 0.7');
  assert.strictEqual(Object.values(WEIGHTS).every((w) => w > 0 && w <= 0.5), true);
  const card = cardOf({ c: { ads: 1 }, r: 2 });
  assert.deepStrictEqual([card.m, card.l, card.cl, card.x], [1, 'up', 1, 1.17]);
});

test('/momentum.js runs the same kit in the browser: same scores, sparklines without style attributes, data escaped', () => {
  const ctx = { window: {}, document: { currentScript: null }, dispatchEvent: () => {}, CustomEvent: class {} };
  vm.runInNewContext(MOMENTUM_JS.replace('window.MOMENTUM.install();', ''), ctx);
  const K = ctx.window.MOMENTUM;
  const plain = (x) => JSON.parse(JSON.stringify(x)); // objects from the other realm
  for (const mo of [{ c: { ads: 0.6, rank: -0.2 }, r: 3 }, { c: { sold: 0.9 }, r: 6, rn: 1 }, { c: {}, stop: 1 }]) assert.deepStrictEqual(plain(K.factorOf(mo)), factorOf(mo));
  const svg = K.spark([3, null, 4, 9]);
  assert.match(svg, /^<svg class="msp"[^>]*aria-hidden="true"><polyline points="1\.5,14\.5 36\.8,12\.3 54\.5,1\.5"/, 'one line through the days it has, the missing day skipped at its place in time');
  assert.doesNotMatch(svg, /style=/);
  assert.strictEqual(K.spark([5]), '', 'one point: no line');
  const evil = '<img src=x onerror=alert(1)>';
  const html = K.row({ mo: cardOf({ c: { ads: 1 }, r: 3, rs: [evil], g: { q: evil, ch: 10 }, sv: 40 }) }, true) + K.row({ mo: cardOf({ c: { ads: 1 }, r: 3, rs: [evil] }) });
  assert.ok(!html.includes('<img'), 'store names and search words never become HTML');
  assert.match(html, /Ranks it × 1\.17 in the Inbox: Rising \+1\.00 × 1\.3 · Getting crowded × 0\.9/);
  assert.strictEqual(K.row({ mo: null }), '');
  assert.strictEqual(K.row({ mo: cardOf({ c: {}, h: 1 }) }), '', 'no trend yet, no rivals, no survival: nothing on a small card');
});

// ---------------------------------------------------------------------------
// The job, on an in-memory D1
// ---------------------------------------------------------------------------
test('the job: rising, falling, steady and stopped products, rivals by words and supplier photo, TikTok sales, after four runs', async () => {
  const env = await momentumEnv();
  const parts = env.db.prepare("SELECT key, body FROM momentum WHERE key LIKE 'board:%' OR key LIKE 'tiktok:%' ORDER BY key").all();
  const all = Object.assign({}, ...parts.map((p) => JSON.parse(p.body).p));
  const label = (k) => scoreOf(all[k]).label;
  assert.deepStrictEqual([label(RISER), label(FALLER), label(STEADY), label(GONE)], ['up', 'down', 'flat', 'stopped']);
  const r = all[RISER];
  assert.deepStrictEqual({ sm: r.sm, d: r.d, sv: r.sv, sl: r.sl, h: r.h, f: r.f }, { sm: 'ads', d: [3, 11, 8], sv: 69, sl: 2, h: 4, f: d(8) }, 'ads 3 → 11 in 8 days; its oldest ad survived 69 days');
  assert.deepStrictEqual(r.s, [3, null, null, 6, null, null, 9, null, 11], 'one value a day since the first run');
  assert.deepStrictEqual({ r: r.r, rn: r.rn, rs: r.rs }, { r: 3, rn: 1, rs: ['rival-one.test', 'rival-three.test', 'rival-two.test'] }, 'two by words (one new this week), one by the supplier\'s photo');
  assert.ok(r.c.rank > 0.5 && r.c.ads === 1 && r.c.fresh === 1, JSON.stringify(r.c));
  assert.ok(all[FALLER].c.rank < 0 && all[FALLER].c.ads < 0, 'fewer ads, out of the store\'s top 50');
  assert.deepStrictEqual([label('tiktok|' + TT_UP), label('tiktok|' + TT_DOWN)], ['up', 'down'], 'TikTok: selling faster and faster; hardly selling');
  assert.strictEqual(all['tiktok|' + TT_UP].v, 4800, '24,000 sold in the 5 days between the last two imports');
  const eu = Object.entries(all).filter(([k]) => k.startsWith('eu|'));
  assert.ok(eu.length > 20 && eu.every(([, mo]) => scoreOf(mo).label === 'new' && mo.same), 'the EU board was not hunted: no trend, and it says since when');
  assert.deepStrictEqual(env.records.map((x) => x.days), [1, 2, 3, 4]);
  assert.strictEqual(env.records[3].trends.off, true, 'no SERPAPI_KEY: no Google Trends');
  assert.strictEqual(env.records[3].photos.off, true, 'no browser: no photo fingerprints');
});

test('the job writes little: one row a day (a second run that day replaces it), a few summary rows; old days and stale parts go', async () => {
  const env = await momentumEnv();
  const days = () => env.db.prepare('SELECT day, part FROM momentum_daily ORDER BY day, part').all().map((x) => `${x.day}/${x.part}`);
  assert.deepStrictEqual(days(), [d(8), d(5), d(2), d(0)].map((x) => x + '/0'), 'one row for each day it ran');
  env.db.prepare("INSERT INTO momentum_daily (day, part, body) VALUES ('2026-01-01', 0, '{}'), (?, 1, '{}')").run(d(0)); // too old; a part today will not write again
  env.db.prepare("INSERT INTO momentum (key, body) VALUES ('board:07', '{\"p\":{\"world|old\":{}}}')").run();
  const rest = d1Rest(env.db);
  const client = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: rest.doFetch, retryMs: 0 });
  env.db.prepare("UPDATE world_products SET ads = 30 WHERE product_key = 'riser.test/products/neck-fan'").run();
  await run({ db: client, now: () => NOW + 3600e3, log: () => {} });
  assert.deepStrictEqual(days(), [d(8), d(5), d(2), d(0)].map((x) => x + '/0'), 'the second run today replaced its row; the 120-day-old row and the extra part are gone');
  const today = JSON.parse(env.db.prepare('SELECT body FROM momentum_daily WHERE day = ?').get(d(0)).body);
  assert.strictEqual(today[RISER].a, 30, 'with the new numbers');
  assert.strictEqual(env.db.prepare("SELECT COUNT(*) AS n FROM momentum WHERE key = 'board:07'").get().n, 0, 'a stale summary part is gone');
  const writes = rest.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.body.sql));
  assert.ok(writes.length <= 6, `${writes.length} write queries for ${Object.keys(today).length} products`);
  assert.ok(writes.every((c) => /momentum/.test(c.body.sql)), 'it only writes its own tables');
  const history = rest.calls.filter((c) => /FROM momentum_daily/.test(c.body.sql) && /^\s*SELECT/i.test(c.body.sql));
  assert.strictEqual(history.length, 1, 'the history in one query: a row a day, not a row per product');
  // The history view gives a product's days for questions.
  const rows = env.db.prepare('SELECT day, ads, rivals FROM momentum_history WHERE product_key = ? ORDER BY day').all(RISER).map((x) => [x.day, x.ads, x.rivals]);
  assert.deepStrictEqual(rows, [[d(8), 3, 3], [d(5), 6, 3], [d(2), 9, 3], [d(0), 30, 3]]);
});

test('photo fingerprints: made in the browser once per photo, kept, an unreadable photo tried again after a week; a look-alike is a rival', async () => {
  const env = await seededEnv();
  const put = (key, title, img) => env.db.prepare("INSERT INTO world_products (product_key, ad_id, active, product_title, image_url, store_url, product_url, markets, ads, new14, first_seen, last_seen) VALUES (?, ?, 1, ?, ?, ?, ?, '{\"AU\":{\"ads\":2}}', 2, 1, ?, ?)")
    .run(key, 'w' + key.length + title.length, title, img, `https://${key.split('/')[0]}/`, `https://${key}`, new Date(NOW - 20 * DAY).toISOString(), new Date(NOW).toISOString());
  put('one.test/products/a', 'Bladeless Neck Fan', 'https://cdn.shopify.com/s/files/1/a.jpg');
  put('two.test/products/b', 'Hals Ventilator Ohne Flügel', 'https://cdn.shopify.com/s/files/1/b.jpg'); // German: no words in common
  put('three.test/products/c', 'Garden Hose', 'https://cdn.shopify.com/s/files/1/broken.jpg');
  const photos = [];
  const doFetch = async (url) => {
    if (/cdn\.shopify\.com/.test(url)) {
      photos.push(url);
      return /broken/.test(url) ? new Response('nope', { status: 404 }) : new Response(Buffer.from('fake-jpeg-' + url), { headers: { 'content-type': 'image/jpeg' } });
    }
    return d1.doFetch(url, arguments[1]);
  };
  const d1 = d1Rest(env.db);
  const client = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1.doFetch, retryMs: 0 });
  let hashed = 0;
  const hasher = async (list) => list.map((x) => { hashed++; return { k: x.k, h: /\/a\.jpg/.test(Buffer.from(x.b64, 'base64').toString()) ? '0f0f0f0f33cc33cc' : /\/b\.jpg/.test(Buffer.from(x.b64, 'base64').toString()) ? '0f0f0f0f33cc33c3' : 'ffff0000ffff0000' }; });
  const first = await run({ db: client, now: () => NOW, log: () => {}, hasher, doFetch });
  assert.ok(photos.every((u) => new URL(u).searchParams.get('width') === '100'), 'Shopify photos asked for 100 px wide');
  assert.ok(first.photos.hashed >= 2 && first.photos.failed >= 1, JSON.stringify(first.photos));
  const p = JSON.parse(env.db.prepare("SELECT body FROM momentum WHERE key = 'board:00'").get().body).p;
  assert.deepStrictEqual({ r: p['world|one.test/products/a'].r, rs: p['world|one.test/products/a'].rs }, { r: 1, rs: ['two.test'] }, 'the same photo under a German title: a rival');
  const before = hashed;
  const asked = photos.length;
  const again = await run({ db: client, now: () => NOW + DAY, log: () => {}, hasher, doFetch });
  assert.deepStrictEqual([hashed - before, photos.length - asked, again.photos.hashed], [0, 0, 0], 'the next day: nothing fingerprinted or fetched again');
  await run({ db: client, now: () => NOW + 8 * DAY, log: () => {}, hasher, doFetch });
  assert.ok(photos.slice(asked).some((u) => /broken/.test(u)), 'an unreadable photo is tried again after a week');
  // hashPhotos: a browser that answers for only some photos marks the rest unreadable, and the deadline stops it.
  const got = await hashPhotos([{ key: 'k1', img: 'https://cdn.shopify.com/s/files/1/x.jpg' }, { key: 'k2', img: 'https://cdn.shopify.com/s/files/1/y.jpg' }], { hasher: async (l) => [{ k: l[0].k, h: '0123456789abcdef' }], doFetch });
  assert.deepStrictEqual([...got], [['k1', '0123456789abcdef'], ['k2', '']]);
  assert.strictEqual((await hashPhotos([{ key: 'k', img: 'https://cdn.shopify.com/a.jpg' }], { hasher, doFetch, now: () => 2, deadline: 1 })).size, 0);
});

test('Google Trends in the job: off without a key; with one only shortlisted products, at most TRENDS_MAX, again after TRENDS_DAYS', async () => {
  const env = await momentumEnv();
  const d1 = d1Rest(env.db);
  const client = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1.doFetch, retryMs: 0 });
  // Shortlisted: a launch card (pinned), an approved product (the gone one, from the fixture), a TikTok approval, a star.
  env.db.prepare("INSERT INTO launches (product_key, title, facts, steps, pinned, created_at, updated_at) VALUES (?, 'x', '{}', '{}', 1, ?, ?)").run(RISER, new Date(NOW).toISOString(), new Date(NOW).toISOString());
  env.db.prepare("UPDATE tiktok_products SET decision = 'approved', decided_at = ? WHERE id = ?").run(new Date(NOW).toISOString(), TT_UP);
  env.db.prepare("INSERT INTO stars (ad_id, at) VALUES ('2003', ?)").run(new Date(NOW).toISOString());
  const asked = [];
  const doFetch = async (url, init) => {
    if (String(url).startsWith('https://serpapi.com/')) {
      asked.push(new URL(url).searchParams.get('q'));
      return json(weeks(Array.from({ length: 12 }, (_, i) => (i < 8 ? 20 : 30))));
    }
    return d1.doFetch(url, init);
  };
  const logs = [];
  const one = await run({ db: client, now: () => NOW + 3600e3, log: (m) => logs.push(m), doFetch, serpKey: 'SECRET', trendsMax: 2 });
  assert.deepStrictEqual(asked, ['bladeless neck fan', 'old gadget holder'], 'the launch pin first, then the approved product; at most 2');
  assert.deepStrictEqual([one.trends.asked, one.trends.ok], [2, 2]);
  const p = JSON.parse(env.db.prepare("SELECT body FROM momentum WHERE key = 'board:00'").get().body).p;
  assert.deepStrictEqual({ q: p[RISER].g.q, geo: p[RISER].g.geo, ch: p[RISER].g.ch, c: p[RISER].c.trends }, { q: 'bladeless neck fan', geo: 'AU', ch: 50, c: 1 }, 'its biggest market (10 ads in AU, 1 in NZ); +50% in 4 weeks');
  await run({ db: client, now: () => NOW + 2 * 3600e3, log: () => {}, doFetch, serpKey: 'SECRET', trendsMax: 2 });
  assert.deepStrictEqual(asked.slice(2), ['magnetic phone holder', 'cooling dog mat'], 'the next run asks the rest of the shortlist');
  await run({ db: client, now: () => NOW + 3 * 3600e3, log: () => {}, doFetch, serpKey: 'SECRET', trendsMax: 5 });
  assert.strictEqual(asked.length, 4, 'all fresh: nothing asked again before TRENDS_DAYS');
  await run({ db: client, now: () => NOW + 15 * DAY, log: () => {}, doFetch, serpKey: 'SECRET', trendsMax: 5, trendsDays: 14 });
  assert.strictEqual(asked.length, 8, 'after 14 days: asked again');
  assert.ok(!logs.join('\n').includes('SECRET'), 'the key is never in the log');
  const off = await run({ db: client, now: () => NOW + 16 * DAY, log: () => {}, doFetch, serpKey: '' });
  assert.deepStrictEqual([off.trends.off, asked.length], [true, 8]);
});

// ---------------------------------------------------------------------------
// The board: what it reads, how it ranks, what it sends
// ---------------------------------------------------------------------------
test('the board: each card gets its summary; the Momentum sort and the Inbox rank with it; no summary, no change', async () => {
  const plain = await seededEnv();
  const p0 = await login(plain);
  const before = await p0.get('/api/ads?view=inbox&limit=100');
  assert.ok(before.ads.every((a) => a.mo === null), 'before the first run: no summaries');
  const env = await momentumEnv();
  const s = await login(env);
  const world = await s.get('/api/ads?scope=world&view=all&limit=100');
  const byTitle = Object.fromEntries(world.ads.map((a) => [a.title, a]));
  assert.deepStrictEqual([byTitle['Bladeless Neck Fan'].mo.l, byTitle['Sunset Projection Lamp'].mo.l, byTitle['Cooling Dog Mat'].mo.l], ['up', 'down', 'flat']);
  assert.ok(byTitle['Bladeless Neck Fan'].mo.x > 1 && byTitle['Sunset Projection Lamp'].mo.x < 1);
  const mom = (await s.get('/api/ads?scope=world&view=all&sort=mom&limit=100')).ads.map((a) => a.title);
  assert.strictEqual(mom[0], 'Bladeless Neck Fan', 'rising and only getting crowded: first');
  assert.strictEqual(mom[mom.length - 1], 'Sunset Projection Lamp', 'falling: last');
  const inbox = (await s.get('/api/ads?scope=world&view=inbox&limit=100')).ads.map((a) => a.title);
  assert.strictEqual(inbox[0], 'Bladeless Neck Fan', 'the Inbox outside the EU: (proof + 1) × momentum');
  const order = (await s.get('/api/ads?view=inbox&limit=100')).ads.map((a) => a.id);
  assert.deepStrictEqual(order, (await p0.get('/api/ads?view=inbox&limit=100')).ads.map((a) => a.id), 'EU products without a trend (× 1) keep the Inbox order');
  // A rising EU product moves up the Inbox; a crowded one down (summaries written as the job writes them).
  const eu = Object.fromEntries((await s.get('/api/ads?view=all&limit=100')).ads.map((a) => [a.title, a]));
  assert.ok(Object.values(eu).every((a) => a.mo && a.mo.l === 'new' && a.mo.same), 'EU: no new numbers, and since when');
  // The Inbox ranks by reach a day × the factor (at most × 1.3, at least × 0.7 × 0.75): it moves neighbours, it does
  // not lift the weakest product over the strongest. 9024 (2,000 a day) rising × 1.3 passes 9023 (2,385); 9000 (10,000)
  // falling and crowded × 0.525 drops below every product from 5,250 a day up.
  const rpd = Object.fromEntries((await s.get('/api/ads?view=inbox&limit=100')).ads.map((a) => [a.id, a.rpd]));
  assert.ok(rpd['9023'] > rpd['9024'] && rpd['9024'] * 1.3 > rpd['9023'] && order.indexOf('9023') + 1 === order.indexOf('9024'), 'neighbours the factor can swap');
  const env2 = await momentumEnv();
  const parts = JSON.parse(env2.db.prepare("SELECT body FROM momentum WHERE key = 'board:00'").get().body);
  const keyOf = (id) => env2.db.prepare("SELECT 'eu|' || COALESCE(advertiser_page_id, '') || '|' || lower(trim(COALESCE(NULLIF(product_title, ''), ad_id))) AS k FROM winners WHERE ad_id = ?").get(id).k;
  assert.ok(parts.p[keyOf('9024')] && parts.p[keyOf('9000')], 'the job wrote them under the board\'s EU key');
  parts.p[keyOf('9024')] = { h: 9, f: d(8), c: { ads: 1, reach: 1 }, sm: 'ads', s: [3, 9], d: [3, 9, 8] };
  parts.p[keyOf('9000')] = { h: 9, f: d(8), c: { ads: -1 }, r: 7, sm: 'ads' };
  env2.db.prepare("UPDATE momentum SET body = ? WHERE key = 'board:00'").run(JSON.stringify(parts));
  const s2 = await login(env2);
  const moved = (await s2.get('/api/ads?view=inbox&limit=100')).ads;
  const at = (id) => moved.findIndex((a) => a.id === id);
  assert.ok(at('9024') < at('9023'), 'rising: ahead of the product it trailed');
  const below = order.filter((id) => rpd[id] >= 0.525 * rpd['9000'] && id !== '9000');
  assert.strictEqual(at('9000'), below.length, `falling and crowded: behind the ${below.length} products from ${0.525 * rpd['9000']} a day up`);
  assert.deepStrictEqual(moved[at('9024')].mo.why, [{ text: 'Rising +1.00', x: 1.3 }], 'the card says why it moved');
  assert.strictEqual((await s2.get('/api/ads?view=all&sort=nope&limit=3')).ads.length, 3, 'an unknown sort is the default');
});

test('D1 reads: the summaries come in one query of a few rows with the board\'s tables, not one row per product; read again only with them', async () => {
  const env = await momentumEnv();
  // A big board: 5,000 summaries more, as the job writes them (parts of at most 400 KB).
  const big = new Map(Array.from({ length: 5000 }, (_, i) => [`world|s${i}.test/products/p${i}`, { h: 20, f: d(19), c: { ads: 0.3, fresh: 0.5 }, sm: 'ads', s: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], d: [5, 14, 7], r: 1, rs: [`r${i}.test`], sv: 40 }]));
  const real = JSON.parse(env.db.prepare("SELECT body FROM momentum WHERE key = 'board:00'").get().body).p;
  for (const [k, v] of Object.entries(real)) big.set(k, v);
  env.db.prepare("DELETE FROM momentum WHERE key LIKE 'board:%'").run();
  for (const part of partsOf('board', big)) env.db.prepare('INSERT INTO momentum (key, body) VALUES (?, ?)').run(part.key, part.body);
  const n = env.db.prepare("SELECT COUNT(*) AS n FROM momentum WHERE key LIKE 'board:%'").get().n;
  assert.ok(n >= 2 && n <= 4, `${n} rows for 5,000+ products`);
  const s = await login(env);
  const reads = () => env.DB.log.filter((l) => l.sql === PARTS_SQL);
  await s.get('/api/ads?scope=world&view=all');
  await s.get('/api/ads?scope=world&view=all&sort=mom');
  await s.get('/api/ads?view=inbox');
  await s.get('/api/markets?scope=world');
  assert.strictEqual(reads().length, 1, 'one read with the tables, kept with them');
  assert.ok(env.db.prepare(PARTS_SQL).all('board:', 'board;').length === n, 'the range on the primary key reads only those rows');
  const plan = env.db.prepare('EXPLAIN QUERY PLAN ' + PARTS_SQL).all('board:', 'board;').map((r) => r.detail).join(' ');
  assert.match(plan, /SEARCH momentum USING INDEX sqlite_autoindex_momentum_1 \(key>\? AND key<\?\)/, 'an index range, not a scan of the table');
  env.db.prepare("UPDATE state SET updated_at = '2026-10-17T09:00:00.000Z' WHERE key = 'last_run'").run(); // a run saved: the board reads its tables again
  await s.get('/api/ads');
  assert.strictEqual(reads().length, 2, 'read again with the tables, not more often');
  // TikTok and the panel: their own small reads.
  const tt = await s.get('/api/momentum?scope=tiktok');
  assert.deepStrictEqual([tt.items[TT_UP].l, tt.items[TT_DOWN].l], ['up', 'down']);
});

test('the board without the momentum table works as before; a failing read is not kept', async () => {
  const env = await seededEnv();
  env.db.exec('DROP TABLE momentum');
  const s = await login(env);
  const res = await s.call('/api/ads?view=all');
  assert.strictEqual(res.status, 200, 'a test link before the merge: no table yet');
  assert.ok((await res.json()).ads.every((a) => a.mo === null));
  assert.strictEqual((await s.call('/api/momentum?scope=tiktok')).status, 200);
  const env2 = await momentumEnv();
  const s2 = await login(env2);
  const prepare = env2.DB.prepare;
  let fail = true;
  env2.DB.prepare = (sql) => (fail && sql === PARTS_SQL ? { bind: () => ({ all: async () => { fail = false; throw new Error('D1 hiccup'); } }) } : prepare(sql));
  assert.strictEqual((await s2.call('/api/ads?scope=world&view=all')).status, 500, 'a D1 error is not hidden as "no momentum" for 15 minutes');
  const ok = await s2.get('/api/ads?scope=world&view=all');
  assert.ok(ok.ads.some((a) => a.mo && a.mo.l === 'up'), 'read again on the next request');
});

test('/api/momentum and /momentum.js: logged in only, GET only; the panel counts the open products of a tab', async () => {
  const env = await momentumEnv();
  const anon = await handle(new Request(ORIGIN + '/api/momentum?scope=world'), env, { now: NOW });
  assert.strictEqual(anon.status, 401);
  assert.strictEqual((await handle(new Request(ORIGIN + '/momentum.js'), env, { now: NOW })).status, 401);
  const s = await login(env);
  const js = await s.call('/momentum.js');
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  assert.match(await js.text(), /window\.MOMENTUM = \(function momentumKit\(\)/);
  assert.strictEqual((await s.call('/api/momentum', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' })).status, 405);
  const w = await s.get('/api/momentum?scope=world');
  assert.deepStrictEqual({ up: w.counts.up, down: w.counts.down, flat: w.counts.flat, busy: w.counts.busy }, { up: 1, down: 1, flat: 4, busy: 3 }, 'the open products outside the EU (the stopped one was approved)');
  assert.deepStrictEqual(w.rising.map((x) => [x.title, x.move]), [['Bladeless Neck Fan', 'ads 3 → 11 in 8d']]);
  assert.deepStrictEqual(Object.keys(w.weights), Object.keys(WEIGHTS));
  assert.strictEqual(w.run.days, 4);
  const e = await s.get('/api/momentum?scope=eu');
  assert.strictEqual(e.counts.new, 27, 'the EU board: no trend yet');
  assert.strictEqual((await s.get('/api/momentum?scope=nonsense')).scope, 'world');
  // The panel's reads: the products in memory and the decisions; not the stars or the feedback.
  const before = env.DB.log.length;
  await s.get('/api/momentum?scope=world');
  const sql = env.DB.log.slice(before).map((l) => l.sql).join('\n');
  assert.match(sql, /FROM hidden/);
  assert.doesNotMatch(sql, /FROM stars|FROM feedback|FROM winners w$/m, 'no stars, no feedback, the tables not read again');
});

test('summaries are found under an EU product\'s advertiser + title key, also where the board groups EU ads by product page', async () => {
  const map = new Map([['eu|501|posture corrector pro', { c: { ads: 1 } }], ['world|a.test/products/x', { c: { ads: -1 } }]]);
  const rows = [{ gk: '501|posture corrector pro' }, { gk: 'shop1.test/products/item-1', jk: '501|posture corrector pro' }, { gk: 'world|a.test/products/x', world: {} }, { gk: '999|other' }];
  attachMomentum(rows, map);
  assert.deepStrictEqual(rows.map((r) => (r.mo ? scoreOf(r.mo).label : null)), ['up', 'up', 'down', null]);
  assert.deepStrictEqual(rows.map(momentumX), [1.3, 1.3, 0.7, 1]);
  assert.deepStrictEqual(await readMomentum({ prepare: () => ({ bind: () => ({ all: async () => ({ results: [{ key: 'board:00', body: 'not json' }, { key: 'board:01', body: JSON.stringify({ p: { k: { c: {} } } }) }] }) }) }) }), new Map([['k', { c: {} }]]), 'a broken part is skipped');
});

test('the workflow: once a day after the last hunt and by hand, read-only, the D1-only token, tables first, SerpApi from a secret', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/momentum.yml', import.meta.url), 'utf8');
  assert.match(wf, /^on:\n  workflow_dispatch:\n  schedule:\n(?:    #.*\n)*    - cron: '43 22 \* \* \*'$/m, 'after the 19:17 hunt, before midnight UTC');
  assert.match(wf, /^permissions:\n  contents: read$/m);
  assert.match(wf, /^      CF_API_TOKEN: \$\{\{ secrets\.CF_D1_TOKEN \|\| secrets\.CF_API_TOKEN \}\}$/m);
  assert.match(wf, /^      SERPAPI_KEY: \$\{\{ secrets\.SERPAPI_KEY \}\}$/m);
  assert.ok(wf.indexOf('node winner-hunter/migrate.mjs') < wf.indexOf('node winner-hunter/momentum.mjs'), 'the tables before the job');
  assert.match(wf, /playwright-core@1\.56\.1/, 'the same Playwright as the hunts');
  assert.match(wf, /- name: Install Playwright\n\s+continue-on-error: true/, 'no browser is no failure');
  const timeout = Number(/timeout-minutes: (\d+)/.exec(wf)[1]);
  const minutes = Number(/MOMENTUM_MINUTES: '(\d+)'/.exec(wf)[1]);
  assert.ok(timeout >= minutes + 8, 'room for the writes after the photos and searches stop');
});

test('itemsOf and historyOf: one list from the three tables; one entry a day per product', () => {
  const items = itemsOf({
    world: [{ product_key: 'a.test/products/x', ad_id: 'w1', active: 0, product_title: 'X', markets: '{"AU":{"ads":1},"NZ":{"ads":4}}', ads: 5, new14: 1, shop_ads: 80, price: 9, product_url: 'https://a.test/products/x' }],
    eu: [{ ad_id: '1', gk: '5|lamp', product_title: 'Lamp', reach_eu: 10000, ad_age_days: 10, scaled_count: 3, active_ads: 90, pass: 1, store_url: 'https://www.l.test/', product_url: 'https://l.test/products/lamp', tc: 'NL 70%, BE 30%', first_seen: '2026-10-01', last_seen: '2026-10-16T10:00:00Z' },
      { ad_id: '2', gk: '5|lamp', product_title: 'Lamp', reach_eu: 5000, ad_age_days: 34, scaled_count: 1, active_ads: 90, pass: 0, store_url: 'https://www.l.test/', first_seen: '2026-09-20', last_seen: '2026-10-10T10:00:00Z' }],
    tiktok: [{ id: '77', title: '【Sale】 Mount', shop: 'Mount Co', sold_us: 900, creators: 4, price_min: 9.5, updated_at: '2026-10-16T10:00:00Z' }],
  }, { best: new Map([['l.test/products/lamp', { ok: 1, rank: 4, checked_at: '2026-10-17T07:00:00Z' }]]), decided: new Set(), now: NOW });
  const [w, e, t] = items;
  assert.deepStrictEqual({ tracked: w.tracked, live: w.live, geo: w.geo, today: w.today }, { tracked: false, live: false, geo: 'NZ', today: { a: 5, s: 80, n: 1, m: 2, p: 9, x: 0 } }, 'inactive, not decided: no summary, no rival');
  assert.deepStrictEqual({ key: e.key, store: e.store, geo: e.geo, sv: e.sv, sl: e.sl, today: e.today }, { key: 'eu|5|lamp', store: 'l.test', geo: 'NL', sv: 34, sl: 1, today: { a: 3, s: 90, e: 1000, b: 4, w: '2026-10-16' } }, 'the best ad\'s numbers, the oldest age');
  assert.deepStrictEqual({ key: t.key, title: t.title, store: t.store, first: t.first, today: t.today }, { key: 'tiktok|77', title: 'Mount', store: 'tiktok:mount co', first: '', today: { o: 900, c: 4, p: 9.5, t: '2026-10-16' } });
  const h = historyOf([{ day: '2026-10-01', body: '{"k":{"a":1}}' }, { day: '2026-10-02', body: 'broken' }, { day: '2026-10-03', body: '{"k":{"a":3},"j":{"a":9}}' }]);
  assert.deepStrictEqual([...h], [['k', [['2026-10-01', { a: 1 }], ['2026-10-03', { a: 3 }]]], ['j', [['2026-10-03', { a: 9 }]]]]);
  assert.deepStrictEqual(splitMap(new Map([['a', 'x'.repeat(50)], ['b', 'y'.repeat(50)]]), 60).length, 2);
  assert.deepStrictEqual(partsOf('board', new Map()).map((p) => p.key), ['board:00'], 'an empty board still writes one part, so old parts go');
  assert.strictEqual(summaryOf({ src: 'world', today: { a: 2 } }, [], { day: d(0) }).h, 1);
});

test('migrations with the job\'s first run in one go: migrate() twice, then the job on an empty database', async () => {
  const dir = new URL('../worker/migrations/', import.meta.url);
  const texts = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(new URL(f, dir), 'utf8'));
  const rest = d1Rest(new DatabaseSync(':memory:'));
  const c = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: rest.doFetch, retryMs: 0 });
  await migrate(c, texts);
  await migrate(c, texts);
  const out = await run({ db: c, now: () => NOW, log: () => {} });
  assert.deepStrictEqual([out.days, out.tracked], [1, { world: 0, eu: 0, tiktok: 0 }]);
  assert.deepStrictEqual(rest.db.prepare('SELECT key FROM momentum ORDER BY key').all().map((r) => r.key), ['board:00', 'images', 'run', 'tiktok:00', 'trends']);
  assert.match(DAILY_SQL, /ON CONFLICT\(day, part\) DO UPDATE/);
});
