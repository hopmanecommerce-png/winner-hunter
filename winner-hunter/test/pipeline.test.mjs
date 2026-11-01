// 🧭 Pipeline (worker/src/pipeline.mjs, worker/src/countries.mjs, migrations/0074_pipeline.sql): the migration, the link
// clean-up (1688, AliExpress, Alibaba, Taobao; share text in Chinese), the title and Chinese words, the target price from
// the launch card's margin, the request pack with its exact copy text per agent template, the stages (what the data
// shows, the launch card ticks a move sets or clears), the country facts, /pipeline.js (the code the board runs), and
// /api/pipeline on an in-memory D1 with every migration applied: approved products from the EU, outside the EU and TikTok,
// a launch card started on the first action, links that are 🔎 Sourcing's candidates, the photo as a file.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { launchKit, STEPS } from '../worker/src/launch.mjs';
import { sourcingKit, CHOSEN_SQL } from '../worker/src/sourcing.mjs';
import { MARKET_RULES } from '../worker/src/market-rules.mjs';
import { COUNTRIES, DEFAULT_MARKETS, EXTRA_RULES, ALL_COUNTRIES, countryFacts } from '../worker/src/countries.mjs';
import {
  PIPELINE_JS, STAGES, STAGE_KEYS, MAX_LINKS, TEMPLATES, linkOf, linksIn, noLinkWhy, cleanTitle, notEnglish, zhGuess, zhOf, moneyOf, packOf, fieldsOf, copyAllOf, evidenceOf, suggestOf,
  ticksFor, daysIn, cleanPack, badPack, marketsOf,
} from '../worker/src/pipeline.mjs';
import { statements } from '../lib/d1.mjs';
import { memoryDb } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { googleEnv, GLOW } from './helpers/google-seed.mjs';

const ORIGIN = 'https://winner-hunter.example.workers.dev';
const MIGRATION = fs.readFileSync(new URL('../worker/migrations/0074_pipeline.sql', import.meta.url), 'utf8');
const KEY = 'eu|shop1.test/products/item-1'; // Posture Corrector Pro, approved in pipelineEnv()
const WORLD = 'world|pod.test/products/pillow';
const TT = 'tiktok|7300000000000000001';
const SHARE_1688 = '【1688】护腰带 姿势矫正器 ¥12.50 2-99件 ≥100件 ¥10 回头率35% 4.8分 源头工厂 https://m.1688.com/offer/695123456789.html?spm=a26352.b28411319&tracelog=x';
const iso = (ms) => new Date(ms).toISOString();
const plain = (r) => (r ? { ...r } : r);

/** A logged-in phone at `at` (its cookie from then: a cookie never says it lasts longer than the board gives one). */
async function session(env, at = NOW) {
  const cookie = `__Host-wh=${await tokenFor(env, at)}`;
  const call = (path, init = {}, now = at) => handle(new Request(ORIGIN + path, { ...init, headers: { cookie, ...init.headers } }), env, { now });
  return {
    get: async (path) => (await call(path)).json(),
    post: (path, body, { now = at, headers = {} } = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, now),
    call,
  };
}
const send = async (s, body, opts) => {
  const res = await s.post('/api/pipeline', body, opts);
  return { status: res.status, ...(await res.json()) };
};
/** The seeded board with three approved products: Posture Corrector Pro (EU), Pod Pillow (outside the EU: ads in AU and US) and a TikTok product (Meta ads in US and NZ). */
async function pipelineEnv() {
  const env = await seededEnv();
  env.db.prepare(`INSERT INTO world_products (product_key, ad_id, active, product_title, price, currency, image_url, store_url, product_url, ad_library_url, advertiser, page_id, keyword, markets, ads, creatives, days, new14, shop_ads, store_products, first_seen, last_seen)
    VALUES ('pod.test/products/pillow', '1001', 1, 'Pod Pillow', 49, 'AUD', 'https://cdn.shopify.com/pod.jpg', 'https://pod.test/', 'https://pod.test/products/pillow', 'https://www.facebook.com/ads/library/?id=1001', 'Pod', '77', 'pillow',
    '{"AU":{"ads":3,"days":40,"new14":1},"US":{"ads":2,"days":12,"new14":2}}', 5, 2, 40, 1, 80, 12, ?, ?)`).run(iso(NOW - 2 * 864e5), iso(NOW - 3600e3));
  env.db.prepare(`INSERT INTO tiktok_products (id, title, shop, url, image_url, price_min, sold_us, category, blockers, meta_status, meta_url, meta_us, meta_au, meta_nz, decision, decided_at)
    VALUES ('7300000000000000001', 'Ice Roller', 'Glow', 'https://shop.tiktok.com/view/product/7300000000000000001', 'https://p16.tiktokcdn.com/roller.jpg', 12.99, 5400, 'Beauty', '', 'matched', 'https://www.facebook.com/ads/library/?q=glow', 12, 0, 3, 'approved', ?)`).run(iso(NOW - 3 * 864e5));
  // Approved five days and one day ago (each on a phone of that day)
  assert.strictEqual((await (await session(env, NOW - 5 * 864e5)).post('/api/hide', { ad_id: '9001', status: 'seen' })).status, 200);
  assert.strictEqual((await (await session(env, NOW - 864e5)).post('/api/hide', { ad_id: '1001', status: 'seen' })).status, 200);
  return { env, s: await session(env) };
}
const steps = (env, key = KEY) => JSON.parse(env.db.prepare('SELECT steps FROM launches WHERE product_key = ?').get(key).steps);
const row = (env, key = KEY) => plain(env.db.prepare('SELECT * FROM pipeline_items WHERE product_key = ?').get(key));
const history = (env, key = KEY) => env.db.prepare('SELECT from_stage, to_stage, note, actor FROM pipeline_history WHERE product_key = ? ORDER BY id').all(key).map(plain);

test('migration 0074: only CREATE … IF NOT EXISTS, safe to run again and again; the stage, markets, pack and notes of a product; history ids never reused', () => {
  const st = statements(MIGRATION);
  assert.deepStrictEqual(st.map((x) => x.split('(')[0].trim()), ['CREATE TABLE IF NOT EXISTS pipeline_items', 'CREATE TABLE IF NOT EXISTS pipeline_history', 'CREATE INDEX IF NOT EXISTS pipeline_history_key ON pipeline_history', 'CREATE TABLE IF NOT EXISTS pipeline_settings'],
    'nothing that fails a second time (no ALTER) and nothing that drops or changes a row');
  assert.ok(!/\b(DROP|DELETE|UPDATE|ALTER|INSERT)\b/i.test(st.join('\n')));
  assert.ok(!/product_suppliers|product_sourcing|launches/.test(st.join('\n')), 'no table of Sourcing or Launch is touched: the links stay theirs');
  const fresh = new DatabaseSync(':memory:');
  for (let i = 0; i < 3; i++) for (const x of st) fresh.exec(x);
  const db = memoryDb(); // every migration, this one included
  for (const x of st) db.exec(x);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.deepStrictEqual(cols('pipeline_items'), ['product_key', 'stage', 'stage_at', 'outcome', 'markets', 'pack', 'notes', 'created_at', 'updated_at']);
  assert.deepStrictEqual(cols('pipeline_history'), ['id', 'product_key', 'from_stage', 'to_stage', 'note', 'actor', 'at']);
  assert.deepStrictEqual(cols('pipeline_settings'), ['key', 'value', 'updated_at']);
  db.prepare("INSERT INTO pipeline_items (product_key) VALUES ('eu|a')").run();
  assert.strictEqual(db.prepare('SELECT stage FROM pipeline_items').get().stage, 'approved', 'a new row starts in Approved');
  const add = db.prepare("INSERT INTO pipeline_history (product_key, to_stage, at) VALUES ('eu|a', 'link', 'x') RETURNING id");
  assert.strictEqual(add.get().id, 1);
  db.prepare('DELETE FROM pipeline_history').run();
  assert.strictEqual(add.get().id, 2, 'AUTOINCREMENT: a removed id is never given again');
  assert.throws(() => db.prepare('INSERT INTO pipeline_items (product_key) VALUES (?)').run(null), /NOT NULL|constraint/i);
});

