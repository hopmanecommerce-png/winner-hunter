// The hunt outside the EU: reading the public Ad Library, what is on the board, adding ads up, the night's run on a
// fake library and fake shops, and the board's API on the result.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { d1Client, migrate } from '../lib/d1.mjs';
import { MARKETS, LANGS, euFacts, resetCooling, parseWorldKeywords, searchesOf, libraryUrl, readLibrary, toRow, classify, checkStore, fetchProduct, suggestProduct, addUp, MIN_DAYS } from '../lib/world.mjs';
import { hunt, ADS_SQL } from '../world.mjs';
import { openLibrary } from '../lib/adlibrary.mjs';
import { handle, makeToken, proofOf, worldRow, worldMarketsOf, worldAlert, PROOF, WORLD_MARKETS } from '../worker/src/app.mjs';
import { MARKET_RULES } from '../worker/src/market-rules.mjs';
import { d1Binding, d1Rest, memoryDb } from './helpers/sqlite-d1.mjs';
import { seededEnv } from './helpers/seed.mjs';

const NOW = Date.UTC(2026, 9, 31, 12);
const DAY = 864e5;
const sec = (daysAgo) => Math.floor((NOW - daysAgo * DAY) / 1000);
const raw = (id, { page = '11', name = 'Pod Shop', link = 'https://pod.test/products/pillow?utm=1', days = 40, copies = 1, coll = '', title = 'Pillow', active = true } = {}) => ({
  ad_archive_id: id, page_id: page, collation_id: coll || 'c' + id, collation_count: copies, is_active: active, start_date: sec(days),
  snapshot: { page_name: name, page_id: page, page_like_count: 1200, link_url: link, caption: 'pod.test', title, images: [{ resized_image_url: 'https://cdn.test/a.jpg' }], cards: [] },
});
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });

test('the markets Connor asked for, each searched in its own language', () => {
  assert.deepStrictEqual(MARKETS.slice(0, 7), ['CH', 'NO', 'AU', 'NZ', 'AE', 'US', 'CA']);
  assert.deepStrictEqual(MARKETS, WORLD_MARKETS, 'hunt and board use one list');
  assert.strictEqual(MARKETS.length, 17);
  const every = parseWorldKeywords(fs.readFileSync(new URL('../keywords-world.txt', import.meta.url), 'utf8'));
  assert.ok(every.length >= 80);
  const langs = new Set(Object.values(LANGS).flat());
  for (const k of every) for (const l of langs) assert.ok(k[l], `${k.en}: no ${l}`);
  for (const cc of MARKETS) assert.ok(LANGS[cc], cc);
  const [row] = parseWorldKeywords('# pets\nen: dog harness | de: hundegeschirr | fr: harnais chien | no: hundesele\n\nnot a line');
  assert.deepStrictEqual(searchesOf(row, ['CH', 'NO', 'AU', 'LI']), [{ cc: 'CH', q: 'hundegeschirr' }, { cc: 'CH', q: 'harnais chien' }, { cc: 'NO', q: 'hundesele' },
    { cc: 'AU', q: 'dog harness' }, { cc: 'LI', q: 'hundegeschirr' }]);
  assert.deepStrictEqual(searchesOf({ en: 'mat', de: 'matte' }, ['NO', 'CH']), [{ cc: 'NO', q: 'mat' }, { cc: 'CH', q: 'matte' }, { cc: 'CH', q: 'mat' }]); // no word: English
});

test('library links: a keyword in one country, a shop in one country', () => {
  const a = new URL(libraryUrl({ cc: 'NZ', q: 'dog & cat' }));
  assert.strictEqual(a.searchParams.get('country'), 'NZ');
  assert.strictEqual(a.searchParams.get('q'), 'dog & cat');
  assert.strictEqual(a.searchParams.get('active_status'), 'active');
  const b = new URL(libraryUrl({ cc: 'AU', pageId: '42' }));
  assert.strictEqual(b.searchParams.get('view_all_page_id'), '42');
  assert.strictEqual(b.searchParams.get('search_type'), 'page');
});

test('reading a page: ads and the count; no results block at all means blocked, not empty', () => {
  const page = [JSON.stringify({ a: { b: [{ search_results_connection: { count: 1935, edges: [{ node: { collated_results: [raw('1'), raw('2')] } }] } }] } }), 'not json', '{"other":1}'];
  const got = readLibrary(page);
  assert.strictEqual(got.count, 1935);
  assert.deepStrictEqual(got.ads.map((a) => a.ad_archive_id), ['1', '2']);
  assert.strictEqual(readLibrary(['{"other":1}']).count, null);
  assert.strictEqual(readLibrary([JSON.stringify({ search_results_connection: { count: 0, edges: [] } })]).count, 0);
});

test('an ad as a row: its store and product from the link; a marketplace or a stopped ad is no shop', () => {
  const r = toRow(raw('1', { link: 'https://www.Pod.test/en-au/products/Pillow-X?fbclid=1', copies: 3 }), 'AU', 'pillow');
  assert.strictEqual(r.store, 'pod.test');
  assert.strictEqual(r.product_key, 'pod.test/products/pillow-x');
  assert.strictEqual(r.copies, 3);
  assert.strictEqual(r.start_at, sec(40));
  assert.strictEqual(toRow(raw('2', { link: 'https://www.amazon.com.au/dp/1' }), 'AU', 'x').store, '');
  assert.strictEqual(toRow(raw('3', { active: false }), 'AU', 'x'), null);
  const home = toRow(raw('4', { link: 'https://l.facebook.com/l.php?u=' + encodeURIComponent('https://pod.test/') }), 'AU', 'x');
  assert.strictEqual(home.store, 'pod.test');
  assert.strictEqual(home.product_key, '');
  const dpa = toRow(raw('5', { title: '{{product.name}}', link: 'https://pod.test/products/{{product.handle}}' }), 'AU', 'x');
  assert.strictEqual(dpa.title, '');
});

