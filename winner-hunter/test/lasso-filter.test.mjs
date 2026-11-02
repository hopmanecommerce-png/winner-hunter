// The board's "Lasso checkout" filter (worker/src/lasso.mjs): domain matching; the stores from D1 (the research list,
// migration 0080, and what the discovery job lasso.mjs saves later); ?lasso=1 on the Inbox and Browse of every tab, with
// its count; the card's data and the CSV column; /lasso.js. And the migration: it holds the research list, and running it
// again (every workflow runs every migration) changes nothing.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { registrable, lassoIndex, readLasso, attachLasso, lassoBoard, lassoView, lassoCard, LASSO_JS } from '../worker/src/lasso.mjs';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { statements, migrate, d1Client } from '../lib/d1.mjs';
import { discover, STORES_SQL } from '../lasso.mjs';
import { d1Rest, d1Binding, memoryDb } from './helpers/sqlite-d1.mjs';
import { googleEnv } from './helpers/google-seed.mjs';
import { NOW } from './helpers/seed.mjs';

const MIGRATIONS = new URL('../worker/migrations/', import.meta.url);
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const SEED = fs.readFileSync(new URL('0080_lasso_seed.sql', MIGRATIONS), 'utf8');
const pick = (e) => e && { store: e.store, sure: e.sure, at: e.at };

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

test('registrable: lowercase, no www, the registrable domain; a shop on a platform stays itself; no domain gives ""', () => {
  const cases = [
    ['fasciablaster.com', 'fasciablaster.com'],
    ['FasciaBlaster.COM', 'fasciablaster.com'],
    ['www.fasciablaster.com', 'fasciablaster.com'],
    ['www2.fasciablaster.com', 'fasciablaster.com'],
    ['https://www.FasciaBlaster.com/products/tool?x=1#y', 'fasciablaster.com'],
    ['http://shop.fasciablaster.com:8080/', 'fasciablaster.com'],
    ['  fasciablaster.com/collections/all  ', 'fasciablaster.com'],
    ['us.lounelle.com', 'lounelle.com'],
    ['au.maison-verdelle.com', 'maison-verdelle.com'],
    ['checkout.store.com.', 'store.com'],
    ['castellacookware.com.au', 'castellacookware.com.au'],
    ['www.shop.castellacookware.com.au', 'castellacookware.com.au'],
    ['lunafashionhouse.co.uk', 'lunafashionhouse.co.uk'],
    ['https://eu.lunafashionhouse.co.uk/x', 'lunafashionhouse.co.uk'],
    ['4216ec.myshopify.com', '4216ec.myshopify.com'],
    ['https://www.4216ec.myshopify.com/', '4216ec.myshopify.com'],
    ['edjvntge.uk', 'edjvntge.uk'],
    ['sleepbysanti.co', 'sleepbysanti.co'],
    ['bücher.de', 'xn--bcher-kva.de'],
    ['www-shop.com', 'www-shop.com'],
    ['', ''], [null, ''], [undefined, ''], ['localhost', ''], ['192.168.1.20', ''], ['https://[::1]/', ''],
    ['co.uk', ''], ['www.co.uk', ''], ['myshopify.com', ''], ['www.com', ''], ['not a domain', ''], ['javascript:alert(1)', ''],
  ];
  for (const [x, want] of cases) assert.strictEqual(registrable(x), want, JSON.stringify(x));
  assert.notStrictEqual(registrable('other.myshopify.com'), registrable('4216ec.myshopify.com'), 'two Shopify shops are two stores');
  assert.notStrictEqual(registrable('fasciablaster.com.evil.test'), 'fasciablaster.com', 'a look-alike is another domain');
});