test('links: 1688 offers in every shape (desktop, mobile, offerId, http, no https), shops, share links and search pages; AliExpress, Alibaba, Taobao and Tmall cleaned; never a non-web link', () => {
  const offer = 'https://detail.1688.com/offer/695123456789.html';
  for (const u of ['https://detail.1688.com/offer/695123456789.html?spm=a26352.13672862&tracelog=x', 'https://m.1688.com/offer/695123456789.html', 'detail.1688.com/offer/695123456789.html',
    'http://detail.1688.com/offer/695123456789.html', 'https://m.1688.com/page/offerdetail.html?offerId=695123456789&forcePC=1', 'https://detail.m.1688.com/page/index.html?offerId=695123456789&sk=consign',
    '  https://detail.1688.com/offer/695123456789.html#comments  ']) {
    assert.deepStrictEqual(linkOf(u), { url: offer, platform: '1688', label: '1688', kind: 'offer', id: '695123456789', note: '' }, u);
  }
  const shop = linkOf('https://shop1434906291717.1688.com/page/offerlist.htm?spm=a2615');
  assert.deepStrictEqual([shop.url, shop.kind, shop.id], ['https://shop1434906291717.1688.com/page/offerlist.htm', 'shop', '']);
  assert.match(shop.note, /A shop, not one product/);
  assert.strictEqual(linkOf('https://winport.m.1688.com/page/index.html?memberId=b2b-22').kind, 'shop');
  assert.deepStrictEqual([linkOf('https://qr.1688.com/s/AbCdEf12').kind, linkOf('https://qr.1688.com/s/AbCdEf12').url], ['short', 'https://qr.1688.com/s/AbCdEf12']);
  assert.strictEqual(linkOf('https://s.1688.com/selloffer/offer_search.htm?keywords=%E6%9E%95').kind, 'search');
  assert.match(linkOf('https://s.1688.com/selloffer/offer_search.htm?keywords=x').note, /not a product/);
  // AliExpress and Alibaba: "other supplier", with the offer's own address
  for (const u of ['https://www.aliexpress.com/item/1005006543210987.html?spm=a2g0o&algo_pvid=x', 'https://m.aliexpress.com/item/1005006543210987.html', 'www.aliexpress.com/i/1005006543210987.html?gatewayAdapt=glo2nld',
    'https://es.aliexpress.com/i/1005006543210987.html']) {
    assert.deepStrictEqual(linkOf(u), { url: 'https://www.aliexpress.com/item/1005006543210987.html', platform: 'aliexpress', label: 'AliExpress', kind: 'offer', id: '1005006543210987', note: '' }, u);
  }
  assert.strictEqual(linkOf('https://www.aliexpress.us/item/3256806543210987.html').url, 'https://www.aliexpress.com/item/3256806543210987.html');
  assert.strictEqual(linkOf('https://a.aliexpress.com/_mKpQr7a').kind, 'short');
  assert.strictEqual(linkOf('https://www.aliexpress.com/store/1102345').kind, 'shop');
  assert.deepStrictEqual([linkOf('https://www.alibaba.com/product-detail/Posture-Corrector_1600987654321.html?spm=a2700').url, linkOf('https://www.alibaba.com/product-detail/Posture-Corrector_1600987654321.html').id],
    ['https://www.alibaba.com/product-detail/Posture-Corrector_1600987654321.html', '1600987654321']);
  assert.deepStrictEqual([linkOf('https://m.alibaba.com/product/1600987654321/Posture.html').kind, linkOf('https://m.alibaba.com/product/1600987654321/Posture.html').id], ['offer', '1600987654321']);
  // Taobao and Tmall: their own item address, without the trail of tracking
  assert.deepStrictEqual(linkOf('https://item.taobao.com/item.htm?spm=a1z10&id=712345678901&ns=1&abbucket=7'), { url: 'https://item.taobao.com/item.htm?id=712345678901', platform: 'taobao', label: 'Taobao', kind: 'offer', id: '712345678901', note: '' });
  assert.deepStrictEqual([linkOf('detail.tmall.com/item.htm?id=712345678901&skuId=5').url, linkOf('detail.tmall.com/item.htm?id=712345678901').platform], ['https://detail.tmall.com/item.htm?id=712345678901', 'tmall']);
  assert.strictEqual(linkOf('https://m.tb.cn/h.5aBcDeF').kind, 'short');
  for (const x of ['not a link', '', null, 'ftp://detail.1688.com/offer/1.html', 'javascript:alert(1)', 'https://user:pw@detail.1688.com/offer/695123456789.html', 'https://x']) assert.strictEqual(linkOf(x), null, String(x));
});

test('linksIn: the 1688 app’s share text in Chinese gives the link, price, MOQ and name; several links at once, each once; a share code without a link says what to do', () => {
  const [a] = linksIn(SHARE_1688);
  assert.deepStrictEqual({ url: a.url, kind: a.kind, id: a.id, price: a.price, currency: a.currency, moq: a.moq, title: a.title }, { url: 'https://detail.1688.com/offer/695123456789.html', kind: 'offer', id: '695123456789', price: 12.5, currency: 'CNY', moq: 2, title: '护腰带 姿势矫正器' });
  assert.strictEqual(a.text, SHARE_1688, 'the whole text goes to Sourcing, which reads the rest (rating, repeat buyers, factory)');
  const many = linksIn(`${SHARE_1688}\nhttps://detail.1688.com/offer/695123456789.html https://www.aliexpress.com/item/1005006543210987.html\n\ndetail.1688.com/offer/612345678901.html\nwhat else`);
  assert.deepStrictEqual(many.map((x) => [x.url, x.text === x.url]), [['https://detail.1688.com/offer/695123456789.html', false], ['https://www.aliexpress.com/item/1005006543210987.html', true], ['https://detail.1688.com/offer/612345678901.html', false]],
    'the same offer twice is one link; two links on a line go alone');
  assert.strictEqual(linksIn('€12,34 | Posture Corrector Back Brace https://a.aliexpress.com/_mKpQr7a')[0].price, 12.34);
  assert.deepStrictEqual(linksIn('我在1688发现了一个好货：加热颈枕 ¥23.80 复制这条消息￥AbC123￥打开【1688】App'), []);
  assert.match(noLinkWhy('我在1688发现了一个好货：加热颈枕 ¥23.80 复制这条消息￥AbC123￥打开【1688】App'), /only the app’s share code: in the app tap Share → Copy link/);
  assert.match(noLinkWhy('just words'), /No link in what you pasted/);
});

test('cleanTitle, notEnglish, zhGuess and zhOf: a clean English title; Chinese words from you, then the hunt (1688-terms), then a guess from the words', () => {
  assert.strictEqual(cleanTitle('🔥 50% OFF Heated Neck Pillow™ | Grey'), 'Heated Neck Pillow');
  assert.strictEqual(cleanTitle('【Black Friday】 New LED Sunset Lamp [2 pack]'), 'LED Sunset Lamp');
  assert.strictEqual(cleanTitle('Newborn Baby Sleep Sack - Free Shipping'), 'Newborn Baby Sleep Sack', 'a sale word only as a word: Newborn keeps its New');
  assert.strictEqual(cleanTitle('Wholesale Lamp Sale'), 'Wholesale Lamp');
  assert.strictEqual(cleanTitle('3-in-1 Cable'), '3-in-1 Cable');
  assert.strictEqual(cleanTitle('x'.repeat(30) + ' ' + 'word '.repeat(30)).length <= 120, true);
  assert.strictEqual(notEnglish('Elegante Moderne Dameshorloge Met Cadeau Doos'), true);
  assert.strictEqual(notEnglish('Heated Neck Pillow'), false);
  assert.strictEqual(zhGuess('Heated Neck Pillow'), '加热 颈枕');
  assert.strictEqual(zhGuess('Pet Hair Remover Roller'), '宠物除毛器 滚筒');
  assert.strictEqual(zhGuess('Self-Cleaning Cat Brushes'), '自清洁 猫梳', 'plurals');
  assert.strictEqual(zhGuess('Portable Mini'), '', 'no product word: no guess');
  assert.deepStrictEqual(zhOf({ zh: '护腰带', zh_hunt: '颈枕' }, 'Heated Neck Pillow'), { zh: '护腰带', from: 'yours' });
  assert.deepStrictEqual(zhOf({ zh: '', zh_hunt: '颈枕 加热' }, 'Heated Neck Pillow'), { zh: '颈枕 加热', from: 'hunt' });
  assert.deepStrictEqual(zhOf({ zh: '', zh_hunt: 'Heated Neck Pillow' }, 'Heated Neck Pillow'), { zh: '加热 颈枕', from: 'guess' }, 'the hunt’s words count only in Chinese');
  assert.deepStrictEqual(zhOf({}, 'Dameshorloge'), { zh: '', from: '' });
});