test('off the board: supplements, food and drink, gymwear. The categories Connor kept stay on', () => {
  for (const t of ['Collagen gummies', 'Daily Vitamin C', 'Kollagen Pulver', 'Protein bar box', 'Sports Gym Leggings', 'men\'s activewear', 'Creatine monohydrate powder']) assert.ok(classify(t).out, t);
  assert.ok(classify('Creatine monohydrate powder', 'perfect for your home gym').out, 'a supplement stays out, whatever its text says');
  // Reviewed 2026-10-31: ordinary goods that a loose word match took off the board.
  for (const [h, b] of [['Vegetable chopper', 'Chops food in seconds'], ['Dog lick mat', 'spread wet food on the mat'], ['Bike frame', 'magnesium alloy'], ['Coffee machine', 'fits all capsules'], ['Collagen face mask', ''], ['Vitamin C face serum', ''], ['Capsule wardrobe set', ''], ['Cat food bowl', '']]) {
    assert.strictEqual(classify(h, b).out, '', h);
  }
  for (const [t, f] of [['Anti-cellulite leggings', 'Shaping or cellulite leggings'], ['Running socks 3-pack', 'Running socks'], ['Adjustable dumbbells', 'Home gym gear'], ['Grain free dog food', 'Pet food'], ['Nasal strips', 'Nose strips or sprays']]) {
    assert.deepStrictEqual(classify(t), { out: '' }, `${t} (${f})`);
  }
  for (const t of ['Memory foam pillow', 'Food processor 5L', 'Dog harness', 'Lamp shade', 'Tea towel set']) assert.deepStrictEqual(classify(t), { out: '' }, t);
  assert.ok(classify('Glass jar', 'Complément alimentaire').out, 'the product type tells');
  for (const t of ['Shipping & Order Protection', 'Gift Card', 'Geschenkgutschein 50']) assert.strictEqual(classify(t).out, 'not a product', t);
});

test('stores and products: Shopify from meta.json, product from its JSON, prices in the store currency', async () => {
  const f = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'pod.test' && u.pathname === '/meta.json') return json({ myshopify_domain: 'pod.myshopify.com', currency: 'AUD', published_products_count: 9 });
    if (u.pathname === '/products/pillow.json') return json({ product: { title: 'Pod Pillow', product_type: 'Bedding', tags: 'sleep, pod', variants: [{ price: '89.00', compare_at_price: '129.00' }], image: { src: 'https://cdn.shopify.com/p.jpg' } } });
    if (u.pathname === '/products/gums.json') return json({ product: { title: 'Sleep Bears', product_type: 'Complément alimentaire', variants: [{ price: '20' }] } });
    if (u.pathname === '/search/suggest.json') return json({ resources: { results: { products: [{ url: '/products/Pillow?_pos=1' }] } } });
    return new Response('no', { status: 404 });
  };
  assert.deepStrictEqual(await checkStore('pod.test', f), { shopify: 1, host: 'pod.test', currency: 'AUD', products: 9, myshopify: 'pod.myshopify.com' });
  assert.strictEqual((await checkStore('other.test', f)).shopify, 0);
  assert.strictEqual((await checkStore('down.test', async () => { throw new Error('x'); })).shopify, null);
  const p = await fetchProduct('pod.test/products/pillow', { host: 'pod.test', currency: 'AUD' }, f);
  assert.strictEqual(p.title, 'Pod Pillow');
  assert.strictEqual(p.price, 89);
  assert.strictEqual(p.compare_at_price, 129);
  assert.strictEqual(p.currency, 'AUD');
  assert.strictEqual(p.out, 0);
  assert.strictEqual((await fetchProduct('pod.test/products/gums', { host: 'pod.test' }, f)).out, 1);
  assert.strictEqual(await fetchProduct('pod.test/products/none', { host: 'pod.test' }, f), null);
  assert.strictEqual(await suggestProduct('The pod pillow', 'pod.test', f), 'pod.test/products/pillow');
  assert.strictEqual(await suggestProduct('The pod pillow', 'pod.test', f, 'getpod.test'), 'getpod.test/products/pillow', 'known by the name the ads use');
  assert.strictEqual(await suggestProduct('Free shipping today', 'pod.test', f), '', 'a search always answers: it must be about the same thing');
});

test('Shopify says too many requests: wait and ask again; still no: the store is unknown, not "not on Shopify"', async () => {
  resetCooling();
  let n = 0;
  const once = async () => (++n === 1 ? new Response('', { status: 429 }) : json({ product: { title: 'Pod Pillow', variants: [{ price: '10' }] } }));
  const p = await fetchProduct('pod.test/products/pillow', { host: 'pod.test' }, once, { coolMs: 5 });
  assert.strictEqual(p.title, 'Pod Pillow');
  assert.strictEqual(n, 2);
  resetCooling();
  const always = async () => new Response('', { status: 429 });
  assert.strictEqual((await checkStore('pod.test', always, { coolMs: 1, tries: 2 })).shopify, null, 'asked again next run');
  resetCooling();
});

