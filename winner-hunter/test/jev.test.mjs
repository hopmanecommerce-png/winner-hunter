// Jev's answers (lib/jev.mjs, world-check.mjs) on a fake TypeSafe API and fake shops, and what the board does with them.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { d1Client, migrate } from '../lib/d1.mjs';
import { checkProduct, photoAsset, JevError, QUESTIONS } from '../lib/jev.mjs';
import { checkAll, SAVE_SQL } from '../world-check.mjs';
import { jevFlags, jevMatches, worldAlert, toCsv } from '../worker/src/app.mjs';
import { d1Rest, memoryDb } from './helpers/sqlite-d1.mjs';

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]);
const WEBP = Buffer.from('RIFFxxxxWEBPyyy');
const ANSWERS = { people: { type: 'noul', noul: 0.99 }, animals: { type: 'noul', noul: 0.01 }, gymwear: { type: 'noul', noul: 0.02 }, physical: { type: 'noul', noul: 0.98 }, category: { type: 'choice', choice: 'food or supplement', confidence: 1, probabilities: {} } };
const json = (x, status = 200, headers = {}) => new Response(JSON.stringify(x), { status, headers });
const OK = () => json({ model: 'jev-1.14.0', answers: ANSWERS, usage: { input_tokens: 2400, output_tokens: 200 } });
const IMG = 'https://cdn.shopify.com/s/files/a.png?v=1';
const pause = async () => {};

function api(answer = OK, photo = () => new Response(JPG)) {
  const calls = [];
  const doFetch = async (url, init = {}) => {
    calls.push({ url, init });
    return String(url).startsWith('https://api.typesafe.ai/') ? answer(JSON.parse(init.body), init, calls) : photo(url);
  };
  return { calls, doFetch, asks: () => calls.filter((c) => String(c.url).startsWith('https://api.typesafe.ai/')) };
}

test('checkProduct: the name, type, shop and photo go to Jev with the image header and the key; the answers come back as numbers', async () => {
  const a = api();
  const r = await checkProduct({ title: 'She Again', type: '', store: 'https://nova.test', image: IMG }, { key: 'k1', doFetch: a.doFetch, pause });
  assert.deepStrictEqual(r, { input: 'photo', model: 'jev-1.14.0', people: 0.99, animals: 0.01, gymwear: 0.02, physical: 0.98, category: 'food or supplement', category_conf: 1, tokens: 2400 });
  const [ask] = a.asks();
  assert.strictEqual(ask.init.headers.Authorization, 'Bearer k1');
  assert.strictEqual(ask.init.headers['TypeSafe-Danger-Zone-Images'], 'true');
  const body = JSON.parse(ask.init.body);
  assert.strictEqual(body.model, 'jev-1.14.0');
  assert.strictEqual(body.state.product_name, 'She Again');
  assert.strictEqual(body.assets[body.state.picture].format, 'jpg');
  assert.strictEqual(body.assets[body.state.picture].data_base64, JPG.toString('base64'));
  assert.deepStrictEqual(Object.keys(body.questions), Object.keys(QUESTIONS));
  assert.match(a.calls[0].url, /width=768/);
});

test('photoAsset: PNG and JPEG as they are, Shopify converts the rest, anything else is no photo', async () => {
  assert.strictEqual((await photoAsset(IMG, { doFetch: async () => new Response(PNG) })).format, 'png');
  const asked = [];
  const webp = await photoAsset(IMG, { doFetch: async (u) => { asked.push(u); return new Response(/format=jpg/.test(u) ? JPG : WEBP); } });
  assert.strictEqual(webp.format, 'jpg');
  assert.strictEqual(asked.length, 2);
  assert.strictEqual(await photoAsset('https://other.test/a.webp', { doFetch: async () => new Response(WEBP) }), null, 'not on Shopify: no conversion');
  assert.strictEqual(await photoAsset('http://cdn.shopify.com/a.png', { doFetch: async () => new Response(PNG) }), null, 'https only');
  assert.strictEqual(await photoAsset('not a url'), null);
  assert.strictEqual(await photoAsset(IMG, { doFetch: async () => new Response('gone', { status: 404 }) }), null);
  await assert.rejects(photoAsset(IMG, { doFetch: async () => { throw new Error('down'); } }), JevError, 'down now is not "no photo"');
  await assert.rejects(photoAsset(IMG, { doFetch: async () => new Response('busy', { status: 503 }) }), JevError);
  const own = [];
  assert.strictEqual((await photoAsset('https://shop.test/cdn/shop/files/a.webp?height=90&crop=center', { doFetch: async (u) => { own.push(u); return new Response(/format=jpg/.test(u) ? JPG : WEBP); } })).format, 'jpg', "a photo on the shop's own domain is Shopify's too");
  assert.match(own[0], /width=768/);
  assert.doesNotMatch(own[0], /height=|crop=/);
});

