// The checklist score (lib/score.mjs) and the stored record shape (lib/record.mjs).
import test from 'node:test';
import assert from 'node:assert';
import { scoreAd, productOf, passesRules, reachPerDay, DAY, MIN_ACTIVE_ADS, MIN_AGE_DAYS, MAX_AGE_DAYS, MIN_REACH_PER_DAY } from '../lib/score.mjs';
import { slimRecord, zhTerm } from '../lib/record.mjs';
import { parseKeywords, wrap } from '../lib/keywords.mjs';

const NOW = Date.UTC(2026, 9, 14);
const daysAgo = (d) => Math.floor((NOW - d * DAY) / 1000);
const ad = (over) => Object.assign({
  id: '1', pageId: 'p1', pageName: 'Anna Boutique', active: true, start: daysAgo(14), end: 0, coll: 1,
  cap: '', links: ['https://annaboutique.com/products/linen-dress?variant=1'], title: 'Linen dress', body: 'Summer sale: 60% off today', cta: 'Shop now',
}, over);
const shopify = { shopify: true, host: 'annaboutique.com', meta: { myshopify: 'anna.myshopify.com', products: 420, currency: 'EUR' } };
const winnerInputs = { shop: shopify, cnt: { count: 130 }, reach: { eu: 150000, uk: null, br: null }, product: { price: 49.95, compareAt: 119.95, currency: 'EUR' }, dupes: 4 };

test('an ad that passes all four rules is a winner (no points; score 100 only for the database)', () => {
  const r = scoreAd(ad(), winnerInputs, {}, NOW);
  assert.strictEqual(r.verdict, 'winner');
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.discount, 58);
  assert.deepStrictEqual(r.items.map((i) => [i.key, i.state, i.text]), [
    ['shopify', 'ok', 'anna.myshopify.com'], ['ads', 'ok', '130 active ads'], ['age', 'ok', 'Live 14 days'], ['reach', 'ok', '11K EU reach a day']]);
  assert.ok(r.items.every((i) => !('pts' in i)));
});

test('marketplaces, ads without a website and non-Shopify stores are out', () => {
  assert.strictEqual(scoreAd(ad({ links: ['https://www.amazon.de/dp/B01'] }), {}, {}, NOW).verdict, 'skip');
  assert.strictEqual(scoreAd(ad({ links: [] }), {}, {}, NOW).verdict, 'skip');
  assert.strictEqual(scoreAd(ad(), Object.assign({}, winnerInputs, { shop: { shopify: false, status: 404 } }), {}, NOW).verdict, 'skip');
});

test('75+ active ads is required; an unknown count stays pending (not saved until known)', () => {
  const v = (cnt) => scoreAd(ad(), Object.assign({}, winnerInputs, { cnt }), {}, NOW);
  assert.strictEqual(v({ count: 75 }).verdict, 'winner');
  assert.strictEqual(v({ count: 74 }).verdict, 'skip');
  assert.strictEqual(v({ count: 74 }).skip, 'Only 74 active ads (needs 75+)');
  for (const unknown of [null, undefined, 'pending']) assert.strictEqual(v(unknown).verdict, 'pending', String(unknown));
  assert.strictEqual(scoreAd(ad(), Object.assign({}, winnerInputs, { shop: 'pending' }), {}, NOW).verdict, 'pending', 'Shopify check still running');
  assert.strictEqual(scoreAd(ad({ start: daysAgo(60) }), Object.assign({}, winnerInputs, { cnt: null }), {}, NOW).verdict, 'skip', 'a failed rule beats pending');
});

test('ad age 7 to 42 days (inclusive) is required', () => {
  const v = (d) => scoreAd(ad({ start: daysAgo(d) }), Object.assign({}, winnerInputs, { reach: { eu: 1e7 } }), {}, NOW);
  assert.deepStrictEqual([6, 7, 42, 43].map((d) => v(d).verdict), ['skip', 'winner', 'winner', 'skip']);
  assert.strictEqual(v(134).skip, 'Live 134 days (max 6 weeks)');
  assert.strictEqual(v(3).skip, 'Live 3 days (needs 7+)');
  assert.strictEqual(scoreAd(ad({ start: 0 }), winnerInputs, {}, NOW).verdict, 'skip', 'start date unknown');
});

test('500+ EU reach per day of ad life is required; unknown reach is out', () => {
  const v = (eu) => scoreAd(ad(), Object.assign({}, winnerInputs, { reach: eu == null ? { err: 'not published' } : { eu } }), {}, NOW);
  assert.strictEqual(v(7000).verdict, 'winner', '7000 / 14 days = 500');
  assert.strictEqual(v(6999).verdict, 'skip');
  assert.strictEqual(v(6999).skip, '499 EU reach a day (needs 500+)');
  assert.strictEqual(v(null).verdict, 'skip');
});