const row = (id, cc, o = {}) => ({ ad_id: id, cc, page_id: '11', page_name: 'Pod Shop', likes: 10, collation_id: 'c' + id, copies: 1, start_at: sec(40), title: 'T', image_url: '', keyword: 'pillow',
  store: 'pod.test', product_key: 'pod.test/products/pillow', first_seen: '2026-10-20T00:00:00Z', last_seen: '2026-10-31T00:00:00Z', ...o });
const ctx = (o = {}) => ({ items: new Map([['pod.test/products/pillow', { title: 'Pod Pillow', price: 89, currency: 'AUD', out: 0 }]]), stores: new Map([['pod.test', { shopify: 1, host: 'pod.test', currency: 'AUD', products: 9 }]]),
  pages: new Map([['11', { counts: { AU: 85, US: 3, DE: 500 }, in_eu: 0 }]]), now: NOW, ...o });

test('adding up: one product over its markets, copies, the oldest ad, new ads, the shop\'s ads, not in the EU', () => {
  const [p] = addUp([row('1', 'AU', { copies: 4, collation_id: 'x' }), row('2', 'AU', { copies: 4, collation_id: 'x', start_at: sec(90) }), row('3', 'NZ', { collation_id: 'y', start_at: sec(3) }), row('1', 'NZ', { copies: 4, collation_id: 'x' })], ctx());
  assert.strictEqual(p.days, 90);
  assert.strictEqual(p.ads, 5, 'creative x has 4 copies, y has 1: counted once though seen twice');
  assert.strictEqual(p.creatives, 2);
  assert.strictEqual(p.new14, 1);
  assert.deepStrictEqual(JSON.parse(p.markets), { AU: { ads: 4, days: 90, new14: 0 }, NZ: { ads: 5, days: 40, new14: 1 } });
  assert.strictEqual(p.shop_ads, 85, 'its biggest market here; DE is no market here');
  assert.strictEqual(p.in_eu, 0);
  assert.strictEqual(p.ad_id, 'w2', 'the oldest ad, in its own id space');
  assert.ok(p.ad_library_url.endsWith('?id=2'));
});

test('EU facts from Meta\'s API: in the EU or not, reach a day of the best ad, and only ads also seen here are kept', () => {
  const ads = [{ id: '1', eu_total_reach: 1000, ad_delivery_start_time: new Date(NOW - 10 * DAY).toISOString().slice(0, 10) }, { id: '2', eu_total_reach: 9000, ad_delivery_start_time: new Date(NOW - 3 * DAY).toISOString().slice(0, 10) }, { id: '3' }];
  const f = euFacts(ads, new Set(['1', '3']), NOW);
  assert.strictEqual(f.in_eu, 1);
  assert.ok(f.eu_rpd >= 2250 && f.eu_rpd <= 3000);
  assert.deepStrictEqual(Object.keys(JSON.parse(f.eu_ads)), ['1']);
  assert.deepStrictEqual(euFacts([], new Set(), NOW), { in_eu: 0, eu_rpd: null, eu_ads: '{}' });
  const [p] = addUp([row('1', 'AU')], ctx({ pages: new Map([['11', { counts: { AU: 5 }, in_eu: 1, eu_rpd: 2999.6, eu_ads: { 1: 123 } }]]) }));
  assert.strictEqual(p.eu_rpd, 123);
  assert.strictEqual(p.shop_eu_rpd, 3000);
  const [q] = addUp([row('9', 'AU')], ctx({ pages: new Map([['11', { counts: {}, in_eu: 1, eu_rpd: 50, eu_ads: { 1: 123 } }]]) }));
  assert.strictEqual(q.eu_rpd, null, 'another ad of the shop is no proof for this product');
  assert.strictEqual(q.shop_eu_rpd, 50);
});

test('adding up: only Shopify, only products on the board, an ad at least 7 days old; the id never changes', () => {
  assert.strictEqual(addUp([row('1', 'AU')], ctx({ stores: new Map([['pod.test', { shopify: 0 }]]) })).length, 0);
  assert.strictEqual(addUp([row('1', 'AU')], ctx({ items: new Map([['pod.test/products/pillow', { out: 1 }]]) })).length, 0);
  assert.strictEqual(addUp([row('1', 'AU', { start_at: sec(MIN_DAYS - 1) })], ctx()).length, 0);
  assert.strictEqual(addUp([row('1', 'AU', { start_at: sec(MIN_DAYS) })], ctx()).length, 1);
  assert.strictEqual(addUp([row('1', 'AU', { store: 'getpod.test', product_key: 'getpod.test/products/pillow' })], ctx({ items: new Map([['getpod.test/products/pillow', { title: 'X', out: 0 }]]), stores: new Map([['getpod.test', { shopify: 1, host: 'pod.test' }]]) })).length, 1, 'a store that redirects');
  assert.strictEqual(addUp([row('1', 'AU', { product_key: '' })], ctx()).length, 0);
  assert.strictEqual(addUp([row('1', 'DE')], ctx()).length, 0, 'a market not hunted here');
  const [p] = addUp([row('7', 'AU', { start_at: sec(100) })], ctx({ known: new Map([['pod.test/products/pillow', { ad_id: '1', first_seen: '2026-01-01' }]]) }));
  assert.strictEqual(p.ad_id, '1');
  assert.strictEqual(p.first_seen, '2026-01-01');
});

