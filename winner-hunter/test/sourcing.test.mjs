// 🔎 Sourcing (worker/src/sourcing.mjs, migrations/0016_sourcing.sql): the shared table and the candidates, the link and
// share-text clean-up, the money (EU import fees by date, landed cost, ranking), the search links and first messages,
// /sourcing.js (the code the board runs), /api/sourcing (choosing a supplier wires its cost into the launch card), and
// the CJ Dropshipping module against a fake of its API: off without a key, the token sealed in D1, search by photo and
// by name, cost, stock and freight to NL/DE/FR. On an in-memory D1 (node:sqlite) with every migration applied.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { marginOf, marginInputs, summaryOf } from '../worker/src/launch.mjs';
import {
  SOURCING_JS, FIELDS, VET, SAMPLE, MAX_SUPPLIERS, cleanUrl, platformOf, fromPaste, cleanSupplier, cleanInfo, badFields, fxOf, toEur, euFeesOf, landedOf, flagsOf, ranked, wireOf,
  searchLinks, messageOf, sourcingPost, chosenSupplier, CHOSEN_SQL, cjOn, cjClient, cjItem, cjUrl, seal, unseal,
} from '../worker/src/sourcing.mjs';
import { statements } from '../lib/d1.mjs';
import { memoryDb, d1Binding } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { fakeCj, CJ_KEY, PID } from './helpers/fake-cj.mjs';

const ORIGIN = 'https://winner-hunter.example.workers.dev';
const MIGRATION = fs.readFileSync(new URL('../worker/migrations/0016_sourcing.sql', import.meta.url), 'utf8');
const KEY = 'eu|shop1.test/products/item-1'; // Posture Corrector Pro, approved and on a launch card
const plain = (r) => (r ? { ...r } : r);
const iso = (ms) => new Date(ms).toISOString();
const SHARE_1688 = '【1688】护腰带 姿势矫正器 ¥12.50 2-99件 ≥100件 ¥10 回头率35% 4.8分 源头工厂 https://m.1688.com/offer/695123456789.html?spm=a26352.b28411319&tracelog=x';

async function session(env) {
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const call = (path, init = {}, now = NOW) => handle(new Request(ORIGIN + path, { ...init, headers: { cookie, ...init.headers } }), env, { now });
  return {
    get: async (path) => (await call(path)).json(),
    post: (path, body, { now = NOW, headers = {} } = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, now),
    call,
  };
}
const send = async (s, body, opts) => {
  const res = await s.post('/api/sourcing', body, opts);
  return { status: res.status, ...(await res.json()) };
};
// The board with Posture Corrector Pro approved and its launch card started.
async function cardEnv() {
  const env = await seededEnv();
  const s = await session(env);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9001', status: 'seen' }, { now: NOW - 1000 })).status, 200);
  const start = await s.post('/api/launch', { start: KEY });
  assert.strictEqual(start.status, 200);
  assert.strictEqual((await start.json()).launch.key, KEY);
  return { env, s };
}
const steps = (env, key = KEY) => JSON.parse(env.db.prepare('SELECT steps FROM launches WHERE product_key = ?').get(key).steps);
const shared = (env, key = KEY) => plain(env.db.prepare(CHOSEN_SQL).get(key));

test('migration 0016: only CREATE … IF NOT EXISTS, safe to run again and again; the shared columns; checks on the candidates; ids never reused', () => {
  const st = statements(MIGRATION);
  assert.deepStrictEqual(st.map((x) => x.split('(')[0].trim()), ['CREATE TABLE IF NOT EXISTS product_sourcing', 'CREATE TABLE IF NOT EXISTS product_suppliers', 'CREATE INDEX IF NOT EXISTS product_suppliers_key ON product_suppliers'],
    'nothing that fails a second time (no ALTER) and nothing that drops or changes a row');
  assert.ok(!/\b(DROP|DELETE|UPDATE|ALTER|INSERT)\b/i.test(st.join('\n')));
  const fresh = new DatabaseSync(':memory:');
  for (let i = 0; i < 3; i++) for (const x of st) fresh.exec(x);
  const db = memoryDb(); // every migration, this one included
  for (const x of st) db.exec(x);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['product_key', 'supplier_cost', 'supplier_url', 'weight_g', 'ship_cost', 'supplier_id']) assert.ok(cols('product_sourcing').includes(c), c);
  assert.deepStrictEqual(FIELDS.map((f) => f.k).filter((k) => !cols('product_suppliers').includes(k)), [], 'a column for every field of a candidate');
  const add = db.prepare('INSERT INTO product_suppliers (product_key, currency, kind, origin) VALUES (?, ?, ?, ?) RETURNING id');
  assert.strictEqual(add.get('eu|a', 'CNY', 'factory', 'cn').id, 1);
  assert.strictEqual(add.get('eu|a', null, null, null).id, 2, 'empty is fine');
  assert.throws(() => add.get('eu|a', 'GBP', null, null), /CHECK constraint failed/, 'currency: CNY, USD or EUR');
  assert.throws(() => add.get('eu|a', null, 'agent', null), /CHECK constraint failed/, 'factory or trader');
  assert.throws(() => add.get('eu|a', null, null, 'us'), /CHECK constraint failed/, 'ships from cn or eu');
  db.prepare('DELETE FROM product_suppliers WHERE id = 2').run();
  assert.strictEqual(add.get('eu|a', null, null, null).id, 3, 'AUTOINCREMENT: a removed id is never given again');
  assert.throws(() => db.prepare('INSERT INTO product_sourcing (product_key) VALUES (?)').run(null), /NOT NULL|constraint/i);
});

test('links: https, the offer’s own address on 1688 and AliExpress, no tracking; nothing that is not a web link', () => {
  assert.strictEqual(cleanUrl('https://m.1688.com/offer/695123456789.html?spm=a&tracelog=b'), 'https://detail.1688.com/offer/695123456789.html');
  assert.strictEqual(cleanUrl('detail.1688.com/offer/695123456789.html'), 'https://detail.1688.com/offer/695123456789.html', 'https:// added');
  assert.strictEqual(cleanUrl('https://detail.m.1688.com/page/index.htm?offerId=695123456789&spm=x'), 'https://detail.1688.com/offer/695123456789.html');
  assert.strictEqual(cleanUrl('http://nl.aliexpress.com/item/1005006123456789.html?spm=a2g0o&algo_pvid=x#nav'), 'https://www.aliexpress.com/item/1005006123456789.html');
  assert.strictEqual(cleanUrl('https://www.alibaba.com/product-detail/Posture-Corrector_1600123456789.html?spm=a2700'), 'https://www.alibaba.com/product-detail/Posture-Corrector_1600123456789.html');
  assert.strictEqual(cleanUrl('https://cjdropshipping.com/product/brace-p-1748190816352751616.html?from=x'), 'https://cjdropshipping.com/product/brace-p-1748190816352751616.html');
  assert.strictEqual(cleanUrl('https://a.aliexpress.com/_EyHgAbc'), 'https://a.aliexpress.com/_EyHgAbc', 'a short link stays as it is');
  assert.strictEqual(cleanUrl('https://shop.test/p/1?utm_source=x&id=7&spm=y#top'), 'https://shop.test/p/1?id=7', 'tracking out, the rest stays');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://shop.test/x', 'https://', 'https://nodot', 'not a link', 'https://user:pw@evil.test/x', 'https://' + 'a'.repeat(600) + '.test/']) assert.strictEqual(cleanUrl(bad), '', bad.slice(0, 30));
  assert.deepStrictEqual(['https://detail.1688.com/offer/1.html', 'https://www.aliexpress.us/item/1.html', 'https://sale.alibaba.com/x', 'https://app.cjdropshipping.com/x', 'https://shop.test/', 'nope'].map(platformOf),
    ['1688', 'aliexpress', 'alibaba', 'cj', 'other', 'other']);
});

