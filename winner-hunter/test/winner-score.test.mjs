// The Winner Score (lib/winner-score.mjs): pillars, gates, the evidence ladder, coverage and the learned niches.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { ramp, rankStrength, idOf, undecidedOf, gateOf, riskOf, scoreProduct, scoreAll, learnNiche, SPEC } from '../lib/winner-score.mjs';
import { evaluate } from '../worker/src/econ.mjs';

const DAY = '2026-11-05';
const jevP = (o = {}) => ({ people: 0.01, animals: 0.01, gymwear: 0.01, physical: 0.99, face: 0.01, electric: 0.02, skin: 0.01, medical: 0.03, brand: 0.05, sizing: 0.03, fragile: 0.05,
  bulky: 0.05, restricted: 0.02, kids: 0.02, foodcontact: 0.02, hardsource: 0.1, problem: 0.8, wow: 0.6, beforeafter: 0.4, clear3s: 0.8, smalllight: 0.8, repeat: 0.1, upsell: 0.5,
  generic: 0.2, impulse: 0.5, gift: 0.4, personal: 0.05, ...o });
const base = (o = {}) => ({ key: 'world|shop.test/products/pillow', src: 'world', title: 'Cooling Pillow', store: 'shop.test', store_url: 'https://shop.test/',
  product_url: 'https://shop.test/products/pillow', price: 49.95, cur: 'EUR', jev: { p: jevP(), main: 'Sleep and comfort', sub: 'Pillows', product_score: 3 }, as_of: DAY, ...o });

test('ramp interpolates between points, flat outside them, and reads log scales', () => {
  assert.strictEqual(ramp(0, [[0, 0], [10, 1]]), 0);
  assert.strictEqual(ramp(5, [[0, 0], [10, 1]]), 0.5);
  assert.strictEqual(ramp(50, [[0, 0], [10, 1]]), 1);
  assert.strictEqual(ramp(-3, [[0, 0.2], [10, 1]]), 0.2);
  assert.ok(Math.abs(ramp(100, { log: true, pts: [[1, 0], [3, 1]] }) - 0.5) < 1e-9);
  assert.strictEqual(ramp(null, [[0, 0], [1, 1]]), null);
});

test('a best-seller rank: #1 strongest, 50 weakest, not in the top 50 is 0, a tiny store says little', () => {
  assert.ok(rankStrength(1, 100) > rankStrength(10, 100));
  assert.ok(rankStrength(10, 100) > rankStrength(50, 100));
  assert.strictEqual(rankStrength(60, 100), 0);
  assert.ok(rankStrength(1, 3) < rankStrength(1, 100) * 0.5, 'rank 1 of 3 products is no news');
  assert.strictEqual(rankStrength(null, 10), null);
});

test('ids are stable, file-safe and differ by key', () => {
  const a = idOf('world|shop.test/products/Kühl Kissen™');
  assert.match(a, /^[a-z0-9-]+$/);
  assert.strictEqual(a, idOf('world|shop.test/products/Kühl Kissen™'));
  assert.notStrictEqual(a, idOf('world|shop.test/products/kuhl-kissen-2'));
  assert.ok(a.length <= 67);
});

