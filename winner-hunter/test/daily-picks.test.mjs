// Today's winners: the bar, dedupe, rotation and the cap (lib/daily-picks.mjs), and the facts the score reads (lib/winner-facts.mjs).
import test from 'node:test';
import assert from 'node:assert';
import { selectDaily, belowBar, titleWords, overlap, RULES } from '../lib/daily-picks.mjs';
import { euFacts, worldFacts, tiktokFacts, decisionsOf, adIndex, withInputs, jkOf } from '../lib/winner-facts.mjs';

const DAY = '2026-11-06';
let n = 0;
const WORDS = ['lamp', 'pillow', 'harness', 'blanket', 'towel', 'kettle', 'mirror', 'clock', 'brush', 'mat', 'scarf', 'wallet', 'cushion', 'bowl', 'tent', 'chair', 'bottle', 'fan',
  'heater', 'basket', 'rug', 'shelf', 'apron', 'glove', 'candle', 'vase', 'stool', 'hook', 'tray', 'jar', 'cup', 'board', 'cover', 'bag', 'box', 'case', 'light', 'tool', 'net', 'strap'];
const pick = (o = {}) => {
  n++;
  return { key: `world|s${n}.test/products/p${n}`, id: `p${n}`, name: o.name || `${WORDS[n % WORDS.length]} ${WORDS[(n * 7 + 3) % WORDS.length]}${n}`, src: 'world', category: 'Home', score: 70, level: 3,
    coverage: 0.7, ladder: { paid: true, sustained: true, selling: true, profitable: true }, pillars: {}, risk: { gate: null, mult: 1, flags: [], returns: [], undecided: [] },
    econ: { breakeven_cpa_eur: 30, margin_eur: 30, supplier: 'est' }, stores: [`s${n}.test`], ...o };
};

test('the bar: every reason a product is passed over', () => {
  assert.strictEqual(belowBar(pick()), '');
  assert.strictEqual(belowBar(pick({ risk: { gate: 'excluded', mult: 1, flags: [] } })), 'excluded');
  assert.strictEqual(belowBar(pick({ score: 49 })), 'score');
  assert.strictEqual(belowBar(pick({ level: 1 })), 'evidence');
  assert.strictEqual(belowBar(pick({ ladder: { paid: false } })), 'evidence');
  assert.strictEqual(belowBar(pick({ econ: null })), 'price');
  assert.strictEqual(belowBar(pick({ econ: { breakeven_cpa_eur: 9 } })), 'margin');
  assert.strictEqual(belowBar(pick({ risk: { gate: null, mult: 0.5, flags: [] } })), 'risk');
  assert.strictEqual(belowBar(pick({ category: null })), 'not read by Jev');
});

test('5 to 10 a day: at most 10; fewer than 5 passing says so and is never padded', () => {
  const many = [...Array(30)].map((_, i) => pick({ category: ['Home', 'Pets', 'Car', 'Kitchen', 'Garden', 'Tech', 'Sleep and comfort', 'Outdoor and travel'][i % 8], score: 90 - i }));
  const d = selectDaily(many, { day: DAY });
  assert.strictEqual(d.picks.length, 10);
  assert.strictEqual(d.shortfall, false);
  const few = [pick(), pick(), pick({ score: 40 }), pick({ econ: null })];
  const s = selectDaily(few, { day: DAY });
  assert.strictEqual(s.picks.length, 2);
  assert.strictEqual(s.shortfall, true);
  assert.match(s.message, /Only 2 products passed the quality bar today/);
  assert.deepStrictEqual(s.skipped, { score: 1, price: 1 });
  assert.match(selectDaily([], { day: DAY }).message, /No product passed/);
});

test('dedupe: decided, shown in the last 14 days, one per store, near-identical titles, no brand listings', () => {
  const a = pick({ score: 90 });
  const b = pick({ score: 89 });
  const c = pick({ score: 88 });
  const d = pick({ score: 87, stores: a.stores });
  const e = pick({ score: 86, name: a.name + ' XL' });
  const f = pick({ score: 85, risk: { gate: null, mult: 1, flags: ["A brand's own listing: sell the product type, not the brand"] } });
  const g = pick({ score: 84 });
  const out = selectDaily([a, b, c, d, e, f, g], { day: DAY, decided: new Set([b.key]), shown: new Map([[c.key, '2026-11-01'], [g.key, '2026-10-20']]) });
  assert.deepStrictEqual(out.picks.map((p) => p.key), [a.key, g.key], 'g was shown 17 days ago: back; c 5 days ago: not yet');
  assert.strictEqual(out.skipped.decided, 1);
  assert.strictEqual(out.skipped['shown lately'], 1);
  assert.strictEqual(out.skipped['rotation or duplicate'], 3);
});