test('moneyOf: the most one unit may cost, from the launch card: ROAS 3 without a target CPA, profit 0 at it; shipping counts; their price in € or $ when the card has none', () => {
  const fx = { CNY: 8.3, USD: 1.16 };
  const it = (v, facts = {}) => ({ facts, steps: { margin: { v } }, fx });
  // €39.95 incl. 21% VAT: €33.02 net, €1.20 fees (3%): €31.82 before the product; minus a third of the price (ROAS 3): €18.50
  const a = moneyOf(it({ price: 39.95 }));
  assert.deepStrictEqual([a.known, a.from, a.be_unit, a.max_unit, a.rule, a.ship_known, a.cny_text, a.eur_text, a.text], [true, 'launch card', 31.82, 18.5, 'roas3', false, '¥153', '€18.50', 'Under ¥153 per unit (€18.50)']);
  const b = moneyOf(it({ price: 39.95, cpa: 12, ship: 4.5 }));
  assert.deepStrictEqual([b.be_unit, b.max_unit, b.rule, b.ship_known], [27.32, 15.32, 'cpa', true], 'at a €12 CPA, after €4.50 shipping');
  const c = moneyOf(it({}, { price: 29.95, cur: 'EUR' }));
  assert.deepStrictEqual([c.from, c.max_unit], ['their price', 13.87]);
  const d = moneyOf(it({}, { price: 23.2, cur: 'USD' }));
  assert.deepStrictEqual([d.from, d.price], ['their price', 20], '$23.20 at $1.16 for €1');
  const e = moneyOf(it({}, { price: 49, cur: 'AUD' }));
  assert.deepStrictEqual([e.known, e.why], [false, 'Their price is in AUD: set your selling price in € on the launch card (Margin) for a target price.']);
  assert.deepStrictEqual(moneyOf(it({})).known, false);
  assert.match(moneyOf(it({ price: 5, ship: 6 })).why, /leaves nothing for the product/);
  assert.strictEqual(moneyOf({ facts: {}, steps: { margin: { v: { price: 39.95 } } }, fx: { CNY: 7, USD: 1.1 } }).cny_text, '¥129', 'the product’s own rate (Sourcing)');
  // €19.95: €16.49 net, €0.60 fees, €2 shipping: €13.89 before the product; minus €6.65 (a third): €7.24
  assert.strictEqual(moneyOf({ facts: {}, steps: { sourcing: { v: { ship: 2 } }, margin: { v: { price: 19.95 } } } }).max_unit, 7.24, 'shipping from the Sourcing step, as the margin reads it');
});

// One product, as GET /api/pipeline gives it, for the pack's exact copy text.
const NAMES = { US: { name: 'United States', zh: '美国' }, GB: { name: 'United Kingdom', zh: '英国' }, AU: { name: 'Australia', zh: '澳大利亚' } };
const ITEM = {
  key: KEY, title: 'Posture Corrector Pro™ | Black',
  facts: { source: 'eu', title: 'Posture Corrector Pro™ | Black', img: 'https://cdn.shopify.com/p1.jpg', product: 'https://shop1.test/products/item-1', store: 'https://shop1.test/', ad: 'https://www.facebook.com/ads/library/?id=9001', price: 39.95, cur: 'EUR', risks: [] },
  stage: 'link', markets: ['US', 'GB'], suggested: ['US', 'GB', 'CA', 'AU'], pack: { variants: 'Black, Beige · S/M/L' },
  links: [{ id: 7, platform: '1688', url: 'https://detail.1688.com/offer/695123456789.html', unit_price: 12.5, currency: 'CNY' }], chosen_id: null, zh: '', zh_hunt: '', fx: { CNY: 8.3, USD: 1.16 },
  steps: { margin: { done: false, note: '', v: { price: 39.95 } } },
};
const REMARK_EN = `Please check the 1688 product in the link: Posture Corrector Pro.
Variants: Black, Beige · S/M/L.
Please check: is this the same product, from a factory? MOQ, price at 1/10/50 pcs, sample price, material, certificates (CE, RoHS), lead time, shipping time to United States and United Kingdom (fast tracked line), packaging, and the option for no logo or a custom logo.
Target price: under ¥153 per unit.
2 samples first, then a test order of 50 units.`;
const REMARK_ZH = `请核实链接里的这款1688产品：姿势矫正器。
款式：Black, Beige · S/M/L。
请帮忙确认：是否同款，是否工厂？起订量，1件/10件/50件的价格，样品价格，材质，证书（CE、RoHS），交期，发往美国、英国的时效（快速、可追踪的专线），包装，以及能否无logo或定制logo。
目标价：每个低于¥153。
先要2个样品，然后试单50个。`;

test('packOf: every field of the request pack, ready to copy, in English and Chinese; what is missing; the link is the 1688 link found, else the shop', () => {
  const p = packOf(ITEM, NAMES);
  assert.deepStrictEqual([p.title, p.title_from, p.zh, p.zh_from, p.link, p.link_kind, p.page, p.image, p.countries.join(' / '), p.countries_zh.join('、'), p.sample_qty, p.test_qty],
    ['Posture Corrector Pro', 'cleaned', '姿势矫正器', 'guess', 'https://detail.1688.com/offer/695123456789.html', 'supplier', 'https://shop1.test/products/item-1', 'https://cdn.shopify.com/p1.jpg', 'United States / United Kingdom', '美国、英国', 2, 50]);
  assert.strictEqual(p.remark_en, REMARK_EN);
  assert.strictEqual(p.remark_zh, REMARK_ZH);
  assert.strictEqual(p.ship_en, 'A fast tracked line (special line or express) to United States and United Kingdom, with a tracking number.');
  assert.strictEqual(p.ship_zh, '发往美国、英国：快速、可追踪的专线或快递，需提供追踪号。');
  assert.strictEqual(p.questions_en, `1. Is it the same product? Factory or trader?
2. MOQ, and the price at 1 / 10 / 50 pcs?
3. Sample price, and is it refunded on a bulk order?
4. Material, and which certificates (CE, RoHS, test reports)?
5. Lead time, and the shipping time and cost to United States and United Kingdom?
6. Packed size and weight?
7. No logo, or my own logo (MOQ and cost)?`);
  assert.match(p.questions_zh, /^1\. 是否同款？工厂还是贸易公司？\n2\. 起订量，以及1件\/10件\/50件的价格？/);
  assert.deepStrictEqual([p.missing, p.complete], [[], true]);
  // No 1688 link yet: the shop's page, and the remark asks to find it; your own title and quantities count; no markets: missing
  const q = packOf(Object.assign({}, ITEM, { links: [], markets: [], pack: { title_en: 'Back posture brace', sample_qty: 3, test_qty: 100 } }), NAMES);
  assert.deepStrictEqual([q.title, q.title_from, q.link, q.link_kind, q.missing, q.complete], ['Back posture brace', 'yours', 'https://shop1.test/products/item-1', 'page', ['markets'], false]);
  assert.match(q.remark_en, /^Please find this product on 1688 \(the same as in the link\): Back posture brace\.\n/);
  assert.match(q.remark_en, /shipping time to my customers/);
  assert.match(q.remark_en, /3 samples first, then a test order of 100 units\.$/);
  // The suggested markets count until you pick your own; a battery product asks for battery lines and papers
  const r = packOf(Object.assign({}, ITEM, { markets: null, facts: Object.assign({}, ITEM.facts, { risks: [{ k: 'electric', text: 'Battery or electric' }] }) }), NAMES);
  assert.deepStrictEqual(r.markets, ['US', 'GB', 'CA', 'AU']);
  assert.match(r.remark_en, /It has a battery: a line that takes batteries, and the UN38\.3 report\./);
  assert.match(r.ship_en, /it must take batteries\.$/);
  assert.match(r.questions_en, /8\. Battery: the UN38\.3 report and the MSDS/);
  // No photo, no page, no price: each missing, and the price field says why
  const s = packOf({ facts: { title: 'Thing', price: 49, cur: 'AUD' }, markets: ['AU'] }, NAMES);
  assert.deepStrictEqual(s.missing, ['photo', 'link', 'price', 'zh']);
  assert.deepStrictEqual(marketsOf({ markets: ['US'], suggested: ['GB'] }), ['US']);
});

