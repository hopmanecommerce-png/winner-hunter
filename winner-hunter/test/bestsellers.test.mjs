// Store best sellers: lib/bestsellers.mjs, bestsellers.mjs (on fake stores and the in-memory D1) and the board's copy.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { productKey, storeTop, productId, rankOf, addDay, movement } from '../lib/bestsellers.mjs';
import { refresh } from '../bestsellers.mjs';
import { storeTrust, trustIdIn } from '../lib/trust.mjs';
import { handle, makeToken, productKey as boardKey, movement as boardMovement, bestOf, sellsBoost } from '../worker/src/app.mjs';
import { d1Client } from '../lib/d1.mjs';
import { d1Rest } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

const DAY = 864e5;
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const list = (...items) => json({ data: { products: { nodes: items.map(([id, h]) => ({ id: `gid://shopify/Product/${id}`, handle: h })) } } });

// Fake stores: shop1 has item-1 at #3 (found by handle); shop2 lists item-2 under its Dutch handle (found by id via .js);
// shop3 sells other things (not in its top 50); every other store gives no list (headless / API off).
function stores(lists) {
  const calls = [];
  const doFetch = async (url, init = {}) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/graphql.json')) {
      assert.strictEqual(init.method, 'POST');
      assert.match(JSON.parse(init.body).query, /sortKey: BEST_SELLING/);
      const l = lists[u.host];
      return l ? l() : new Response('<html>not found</html>', { status: 404 });
    }
    if (u.host === 'shop2.test' && u.pathname === '/products/item-2.js') return json({ id: 22, handle: 'item-2' });
    return new Response('nope', { status: 404 });
  };
  return { calls, doFetch };
}
const WEEK1 = {
  'shop1.test': () => list([10, 'a'], [11, 'b'], [12, 'item-1'], [13, 'c']),
  'shop2.test': () => list([22, 'artikel-2'], [23, 'x']),
  'shop3.test': () => list([30, 'other']),
};
const WEEK2 = {
  'shop1.test': () => list([12, 'item-1'], [10, 'a']), // climbed from #3 to #1
  'shop2.test': () => list([23, 'x'], [24, 'y'], [22, 'artikel-2']), // fell from #1 to #3
  'shop3.test': () => list([31, 'item-3'], [30, 'other']), // new in the top 50
};

test('productKey: host without www, locale prefix and query dropped, only product pages (lib and board agree)', () => {
  const cases = [
    ['https://www.Store.com/nl/products/Lamp-Pro?variant=1#x', 'store.com/products/lamp-pro'],
    ['https://store.com/collections/sale/products/lamp.js', 'store.com/products/lamp'],
    ['https://store.com/products/l%C3%A4mpe', 'store.com/products/lämpe'],
    ['https://store.com/', ''],
    ['https://store.com/collections/all', ''],
    ['javascript:alert(1)//products/x', ''],
    ['not a url', ''],
    ['', ''],
  ];
  for (const [u, want] of cases) {
    assert.strictEqual(productKey(u), want, u);
    assert.strictEqual(boardKey(u), want, 'board: ' + u);
  }
});

test('storeTop / productId / rankOf: the store list best first, or an error; never throws', async () => {
  const { doFetch } = stores(WEEK1);
  assert.deepStrictEqual(await storeTop('shop1.test', { doFetch }), { top: [{ id: '10', handle: 'a' }, { id: '11', handle: 'b' }, { id: '12', handle: 'item-1' }, { id: '13', handle: 'c' }] });
  assert.deepStrictEqual(await storeTop('nope.test', { doFetch }), { error: 'HTTP 404' });
  assert.deepStrictEqual(await storeTop('x.test', { doFetch: async () => json({ errors: [{ message: 'Access denied' }] }) }), { error: 'api error' });
  assert.deepStrictEqual(await storeTop('x.test', { doFetch: async () => { throw new TypeError('fetch failed'); } }), { error: 'network' });
  assert.strictEqual(await productId('https://shop2.test/products/item-2', { doFetch }), '22');
  assert.strictEqual(await productId('https://shop1.test/products/item-1', { doFetch }), null);
  const top = (await storeTop('shop2.test', { doFetch })).top;
  assert.strictEqual(rankOf(top, { id: '22', handle: 'item-2' }), 1, 'by id');
  assert.strictEqual(rankOf(top, { handle: 'x' }), 2, 'by handle');
  assert.strictEqual(rankOf(top, { id: '99', handle: 'zz' }), null);
});

