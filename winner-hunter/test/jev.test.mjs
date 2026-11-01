// Jev's answers (lib/jev.mjs, world-check.mjs) on a fake TypeSafe API and fake shops, and what the board does with them.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { d1Client, migrate } from '../lib/d1.mjs';
import { checkProduct, photoAsset, productPage, categoryOf, sizeOf, JevError } from '../lib/jev.mjs';
import { questions, TAXONOMY, CATEGORIES, SEP, TRAITS, AD_TRAITS, VERSION } from '../worker/src/jev-questions.mjs';
import { checkAll, adsOf, SAVE_SQL, TODO_SQL } from '../world-check.mjs';
import { jevFlags, jevMatches, jevSummary, worldAlert, worldRow, toCsv } from '../worker/src/app.mjs';
import { d1Rest, memoryDb } from './helpers/sqlite-d1.mjs';

// A JPEG header says 800 × 600 (or what is asked), a PNG header 800 × 600.
const jpg = (w = 800, h = 600) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const png = () => { const b = Buffer.alloc(24); b.set([0x89, 0x50, 0x4e, 0x47]); b.writeUInt32BE(800, 16); b.writeUInt32BE(600, 20); return b; };
const WEBP = Buffer.from('RIFFxxxxWEBPyyy');
const json = (x, status = 200, headers = {}) => new Response(JSON.stringify(x), { status, headers });
const IMG = 'https://cdn.shopify.com/s/files/a.png?v=1';
const pause = async () => {};

// The fake Jev answers every question it is asked: yes to people, no to the rest, the first option of each choice.
function answers(body, yes = { people: 0.99, physical: 0.98 }) {
  const out = {};
  for (const [k, q] of Object.entries(body.questions)) {
    if (q.type === 'noul') out[k] = { type: 'noul', noul: yes[k] ?? 0.01 };
    else if (q.type === 'score') out[k] = { type: 'score', score: 2.5, confidence: 0.5 };
    else if (k === 'category') out[k] = { type: 'choice', choice: 'x', confidence: 0.9, probabilities: { [`Pets${SEP}Food and treats`]: 0.5, [`Pets${SEP}Grooming`]: 0.2, [`Home${SEP}Lighting`]: 0.3 } };
    else out[k] = { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.8 };
  }
  return out;
}
const OK = (body) => json({ model: 'jev-1.14.0', answers: answers(body), usage: { input_tokens: 2400, output_tokens: 200 } });

function api(answer = OK, { photo = () => new Response(jpg()), page = () => json({ product: { body_html: '<p>Calm <b>capsules</b></p>', vendor: 'Nova', tags: ['sleep', 'calm'], options: [{ name: 'Title' }, { name: 'Size' }], variants: [{}, {}], images: [{ src: IMG }, { src: 'https://cdn.shopify.com/s/files/b.png' }] } }) } = {}) {
  const calls = [];
  const doFetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).startsWith('https://api.typesafe.ai/')) return answer(JSON.parse(init.body), init, calls);
    return /\/products\/.*\.json$/.test(url) ? page(url) : photo(url);
  };
  return { calls, doFetch, asks: () => calls.filter((c) => String(c.url).startsWith('https://api.typesafe.ai/')) };
}
const PRODUCT = { key: 'nova.test/products/calm', title: 'She Again', type: '', store: 'https://nova.test', image: IMG, price: 42, was: 60, currency: 'USD', products: 26, advertiser: 'Nova', likes: 900, keyword: 'sleep',
  ads: { titles: ['Sleep again'], texts: ['Tired of waking up?'], image: 'https://scontent.test/ad.jpg', countries: ['NZ'], count: 3, days: 143, new14: 1, creatives: 2 } };

test('the question set: a category tree of 100+, every question well formed, ad questions only with an ad', () => {
  assert.ok(Object.keys(TAXONOMY).length >= 15);
  assert.ok(CATEGORIES.length >= 100, String(CATEGORIES.length));
  assert.strictEqual(new Set(CATEGORIES).size, CATEGORIES.length);
  const all = [...TRAITS, ...AD_TRAITS].map((t) => t.k);
  assert.strictEqual(new Set(all).size, all.length);
  const withAd = questions(true);
  const without = questions(false);
  assert.ok(withAd.ad_score && withAd.ad_format && withAd.ad_clear);
  assert.ok(!without.ad_score && !without.ad_format && !without.ad_clear);
  for (const k of ['face', 'hardsource', 'people', 'problem', 'product_score']) assert.ok(without[k], k);
  assert.ok(Array.isArray(withAd.product_score.criteria) && withAd.product_score.criteria.length === 5);
});