test('pasting what an app shares: the link, price and currency, MOQ, repeat buyers, rating, factory or trader, the name', () => {
  assert.deepStrictEqual(fromPaste(SHARE_1688), {
    url: 'https://detail.1688.com/offer/695123456789.html', platform: '1688', currency: 'CNY', unit_price: 12.5, moq: 2, repeat_rate: 35, rating: 4.8, kind: 'factory', title: '护腰带 姿势矫正器',
  }, 'the first price tier is the MOQ, not the ≥100 tier');
  assert.deepStrictEqual(fromPaste('€12,34 | Ergonomic Posture Corrector Back Brace https://a.aliexpress.com/_EyHgAbc'),
    { url: 'https://a.aliexpress.com/_EyHgAbc', platform: 'aliexpress', currency: 'EUR', unit_price: 12.34, title: 'Ergonomic Posture Corrector Back Brace' }, 'a decimal comma');
  assert.deepStrictEqual(fromPaste('Posture corrector US $1.85-2.40 Min. order: 100 pieces Trading Company 4.9/5 https://www.alibaba.com/product-detail/Posture-Corrector_1600123456789.html?spm=abc'), {
    url: 'https://www.alibaba.com/product-detail/Posture-Corrector_1600123456789.html', platform: 'alibaba', currency: 'USD', unit_price: 1.85, moq: 100, rating: 4.9, kind: 'trader', title: 'Posture corrector',
  });
  assert.deepStrictEqual(fromPaste('复制这条信息￥8kL2Abc￥打开1688 https://qr.1688.com/s/AbCd'), { url: 'https://qr.1688.com/s/AbCd', platform: '1688', currency: 'CNY' }, 'a share code is no price, boilerplate no name');
  assert.deepStrictEqual(fromPaste('detail.1688.com/offer/123456789.html'), { url: 'https://detail.1688.com/offer/123456789.html', platform: '1688', currency: 'CNY' }, 'a link without https://');
  assert.deepStrictEqual(fromPaste('¥1,234.50 起批量≥5 好评率 96% 工厂 贸易'), { currency: 'CNY', unit_price: 1234.5, moq: 5, rating: 4.8 }, 'a thousands comma; factory and trader both named: neither');
  assert.deepStrictEqual(fromPaste('Brace 1.234,50 € MOQ: 3'), { unit_price: 1234.5, currency: 'EUR', moq: 3, title: 'Brace' });
  assert.deepStrictEqual(fromPaste('Back brace'), { title: 'Back brace' }, 'a name alone (a supplier on WeChat)');
  assert.deepStrictEqual(fromPaste(''), {});
  assert.deepStrictEqual(fromPaste(null), {});
  assert.deepStrictEqual(fromPaste('<script>alert(1)</script> javascript:alert(1)'), { title: '<script>alert(1)</script> javascript:alert(1)' }, 'kept as text: the board escapes it');
});

test('a candidate as it is saved: valid fields only, decimal commas, a rating from a percentage, the currency of its platform; product facts', () => {
  const s = cleanSupplier({ url: 'detail.1688.com/offer/1.html', unit_price: '12,5', ship_price: '30', moq: '2.4', rating: '96%', repeat_rate: '35%', kind: 'factory', origin: 'moon', weight_g: '320', lead_days: '12', notes: ' Sample\nok\u0000 ', extra: 'x' });
  assert.deepStrictEqual(s, { url: 'https://detail.1688.com/offer/1.html', title: null, unit_price: 12.5, currency: 'CNY', ship_price: 30, moq: 2, rating: 4.8, repeat_rate: 35, kind: 'factory', origin: null, weight_g: 320, lead_days: 12, notes: 'Sample\nok' });
  assert.strictEqual(cleanSupplier({ url: 'https://www.alibaba.com/product-detail/x_1.html' }).currency, 'USD');
  assert.strictEqual(cleanSupplier({ url: 'https://www.alibaba.com/product-detail/x_1.html', currency: 'EUR' }).currency, 'EUR', 'what you set wins');
  assert.strictEqual(cleanSupplier({}).currency, 'EUR');
  assert.deepStrictEqual(cleanSupplier({ unit_price: '', moq: null, rating: '4,7' }, { partial: true }), { unit_price: null, moq: null, rating: 4.7 }, 'partial: only what was given; empty clears');
  for (const [k, bad] of [['unit_price', 'lots'], ['unit_price', -1], ['unit_price', 2e6], ['rating', 6], ['rating', '120%'], ['repeat_rate', 101], ['moq', 2e7], ['lead_days', 400], ['currency', 'GBP'], ['kind', 'agent'], ['url', 'javascript:x']]) {
    assert.strictEqual(cleanSupplier({ [k]: bad }, { partial: true })[k], null, `${k}: ${bad}`);
  }
  assert.strictEqual(cleanSupplier({ title: 't'.repeat(300), notes: 'n'.repeat(1500) }).title.length, 200);
  assert.strictEqual(cleanSupplier({ notes: 'n'.repeat(1500) }).notes.length, 1000);
  assert.deepStrictEqual(badFields({ unit_price: 'lots', moq: '2', url: 'nope', rating: '7', notes: '', kind: '' }), ['url', 'unit_price', 'rating'], 'what the form marks before it saves');
  assert.deepStrictEqual(cleanInfo({ zh: ' 姿势矫正器 ', weight_g: '320,4', eur_cny: '8,1', eur_usd: '9', junk: 1 }), { zh: '姿势矫正器', weight_g: 320, eur_cny: 8.1, eur_usd: null }, 'a rate out of range is a typo: not saved');
  assert.deepStrictEqual(cleanInfo({ eur_cny: '' }), { eur_cny: null }, 'empty: back to the default');
  assert.deepStrictEqual(cleanInfo(null), {});
});