test('templates: the agent form, Kungfubuy (link, image, one country, remark) and free text, each field in order; Copy all is exact', () => {
  const p = packOf(ITEM, NAMES);
  assert.deepStrictEqual(Object.keys(TEMPLATES), ['generic', 'kungfubuy', 'text']);
  const k = fieldsOf(p, 'kungfubuy');
  assert.deepStrictEqual(k.map((x) => [x.k, x.label, x.value, !!x.file]), [
    ['link', 'Product Link', 'https://detail.1688.com/offer/695123456789.html', false], ['image', 'Product Image', 'https://cdn.shopify.com/p1.jpg', true], ['country1', 'Country', 'United States', false], ['remark', 'Remark', REMARK_EN, false]]);
  assert.strictEqual(k[2].note, 'One country per request: send another for United Kingdom.');
  assert.match(k[1].note, /gif\/jpg\/png, max 3 MB/);
  assert.strictEqual(copyAllOf(k), `Product Link: https://detail.1688.com/offer/695123456789.html\nCountry: United States\nRemark:\n${REMARK_EN}`);
  assert.strictEqual(copyAllOf(fieldsOf(p, 'kungfubuy', 'zh')), `Product Link: https://detail.1688.com/offer/695123456789.html\nCountry: United States\nRemark:\n${REMARK_ZH}`);
  const g = fieldsOf(p, 'generic');
  assert.deepStrictEqual(g.map((x) => x.k), ['link', 'title', 'zh', 'image_url', 'image', 'variants', 'qty', 'price', 'country', 'shipping', 'remark', 'questions', 'documents']);
  assert.strictEqual(copyAllOf(g), `Product Link: https://detail.1688.com/offer/695123456789.html
Product name: Posture Corrector Pro
Chinese name (1688): 姿势矫正器
Image URL: https://cdn.shopify.com/p1.jpg
Colour / size: Black, Beige · S/M/L
Quantity: 2 samples, then 50 units
Target price: Under ¥153 per unit (€18.50)
Country: United States, United Kingdom
Shipping: A fast tracked line (special line or express) to United States and United Kingdom, with a tracking number.
Remark:
${REMARK_EN}
Questions:
${p.questions_en}`);
  assert.match(g[2].note, /Guessed from the English words/);
  const t = fieldsOf(p, 'text');
  assert.deepStrictEqual(t.map((x) => x.k), ['message']);
  assert.strictEqual(copyAllOf(t), p.message_en, 'one message: copied as it is');
  assert.strictEqual(p.message_en, `Hello! Could you source this product for me on 1688?

Product: Posture Corrector Pro
Chinese: 姿势矫正器
Supplier link: https://detail.1688.com/offer/695123456789.html
Sold here: https://shop1.test/products/item-1
Photo: https://cdn.shopify.com/p1.jpg
Variants: Black, Beige · S/M/L
Quality: Same as the photo and the product page: same size, material and function. No damage, a sturdy box. No logo or brand on the product or the box.
Target price: under ¥153 per unit (€18.50), my maximum
Quantity: 2 samples first, then a test order of 50 units
Ship to: United States and United Kingdom, by a fast tracked line

Please tell me:
${p.questions_en}

Thank you!`);
  assert.match(copyAllOf(fieldsOf(p, 'text', 'zh')), /^您好！请帮我在1688上采购这款产品：\n\n产品：姿势矫正器\n英文名：Posture Corrector Pro\n/);
  assert.deepStrictEqual(fieldsOf(p, 'nope').map((x) => x.k), g.map((x) => x.k), 'an unknown template: the agent form');
  // Empty fields are left out of Copy all; the variants field says to fill it in
  const e = fieldsOf(packOf(Object.assign({}, ITEM, { pack: {} }), NAMES), 'generic');
  assert.strictEqual(e.find((x) => x.k === 'variants').value, '');
  assert.match(e.find((x) => x.k === 'variants').note, /Fill in the variants/);
  assert.ok(!/Colour \/ size/.test(copyAllOf(e)));
  assert.strictEqual(g.find((x) => x.k === 'documents').value, '', 'no risk radar verdict: no documents field in Copy all');
  // The risk radar's documents (risk.mjs ask): a field of the agent form and a part of the message, in English and Chinese
  const withDocs = packOf(Object.assign({}, ITEM, { risk: { level: 'docs', reasons: [{ k: 'battery', level: 'docs', short: 'Battery', text: 'Battery' }],
    ask: [['UN38.3 test summary', 'UN38.3 测试摘要'], ['MSDS for the battery', '电池 MSDS（化学品安全技术说明书）']] } }), NAMES);
  assert.strictEqual(withDocs.documents_en, '1. UN38.3 test summary\n2. MSDS for the battery');
  assert.strictEqual(withDocs.documents_zh, '1. UN38.3 测试摘要\n2. 电池 MSDS（化学品安全技术说明书）');
  assert.match(copyAllOf(fieldsOf(withDocs, 'generic')), /\nDocuments to ask for:\n1\. UN38\.3 test summary\n2\. MSDS for the battery$/);
  assert.match(withDocs.message_en, /\n\nPlease also send these documents:\n1\. UN38\.3 test summary\n2\. MSDS for the battery\n\nThank you!$/);
  assert.match(withDocs.message_zh, /\n\n请同时提供以下文件：\n1\. UN38\.3 测试摘要\n2\. 电池 MSDS（化学品安全技术说明书）\n\n谢谢！$/);
  assert.strictEqual(copyAllOf(fieldsOf(withDocs, 'kungfubuy')), copyAllOf(k), 'Kungfubuy’s four fields stay as they are');
});