test('checkProduct: everything we know goes to Jev: the page, three pictures, the ad words and where it runs', async () => {
  const a = api();
  const r = await checkProduct(PRODUCT, { key: 'k1', doFetch: a.doFetch, pause });
  assert.strictEqual(r.main, 'Pets');
  assert.strictEqual(r.sub, 'Food and treats');
  assert.strictEqual(r.main_conf, 0.7, 'the sum of its sub-categories');
  assert.strictEqual(r.version, VERSION);
  assert.strictEqual(r.people, 0.99);
  assert.strictEqual(r.product_score, 2.5);
  assert.strictEqual(r.ad_score, 2.5);
  assert.strictEqual(r.ad_text, 1);
  assert.strictEqual(r.used, 'photo, photo2, ad image, description, ad text, ad title');
  const saved = JSON.parse(r.answers);
  assert.strictEqual(saved.p.people, 0.99);
  assert.strictEqual(saved.choices.audience.c, 'Women');
  const [ask] = a.asks();
  assert.strictEqual(ask.init.headers.Authorization, 'Bearer k1');
  assert.strictEqual(ask.init.headers['TypeSafe-Danger-Zone-Images'], 'true');
  const body = JSON.parse(ask.init.body);
  assert.strictEqual(body.model, 'jev-1.14.0');
  assert.strictEqual(Object.keys(body.assets).length, 3);
  for (const k of ['product_photo', 'second_product_photo', 'ad_picture']) assert.ok(body.assets[body.state[k]], k);
  assert.strictEqual(body.state.product.description, 'Calm capsules', 'no HTML');
  assert.deepStrictEqual(body.state.product.options, ['Size'], "Shopify's dummy option is left out");
  assert.strictEqual(body.state.product.price, 42);
  assert.deepStrictEqual(body.state.ads.texts, ['Tired of waking up?']);
  assert.deepStrictEqual(body.state.ads.countries, ['NZ']);
  assert.ok(body.questions.ad_score);
});

test('checkProduct: no ad, no ad questions; a page or an ad picture that fails only leaves that out', async () => {
  const none = api();
  const r = await checkProduct({ ...PRODUCT, ads: {} }, { key: 'k', doFetch: none.doFetch, pause });
  assert.strictEqual(r.ad_score, null);
  assert.ok(!JSON.parse(none.asks()[0].init.body).questions.ad_score);
  const noPage = api(OK, { page: () => json({}, 404) });
  assert.strictEqual((await checkProduct(PRODUCT, { key: 'k', doFetch: noPage.doFetch, pause })).used, 'photo, ad image, ad text, ad title');
  const expired = api(OK, { photo: (u) => (/scontent/.test(u) ? new Response('gone', { status: 403 }) : new Response(jpg())) });
  assert.doesNotMatch((await checkProduct(PRODUCT, { key: 'k', doFetch: expired.doFetch, pause })).used, /ad image/);
  const fbDown = api(OK, { photo: (u) => { if (/scontent/.test(u)) throw new Error('down'); return new Response(jpg()); } });
  assert.doesNotMatch((await checkProduct(PRODUCT, { key: 'k', doFetch: fbDown.doFetch, pause })).used, /ad image/, 'the ad picture is extra: no failure');
});