test('the Lasso stores: high and medium count, low and gone do not; aliases find a store; its own domain and a sure store come first', () => {
  const idx = lassoIndex([
    { store: 'sure.test', confidence: 'high', checked_at: '2026-11-01T00:00:00.000Z', aliases: 'sure-alias.test www.sure-two.test;Sure-Three.test' },
    { store: 'likely.test', confidence: 'medium', checked_at: '2026-11-02T10:00:00.000Z' },
    { store: 'left.test', confidence: 'low', aliases: 'left-alias.test' },
    { store: 'gone.test', confidence: '' },
    { store: 'us.both.test', confidence: 'medium' },
    { store: 'both.test', confidence: 'high' },
    { store: 'claims.test', confidence: 'high', aliases: 'likely.test' },
    { store: 'junk', confidence: 'high', aliases: 'junk-alias.test' },
    { store: 'odd.test', confidence: 'maybe' },
    null,
  ]);
  assert.deepStrictEqual(pick(idx.get('sure.test')), { store: 'sure.test', sure: true, at: '2026-11-01' });
  for (const d of ['sure-alias.test', 'sure-two.test', 'sure-three.test']) assert.strictEqual(idx.get(d).store, 'sure.test', d);
  assert.deepStrictEqual(pick(idx.get('likely.test')), { store: 'likely.test', sure: false, at: '2026-11-02' }, 'its own domain, not another store\'s alias');
  assert.deepStrictEqual(pick(idx.get('both.test')), { store: 'both.test', sure: true, at: '' }, 'one domain, two stores: the sure one');
  for (const d of ['left.test', 'left-alias.test', 'gone.test', 'junk-alias.test', 'odd.test']) assert.ok(!idx.has(d), d + ': not on Lasso now');
  assert.strictEqual(idx.size, 7);
  assert.strictEqual(lassoIndex(null).size, 0);
});

test('a product matches by its store\'s registrable domain: through www, a subdomain or an alias; another shop or a look-alike does not', () => {
  const idx = lassoIndex([
    { store: 'fasciablaster.com', confidence: 'high', aliases: 'ashleyblackguru.com' },
    { store: '4216ec.myshopify.com', confidence: 'high', aliases: 'mueler-mode.com' },
    { store: 'us.lounelle.com', confidence: 'medium' },
  ]);
  const rows = [
    { store_url: 'https://www.fasciablaster.com/' },
    { store_url: 'https://shop.fasciablaster.com/' },
    { store_url: 'https://ashleyblackguru.com/' },
    { store_url: 'https://au.lounelle.com/' },
    { store_url: 'https://mueler-mode.com/' },
    { store_url: 'https://4216ec.myshopify.com/' },
    { store_url: 'https://other.myshopify.com/' },
    { store_url: 'https://fasciablaster.com.evil.test/' },
    { store_url: 'https://notfasciablaster.com/' },
    { store_url: '', product_url: 'https://www.fasciablaster.com/products/x' },
    { store_url: null },
  ];
  attachLasso(rows, idx);
  assert.deepStrictEqual(rows.map((r) => r.lasso && r.lasso.store),
    ['fasciablaster.com', 'fasciablaster.com', 'fasciablaster.com', 'us.lounelle.com', '4216ec.myshopify.com', '4216ec.myshopify.com', null, null, null, 'fasciablaster.com', null]);
  assert.deepStrictEqual(lassoCard(rows[3]), { store: 'us.lounelle.com', sure: false, at: '' });
  assert.strictEqual(lassoCard(rows[6]), null);
  assert.ok(attachLasso([{ store_url: 'https://fasciablaster.com/' }], new Map()).every((r) => r.lasso === null), 'no stores: nothing matches');
});