test('history and movement: one rank a day, last 15 days; a week back, else the oldest from 2 days (lib and board agree)', () => {
  let h = addDay([], '2026-10-01', 9);
  h = addDay(h, '2026-10-01', 8); // same day: replaced
  assert.deepStrictEqual(h, [['2026-10-01', 8]]);
  assert.strictEqual(movement(h), null, 'one day: no movement yet');
  h = addDay(h, '2026-10-02', 5);
  assert.strictEqual(movement(h), null, 'one day apart: too soon');
  h = addDay(h, '2026-10-04', 4);
  assert.deepStrictEqual(movement(h), { from: 8, to: 4, days: 3 });
  for (let d = 5; d <= 20; d++) h = addDay(h, `2026-10-${String(d).padStart(2, '0')}`, d === 20 ? 2 : null);
  assert.strictEqual(h.length, 15, 'last 15 days kept');
  assert.strictEqual(h[0][0], '2026-10-06');
  assert.deepStrictEqual(movement(h), { from: null, to: 2, days: 7 }, 'not in the top 50 a week ago: new');
  for (const x of [[], h.slice(0, 1), h.slice(0, 3), h]) assert.deepStrictEqual(boardMovement(x), movement(x));
});

test('bestsellers.mjs: ranks for the board products, kept per day; the board shows them, sorts by them and puts sellers first in the inbox', async () => {
  const env = await seededEnv();
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const logs = [];

  const w1 = stores(WEEK1);
  const t1 = await refresh({ db, doFetch: w1.doFetch, now: () => NOW, log: (m) => logs.push(m) });
  assert.strictEqual(t1.ranked, 2, 'item-1 (#3, by handle) and item-2 (#1, by id)');
  assert.ok(t1.noList >= 1 && t1.stores === t1.noList + 3);
  assert.match(logs[0], /^Store best sellers: \d+ products in \d+ stores · 2 in their store's top 50/);
  assert.ok(!w1.calls.some((u) => /shop0\.test\/(?!$)|\/collections/.test(u)), 'store-root links (no product page): no best-seller list');
  assert.ok(w1.calls.includes('https://shop0.test/'), 'but their store gets its Trustpilot check');
  const row = (k) => env.db.prepare('SELECT * FROM bestseller WHERE product_key = ?').get(k);
  assert.deepStrictEqual({ ...row('shop1.test/products/item-1') }, { product_key: 'shop1.test/products/item-1', store: 'shop1.test', product_id: '12', rank: 3, ok: 1,
    checked_at: new Date(NOW).toISOString(), history: '[["2026-10-17",3]]' });
  assert.strictEqual(row('shop2.test/products/item-2').product_id, '22');
  assert.strictEqual(row('shop3.test/products/item-3').rank, null, 'listed store, not in its top 50');
  assert.strictEqual(row('shop3.test/products/item-3').ok, 1);
  assert.strictEqual(row('shop5.test/products/item-5').ok, 0, 'no list: rank unknown');

  // A week later: shop1's product climbed, shop2's fell, shop3's is new in the top 50. Known ids are not looked up again.
  const later = NOW + 8 * DAY;
  const w2 = stores(WEEK2);
  await refresh({ db, doFetch: w2.doFetch, now: () => later, log: () => {} });
  assert.ok(!w2.calls.some((u) => u.endsWith('.js')), 'product ids remembered');
  assert.strictEqual(row('shop1.test/products/item-1').history, '[["2026-10-17",3],["2026-10-25",1]]');

  const cookie = `__Host-wh=${await makeToken(env.BOARD_PIN, later)}`;
  const get = async (path) => (await handle(new Request('https://wh.example.workers.dev' + path, { headers: { cookie } }), env, { html: '', now: later })).json();
  const all = await get('/api/ads');
  const best = (id) => all.ads.find((a) => a.id === id).best;
  assert.deepStrictEqual(best('9001'), { rank: 1, move: { from: 3, days: 8 } });
  assert.deepStrictEqual(best('9002'), { rank: 3, move: { from: 1, days: 8 } });
  assert.deepStrictEqual(best('9003'), { rank: 1, move: { from: null, days: 8 } });
  assert.strictEqual(best('9005'), null, 'store without a list: nothing shown');
  assert.strictEqual(best('9000'), null, 'no product page: nothing shown');

  const sorted = (await get('/api/ads?sort=best')).ads.map((a) => (a.best && a.best.rank) || 999);
  assert.deepStrictEqual(sorted, [...sorted].sort((a, b) => a - b), 'sort=best: best store rank first, unknown last');
  assert.strictEqual(sorted[0], 1);

  const inbox = (await get('/api/ads?view=inbox&limit=100')).ads.map((a) => a.id);
  const plain = all.ads.map((a) => a.id); // by reach a day
  assert.ok(inbox.indexOf('9003') < plain.indexOf('9003'), 'a top-10 seller moves up in the inbox');

  assert.strictEqual(sellsBoost({ bs: { ok: 1, rank: 4 } }), 1.5);
  assert.strictEqual(sellsBoost({ bs: { ok: 1, rank: 30 } }), 1.2);
  assert.strictEqual(sellsBoost({ bs: { ok: 1, rank: null } }), 1);
  assert.strictEqual(sellsBoost({ bs: { ok: 0, rank: 2 } }), 1, 'unknown is not a boost');
  assert.strictEqual(bestOf({ ok: 1, rank: null, history: 'not json' }).rank, null);
});

test('the board without the bestseller table (not migrated yet) still works, just without ranks', async () => {
  const env = await seededEnv();
  env.db.exec('DROP TABLE bestseller');
  const cookie = `__Host-wh=${await makeToken(env.BOARD_PIN, NOW)}`;
  const res = await handle(new Request('https://wh.example.workers.dev/api/ads', { headers: { cookie } }), env, { html: '', now: NOW });
  assert.strictEqual(res.status, 200);
  assert.ok((await res.json()).ads.every((a) => a.best === null));
});

test('workflows: ranks after every hunt (also a red one) and before every test link', () => {
  const hunt = fs.readFileSync(new URL('../../.github/workflows/winner-hunter.yml', import.meta.url), 'utf8');
  assert.match(hunt, /- name: Store best sellers\n\s+if: \$\{\{ !cancelled\(\) \}\}\n\s+run: node winner-hunter\/bestsellers\.mjs/);
  const prev = fs.readFileSync(new URL('../../.github/workflows/preview-board.yml', import.meta.url), 'utf8');
  const at = (x) => prev.indexOf(x);
  assert.ok(at('run: node winner-hunter/migrate.mjs') > 0 && at('run: node winner-hunter/migrate.mjs') < at('run: node winner-hunter/bestsellers.mjs'));
  assert.ok(at('run: node winner-hunter/bestsellers.mjs') < at('versions upload'));
});

// ---- Trustpilot (lib/trust.mjs): only from a real widget on the store ----
const WIDGET = (score, total, name) => json({ businessUnit: { trustScore: score, stars: 4, displayName: name, identifyingName: name, numberOfReviews: { total } } });
function trustStores() {
  const calls = [];
  const doFetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const page = (html) => new Response(`<html><body>${html}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
    if (u.host === 'widget.trustpilot.com') {
      assert.match(u.pathname, /^\/trustbox-data\/5419b6a8b0d04a076446a9ad$/);
      const id = u.searchParams.get('businessUnitId');
      if (id === 'aaaaaaaaaaaaaaaaaaaaaaaa') return WIDGET(4.2, 1252, 'shop1.test');
      if (id === 'bbbbbbbbbbbbbbbbbbbbbbbb') return WIDGET(2.4, 31, 'shop2.test');
      if (id === 'dddddddddddddddddddddddd') return WIDGET(4.7, 88, 'shop4.test');
      return new Response('<!DOCTYPE html><title>Trustpilot Custom Widget</title>', { status: 200 });
    }
    if (u.host === 'shop1.test' && u.pathname === '/') return page('<div class="trustpilot-widget" data-locale="nl-NL" data-template-id="x" data-businessunit-id="aaaaaaaaaaaaaaaaaaaaaaaa"></div>');
    if (u.host === 'shop2.test' && u.pathname === '/') return page('<footer>no widget here</footer>');
    if (u.host === 'shop2.test' && u.pathname === '/products/item-2') return page('<script>window.tp = {"businessUnitId":"bbbbbbbbbbbbbbbbbbbbbbbb"}</script>');
    if (u.host === 'shop3.test') return page('<img src="https://upload.wikimedia.org/Trustpilot_Logo.png" alt="Trustpilot"><div>★★★★★ Uitstekend</div>');
    if (u.host === 'shop4.test' && u.pathname === '/') return page('<div class="trustpilot-widget" data-businessunit-id="dddddddddddddddddddddddd"></div>');
    if (u.host === 'shop5.test') return page('<footer>plain store</footer>');
    if (u.host === 'shop6.test') return page('<div data-businessunit-id="cccccccccccccccccccccccc"></div>');
    return new Response('down', { status: 503 });
  };
  return { calls, doFetch };
}

test('storeTrust: score and reviews from a real widget (home or product page), badge only, none, not reachable', async () => {
  const { doFetch } = trustStores();
  assert.deepStrictEqual(await storeTrust('shop1.test', 'https://shop1.test/products/item-1', { doFetch }), { status: 'widget', score: 4.2, reviews: 1252, profile: 'shop1.test' });
  assert.deepStrictEqual(await storeTrust('shop2.test', 'https://shop2.test/products/item-2', { doFetch }), { status: 'widget', score: 2.4, reviews: 31, profile: 'shop2.test' }, 'widget on the product page');
  assert.deepStrictEqual(await storeTrust('shop3.test', '', { doFetch }), { status: 'badge' }, 'Trustpilot logo, no real widget');
  assert.deepStrictEqual(await storeTrust('shop5.test', '', { doFetch }), { status: 'none' });
  assert.deepStrictEqual(await storeTrust('down.test', '', { doFetch }), { error: 'store not reachable' });
  assert.deepStrictEqual(await storeTrust('shop6.test', '', { doFetch }), { error: 'Trustpilot widget data HTTP 200' }, 'unknown id: retried next run, not "none"');
  assert.strictEqual(trustIdIn("data-businessunit-id='0123456789abcdef01234567'"), '0123456789abcdef01234567');
  assert.strictEqual(trustIdIn('"business_unit_id": "0123456789abcdef01234567"'), '0123456789abcdef01234567');
  assert.strictEqual(trustIdIn('data-businessunit-id="not-an-id"'), '');
});

test('bestsellers.mjs + board: Trustpilot per store every 3 days, also for ads that link to the home page; the card gets score, reviews or what the store shows', async () => {
  const env = await seededEnv();
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const logs = [];
  const s1 = trustStores();
  const t1 = await refresh({ db, doFetch: s1.doFetch, now: () => NOW, log: (m) => logs.push(m) });
  assert.deepStrictEqual({ widget: t1.trust.widget, badge: t1.trust.badge, none: t1.trust.none }, { widget: 3, badge: 1, none: 1 });
  assert.match(logs[1], /^Trustpilot: \d+ stores checked · 3 with a real widget · 1 name it without one · 1 without · \d+ not reachable$/);
  const row = (s) => env.db.prepare('SELECT status, score, reviews, profile FROM store_trust WHERE store = ?').get(s);
  assert.deepStrictEqual({ ...row('shop1.test') }, { status: 'widget', score: 4.2, reviews: 1252, profile: 'shop1.test' });
  assert.strictEqual(row('shop3.test').status, 'badge');
  assert.deepStrictEqual({ ...row('shop4.test') }, { status: 'widget', score: 4.7, reviews: 88, profile: 'shop4.test' }, 'its ad links to the home page');
  assert.ok(!s1.calls.some((u) => /shop4\.test\/.+/.test(u)), 'home page only: no product page or best-seller list asked');
  assert.strictEqual(row('shop7.test'), undefined, 'not reachable: nothing saved, tried again next run');

  const s2 = trustStores();
  await refresh({ db, doFetch: s2.doFetch, now: () => NOW + DAY, log: () => {} });
  assert.ok(!s2.calls.some((u) => /^https:\/\/shop1\.test\/$|businessUnitId=a{24}/.test(u)), 'checked a day ago: not again');
  assert.ok(s2.calls.some((u) => /businessUnitId=c{24}/.test(u)), 'a failed widget lookup is tried again the next run');
  const s3 = trustStores();
  await refresh({ db, doFetch: s3.doFetch, now: () => NOW + 3 * DAY, log: () => {} });
  assert.ok(s3.calls.some((u) => /widget\.trustpilot/.test(u)), 'after 3 days: checked again');

  const later = NOW + 3 * DAY;
  const cookie = `__Host-wh=${await makeToken(env.BOARD_PIN, later)}`;
  const ads = (await (await handle(new Request('https://wh.example.workers.dev/api/ads', { headers: { cookie } }), env, { html: '', now: later })).json()).ads;
  const trust = (id) => ads.find((a) => a.id === id).trust;
  assert.deepStrictEqual(trust('9001'), { status: 'widget', score: 4.2, reviews: 1252, profile: 'shop1.test' });
  assert.deepStrictEqual(trust('9003'), { status: 'badge', score: null, reviews: null, profile: '' });
  assert.deepStrictEqual(trust('9004'), { status: 'widget', score: 4.7, reviews: 88, profile: 'shop4.test' }, 'ad to the home page: the card has its score too');
  assert.deepStrictEqual(trust('9005'), { status: 'none', score: null, reviews: null, profile: '' });
  assert.strictEqual(trust('9007'), null, 'never checked: nothing shown');
});