test('sizeOf and photoAsset: only pictures Jev accepts go along; Shopify converts the rest; a server that is down is no "no photo"', async () => {
  assert.deepStrictEqual(sizeOf(jpg(800, 600)), { w: 800, h: 600 });
  assert.deepStrictEqual(sizeOf(png()), { w: 800, h: 600 });
  assert.strictEqual(sizeOf(WEBP), null);
  assert.strictEqual((await photoAsset(IMG, { doFetch: async () => new Response(png()) })).format, 'png');
  assert.strictEqual(await photoAsset(IMG, { doFetch: async () => new Response(jpg(200, 200)) }), null, 'too small');
  assert.strictEqual(await photoAsset(IMG, { doFetch: async () => new Response(jpg(800, 2000)) }), null, 'too tall');
  const asked = [];
  const webp = await photoAsset(IMG, { doFetch: async (u) => { asked.push(u); return new Response(/format=jpg/.test(u) ? jpg() : WEBP); } });
  assert.strictEqual(webp.format, 'jpg');
  assert.strictEqual(asked.length, 2);
  assert.strictEqual(await photoAsset('https://other.test/a.webp', { doFetch: async () => new Response(WEBP) }), null, 'not on Shopify: no conversion');
  assert.strictEqual(await photoAsset('http://cdn.shopify.com/a.png', { doFetch: async () => new Response(png()) }), null, 'https only');
  assert.strictEqual(await photoAsset('not a url'), null);
  assert.strictEqual(await photoAsset(IMG, { doFetch: async () => new Response('gone', { status: 404 }) }), null);
  await assert.rejects(photoAsset(IMG, { doFetch: async () => { throw new Error('down'); } }), JevError);
  await assert.rejects(photoAsset(IMG, { doFetch: async () => new Response('busy', { status: 503 }) }), JevError);
  assert.strictEqual(await photoAsset(IMG, { must: false, doFetch: async () => { throw new Error('down'); } }), null);
  const own = [];
  assert.strictEqual((await photoAsset('https://shop.test/cdn/shop/files/a.webp?height=90&crop=center', { doFetch: async (u) => { own.push(u); return new Response(/format=jpg/.test(u) ? jpg() : WEBP); } })).format, 'jpg');
  assert.match(own[0], /width=768/);
  assert.doesNotMatch(own[0], /height=|crop=/);
});

test('productPage: waits once on 429; anything else simply gives no page', async () => {
  let n = 0;
  const p = await productPage('s.test/products/a', { doFetch: async () => (++n === 1 ? json({}, 429) : json({ product: { body_html: 'x', images: [{ src: 'a' }] } })), pause });
  assert.strictEqual(p.description, 'x');
  assert.strictEqual(n, 2);
  assert.strictEqual(await productPage('s.test/a'), null);
  assert.strictEqual(await productPage('s.test/products/a', { doFetch: async () => { throw new Error('down'); }, pause }), null);
  assert.strictEqual(await productPage('s.test/products/a', { doFetch: async () => new Response('<html>'), pause }), null);
});

test('categoryOf: the main category is the sum of its subs, so three weak pet answers beat one stronger home answer', () => {
  const r = categoryOf({ probabilities: { [`Pets${SEP}Grooming`]: 0.2, [`Pets${SEP}Cat toys`]: 0.2, [`Pets${SEP}Dog toys`]: 0.2, [`Home${SEP}Lighting`]: 0.4 } });
  assert.strictEqual(r.main, 'Pets');
  assert.strictEqual(r.main_conf, 0.6);
  assert.throws(() => categoryOf({ probabilities: { 'Nope > x': 1 } }), JevError);
  assert.throws(() => categoryOf({}), (e) => e.stop);
});