test('lassoBoard keeps every list a view reads; lassoView: the view, the count with the other filters, and no count for the CSV', () => {
  const a = { id: 'a', lasso: { store: 'x.test' } };
  const b = { id: 'b', lasso: null };
  const list = { v: [a, b], k: [a, b], w: [b, a], gl: [a], taste: { t: 1 }, rows: [a, b] };
  const only = lassoBoard(list);
  assert.deepStrictEqual([only.v, only.k, only.w, only.gl], [[a], [a], [a], [a]]);
  assert.strictEqual(only.taste, list.taste);
  assert.deepStrictEqual(list.v, [a, b], 'the board itself is left as it was');
  const seen = [];
  const view = (p, l) => (seen.push(l === list ? 'all' : 'lasso'), { total: l.v.length, rows: l.v });
  assert.deepStrictEqual(lassoView(new URLSearchParams('view=all'), list, view), { total: 2, rows: [a, b], lasso: 1 });
  assert.deepStrictEqual(lassoView(new URLSearchParams('view=all&lasso=1'), list, view), { total: 1, rows: [a], lasso: 1 });
  assert.deepStrictEqual(seen, ['all', 'lasso', 'lasso'], 'with the chip on, one view: its total is the count');
  seen.length = 0;
  assert.deepStrictEqual(lassoView(new URLSearchParams('view=all'), list, view, { count: false }), { total: 2, rows: [a, b] });
  assert.deepStrictEqual(seen, ['all']);
});

// ---------------------------------------------------------------------------
// The board: every tab, Inbox and Browse, with the stores from D1
// ---------------------------------------------------------------------------

const worldProduct = (key, id, o = {}) => ({ product_key: key, ad_id: id, active: 1, product_title: 'Product ' + id, price: 79, compare_at_price: 129, currency: 'AUD',
  image_url: '', store_url: `https://${key.split('/')[0]}/`, product_url: `https://${key}`, ad_library_url: `https://www.facebook.com/ads/library/?id=${id}`, advertiser: 'Shop ' + id,
  page_id: '77', likes: 900, keyword: 'pillow', markets: '{"AU":{"ads":1,"days":12,"new14":1}}', ads: 1, creatives: 1, days: 12, new14: 1, shop_ads: null, in_eu: null, store_products: 12,
  first_seen: new Date(NOW - 5 * 864e5).toISOString(), last_seen: new Date(NOW - 3600e3).toISOString(), ...o });

/** The sample board with Google products, three products outside the EU, and Lasso stores next to the research list. */
async function lassoEnv() {
  const env = await googleEnv();
  const put = (p) => env.db.prepare(`INSERT INTO world_products (${Object.keys(p).join(',')}) VALUES (${Object.keys(p).map(() => '?').join(',')})`).run(...Object.values(p));
  put(worldProduct('www.fasciablaster.com/products/tool', '1001', { product_title: 'FasciaBlaster Original Tool', in_eu: 0 })); // the research list: sure
  put(worldProduct('strong.test/products/pod', '1002', { product_title: 'Pillow Pod' }));
  put(worldProduct('mueler-mode.com/products/coat', '1003', { product_title: 'Wool Coat' })); // an alias of 4216ec.myshopify.com
  const store = env.db.prepare('INSERT INTO lasso_stores (store, confidence, live, aliases, checked_at) VALUES (?, ?, 1, ?, ?)');
  store.run('shop1.test', 'high', null, '2026-10-30T09:00:00.000Z');
  store.run('shop4-main.test', 'medium', 'shop4.test', '2026-10-31T09:00:00.000Z'); // shop4.test: an alias
  store.run('shop7.test', 'low', null, null); // left Lasso
  store.run('shop9.test', '', null, null); // checked again: no Lasso now
  store.run('posturepro-sample.example', 'high', null, null); // a shop only on the Google tab
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const get = async (path, now = NOW) => handle(new Request('https://board.test' + path, { headers: { cookie } }), env, { html: HTML, now });
  const ads = async (q, now) => (await get('/api/ads?' + q, now)).json();
  return Object.assign(env, { get, ads, cookie });
}