// A library with one page per search and shops behind it.
function fakeWorld(pages, opts = {}) {
  const calls = [];
  const lib = { search: async (what) => {
    calls.push(what);
    if (opts.refuse && opts.refuse(what, calls.length)) return { ads: [], count: null, blocked: true };
    const ads = what.pageId ? (pages.shop || []) : (pages[what.cc + '|' + what.q] || []);
    return { ads, count: what.pageId ? 85 : ads.length, blocked: false };
  } };
  const doFetch = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'graph.test') {
      calls.push({ eu: JSON.parse(u.searchParams.get('search_page_ids'))[0], token: u.searchParams.get('access_token'), countries: JSON.parse(u.searchParams.get('ad_reached_countries')) });
      return json({ data: opts.inEu ? [{ id: '1' }] : [] });
    }
    if (u.pathname === '/meta.json') return u.hostname === 'pod.test' ? json({ myshopify_domain: 'pod.myshopify.com', currency: 'AUD', published_products_count: 9 }) : new Response('<html>', { status: 200 });
    if (u.pathname === '/products/pillow.json') return json({ product: { title: 'Pod Pillow', variants: [{ price: '89.00' }], image: { src: 'https://cdn.shopify.com/p.jpg' } } });
    if (u.pathname === '/products/gums.json') return json({ product: { title: 'Sleep gummies', variants: [{ price: '20' }] } });
    if (u.pathname === '/search/suggest.json') return json({ resources: { results: { products: [] } } });
    return new Response('nope', { status: 404 });
  };
  return { lib, calls, doFetch };
}
const setup = async () => {
  const mem = memoryDb();
  const client = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(mem).doFetch, retryMs: 0 });
  return { mem, client, env: { DB: d1Binding(mem), BOARD_PIN: '1234' } };
};
const KEYWORDS = [{ en: 'pillow', de: 'kissen', fr: 'oreiller', no: 'pute', ja: '枕', ko: '베개', zh: '枕頭' }, { en: 'dog', de: 'hund', fr: 'chien', no: 'hund', ja: '犬', ko: '강아지', zh: '狗' }];
const quiet = { log: () => {}, sleep: async () => {}, now: () => NOW, base: 'https://graph.test' };