test('checkProduct: a refused or missing photo falls back to the title; waits and asks again on 429 and overload; a changed format stops', async () => {
  const refused = api((body) => (body.assets ? json({ detail: 'Invalid image dimensions.' }, 400) : OK()));
  assert.strictEqual((await checkProduct({ title: 'x', image: IMG }, { key: 'k', doFetch: api((body) => (body.assets ? json({}, 413) : OK())).doFetch, pause })).input, 'title', 'too big: the title too');
  await assert.rejects(checkProduct({ title: 'x', image: IMG }, { key: 'k', doFetch: api(OK, () => { throw new Error('down'); }).doFetch, pause }), (e) => e instanceof JevError && !e.stop, 'the photo server down: no title-only answer for good');
  await assert.rejects(checkProduct({ title: 'x', image: IMG }, { key: 'k', doFetch: api(() => new Response('<html>')).doFetch, pause }), (e) => e instanceof JevError && !e.stop, 'an unreadable answer: only this product');
  const r = await checkProduct({ title: 'x', image: IMG }, { key: 'k', doFetch: refused.doFetch, pause });
  assert.strictEqual(r.input, 'title');
  assert.strictEqual(refused.asks()[1].init.headers['TypeSafe-Danger-Zone-Images'], undefined);
  assert.strictEqual((await checkProduct({ title: 'x', image: '' }, { key: 'k', doFetch: api().doFetch, pause })).input, 'title');

  const waits = [];
  let n = 0;
  const busy = api(() => (++n === 1 ? json({}, 429, { 'retry-after': '7' }) : n === 2 ? json({}, 529) : OK()));
  assert.strictEqual((await checkProduct({ title: 'x', image: IMG }, { key: 'k', doFetch: busy.doFetch, pause: async (ms) => { waits.push(ms); } })).input, 'photo');
  assert.deepStrictEqual(waits, [7000, 6000]);

  await assert.rejects(checkProduct({ title: 'x', image: IMG }, { key: 'k', doFetch: api(() => json({}, 401)).doFetch, pause }), (e) => e instanceof JevError && e.stop && e.status === 401);
  await assert.rejects(checkProduct({ title: 'x', image: IMG }, { key: 'k', doFetch: api(() => json({ answers: { ...ANSWERS, people: { noul: 'yes' } }, usage: {} })).doFetch, pause }), (e) => e.stop);
  await assert.rejects(checkProduct({ title: 'x', image: IMG }, { key: 'k', doFetch: api(() => json({ answers: { ...ANSWERS, category: { choice: '<b>new</b>' } }, usage: {} })).doFetch, pause }), (e) => e.stop);
  await assert.rejects(checkProduct({ title: 'x', image: IMG }, { key: 'k', doFetch: api(() => json({}, 500)).doFetch, pause }), (e) => e instanceof JevError && !e.stop);
});

async function db() {
  const mem = memoryDb();
  const client = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(mem).doFetch, retryMs: 0 });
  const dir = new URL('../worker/migrations/', import.meta.url);
  await migrate(client, fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort().map((f) => fs.readFileSync(new URL(f, dir), 'utf8')));
  return { mem, client };
}
const addProduct = (mem, key, active = 1) => mem.prepare("INSERT INTO world_products (product_key, ad_id, active, product_title, image_url, store_url, first_seen) VALUES (?, ?, ?, ?, ?, 'https://s.test', '2026-10-31')").run(key, 'w' + key, active, 'P ' + key, IMG);