test('EU: ?lasso=1 keeps only Lasso stores\' products in Browse and the Inbox, with the count on every answer; the card says which store', async () => {
  const env = await lassoEnv();
  const all = await env.ads('view=all');
  assert.strictEqual(all.total, 28);
  assert.strictEqual(all.lasso, 4, 'shop1.test (3 products) and shop4.test (an alias of a likely store); not the store that left, not the gone one');
  const lassoIds = all.ads.filter((a) => a.lasso).map((a) => a.id).sort();
  assert.deepStrictEqual(lassoIds, ['9001', '9004', '9400', '9500']);
  assert.deepStrictEqual(all.ads.find((a) => a.id === '9004').lasso, { store: 'shop4-main.test', sure: false, at: '2026-10-31' });
  assert.deepStrictEqual(all.ads.find((a) => a.id === '9001').lasso, { store: 'shop1.test', sure: true, at: '2026-10-30' });
  assert.strictEqual(all.ads.find((a) => a.id === '9007').lasso, null, 'shop7.test left Lasso');
  assert.strictEqual(all.ads.find((a) => a.id === '9009').lasso, null, 'shop9.test has no Lasso now');

  const only = await env.ads('view=all&lasso=1');
  assert.deepStrictEqual([only.total, only.lasso], [4, 4]);
  assert.deepStrictEqual(only.ads.map((a) => a.id).sort(), lassoIds);
  const tabs = ({ fresh, ...c }) => c;
  assert.deepStrictEqual(tabs(only.counts), tabs(all.counts), 'the tabs keep their own counts');
  // With another filter: the count follows it.
  const lamp = await env.ads('view=all&q=lamp');
  assert.deepStrictEqual([lamp.total, lamp.lasso], [2, 1], 'two lamps, one from a Lasso store');
  assert.deepStrictEqual((await env.ads('view=all&q=lamp&lasso=1')).ads.map((a) => a.id), ['9004']);
  assert.deepStrictEqual([(await env.ads('view=all&q=linen')).total, (await env.ads('view=all&q=linen&lasso=1')).total], [1, 0]);

  const inbox = await env.ads('view=inbox&lasso=1');
  assert.deepStrictEqual([inbox.total, inbox.lasso], [4, 4]);
  assert.ok(inbox.ads.every((a) => a.lasso));
  assert.strictEqual(inbox.counts.fresh, inbox.ads.filter((a) => NOW - Date.parse(a.first_seen) < 864e5).length, '"new today" as the Inbox is filtered');
  assert.strictEqual((await env.ads('view=inbox')).counts.fresh, all.counts.fresh, 'without the chip: the whole Inbox');
  // A decision takes it out of the Inbox and out of the count.
  const res = await handle(new Request('https://board.test/api/hide', { method: 'POST', headers: { cookie: env.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ ad_id: '9004', status: 'rejected' }) }), env, { now: NOW });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual([(await env.ads('view=inbox')).lasso, (await env.ads('view=inbox&lasso=1')).total], [3, 3]);
  assert.strictEqual((await env.ads('view=all&hidden=1&lasso=1')).total, 1, 'Approved & rejected, from Lasso stores');
});

test('with the risk radar\'s Block products hidden (?risk=hide, the board\'s default), the filter and its count leave them out too', async () => {
  const env = await lassoEnv();
  env.db.prepare("INSERT INTO lasso_stores (store, confidence) VALUES ('shop11.test', 'high')").run();
  const shown = await env.ads('view=all&lasso=1');
  assert.ok(shown.ads.some((a) => a.id === '9011'), 'Anti-Snoring Mouthpiece: sold by a Lasso store');
  const hidden = await env.ads('view=all&lasso=1&risk=hide');
  assert.ok(!hidden.ads.some((a) => a.id === '9011'), 'blocked by the risk radar');
  assert.deepStrictEqual([hidden.total, hidden.lasso], [shown.total - 1, shown.lasso - 1]);
  assert.strictEqual((await env.ads('view=inbox&risk=hide')).lasso, shown.lasso - 1, 'the chip counts what the Inbox would show');
  const csv = await (await env.get('/export.csv?view=all&lasso=1&risk=hide')).text();
  assert.ok(!csv.includes('\r\n9011,') && csv.includes('\r\n9001,'));
});