test('ads for the same product, store size and price are information only', () => {
  const r = scoreAd(ad({ coll: 1 }), Object.assign({}, winnerInputs, { dupes: 1, shop: Object.assign({}, shopify, { meta: { products: 2 } }), product: { price: 280, currency: 'EUR' } }), {}, NOW);
  assert.strictEqual(r.verdict, 'winner');
  assert.strictEqual(r.dupes, 1);
});

test('product links are recognised (also behind l.facebook.com)', () => {
  assert.deepStrictEqual(productOf(ad({ links: ['https://l.facebook.com/l.php?u=' + encodeURIComponent('https://www.shop.nl/en/collections/sale/products/Rok-X?utm=1')] })),
    { kind: 'product', handle: 'rok-x', key: 'shop.nl/products/rok-x', url: 'https://www.shop.nl/products/rok-x' });
  assert.strictEqual(productOf(ad({ links: ['https://shop.nl/'] })), null);
});

test('passesRules: a stored record passes all four rules (run.mjs saves only these)', () => {
  const ok = { verdict: 'winner', active_ads: 75, ad_age_days: 14, reach_eu: 7000 };
  assert.strictEqual(reachPerDay(900, 0), 900, 'a day-old ad counts as one day');
  assert.ok(passesRules(ok));
  for (const bad of [{ verdict: 'pending' }, { active_ads: 74 }, { active_ads: null }, { ad_age_days: 6 }, { ad_age_days: 43, reach_eu: 1e6 }, { reach_eu: 6999 }, { ad_age_days: null }]) {
    assert.ok(!passesRules(Object.assign({}, ok, bad)), JSON.stringify(bad));
  }
  assert.deepStrictEqual([MIN_ACTIVE_ADS, MIN_AGE_DAYS, MAX_AGE_DAYS, MIN_REACH_PER_DAY], [75, 7, 42, 500]);
});

test('stored record: only known fields, https URLs, sized Shopify photos, 1688 words', () => {
  const r = slimRecord({
    id: 123, score: '96', verdict: 'winner', product_title: 'Linen {{product.name}} Dress', price: '49.95', compare_at_price: 119.95, currency: 'EUR',
    keyword: 'dress', store_url: 'javascript:alert(1)', product_url: 'https://a.shop/products/x', ad_library_url: 'https://www.facebook.com/ads/library/?id=123',
    image_url: '//cdn.shopify.com/s/files/1/x.jpg?v=1&width=1200&height=600', thumb: 'data:image/png;base64,AAAA', ad_copy: 'x'.repeat(800),
    checklist: [{ key: 'ads', label: 'Advertiser active ads', pts: 30, max: 30, state: 'ok', text: '99 active ads', rule: 'long text' }],
  }, { seenAt: Date.UTC(2026, 9, 15) });
  assert.strictEqual(r.id, '123');
  assert.strictEqual(r.score, 96);
  assert.strictEqual(r.product_title, 'Linen Dress');
  assert.strictEqual(r.discount_pct, 58);
  assert.strictEqual(r.store_url, '', 'no javascript: URLs');
  assert.strictEqual(r.image_url, 'https://cdn.shopify.com/s/files/1/x.jpg?v=1&width=400');
  assert.strictEqual(r.image_source, 'product');
  assert.strictEqual(r.zh, '连衣裙', 'search word "dress" maps to its Chinese term');
  assert.strictEqual(r.ad_copy.length, 600);
  assert.strictEqual(r.seen_at, '2026-10-15T00:00:00.000Z');
  assert.ok(!('thumb' in r));
  assert.deepStrictEqual(Object.keys(r.checklist[0]), ['key', 'label', 'state', 'text'], 'no points stored');
  assert.strictEqual(zhTerm({ product_title: 'Pammy Corset' }), '性感 束身胸衣');
  assert.strictEqual(zhTerm({ product_title: 'Bamboo pillow', keyword: 'kussen' }), 'Bamboo pillow');
});

test('keywords: comments and empty lines skipped; the cursor wraps around', () => {
  assert.deepStrictEqual(parseKeywords('# pets\nhond\n\nkat # nl\n  hund  \n'), ['hond', 'kat', 'hund']);
  assert.deepStrictEqual([wrap(0, 5), wrap(7, 5), wrap(-1, 5), wrap('x', 5), wrap(3, 0)], [0, 2, 4, 0, 0]);
});