test('rotation: at most 2 of a category, a category from yesterday counts less, shown by score', () => {
  const homes = [...Array(5)].map((_, i) => pick({ category: 'Home', score: 80 - i }));
  const pets = [pick({ category: 'Pets', score: 70 }), pick({ category: 'Pets', score: 69 })];
  const out = selectDaily([...homes, ...pets], { day: DAY });
  assert.strictEqual(out.picks.filter((p) => p.category === 'Home').length, 2);
  assert.deepStrictEqual(out.picks.map((p) => p.score), [80, 79, 70, 69]);
  assert.deepStrictEqual(out.picks.map((p) => p.pick), [1, 2, 3, 4]);
  const y = selectDaily([pick({ category: 'Home', score: 72 }), pick({ category: 'Pets', score: 70 })], { day: DAY, yesterday: new Set(['Home']), rules: { ...RULES, max: 1 } });
  assert.strictEqual(y.picks[0].category, 'Pets', 'Home was picked yesterday: 72 × 0.92 < 70');
  const again = selectDaily([...homes, ...pets], { day: DAY });
  assert.deepStrictEqual(again.picks.map((p) => p.key), out.picks.map((p) => p.key), 'the same input, the same picks');
});

test('title words and overlap ignore stop words, numbers and sale tags', () => {
  assert.deepStrictEqual([...titleWords('【Black Friday】The Cooling Pillow 2 Pack for Side Sleepers')].sort(), ['cooling', 'pillow', 'side', 'sleepers']);
  assert.ok(overlap(titleWords('Cooling Pillow for side sleepers'), titleWords('Cooling pillow, side sleepers')) >= 0.6);
  assert.ok(overlap(titleWords('Cooling Pillow'), titleWords('Dog Harness')) === 0);
});

// ---- The facts.
const ad = (o) => ({ ad_id: o.ad_id, product_title: 'Heated Neck Pillow', price: 39.95, currency: 'EUR', advertiser: 'Shop A', advertiser_page_id: '500', active_ads: 120,
  ad_age_days: 20, reach_eu: 200000, scaled_count: 3, store_url: 'https://shopa.test/', product_url: 'https://shopa.test/products/neck', ad_library_url: 'https://www.facebook.com/ads/library/?id=' + o.ad_id,
  last_seen: '2026-11-01T08:00:00Z', data: JSON.stringify({ store_products: 25, top_countries: 'NL 70%, BE 30%' }), ...o });

test('EU ads become one product per product page: the best ad leads, counts are the most any ad shows', () => {
  const rows = [ad({ ad_id: '1', reach_eu: 100000, scaled_count: 9 }), ad({ ad_id: '2', reach_eu: 400000, ad_age_days: 30 }), ad({ ad_id: '3', product_url: 'https://shopa.test/', product_title: 'Other thing', reach_eu: 1000 })];
  const checks = new Map([['eu|' + jkOf(rows[0]), { product_key: 'eu|' + jkOf(rows[0]), main: 'Sleep and comfort', sub: 'Pillows', product_score: 2.5, answers: JSON.stringify({ p: { physical: 0.99, people: 0.01 } }) }]]);
  const best = new Map([['shopa.test/products/neck', { product_key: 'shopa.test/products/neck', rank: 2, ok: 1, checked_at: '2026-11-01T09:00:00Z', history: '[["2026-10-25",6],["2026-11-01",2]]' }]]);
  const f = euFacts(rows, { checks, best });
  assert.strictEqual(f.length, 2);
  const p = f.find((x) => x.key === 'eu|shopa.test/products/neck');
  assert.deepStrictEqual(p.ad_ids, ['2', '1']);
  assert.strictEqual(p.copies, 9);
  assert.strictEqual(p.ad_days, 30);
  assert.strictEqual(Math.round(p.reach_day), Math.round(400000 / 30));
  assert.strictEqual(p.store_products, 25);
  assert.deepStrictEqual(p.markets, ['NL', 'BE']);
  assert.strictEqual(p.jev.main, 'Sleep and comfort');
  assert.strictEqual(p.bs_rank, 2);
  assert.strictEqual(p.bs_move, 4, 'from #6 a week ago to #2');
});