test('checkProduct: refused pictures fall back to the words; waits and asks again on 429 and overload; a changed format stops', async () => {
  const refused = api((body) => (body.assets ? json({ detail: 'Invalid image dimensions.' }, 400) : OK(body)));
  const r = await checkProduct(PRODUCT, { key: 'k', doFetch: refused.doFetch, pause });
  assert.strictEqual(r.input, 'title');
  assert.strictEqual(refused.asks()[1].init.headers['TypeSafe-Danger-Zone-Images'], undefined);
  const words = JSON.parse(refused.asks()[1].init.body);
  assert.strictEqual(words.state.ad_picture, undefined, 'no reference to a picture that is not sent');
  assert.strictEqual((await checkProduct(PRODUCT, { key: 'k', doFetch: api((body) => (body.assets ? json({}, 413) : OK(body))).doFetch, pause })).input, 'title', 'too big: the words too');
  await assert.rejects(checkProduct(PRODUCT, { key: 'k', doFetch: api(OK, { photo: () => { throw new Error('down'); } }).doFetch, pause }), (e) => e instanceof JevError && !e.stop, 'the main photo down: no words-only answer for good');
  await assert.rejects(checkProduct(PRODUCT, { key: 'k', doFetch: api(() => new Response('<html>')).doFetch, pause }), (e) => e instanceof JevError && !e.stop, 'an unreadable answer: only this product');

  const waits = [];
  let n = 0;
  const busy = api((body) => (++n === 1 ? json({}, 429, { 'retry-after': '7' }) : n === 2 ? json({}, 529) : OK(body)));
  assert.strictEqual((await checkProduct(PRODUCT, { key: 'k', doFetch: busy.doFetch, pause: async (ms) => { waits.push(ms); } })).input, 'photo');
  assert.deepStrictEqual(waits, [7000, 6000]);

  const broken = (change) => api((body) => json({ answers: { ...answers(body), ...change }, usage: {} })).doFetch;
  await assert.rejects(checkProduct(PRODUCT, { key: 'k', doFetch: api(() => json({}, 401)).doFetch, pause }), (e) => e instanceof JevError && e.stop && e.status === 401);
  await assert.rejects(checkProduct(PRODUCT, { key: 'k', doFetch: broken({ people: { noul: 'yes' } }), pause }), (e) => e.stop);
  await assert.rejects(checkProduct(PRODUCT, { key: 'k', doFetch: broken({ audience: { choice: '<b>new</b>' } }), pause }), (e) => e.stop);
  await assert.rejects(checkProduct(PRODUCT, { key: 'k', doFetch: broken({ product_score: {} }), pause }), (e) => e.stop);
  await assert.rejects(checkProduct(PRODUCT, { key: 'k', doFetch: api(() => json({}, 500)).doFetch, pause }), (e) => e instanceof JevError && !e.stop);
});

async function db() {
  const mem = memoryDb();
  const client = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(mem).doFetch, retryMs: 0 });
  const dir = new URL('../worker/migrations/', import.meta.url);
  await migrate(client, fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort().map((f) => fs.readFileSync(new URL(f, dir), 'utf8')));
  return { mem, client };
}
const addProduct = (mem, key, active = 1) => mem.prepare("INSERT INTO world_products (product_key, ad_id, active, product_title, image_url, store_url, first_seen, markets, ads, days) VALUES (?, ?, ?, ?, ?, 'https://s.test', '2026-10-31', '{\"AU\":{\"ads\":2}}', 2, 40)").run(key, 'w' + key, active, 'P ' + key, IMG);
const stateOf = (mem) => JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'world_check'").get().value);

test('checkAll: EU products get answers too, once per product, after the ones outside the EU; a gone picture is no reason to skip', async () => {
  const { mem, client } = await db();
  addProduct(mem, 's.test/products/world');
  const put = mem.prepare("INSERT INTO winners (ad_id, product_title, advertiser, advertiser_page_id, active_ads, ad_age_days, reach_eu, image_url, store_url, product_url, first_seen, last_seen, data) VALUES (?, ?, 'Shop', '7', 200, 20, 400000, ?, 'https://eu.test', ?, '2026-10-31', '2026-10-31', '{}')");
  put.run('1', 'Pod', 'https://scontent.test/gone.jpg', 'https://eu.test/products/pod');
  put.run('2', 'Pod', '', 'https://eu.test/products/pod');
  put.run('3', 'Lamp', '', 'https://eu.test/');
  const now = () => Date.UTC(2026, 10, 1);
  const a = api(OK, { photo: (u) => (/scontent/.test(u) ? new Response('gone', { status: 403 }) : new Response(jpg())) });
  const t = await checkAll({ db: client, key: 'k', doFetch: a.doFetch, pause, atOnce: 1, log: () => {}, now });
  assert.deepStrictEqual({ c: t.checked, s: t.skipped, l: t.left }, { c: 3, s: 0, l: 0 });
  const keys = mem.prepare('SELECT product_key, input FROM world_checks ORDER BY product_key').all().map((r) => r.product_key);
  assert.deepStrictEqual(keys, ['eu|7|lamp', 'eu|7|pod', 's.test/products/world']);
  assert.strictEqual(JSON.parse(a.asks()[0].init.body).state.product.name, 'P s.test/products/world', 'outside the EU first');
  assert.strictEqual((await checkAll({ db: client, key: 'k', doFetch: api().doFetch, pause, log: () => {}, now })).checked, 0, 'once');
});

