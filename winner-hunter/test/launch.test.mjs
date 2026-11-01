// The Launch view (worker/src/launch.mjs, migrations/0015_launch.sql): the table and its one launch pin, the checklist's
// clean-up, the margin and decision helpers (also as /launch.js, the code the board runs) and /api/launch, on an
// in-memory D1 (node:sqlite) with every migration applied.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { handle, tokenFor, productKey } from '../worker/src/app.mjs';
import { STEPS, cleanStep, marginInputs, marginOf, summaryOf, LAUNCH_JS, jevRisks, launchIndex, cardProduct, productFor } from '../worker/src/launch.mjs';
import { statements } from '../lib/d1.mjs';
import { UPSERT_SQL as TIKTOK_UPSERT } from '../lib/tiktok.mjs';
import { memoryDb } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

const ORIGIN = 'https://winner-hunter.example.workers.dev';
const MIGRATION = fs.readFileSync(new URL('../worker/migrations/0015_launch.sql', import.meta.url), 'utf8');
const plain = (r) => (r ? { ...r } : r);
const iso = (ms) => new Date(ms).toISOString();

async function session(env) {
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const call = (path, init = {}, now = NOW) => handle(new Request(ORIGIN + path, { ...init, headers: { cookie, ...init.headers } }), env, { now });
  return {
    get: async (path) => (await call(path)).json(),
    post: (path, body, { now = NOW, headers = {} } = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, now),
    call,
  };
}
const launch = async (s, body, opts) => {
  const res = await s.post('/api/launch', body, opts);
  return { status: res.status, ...(await res.json()) };
};

// Approved products: two on the EU board (✓), one outside the EU and one on the TikTok tab, each a second apart.
// The EU ones by their key on the board (their product page) and by the key their card had before the board grouped
// EU products by product page (advertiser + title), as launch cards saved in production still have it.
const TT_ID = '1700000000000000001';
const POSTURE = 'eu|shop1.test/products/item-1';
const POSTURE_OLD = 'eu|501|posture corrector pro';
const ROLLER = 'eu|shop3.test/products/item-3';
const ROLLER_OLD = 'eu|503|pet hair remover roller';
async function approvedEnv() {
  const env = await seededEnv();
  env.db.prepare(`INSERT INTO world_products (product_key, ad_id, active, product_title, price, currency, image_url, store_url, product_url, ad_library_url, advertiser, page_id, keyword, markets, ads, creatives, days, new14, shop_ads, store_products, first_seen, last_seen)
    VALUES ('strong.test/products/pod', '1001', 1, 'Pillow Pod', 79, 'AUD', 'https://cdn.shopify.com/1001.jpg', 'https://strong.test/', 'https://strong.test/products/pod', 'https://www.facebook.com/ads/library/?id=1001', 'Strong', '77', 'pillow',
    '{"AU":{"ads":9,"days":210,"new14":2},"NZ":{"ads":3,"days":90,"new14":1}}', 12, 4, 210, 3, 89, 12, ?, ?)`).run(iso(NOW - 5 * 864e5), iso(NOW - 3600e3));
  env.db.prepare("INSERT INTO world_checks (product_key, model, input, people, animals, gymwear, physical, category, checked_at, version, main, sub, answers) VALUES ('strong.test/products/pod', 'jev', 'photo', 0.01, 0.01, 0.01, 0.98, 'Home', 'x', 2, 'Home', 'Bedding', ?)")
    .run(JSON.stringify({ p: { people: 0.01, animals: 0.01, gymwear: 0.01, physical: 0.98, electric: 0.9, brand: 0.7 }, choices: {} }));
  await env.DB.prepare(TIKTOK_UPSERT).bind(JSON.stringify([{ id: TT_ID, title: '【Black Friday】 Rhino Straps', shop: 'Rhino Shop', url: 'https://www.tiktok.com/shop/pdp/1', image_url: 'https://cdn.shopify.com/tt1.jpg', price_min: 55.77, price_max: 55.77, rating: 4.6,
    reviews: 120, sold_us: 152000, creators: 5, plays: 1000000, category: 'Car', blockers: 'bulky', meta_status: 'none', meta_url: null, meta_unsure: 0, meta_us: null, meta_au: null, meta_nz: null, updated_at: '2026-10-16T10:00:00Z' }])).run();
  const s = await session(env);
  for (const [i, ad] of ['9001', '9003', '1001'].entries()) assert.strictEqual((await s.post('/api/hide', { ad_id: ad, status: 'seen' }, { now: NOW - 3000 + i * 1000 })).status, 200);
  assert.strictEqual((await s.post('/api/tiktok', { id: TT_ID, decision: 'approved' })).status, 200);
  return { env, s };
}