test('stages: eight, in order, each with who and what next; the data shows a later stage; a move sets or clears the launch card’s two ticks; days in a stage', () => {
  assert.deepStrictEqual(STAGE_KEYS, ['approved', 'request', 'link', 'supplier', 'sample', 'sample_ok', 'ads', 'launched']);
  assert.ok(STAGES.every((s) => s.label && s.long && s.who && s.todo && s.next.length > 20), 'each stage says who does it and what to do next, short and long');
  const it = { stage: 'approved', links: [], steps: {} };
  assert.deepStrictEqual(suggestOf(it), null);
  it.links = [{ id: 1, url: 'https://detail.1688.com/offer/1.html' }];
  assert.deepStrictEqual(suggestOf(it), { stage: 'link', why: '1 supplier link pasted' });
  it.chosen_id = 1;
  it.steps = { sourcing: { v: { sample: true } } };
  assert.deepStrictEqual(suggestOf(it), { stage: 'sample', why: '“Sample ordered” is ticked on the launch card' });
  it.steps.launch = { v: { campaign: true } };
  assert.strictEqual(suggestOf(it).stage, 'ads');
  it.stage = 'ads';
  assert.strictEqual(suggestOf(it), null, 'nothing beyond where it is');
  it.stage = 'launched';
  assert.strictEqual(suggestOf(it), null, 'back is never suggested');
  assert.deepStrictEqual(Object.keys(evidenceOf({})), ['link', 'supplier', 'sample', 'sample_ok', 'ads', 'launched']);
  assert.deepStrictEqual(ticksFor('link', 'sample'), [{ step: 'sourcing', field: 'sample', on: true }]);
  assert.deepStrictEqual(ticksFor('sample', 'link'), [{ step: 'sourcing', field: 'sample', on: false }]);
  assert.deepStrictEqual(ticksFor('approved', 'launched'), [{ step: 'sourcing', field: 'sample', on: true }, { step: 'launch', field: 'campaign', on: true }]);
  assert.deepStrictEqual(ticksFor('ads', 'sample_ok'), [{ step: 'launch', field: 'campaign', on: false }]);
  assert.deepStrictEqual(ticksFor('sample', 'sample_ok'), [], 'within the sample stages nothing changes');
  assert.ok(STEPS.find((s) => s.k === 'sourcing').items.some((f) => f.k === 'sample' && f.t === 'tick') && STEPS.find((s) => s.k === 'launch').items.some((f) => f.k === 'campaign' && f.t === 'tick'), 'the ticks are the launch card’s own');
  assert.strictEqual(daysIn(iso(NOW - 3.5 * 864e5), NOW), 3);
  assert.strictEqual(daysIn('', NOW), 0);
  assert.strictEqual(daysIn(iso(NOW + 864e5), NOW), 0);
  assert.deepStrictEqual(cleanPack({ title_en: '  Brace  ', variants: '', sample_qty: '3', test_qty: '0', nope: 1, quality: 'x'.repeat(900) }), { title_en: 'Brace', quality: 'x'.repeat(500), sample_qty: 3 });
  assert.deepStrictEqual(badPack({ sample_qty: '2.5', test_qty: 'lots', variants: 'Red' }), ['sample_qty', 'test_qty']);
  assert.strictEqual(MAX_LINKS, 5);
});

test('countries: the default list (US, UK … Türkiye) with currency, language, plug, voltage, a shipping range and its source; tax and customs for each; market-rules.mjs reused; the compliance hook', () => {
  assert.deepStrictEqual(DEFAULT_MARKETS, ['US', 'GB', 'CA', 'AU', 'NZ', 'CH', 'NO', 'AE', 'SA', 'SG', 'MY', 'JP', 'KR', 'IL', 'ZA', 'MX', 'BR', 'CL', 'TR']);
  assert.ok(DEFAULT_MARKETS.every((cc) => !['NL', 'DE', 'FR', 'BE', 'ES', 'IT'].includes(cc)), 'all outside the EU');
  for (const cc of Object.keys(COUNTRIES)) {
    const f = countryFacts(cc);
    assert.ok(f.name && f.zh && /^[A-Z]{3}$/.test(f.cur) && f.lang && f.power.plug && /\d+ V/.test(f.power.volt) && f.power.source === 'https://www.iec.ch/world-plugs', cc);
    assert.ok(f.ship.min > 0 && f.ship.max >= f.ship.min && ['estimate', 'unverified'].includes(f.ship.status), `${cc}: a range, marked as an estimate`);
    assert.ok(f.ship.status === 'unverified' || /^https:\/\//.test(f.ship.source), `${cc}: an estimate has its source`);
    assert.match(f.ship.note, /carrier|rough range/);
    assert.ok(f.items.some((i) => i.k === 'tax') && f.items.some((i) => i.k === 'customs'), `${cc}: tax and customs`);
    for (const i of f.items.concat(f.restrictions)) assert.ok(['fact', 'estimate', 'unverified'].includes(i.status) && /^https:\/\//.test(i.source) && i.text, `${cc} ${i.k}: checked how far, with a source`);
    assert.ok(f.short, cc);
  }
  assert.strictEqual(countryFacts('US').rules_from, 'market-rules');
  assert.deepStrictEqual(countryFacts('US').items.find((i) => i.k === 'customs'), MARKET_RULES.markets.US.items.find((i) => i.k === 'customs'), 'the researched rules, as they are');
  assert.ok(countryFacts('AU').restrictions.some((i) => i.k === 'blocker' && /EESS/.test(i.text)), 'AU: mains goods need an AU/NZ supplier');
  for (const cc of ['GB', 'SA', 'ZA', 'MX', 'BR', 'CL', 'TR']) assert.strictEqual(countryFacts(cc).rules_from, 'extra', `${cc}: not in market-rules.mjs yet`);
  assert.deepStrictEqual(Object.keys(EXTRA_RULES).filter((cc) => MARKET_RULES.markets[cc]), [], 'never twice');
  assert.match(countryFacts('GB').items.find((i) => i.k === 'customs').text, /£135/);
  assert.match(countryFacts('CL').items.find((i) => i.k === 'tax').text, /USD 500/);
  assert.strictEqual(countryFacts('XX'), null);
  assert.strictEqual(countryFacts('NL'), null, 'the EU is not a target market here');
  assert.deepStrictEqual(ALL_COUNTRIES.map((c) => c.cc).slice(0, DEFAULT_MARKETS.length), DEFAULT_MARKETS);
  assert.strictEqual(ALL_COUNTRIES.length, Object.keys(COUNTRIES).length);
  // The compliance hook: its items come first under the restrictions
  const hooked = countryFacts('US', { compliance: [{ k: 'kids', label: 'Children', text: 'CPC certificate for children’s products', status: 'fact', source: 'https://www.cpsc.gov/' }, { text: '' }] });
  assert.deepStrictEqual(hooked.restrictions[0], { k: 'kids', label: 'Children', text: 'CPC certificate for children’s products', status: 'fact', source: 'https://www.cpsc.gov/', checked: '' });
  assert.strictEqual(hooked.restrictions.length, countryFacts('US').restrictions.length + 1);
});

test('/pipeline.js is the kit on its own: run in a bare context with the board’s sourcing and launch kits it gives the same answers as the module', () => {
  const ctx = vm.createContext({ window: { SOURCING: sourcingKit(), LAUNCH: launchKit() }, URL }); // the board and the Worker both have URL
  vm.runInContext(PIPELINE_JS, ctx);
  const K = ctx.window.PIPELINE;
  const same = (a, b, what) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), what);
  same(K.STAGES, STAGES, 'the stages');
  same(K.TEMPLATES, TEMPLATES, 'the templates');
  for (const u of ['https://m.1688.com/offer/695123456789.html?spm=x', 'www.aliexpress.com/i/1005006543210987.html', 'https://item.taobao.com/item.htm?id=712345678901&ns=1']) same(K.linkOf(u), linkOf(u), u);
  same(K.linksIn(SHARE_1688), linksIn(SHARE_1688), 'share text');
  same(K.packOf(ITEM, NAMES), packOf(ITEM, NAMES), 'the pack, every text');
  for (const t of Object.keys(TEMPLATES)) same(K.copyAllOf(K.fieldsOf(K.packOf(ITEM, NAMES), t, 'zh')), copyAllOf(fieldsOf(packOf(ITEM, NAMES), t, 'zh')), t);
  same(K.zhGuess('Heated Neck Pillow'), zhGuess('Heated Neck Pillow'), 'the Chinese words');
  same(K.suggestOf({ stage: 'approved', links: [{ url: 'https://x.com/a' }] }), suggestOf({ stage: 'approved', links: [{ url: 'https://x.com/a' }] }), 'what the data says');
  assert.match(PIPELINE_JS, /^'use strict';\nwindow\.PIPELINE = \(function pipelineKit\(S, L\) \{/);
  assert.match(PIPELINE_JS, /\}\)\(window\.SOURCING, window\.LAUNCH\);\n$/);
});