test('the gates: eaten or taken and gymwear are excluded, a Block is blocked, pet food and digital products stay', () => {
  const g = (o) => { const f = base(o); return gateOf(f, riskOf(f)).gate; };
  assert.strictEqual(g({ title: 'Magnesium Sleep Gummies', jev: { p: jevP({ people: 0.97 }), main: 'Food and supplements' } }), 'excluded');
  assert.strictEqual(g({ title: 'Ashwagandha calm capsules', jev: null }), 'excluded', 'the words alone, without Jev');
  assert.strictEqual(g({ title: 'Seamless gym leggings', jev: { p: jevP({ gymwear: 0.9 }), main: 'Clothing' } }), 'excluded');
  assert.strictEqual(g({ title: 'Retinol night cream', jev: null }), 'blocked');
  assert.strictEqual(g({ title: 'GroundingWell™ Bedsheet', product_url: 'https://groundingwell.com/products/groundingwell-bedsheet', jev: null }), 'blocked');
  assert.strictEqual(g({ title: 'KALM Bracelet / Your Natural Menopause Solution', jev: null }), 'blocked');
  assert.strictEqual(g({ title: '(BUNDEL) Total Bye Hyperpigmentation Package', jev: null }), 'blocked');
  assert.strictEqual(g({ title: 'LED face mask device', jev: { p: jevP({ face: 0.2 }), main: 'Beauty and personal care', sub: 'Tools' } }), null, 'a skin tool is no cosmetic by these words');
  assert.strictEqual(g({ title: 'Grain-free dog food 2 kg', jev: { p: jevP({ animals: 0.95 }), main: 'Pets', sub: 'Food and treats' } }), null, 'pet food stays (Connor, 31 Oct)');
  const digital = base({ title: 'Sleep coaching course (download)', jev: { p: jevP({ physical: 0.02 }), main: 'Other', sub: 'Services and digital' } });
  assert.strictEqual(gateOf(digital, riskOf(digital)).gate, null, 'a non-physical product is never gated for that');
  const handRead = base({ title: 'Budget planner spreadsheet', excluded: 'not a product', jev: { p: jevP({ physical: 0.1 }), main: 'Other' } });
  assert.strictEqual(gateOf(handRead, riskOf(handRead)).gate, null, "a source's 'not a product' is no gate either");
  assert.strictEqual(g({ title: 'Seamless set', excluded: 'gymwear', jev: null }), 'excluded');
});

test('another company\'s trademark in the title is a docs reason, not a block', () => {
  const s = scoreProduct(base({ title: 'Ostand Q3 VegSkin for iPhone Duo', jev: { p: jevP(), main: 'Tech' } }), { day: DAY });
  assert.strictEqual(s.risk.gate, null);
  assert.ok(s.risk.flags.includes('Docs: Trademark named (referential use only)'));
  assert.ok(!scoreProduct(base({ title: 'Cooling pillow' }), { day: DAY }).risk.flags.some((f) => /Trademark/.test(f)));
});

test('undecided categories are flagged, never gated', () => {
  assert.deepStrictEqual(undecidedOf('Anti-cellulite shaping leggings'), ['shaping or cellulite leggings']);
  assert.deepStrictEqual(undecidedOf('Breathe Right nasal strips 30 pack'), ['nose strips and sprays']);
  assert.deepStrictEqual(undecidedOf('Merino running socks'), ['running socks']);
  const s = scoreProduct(base({ title: 'Anti-cellulite shaping leggings', jev: { p: jevP(), main: 'Clothing' } }), { day: DAY });
  assert.strictEqual(s.risk.gate, null);
  assert.deepStrictEqual(s.risk.undecided, ['shaping or cellulite leggings']);
});

test('more proof scores higher; a gated product scores 0 but keeps its reasons', () => {
  const none = scoreProduct(base(), { day: DAY });
  const proven = scoreProduct(base({ bs_rank: 1, bs_ok: true, store_products: 40, ad_days: 90, copies: 30, shop_ads: 300 }), { day: DAY });
  assert.ok(proven.score > none.score + 10, `${proven.score} vs ${none.score}`);
  assert.ok(proven.pillars.proof > 0.8);
  assert.strictEqual(none.pillars.proof, SPEC.prior.proof, 'no proof at all: the prior');
  const gated = scoreProduct(base({ title: 'Collagen face serum', jev: { p: jevP({ skin: 0.95, face: 0.9 }), main: 'Beauty and personal care', sub: 'Skincare' }, bs_rank: 1, ad_days: 90 }), { day: DAY });
  assert.strictEqual(gated.score, 0);
  assert.strictEqual(gated.risk.gate, 'blocked');
  assert.ok(gated.pillars.proof > 0.5, 'the pillars are still worked out, so the card can say why');
});