test('checkAll: each active product once, saved in world_checks, nothing else changes; the run is on record', async () => {
  const { mem, client } = await db();
  addProduct(mem, 's.test/products/a');
  addProduct(mem, 's.test/products/b');
  addProduct(mem, 's.test/products/gone', 0);
  const before = mem.prepare('SELECT COUNT(*) AS n FROM world_products').get().n;
  const a = api();
  const t = await checkAll({ db: client, key: 'k', doFetch: a.doFetch, pause, log: () => {}, now: () => Date.UTC(2026, 10, 1) });
  assert.deepStrictEqual({ c: t.checked, s: t.skipped, l: t.left, st: t.stopped }, { c: 2, s: 0, l: 0, st: '' });
  const rows = mem.prepare('SELECT * FROM world_checks ORDER BY product_key').all();
  assert.deepStrictEqual(rows.map((r) => [r.product_key, r.people, r.category, r.input, r.tokens, r.checked_at]), [
    ['s.test/products/a', 0.99, 'food or supplement', 'photo', 2400, '2026-11-01T00:00:00.000Z'],
    ['s.test/products/b', 0.99, 'food or supplement', 'photo', 2400, '2026-11-01T00:00:00.000Z']]);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_products').get().n, before);
  assert.ok(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'world_check'").get().value).checked === 2);
  const again = api();
  assert.strictEqual((await checkAll({ db: client, key: 'k', doFetch: again.doFetch, pause, log: () => {} })).checked, 0);
  assert.strictEqual(again.calls.length, 0, 'asked once per product');
  assert.match(SAVE_SQL, /ON CONFLICT/);
});

test('checkAll: no key asks nothing; a refused key stops the run, what is done stays; other failures skip one product; a D1 failure is a real failure', async () => {
  const { mem, client } = await db();
  for (const k of ['a', 'b', 'c', 'd', 'e']) addProduct(mem, 's.test/products/' + k);
  const none = api();
  const nokey = await checkAll({ db: client, key: '', doFetch: none.doFetch, pause, log: () => {} });
  assert.deepStrictEqual({ c: nokey.checked, st: nokey.stopped }, { c: 0, st: 'no TYPESAFE_API_KEY' });
  assert.strictEqual(none.calls.length, 0);
  assert.strictEqual(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'world_check'").get().value).stopped, 'no TYPESAFE_API_KEY', 'the board can say so');

  let n = 0;
  const refused = api(() => (++n === 1 ? OK() : json({}, 401)));
  const t = await checkAll({ db: client, key: 'k', doFetch: refused.doFetch, pause, atOnce: 1, log: () => {} });
  assert.deepStrictEqual({ c: t.checked, st: t.stopped, l: t.left, s: t.skipped }, { c: 1, st: 'the API key was refused', l: 4, s: 1 });
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_checks').get().n, 1);
  assert.strictEqual(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'world_check'").get().value).stopped, 'the API key was refused');

  // One product fails, the rest go on; it stays on the list for the next run.
  const flaky = api((body) => (body.state.product_name.endsWith('/b') ? json({}, 500) : OK()));
  const t2 = await checkAll({ db: client, key: 'k', doFetch: flaky.doFetch, pause, atOnce: 1, log: () => {} });
  assert.deepStrictEqual({ c: t2.checked, s: t2.skipped, l: t2.left, st: t2.stopped }, { c: 3, s: 1, l: 1, st: '' });

  // Ten failures in a row: stop asking.
  for (let i = 0; i < 12; i++) addProduct(mem, 's.test/products/x' + i);
  const dead = api(() => json({}, 500));
  const t3 = await checkAll({ db: client, key: 'k', doFetch: dead.doFetch, pause, atOnce: 1, log: () => {} });
  assert.match(t3.stopped, /10 failures in a row/);
  assert.strictEqual(t3.skipped, 10);
  mem.prepare("DELETE FROM world_products WHERE product_key LIKE '%/x%' OR product_key LIKE '%/b'").run();

  const broke = { query: async (sql) => { if (/INSERT INTO world_checks/.test(sql)) throw new Error('D1 down'); return client.query(sql); }, setState: client.setState };
  mem.prepare('DELETE FROM world_checks').run();
  await assert.rejects(checkAll({ db: broke, key: 'k', doFetch: api().doFetch, pause, log: () => {} }), /D1 down/);

  // A batch that could not be saved is saved by the next try, so paid answers are not lost.
  let once = true;
  const blip = { query: async (sql, p) => { if (/INSERT INTO world_checks/.test(sql) && once) { once = false; throw new Error('blip'); } return client.query(sql, p); }, setState: client.setState };
  for (let i = 0; i < 60; i++) addProduct(mem, 's.test/products/y' + i);
  await assert.rejects(checkAll({ db: blip, key: 'k', doFetch: api().doFetch, pause, atOnce: 1, log: () => {} }), /blip/);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM world_checks').get().n, 50, 'the first 50 answers survive the failed save');
});

test('board: every category Jev can answer is in the filter', () => {
  const html = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
  for (const c of Object.keys(QUESTIONS.category.criteria)) assert.ok(html.includes(`value="cat:${c}"`), c);
});

test('board: flags at 0.5, the filter, the alert and the CSV', () => {
  const c = { people: 0.99, animals: 0.6, gymwear: 0.01, physical: 0.4, category: 'pet', input: 'photo' };
  assert.deepStrictEqual(jevFlags(c), ['people', 'animals', 'digital']);
  assert.deepStrictEqual(jevFlags(null), []);
  const clean = { people: 0.01, animals: 0.01, gymwear: 0.01, physical: 0.98, category: 'home' };
  assert.ok(jevMatches('clean', clean) && !jevMatches('clean', c) && !jevMatches('clean', null));
  assert.ok(jevMatches('none', null) && !jevMatches('none', clean));
  assert.ok(jevMatches('unsure', c) && !jevMatches('unsure', clean));
  assert.ok(jevMatches('cat:pet', c) && !jevMatches('cat:home', c));
  assert.ok(jevMatches('digital', c) && !jevMatches('gymwear', c));
  const now = Date.UTC(2026, 10, 1);
  const fine = { health: 'ok', finished_at: new Date(now - 3600e3).toISOString() };
  assert.strictEqual(worldAlert(fine, now, null, { stopped: '' }), null);
  assert.deepStrictEqual(worldAlert(fine, now, null, { stopped: 'no balance left' }), { level: 'yellow', text: 'Jev-check gestopt / Jev check stopped: no balance left' });
  const csv = toCsv([{ world: { markets: [], check: c } }, { world: { markets: [], check: null } }, {}]).split('\r\n');
  const head = csv[0].split(',');
  const at = (k, line) => csv[line].split(',')[head.indexOf(k)];
  assert.strictEqual(at('jev_people_eat_or_take', 1), '0.99');
  assert.strictEqual(at('jev_category', 1), 'pet');
  assert.strictEqual(at('jev_category', 2), '');
});