test('migration 0015: safe to apply again and again; one launch pin at a time; clearing then pinning another works', () => {
  const st = statements(MIGRATION);
  assert.deepStrictEqual(st.map((x) => x.split('(')[0].trim()), ['CREATE TABLE IF NOT EXISTS launches', 'CREATE UNIQUE INDEX IF NOT EXISTS launches_one_pin ON launches'], 'nothing that fails a second time (no ALTER)');
  assert.match(st[1], /WHERE pinned = 1$/, 'a partial index: only pinned rows are in it');
  const fresh = new DatabaseSync(':memory:');
  for (let i = 0; i < 3; i++) for (const x of st) fresh.exec(x);
  const db = memoryDb(); // every migration, this one included
  for (const x of st) db.exec(x);
  const add = db.prepare('INSERT INTO launches (product_key, pinned, decision) VALUES (?, ?, ?)');
  add.run('eu|1|a', 1, null);
  add.run('eu|2|b', null, 'go');
  add.run('world|c.test/products/c', null, null);
  assert.throws(() => add.run('tiktok|4', 1, null), /UNIQUE constraint failed: launches\.pinned/, 'a second launch pin is refused');
  assert.throws(() => db.prepare("UPDATE launches SET pinned = 1 WHERE product_key = 'eu|2|b'").run(), /UNIQUE constraint failed/, 'also by an update');
  assert.throws(() => add.run('tiktok|5', 0, null), /CHECK constraint failed/, 'pinned is 1 or NULL');
  assert.throws(() => add.run('tiktok|6', null, 'maybe'), /CHECK constraint failed/, "a decision is 'go', 'no' or NULL");
  db.exec('BEGIN');
  db.prepare('UPDATE launches SET pinned = NULL WHERE pinned = 1 AND product_key != ?').run('eu|2|b');
  db.prepare('UPDATE launches SET pinned = 1 WHERE product_key = ?').run('eu|2|b');
  db.exec('COMMIT');
  assert.deepStrictEqual(db.prepare('SELECT product_key FROM launches WHERE pinned = 1').all().map((r) => r.product_key), ['eu|2|b']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM launches WHERE pinned IS NULL').get().n, 2, 'any number of cards without the pin');
});

test('cleanStep: only the step’s own fields, valid and filled in; decimal commas, https links, notes up to 1000 characters', () => {
  assert.strictEqual(cleanStep('nope', {}), null);
  assert.strictEqual(cleanStep('__proto__', {}), null);
  assert.deepStrictEqual(cleanStep('margin', null), { done: false, note: '', v: {} });
  assert.deepStrictEqual(cleanStep('sourcing', {
    done: true, note: '  Sample\nordered\u0000 ', extra: 1,
    v: { supplier: 'detail.1688.com/offer/1.html', unit: '8,50', ship: '€ 4.20', moq: '50.4', lead: -3, sample: 'yes', price: 5, junk: 'x' },
  }), { done: true, note: 'Sample\nordered', v: { supplier: 'https://detail.1688.com/offer/1.html', unit: 8.5, ship: 4.2, moq: 50 } }, 'a tick is only true; fields of other steps dropped');
  const url = (x) => cleanStep('research', { v: { comp1: x } }).v.comp1;
  assert.strictEqual(url('http://shop.test/a?b=1'), 'https://shop.test/a?b=1', 'http becomes https');
  assert.strictEqual(url(' https://www.shop.test/products/x '), 'https://www.shop.test/products/x');
  for (const bad of ['javascript:alert(1)', 'not a link', 'ftp://shop.test', 'https://', 'https://nodot', 'data:text/html,x', 'https://' + 'a'.repeat(600) + '.test']) assert.strictEqual(url(bad), undefined, bad);
  const money = (x) => cleanStep('margin', { v: { price: x } }).v.price;
  assert.deepStrictEqual([money('39,95'), money(39.951), money('0'), money('5.')], [39.95, 39.95, 0, 5]);
  for (const bad of ['1,234.56', '1.234,56', '1e3', 'abc', -1, 2e6, '', null, NaN, {}]) assert.strictEqual(money(bad), undefined, String(bad));
  const v = cleanStep('margin', { v: { fees: '2,9', vat: 101, cpa: '12' } }).v;
  assert.deepStrictEqual(v, { fees: 2.9, cpa: 12 }, 'a percentage is 0 to 100');
  assert.deepStrictEqual(cleanStep('research', { v: { position: 'above' } }).v, { position: 'above' });
  assert.deepStrictEqual(cleanStep('research', { v: { position: 'x' } }).v, {});
  const long = cleanStep('creatives', { note: 'n'.repeat(1500), v: { hook1: '  Stop\u0007 scrolling\n now ', hook2: 'h'.repeat(600) } });
  assert.deepStrictEqual([long.note.length, long.v.hook1, long.v.hook2.length], [1000, 'Stop  scrolling  now', 500], 'a control character or a line break in a one-line field is a space');
  assert.deepStrictEqual(STEPS.map((x) => x.k), ['sourcing', 'margin', 'compliance', 'research', 'store', 'creatives', 'launch'], 'the seven steps, in order');
});

test('marginOf: price with VAT, fees on the price; margin before ads, break-even ROAS and CPA, profit at the target CPA', () => {
  // 39.95 incl. 21% VAT = 33.02 net; 3% fees = 1.20; 8.50 + 4.20 cost: 19.12 left = 47.9%; 39.95 / 19.12 = 2.09.
  assert.deepStrictEqual(marginOf({ price: 39.95, cogs: 8.5, ship: 4.2, fees: 3, vat: 21, cpa: 12 }), {
    price: 39.95, vat: 6.93, fees: 1.2, cost: 12.7, contribution: 19.12, pct: 47.9, be_roas: 2.09, be_cpa: 19.12, cpa: 12, profit: 7.12, roas: 3.33,
  });
  assert.deepStrictEqual(marginOf({ price: 30, cogs: 10, ship: 5, fees: 0, vat: 0 }), {
    price: 30, vat: 0, fees: 0, cost: 15, contribution: 15, pct: 50, be_roas: 2, be_cpa: 15, cpa: null, profit: null, roas: null,
  }, 'no target CPA yet: no profit or ROAS at it');
  const loss = marginOf({ price: 10, cogs: 9, ship: 3, fees: 3, vat: 21 });
  // 10 / 1.21 = 8.26 net, − 0.30 fees − 12 cost = −4.04
  assert.deepStrictEqual([loss.contribution, loss.be_roas, loss.be_cpa], [-4.04, null, 0], 'loses money: no break-even ROAS, no room for ads');
  assert.strictEqual(marginOf({ price: 20, cogs: 0, fees: 0, vat: 0 }).contribution, 20, 'a free product is a cost of 0, shipping empty is 0');
  assert.deepStrictEqual([marginOf({ price: 20, cogs: 5, fees: 0, vat: 0, cpa: 0 }).profit, marginOf({ price: 20, cogs: 5, fees: 0, vat: 0, cpa: 0 }).roas], [15, null]);
  for (const m of [{ cogs: 5 }, { price: 20 }, { price: 0, cogs: 5 }, { price: -5, cogs: 1 }, { price: 20, cogs: -1 }, null, undefined]) assert.strictEqual(marginOf(m), null, JSON.stringify(m));
});

test('marginInputs: COGS and shipping come from Sourcing unless the margin step has its own; fees 3% and VAT 21% when empty', () => {
  assert.deepStrictEqual(marginInputs({}), { price: undefined, cogs: undefined, ship: undefined, fees: 3, vat: 21, cpa: undefined });
  assert.deepStrictEqual(marginInputs(undefined), marginInputs({}));
  const steps = { sourcing: { v: { unit: 8.5, ship: 4.2 } }, margin: { v: { price: 39.95, cogs: 9, fees: 0, vat: 0, cpa: 12 } } };
  assert.deepStrictEqual(marginInputs(steps), { price: 39.95, cogs: 9, ship: 4.2, fees: 0, vat: 0, cpa: 12 }, 'a 0 is a value, not empty');
});

test('summaryOf: the decision card: its numbers, red flags first, compliance, delivery, store size, ad age; green when nothing is open', () => {
  const steps = (o = {}) => ({
    sourcing: { done: true, v: { unit: 8.5, ship: 4.2, lead: 8, moq: 10, ...o.sourcing } },
    margin: { done: true, v: { price: 39.95, cpa: 12, ...o.margin } },
    compliance: { done: true, v: { restricted: true, trademark: true, claims: true, ce: true, ...o.compliance } },
    research: { done: false, v: { ...o.research } },
  });
  const clean = summaryOf({ facts: { age: 30, products: 12 }, steps: steps() });
  assert.deepStrictEqual([clean.flags, clean.level, clean.done, clean.of, clean.be_roas, clean.ad_days, clean.store_products], [[], 'green', 3, 7, 2.09, 30, 12]);
  assert.strictEqual(clean.margin.contribution, 19.12);
  assert.strictEqual(clean.kill, 'No sale after €38.24 spent (2× the break-even CPA): stop the ad');
  assert.strictEqual(clean.scale, 'ROAS above 2.09 for 3 days: budget +20%');
  const empty = summaryOf({ facts: {}, steps: {} });
  assert.deepStrictEqual(empty.flags.map((f) => [f.k, f.level]), [['margin', 'amber'], ['compliance', 'amber']]);
  assert.deepStrictEqual([empty.level, empty.done, empty.margin, empty.be_roas, empty.ad_days, empty.kill], ['amber', 0, null, null, null, '']);
  assert.strictEqual(empty.flags[1].text, 'Compliance: 4 of 4 checks open');
  const risky = summaryOf({
    facts: { age: 9, products: 900, risks: [{ k: 'electric', text: 'Battery or electric' }, { k: 'brand', text: 'Brand or copy risk' }] },
    steps: steps({ sourcing: { lead: 20, moq: 100, ship: undefined }, compliance: { ce: false }, research: { position: 'above' }, margin: { cpa: 25 } }),
  });
  assert.deepStrictEqual(risky.flags.map((f) => f.text), ['Brand or copy risk', 'Loses money at your target CPA', 'Battery or electric', 'Shipping cost not filled in', 'Slow delivery: 20 days',
    'MOQ 100: stock bought up front', 'Compliance: 1 of 4 checks open', 'Priced above the competitors', 'Its ads only run 9 days', 'Big store: 900 products'], 'red first, then amber, each in its own order');
  assert.strictEqual(risky.level, 'red');
  assert.deepStrictEqual(summaryOf({ facts: {}, steps: steps({ margin: { price: 15 } }) }).flags.map((f) => [f.k, f.level]), [['loss', 'red']]);
  // 25 / 1.21 = 20.66 net − 0.75 fees − 12.70 cost = 7.21 left: 25 / 7.21 = 3.47
  assert.deepStrictEqual(summaryOf({ facts: {}, steps: steps({ margin: { price: 25, cpa: 5 } }) }).flags.map((f) => f.text), ['Thin margin: break-even ROAS 3.47']);
  assert.strictEqual(summaryOf({ facts: {}, steps: { margin: { done: 'yes' } } }).done, 0, 'done is only true');
  assert.strictEqual(summaryOf(null).level, 'amber', 'nothing known: no crash');
});

test('risk flags from Jev: its rule flags and the blockers it said yes to', () => {
  assert.deepStrictEqual(jevRisks(null), []);
  assert.deepStrictEqual(jevRisks({ flags: ['people', 'face'], p: { electric: 0.9, kids: 0.49, brand: 0.5 } }), [
    { k: 'people', text: 'People take it' }, { k: 'face', text: 'Goes on the face' }, { k: 'electric', text: 'Battery or electric' }, { k: 'brand', text: 'Brand or copy risk' },
  ]);
});

test('/launch.js is the kit on its own: run in a bare context it gives the same answers as the module', () => {
  const ctx = vm.createContext({ window: {}, URL }); // the board and the Worker both have URL
  vm.runInContext(LAUNCH_JS, ctx);
  const K = ctx.window.LAUNCH;
  assert.deepStrictEqual(Object.keys(K), ['STEPS', 'cleanStep', 'marginInputs', 'marginOf', 'summaryOf']);
  const same = (a, b, what) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), what);
  same(K.STEPS, STEPS, 'the checklist');
  const raw = { done: true, note: 'x', v: { supplier: 'aliexpress.com/item/1.html', unit: '8,50', ship: '4.2', lead: '30', moq: '200' } };
  same(K.cleanStep('sourcing', raw), cleanStep('sourcing', raw), 'clean-up');
  const l = { facts: { age: 5, products: 700, risks: [{ k: 'skin', text: 'Cosmetics' }] }, steps: { sourcing: cleanStep('sourcing', raw), margin: { v: { price: 19.95, cpa: 9 } }, research: { v: { position: 'above' } } } };
  same(K.marginOf(K.marginInputs(l.steps)), marginOf(marginInputs(l.steps)), 'margin');
  same(K.summaryOf(l), summaryOf(l), 'decision card, every flag');
  assert.match(LAUNCH_JS, /^'use strict';\nwindow\.LAUNCH = \(function launchKit\(\) \{/);
});

test('/api/launch and /launch.js need the PIN; /launch.js is the kit as a script', async () => {
  const env = await seededEnv();
  const anon = (path, init) => handle(new Request(ORIGIN + path, init), env, { now: NOW });
  assert.strictEqual((await anon('/api/launch')).status, 401);
  assert.strictEqual((await anon('/api/launch?pick=1')).status, 401);
  assert.strictEqual((await anon('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"start":"eu|1|x"}' })).status, 401);
  assert.strictEqual((await anon('/launch.js')).status, 401);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM launches').get().n, 0);
  const s = await session(env);
  const js = await s.call('/launch.js');
  assert.strictEqual(js.status, 200);
  assert.strictEqual(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.strictEqual(js.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(js.headers.get('cache-control'), 'no-store');
  assert.strictEqual(await js.text(), LAUNCH_JS);
  assert.strictEqual((await s.call('/launch.js', { method: 'POST' })).status, 405);
  assert.strictEqual((await s.call('/api/launch', { method: 'PUT' })).status, 405);
  assert.deepStrictEqual(await s.get('/api/launch'), { launches: [] });
  assert.deepStrictEqual(await s.get('/api/launch?pick=1'), { candidates: [] }, 'nothing approved yet');
});

test('/api/launch: a card only for an approved product, with its facts; the first card is the launch pin; starting again changes nothing', async () => {
  const { env, s } = await approvedEnv();
  const pick = (await s.get('/api/launch?pick=1')).candidates;
  assert.deepStrictEqual(pick.map((c) => c.key), [`tiktok|${TT_ID}`, 'world|strong.test/products/pod', ROLLER, POSTURE], 'the last approved first, EU products by product page');
  const [tt, world, , eu] = pick.map((c) => c.facts);
  assert.deepStrictEqual([eu.source, eu.id, eu.title, eu.price, eu.cur, eu.age, eu.shop_ads, eu.rpd, eu.products, eu.approved_at], ['eu', '9001', 'Posture Corrector Pro', 30.95, 'EUR', 11, 81, 8818, null, iso(NOW - 3000)], '97,000 EU reach in 11 days');
  assert.deepStrictEqual([world.source, world.title, world.age, world.products, world.proof.of, world.jev], ['world', 'Pillow Pod', 210, 12, 6, { main: 'Home', sub: 'Bedding' }]);
  assert.deepStrictEqual(world.risks, [{ k: 'electric', text: 'Battery or electric' }, { k: 'brand', text: 'Brand or copy risk' }], "Jev's blockers");
  assert.deepStrictEqual([tt.source, tt.title, tt.sold, tt.price, tt.cur, tt.age, tt.risks], ['tiktok', 'Rhino Straps', 152000, 55.77, 'USD', null, [{ k: 'bulky', text: 'Big or heavy' }]]);

  assert.deepStrictEqual(await launch(s, { start: 'eu|500|linen summer dress' }), { status: 409, error: 'Approve it first' }, 'on the board, not approved (no product page: its advertiser + title is its key)');
  assert.deepStrictEqual(await launch(s, { start: 'eu|shop2.test/products/item-2' }), { status: 409, error: 'Approve it first' });
  assert.deepStrictEqual(await launch(s, { start: 'eu|999|no such product' }), { status: 404, error: 'Unknown product' });
  assert.deepStrictEqual(await launch(s, { start: 'eu|nope.test/products/x' }), { status: 404, error: 'Unknown product' });
  assert.deepStrictEqual(await launch(s, { start: 'tiktok|42' }), { status: 404, error: 'Unknown product' });
  assert.deepStrictEqual(await launch(s, { start: "tiktok|1' OR '1'='1" }), { status: 400, error: 'Bad product' });
  for (const bad of ['', 'shop|1', 'eu|', 42, [POSTURE], 'eu|' + 'x'.repeat(1000)]) assert.strictEqual((await launch(s, { start: bad })).status, 400, JSON.stringify(bad).slice(0, 40));
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM launches').get().n, 0, 'nothing made by a refused start');

  const first = await launch(s, { start: POSTURE }, { now: NOW + 1000 });
  assert.strictEqual(first.status, 200);
  const l = first.launch;
  assert.deepStrictEqual([l.key, l.title, l.pinned, l.decision, l.created_at, l.facts.title, l.facts.age, l.facts.product], [POSTURE, 'Posture Corrector Pro', true, null, iso(NOW + 1000), 'Posture Corrector Pro', 11, 'https://shop1.test/products/item-1'], 'the first card is the launch pin');
  assert.deepStrictEqual(l.steps, {});
  assert.deepStrictEqual(l.summary.flags.map((f) => f.k), ['margin', 'compliance', 'young']);
  const again = await launch(s, { start: POSTURE }, { now: NOW + 5000 });
  assert.deepStrictEqual(again.launch, l, 'starting again keeps the card as it is');
  assert.deepStrictEqual((await launch(s, { start: POSTURE_OLD }, { now: NOW + 5000 })).launch, l, 'also through its old key (a board opened before)');
  const w = (await launch(s, { start: 'world|strong.test/products/pod' }, { now: NOW + 2000 })).launch;
  assert.deepStrictEqual([w.pinned, w.facts.source, w.summary.level], [false, 'world', 'red'], 'one launch pin: the second card is not pinned');
  const t = (await launch(s, { start: `tiktok|${TT_ID}` }, { now: NOW + 3000 })).launch;
  assert.deepStrictEqual([t.pinned, t.title, t.facts.meta], [false, 'Rhino Straps', null]);
  assert.deepStrictEqual((await s.get('/api/launch?pick=1')).candidates.map((c) => c.key), [ROLLER], 'a product with a card is not offered again');
  const list = (await s.get('/api/launch')).launches;
  assert.deepStrictEqual(list.map((x) => [x.key, x.pinned]), [[POSTURE, true], [`tiktok|${TT_ID}`, false], ['world|strong.test/products/pod', false]], 'the launch pin first, then the last touched');
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM launches').get().n, 3, 'one card per product');
  // An approved product taken off ✓ keeps its card: the launch is yours.
  await s.post('/api/hide', { ad_id: '9001', status: 'none' });
  assert.strictEqual((await s.get('/api/launch')).launches.length, 3);
});

test('/api/launch: a step saves on its own, cleaned; the pin moves in one batch; a no-go loses the pin; remove', async () => {
  const { env, s } = await approvedEnv();
  const A = POSTURE;
  const B = 'world|strong.test/products/pod';
  await launch(s, { start: A });
  await launch(s, { start: B });
  const row = (k) => plain(env.db.prepare('SELECT pinned, decision, steps, updated_at FROM launches WHERE product_key = ?').get(k));
  const m = await launch(s, { key: A, step: 'margin', done: true, note: 'Retail 39,95', v: { price: '39,95', cpa: '12', vat: 'lots', junk: 1 } }, { now: NOW + 60e3 });
  assert.strictEqual(m.status, 200);
  assert.deepStrictEqual(m.launch.steps, { margin: { done: true, note: 'Retail 39,95', v: { price: 39.95, cpa: 12 } } });
  const src = await launch(s, { key: A, step: 'sourcing', v: { unit: 8.5, ship: 4.2, supplier: 'javascript:alert(1)' } });
  assert.deepStrictEqual(Object.keys(src.launch.steps).sort(), ['margin', 'sourcing'], 'another step does not wipe the first');
  assert.deepStrictEqual(src.launch.steps.sourcing.v, { unit: 8.5, ship: 4.2 }, 'a link that is not https is not saved');
  assert.strictEqual(src.launch.summary.margin.be_roas, 2.09, 'the summary is worked out with the saved steps');
  assert.deepStrictEqual(src.launch.summary, summaryOf(src.launch));
  assert.deepStrictEqual(JSON.parse(row(A).steps).margin.v, { price: 39.95, cpa: 12 });
  assert.strictEqual(row(A).updated_at, iso(NOW));
  const resave = await launch(s, { key: A, step: 'margin', v: { price: 44 } });
  assert.deepStrictEqual(resave.launch.steps.margin, { done: false, note: '', v: { price: 44 } }, 'a step is saved as a whole');
  assert.deepStrictEqual(await launch(s, { key: A, step: 'nope', v: {} }), { status: 400, error: 'Bad step' });
  assert.deepStrictEqual(await launch(s, { key: A }), { status: 400, error: 'Nothing to save' });
  assert.deepStrictEqual(await launch(s, { key: 'eu|1|no card', pin: true }), { status: 404, error: 'No launch card for this product' });
  assert.deepStrictEqual(await launch(s, { key: 'nope', pin: true }), { status: 400, error: 'Bad key' });
  assert.deepStrictEqual(await launch(s, { key: A, decision: 'maybe' }), { status: 400, error: 'Bad decision' });

  // The pin: B takes it from A in one batch; never two.
  const pinned = () => env.db.prepare('SELECT product_key FROM launches WHERE pinned = 1').all().map((r) => r.product_key);
  assert.deepStrictEqual(pinned(), [A]);
  const batches = () => env.DB.log.filter((l) => /UPDATE launches SET pinned = NULL WHERE pinned = 1/.test(l.sql)).length;
  assert.strictEqual((await launch(s, { key: B, pin: true })).launch.pinned, true);
  assert.deepStrictEqual(pinned(), [B]);
  assert.strictEqual(batches(), 1);
  assert.strictEqual((await launch(s, { key: B, pin: true })).launch.pinned, true, 'pinning the launch pin again: still the one');
  assert.strictEqual((await launch(s, { key: B, pin: false })).launch.pinned, false);
  assert.deepStrictEqual(pinned(), []);
  assert.strictEqual((await launch(s, { key: A, pin: true })).launch.pinned, true, 'cleared, then another one pinned');
  assert.deepStrictEqual(pinned(), [A]);
  // A no-go loses the pin and cannot take it; taking the no-go back can.
  const no = await launch(s, { key: A, decision: 'no' });
  assert.deepStrictEqual([no.launch.decision, no.launch.pinned], ['no', false]);
  assert.deepStrictEqual(pinned(), []);
  assert.deepStrictEqual(await launch(s, { key: A, pin: true }), { status: 409, error: 'A no-go cannot be the launch pin: take the no-go back first' });
  assert.strictEqual((await launch(s, { key: A, decision: '' })).launch.decision, null);
  assert.strictEqual((await launch(s, { key: A, pin: true })).launch.pinned, true);
  const go = await launch(s, { key: A, decision: 'go' });
  assert.deepStrictEqual([go.launch.decision, go.launch.pinned], ['go', true], 'a go keeps the pin');
  assert.deepStrictEqual(await launch(s, { key: B, remove: true }), { status: 200, ok: true, removed: B });
  assert.deepStrictEqual((await s.get('/api/launch')).launches.map((x) => x.key), [A]);
  assert.strictEqual((await launch(s, { key: B, pin: true })).status, 404);
  assert.deepStrictEqual((await s.get('/api/launch?pick=1')).candidates.map((c) => c.key).includes(B), true, 'removed: it can be started again');
});

test('/api/launch: a card removed while a save was on its way is a 404, not a crash', async () => {
  const { env, s } = await approvedEnv();
  const A = POSTURE;
  await launch(s, { start: A });
  const prepare = env.DB.prepare;
  let n = 0; // the save finds the card, then it is gone when the answer reads it back
  env.DB.prepare = (sql) => (/FROM launches WHERE product_key = \?$/.test(sql) && ++n === 2 ? { bind: () => ({ first: async () => null }) } : prepare(sql));
  assert.deepStrictEqual(await launch(s, { key: A, pin: false }), { status: 404, error: 'No launch card for this product' });
});

test('/api/launch refuses other sites and bad JSON; every value goes in as a bound parameter', async () => {
  const { env, s } = await approvedEnv();
  await launch(s, { start: POSTURE });
  const body = { key: POSTURE, pin: false };
  assert.strictEqual((await s.post('/api/launch', body, { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.strictEqual((await s.post('/api/launch', body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.strictEqual((await s.post('/api/launch', 'not json')).status, 400);
  assert.strictEqual((await s.post('/api/launch', '[1,2]')).status, 400);
  assert.strictEqual((await s.post('/api/launch', { ...body, step: 'creatives', note: 'x'.repeat(9000) })).status, 413);
  assert.strictEqual(plain(env.db.prepare('SELECT pinned FROM launches').get()).pinned, 1, 'nothing changed');
  for (const evil of [`${POSTURE}'; DROP TABLE launches; --`, `${POSTURE_OLD}'; DROP TABLE launches; --`]) {
    assert.strictEqual((await launch(s, { key: evil, decision: 'no' })).status, 404, evil);
    assert.strictEqual((await launch(s, { start: evil })).status, 404, evil);
  }
  const step = await launch(s, { key: body.key, step: 'research', v: { angle: "'); DELETE FROM launches; --" } });
  assert.strictEqual(step.launch.steps.research.v.angle, "'); DELETE FROM launches; --", 'kept as text');
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM launches').get().n, 1);
  assert.ok(!env.DB.log.some((l) => /DROP|DELETE FROM launches;|posture corrector|shop1\.test/.test(l.sql)), 'user text never in the SQL');
});

// ---------------------------------------------------------------------------
// Cards saved before the board grouped EU products by product page, under 'eu|' + advertiser + title (as in production).
// They are never rewritten, and stay their product's card under both keys.
// ---------------------------------------------------------------------------

// A launch card as the board saved it then: facts as the card showed the product (boardFacts), a checklist under way.
function oldCard(env, { key = POSTURE_OLD, id = '9001', title = 'Posture Corrector Pro', product = 'https://shop1.test/products/item-1', pinned = 1, steps = { margin: { done: true, note: 'Retail 39,95', v: { price: 39.95, cpa: 12 } } }, at = iso(NOW - 864e5) } = {}) {
  const facts = { source: 'eu', id, title, img: 'https://cdn.shopify.com/s/files/1/p1.jpg', price: 30.95, cur: 'EUR', store: 'https://shop1.test/', product,
    ad: `https://www.facebook.com/ads/library/?id=${id}`, kw: 'hond', adv: 'Shop 1', age: 11, shop_ads: 81, copies: 3, products: null, rpd: 8818, proof: null, best: null,
    trust: null, jev: null, risks: [], approved_at: iso(NOW - 2 * 864e5) };
  env.db.prepare('INSERT INTO launches (product_key, title, facts, steps, pinned, decision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)')
    .run(key, title, JSON.stringify(facts), JSON.stringify(steps), pinned, at, at);
}
// Another ad: a copy of ad `from` with some columns changed (another title, advertiser or product page).
function copyAd(env, from, id, o) {
  const cols = ['product_title', 'advertiser_page_id', 'advertiser', 'active_ads', 'ad_age_days', 'ad_start_date', 'reach_eu', 'product_url', 'store_url', 'ad_library_url', 'image_url', 'keyword', 'currency', 'price', 'scaled_count', 'first_seen', 'last_seen', 'data'];
  env.db.prepare(`INSERT INTO winners (ad_id, ${cols.join(', ')}) SELECT ?, ${cols.map((c) => (c in o ? '?' : c)).join(', ')} FROM winners WHERE ad_id = ?`).run(id, ...cols.filter((c) => c in o).map((c) => o[c]), from);
}
const keysIn = (env) => env.db.prepare('SELECT product_key FROM launches ORDER BY product_key').all().map((r) => r.product_key);

test('launch keys: an old advertiser + title card is the card of the product its ad is in now (else of the product page it saved); an old key names the product its ads are in now', () => {
  // The old product "501|yoga mat" is two product pages now, and one of them also runs under another advertiser + title.
  const rows = [
    { ad_id: '1', gk: 'shop.test/products/mat', jk: '501|yoga mat' },
    { ad_id: '2', gk: 'shop.test/products/mat-xl', jk: '501|yoga mat' },
    { ad_id: '3', gk: 'shop.test/products/mat', jk: '777|best yoga mat' },
    { ad_id: '4', gk: '500|summer dress', jk: '500|summer dress' }, // no product page: the same key before and now
    { ad_id: '2', gk: 'world|shop.test/products/mat', world: { active: true } }, // outside the EU: never an EU card's ad
  ];
  const products = [
    { gk: 'shop.test/products/mat', hid: 1, pass: 1, rpd: 900 },
    { gk: 'shop.test/products/mat-xl', hid: 0, pass: 1, rpd: 5000 },
    { gk: '500|summer dress', hid: 0, pass: 1, rpd: 700 },
    { gk: 'world|shop.test/products/mat', hid: 1, world: { active: true } },
  ];
  const idx = launchIndex({ products, rows }, productKey);
  const of = (product_key, facts) => cardProduct({ product_key, facts: JSON.stringify(facts) }, idx);
  for (const k of ['eu|shop.test/products/mat', 'eu|shop.test/products/a|b', 'world|shop.test/products/mat', 'tiktok|1']) assert.strictEqual(of(k, { id: '2' }), k, `${k}: as it is`);
  assert.strictEqual(of('eu|501|yoga mat', { id: '1' }), 'eu|shop.test/products/mat', 'the product its own ad is in, not every product that shares the old key');
  assert.strictEqual(of('eu|501|yoga mat', { id: '2' }), 'eu|shop.test/products/mat-xl');
  assert.strictEqual(of('eu|777|best yoga mat', { id: '3' }), 'eu|shop.test/products/mat', 'two old products, one product page now');
  assert.strictEqual(of('eu|501|https://shop.test/products/mat', { id: '1' }), 'eu|shop.test/products/mat', 'a title that is a link is still a title');
  assert.strictEqual(of('eu|500|summer dress', { id: '4' }), 'eu|500|summer dress');
  assert.strictEqual(of('eu|501|yoga mat', { id: '99', product: 'https://www.Shop.test/products/Mat?variant=1' }), 'eu|shop.test/products/mat', 'its ad gone: the product page it saved, as the board keys it');
  assert.strictEqual(of('eu|501|yoga mat', { id: '99', product: 'https://shop.test/' }), 'eu|501|yoga mat', 'no product page either: its own key');
  assert.strictEqual(of('eu||yoga mat', null), 'eu||yoga mat', 'no page id, no facts');
  assert.strictEqual(cardProduct({ product_key: 'eu|501|yoga mat', facts: 'not json' }, idx), 'eu|501|yoga mat');
  // What a key names: its product; an old key: the product its ads are in now (approved first, then passing, then most reach a day).
  const named = (k) => (productFor(idx, k) || {}).gk;
  assert.strictEqual(named('eu|shop.test/products/mat-xl'), 'shop.test/products/mat-xl');
  assert.strictEqual(named('eu|501|yoga mat'), 'shop.test/products/mat', 'approved beats more reach');
  assert.strictEqual(named('eu|777|best yoga mat'), 'shop.test/products/mat');
  assert.strictEqual(named('eu|500|summer dress'), '500|summer dress');
  assert.strictEqual(named('world|shop.test/products/mat'), 'world|shop.test/products/mat');
  assert.strictEqual(named('eu|999|unknown'), undefined);
  products[0].hid = 0;
  assert.strictEqual(named('eu|501|yoga mat'), 'shop.test/products/mat-xl', 'none approved: most reach a day');
});

test('/api/launch: a card saved under the old advertiser + title key is still its product’s card: listed as saved, not offered again, found under either key; never copied, moved or deleted', async () => {
  const { env, s } = await approvedEnv();
  oldCard(env);
  const [l] = (await s.get('/api/launch')).launches;
  assert.deepStrictEqual([l.key, l.title, l.pinned, l.facts.id, l.steps.margin.v], [POSTURE_OLD, 'Posture Corrector Pro', true, '9001', { price: 39.95, cpa: 12 }], 'listed as it was saved');
  assert.deepStrictEqual((await s.get('/api/launch?pick=1')).candidates.map((c) => c.key), [`tiktok|${TT_ID}`, 'world|strong.test/products/pod', ROLLER], 'its product is not offered again');
  // Started again under its board key, or under its old key (a board opened before): the old card, as it is
  for (const k of [POSTURE, POSTURE_OLD]) {
    const again = await launch(s, { start: k }, { now: NOW + 1000 });
    assert.deepStrictEqual([again.status, again.launch.key, again.launch.created_at, again.launch.updated_at, again.launch.steps.margin.note], [200, POSTURE_OLD, iso(NOW - 864e5), iso(NOW - 864e5), 'Retail 39,95'], k);
  }
  assert.deepStrictEqual(keysIn(env), [POSTURE_OLD], 'no second card');
  // A change under either key goes to the old row
  const viaNew = await launch(s, { key: POSTURE, step: 'sourcing', v: { unit: 8.5, ship: 4.2 } }, { now: NOW + 2000 });
  assert.deepStrictEqual([viaNew.status, viaNew.launch.key, Object.keys(viaNew.launch.steps).sort(), viaNew.launch.summary.be_roas], [200, POSTURE_OLD, ['margin', 'sourcing'], 2.09]);
  assert.strictEqual((await launch(s, { key: POSTURE_OLD, decision: 'go' })).launch.decision, 'go');
  assert.strictEqual((await launch(s, { key: POSTURE, pin: false })).launch.pinned, false);
  const row = plain(env.db.prepare('SELECT steps, decision, pinned, created_at, updated_at FROM launches WHERE product_key = ?').get(POSTURE_OLD));
  assert.deepStrictEqual([JSON.parse(row.steps).sourcing.v, JSON.parse(row.steps).margin.note, row.decision, row.pinned, row.created_at, row.updated_at],
    [{ unit: 8.5, ship: 4.2 }, 'Retail 39,95', 'go', null, iso(NOW - 864e5), iso(NOW)]);
  assert.deepStrictEqual(keysIn(env), [POSTURE_OLD], 'never copied or moved to the new key');
  // A new card goes under the board key, next to it (nothing is pinned now, so it takes the pin)
  const roller = (await launch(s, { start: ROLLER })).launch;
  assert.deepStrictEqual([roller.key, roller.pinned], [ROLLER, true]);
  assert.deepStrictEqual((await s.get('/api/launch')).launches.map((x) => x.key), [ROLLER, POSTURE_OLD]);
  // Only a remove takes a card away: under its board key it removes the old row, and says which
  assert.deepStrictEqual(await launch(s, { key: POSTURE, remove: true }), { status: 200, ok: true, removed: POSTURE_OLD });
  assert.deepStrictEqual(keysIn(env), [ROLLER]);
  assert.deepStrictEqual(await launch(s, { key: POSTURE_OLD, pin: true }), { status: 404, error: 'No launch card for this product' });
  assert.ok((await s.get('/api/launch?pick=1')).candidates.some((c) => c.key === POSTURE), 'removed: it can be started again, under the board key');
});

test('/api/launch: two old cards of what is one product page now both stay; a board opened before sends an old key and the card goes under the board key', async () => {
  const { env, s } = await approvedEnv();
  // The same posture corrector under a second title and advertiser: one product page, one product on the board now.
  copyAd(env, '9001', '9150', { product_title: 'Posture Corrector - 2 for 1', advertiser_page_id: '650', advertiser: 'Deals', reach_eu: 60000, ad_library_url: 'https://www.facebook.com/ads/library/?id=9150' });
  const SALE_OLD = 'eu|650|posture corrector - 2 for 1';
  oldCard(env, { pinned: null, at: iso(NOW - 3 * 864e5) });
  oldCard(env, { key: SALE_OLD, id: '9150', title: 'Posture Corrector - 2 for 1', pinned: null, steps: {}, at: iso(NOW - 864e5) });
  assert.deepStrictEqual((await s.get('/api/launch')).launches.map((l) => l.key), [SALE_OLD, POSTURE_OLD], 'both listed, the last touched first');
  assert.deepStrictEqual((await s.get('/api/launch?pick=1')).candidates.map((c) => c.key), [`tiktok|${TT_ID}`, 'world|strong.test/products/pod', ROLLER], 'the product is not offered again');
  // Its board key finds one of them (the launch pin, else the last touched); each old key finds its own
  assert.strictEqual((await launch(s, { start: POSTURE })).launch.key, SALE_OLD);
  assert.strictEqual((await launch(s, { key: POSTURE, step: 'store', v: { page: true } })).launch.key, SALE_OLD);
  assert.strictEqual((await launch(s, { key: POSTURE_OLD, step: 'store', v: { photos: true } })).launch.key, POSTURE_OLD);
  assert.strictEqual((await launch(s, { key: POSTURE_OLD, pin: true })).launch.pinned, true);
  assert.strictEqual((await launch(s, { key: POSTURE, decision: 'go' })).launch.key, POSTURE_OLD, 'the launch pin first');
  assert.deepStrictEqual(keysIn(env), [POSTURE_OLD, SALE_OLD], 'nothing copied, moved or deleted');
  // A board opened before the change sends the old key of a product without a card: the card goes under the board key,
  // and the old key finds it there.
  const r = await launch(s, { start: ROLLER_OLD });
  assert.deepStrictEqual([r.status, r.launch.key, r.launch.title, r.launch.facts.id], [200, ROLLER, 'Pet Hair Remover Roller', '9003']);
  assert.strictEqual((await launch(s, { key: ROLLER_OLD, decision: 'no' })).launch.key, ROLLER);
  assert.deepStrictEqual(await launch(s, { start: 'eu|502|heated neck pillow' }), { status: 409, error: 'Approve it first' }, 'an old key of a product not approved');
  assert.deepStrictEqual(keysIn(env), [POSTURE_OLD, SALE_OLD, ROLLER]);
});