test('the margin is the board\'s own (econ.mjs): VAT out first, then fees, refunds, product, shipping, customs', () => {
  const s = scoreProduct(base({ price: 49.95 }), { day: DAY });
  const e = evaluate({ price: 49.95, cur: 'EUR', src: 'world', risks: [], checked: true }, {}, null, DAY).m;
  assert.strictEqual(s.econ.breakeven_cpa_eur, e.be_cpa);
  assert.strictEqual(s.econ.supplier, 'est');
  assert.ok(s.econ.breakeven_cpa_eur < 49.95 / 1.21, 'VAT came out first');
  const typed = scoreProduct(base({ price: 49.95, supplier_cost_text: '¥20' }), { day: DAY });
  assert.strictEqual(typed.econ.supplier, 'yours');
  assert.ok(typed.pillars.margin > s.pillars.margin, 'a real, lower supplier price and no guess shrink');
  const unknown = scoreProduct(base({ price: null }), { day: DAY });
  assert.strictEqual(unknown.econ, null);
  assert.strictEqual(unknown.pillars.margin, SPEC.prior.margin);
  assert.strictEqual(unknown.ladder.profitable, null);
});

test('the ladder: paid, sustained, selling and profitable are true, false or unknown', () => {
  const s = scoreProduct(base({ ad_days: 45, copies: 2, bs_rank: 3, bs_ok: true, store_products: 30, price: 79.95 }), { day: DAY });
  assert.deepStrictEqual(s.ladder, { paid: true, sustained: true, selling: true, profitable: true });
  assert.strictEqual(s.level, 4);
  const thin = scoreProduct(base({ ad_days: 9, copies: 1, bs_checked: DAY, bs_ok: true, bs_rank: null, price: 12 }), { day: DAY });
  assert.strictEqual(thin.ladder.sustained, false);
  assert.strictEqual(thin.ladder.selling, false, 'checked and not in the top 50');
  assert.strictEqual(thin.ladder.profitable, false);
  assert.strictEqual(scoreProduct(base({ active: false, ad_days: 60 }), { day: DAY }).ladder.paid, false, 'the hunt no longer finds its ads');
  assert.strictEqual(scoreProduct(base({ src: 'eu', key: 'eu|x', as_of: '2026-10-10' }), { day: DAY }).ladder.paid, null, 'an EU row last seen 26 days ago');
  const young = scoreProduct(base({ ad_days: 9, copies: 5, shop_ads: 200 }), { day: DAY });
  assert.strictEqual(young.ladder.sustained, false, '5 ads in 9 days is a test being scaled, not sustained');
  assert.strictEqual(scoreProduct(base({ ad_days: 15, copies: 5, shop_ads: 200 }), { day: DAY }).ladder.sustained, true);
  const tt = scoreProduct(base({ src: 'tiktok', key: 'tiktok|1', sold: 25000, shop_ads: null }), { day: DAY });
  assert.strictEqual(tt.ladder.selling, true);
  assert.strictEqual(tt.ladder.paid, null, 'no Meta ads known for a TikTok listing');
});

test('every number says where it came from; facts and estimates apart', () => {
  const s = scoreProduct(base({ ad_days: 45, bs_rank: 2, bs_ok: true, store_products: 30, tp_reviews: 420, tp_score: 4.4 }), { day: DAY });
  for (const e of s.evidence) {
    assert.ok(['fact', 'estimate', 'claim'].includes(e.kind), e.signal);
    assert.ok(e.source, e.signal);
  }
  assert.strictEqual(s.evidence.find((e) => e.signal === 'breakeven_cpa_eur').kind, 'estimate', 'a guessed supplier price makes the CPA an estimate');
  assert.strictEqual(s.evidence.find((e) => e.signal === 'best_seller_rank').kind, 'fact');
  assert.ok(s.coverage > 0 && s.coverage <= 1);
});