test('the queries stay cheap: D1 counts every row read, and a scan per product took the board down on 1 Nov 2026', async () => {
  const { mem } = await db();
  const plan = (sql) => mem.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail).join(' | ');
  assert.doesNotMatch(plan(TODO_SQL), /CORRELATED/, 'no subquery per product');
  assert.match(plan("UPDATE world_ads INDEXED BY world_ads_store_title SET product_key = 'x', guessed = 1 WHERE store = 'a' AND title = 'b' AND product_key = ''"), /USING INDEX world_ads_store_title/);
  assert.match(fs.readFileSync(new URL('../world.mjs', import.meta.url), 'utf8'), /UPDATE world_ads INDEXED BY world_ads_store_title SET/, 'the hunt names the index: with an empty key the planner can pick the other one');
  // Measured, not assumed: with 2,000 ads and 500 products the query reads each table about once.
  const addAd = mem.prepare("INSERT INTO world_ads (ad_id, cc, title, body, product_key) VALUES (?, 'AU', 't', ?, ?)");
  for (let i = 0; i < 500; i++) addProduct(mem, 's.test/products/p' + i);
  for (let i = 0; i < 2000; i++) addAd.run(String(i), i % 50 ? '' : 'words', 's.test/products/p' + (i % 500));
  assert.strictEqual(mem.prepare(TODO_SQL).all().length, 500);
});

test('adsOf: unique words, the ad with the most copies first, and the markets', () => {
  const a = adsOf([{ title: 'A', body: 'x', image_url: '' }, { title: 'A', body: 'y', image_url: 'https://i' }, { title: 'B', body: '', image_url: 'https://j' }], { markets: '{"AU":{},"NZ":{}}', ads: 3, days: 9, new14: 1, creatives: 2 });
  assert.deepStrictEqual(a, { titles: ['A', 'B'], texts: ['x', 'y'], image: 'https://i', countries: ['AU', 'NZ'], count: 3, days: 9, new14: 1, creatives: 2 });
  assert.deepStrictEqual(adsOf([], { markets: 'nope' }).countries, []);
});

test('checkAll: active products, saved with all answers; asked again when the questions change, and once when ad words appear', async () => {
  const { mem, client } = await db();
  addProduct(mem, 's.test/products/a');
  addProduct(mem, 's.test/products/b');
  addProduct(mem, 's.test/products/gone', 0);
  mem.prepare("INSERT INTO world_ads (ad_id, cc, title, body, image_url, product_key, copies) VALUES ('1', 'AU', 'Ad title', '', 'https://scontent.test/1.jpg', 's.test/products/a', 3)").run();
  const before = mem.prepare('SELECT COUNT(*) AS n FROM world_products').get().n;
  const a = api();
  const t = await checkAll({ db: client, key: 'k', doFetch: a.doFetch, pause, log: () => {}, now: () => Date.UTC(2026, 10, 1) });
  assert.deepStrictEqual({ c: t.checked, s: t.skipped, l: t.left, st: t.stopped }, { c: 2, s: 0, l: 0, st: '' });
  const rows = mem.prepare('SELECT * FROM world_checks ORDER BY product_key').all();
  assert.deepStrictEqual(rows.map((r) => [r.product_key, r.main, r.sub, r.version, r.product_score, r.checked_at]), [
    ['s.test/products/a', 'Pets', 'Food and treats', VERSION, 2.5, '2026-11-01T00:00:00.000Z'],
    ['s.test/products/b', 'Pets', 'Food and treats', VERSION, 2.5, '2026-11-01T00:00:00.000Z']]);
  assert.strictEqual(rows[0].ad_score, 2.5, 'it has an ad');
  assert.strictEqual(rows[1].ad_score, null, 'it has none');
  assert.ok(JSON.parse(rows[0].answers).p.face != null);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_products').get().n, before);
  assert.strictEqual(stateOf(mem).checked, 2);

  const again = api();
  assert.strictEqual((await checkAll({ db: client, key: 'k', doFetch: again.doFetch, pause, log: () => {} })).checked, 0);
  assert.strictEqual(again.calls.length, 0, 'nothing new: nothing asked');

  mem.prepare("UPDATE world_ads SET body = 'Tired?' WHERE ad_id = '1'").run();
  assert.strictEqual((await checkAll({ db: client, key: 'k', doFetch: api().doFetch, pause, log: () => {} })).checked, 1, "the ad's words are known now");
  assert.strictEqual(mem.prepare("SELECT ad_text FROM world_checks WHERE product_key = 's.test/products/a'").get().ad_text, 1);
  assert.strictEqual((await checkAll({ db: client, key: 'k', doFetch: api().doFetch, pause, log: () => {} })).checked, 0, 'and only once');

  mem.prepare('UPDATE world_checks SET version = 1').run();
  assert.strictEqual((await checkAll({ db: client, key: 'k', doFetch: api().doFetch, pause, log: () => {} })).checked, 2, 'an older question set');
  assert.match(SAVE_SQL, /ON CONFLICT/);
});