test('money: euros at the product’s rates; EU import fees by date (€3 from 1 Jul 2026, €2 more from 1 Nov 2026), none from EU stock; the landed cost', () => {
  assert.deepStrictEqual(fxOf(null), { CNY: 8.3, USD: 1.16 });
  assert.deepStrictEqual(fxOf({ eur_cny: 8, eur_usd: null }), { CNY: 8, USD: 1.16 });
  assert.deepStrictEqual([toEur(12.5, 'CNY', fxOf(null)), toEur(4.2, 'USD', fxOf(null)), toEur(4.99, 'EUR'), toEur(3, null), toEur(null, 'CNY'), toEur('', 'EUR')], [1.51, 3.62, 4.99, 3, null, null]);
  assert.deepStrictEqual(euFeesOf('2026-06-30', 10), { duty: 0, handling: 0, total: 0 });
  assert.deepStrictEqual(euFeesOf('2026-07-01', 10), { duty: 3, handling: 0, total: 3 });
  assert.deepStrictEqual(euFeesOf('2026-10-31T23:59:59Z', 10), { duty: 3, handling: 0, total: 3 });
  assert.deepStrictEqual(euFeesOf('2026-11-01', 10), { duty: 3, handling: 2, total: 5 }, 'about €5 an order from China');
  assert.deepStrictEqual(euFeesOf('2026-11-01', 150), { duty: 0, handling: 2, total: 2 }, '€150 or more: the normal duty, not this flat one');
  const s = { unit_price: 12.5, ship_price: 30, currency: 'CNY' };
  assert.deepStrictEqual(landedOf(s, fxOf(null), '2026-11-01'), { unit: 1.51, ship: 3.61, fees: 5, landed: 10.12 });
  assert.deepStrictEqual(landedOf({ ...s, origin: 'eu' }, fxOf(null), '2026-11-01'), { unit: 1.51, ship: 3.61, fees: 0, landed: 5.12 }, 'from EU stock');
  assert.deepStrictEqual(landedOf({ ship_price: 3 }, fxOf(null), '2026-11-01'), { unit: null, ship: 3, fees: 5, landed: null }, 'no price, no landed cost');
});

test('the comparison: cheapest at the door first, priceless last; what to look at; what the chosen one puts on the launch card', () => {
  const fx = fxOf(null);
  const list = [
    { id: 1, unit_price: 12.5, ship_price: 30, currency: 'CNY', kind: 'factory', repeat_rate: 35, rating: 4.8, moq: 2 },
    { id: 2, unit_price: 3, ship_price: 4, currency: 'EUR', origin: 'eu', kind: 'trader', repeat_rate: 9 },
    { id: 3, title: 'No price yet' },
    { id: 4, unit_price: 2, currency: 'USD', rating: 3.9, moq: 300, lead_days: 25 },
  ];
  const r = ranked(list, fx, '2026-11-01');
  assert.deepStrictEqual(r.map((x) => [x.id, x.x.landed, x.best]), [[4, 6.72, true], [2, 7, false], [1, 10.12, false], [3, null, false]], 'shipping not known counts as 0 (and is flagged)');
  assert.deepStrictEqual(r[0].flags.map((f) => [f.level, f.text]), [['red', 'Rating 3.9'], ['amber', 'Shipping to NL not known yet'], ['amber', 'MOQ 300: stock bought up front'], ['amber', 'Slow: 25 days to the customer']]);
  assert.deepStrictEqual(r[1].flags.map((f) => [f.level, f.k]), [['amber', 'trader'], ['amber', 'repeat'], ['green', 'eu']]);
  assert.deepStrictEqual(r[2].flags.map((f) => [f.level, f.k]), [['green', 'factory'], ['green', 'repeat'], ['green', 'rating']]);
  assert.deepStrictEqual(flagsOf({}, landedOf({}, fx, '2026-11-01')).map((f) => f.k), ['price']);
  assert.deepStrictEqual(ranked(null, fx, ''), []);
  assert.deepStrictEqual(wireOf({ url: 'https://detail.1688.com/offer/1.html', unit_price: 12.5, ship_price: 30, currency: 'CNY', moq: 2, lead_days: 12, weight_g: 320 }, fx),
    { supplier: 'https://detail.1688.com/offer/1.html', unit: 1.51, ship: 3.61, moq: 2, lead: 12, weight_g: 320 }, 'euros, product and shipping only: the margin adds its own fees');
  assert.deepStrictEqual(wireOf({ unit_price: 4.99, currency: 'EUR' }, fx), { unit: 4.99 }, 'only what it knows');
});

test('search links: by name on 1688 (its Chinese words when set), AliExpress, Alibaba and CJ; by photo on Google Lens and Yandex; all https', () => {
  const f = { title: 'Posture Corrector™ Pro | Black', img: 'https://cdn.shopify.com/s/files/1/p1.jpg?width=400' };
  const by = Object.fromEntries(searchLinks(f, '').map((l) => [l.k, l]));
  assert.deepStrictEqual(Object.keys(by), ['1688', 'aliexpress', 'alibaba', 'cj', 'lens', 'yandex', 'photo', 'translate']);
  assert.strictEqual(by[1688].url, 'https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=Posture%20Corrector%20Pro', '™ and the "| Black" tail dropped');
  assert.strictEqual(searchLinks(f, '姿势矫正器')[0].url, 'https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=%E5%A7%BF%E5%8A%BF%E7%9F%AB%E6%AD%A3%E5%99%A8');
  assert.strictEqual(by.aliexpress.url, 'https://www.aliexpress.com/wholesale?SearchText=Posture%20Corrector%20Pro');
  assert.strictEqual(by.alibaba.url, 'https://www.alibaba.com/trade/search?SearchText=Posture%20Corrector%20Pro');
  assert.strictEqual(by.cj.url, 'https://cjdropshipping.com/?searchValue=Posture%20Corrector%20Pro&selectedTabKey=cj');
  assert.strictEqual(by.lens.url, 'https://lens.google.com/uploadbyurl?url=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2Fp1.jpg%3Fwidth%3D400');
  assert.strictEqual(by.yandex.url, 'https://yandex.com/images/search?rpt=imageview&url=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2Fp1.jpg%3Fwidth%3D400');
  assert.deepStrictEqual([by.lens.by, by.photo.by, by.photo.url], ['photo', 'photo', f.img]);
  assert.ok(searchLinks(f, '').every((l) => l.url.startsWith('https://')));
  assert.deepStrictEqual(searchLinks({ title: 'Lamp', img: 'http://x.test/a.jpg' }, '').map((l) => l.k), ['1688', 'aliexpress', 'alibaba', 'cj', 'translate'], 'no photo search without an https photo');
  assert.deepStrictEqual(searchLinks({}, ''), []);
});