test('/api/pipeline, /pipeline.js and the photo need the PIN; other methods are refused; other sites, other content types and big bodies too', async () => {
  const { env } = await pipelineEnv();
  const anon = (path, init) => handle(new Request(ORIGIN + path, init), env, { now: NOW });
  for (const p of ['/api/pipeline', '/pipeline.js', '/api/pipeline/image?key=' + encodeURIComponent(KEY)]) assert.strictEqual((await anon(p)).status, 401, p);
  assert.strictEqual((await anon('/api/pipeline', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: KEY, stage: 'link' }) })).status, 401);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM launches').get().n, 0, 'nothing started');
  const s = await session(env);
  const js = await s.call('/pipeline.js');
  assert.strictEqual(js.status, 200);
  assert.strictEqual(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.strictEqual(js.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(await js.text(), PIPELINE_JS);
  assert.strictEqual((await s.call('/pipeline.js', { method: 'POST' })).status, 405);
  assert.strictEqual((await s.call('/api/pipeline', { method: 'PUT' })).status, 405);
  assert.strictEqual((await s.call('/api/pipeline/image?key=x', { method: 'POST' })).status, 405);
  assert.strictEqual((await s.post('/api/pipeline', { key: KEY, stage: 'link' }, { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.strictEqual((await s.post('/api/pipeline', { key: KEY, stage: 'link' }, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.strictEqual((await s.post('/api/pipeline', JSON.stringify({ key: KEY, pack: { features: 'x'.repeat(9000) } }))).status, 413);
  assert.strictEqual((await s.post('/api/pipeline', '{nope')).status, 400);
  assert.deepStrictEqual(await send(s, [1]), { status: 400, error: 'Bad JSON' });
  assert.deepStrictEqual(await send(s, { key: 'nope', stage: 'link' }), { status: 400, error: 'Bad key' });
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM launches').get().n, 0);
});

test('GET /api/pipeline: every approved product once (EU, outside the EU, TikTok), in Approved since it was approved; where it runs ads and the suggested markets; the settings and the facts of each country in the list', async () => {
  const { env, s } = await pipelineEnv();
  const j = await s.get('/api/pipeline');
  assert.strictEqual(j.ok, true);
  assert.deepStrictEqual(j.items.map((i) => [i.key, i.stage, i.card, i.days, i.source]), [[KEY, 'approved', false, 5, 'eu'], [TT, 'approved', false, 3, 'tiktok'], [WORLD, 'approved', false, 1, 'world']],
    'Approved, the longest waiting first');
  const [eu, tt, world] = j.items;
  assert.deepStrictEqual(world.ad_markets, [{ cc: 'AU', ads: 3, days: 40 }, { cc: 'US', ads: 2, days: 12 }]);
  assert.deepStrictEqual(world.suggested, ['AU', 'US'], 'where it runs ads');
  assert.deepStrictEqual(tt.ad_markets, [{ cc: 'US', ads: 12 }, { cc: 'NZ', ads: 3 }]);
  assert.deepStrictEqual(tt.suggested, ['US', 'NZ']);
  assert.deepStrictEqual(eu.ad_markets, [{ cc: 'NL', pct: 70, eu: true }, { cc: 'BE', pct: 30, eu: true }]);
  assert.deepStrictEqual(eu.suggested, ['US', 'GB', 'CA', 'AU'], 'ads only in the EU: the first four of your list');
  assert.deepStrictEqual([eu.title, eu.facts.title, eu.markets, eu.links, eu.chosen_id, eu.fx], ['Posture Corrector Pro', 'Posture Corrector Pro', null, [], null, { CNY: 8.3, USD: 1.16 }]);
  assert.deepStrictEqual(j.settings, { markets: DEFAULT_MARKETS, template: 'generic' });
  assert.deepStrictEqual(Object.keys(j.countries), DEFAULT_MARKETS);
  assert.deepStrictEqual(j.countries.SA, countryFacts('SA'));
  assert.strictEqual(j.all_countries.length, Object.keys(COUNTRIES).length);
  assert.deepStrictEqual(j.stages.map((x) => x.k), STAGE_KEYS);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM pipeline_items').get().n, 0, 'reading writes nothing');
});

test('POST /api/pipeline: the first action starts the launch card (approved products only); markets, pack and notes save; a stage moves forward and back with its history and the launch card ticks', async () => {
  const { env, s } = await pipelineEnv();
  // Not approved (Heated Neck Pillow): no card, no pipeline row
  assert.deepStrictEqual(await send(s, { key: 'eu|shop2.test/products/item-2', markets: ['US'] }), { status: 409, error: 'Approve it first' });
  assert.deepStrictEqual(await send(s, { key: 'eu|nowhere.test/products/x', markets: ['US'] }), { status: 404, error: 'Unknown product' });
  let r = await send(s, { key: KEY, markets: ['US', 'GB', 'us'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.started, KEY, 'the launch card is started');
  assert.deepStrictEqual([r.item.card, r.item.stage, r.item.markets, r.item.partial, r.item.stage_at], [true, 'approved', ['US', 'GB'], true, iso(NOW - 5 * 864e5)], 'in Approved since it was approved');
  assert.strictEqual(env.db.prepare('SELECT pinned FROM launches WHERE product_key = ?').get(KEY).pinned, 1, 'as 🚀 Start: the first card is the launch pin');
  assert.deepStrictEqual(await send(s, { key: KEY, markets: ['US', 'NL'] }), { status: 400, error: 'Bad markets' }, 'only countries of the list');
  assert.deepStrictEqual(await send(s, { key: KEY, markets: 'US' }), { status: 400, error: 'Bad markets' });
  assert.strictEqual((await send(s, { key: KEY, markets: null })).item.markets, null, 'null: back to the suggested ones');
  r = await send(s, { key: KEY, pack: { title_en: 'Back posture brace', variants: 'Black, Beige', sample_qty: '3', test_qty: 100, nope: 'x' } });
  assert.deepStrictEqual(r.item.pack, { title_en: 'Back posture brace', variants: 'Black, Beige', sample_qty: 3, test_qty: 100 });
  assert.deepStrictEqual(await send(s, { key: KEY, pack: { sample_qty: 'two' } }), { status: 400, error: 'Not a whole number in range: sample_qty' });
  r = await send(s, { key: KEY, note: { stage: 'approved', text: 'Ask Lily (agent)\nfirst' } });
  r = await send(s, { key: KEY, note: { stage: 'link', text: 'two links from Lily' } });
  assert.deepStrictEqual(r.item.notes, { approved: 'Ask Lily (agent)\nfirst', link: 'two links from Lily' }, 'a note per stage, the other kept');
  assert.deepStrictEqual(await send(s, { key: KEY, note: { stage: "x'); DROP TABLE launches; --", text: 'x' } }), { status: 400, error: 'Bad stage' });
  // Forward to Sample ordered: the launch card's "Sample ordered" is ticked; its other fields stay
  assert.strictEqual((await s.post('/api/launch', { key: KEY, step: 'sourcing', note: 'my note', v: { unit: 8.5, lead: 9 } })).status, 200);
  r = await send(s, { key: KEY, stage: 'sample', note: 'paid on 1688' });
  assert.deepStrictEqual([r.item.stage, r.item.stage_at, r.item.days], ['sample', iso(NOW), 0]);
  assert.deepStrictEqual(steps(env).sourcing, { done: false, note: 'my note', v: { unit: 8.5, lead: 9, sample: true } });
  // To Test ads: "Test campaign set up" too; back to Supplier confirmed: both cleared
  await send(s, { key: KEY, stage: 'ads' });
  assert.strictEqual(steps(env).launch.v.campaign, true);
  r = await send(s, { key: KEY, stage: 'supplier', note: 'sample was wrong' });
  assert.deepStrictEqual([steps(env).sourcing.v, steps(env).launch.v], [{ unit: 8.5, lead: 9 }, {}]);
  assert.deepStrictEqual(history(env), [{ from_stage: 'approved', to_stage: 'sample', note: 'paid on 1688', actor: 'you' }, { from_stage: 'sample', to_stage: 'ads', note: null, actor: 'you' }, { from_stage: 'ads', to_stage: 'supplier', note: 'sample was wrong', actor: 'you' }]);
  assert.deepStrictEqual(r.item.history.map((h) => [h.from, h.to, h.by]), [['ads', 'supplier', 'you'], ['sample', 'ads', 'you'], ['approved', 'sample', 'you']], 'newest first');
  assert.deepStrictEqual(await send(s, { key: KEY, stage: 'nope' }), { status: 400, error: 'Bad stage' });
  const before = history(env).length;
  assert.strictEqual((await send(s, { key: KEY, stage: 'supplier' })).status, 200);
  assert.strictEqual(history(env).length, before, 'the same stage again: no move, no history');
  // The outcome only at Launched; a move back takes it away
  assert.deepStrictEqual(await send(s, { key: KEY, outcome: 'scale' }), { status: 409, error: 'Move it to Launched first' });
  await send(s, { key: KEY, stage: 'launched' });
  assert.deepStrictEqual(await send(s, { key: KEY, outcome: 'maybe' }), { status: 400, error: 'Bad outcome' });
  assert.strictEqual((await send(s, { key: KEY, outcome: 'kill' })).item.outcome, 'kill');
  assert.deepStrictEqual(history(env).at(-1), { from_stage: 'launched', to_stage: 'launched', note: 'Kill', actor: 'outcome' });
  r = await send(s, { key: KEY, stage: 'ads' });
  assert.deepStrictEqual([r.item.outcome, row(env).outcome], [null, null]);
  assert.deepStrictEqual(await send(s, { key: KEY }), { status: 400, error: 'Nothing to save' });
});

test('POST /api/pipeline links: 1688 links become 🔎 Sourcing candidates (cleaned, price and MOQ from the share text), at most 5; the same one twice is skipped; Link found follows; price and MOQ set; choose: Supplier confirmed and the launch card follow', async () => {
  const { env, s } = await pipelineEnv();
  assert.deepStrictEqual(await send(s, { key: KEY, links: { paste: '复制这条消息￥AbC123￥打开【1688】App' } }), { status: 400, error: 'No link in it, only the app’s share code: in the app tap Share → Copy link, and paste that.' });
  let r = await send(s, { key: KEY, links: { paste: SHARE_1688 } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.started, r.added.length, r.skipped, r.over, r.item.stage], [KEY, 1, [], 0, 'link'], 'a link pasted: Link found');
  const [l] = r.item.links;
  assert.deepStrictEqual({ url: l.url, platform: l.platform, link_kind: l.link_kind, offer_id: l.offer_id, unit_price: l.unit_price, currency: l.currency, moq: l.moq, rating: l.rating, repeat_rate: l.repeat_rate, kind: l.kind },
    { url: 'https://detail.1688.com/offer/695123456789.html', platform: '1688', link_kind: 'offer', offer_id: '695123456789', unit_price: 12.5, currency: 'CNY', moq: 2, rating: 4.8, repeat_rate: 35, kind: 'factory' },
    'Sourcing read the rest of the share text: rating, repeat buyers, factory');
  assert.deepStrictEqual(history(env), [{ from_stage: 'approved', to_stage: 'link', note: '1 link pasted', actor: 'link' }]);
  // The same candidate in the Sourcing panel, with its landed cost (the panel's own comparison)
  const sx = await s.get('/api/sourcing?key=' + encodeURIComponent(KEY));
  assert.deepStrictEqual(sx.suppliers.map((x) => [x.id, x.url, x.x.unit]), [[l.id, l.url, 1.51]]);
  // More at once: the same offer again is skipped, the rest added, never more than 5
  r = await send(s, { key: KEY, links: { paste: 'https://detail.1688.com/offer/695123456789.html\nhttps://www.aliexpress.com/item/1005006543210987.html https://detail.1688.com/offer/600000000001.html\nhttps://detail.1688.com/offer/600000000002.html\nhttps://detail.1688.com/offer/600000000003.html\nhttps://detail.1688.com/offer/600000000004.html' } });
  assert.deepStrictEqual([r.added.length, r.skipped.map((x) => x.error), r.over, r.item.links.length], [3, ['That supplier is already in the list'], 2, 4]);
  r = await send(s, { key: KEY, links: { paste: 'https://detail.1688.com/offer/600000000009.html' } });
  assert.strictEqual(r.item.links.length, 5);
  assert.deepStrictEqual(await send(s, { key: KEY, links: { paste: 'https://detail.1688.com/offer/600000000010.html' } }), { status: 409, error: 'Already 5 links: remove one, or compare more in 🔎 Sourcing' });
  // Price, MOQ and notes of a link, through Sourcing; a field the pipeline does not edit is not passed on
  const ali = r.item.links.find((x) => x.platform === 'aliexpress');
  r = await send(s, { key: KEY, link: { id: ali.id, set: { unit_price: '3,20', currency: 'USD', moq: '1', notes: 'agent: same product', kind: 'factory' } } });
  assert.deepStrictEqual((({ unit_price, currency, moq, notes, kind }) => ({ unit_price, currency, moq, notes, kind }))(r.item.links.find((x) => x.id === ali.id)), { unit_price: 3.2, currency: 'USD', moq: 1, notes: 'agent: same product', kind: null });
  assert.deepStrictEqual(await send(s, { key: KEY, link: { id: 999999, set: { moq: 1 } } }), { status: 404, error: 'No such supplier for this product' });
  // Choose one without a price: refused (Sourcing's rule); with one: Supplier confirmed, and the launch card's Sourcing step follows
  const bare = r.item.links.find((x) => x.unit_price == null);
  assert.deepStrictEqual(await send(s, { key: KEY, choose: bare.id }), { status: 409, error: 'Add its price first: the launch card works out the margin from it' });
  r = await send(s, { key: KEY, choose: ali.id });
  assert.deepStrictEqual([r.item.stage, r.item.chosen_id, r.launch.steps.sourcing.v.supplier, r.launch.steps.sourcing.v.unit], ['supplier', ali.id, 'https://www.aliexpress.com/item/1005006543210987.html', 2.76]);
  assert.deepStrictEqual(plain(env.db.prepare(CHOSEN_SQL).get(KEY)).supplier_cost, 2.76, 'the shared row other parts of the board read');
  assert.deepStrictEqual(history(env).at(-1), { from_stage: 'link', to_stage: 'supplier', note: 'Supplier chosen', actor: 'choose' });
  r = await send(s, { key: KEY, choose: null });
  assert.deepStrictEqual([r.item.chosen_id, r.item.stage], [null, 'supplier'], 'unchosen: the stage stays where it is');
  r = await send(s, { key: KEY, link: { id: bare.id, remove: true } });
  assert.strictEqual(r.item.links.length, 4);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM product_suppliers WHERE product_key = ?').get(KEY).n, 4);
  // Another product's link can never be reached through this card
  await send(s, { key: WORLD, links: { paste: 'https://detail.1688.com/offer/700000000001.html' } });
  const other = env.db.prepare('SELECT id FROM product_suppliers WHERE product_key = ?').get(WORLD).id;
  assert.deepStrictEqual(await send(s, { key: KEY, link: { id: other, remove: true } }), { status: 404, error: 'No such supplier for this product' });
  assert.deepStrictEqual(await send(s, { key: KEY, choose: other }), { status: 404, error: 'No such supplier for this product' });
});

test('POST /api/pipeline: Chinese words go to Sourcing; copying the pack moves Approved on; drop is No go on the launch card and back; settings save the list and the template; every value is a bound parameter', async () => {
  const { env, s } = await pipelineEnv();
  let r = await send(s, { key: TT, zh: '冰敷滚轮' });
  assert.deepStrictEqual([r.started, r.item.zh], [TT, '冰敷滚轮']);
  assert.strictEqual(env.db.prepare('SELECT zh FROM product_sourcing WHERE product_key = ?').get(TT).zh, '冰敷滚轮', 'Sourcing’s own field');
  r = await send(s, { key: TT, copied: true });
  assert.strictEqual(r.item.stage, 'request');
  assert.deepStrictEqual(history(env, TT), [{ from_stage: 'approved', to_stage: 'request', note: 'Request pack copied', actor: 'copy' }]);
  r = await send(s, { key: TT, copied: true });
  assert.strictEqual(history(env, TT).length, 1, 'only from Approved');
  r = await send(s, { key: TT, drop: true });
  assert.deepStrictEqual([r.item.dropped, r.item.decision, r.launch.decision], [true, 'no', 'no']);
  r = await send(s, { key: TT, drop: false });
  assert.deepStrictEqual([r.item.dropped, r.item.decision], [false, null]);
  // Settings: the countries in the list (any of the config, at least one) and the agent form
  assert.deepStrictEqual(await send(s, { settings: { markets: [] } }), { status: 400, error: 'Bad markets: pick at least one country' });
  assert.deepStrictEqual(await send(s, { settings: { template: 'nope' } }), { status: 400, error: 'Bad template' });
  assert.deepStrictEqual(await send(s, { settings: {} }), { status: 400, error: 'Nothing to save' });
  r = await send(s, { settings: { markets: ['JP', 'US', 'HK'], template: 'kungfubuy' } });
  assert.deepStrictEqual([r.settings, Object.keys(r.countries)], [{ markets: ['JP', 'US', 'HK'], template: 'kungfubuy' }, ['JP', 'US', 'HK']]);
  const j = await s.get('/api/pipeline');
  assert.deepStrictEqual([j.settings.template, Object.keys(j.countries), j.items.find((i) => i.key === WORLD).suggested], ['kungfubuy', ['JP', 'US', 'HK'], ['US']], 'the suggested markets follow your list');
  // Nothing you send ends up in the SQL text
  const log = env.DB.log;
  log.length = 0;
  const evil = "'); DROP TABLE launches; --";
  await send(s, { key: KEY, pack: { title_en: evil, variants: evil } });
  await send(s, { key: KEY, note: { stage: 'link', text: evil } });
  await send(s, { key: KEY, links: { paste: `https://detail.1688.com/offer/695123456789.html ${evil}` } });
  assert.ok(log.length > 0 && log.every((q) => !q.sql.includes('DROP TABLE')), 'only bound parameters');
  assert.strictEqual(env.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'launches'").get().n, 1);
});

test('GET /api/pipeline: each product has the risk radar’s verdict (risk.mjs), with your radar check on it; its documents are in the request pack', async () => {
  const { env, s } = await pipelineEnv();
  let j = await s.get('/api/pipeline');
  const eu = j.items.find((i) => i.key === KEY);
  assert.strictEqual(eu.risk.level, 'docs', 'Posture Corrector: a health claim in its name');
  assert.deepStrictEqual(eu.risk.reasons.map((r) => [r.k, r.level]), [['claims', 'docs']]);
  assert.deepStrictEqual(eu.risk.ask, [['Label: the maker\'s name and address, model or batch number', '产品标签：制造商名称和地址、型号或批号']]);
  assert.strictEqual(j.items.find((i) => i.key === WORLD).risk.level, 'ok');
  assert.match(packOf(eu, j.countries).documents_en, /^1\. Label: the maker's name and address/);
  // Your documents check on the radar (POST /api/risk) ticks the docs reasons off: the pipeline shows the radar as you left it
  assert.strictEqual((await s.post('/api/risk', { id: '9001', docs: true })).status, 200);
  j = await s.get('/api/pipeline');
  assert.strictEqual(j.items.find((i) => i.key === KEY).risk.level, 'ok');
  assert.deepStrictEqual(j.items.find((i) => i.key === KEY).risk.reasons, []);
  assert.ok(env.db.prepare("SELECT COUNT(*) AS n FROM state WHERE key LIKE 'risk:%'").get().n >= 1);
});

test('a Google product (google|…, the Google tab) goes through the pipeline too: listed, its card started, its 1688 link in 🔎 Sourcing', async () => {
  const env = await googleEnv();
  const s = await session(env);
  assert.strictEqual((await s.post('/api/hide', { ad_id: 'gCR10000000000000000201', status: 'seen' })).status, 200);
  const key = 'google|' + GLOW;
  const item = (await s.get('/api/pipeline')).items.find((i) => i.key === key);
  assert.deepStrictEqual([item.source, item.title, item.stage, item.card], ['google', 'Glow Sunset Lamp', 'approved', false]);
  const r = await send(s, { key, links: { paste: 'https://detail.1688.com/offer/688000000001.html' } });
  assert.deepStrictEqual([r.status, r.started, r.item.stage, r.item.links.map((l) => l.offer_id)], [200, key, 'link', ['688000000001']]);
  const sx = await s.get('/api/sourcing?key=' + encodeURIComponent(key));
  assert.deepStrictEqual(sx.suppliers.map((x) => x.url), ['https://detail.1688.com/offer/688000000001.html'], 'the Sourcing panel of a Google launch card works too');
});

test('before the migration ran (a test link on the live database): the list still shows the approved products; a change is a 503 and starts no launch card', async () => {
  const { env, s } = await pipelineEnv();
  for (const t of ['pipeline_items', 'pipeline_history', 'pipeline_settings']) env.db.exec(`DROP TABLE ${t}`);
  const j = await s.get('/api/pipeline');
  assert.deepStrictEqual([j.ok, j.items.length, j.items[0].stage, j.settings.template], [true, 3, 'approved', 'generic']);
  const r = await s.post('/api/pipeline', { key: KEY, markets: ['US'] });
  assert.deepStrictEqual([r.status, (await r.json()).error], [503, 'Database not ready: run the Winner Hunter workflow once.']);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM launches').get().n, 0, 'nothing written');
  assert.strictEqual((await s.post('/api/pipeline', { settings: { template: 'text' } })).status, 503);
});

test('GET /api/pipeline/image: the product’s own photo as a file (a launch card’s, or an approved product’s without one), never a link from the request; not a photo, too big or no photo: a clear error', async () => {
  const { env, s } = await pipelineEnv();
  const realFetch = globalThis.fetch;
  const asked = [];
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==', 'base64');
  let answer = () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } });
  globalThis.fetch = async (url, init) => {
    asked.push(String(url));
    return answer(url, init);
  };
  try {
    const get = (key, extra = '') => s.call('/api/pipeline/image?key=' + encodeURIComponent(key) + extra);
    let res = await get(KEY, '&url=https://evil.test/x.png');
    assert.strictEqual(res.status, 200, 'an approved product without a card yet');
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.strictEqual(res.headers.get('content-disposition'), 'attachment; filename="posture-corrector-pro.png"');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepStrictEqual(Buffer.from(await res.arrayBuffer()), PNG);
    assert.deepStrictEqual(asked, ['https://cdn.shopify.com/s/files/1/p1.jpg?width=400'], 'only the photo the board has for it');
    await send(s, { key: WORLD, markets: ['AU'] }); // its card started
    res = await get(WORLD);
    assert.deepStrictEqual([res.status, res.headers.get('content-disposition')], [200, 'attachment; filename="pod-pillow.png"']);
    assert.strictEqual(asked.at(-1), 'https://cdn.shopify.com/pod.jpg');
    answer = () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
    assert.deepStrictEqual([(await get(KEY)).status, (await (await get(KEY)).json()).error], [502, 'Not a photo the board can use (text/html)']);
    answer = () => new Response('x', { status: 404 });
    assert.strictEqual((await (await get(KEY)).json()).error, 'The photo’s site answered 404');
    answer = () => new Response(new Uint8Array(10), { headers: { 'content-type': 'image/jpeg', 'content-length': String(16 * 1024 * 1024) } });
    assert.strictEqual((await get(KEY)).status, 413);
    answer = () => { throw new Error('ECONNRESET'); };
    assert.match((await (await get(KEY)).json()).error, /Could not fetch the photo: ECONNRESET/);
    assert.deepStrictEqual([(await get('eu|nowhere.test/products/x')).status, (await get('eu|shop2.test/products/item-2')).status], [404, 404], 'unknown, or not approved');
    assert.strictEqual((await get('nope')).status, 400);
    env.db.prepare("UPDATE launches SET facts = json_set(facts, '$.img', 'http://plain.test/x.png') WHERE product_key = ?").run(WORLD);
    assert.strictEqual((await (await get(WORLD)).json()).error, 'This product has no photo', 'never a link that is not https');
  } finally {
    globalThis.fetch = realFetch;
  }
});