test('checkAll: no key asks nothing; a refused key stops the run, what is done stays; other failures skip one product; a D1 failure is a real failure', async () => {
  const { mem, client } = await db();
  for (const k of ['a', 'b', 'c', 'd', 'e']) addProduct(mem, 's.test/products/' + k);
  const none = api();
  const nokey = await checkAll({ db: client, key: '', doFetch: none.doFetch, pause, log: () => {} });
  assert.deepStrictEqual({ c: nokey.checked, st: nokey.stopped }, { c: 0, st: 'no TYPESAFE_API_KEY' });
  assert.strictEqual(none.calls.length, 0);
  assert.strictEqual(stateOf(mem).stopped, 'no TYPESAFE_API_KEY', 'the board can say so');

  let n = 0;
  const refused = api((body) => (++n === 1 ? OK(body) : json({}, 401)));
  const t = await checkAll({ db: client, key: 'k', doFetch: refused.doFetch, pause, atOnce: 1, log: () => {} });
  assert.deepStrictEqual({ c: t.checked, st: t.stopped, l: t.left, s: t.skipped }, { c: 1, st: 'the API key was refused', l: 4, s: 1 });
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_checks').get().n, 1);
  assert.strictEqual(stateOf(mem).stopped, 'the API key was refused');

  const flaky = api((body) => (body.state.product.name.endsWith('/b') ? json({}, 500) : OK(body)));
  const t2 = await checkAll({ db: client, key: 'k', doFetch: flaky.doFetch, pause, atOnce: 1, log: () => {} });
  assert.deepStrictEqual({ c: t2.checked, s: t2.skipped, l: t2.left, st: t2.stopped }, { c: 3, s: 1, l: 1, st: '' });

  for (let i = 0; i < 12; i++) addProduct(mem, 's.test/products/x' + i);
  const t3 = await checkAll({ db: client, key: 'k', doFetch: api(() => json({}, 500)).doFetch, pause, atOnce: 1, log: () => {} });
  assert.match(t3.stopped, /10 failures in a row/);
  assert.strictEqual(t3.skipped, 10);
  mem.prepare("DELETE FROM world_products WHERE product_key LIKE '%/x%' OR product_key LIKE '%/b'").run();

  const broke = { query: async (sql, p) => { if (/INSERT INTO world_checks/.test(sql)) throw new Error('D1 down'); return client.query(sql, p); }, setState: client.setState };
  mem.prepare('DELETE FROM world_checks').run();
  await assert.rejects(checkAll({ db: broke, key: 'k', doFetch: api().doFetch, pause, log: () => {} }), /D1 down/);

  let once = true;
  const blip = { query: async (sql, p) => { if (/INSERT INTO world_checks/.test(sql) && once) { once = false; throw new Error('blip'); } return client.query(sql, p); }, setState: client.setState };
  for (let i = 0; i < 60; i++) addProduct(mem, 's.test/products/y' + i);
  await assert.rejects(checkAll({ db: blip, key: 'k', doFetch: api().doFetch, pause, atOnce: 1, log: () => {} }), /blip/);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_checks').get().n, 50, 'the first 50 answers survive the failed save');
});