test('outside the EU and TikTok: markets, the TikTok tab table and the research export, brands and page-level ads', () => {
  const w = worldFacts([{ product_key: 's.test/products/x', ad_id: 'w1', product_title: 'X', price: 59, currency: 'AUD', store_url: 'https://s.test/', product_url: 'https://s.test/products/x',
    markets: '{"AU":{"ads":3,"days":40},"NZ":{"ads":1,"days":12}}', ads: 4, days: 40, new14: 1, shop_ads: 90, store_products: 12, last_seen: '2026-11-01T05:00:00Z' }]);
  assert.deepStrictEqual(w[0].markets, ['AU', 'NZ']);
  assert.strictEqual(w[0].markets_n, 2);
  const csv = tiktokFacts([{ product_id: '17', title: 'KastKing Spartacus II reel', shop: 'KastKingUSA', sold: '12000', price_usd: '59.9', meta_status: 'matched', meta_ads_total: '400', meta_ads_au: '0', meta_ads_nz: '0',
    meta_oldest_ad_days: '236', ads_mention_n: '0', jev_category: 'Outdoor and travel', jev_blockers: 'sizing', price_suspect: 'false' }]);
  assert.strictEqual(csv[0].key, 'tiktok|17');
  assert.strictEqual(csv[0].brand_owned, true, 'a glued shop name: KastKingUSA sells KastKing');
  assert.strictEqual(csv[0].page_level, true, 'no sampled ad names the product');
  assert.strictEqual(csv[0].gap, true);
  assert.strictEqual(csv[0].store, 'tiktok shop kastkingusa');
  const shops = tiktokFacts([{ product_id: '20', title: 'KastKing BaitSpace sling bag', shop: 'KastKingUSA' }, { product_id: '21', title: '50L BaitSpace tackle backpack', shop: 'KastKingUSA' },
    { product_id: '22', title: 'MotorBox Americana leather seat covers', shop: 'Carbella Auto' }, { product_id: '23', title: 'MotorBox Cabin King seat covers', shop: 'Carbella Auto' },
    { product_id: '24', title: 'Cooling pillowcase set', shop: 'Carbella Auto' }]);
  assert.deepStrictEqual(shops.map((x) => x.brand_owned), [true, true, true, true, false], "a brand shop's listing without its name, and a brand line, are brand listings");
  assert.match(shops[1].brand_note, /brand shop KastKingUSA/);
  assert.match(shops[2].brand_note, /brand line \(MotorBox\)/);
  const tab = tiktokFacts([{ id: '18', title: 'Cooling sheet set', shop: 'Sleepy Co', url: 'https://www.tiktok.com/shop/pdp/18', price_min: 39, sold_us: 5000, category: 'Sleep and comfort', blockers: 'bulky', meta_status: 'none', price_suspect: 1 }]);
  assert.strictEqual(tab[0].sold, 5000);
  assert.strictEqual(tab[0].price, null, 'a suspect price is no price');
  assert.strictEqual(tab[0].brand_owned, false);
  assert.deepStrictEqual(tab[0].jev.p, { bulky: 1 });
});

test("Connor's decisions: one per product, the newest wins; undone ones do not count", () => {
  const byAd = adIndex([ad({ ad_id: '1' }), ad({ ad_id: '2' })], [{ ad_id: 'w9', product_key: 's.test/products/x' }]);
  const d = decisionsOf({
    hidden: [{ ad_id: '1', status: 'rejected', at: '2026-10-25T10:00:00Z' }, { ad_id: '2', status: 'seen', at: '2026-10-26T10:00:00Z' }, { ad_id: 'w9', status: 'seen', at: '2026-11-01T07:00:00Z' }],
    log: [{ product_key: 'world|s.test/products/x', decision: 'rejected', at: '2026-11-02T07:00:00Z', undone_at: '2026-11-02T08:00:00Z' }],
    tiktok: [{ id: '5', decision: 'approved', decided_at: '2026-11-01T09:00:00Z' }],
  }, byAd);
  const by = Object.fromEntries(d.map((x) => [x.key, x.y]));
  assert.strictEqual(by['eu|shopa.test/products/neck'], 1, 'the ✓ a day later wins over the ✗ (same product page)');
  assert.strictEqual(by['world|s.test/products/x'], 1, 'the undone rejection does not count');
  assert.strictEqual(by['tiktok|5'], 1);
});

test("Connor's own prices: a typed supplier price wins over the chosen supplier; the weight and shipping come along", () => {
  const f = withInputs([{ key: 'eu|a' }, { key: 'eu|b' }], { inputs: [{ product_key: 'eu|a', cost_text: '¥23.50', weight_g: 420 }], sourcing: [{ product_key: 'eu|a', supplier_cost: 4 }, { product_key: 'eu|b', supplier_cost: 3.2, weight_g: 300, ship_cost: 6.1 }] });
  assert.strictEqual(f[0].supplier_cost_text, '¥23.50');
  assert.strictEqual(f[0].weight_g, 420);
  assert.strictEqual(f[1].supplier_cost_text, '€3.2');
  assert.strictEqual(f[1].supplier_from, 'sourcing');
  assert.strictEqual(f[1].ship_eur, 6.1);
});