test('the first message: to an agent or to a supplier, in English and Chinese; the supplier questions; batteries; only https links', () => {
  const o = { title: 'Posture Corrector Pro', link: 'https://detail.1688.com/offer/1.html', photo: 'https://cdn.shopify.com/p1.jpg', page: 'https://shop1.test/products/item-1', zh: '姿势矫正器', name: 'Connor', qty: 30 };
  const en = messageOf({ ...o, to: 'supplier', lang: 'en' });
  assert.match(en, /^Hello! I'm Connor\. I run an online shop in the Netherlands/);
  assert.match(en, /\nPosture Corrector Pro\nhttps:\/\/detail\.1688\.com\/offer\/1\.html\n\nI'd like 1–2 samples first, then about 30 units/);
  for (const q of ['1, 30, 100 and 500 units', 'packed weight and size', 'CE / RoHS / REACH', 'sample fee credited', 'factory or a trading company', "today's date and my name, Connor"]) assert.ok(en.includes(q), q);
  assert.ok(!/battery/i.test(en));
  assert.match(messageOf({ ...o, to: 'supplier', lang: 'en', battery: true }), /\n11\. It has a battery: please send the UN38\.3 summary/);
  const zh = messageOf({ ...o, to: 'supplier', lang: 'zh', battery: true });
  assert.match(zh, /^您好！我叫Connor，在荷兰开网店/);
  for (const q of ['1个、30个、100个、500个', 'CE / RoHS / REACH检测报告', '样品费可以抵扣', '您是工厂还是贸易公司', '和我的名字Connor', '11. 产品带电池']) assert.ok(zh.includes(q), q);
  const agent = messageOf({ ...o, to: 'agent', lang: 'en' });
  assert.match(agent, /source this product on 1688\?\nPosture Corrector Pro\nPhoto: https:\/\/cdn\.shopify\.com\/p1\.jpg\nSold here: https:\/\/shop1\.test\/products\/item-1\nChinese search words: 姿势矫正器\n\nPlease:\n1\. Find 2–3 suppliers/);
  for (const q of ['PostNL, Hermes or La Poste', 'EU €3 duty and €2 handling fee', 'IOSS number', '20–50 units of starter stock', 'about 30 units']) assert.ok(agent.includes(q), q);
  const agentZh = messageOf({ ...o, to: 'agent', lang: 'zh' });
  for (const q of ['请帮我在1688上采购这款产品', '图片：https://cdn.shopify.com/p1.jpg', '中文关键词：姿势矫正器', '欧盟3欧元关税和2欧元处理费', 'IOSS', '首单约30个试卖']) assert.ok(agentZh.includes(q), q);
  const bare = messageOf({ to: 'supplier', lang: 'en', link: 'javascript:alert(1)', qty: -4 });
  assert.match(bare, /^Hello! I run an online shop/, 'no name: no name');
  assert.ok(!bare.includes('javascript') && bare.includes('about 50 units'), 'a link that is not https is left out; a bad quantity is 50');
});

test('/sourcing.js is the kit on its own: run in a bare context it gives the same answers as the module', () => {
  const ctx = vm.createContext({ window: {}, URL, encodeURIComponent }); // the board and the Worker both have these
  vm.runInContext(SOURCING_JS, ctx);
  const K = ctx.window.SOURCING;
  const same = (a, b, what) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), what);
  same(K.fromPaste(SHARE_1688), fromPaste(SHARE_1688), 'share text');
  same(K.cleanSupplier({ url: 'nl.aliexpress.com/item/1005006123456789.html', unit_price: '4,99', rating: '96%' }), cleanSupplier({ url: 'nl.aliexpress.com/item/1005006123456789.html', unit_price: '4,99', rating: '96%' }));
  const list = [{ id: 1, unit_price: 12.5, ship_price: 30, currency: 'CNY' }, { id: 2, unit_price: 3, currency: 'EUR', kind: 'trader' }];
  same(K.ranked(list, K.fxOf(null), '2026-11-01'), ranked(list, fxOf(null), '2026-11-01'), 'the comparison');
  same(K.searchLinks({ title: 'Lamp', img: 'https://x.test/a.jpg' }, '台灯'), searchLinks({ title: 'Lamp', img: 'https://x.test/a.jpg' }, '台灯'));
  same(K.messageOf({ to: 'agent', lang: 'zh', title: 'Lamp', qty: 20 }), messageOf({ to: 'agent', lang: 'zh', title: 'Lamp', qty: 20 }));
  same([K.VET, K.SAMPLE], [VET, SAMPLE], 'the checklists');
  assert.match(SOURCING_JS, /^'use strict';\nwindow\.SOURCING = \(function sourcingKit\(\) \{/);
  assert.strictEqual(VET.length, 10);
  assert.strictEqual(SAMPLE.length, 10);
});

test('/api/sourcing and /sourcing.js need the PIN; a card is needed; bad keys and methods are refused', async () => {
  const { env, s } = await cardEnv();
  const anon = (path, init) => handle(new Request(ORIGIN + path, init), env, { now: NOW });
  assert.strictEqual((await anon('/api/sourcing?key=' + encodeURIComponent(KEY))).status, 401);
  assert.strictEqual((await anon('/api/sourcing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY, add: { paste: SHARE_1688 } }) })).status, 401);
  assert.strictEqual((await anon('/sourcing.js')).status, 401);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM product_suppliers').get().n, 0);
  const js = await s.call('/sourcing.js');
  assert.deepStrictEqual([js.status, js.headers.get('content-type'), js.headers.get('x-content-type-options'), js.headers.get('cache-control')], [200, 'text/javascript; charset=utf-8', 'nosniff', 'no-store']);
  assert.strictEqual(await js.text(), SOURCING_JS);
  assert.strictEqual((await s.call('/sourcing.js', { method: 'POST' })).status, 405);
  assert.strictEqual((await s.call('/api/sourcing', { method: 'PUT' })).status, 405);
  assert.deepStrictEqual(await s.get('/api/sourcing'), { error: 'Bad key' });
  assert.deepStrictEqual(await s.get('/api/sourcing?key=eu%7Cshop9.test%2Fproducts%2Fnone'), { error: 'No launch card for this product' }, 'no card, no panel');
  const g = await s.get('/api/sourcing?key=' + encodeURIComponent(KEY));
  assert.deepStrictEqual([g.ok, g.key, g.suppliers, g.fx, g.fees, g.cj], [true, KEY, [], { CNY: 8.3, USD: 1.16 }, { duty: 3, handling: 0, total: 3 }, { on: false }], 'on 17 Oct 2026: the €3 duty, the €2 handling fee not yet');
  assert.deepStrictEqual([g.sourcing.supplier_cost, g.sourcing.supplier_id, g.sourcing.zh, g.sourcing.checks.vet.factory, Object.keys(g.sourcing.checks.sample).length], [null, null, '', false, 10]);
  for (const bad of [{}, { key: 'nope' }, { key: 42 }, { key: ['x'] }, { key: 'eu|' + 'x'.repeat(1000) }]) assert.strictEqual((await send(s, { ...bad, add: { paste: SHARE_1688 } })).status, 400, JSON.stringify(bad).slice(0, 30));
  assert.deepStrictEqual(await send(s, { key: 'eu|shop9.test/products/none', add: { paste: SHARE_1688 } }), { status: 404, error: 'No launch card for this product' });
  assert.deepStrictEqual(await send(s, { key: KEY }), { status: 400, error: 'Nothing to save' });
  assert.strictEqual((await send(s, '[1]')).status, 400);
});

test('/api/sourcing: paste, fill in, compare; choosing a supplier puts its cost into the shared columns and the launch card’s numbers', async () => {
  const { env, s } = await cardEnv();
  // The card's Sourcing step already has your note, the sample tick and a shipping quote of your own.
  assert.strictEqual((await s.post('/api/launch', { key: KEY, step: 'sourcing', done: false, note: 'Agent: Lily', v: { sample: true, ship: 6, supplier: 'https://old.test/x' } })).status, 200);
  assert.strictEqual((await s.post('/api/launch', { key: KEY, step: 'margin', v: { price: 39.95, cpa: 12 } })).status, 200);
  const a = await send(s, { key: KEY, add: { paste: SHARE_1688 } });
  assert.strictEqual(a.status, 200);
  const A = a.added;
  assert.deepStrictEqual(a.suppliers.map((x) => [x.id, x.platform, x.title, x.unit_price, x.currency, x.moq, x.rating, x.kind, x.repeat_rate, x.source]), [[A, '1688', '护腰带 姿势矫正器', 12.5, 'CNY', 2, 4.8, 'factory', 35, 'manual']]);
  assert.deepStrictEqual(a.suppliers[0].x, { unit: 1.51, ship: null, fees: 3, landed: 4.51 });
  assert.deepStrictEqual(await send(s, { key: KEY, add: { paste: 'https://detail.1688.com/offer/695123456789.html' } }), { status: 409, error: 'That supplier is already in the list' }, 'the same offer');
  assert.deepStrictEqual(await send(s, { key: KEY, add: { paste: '   ' } }), { status: 400, error: 'No link, name or price in what you pasted' });
  const set = await send(s, { key: KEY, id: A, set: { ship_price: '30', weight_g: '320', lead_days: '12', notes: "'); DROP TABLE launches; --" } });
  assert.deepStrictEqual(set.suppliers[0].x, { unit: 1.51, ship: 3.61, fees: 3, landed: 8.12 });
  assert.strictEqual(set.suppliers[0].notes, "'); DROP TABLE launches; --", 'kept as text');
  const B = (await send(s, { key: KEY, add: { paste: 'https://www.aliexpress.com/item/1005006123456789.html', unit_price: '4,99', ship_price: '2.50', kind: 'trader', repeat_rate: '12' } })).added;
  const both = await s.get('/api/sourcing?key=' + encodeURIComponent(KEY));
  assert.deepStrictEqual(both.suppliers.map((x) => [x.id, x.x.landed, x.best, x.flags.filter((f) => f.level !== 'green').map((f) => f.k)]), [[A, 8.12, true, []], [B, 10.49, false, ['trader', 'repeat']]], 'cheapest at the door first');

  assert.deepStrictEqual(await send(s, { key: KEY, choose: 999 }), { status: 404, error: 'No such supplier for this product' });
  const C = (await send(s, { key: KEY, add: { paste: 'Back brace from WeChat' } })).added;
  assert.deepStrictEqual(await send(s, { key: KEY, choose: C }), { status: 409, error: 'Add its price first: the launch card works out the margin from it' });
  const ch = await send(s, { key: KEY, choose: A });
  assert.strictEqual(ch.status, 200);
  assert.deepStrictEqual(shared(env), { product_key: KEY, supplier_cost: 1.51, supplier_url: 'https://detail.1688.com/offer/695123456789.html', weight_g: 320, ship_cost: 3.61, moq: 2, lead_days: 12 }, 'the shared columns');
  assert.deepStrictEqual(await chosenSupplier(env, KEY), shared(env));
  assert.strictEqual(await chosenSupplier(env, 'eu|nothing'), null);
  assert.deepStrictEqual(steps(env).sourcing, { done: false, note: 'Agent: Lily', v: { sample: true, ship: 3.61, supplier: 'https://detail.1688.com/offer/695123456789.html', unit: 1.51, moq: 2, lead: 12 } },
    'its numbers and link in the Sourcing step; your note and sample tick stay');
  assert.deepStrictEqual(steps(env).margin.v, { price: 39.95, cpa: 12 }, 'another step is not touched');
  // The answer brings the launch card as it is now: its margin works the supplier's cost out at once.
  assert.strictEqual(ch.launch.key, KEY);
  assert.deepStrictEqual(ch.launch.steps.sourcing, steps(env).sourcing);
  assert.deepStrictEqual(ch.launch.summary.margin, marginOf(marginInputs(steps(env))));
  assert.strictEqual(ch.launch.summary.margin.cost, 5.12, '€1.51 unit + €3.61 shipping');
  assert.deepStrictEqual(ch.launch.summary, summaryOf(ch.launch));
  assert.strictEqual(ch.sourcing.supplier_id, A);
  // A new price for the chosen supplier: the launch follows. Another supplier changed: it does not.
  const re = await send(s, { key: KEY, id: A, set: { unit_price: '16,6' } });
  assert.deepStrictEqual([re.launch.steps.sourcing.v.unit, shared(env).supplier_cost], [2, 2]);
  const other = await send(s, { key: KEY, id: B, set: { unit_price: '4.50' } });
  assert.strictEqual(other.launch, undefined);
  assert.strictEqual(steps(env).sourcing.v.unit, 2);
  // Your own rate for the yuan: the chosen supplier's euros follow.
  const rate = await send(s, { key: KEY, info: { eur_cny: '8,0', zh: '姿势矫正器' } });
  assert.deepStrictEqual([rate.sourcing.eur_cny, rate.sourcing.zh, rate.fx.CNY, shared(env).supplier_cost, shared(env).ship_cost, rate.launch.steps.sourcing.v.unit, rate.launch.steps.sourcing.v.ship], [8, '姿势矫正器', 8, 2.08, 3.75, 2.08, 3.75]);
  assert.strictEqual((await send(s, { key: KEY, info: { zh: '护腰带' } })).launch, undefined, 'Chinese words change no numbers');
  assert.deepStrictEqual(await send(s, { key: KEY, info: { junk: 1 } }), { status: 400, error: 'Nothing to save' });
  // Choose another: the link follows; a value it does not know (weight) stays.
  const chB = await send(s, { key: KEY, choose: B });
  assert.deepStrictEqual(chB.launch.steps.sourcing.v, { sample: true, ship: 2.5, supplier: 'https://www.aliexpress.com/item/1005006123456789.html', unit: 4.5, moq: 2, lead: 12 }, 'MOQ and lead time it does not know stay from before');
  assert.deepStrictEqual(shared(env), { product_key: KEY, supplier_cost: 4.5, supplier_url: 'https://www.aliexpress.com/item/1005006123456789.html', weight_g: 320, ship_cost: 2.5, moq: null, lead_days: null });
  // Its price taken out: no longer a cost to go with. Removed: the shared columns empty, the card keeps its numbers.
  const unpriced = await send(s, { key: KEY, id: B, set: { unit_price: '' } });
  assert.deepStrictEqual([unpriced.sourcing.supplier_id, unpriced.sourcing.supplier_cost, unpriced.launch], [null, null, undefined]);
  assert.strictEqual((await send(s, { key: KEY, choose: A })).sourcing.supplier_id, A);
  const rm = await send(s, { key: KEY, id: A, remove: true });
  assert.deepStrictEqual([rm.removed, rm.sourcing.supplier_id, rm.sourcing.supplier_cost, rm.sourcing.supplier_url, rm.sourcing.weight_g], [A, null, null, '', 320], 'the weight is the product’s: it stays');
  assert.strictEqual(steps(env).sourcing.v.unit, 2.08, 'the launch card keeps its numbers: they are yours now');
  assert.deepStrictEqual(await send(s, { key: KEY, id: A, set: { moq: 1 } }), { status: 404, error: 'No such supplier for this product' });
  assert.strictEqual((await send(s, { key: KEY, choose: null })).sourcing.supplier_id, null);
  assert.deepStrictEqual(rm.suppliers.map((x) => x.id).sort(), [B, C].sort());
});

test('/api/sourcing: the weight is the product’s: one you weighed wins over what a supplier says; without one, the supplier’s fills it', async () => {
  const { env, s } = await cardEnv();
  const A = (await send(s, { key: KEY, add: { paste: 'https://detail.1688.com/offer/1.html', unit_price: 10, weight_g: 320 } })).added;
  const B = (await send(s, { key: KEY, add: { paste: 'https://detail.1688.com/offer/2.html', unit_price: 9, weight_g: 410 } })).added;
  await send(s, { key: KEY, choose: A });
  assert.strictEqual(shared(env).weight_g, 320, 'nothing typed: the supplier’s');
  await send(s, { key: KEY, choose: B });
  assert.strictEqual(shared(env).weight_g, 320, 'once there, another supplier does not change it');
  await send(s, { key: KEY, info: { weight_g: '350' } });
  await send(s, { key: KEY, id: B, set: { unit_price: '8' } }); // the chosen one again: wired again
  await send(s, { key: KEY, choose: A });
  assert.deepStrictEqual([shared(env).weight_g, shared(env).supplier_cost], [350, 1.2], 'weighed on the sample: it stays');
  await send(s, { key: KEY, info: { weight_g: '' } });
  assert.strictEqual(shared(env).weight_g, null, 'cleared');
  await send(s, { key: KEY, choose: A });
  assert.strictEqual(shared(env).weight_g, 320, 'cleared, then a supplier with a weight is chosen: its weight');
});

test('/api/sourcing: the vetting and sample checklists tick one item at a time; another product’s supplier is out of reach; at most 30', async () => {
  const { env, s } = await cardEnv();
  for (const [list, k, on] of [['vet', 'video', true], ['vet', 'certs', true], ['sample', 'qc', true], ['vet', 'video', false]]) assert.strictEqual((await send(s, { key: KEY, check: { list, k, on } })).status, 200);
  const g = await s.get('/api/sourcing?key=' + encodeURIComponent(KEY));
  assert.deepStrictEqual(Object.entries(g.sourcing.checks.vet).filter(([, v]) => v).map(([k]) => k), ['certs']);
  assert.deepStrictEqual(Object.entries(g.sourcing.checks.sample).filter(([, v]) => v).map(([k]) => k), ['qc']);
  assert.deepStrictEqual(JSON.parse(env.db.prepare('SELECT checks FROM product_sourcing').get().checks), { vet: { video: false, certs: true }, sample: { qc: true } });
  for (const bad of [{ list: 'vet', k: 'nope' }, { list: 'other', k: 'video' }, { list: '__proto__', k: 'video' }, { list: 'vet', k: '__proto__' }, 'vet', []]) assert.deepStrictEqual(await send(s, { key: KEY, check: bad }), { status: 400, error: 'Bad checklist item' });
  assert.deepStrictEqual(await send(s, { key: KEY, check: null }), { status: 400, error: 'Nothing to save' });
  // Another approved product with a card: its supplier cannot be changed through this card.
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'seen' })).status, 200);
  const K2 = (await (await s.post('/api/launch', { start: 'eu|shop3.test/products/item-3' })).json()).launch.key;
  const theirs = (await send(s, { key: K2, add: { paste: 'https://detail.1688.com/offer/42.html', unit_price: 9 } })).added;
  for (const body of [{ id: theirs, set: { unit_price: 1 } }, { id: theirs, remove: true }, { choose: theirs }]) assert.strictEqual((await send(s, { key: KEY, ...body })).status, 404, JSON.stringify(body));
  assert.strictEqual(plain(env.db.prepare('SELECT unit_price FROM product_suppliers WHERE id = ?').get(theirs)).unit_price, 9);
  for (const id of ['1 OR 1=1', -1, 0, 1.5, 'x', 1e20]) assert.strictEqual((await send(s, { key: KEY, id, set: { moq: 1 } })).status, 404, String(id));
  // The 30 limit
  for (let i = 0; i < MAX_SUPPLIERS; i++) env.db.prepare('INSERT INTO product_suppliers (product_key, url) VALUES (?, ?)').run(KEY, `https://detail.1688.com/offer/${1000 + i}.html`);
  assert.deepStrictEqual(await send(s, { key: KEY, add: { paste: 'https://detail.1688.com/offer/99.html' } }), { status: 409, error: 'At most 30 suppliers per product: remove one first' });
});

test('/api/sourcing refuses other sites, other content and big bodies; every value goes in as a bound parameter', async () => {
  const { env, s } = await cardEnv();
  const body = { key: KEY, add: { paste: SHARE_1688 } };
  assert.strictEqual((await s.post('/api/sourcing', body, { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.strictEqual((await s.post('/api/sourcing', body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.strictEqual((await s.post('/api/sourcing', 'not json')).status, 400);
  assert.strictEqual((await s.post('/api/sourcing', { key: KEY, add: { paste: 'x'.repeat(9000) } })).status, 413);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM product_suppliers').get().n, 0, 'nothing saved');
  const evil = "x'); DELETE FROM product_suppliers; --";
  const a = await send(s, { key: KEY, add: { paste: evil, title: evil, notes: evil } });
  assert.deepStrictEqual([a.status, a.suppliers[0].title, a.suppliers[0].notes], [200, evil, evil]);
  await send(s, { key: KEY, info: { zh: evil } });
  assert.strictEqual((await send(s, { key: KEY + "' OR '1'='1", choose: a.added })).status, 404);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM product_suppliers').get().n, 1);
  assert.ok(!env.DB.log.some((l) => /DELETE FROM product_suppliers;|姿势|posture|shop1\.test/i.test(l.sql)), 'user text never in the SQL');
});

test('CJ: off without a key; with one, the token is fetched once, sealed in D1 (no use without the key) and found again', async () => {
  const { env } = await cardEnv();
  assert.strictEqual(cjOn(env), false);
  assert.deepStrictEqual((await sourcingPost(env, { key: KEY, cj: { find: 'name' } }, NOW)), { status: 409, body: { error: 'CJ is off: add the CJ_API_KEY secret to the Worker (README, Sourcing)' } });
  assert.strictEqual(cjOn({ CJ_API_KEY: '  ' }), false);
  env.CJ_API_KEY = CJ_KEY;
  const cj = fakeCj();
  const r = await sourcingPost(env, { key: KEY, cj: { find: 'name' } }, NOW, { fetch: cj.fetch });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.cj.find.results.map((x) => [x.pid, x.price, x.weight_g, x.stock, x.img]), [[PID, 4.2, 180, 12912, 'https://cf.cjdropshipping.com/posture.jpg'], ['04A22450-67F0-4617-A132-E7AE7F8963B0', 6.8, 250, null, '']],
    'the lowest of a range; a photo that is not https is dropped; an id CJ never gives is dropped');
  assert.strictEqual(r.body.cj.find.results[0].url, 'https://cjdropshipping.com/product/adjustable-posture-corrector-back-brace-p-1748190816352751616.html');
  assert.deepStrictEqual(cj.calls.map((c) => c.path), ['/authentication/getAccessToken', '/product/listV2']);
  assert.deepStrictEqual(cj.calls[1].query, { keyWord: 'Posture Corrector Pro', page: '1', size: '10' }, 'by its name on the card');
  const row = env.db.prepare("SELECT value FROM state WHERE key = 'cj_token'").get();
  assert.ok(row && !row.value.includes(cj.token) && !row.value.includes(CJ_KEY), 'sealed: neither the token nor the key in D1');
  assert.strictEqual((await unseal(CJ_KEY, row.value)).token, cj.token);
  assert.strictEqual(await unseal('another key', row.value), null);
  assert.strictEqual(await unseal(CJ_KEY, 'not sealed'), null);
  // A fresh Worker (nothing in memory) finds the token in D1: no second login.
  const again = { ...env, DB: d1Binding(env.db) };
  await sourcingPost(again, { key: KEY, cj: { find: 'name' } }, NOW, { fetch: cj.fetch });
  assert.strictEqual(cj.calls.filter((c) => c.path === '/authentication/getAccessToken').length, 1);
  // Another key: the sealed token does not open, so it logs in again.
  const wrong = { ...env, DB: d1Binding(env.db), CJ_API_KEY: 'CJ999@api@wrong-key-0000' };
  const no = await sourcingPost(wrong, { key: KEY, cj: { find: 'name' } }, NOW, { fetch: cj.fetch });
  assert.deepStrictEqual(no, { status: 502, body: { error: 'CJ refused the API key: User not find' } });
  assert.ok(!JSON.stringify(no).includes('wrong-key'), 'the key is never in an answer');
  assert.ok(await seal('k', { a: 1 }) !== await seal('k', { a: 1 }), 'a new IV every time');
});

test('CJ: by photo (Level 3), else by name with a note; a token CJ dropped is renewed once; too many calls wait and try again', async () => {
  const { env } = await cardEnv();
  env.CJ_API_KEY = CJ_KEY;
  const cj = fakeCj();
  const photo = await sourcingPost(env, { key: KEY, cj: { find: 'photo' } }, NOW, { fetch: cj.fetch });
  assert.deepStrictEqual([photo.body.cj.find.by, photo.body.cj.find.results.map((x) => x.pid), photo.body.cj.find.note], ['photo', [PID], '']);
  assert.deepStrictEqual(cj.calls[1].body, { imageUrl: 'https://cdn.shopify.com/s/files/1/p1.jpg?width=400' }, 'the photo on the launch card');
  const low = fakeCj({ level3: false });
  const env2 = { ...env, DB: d1Binding(env.db) };
  env.db.prepare("DELETE FROM state WHERE key = 'cj_token'").run();
  const byName = await sourcingPost(env2, { key: KEY, cj: { find: 'photo' } }, NOW, { fetch: low.fetch });
  assert.deepStrictEqual([byName.body.cj.find.by, byName.body.cj.find.results.length, byName.body.cj.find.note], ['name', 2, 'CJ searches by photo for Level 3 accounts only: by name instead.']);
  assert.deepStrictEqual(low.calls.map((c) => c.path), ['/authentication/getAccessToken', '/product/queryProductsByImage', '/product/listV2'], 'a refused search by photo is no reason to log in again');
  // CJ dropped the token: one new login, then the call goes through.
  const fresh = fakeCj();
  const env3 = { ...env, DB: d1Binding(env.db) };
  env.db.prepare("DELETE FROM state WHERE key = 'cj_token'").run();
  const c3 = cjClient(env3, { fetch: fresh.fetch, now: NOW });
  await c3.get('/product/listV2', { keyWord: 'x' });
  const later = fakeCj(); // CJ no longer takes the token sealed in D1
  const stale = cjClient({ ...env3, DB: d1Binding(env.db) }, { fetch: later.fetch, now: NOW });
  const d = await stale.get('/product/listV2', { keyWord: 'x' });
  assert.strictEqual(d.content[0].productList.length, 3);
  assert.deepStrictEqual(later.calls.map((c) => [c.path, c.token === later.token]), [['/product/listV2', false], ['/authentication/getAccessToken', false], ['/product/listV2', true]], 'a 401: one new token, one more try');
  assert.strictEqual((await unseal(CJ_KEY, env.db.prepare("SELECT value FROM state WHERE key = 'cj_token'").get().value)).token, later.token, 'the new token is the one kept');
  // Busy: two waits, then through; three: an error that says so.
  const waits = [];
  const busy = fakeCj({ busy: 2 });
  const env4 = { ...env, DB: d1Binding(env.db) };
  env.db.prepare("DELETE FROM state WHERE key = 'cj_token'").run();
  const ok = await sourcingPost(env4, { key: KEY, cj: { find: 'name' } }, NOW, { fetch: busy.fetch, wait: async (ms) => waits.push(ms) });
  assert.deepStrictEqual([ok.status, waits], [200, [1100, 1100]]);
  const busier = fakeCj({ busy: 3 });
  const env5 = { ...env, DB: d1Binding(env.db) };
  env.db.prepare("DELETE FROM state WHERE key = 'cj_token'").run();
  assert.deepStrictEqual(await sourcingPost(env5, { key: KEY, cj: { find: 'name' } }, NOW, { fetch: busier.fetch, wait: async () => {} }), { status: 429, body: { error: 'CJ: too many requests just now; try again in a minute' } });
  assert.deepStrictEqual(await sourcingPost(env5, { key: KEY, cj: { pid: 'bad pid!' } }, NOW, { fetch: busier.fetch }), { status: 400, body: { error: 'Bad CJ product' } });
});

test('CJ: one product’s cost, stock (the EU apart) and freight to NL, DE and FR; added as a candidate by the route that lands cheapest; a new quote keeps your notes', async () => {
  const { env, s } = await cardEnv();
  env.CJ_API_KEY = CJ_KEY;
  const cj = fakeCj();
  const deps = { fetch: cj.fetch, wait: async () => {} };
  const q = (await sourcingPost(env, { key: KEY, cj: { pid: PID } }, NOW, deps)).body.cj.quote;
  assert.deepStrictEqual([q.vid, q.price, q.variants, q.range, q.weight_g, q.variant, q.sku], ['V-BLACK-M', 4.2, 2, [4.2, 5.1], 210, 'Black-M', 'CJYD1234567-Black-M'], 'the cheapest variant');
  assert.deepStrictEqual(q.stock, { total: 12160, eu: 120, by: { CN: 12000, DE: 120, US: 40 } });
  assert.deepStrictEqual(q.freight, [
    { from: 'CN', to: 'NL', name: 'CJPacket Ordinary', usd: 3.95, days: '8-12' }, { from: 'CN', to: 'DE', name: 'CJPacket Ordinary', usd: 3.7, days: '7-11' }, { from: 'CN', to: 'FR', name: 'CJPacket Ordinary', usd: 4.1, days: '8-13' },
    { from: 'DE', to: 'NL', name: 'DHL Paket', usd: 4.9, days: '2-4' }, { from: 'DE', to: 'DE', name: 'DHL Paket', usd: 3.9, days: '1-3' }, { from: 'DE', to: 'FR', name: 'Colissimo', usd: 6.2, days: '3-5' },
  ], 'the cheapest line per route, from China and from the EU warehouse with the most stock');
  assert.deepStrictEqual(cj.calls.filter((c) => c.path === '/logistic/freightCalculate')[0].body, { startCountryCode: 'CN', endCountryCode: 'NL', products: [{ quantity: 1, vid: 'V-BLACK-M' }] });
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM product_suppliers').get().n, 0, 'a quote alone adds nothing');
  // Add: from Germany it lands at €7.84 (no import fees), from China at €10.03.
  const add = await sourcingPost(env, { key: KEY, cj: { pid: PID, add: true } }, NOW, deps);
  const c = add.body.suppliers[0];
  assert.deepStrictEqual([c.platform, c.source, c.unit_price, c.currency, c.ship_price, c.origin, c.lead_days, c.weight_g, c.moq, c.x.landed], ['cj', 'cj', 4.2, 'USD', 4.9, 'eu', 4, 210, 1, 7.84]);
  assert.strictEqual(c.url, 'https://cjdropshipping.com/product/adjustable-posture-corrector-back-brace-p-1748190816352751616.html');
  assert.strictEqual(c.notes, 'CJ CJYD1234567-Black-M (cheapest of 2 variants: Black-M). 12,160 in stock, 120 in the EU (DE). To NL from DE by DHL Paket, 2-4 days.');
  assert.deepStrictEqual([c.cj.pid, c.cj.stock.eu], [PID, 120], 'what CJ said is kept with it');
  // Your notes and rating stay when CJ is asked again; the chosen one's new numbers reach the launch card.
  await send(s, { key: KEY, id: c.id, set: { notes: 'Ask for a logo price', rating: '4.6' } });
  await send(s, { key: KEY, choose: c.id });
  assert.strictEqual(steps(env).sourcing.v.unit, 3.62, '$4.20 at $1.16 for €1');
  await send(s, { key: KEY, info: { eur_usd: '1.05' } });
  const again = await sourcingPost(env, { key: KEY, cj: { pid: PID, add: true } }, NOW, deps);
  const c2 = again.body.suppliers[0];
  assert.deepStrictEqual([again.body.added, c2.id, c2.notes, c2.rating, c2.unit_price, again.body.suppliers.length], [c.id, c.id, 'Ask for a logo price', 4.6, 4.2, 1]);
  assert.strictEqual(again.body.launch.steps.sourcing.v.unit, 4, 'the chosen one: the launch follows');
  assert.deepStrictEqual(await sourcingPost(env, { key: KEY, cj: { pid: 'NOPE' } }, NOW, deps), { status: 502, body: { error: 'CJ: Param error' } });
});

test('CJ through the board’s own route (the Worker’s fetch), and cjItem / cjUrl on odd input', async () => {
  const { env, s } = await cardEnv();
  env.CJ_API_KEY = CJ_KEY;
  const cj = fakeCj();
  const real = globalThis.fetch;
  globalThis.fetch = cj.fetch;
  try {
    const r = await send(s, { key: KEY, cj: { find: 'name', q: 'back brace' } });
    assert.deepStrictEqual([r.status, r.cj.on, r.cj.find.by, r.cj.find.results.length], [200, true, 'name', 2]);
    assert.strictEqual(cj.calls.at(-1).query.keyWord, 'back brace', 'your own words');
    assert.strictEqual((await s.get('/api/sourcing?key=' + encodeURIComponent(KEY))).cj.on, true);
  } finally {
    globalThis.fetch = real;
  }
  assert.strictEqual(cjItem(null), null);
  assert.strictEqual(cjItem({ id: 'x y' }), null);
  assert.deepStrictEqual(cjItem({ pid: 'P1', productNameEn: 'A\u0000B', productImage: 'https://x.test/a b.jpg', sellPrice: 'n/a', productWeight: 0 }),
    { pid: 'P1', name: 'A B', sku: '', img: '', price: null, weight_g: 0, stock: null, listed: null, url: 'https://cjdropshipping.com/product/a-b-p-P1.html' });
  assert.strictEqual(cjUrl('7', '✨✨'), 'https://cjdropshipping.com/product/product-p-7.html');
});