const row = (check, title = 'x') => worldRow({ product_key: 'k' + title, ad_id: 'w1', active: 1, product_title: title, markets: '{}' }, check);
const full = (o = {}) => ({ product_key: 'k', people: 0.01, animals: 0.01, gymwear: 0.01, physical: 0.98, category: 'Home', main: 'Home', sub: 'Lighting', main_conf: 0.9, sub_conf: 0.8, product_score: 3.2, ad_score: 1.5, input: 'photo', used: 'photo',
  answers: JSON.stringify({ p: { people: 0.01, animals: 0.01, gymwear: 0.01, physical: 0.98, face: 0.01, electric: 0.9, problem: 0.8 }, choices: { audience: { c: 'Women', conf: 0.9 } }, scores: {} }), ...o });

test('board: the filter, flags at 0.5, an older answer, and the alert', () => {
  const c = row(full()).jev;
  assert.deepStrictEqual(jevFlags(c), []);
  assert.ok(jevMatches('main:Home', c) && !jevMatches('main:Pets', c));
  assert.ok(jevMatches(`sub:Home${SEP}Lighting`, c) && !jevMatches(`sub:Home${SEP}Bathroom`, c));
  assert.ok(jevMatches('yes:electric', c) && !jevMatches('yes:face', c));
  assert.ok(jevMatches('choice:audience:Women', c) && !jevMatches('choice:audience:Men', c));
  assert.ok(jevMatches('pmin:3', c) && !jevMatches('amin:3', c));
  assert.ok(!jevMatches('noblock', c), 'it has a battery');
  assert.ok(jevMatches('clean', c) && !jevMatches('clean', null));
  assert.ok(jevMatches('none', null) && !jevMatches('none', c));
  const flagged = row(full({ people: 0.99, physical: 0.4, answers: JSON.stringify({ p: { people: 0.99, physical: 0.4, face: 0.7 }, choices: {} }) })).jev;
  assert.deepStrictEqual(jevFlags(flagged), ['people', 'digital', 'face']);
  assert.ok(jevMatches('unsure', flagged) && !jevMatches('unsure', c));
  const old = row({ product_key: 'k', people: 0.99, animals: 0.01, gymwear: 0.01, physical: 0.98, category: 'pet', input: 'photo' }).jev;
  assert.strictEqual(old.main, 'pet', 'answered by the first question set: still shows');
  assert.deepStrictEqual(jevFlags(old), ['people']);
  const now = Date.UTC(2026, 10, 1);
  const fine = { health: 'ok', finished_at: new Date(now - 3600e3).toISOString() };
  assert.strictEqual(worldAlert(fine, now, null, { stopped: '' }), null);
  assert.deepStrictEqual(worldAlert(fine, now, null, { stopped: 'no balance left' }), { level: 'yellow', text: 'Jev-check gestopt / Jev check stopped: no balance left' });
});

test('board: the breakdown counts the answers and sorts by count; the CSV has them all', () => {
  const rows = [row(full(), 'a'), row(full({ main: 'Pets', sub: 'Grooming' }), 'b'), row(full({ main: 'Pets', sub: 'Grooming', product_score: 1 }), 'c'), row(null, 'd')];
  const j = jevSummary(rows);
  assert.strictEqual(j.total, 4);
  assert.strictEqual(j.checked, 3);
  assert.deepStrictEqual(j.mains.map((m) => [m.name, m.n]), [['Pets', 2], ['Home', 1]]);
  assert.deepStrictEqual(j.mains[0].subs, [{ name: 'Grooming', n: 2 }]);
  assert.strictEqual(j.blockers[0].k, 'electric');
  assert.strictEqual(j.blockers[0].n, 3);
  assert.strictEqual(j.product[0].k, 'problem');
  assert.strictEqual(j.pStrong, 2);
  assert.strictEqual(j.noBlock, 0);
  assert.deepStrictEqual(j.choices.find((x) => x.k === 'audience').items, [{ name: 'Women', n: 3 }]);
  const csv = toCsv([{ jev: row(full()).jev }, { jev: null }, {}]).split('\r\n');
  const head = csv[0].split(',');
  const at = (k, line) => csv[line].split(',')[head.indexOf(k)];
  assert.strictEqual(at('jev_main', 1), 'Home');
  assert.strictEqual(at('jev_electric', 1), '0.9');
  assert.strictEqual(at('jev_audience', 1), 'Women');
  assert.strictEqual(at('jev_main', 2), '');
});