test('a night: searched in every market, saved, products on the board, EU check, cursor moves; a second night keeps the id', async () => {
  const { client, mem } = await setup();
  const { lib, calls, doFetch } = fakeWorld({
    'AU|pillow': [raw('1', { days: 120, copies: 6 }), raw('2', { link: 'https://other.test/products/x' }), raw('3', { link: 'https://pod.test/products/gums', title: 'Gums' }), raw('4', { link: 'https://www.ebay.com.au/itm/1' }), raw('9', { active: false })],
    'NZ|pillow': [raw('1', { days: 120, copies: 6 }), raw('5', { days: 2 })],
    shop: [raw('6', { days: 300 })],
  });
  const t = await hunt({ db: client, lib, keywords: KEYWORDS, doFetch, tokens: ['tok'], ...quiet, maxPages: 5 });
  assert.strictEqual(t.health, 'ok');
  assert.strictEqual(t.products, 1);
  const searches = calls.filter((c) => c.q);
  assert.strictEqual(searches.length, 2 * MARKETS.reduce((n, cc) => n + LANGS[cc].length, 0), 'every market, each language');
  assert.ok(searches.some((c) => c.cc === 'JP' && c.q === '枕'));
  assert.ok(searches.some((c) => c.cc === 'CH' && c.q === 'oreiller'));
  assert.ok(searches.some((c) => c.cc === 'NO' && c.q === 'pute'));
  const [p] = mem.prepare('SELECT * FROM world_products').all();
  assert.strictEqual(p.product_key, 'pod.test/products/pillow');
  assert.strictEqual(p.product_title, 'Pod Pillow');
  assert.strictEqual(p.price, 89);
  assert.strictEqual(p.currency, 'AUD');
  assert.strictEqual(p.in_eu, 0);
  assert.strictEqual(p.shop_ads, 85);
  assert.strictEqual(p.days, 300, 'the shop\'s own page showed an older ad of this product');
  assert.deepStrictEqual(Object.keys(JSON.parse(p.markets)).sort(), ['AU', 'NZ']);
  assert.strictEqual(mem.prepare("SELECT out FROM world_items WHERE product_key = 'pod.test/products/gums'").get().out, 1);
  assert.strictEqual(mem.prepare("SELECT shopify FROM world_stores WHERE store = 'other.test'").get().shopify, 0);
  assert.strictEqual(mem.prepare("SELECT COUNT(*) AS n FROM world_ads WHERE store = 'ebay.com.au' OR ad_id = '9'").get().n, 0 + mem.prepare("SELECT COUNT(*) AS n FROM world_ads WHERE ad_id = '9'").get().n);
  const eu = calls.find((c) => c.eu);
  assert.strictEqual(eu.token, 'tok');
  assert.ok(eu.countries.includes('NL') && eu.countries.length === 27 && !eu.countries.includes('GB'));
  assert.strictEqual(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'world_cursor'").get().value).next, 0);
  assert.strictEqual(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'world_run'").get().value).status, 'done');

  // Night two: an older ad shows up, the id stays, a product no longer seen is kept inactive.
  const second = fakeWorld({ 'AU|pillow': [raw('8', { days: 500 })] });
  await hunt({ db: client, lib: second.lib, keywords: KEYWORDS.slice(0, 1), doFetch: second.doFetch, tokens: [], ...quiet, now: () => NOW + DAY, maxPages: 0 });
  const [q] = mem.prepare('SELECT * FROM world_products').all();
  assert.strictEqual(q.ad_id, p.ad_id);
  assert.strictEqual(q.days, 501);
});

test('a decision on a product outside the EU never reaches an EU winner with the same ad', async () => {
  const env = await seededEnv();
  const cookie = `__Host-wh=${await makeToken(env.BOARD_PIN, NOW)}`;
  const [p] = addUp([row('9000', 'AU')], ctx());
  assert.strictEqual(p.ad_id, 'w9000');
  put(env.db, { ...P('pod.test/products/pillow', p.ad_id) });
  const call = (path, init = {}) => handle(new Request('https://board.test' + path, { ...init, headers: { cookie, 'content-type': 'application/json' } }), env, { html: '', now: Date.UTC(2026, 9, 17, 8, 0) });
  const before = await (await call('/api/ads?view=all&limit=100')).json();
  assert.ok(before.ads.some((a) => a.id === '9000'), 'the EU winner with that ad');
  await call('/api/hide', { method: 'POST', body: JSON.stringify({ ad_id: p.ad_id, status: 'rejected' }) });
  const after = await (await call('/api/ads?view=all&limit=100')).json();
  assert.ok(after.ads.some((a) => a.id === '9000'), 'still on the EU board');
});

test('a crash marks the run failed, never "running"; a refused market keeps its old count and is asked again', async () => {
  const { client, mem } = await setup();
  const { lib, doFetch } = fakeWorld({ 'CH|kissen': [raw('1', { days: 50 })] });
  await assert.rejects(hunt({ db: { ...client, query: async (sql, a) => { if (/DISTINCT a.store FROM/.test(sql)) throw new Error('boom'); return client.query(sql, a); } }, lib, keywords: KEYWORDS, doFetch, tokens: [], ...quiet, maxPages: 0 }), /boom/);
  const run = JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'world_run'").get().value);
  assert.strictEqual(run.status, 'failed');
  assert.strictEqual(run.health, 'failed');
  assert.match(run.alert, /boom/);
  assert.strictEqual(worldAlert({ status: 'running', started_at: new Date(NOW - 4 * 3600e3).toISOString(), updated_at: new Date(NOW - 4 * 3600e3).toISOString() }, NOW).level, 'red');
  assert.strictEqual(worldAlert({ status: 'running', started_at: new Date(NOW - 3600e3).toISOString(), updated_at: new Date(NOW - 60000).toISOString() }, NOW), null);

  const second = await setup();
  second.mem.prepare("INSERT INTO world_pages (page_id, counts, checked_at) VALUES ('11', '{\"AU\":3,\"NZ\":85}', '2026-01-01T00:00:00Z')").run();
  const w = fakeWorld({ 'AU|pillow': [raw('1', { days: 50 })], 'NZ|pillow': [raw('1', { days: 50 })] }, { refuse: (what) => what.pageId && what.cc === 'NZ' });
  await hunt({ db: second.client, lib: w.lib, keywords: KEYWORDS.slice(0, 1), doFetch: w.doFetch, tokens: [], ...quiet, maxPages: 5 });
  const pg = second.mem.prepare("SELECT counts, checked_at FROM world_pages WHERE page_id = '11'").get();
  assert.deepStrictEqual(JSON.parse(pg.counts), { AU: 85, NZ: 85 });
  assert.strictEqual(pg.checked_at, '2026-01-01T00:00:00Z', 'asked again next run');
});

test('a run cut short while writing the board leaves the board as it was', async () => {
  const { client, mem } = await setup();
  const first = fakeWorld({ 'AU|pillow': [raw('1', { days: 50 })] });
  await hunt({ db: client, lib: first.lib, keywords: KEYWORDS.slice(0, 1), doFetch: first.doFetch, tokens: [], ...quiet, maxPages: 0 });
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_products WHERE active = 1').get().n, 1);
  const flaky = { ...client, query: async (sql, a) => { if (/^INSERT INTO world_products/.test(sql)) throw new Error('D1 down'); return client.query(sql, a); } };
  await assert.rejects(hunt({ db: flaky, lib: first.lib, keywords: KEYWORDS.slice(0, 1), doFetch: first.doFetch, tokens: [], ...quiet, now: () => NOW + DAY, maxPages: 0 }), /D1 down/);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_products WHERE active = 1').get().n, 1);
});

test('real product links are fetched before any guessing: slow guesses cannot starve them', async () => {
  const { client, mem } = await setup();
  let t0 = NOW;
  const w = fakeWorld({ 'AU|pillow': [raw('1', { days: 50 }), raw('2', { days: 50, link: 'https://pod.test/', title: 'Some other title' })] });
  const slowFetch = async (url, init) => {
    if (/search\/suggest/.test(url)) t0 += 3600e3; // every guess burns an hour
    return w.doFetch(url, init);
  };
  await hunt({ db: client, lib: w.lib, keywords: KEYWORDS.slice(0, 1), doFetch: slowFetch, tokens: [], ...quiet, now: () => t0, deadline: NOW + 1800e3, maxPages: 0 });
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_products').get().n, 1);
});

test('refusals: a few in a row wait, more stop the night, the run says so and what it had is kept', async () => {
  const { client, mem } = await setup();
  const waits = [];
  const { lib, calls, doFetch } = fakeWorld({ 'CH|kissen': [raw('1', { days: 50 })] }, { refuse: (w, n) => n >= 2 });
  const t = await hunt({ db: client, lib, keywords: KEYWORDS, doFetch, tokens: [], ...quiet, sleep: async (ms) => { waits.push(ms); }, waitMs: 777, maxPages: 0 });
  assert.strictEqual(t.stopped, 'blocked');
  assert.strictEqual(t.blocked, 6);
  assert.strictEqual(calls.length, 7, 'one good, six refused, then it stops');
  assert.ok(waits.includes(777));
  assert.strictEqual(t.health, 'failed', 'six of seven refused: red, so GitHub sends its failure mail');
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_products').get().n, 1, 'what it found still reaches the board');
  assert.ok(t.alert.includes('refused'));
  assert.strictEqual(mem.prepare("SELECT value FROM state WHERE key = 'world_cursor'").get(), undefined, 'the keyword cut short is searched again');

  const all = fakeWorld({}, { refuse: () => true });
  const f = await hunt({ db: client, lib: all.lib, keywords: KEYWORDS, doFetch: all.doFetch, tokens: [], ...quiet, maxPages: 0 });
  assert.strictEqual(f.health, 'failed');
  assert.strictEqual(f.searches, 6);
});

test('Facebook sends a count but no ads: a refusal for a keyword, while a shop\'s count stays usable', async () => {
  const blocks = [JSON.stringify({ search_results_connection: { count: 22425, edges: [] } })];
  const page = { goto: async () => {}, evaluate: async () => blocks, waitForTimeout: async () => {} };
  const ctx = { route: async () => {}, newPage: async () => page, close: async () => {} };
  const lib = await openLibrary({ launch: async () => ({ isConnected: () => true, newContext: async () => ctx, close: async () => {} }), settle: 0 });
  assert.strictEqual((await lib.search({ cc: 'AU', q: 'dog bed' })).blocked, true);
  const shop = await lib.search({ cc: 'AU', pageId: '1' });
  assert.strictEqual(shop.blocked, false);
  assert.strictEqual(shop.count, 22425);
});

test('a browser that dies mid-run is started again; a failure counts as refused and never ends the run', async () => {
  const page = { goto: async () => {}, evaluate: async () => [JSON.stringify({ search_results_connection: { count: 3 } })], waitForTimeout: async () => {} };
  const ctx = { route: async () => {}, newPage: async () => page, close: async () => {} };
  let launches = 0;
  let alive = true;
  const launch = async () => {
    launches++;
    if (launches === 3) throw new Error('no browser');
    alive = true;
    return { isConnected: () => alive, newContext: async () => ctx, close: async () => {} };
  };
  const lib = await openLibrary({ launch, settle: 0 });
  assert.strictEqual((await lib.search({ cc: 'AU', q: 'x' })).count, 3);
  alive = false;
  assert.strictEqual((await lib.search({ cc: 'AU', q: 'x' })).count, 3);
  assert.strictEqual(launches, 2);
  alive = false;
  const failed = await lib.search({ cc: 'AU', q: 'x' });
  assert.strictEqual(failed.blocked, true);
  assert.match(failed.error, /no browser/);
});

test('the time budget stops the searching and the board table still gets written', async () => {
  const { client, mem } = await setup();
  let t0 = NOW;
  const { lib, calls, doFetch } = fakeWorld({ 'CH|kissen': [raw('1', { days: 50 })] });
  const t = await hunt({ db: client, lib, keywords: KEYWORDS, doFetch, tokens: [], ...quiet, now: () => (t0 += 60000), deadline: NOW + 7 * 60000, maxPages: 0 });
  assert.strictEqual(t.stopped, 'time');
  assert.ok(calls.length < 8);
  assert.ok(mem.prepare("SELECT value FROM state WHERE key = 'world_run'").get().value.includes('finished_at'));
});

test('keywords go on where the last run stopped', async () => {
  const { client } = await setup();
  await client.setState('world_cursor', { next: 1 });
  const { lib, calls, doFetch } = fakeWorld({});
  await hunt({ db: client, lib, keywords: KEYWORDS, doFetch, tokens: [], ...quiet, maxPages: 0 });
  assert.strictEqual(calls[0].q, 'hund');
});

// ---- the board ----
const P = (key, ad, o = {}) => ({ product_key: key, ad_id: ad, active: 1, product_title: key, price: 50, compare_at_price: null, currency: 'AUD', image_url: 'https://cdn.test/a.jpg', store_url: `https://${key.split('/')[0]}/`,
  product_url: `https://${key}`, ad_library_url: `https://www.facebook.com/ads/library/?id=${ad}`, advertiser: 'Shop', page_id: '11', likes: 5, keyword: 'pillow', markets: JSON.stringify({ AU: { ads: 2, days: 10, new14: 0 } }),
  ads: 2, creatives: 2, days: 10, new14: 0, shop_ads: null, in_eu: null, store_products: 4, first_seen: '2026-10-20T00:00:00Z', last_seen: '2026-10-31T10:00:00Z', ...o });
const put = (mem, p) => mem.prepare(`INSERT INTO world_products (${Object.keys(p).join(',')}) VALUES (${Object.keys(p).map(() => '?').join(',')})`).run(...Object.values(p));
const seedWorld = (mem) => {
  put(mem, P('a.test/products/strong', '100', { days: 120, ads: 9, markets: JSON.stringify({ AU: { ads: 5, days: 120, new14: 1 }, NZ: { ads: 4, days: 60, new14: 0 } }), shop_ads: 85, new14: 1, in_eu: 0 }));
  put(mem, P('b.test/products/weak', '200', { in_eu: 1 }));
  put(mem, P('c.test/products/us', '300', { days: 45, markets: JSON.stringify({ US: { ads: 1, days: 45, new14: 0 } }) }));
  put(mem, P('d.test/products/gone', '400', { active: 0 }));
  mem.prepare("INSERT INTO bestseller (product_key, store, rank, ok, checked_at, history) VALUES ('a.test/products/strong', 'a.test', 3, 1, '2026-10-31', '[]')").run();
  mem.prepare("INSERT INTO store_trust (store, status, score, reviews, profile) VALUES ('a.test', 'page', 4.5, 800, 'a.test')").run();
};
const authed = async (env, path, init = {}) => {
  const res = await handle(new Request('https://board.test' + path, { ...init, headers: { cookie: `__Host-wh=${await makeToken('1234', NOW)}`, ...(init.headers || {}) } }), env, { html: '<html></html>', now: NOW });
  return res;
};
const J = async (env, path, init) => (await authed(env, path, init)).json();

test('proof: six plain signals; unknown is not no', () => {
  const r = { ...worldRow(P('a.test/products/x', '1', { days: PROOF.days, ads: PROOF.ads, shop_ads: PROOF.shop, markets: JSON.stringify({ AU: {}, NZ: {} }) })), age_now: PROOF.days, bs: { ok: 1, rank: 4 }, tp: { status: 'page', reviews: PROOF.reviews } };
  assert.strictEqual(proofOf(r).n, 6);
  const none = proofOf({ ...worldRow(P('a.test/products/x', '1')), age_now: 10 });
  assert.strictEqual(none.n, 0);
  const by = Object.fromEntries(none.items.map((i) => [i.k, i.ok]));
  assert.deepStrictEqual(by, { days: false, ads: false, markets: false, shop: null, best: null, trust: null });
  const onlyStore = proofOf({ ...worldRow(P('a.test/products/x', '1')), age_now: 10, tp: { status: 'none' } });
  assert.strictEqual(onlyStore.items.find((i) => i.k === 'trust').ok, null, 'Trustpilot itself was not read');
  const no = proofOf({ ...worldRow(P('a.test/products/x', '1', { shop_ads: 3 })), age_now: 10, bs: { ok: 1, rank: null }, tp: { status: 'nopage' } });
  assert.deepStrictEqual(Object.fromEntries(no.items.map((i) => [i.k, i.ok])), { days: false, ads: false, markets: false, shop: false, best: false, trust: false });
});

test('the board outside the EU: most proof first, one market, filters, sorts, and products that stopped stay away', async () => {
  const { env, mem } = await setup();
  seedWorld(mem);
  const all = await J(env, '/api/ads?scope=world&view=all');
  assert.deepStrictEqual(all.ads.map((a) => a.id), ['100', '300', '200']);
  const top = all.ads[0];
  assert.strictEqual(top.world.proof.n, 6);
  assert.strictEqual(top.best.rank, 3);
  assert.deepStrictEqual(top.world.markets[0], ['AU', 5, 120, 1]);
  assert.strictEqual(top.world.in_eu, 0);
  assert.strictEqual(all.counts.world, 3);
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all&cc=NZ')).ads.map((a) => a.id), ['100']);
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all&cc=FR')).ads.length, 3, 'not a market here: no filter');
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all&noteu=1')).ads.map((a) => a.id), ['100']);
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all&p4=1')).ads.map((a) => a.id), ['100']);
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all&fresh=1')).ads.map((a) => a.id), ['100']);
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all&sort=days')).ads.map((a) => a.id), ['100', '300', '200']);
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all&q=weak')).ads.map((a) => a.id), ['200']);
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all&sort=constructor')).ads.map((a) => a.id), ['100', '300', '200'], 'a strange sort: the default');
  const inbox = await J(env, '/api/ads?scope=world&view=inbox');
  assert.strictEqual(inbox.view, 'inbox');
  assert.strictEqual(inbox.counts.inbox, 3);
});

test('decisions work on them as on any product: reject, star, note; ★ and ✓ keep them; the EU tabs never show them', async () => {
  const { env, mem } = await setup();
  seedWorld(mem);
  const post = (path, body) => authed(env, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.strictEqual((await post('/api/hide', { ad_id: '200', status: 'rejected' })).status, 200);
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all')).ads.map((a) => a.id), ['100', '300']);
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=all&hidden=1')).ads.map((a) => a.id), ['200']);
  await post('/api/hide', { ad_id: '100', status: 'starred' });
  assert.deepStrictEqual((await J(env, '/api/ads?scope=world&view=inbox')).ads.map((a) => a.id), ['300'], 'decided: out of the inbox');
  await post('/api/hide', { ad_id: '400', status: 'seen' }); // no longer running
  assert.deepStrictEqual((await J(env, '/api/ads?view=made')).ads.map((a) => a.id), ['400']);
  const stars = await J(env, '/api/ads?view=starred');
  assert.strictEqual(stars.ads[0].world.proof.n, 6);
  assert.strictEqual((await post('/api/note', { ad_id: '300', note: 'looks fine' })).status, 200);
  const eu = await J(env, '/api/ads?view=all');
  assert.strictEqual(eu.ads.length, 0, 'the EU board has its own rules');
  assert.strictEqual(eu.counts.world, 2);
  const stopped = (await J(env, '/api/ads?scope=world&view=all')).ads.map((a) => a.id);
  assert.ok(!stopped.includes('400'));
});

test('the radar outside the EU: all seven markets with facts; the EU radar is unchanged', async () => {
  const { env, mem } = await setup();
  seedWorld(mem);
  const m = await J(env, '/api/markets?scope=world');
  assert.strictEqual(m.scope, 'world');
  assert.strictEqual(m.markets.length, MARKETS.length);
  assert.deepStrictEqual(m.markets.slice(0, 3).map((x) => [x.cc, x.products]), [['AU', 2], ['NZ', 1], ['US', 1]]);
  const au = m.markets[0];
  assert.strictEqual(au.shops, 2);
  assert.strictEqual(au.strong, 1);
  assert.strictEqual(au.days, 120);
  assert.strictEqual(au.top.id, '100');
  assert.deepStrictEqual(m.markets.filter((x) => !x.products).map((x) => x.cc), MARKETS.filter((cc) => !['AU', 'NZ', 'US'].includes(cc)));
  const eu = await J(env, '/api/markets');
  assert.strictEqual(eu.scope, undefined);
  assert.deepStrictEqual(eu.markets, []);
  assert.ok(worldMarketsOf([]).markets.every((x) => x.products === 0));
});

test('selling rules: every market has them, each says how far it was checked and has a source unless unverified', async () => {
  for (const cc of Object.keys(MARKET_RULES.markets)) assert.ok(MARKETS.includes(cc), cc);
  for (const [cc, m] of Object.entries(MARKET_RULES.markets)) {
    assert.ok(m.short.length > 0 && m.short.length <= 90, cc);
    assert.ok(m.items.length > 0 && m.items.length <= 8, cc);
    for (const i of m.items) {
      assert.ok(['fact', 'estimate', 'unverified'].includes(i.status), `${cc} ${i.k}`);
      assert.ok(i.text.length <= 140, `${cc} ${i.k}`);
      assert.ok(/^https:\/\//.test(i.source) || i.status === 'unverified', `${cc} ${i.k}`);
      assert.ok(i.checked, `${cc} ${i.k}`);
    }
  }
  const { env } = await setup();
  const m = await J(env, '/api/markets?scope=world');
  assert.strictEqual(m.markets.find((x) => x.cc === 'NZ').rules.short, MARKET_RULES.markets.NZ.short);
  assert.strictEqual(m.rules_as_of, MARKET_RULES.as_of);
});

test('CSV outside the EU has the proof; cells cannot run as formulas', async () => {
  const { env, mem } = await setup();
  put(mem, P('e.test/products/x', '500', { product_title: '=HYPERLINK("x")', days: 90, markets: JSON.stringify({ AU: { ads: 2, days: 90, new14: 0 }, NZ: { ads: 1, days: 9, new14: 1 } }) }));
  const t = await (await authed(env, '/export.csv?scope=world&view=all')).text();
  const [head, line] = t.trim().split('\r\n');
  assert.ok(head.endsWith('proof_signals,markets_outside_eu,new_ads_14d,in_eu,eu_reach_per_day_product,eu_reach_per_day_shop_best_ad'));
  assert.ok(line.includes('AU 2 ads 90d / NZ 1 ads 9d'));
  assert.ok(line.includes(`"'=HYPERLINK`));
});

test('a problem with the scan shows on its tab only', async () => {
  assert.strictEqual(worldAlert(null, NOW), null);
  assert.strictEqual(worldAlert({ health: 'ok', finished_at: new Date(NOW - 3600e3).toISOString() }, NOW), null);
  assert.strictEqual(worldAlert({ health: 'failed', alert: 'x', finished_at: new Date(NOW).toISOString() }, NOW).level, 'red');
  assert.strictEqual(worldAlert({ health: 'warning', finished_at: new Date(NOW).toISOString() }, NOW).level, 'yellow');
  assert.strictEqual(worldAlert({ health: 'ok', finished_at: new Date(NOW - 80 * 3600e3).toISOString() }, NOW).level, 'red');
  const { env, mem } = await setup();
  mem.prepare("INSERT INTO state (key, value, updated_at) VALUES ('world_run', ?, 'x')").run(JSON.stringify({ health: 'failed', alert: 'Refused', finished_at: new Date(NOW).toISOString() }));
  assert.strictEqual((await J(env, '/api/ads?scope=world')).alert.text, 'Refused');
  assert.strictEqual((await J(env, '/api/ads')).alert, null);
});

test('no scan yet, or the tables not there yet: the board still works', async () => {
  const { env } = await setup();
  assert.strictEqual((await J(env, '/api/ads?scope=world&view=all')).ads.length, 0);
  const mem = memoryDb();
  mem.exec('DROP TABLE world_products');
  const old = { DB: d1Binding(mem), BOARD_PIN: '1234' };
  assert.strictEqual((await authed(old, '/api/ads?scope=world')).status, 200);
  assert.strictEqual((await authed(old, '/api/ads')).status, 200);
});

test('the save statements stay valid: one ad seen again keeps when it was first seen', async () => {
  const { client, mem } = await setup();
  const r = toRow(raw('1'), 'AU', 'x');
  await client.query(ADS_SQL, [JSON.stringify([r]), '2026-10-01T00:00:00Z']);
  await client.query(ADS_SQL, [JSON.stringify([{ ...r, copies: 7 }]), '2026-10-02T00:00:00Z']);
  const [a] = mem.prepare('SELECT * FROM world_ads').all();
  assert.strictEqual(a.first_seen, '2026-10-01T00:00:00Z');
  assert.strictEqual(a.last_seen, '2026-10-02T00:00:00Z');
  assert.strictEqual(a.copies, 7);
});