test('outside the EU and Google: the same chip, the same filter; the research list finds a store through www and an alias', async () => {
  const env = await lassoEnv();
  const world = await env.ads('view=all&scope=world');
  assert.strictEqual(world.lasso, 2);
  assert.deepStrictEqual(world.ads.filter((a) => a.lasso).map((a) => [a.title, a.lasso.store]).sort(),
    [['FasciaBlaster Original Tool', 'fasciablaster.com'], ['Wool Coat', '4216ec.myshopify.com']]);
  assert.deepStrictEqual(world.ads.find((a) => a.title === 'FasciaBlaster Original Tool').lasso, { store: 'fasciablaster.com', sure: true, at: '2026-11-01' }, 'checked by the research');
  const worldOnly = await env.ads('view=all&scope=world&lasso=1');
  assert.deepStrictEqual(worldOnly.ads.map((a) => a.title).sort(), ['FasciaBlaster Original Tool', 'Wool Coat']);
  assert.deepStrictEqual((await env.ads('view=all&scope=world&noteu=1')).lasso, 1, 'with "Not in EU"');
  assert.deepStrictEqual((await env.ads('view=inbox&scope=world&lasso=1')).total, 2);

  const google = await env.ads('view=all&scope=google');
  assert.deepStrictEqual([google.total, google.lasso], [3, 1]);
  assert.deepStrictEqual(google.ads.filter((a) => a.lasso).map((a) => [a.title, a.lasso.store]), [['Posture Corrector Pro', 'posturepro-sample.example']]);
  assert.deepStrictEqual((await env.ads('view=all&scope=google&lasso=1')).ads.map((a) => a.title), ['Posture Corrector Pro']);
  assert.deepStrictEqual((await env.ads('view=inbox&scope=google&lasso=1')).ads.map((a) => a.title), ['Posture Corrector Pro']);
});

test('CSV: a lasso_checkout column with the store it matched; ?lasso=1 exports only those products', async () => {
  const env = await lassoEnv();
  const text = await (await env.get('/export.csv?view=all')).text();
  assert.match(text.split('\r\n')[0], /,jev_used,lasso_checkout$/, 'the last column');
  const all = parseCsv(text);
  assert.strictEqual(all.length, 28);
  const byId = Object.fromEntries(all.map((r) => [r.ad_id, r.lasso_checkout]));
  assert.deepStrictEqual([byId['9001'], byId['9004'], byId['9400'], byId['9000'], byId['9007']], ['shop1.test', 'shop4-main.test', 'shop1.test', '', ''],
    'also on the row whose title has quotes, commas and a line break');
  const res = await env.get('/export.csv?view=all&lasso=1');
  assert.match(res.headers.get('content-disposition'), /winners-all-/);
  const only = parseCsv(await res.text());
  assert.deepStrictEqual(only.map((r) => r.ad_id).sort(), ['9001', '9004', '9400', '9500']);
  assert.ok(only.every((r) => r.lasso_checkout));
  const world = parseCsv(await (await env.get('/export.csv?view=all&scope=world&lasso=1')).text());
  assert.deepStrictEqual(world.map((r) => r.lasso_checkout).sort(), ['4216ec.myshopify.com', 'fasciablaster.com']);
});