test("a brand's own TikTok listing and page-level ad numbers count less, and say so", () => {
  const own = scoreProduct(base({ src: 'tiktok', key: 'tiktok|2', sold: 50000, brand_owned: true, brand_note: "the shop's name (Ridge Shop) is in the title" }), { day: DAY });
  const plain = scoreProduct(base({ src: 'tiktok', key: 'tiktok|3', sold: 50000 }), { day: DAY });
  assert.ok(own.pillars.competition < plain.pillars.competition);
  assert.ok(own.risk.flags.some((f) => /brand's own listing/.test(f)));
  const page = scoreProduct(base({ src: 'tiktok', key: 'tiktok|4', ad_days: 200, shop_ads: 400, page_level: true }), { day: DAY });
  const named = scoreProduct(base({ src: 'tiktok', key: 'tiktok|5', ad_days: 200, shop_ads: 400, page_level: false }), { day: DAY });
  assert.ok(page.pillars.proof < named.pillars.proof);
});

test("Connor's niches: learned from decisions, pulled to the overall rate, bounded", () => {
  const d = [...Array(10)].map((_, i) => ({ y: i < 7 ? 1 : 0, cat: 'Home' })).concat([...Array(10)].map((_, i) => ({ y: i < 1 ? 1 : 0, cat: 'Clothing' })), [{ y: 1, cat: 'Garden' }]);
  const n = learnNiche(d);
  assert.ok(n.byCat.Home.fit > SPEC.niche.Home, 'approved often: up');
  assert.ok(n.byCat.Clothing.fit < SPEC.niche.Clothing, 'rejected often: down');
  assert.ok(n.byCat.Garden.fit < 0.8, 'one approval is not a niche');
  for (const e of Object.values(n.byCat)) assert.ok(e.fit >= 0.05 && e.fit <= 0.95);
  const s1 = scoreProduct(base({ jev: { p: jevP(), main: 'Home' } }), { day: DAY, niche: n });
  const s0 = scoreProduct(base({ jev: { p: jevP(), main: 'Home' } }), { day: DAY });
  assert.ok(s1.pillars.fit > s0.pillars.fit);
});

test('scoreAll ranks the ungated by score, ties by evidence then key, and lists the gated apart', () => {
  const facts = [base({ key: 'world|a', bs_rank: 1, bs_ok: true, store_products: 20, ad_days: 60 }), base({ key: 'world|b' }), base({ key: 'world|c', title: 'Protein powder', jev: { p: jevP({ people: 0.99 }), main: 'Food and supplements' } })];
  const { ranked, gated } = scoreAll(facts, { day: DAY });
  assert.deepStrictEqual(ranked.map((r) => r.key), ['world|a', 'world|b']);
  assert.deepStrictEqual(ranked.map((r) => r.rank), [1, 2]);
  assert.deepStrictEqual(gated.map((g) => g.key), ['world|c']);
  assert.deepStrictEqual(scoreAll(facts, { day: DAY }).ranked.map((r) => r.score), ranked.map((r) => r.score), 'the same facts, the same scores');
});

test('the 36 approvals of the 1 Nov review: the 9 restricted ones never pass the gates', () => {
  const { products } = JSON.parse(fs.readFileSync(new URL('./fixtures/approved-36.json', import.meta.url), 'utf8'));
  for (const p of products) {
    const f = { key: 'eu|' + p.n, src: p.source === 'tiktok' ? 'tiktok' : p.source, title: p.title, product_url: p.product || '', store_url: p.store || '', price: p.price, cur: p.cur,
      jev: p.jev ? { p: p.jev.p || null, main: p.jev.main || '', sub: p.jev.sub || '', blockers: p.jev.blockers || '' } : null };
    const s = scoreProduct(f, { day: DAY });
    if (p.expect === 'block') assert.ok(s.risk.gate, `P${p.n} ${p.title} must be gated`);
  }
});