test('/lasso.js: only after login, plain JavaScript that sets up once', async () => {
  const env = await lassoEnv();
  assert.strictEqual((await handle(new Request('https://board.test/lasso.js'), env, { now: NOW })).status, 401);
  const res = await env.get('/lasso.js');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  const js = await res.text();
  assert.strictEqual(js, LASSO_JS);
  assert.doesNotThrow(() => new Function(js), 'it parses');
  assert.match(js, /window\.LASSO/);
  assert.doesNotMatch(js, /__name\(/, 'no bundler helpers: it is sent as source');
  assert.strictEqual((await handle(new Request('https://board.test/lasso.js', { method: 'POST', headers: { cookie: env.cookie } }), env, { now: NOW })).status, 405);
  const html = await (await env.get('/')).text();
  assert.match(html, /<script nonce="[^"]+" src="\/lasso\.js" id="lakit" defer><\/script>/);
});

test('without the table (an older database) the board works and nothing is Lasso; without the aliases column the stores still count', async () => {
  const env = await lassoEnv();
  env.db.exec('DROP TABLE lasso_stores');
  const j = await env.ads('view=all&lasso=1', NOW + 20 * 60000); // after the 15 minutes the tables are kept
  assert.deepStrictEqual([j.total, j.lasso], [0, 0]);
  assert.strictEqual((await env.ads('view=all', NOW + 20 * 60000)).total, 28);

  // The live database before this branch is merged (the test link of preview-board.yml): 0019 without 0080.
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql') && x !== '0080_lasso_seed.sql').sort()) db.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  db.prepare("INSERT INTO lasso_stores (store, confidence) VALUES ('shop1.test', 'high')").run();
  const idx = await readLasso(d1Binding(db));
  assert.deepStrictEqual([...idx.keys()], ['shop1.test']);
  // Any other D1 error is not swallowed: the board reads its tables again on the next request.
  const broken = { prepare: () => ({ all: async () => { throw new Error('D1_ERROR: network connection lost'); } }) };
  await assert.rejects(readLasso(broken), /network connection lost/);
});

// ---------------------------------------------------------------------------
// The discovery job keeps the list: a store it finds joins the filter, one that left Lasso leaves it
// ---------------------------------------------------------------------------

const html = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html' } });
const LASSO_PAGE = (host) => `<!doctype html><html><head><title>${host}</title><script>Shopify.shop = "x.myshopify.com";</script></head><body>
<script src="https://checkout.${host}/shopify-scripts/lasso-script-v4.min.js" data-store-id="6a3c9a6d78c8ee551d08f2f2" data-checkout-url="checkout.${host}/checkout" defer></script></body></html>`;

test('the discovery job runs on top of the research list: a store it finds joins the filter; a store that left Lasso leaves it; aliases stay', async () => {
  const env = await lassoEnv();
  const later = NOW + 20 * 60000; // after the 15 minutes the board keeps its tables
  const before = await env.ads('view=all&scope=world');
  assert.ok(before.ads.find((a) => a.title === 'FasciaBlaster Original Tool').lasso);
  assert.strictEqual((await env.ads('view=all')).ads.find((a) => a.id === '9002').lasso, null, 'shop2.test: not known yet');

  // urlscan finds shop2.test's pages loading Lasso's script; fasciablaster.com answers without Lasso now; every other
  // saved store does not answer (and stays as it was).
  const scanAt = NOW - 864e5;
  const doFetch = async (url) => {
    const u = new URL(url);
    if (u.host === 'urlscan.io') {
      const q = u.searchParams.get('q');
      const [, from, to] = /date:\[(\S+) TO (\S+)\]/.exec(q);
      const hit = q.includes('lasso-script-v4.min.js') && scanAt >= Date.parse(from) && scanAt < Date.parse(to);
      return Response.json({ results: hit ? [{ _id: 's1', page: { domain: 'shop2.test', title: 'Shop 2' }, task: { domain: 'shop2.test', time: new Date(scanAt).toISOString() } }] : [], total: hit ? 1 : 0 });
    }
    if (url === 'https://shop2.test/') return html(LASSO_PAGE('shop2.test'));
    if (url === 'https://checkout.shop2.test/checkout') return html('<script>localStorage.getItem("lasso_theme_hint")</script>');
    if (url === 'https://fasciablaster.com/') return html('<html><title>FasciaBlaster</title></html>');
    if (url === 'https://checkout.fasciablaster.com/checkout') return html('Not found', 404);
    throw new TypeError('fetch failed');
  };
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const t = await discover({ doFetch, db, now: () => later, sleep: async () => {}, log: () => {}, concurrency: 8, sources: ['urlscan'] });
  assert.strictEqual(t.health, 'ok', t.alert);
  assert.ok(t.candidates > 140, 'the stores of the research list are checked again too');
  assert.deepStrictEqual(t.stores.map((r) => [r.store, r.confidence]), [['shop2.test', 'high']]);
  const row = (s) => env.db.prepare('SELECT store, confidence, aliases, last_seen FROM lasso_stores WHERE store = ?').get(s);
  assert.deepStrictEqual({ ...row('fasciablaster.com') }, { store: 'fasciablaster.com', confidence: '', aliases: 'ashleyblackguru.com', last_seen: '2026-11-01T00:00:00.000Z' },
    'left Lasso: marked by the job, its aliases and last Lasso day kept');
  assert.strictEqual(row('tryglowgummies.com').confidence, 'high', 'did not answer: as it was');

  const eu = await env.ads('view=all', later);
  const day = new Date(later).toISOString().slice(0, 10);
  assert.deepStrictEqual(eu.ads.find((a) => a.id === '9002').lasso, { store: 'shop2.test', sure: true, at: day, found: day, src: 'urlscan' }, 'found by the job: on the board, and when');
  assert.deepStrictEqual(eu.lasso_new, { n: 1, by: { urlscan: 1 }, stores: ['shop2.test'], days: 7, run: { at: new Date(later).toISOString(), health: 'ok' } }, 'the chip\'s "+1 new"');
  assert.strictEqual(eu.lasso, 5);
  const world = await env.ads('view=all&scope=world&lasso=1', later);
  assert.deepStrictEqual(world.ads.map((a) => a.title), ['Wool Coat'], 'FasciaBlaster left Lasso: off the filter');
  // The job's own upsert, as it writes any store: the board takes it as it comes.
  await db.query(STORES_SQL, [JSON.stringify([{ store: 'strong.test', host: 'strong.test', confidence: 'medium', live: 1, script: '', lasso_store_id: '', lasso_since: '', checkout_url: 'https://checkout.strong.test/checkout',
    name: 'Strong', country: 'US', currency: 'USD', lang: 'en', products: 3, best_sellers: '[]', how: 'checkout page' }]), new Date(later).toISOString()]);
  assert.strictEqual((await env.ads('view=all&scope=world&lasso=1', later + 20 * 60000)).total, 2);
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

// RFC 4180: quoted cells, "" inside quotes, commas and line breaks inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"', i++);
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') (row.push(cell), (cell = ''));
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

test('migration 0080 holds the research list: every store with its confidence, checkout and aliases', () => {
  const research = parseCsv(fs.readFileSync(new URL('../../docs/research/lasso-stores.csv', import.meta.url), 'utf8'));
  assert.strictEqual(research.length, 143);
  const db = memoryDb();
  const rows = new Map(db.prepare('SELECT * FROM lasso_stores').all().map((r) => [r.store, r]));
  assert.strictEqual(rows.size, 143, 'one row a store, nothing else');
  for (const r of research) {
    const s = rows.get(r.store);
    assert.ok(s, r.store);
    assert.deepStrictEqual([s.confidence, s.live, s.checkout_url, s.script, s.lasso_since, s.name, s.country, s.currency],
      [r.confidence, Number(r.live_2026_11_01), r.checkout_url, r.script, r.lasso_since, r.name, r.shop_country, r.currency], r.store);
    assert.strictEqual(s.aliases, r.also_seen_as ? r.also_seen_as.split(';').map((x) => x.trim()).join(' ') : null, r.store);
    assert.strictEqual(s.products, r.products === '' ? null : Number(r.products), r.store);
    assert.match(s.how, /^research 2026-11-01: /);
    assert.deepStrictEqual([s.first_seen, s.last_seen, s.checked_at], Array(3).fill('2026-11-01T00:00:00.000Z'));
  }
  const n = (sql) => db.prepare(sql).get().n;
  assert.strictEqual(n("SELECT COUNT(*) AS n FROM lasso_stores WHERE confidence IN ('high', 'medium') AND live = 1"), 129, 'the 129 live stores of the research');
  assert.strictEqual(n("SELECT COUNT(*) AS n FROM lasso_stores WHERE confidence = 'low'"), 6, 'left Lasso: in the table, not in the filter');
  const idx = lassoIndex(db.prepare('SELECT * FROM lasso_stores').all());
  assert.strictEqual(new Set([...idx.values()].map((e) => e.store)).size, 137, 'high and medium (the 8 closed that day too)');
  assert.ok(['sleepbysanti.com', 'thetranquilitybed.com', 'yilly.shop'].every((d) => idx.get(d).store === 'sleepbysanti.co'), 'one store, six domains');
});

test('migration 0080 runs as the workflows run it: two statements D1 takes, and every run after the first changes nothing', async () => {
  const st = statements(SEED);
  assert.strictEqual(st.length, 2);
  assert.match(st[0], /^ALTER TABLE lasso_stores ADD COLUMN aliases TEXT$/);
  assert.ok(st.every((s) => Buffer.byteLength(s) < 100000), 'D1 takes a statement of at most 100 KB');
  assert.strictEqual((st[1].match(/^\('/gm) || []).length, 143, 'no store cut off by the comment and statement splitting');
  assert.match(st[1], /ON CONFLICT\(store\) DO UPDATE SET aliases = excluded\.aliases WHERE lasso_stores\.aliases IS NULL AND excluded\.aliases IS NOT NULL$/);

  // Every migration through migrate() (lib/d1.mjs, as migrate.mjs runs them on every workflow run), three times.
  const db = new DatabaseSync(':memory:');
  const client = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(db).doFetch, retryMs: 0 });
  const files = fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort().map((f) => fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  const table = () => JSON.stringify(db.prepare('SELECT * FROM lasso_stores ORDER BY store').all());
  await migrate(client, files);
  const first = table();
  await migrate(client, files);
  await migrate(client, files);
  assert.strictEqual(table(), first);
  assert.strictEqual(db.prepare(st[1]).run().changes, 0, 'not one row written again');
});

test('migration 0080 is additive: a store the job saved before keeps every value; only empty aliases are filled', () => {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql') && x < '0080').sort()) db.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  const job = db.prepare("INSERT INTO lasso_stores (store, host, confidence, live, name, how, first_seen, last_seen, checked_at) VALUES (?, ?, ?, 1, 'From the job', 'store page', '2026-10-20T00:00:00.000Z', ?, '2026-11-08T00:00:00.000Z')");
  job.run('fasciablaster.com', 'fasciablaster.com', '', '2026-11-01T00:00:00.000Z'); // the job found it gone
  job.run('tryglowgummies.com', 'www.tryglowgummies.com', 'medium', '2026-11-08T00:00:00.000Z');
  db.exec(SEED);
  const row = (s) => ({ ...db.prepare('SELECT store, host, confidence, name, how, first_seen, last_seen, checked_at, aliases FROM lasso_stores WHERE store = ?').get(s) });
  assert.deepStrictEqual(row('fasciablaster.com'), { store: 'fasciablaster.com', host: 'fasciablaster.com', confidence: '', name: 'From the job', how: 'store page',
    first_seen: '2026-10-20T00:00:00.000Z', last_seen: '2026-11-01T00:00:00.000Z', checked_at: '2026-11-08T00:00:00.000Z', aliases: 'ashleyblackguru.com' });
  assert.deepStrictEqual(row('tryglowgummies.com'), { store: 'tryglowgummies.com', host: 'www.tryglowgummies.com', confidence: 'medium', name: 'From the job', how: 'store page',
    first_seen: '2026-10-20T00:00:00.000Z', last_seen: '2026-11-08T00:00:00.000Z', checked_at: '2026-11-08T00:00:00.000Z', aliases: null });
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM lasso_stores').get().n, 143);
  // Aliases set since (by hand, or a later list) are not written over.
  db.prepare("UPDATE lasso_stores SET aliases = 'mine.test' WHERE store = 'fasciablaster.com'").run();
  db.exec(SEED.replace(/^ALTER TABLE .*$/m, ''));
  assert.strictEqual(row('fasciablaster.com').aliases, 'mine.test');
});
