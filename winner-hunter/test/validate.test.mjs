// The validate-first product sheet (worker/src/validate.mjs) and its batch tool (validate.mjs): the money of one order
// per market (VAT first, then fees, refunds, the product, shipping and import costs), the shipping fit against Connor's
// own Kungfubuy quotes, the compliance list, the supplier path, the staged test plan and its odds, the sheet, the digest
// fields, the CSV, the batch with its link checks, and the kit as the browser script. Pure: no network, no database.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { VALIDATE, VALIDATE_JS, sheetOf, renderSheet, digestOf, csvRow, CSV_COLS, orderOf, shipOf, customsOf, marketOf, testPlanOf, pAtLeast, launchStepsOf } from '../worker/src/validate.mjs';
import { RISK_JS } from '../worker/src/risk.mjs';
import { cleanStep, marginOf, marginInputs, summaryOf, STEPS } from '../worker/src/launch.mjs';
import { SOURCING_JS } from '../worker/src/sourcing.mjs';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { runSheets, quotesFrom, checkLinks, pasteInto, picksFrom, indexOf, argsOf, productSheet, pickFromScored, oneLineOf, missingOf, linksOf } from '../lib/validate.mjs';

const DAY = '2026-11-05';
const near = (a, b, d = 0.011) => assert.ok(Math.abs(a - b) <= d, `${a} is not ${b} (±${d})`);
const D = VALIDATE.DEFAULTS;

// Rows of Connor's Kungfubuy quotation export (research/2026-10-31-source-snapshots, read 31 Oct 2026; quotation numbers left
// out): product + YunExpress shipping for 1 to 4 units, the 1688 goods price and the weight Kungfubuy used. The shipping fit
// must reproduce them.
const QUOTES = [
  { id: 'Q-AU-1', day: '2026-07-28', country: 'Australia', goods_cny: 32, weight_g: 1200, eur: [16.81, 27.99, 39.37, 50.75, 0] },
  { id: 'Q-AU-2', day: '2026-07-28', country: 'Australia', goods_cny: 26, weight_g: 230, eur: [10.5, 15.2, 20.1, 25.02, 0] },
  { id: 'Q-AU-3', day: '2026-07-05', country: 'Australia', goods_cny: 114, weight_g: 704, eur: [25.74, 45.85, 66.15, 86.47, 0] },
  { id: 'Q-AU-4', day: '2026-09-06', offer: '598741273144', asked: 'https://detail.1688.com/offer/819402786700.html', country: 'Australia', goods_cny: 24.8, weight_g: 412, eur: [12.18, 0, 0, 0, 0] },
  { id: 'Q-NL-1', day: '2026-06-28', country: 'Holland', goods_cny: 27.5, weight_g: 90, eur: [9.76, 16.06, 22.57, 29.08, 0] },
  { id: 'Q-NL-2', day: '2026-06-25', country: 'Holland', goods_cny: 35, weight_g: 461, eur: [13.19, 22.94, 32.87, 42.81, 0] },
  { id: 'Q-PL-1', day: '2026-06-28', country: 'Poland', goods_cny: 28, weight_g: 160, eur: [9.42, 16.45, 23.68, 30.89, 0] },
  { id: 'Q-PL-2', day: '2026-06-24', country: 'Poland', goods_cny: 51, weight_g: 254, eur: [13.27, 24.14, 35.21, 46.28, 0] },
];
const CC = { Australia: 'AU', Holland: 'NL', Poland: 'PL' };

// ---------------------------------------------------------------------------
// One order: VAT first, then the rest
// ---------------------------------------------------------------------------

test('NL: VAT comes out first, then fees, refunds, product, shipping and the EU parcel fees (€5.42 for one kind of item)', () => {
  const o = orderOf({ market: marketOf('NL'), price: 39.95, units: 1, unit_cost: 5, grams: 300, refund_pct: 5, day: DAY });
  near(o.vat, (39.95 * 21) / 121); // 6.93: 21% inside the price
  near(o.net, 39.95 - (39.95 * 21) / 121);
  near(o.fees, 39.95 * 0.019 + 0.25); // Shopify Payments NL Basic, an EU card, euros: no conversion
  near(o.refunds, o.net * 0.05);
  near(o.ship, 3.31 + 5.5 * 0.3 + 2.08); // the NL fit at 300 g
  near(o.customs, 3 + 2 * 1.21); // €3 duty + €2 handling fee + 21% VAT on it: €5.42, as docs/sourcing/showerhead-muravai.md
  near(o.contribution, o.net - o.fees - o.refunds - 5 - o.ship - o.customs, 0.02);
  assert.strictEqual(o.be_cpa, o.contribution);
  near(o.be_roas, 39.95 / o.contribution, 0.01);
});

test('EU parcel fees follow the calendar: no duty before 1 Jul 2026, no handling fee before 1 Nov 2026, no flat duty and a door bill above €150', () => {
  const m = marketOf('DE');
  assert.strictEqual(customsOf(m, 30, 35.7, '2026-06-30').eur, 0);
  assert.strictEqual(customsOf(m, 30, 35.7, '2026-07-01').eur, 3);
  near(customsOf(m, 30, 35.7, '2026-11-01').eur, 3 + 2 * 1.19); // VAT on the fee at Germany's 19%
  const over = customsOf(m, 151, 179.69, DAY);
  assert.strictEqual(over.over, true);
  assert.deepStrictEqual(over.parts.map((p) => p.k), ['uhf'], 'above €150 only the handling fee, and the buyer pays the rest at the door');
  const o = orderOf({ market: m, price: 199, units: 1, unit_cost: 20, grams: 500, refund_pct: 5, day: DAY });
  assert.ok(VALIDATE.levelOf(o, D).reasons.some((r) => r.level === 'red' && /door/.test(r.text)));
});

test('outside the EU: GST once registered (AU, NZ), US duty on a DDP line, Swiss door rule, nothing in Singapore', () => {
  const au = orderOf({ market: marketOf('AU'), price: 40, units: 1, unit_cost: 4, grams: 300, refund_pct: 5, day: DAY });
  near(au.vat, 40 / 11); // GST 10% counted from the first order (it holds at scale)
  near(au.fees, 40 * (0.029 + 0.02) + 0.25); // an international card + 2% conversion (measured on snuggro's orders)
  const nz = orderOf({ market: marketOf('NZ'), price: 40, units: 1, unit_cost: 4, grams: 300, refund_pct: 5, day: DAY });
  near(nz.vat, (40 * 15) / 115);
  near(nz.customs, 2.54 / 1.9988); // the NZ$2.21 + GST border levy
  const us = orderOf({ market: marketOf('US'), price: 40, units: 1, unit_cost: 4, grams: 300, refund_pct: 5, day: DAY });
  assert.strictEqual(us.vat, 0);
  near(us.customs, 40 * 0.35); // the duty estimate on a DDP line
  const chLow = orderOf({ market: marketOf('CH'), price: 50, units: 1, unit_cost: 4, grams: 300, refund_pct: 5, day: DAY }); // CHF 45.94: free at the door
  assert.strictEqual(chLow.ddp_tax, 0);
  assert.strictEqual(chLow.customs, 0);
  const chHigh = orderOf({ market: marketOf('CH'), price: 90, units: 1, unit_cost: 4, grams: 300, refund_pct: 5, day: DAY }); // CHF 82.69: VAT + Swiss Post
  near(chHigh.ddp_tax, 90 * 0.081);
  near(chHigh.customs, 16 / 0.9188);
  const sg = orderOf({ market: marketOf('SG'), price: 40, units: 1, unit_cost: 4, grams: 300, refund_pct: 5, day: DAY });
  assert.strictEqual(sg.vat + sg.customs + sg.ddp_tax, 0);
});

test('every EU VAT rate is the Your Europe table; the markets the board hunts all have rules', () => {
  const want = { AT: 20, BE: 21, DE: 19, DK: 25, ES: 21, FI: 25.5, FR: 20, IE: 23, IT: 22, LU: 17, NL: 21, PL: 23, PT: 23, SE: 25, HU: 27 };
  for (const [cc, v] of Object.entries(want)) assert.strictEqual(VALIDATE.MARKETS[cc].tax.pct, v, cc);
  for (const cc of ['NL', 'BE', 'DE', 'FR', 'AT', 'ES', 'IT', 'IE', 'DK', 'SE', 'PL', 'AU', 'NZ', 'US', 'CA', 'GB', 'CH', 'NO', 'SG', 'HK', 'JP', 'KR', 'MY', 'IL', 'AE']) {
    const m = marketOf(cc);
    assert.ok(m && m.tax && m.tax.status && m.tax.source, cc);
    assert.ok(['checkout', 'registered', 'none', 'door'].includes(m.tax.how), cc);
  }
});

// ---------------------------------------------------------------------------
// Shipping: the fit against the real quotes
// ---------------------------------------------------------------------------

test('the shipping fit reproduces Connor\'s Kungfubuy quotes (product + shipping, 1 to 4 units) within €1.50', () => {
  for (const q of QUOTES) {
    const m = marketOf(CC[q.country]);
    q.eur.forEach((total, i) => {
      if (!total) return;
      const n = i + 1;
      const fit = n * q.goods_cny * VALIDATE.AGENT.goods_eur_per_cny + shipOf(m, n, q.weight_g).eur;
      assert.ok(Math.abs(fit - total) <= 1.5, `${q.id} ${n} units: fit ${fit.toFixed(2)}, quoted ${total}`);
    });
  }
});

test('markets without a quote: YunExpress list price + Kungfubuy\'s premium; else the nearest fit, marked a guess', () => {
  const nz = shipOf(marketOf('NZ'), 1, 300);
  near(nz.eur, 53.51 / 7.5177 + 2.62);
  assert.strictEqual(nz.status, 'estimate');
  near(shipOf(marketOf('NZ'), 1, 500).eur, 72.31 / 7.5177 + 2.62);
  near(shipOf(marketOf('NZ'), 2, 250).eur, 72.31 / 7.5177 + 2.62, 0.011); // 2 × 250 g is one 500 g parcel
  const be = shipOf(marketOf('BE'), 1, 300);
  assert.strictEqual(be.status, 'guess');
  assert.match(be.basis, /Netherlands/);
  assert.strictEqual(shipOf(marketOf('NL'), 1, 300).status, 'estimate');
});

test('a quote to the test market itself is the fact for product + shipping; elsewhere its goods price and weight count', () => {
  const pick = { id: 'heart', name: 'Heart memory foam leg pillow', source: 'world', price: 89.95, cur: 'AUD', markets: ['AU'], supplier: { url: 'https://detail.1688.com/offer/819402786700.html?spm=x' } };
  const s = sheetOf(pick, { day: DAY, quotes: QUOTES, settings: { home: 'AU' } });
  const au = s.economics.markets[0];
  assert.strictEqual(au.cc, 'AU');
  assert.strictEqual(au.quoted, true);
  near(au.offers[0].product + au.offers[0].ship, 12.18);
  assert.strictEqual(au.offers[0].ship_status, 'fact');
  assert.strictEqual(s.economics.inputs.cost.status, 'fact');
  assert.strictEqual(s.economics.inputs.grams.g, 412);
  const nl = s.economics.markets.find((m) => m.cc === 'NL');
  assert.strictEqual(nl.quoted, false);
  assert.notStrictEqual(nl.offers[0].ship_status, 'fact');
  assert.strictEqual(s.supplier.status, 'quote');
  assert.strictEqual(s.supplier.quote.id, 'Q-AU-4');
});

// ---------------------------------------------------------------------------
// Estimates for what is unknown
// ---------------------------------------------------------------------------

test('no supplier price and no weight: 15% of the price and a weight from its name, both marked as guesses', () => {
  const s = sheetOf({ id: 'w', name: 'Weighted blanket 7kg', price: 79.95, cur: 'EUR', source: 'eu' }, { day: DAY, settings: { home: 'NL' } });
  assert.strictEqual(s.economics.inputs.cost.status, 'guess');
  near(s.economics.inputs.cost.eur, 79.95 * 0.15);
  assert.strictEqual(s.economics.inputs.grams.g, 5000, 'the radar calls a 7 kg blanket bulky: 5 kg at least');
  assert.strictEqual(s.economics.inputs.grams.status, 'guess');
  assert.strictEqual(sheetOf({ id: 'c', name: 'Cooling pillow', price: 49, cur: 'EUR' }, { day: DAY }).economics.inputs.grams.g, 900);
  const lug = sheetOf({ id: 'l', name: 'Miusse 3-Piece Luggage Set carry-on', price: 149.99, cur: 'USD' }, { day: DAY });
  assert.strictEqual(lug.economics.inputs.grams.g, 4000);
  const nz = lug.economics.markets[0];
  assert.strictEqual(nz.offers[0].ship_status, 'guess', 'past the weights the quotes were taken at');
  assert.ok(nz.reasons.some((r) => r.level === 'amber' && /4\.0 kg a parcel: .*freight quote/.test(r.text)));
  assert.ok(s.assumptions.some((a) => /Supplier cost/.test(a) && /guess/.test(a)));
  assert.match(digestOf(s).line, /est\. supplier price/);
  const plain = sheetOf({ id: 'p', name: 'Thing', price: 20, cur: 'EUR' }, { day: DAY });
  assert.strictEqual(plain.economics.inputs.grams.g, D.weight_guess_g);
});

test('a pasted 1688 price is an estimate in yuan at the agent\'s rate; prices in any currency the ECB lists', () => {
  const s = sheetOf({ id: 'x', name: 'Pillow speaker', price: 'A$59.95', supplier: { cost: '¥23.50', weight_g: 200 } }, { day: DAY });
  near(s.economics.inputs.cost.eur, 23.5 * VALIDATE.AGENT.goods_eur_per_cny);
  assert.strictEqual(s.economics.inputs.cost.status, 'estimate');
  near(s.economics.inputs.price.eur, 59.95 / 1.6061);
  assert.deepStrictEqual(VALIDATE.priceOf('12,50 €'), { amount: 12.5, cur: 'EUR' });
  assert.deepStrictEqual(VALIDATE.priceOf('US$3.20'), { amount: 3.2, cur: 'USD' });
  assert.deepStrictEqual(VALIDATE.priceOf('NZ$1,299.00'), { amount: 1299, cur: 'NZD' });
  assert.strictEqual(VALIDATE.priceOf('free'), null);
  const none = sheetOf({ id: 'n', name: 'No price at all' }, { day: DAY });
  assert.strictEqual(none.economics.markets[0].offers.length, 0);
  assert.strictEqual(none.test_plan.go, false);
});

test('margin as a line in the price: the price that turns it green, and the most a supplier may ask', () => {
  const s = sheetOf({ id: 'g', name: 'Cooling pillowcase', price: 59.95, cur: 'NZD', supplier: { cost: '¥18', weight_g: 150 } }, { day: DAY });
  const nz = s.economics.markets[0];
  assert.ok(nz.min_price > nz.offers[0].price, 'amber now, green from a higher price');
  const at = sheetOf({ id: 'g2', name: 'Cooling pillowcase', price: nz.min_price, cur: 'EUR', supplier: { cost: '¥18', weight_g: 150 } }, { day: DAY });
  near(at.economics.markets[0].offers[0].be_roas, D.green_roas, 0.02);
  const cheap = sheetOf({ id: 'g3', name: 'Cooling pillowcase', price: 89.95, cur: 'NZD', supplier: { cost: '¥18', weight_g: 150 } }, { day: DAY }).economics.markets[0];
  assert.ok(cheap.max_cost > 0 && cheap.max_cost_cny > 0);
  assert.strictEqual(nz.before_registration, VALIDATE.MARKETS.NZ ? Math.round((nz.offers[0].contribution + nz.offers[0].vat) * 100) / 100 : null);
});

test('offers: 2 and 3 units share one parcel and one set of EU fees, so a bundle leaves more per order', () => {
  const s = sheetOf({ id: 'b', name: 'Silk eye mask', price: 24.95, cur: 'EUR', source: 'eu', supplier: { cost: '¥27.50', weight_g: 90 } }, { day: DAY, settings: { home: 'NL' } });
  const [one, two, three] = s.economics.markets[0].offers;
  assert.deepStrictEqual([one.units, two.units, three.units], [1, 2, 3]);
  near(two.price, 24.95 * 2 * 0.85);
  assert.strictEqual(two.customs, one.customs, 'the same item twice: one €3 + €2');
  assert.ok(two.contribution > one.contribution);
});

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

test('compliance: CE, WEEE, battery and radio papers for an electric gadget; cosmetics block; GPSR to do in the EU only', () => {
  const lamp = sheetOf({ id: 'l', name: 'Rechargeable LED sunset lamp with Bluetooth speaker', price: 39.95, cur: 'EUR', source: 'eu' }, { day: DAY, settings: { home: 'NL' } }).compliance;
  const st = Object.fromEntries(lamp.items.map((i) => [i.k, i.status]));
  assert.strictEqual(lamp.level, 'docs');
  assert.deepStrictEqual([st.ce, st.weee, st.battery, st.radio, st.gpsr], ['docs', 'docs', 'docs', 'docs', 'todo']);
  assert.match(lamp.main, /^Docs: CE/);
  assert.ok(lamp.ask.some((a) => /UN38\.3/.test(a[0])));
  const serum = sheetOf({ id: 's', name: 'Rosemary hair growth serum', price: 29.95, cur: 'EUR', source: 'eu' }, { day: DAY }).compliance;
  assert.strictEqual(serum.level, 'block');
  assert.strictEqual(serum.items.find((i) => i.k === 'cosmetics').status, 'blocker');
  assert.match(serum.main, /^Block: Cosmetic/);
  const nzOnly = sheetOf({ id: 'z', name: 'Bamboo pillowcase', price: 59, cur: 'NZD', markets: ['NZ'] }, { day: DAY, settings: { home: 'NZ' } });
  assert.strictEqual(nzOnly.compliance.items.find((i) => i.k === 'gpsr').status, 'todo', 'NL and DE are on its market list too');
  const noEu = VALIDATE.complianceOf({ name: 'Bamboo pillowcase' }, ['NZ', 'AU']);
  assert.strictEqual(noEu.items.find((i) => i.k === 'gpsr').status, 'n/a');
  assert.strictEqual(noEu.main, 'No blocker found');
});

test('Connor\'s rules: food and gymwear off the board, the undecided categories flagged (never decided), digital never blocked', () => {
  const gym = VALIDATE.complianceOf({ name: 'Seamless gym leggings scrunch butt' }, ['US']);
  assert.strictEqual(gym.level, 'block');
  assert.ok(gym.excluded.some((x) => x.k === 'gymwear'));
  const shaping = VALIDATE.complianceOf({ name: 'Anti cellulite shaping leggings' }, ['US']);
  assert.ok(!shaping.excluded.some((x) => x.k === 'gymwear'), 'shaping leggings are undecided, not gymwear');
  assert.ok(shaping.undecided.some((x) => x.k === 'shaping'));
  const pet = VALIDATE.complianceOf({ name: 'Freeze dried chicken dog treats' }, ['AU']);
  assert.ok(pet.undecided.some((x) => x.k === 'petfood'));
  assert.notStrictEqual(pet.level, 'block');
  const food = VALIDATE.complianceOf({ name: 'Ashwagandha gummies for sleep' }, ['AU']);
  assert.strictEqual(food.level, 'block');
  assert.ok(food.excluded.some((x) => x.k === 'eat'));
  const people = VALIDATE.complianceOf({ name: 'Sleep drops', risks: [{ k: 'people', text: 'People take it' }] }, ['AU']);
  assert.ok(people.excluded.some((x) => x.k === 'eat'), 'Jev\'s "people take it" is off the board too');
  const gift = VALIDATE.complianceOf({ name: 'Digital gift card' }, ['NL']);
  assert.notStrictEqual(gift.level, 'block');
  const nose = VALIDATE.complianceOf({ name: 'Magnetic nasal strips' }, ['AU']);
  assert.ok(nose.undecided.some((x) => x.k === 'nose'));
});

test('market stops: an electric product sold to Australia or New Zealand says who must sign for it there', () => {
  const c = VALIDATE.complianceOf({ name: 'Electric heated blanket with USB controller' }, ['AU', 'NZ']);
  assert.deepStrictEqual(c.stops.map((x) => x.cc), ['AU', 'NZ']);
  assert.ok(c.stops.every((x) => /^https:\/\//.test(x.source)));
});

// ---------------------------------------------------------------------------
// The test plan
// ---------------------------------------------------------------------------

test('the staged test reproduces Connor\'s 1 Nov plan: carts at €40 and sales to keep at €140 from the break-even CPA', () => {
  const plan = (be) => {
    const econ = { markets: [{ cc: 'NZ', name: 'New Zealand', cur: 'NZD', level: 'green', reasons: [], offers: [{ units: 1, off: 0, price: be * 2, contribution: be, be_cpa: be, be_roas: 2 }] }] };
    return testPlanOf(econ, { level: 'ok', items: [], main: 'No blocker found' }, {}, D, DAY);
  };
  // The 1 Nov plan's three products: break-even €22.37 / €26.99 / €29.27 → 5 / 4 / 4 carts at €40, 7 / 6 / 5 sales at €140.
  for (const [be, carts, sales] of [[22.37, 5, 7], [26.99, 4, 6], [29.27, 4, 5]]) {
    const p = plan(be);
    assert.strictEqual(p.go, true);
    assert.match(p.gates[1].rule, new RegExp(`or ${carts} add-to-carts`));
    assert.match(p.gates[3].rule, new RegExp(`Keep with ${sales} or more sales`));
    assert.match(p.gates[0].rule, new RegExp(`€${(Math.round(be * 3) / 100).toFixed(2)}`)); // CPC up to break-even × 3%
  }
  const p = plan(20);
  assert.strictEqual(p.budget, 140);
  assert.strictEqual(p.daily, 20);
  assert.strictEqual(p.days, 7);
  assert.strictEqual(p.timeline[0].day, DAY);
  assert.strictEqual(p.timeline[2].day, '2026-11-06');
  near(p.odds.sale40.even, (1 - Math.exp(-2)) * 100, 0.06);
});

test('the odds are Poisson: P(at least k sales) for a spend at a true CPA', () => {
  near(pAtLeast(1, 40, 20), 1 - Math.exp(-2), 1e-9);
  near(pAtLeast(0, 40, 20), 1, 1e-12);
  near(pAtLeast(2, 20, 20), 1 - 2 * Math.exp(-1), 1e-9);
  assert.strictEqual(pAtLeast(1, 40, 0), 0);
});

test('no test for a red or blocked product: the sheet says why and what would turn it green', () => {
  const red = sheetOf({ id: 'r', name: 'Cheap thing', price: 14.95, cur: 'EUR', source: 'eu' }, { day: DAY, settings: { home: 'NL' } });
  assert.strictEqual(red.level, 'red');
  assert.strictEqual(red.test_plan.go, false);
  assert.match(red.test_plan.why, /no test at this price|Loses money/);
  const blocked = sheetOf({ id: 'k', name: 'Teeth whitening kit', price: 49.95, cur: 'EUR' }, { day: DAY });
  assert.strictEqual(blocked.test_plan.go, false);
  assert.match(blocked.test_plan.why, /^Blocked/);
});

test('a made-to-order product gets the pre-order test (waitlist, then pre-orders with the agent\'s ship date)', () => {
  const s = sheetOf({ id: 'rv', name: 'Made-to-measure caravan bed sheet', price: 'A$149', markets: ['AU'], made_to_order: true, supplier: { cost: '$10', weight_g: 1200 } }, { day: DAY, settings: { home: 'AU' } });
  assert.strictEqual(s.test_plan.go, true);
  assert.strictEqual(s.test_plan.mode, 'preorder');
  assert.ok(s.test_plan.gates.some((g) => /0\.8%/.test(g.rule)));
  near(s.test_plan.budget, 450 / 1.6061);
});

// ---------------------------------------------------------------------------
// The sheet, the digest, the CSV
// ---------------------------------------------------------------------------

const FULL = {
  id: 'cool-pillowcase', key: 'world|chillpillow.co.nz/products/cool', name: 'Cooling pillowcase', source: 'world', price: 79.95, cur: 'NZD', markets: ['NZ', 'AU'],
  product_url: 'https://chillpillow.co.nz/products/cool', store_url: 'https://chillpillow.co.nz', ad_url: 'https://www.facebook.com/ads/library/?id=1', age_days: 34, store_products: 12, best_rank: 2,
  supplier: { url: 'https://detail.1688.com/offer/123456789.html', cost: '¥18', weight_g: 180, moq: 2 },
  audience: { problem: 'Waking up hot and sweaty', personas: [{ age: '25-44', gender: 'women', countries: ['NZ'], situation: 'hot summer nights' }], angles: ['Hook A', 'Hook B', 'Hook C'] },
  score: { total: 71, breakdown: { demand: 20, proof: 30, margin: 21 } },
};

test('the sheet has every section CLAUDE.md asks for, links with their check, and facts apart from assumptions', () => {
  const links = { 'https://chillpillow.co.nz/products/cool': { ok: true, status: 200, checked: DAY }, 'https://chillpillow.co.nz': { ok: false, status: 403, checked: DAY } };
  const s = sheetOf(FULL, { day: DAY, links });
  const md = renderSheet(s);
  for (const h of ['## Product and problem', '## Evidence that it sells', '## Links', '## Margin per offer and break-even CPA', '## Landed cost and shipping', '## Compliance and IP', '## Supplier path', '## Validation test plan', '## Blockers and the reason not to do it', '## Facts and assumptions']) assert.ok(md.includes(h), h);
  assert.match(md, /\*\*1688 link: ______\*\*/);
  assert.match(md, /opens \(200, 2026-11-05\)/);
  assert.match(md, /\*\*did not open\*\* \(403/);
  assert.match(md, /Winner score: \*\*71\*\*/);
  assert.match(md, /Waking up hot and sweaty/);
  assert.match(md, /1\. Hook A 2\. Hook B 3\. Hook C/);
  assert.ok(s.facts.length >= 3 && s.assumptions.length >= 2);
  assert.ok(s.assumptions.some((a) => /Store did not open/.test(a)));
  assert.ok(md.split('\n').length < 135, `one page: under 135 lines (${md.split('\n').length})`);
  assert.match(md, /Clear \(nothing found in its name, link or Jev's answers\): CE, WEEE, Battery/);
});

test('the digest fields: test market, margin and break-even CPA in euros, the main blocker, one line', () => {
  const d = digestOf(sheetOf(FULL, { day: DAY }));
  assert.strictEqual(d.market, 'NZ');
  assert.ok(d.margin_eur > 0);
  assert.strictEqual(d.be_cpa_eur, d.margin_eur);
  assert.strictEqual(d.main_blocker, 'No blocker found');
  assert.match(d.line, /^NZ: €\d+\.\d\d margin, break-even CPA €\d+\.\d\d \(est\. supplier price\) · No blocker found$/);
});

test('the CSV row: the columns in order, commas quoted, no spreadsheet formula', () => {
  const s = sheetOf(Object.assign({}, FULL, { id: '=HYPERLINK("x")', name: 'Pillow, cooling' }), { day: DAY });
  const row = csvRow(s);
  assert.ok(row.startsWith('"=HYPERLINK(""x"")","Pillow, cooling",2026-11-05,'));
  assert.strictEqual(CSV_COLS[0], 'id');
  assert.strictEqual(CSV_COLS.length, 22);
});

test('the same pick on the same day gives the same sheet (the batch is idempotent)', () => {
  const a = JSON.stringify(sheetOf(FULL, { day: DAY, quotes: QUOTES }));
  const b = JSON.stringify(sheetOf(JSON.parse(JSON.stringify(FULL)), { day: DAY, quotes: QUOTES }));
  assert.strictEqual(a, b);
});

test('/validate.js: the browser runs the same kit (with /risk.js and /sourcing.js) and makes the very same sheet', () => {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(RISK_JS, ctx);
  vm.runInContext(SOURCING_JS, ctx);
  vm.runInContext(VALIDATE_JS, ctx);
  const there = ctx.window.VALIDATE.sheetOf(JSON.parse(JSON.stringify(FULL)), { day: DAY });
  assert.strictEqual(JSON.stringify(there), JSON.stringify(sheetOf(FULL, { day: DAY })));
});

// ---------------------------------------------------------------------------
// The batch tool
// ---------------------------------------------------------------------------

const SCORED = {
  rank: 1, key: 'world|calmbed.no/products/calmbed', id: 'world-calmbed-no-products-calmbed-1a2b3c', name: 'CalmBed calming dog bed', src: 'world', category: 'Pets', sub: 'Beds',
  score: 71, level: 3, pillars: { proof: 0.82, demand: 0.55, competition: 0.6, margin: 0.7, fit: 0.64 }, risk: { mult: 0.85, gate: null, flags: ['Docs: CE'], undecided: [] },
  price: { amount: 650, currency: 'NOK', eur: 62.52 }, econ: { margin_eur: 21.3, breakeven_cpa_eur: 21.3, supplier_cost_eur: 8.3, supplier: 'est' },
  evidence: [{ signal: 'oldest_ad_days', value: 64, kind: 'fact', source: 'Meta Ad Library', date: '2026-11-01', link: 'https://www.facebook.com/ads/library/?id=1' }, { signal: 'revenue_month', value: '$40k', kind: 'claim', source: 'a spy tool', date: '2026-10-30' }],
  links: { product_url: 'https://calmbed.no/products/calmbed', store_url: 'https://calmbed.no', ad_library: ['https://www.facebook.com/ads/library/?id=1'], board: 'https://board.example/#today/world-calmbed' },
  ad_ids: ['1'], stores: ['calmbed.no'], markets: ['NO', 'SE'],
};

test('runSheets: one sheet per pick, a broken pick reported and the rest still made, the index sorted by break-even CPA', async () => {
  const picks = [FULL, { id: 'cheap', name: 'Cheap thing', price: 9.95, cur: 'EUR' }, { id: 'serum', name: 'Hair serum', price: 29, cur: 'EUR' }, { id: 'bad', name: 'Bad', get price() { throw new Error('broken'); } }, SCORED];
  const { sheets, files, summary } = await runSheets(picks, { day: DAY, quotes: QUOTES });
  assert.strictEqual(summary.sheets, 4);
  const scored = sheets.find((s) => s.id === SCORED.id);
  assert.ok(scored.economics.markets[0].offers.length, 'a scored pick (price as an object) is read through pickFromScored');
  assert.ok(linksOf([SCORED]).includes('https://calmbed.no/products/calmbed'));
  assert.deepStrictEqual(summary.failed.map((f) => f.id), ['bad']);
  assert.ok(files['cool-pillowcase.json'] && files['cool-pillowcase.md'] && files['index.md'] && files['sheets.csv'] && files['summary.json']);
  assert.strictEqual(summary.blocked, 1);
  const rows = files['index.md'].split('\n').filter((l) => l.startsWith('| ['));
  const be = rows.map((l) => l.split(' | ')[4]).map((c) => (c === '–' ? -1 : Number(c.replace('€', ''))));
  assert.deepStrictEqual(be, [...be].sort((a, b) => b - a), 'the most room for ads first');
  assert.ok(rows.some((l) => l.includes('(cool-pillowcase.md)')));
  assert.strictEqual(sheets.length, 4);
  assert.strictEqual(summary.digest.length, 4);
  assert.doesNotMatch(files['summary.json'], /"ms"/, 'no timing in the file');
  assert.match(indexOf(sheets, DAY), /^# Product sheets, 2026-11-05/);
});

test('checkLinks: opens each link once a day (cache), records a bot wall or a timeout as not opening', async () => {
  const calls = [];
  const fake = async (u, init) => {
    calls.push(u);
    if (u.includes('slow')) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    return { status: u.includes('wall') || u.includes('facebook') ? 403 : 200, body: { cancel: async () => {} } };
  };
  const urls = ['https://a.test/x', 'https://wall.test/y', 'https://slow.test/z', 'http://not-https.test', 'https://a.test/x', 'https://www.facebook.com/ads/library/?id=1'];
  const got = await checkLinks(urls, { day: DAY, fetch: fake, timeoutMs: 30 });
  assert.deepStrictEqual(got['https://a.test/x'], { ok: true, status: 200, checked: DAY });
  assert.deepStrictEqual(got['https://wall.test/y'], { ok: false, status: 403, checked: DAY });
  assert.deepStrictEqual(got['https://slow.test/z'], { ok: false, status: 'timeout', checked: DAY });
  assert.deepStrictEqual(got['https://www.facebook.com/ads/library/?id=1'], { ok: null, status: 'bot wall (403)', checked: DAY }, 'Facebook\'s bot wall is not a broken link');
  assert.strictEqual(calls.length, 4, 'once each, https only');
  const again = await checkLinks(urls, { day: DAY, cache: got, fetch: fake });
  assert.strictEqual(calls.length, 4, 'the same day: from the cache');
  const browser = { 'https://www.facebook.com/ads/library/?id=1': { ok: true, status: 'browser: ad shown', checked: DAY, via: 'browser', active: true, started: 'Jun 14, 2026' } };
  const md = renderSheet(sheetOf({ id: 'b', name: 'B', price: 20, cur: 'EUR', ad_url: 'https://www.facebook.com/ads/library/?id=1' }, { day: DAY, links: Object.assign({}, got, browser) }));
  assert.match(md, /opens in a browser \(2026-11-05\), the ad is active, running since Jun 14, 2026/);
  const walled = renderSheet(sheetOf({ id: 'w', name: 'W', price: 20, cur: 'EUR', ad_url: 'https://www.facebook.com/ads/library/?id=1' }, { day: DAY, links: got }));
  assert.match(walled, /not checkable by script \(bot wall \(403\), 2026-11-05\)/);
  assert.deepStrictEqual(again, got);
});

test('quotesFrom: the raw Kungfubuy export and the flat CSV give the same quotes', () => {
  const raw = [{ order_no: 'N1', create_at: '2026-09-06 10:00:00', product: [{ un_good_url: 'https://detail.1688.com/offer/819402786700.html', relates_information: JSON.stringify({ Australia: { country: 'Australia', channel: '{}', nameOne: '12.18', nameTwo: '0', nameThree: '0', nameFour: '0', nameFive: '0', company: 'YunExpress' } }).replace(/"/g, '&quot;'), order_items: [{ goods_sku: 'TJ6893-1', goods_spec: 'heart', price_selling: '24.80', weight: 350, quotation_weight: 412, goods_url: 'https://detail.1688.com/offer/598741273144.html?spm=a' }] }] }];
  const a = quotesFrom(JSON.stringify(raw));
  assert.deepStrictEqual(a, [{ id: 'N1', day: '2026-09-06', offer: '598741273144', asked: 'https://detail.1688.com/offer/819402786700.html', sku: 'TJ6893-1', spec: 'heart', country: 'Australia', goods_cny: 24.8, weight_g: 412, eur: [12.18, 0, 0, 0, 0] }]);
  const csv = 'order_no,created,status,sku,spec,goods_cny,quote_cost_cny,last_buy_cny,weight_g,quote_weight_g,country,channel,code,company,eur1,eur2,eur3,eur4,eur5,link_1688,asked_link\n'
    + 'N1,2026-09-06 10:00:00,40,TJ6893-1,heart,24.80,20,15,350,412,Australia,x,THPHR,YunExpress,12.18,0,0,0,0,https://detail.1688.com/offer/598741273144.html?spm=a,https://detail.1688.com/offer/819402786700.html\n'
    + 'N2,2026-10-02 14:25:29,26,,,,,,,,,,,,,,,,,,\n';
  assert.deepStrictEqual(quotesFrom(csv), a);
});

test('paste: a 1688 share text puts the link, price and MOQ on the pick; the next sheet uses them', () => {
  const picks = [{ id: 'p1', name: 'Cooling pillowcase', price: 59.95, cur: 'NZD' }];
  pasteInto(picks, 'p1', '【1688】冰丝枕套 ¥18.50 起批 2件 https://detail.1688.com/offer/735512345678.html?spm=a26352.13672862');
  assert.strictEqual(picks[0].supplier.url, 'https://detail.1688.com/offer/735512345678.html');
  assert.strictEqual(picks[0].supplier.cost, '¥18.5');
  assert.strictEqual(picks[0].supplier.moq, 2);
  const s = sheetOf(picks[0], { day: DAY });
  near(s.economics.inputs.cost.eur, 18.5 * VALIDATE.AGENT.goods_eur_per_cny);
  assert.strictEqual(s.supplier.status, 'link');
  assert.throws(() => pasteInto(picks, 'nope', 'https://detail.1688.com/offer/1.html'), /No pick/);
  assert.throws(() => pasteInto(picks, 'p1', 'no link here'), /No link/);
});

test('the CLI: sheets for a picks file into a folder, the same files on a second run, calc to the terminal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-validate-'));
  try {
    const picksFile = path.join(dir, 'picks.json');
    fs.writeFileSync(picksFile, JSON.stringify({ picks: [FULL, { id: 'serum', name: 'Hair serum', price: 29, cur: 'EUR' }] }));
    const cli = new URL('../validate.mjs', import.meta.url).pathname;
    const out = path.join(dir, 'out');
    const run = () => JSON.parse(execFileSync(process.execPath, [cli, 'sheets', '--in', picksFile, '--out', out, '--day', DAY], { encoding: 'utf8' }));
    const first = run();
    assert.strictEqual(first.sheets, 2);
    const files = fs.readdirSync(out).sort();
    assert.deepStrictEqual(files, ['cool-pillowcase.json', 'cool-pillowcase.md', 'index.md', 'serum.json', 'serum.md', 'sheets.csv', 'summary.json']);
    const before = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(out, f), 'utf8')]));
    run();
    for (const f of files) assert.strictEqual(fs.readFileSync(path.join(out, f), 'utf8'), before[f], f);
    const md = execFileSync(process.execPath, [cli, 'calc', '--name', 'Cooling pillowcase', '--price', 'NZ$59.95', '--cost', '¥18', '--weight', '150', '--day', DAY], { encoding: 'utf8' });
    assert.match(md, /^# Cooling pillowcase/);
    assert.deepStrictEqual(picksFrom('[{"id":"a"},{"x":1}]'), [{ id: 'a' }]);
    assert.deepStrictEqual(argsOf(['--in', 'a.json', '--check-links', 'x']), { _: ['x'], in: 'a.json', 'check-links': true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The daily job's step (shared/INTERFACES.md)
// ---------------------------------------------------------------------------


test('pickFromScored: the scorer\'s product in the sheet\'s shape (price, links, markets, evidence with claims kept as claims)', () => {
  const p = pickFromScored(SCORED);
  assert.strictEqual(p.id, SCORED.id);
  assert.strictEqual(p.price, 650);
  assert.strictEqual(p.cur, 'NOK');
  assert.deepStrictEqual(p.markets, ['NO', 'SE']);
  assert.strictEqual(p.ad_url, 'https://www.facebook.com/ads/library/?id=1');
  assert.strictEqual(p.board_url, 'https://board.example/#today/world-calmbed');
  assert.deepStrictEqual(p.category, { main: 'Pets', sub: 'Beds' });
  assert.strictEqual(p.score.total, 71);
  assert.strictEqual(p.score.breakdown.proof, 82);
  assert.ok(p.evidence.some((e) => /claim/.test(e.status)));
  assert.strictEqual(p.zh, '狗窝', 'Chinese 1688 words from the title (pipeline.mjs zhGuess)');
  const own = { id: 'x', name: 'Own shape', price: 10, cur: 'EUR' };
  assert.strictEqual(pickFromScored(own), own);
});

test('productSheet: the sheet, the digest numbers, a one-line phrase under 110 characters, and what is missing', async () => {
  const out = await productSheet(SCORED, { day: '2026-11-06', now: '2026-11-05T23:00:00Z' });
  assert.strictEqual(out.sheet.id, SCORED.id);
  assert.strictEqual(out.market, 'NZ', 'tested in the store\'s market, NO and SE on the sheet too');
  assert.ok(out.sheet.economics.markets.some((m) => m.cc === 'NO'));
  assert.strictEqual(out.breakeven_cpa_eur, out.margin_eur);
  assert.ok(out.one_line.length <= 110, out.one_line);
  assert.match(out.one_line, /^Margin €\d+, break-even CPA €\d+ in NZ \(est\.\)\. Blocker: /);
  assert.ok(out.missing.includes('a supplier price (estimated from the selling price)'));
  assert.ok(out.missing.includes('the audience card'));
  assert.ok(out.missing.includes('a link check'), 'no ctx.fetch: no link check');
  assert.match(out.md, /^# CalmBed calming dog bed/);
  assert.match(out.md, /1688\]\(https:\/\/s\.1688\.com\/selloffer\/offer_search\.htm\?charset=utf8&keywords=%E7%8B%97%E7%AA%9D\)/);
  assert.deepStrictEqual(out.spent, { credits: 0, jevUsd: 0 });
});

test('productSheet: links checked through ctx.fetch and cached across runs in ctx.cache; an aborted run still returns a sheet', async () => {
  const store = new Map();
  const cache = { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v) };
  let calls = 0;
  const fetch = async () => {
    calls++;
    return { status: 200, body: null };
  };
  const a = await productSheet(SCORED, { day: '2026-11-06', fetch, cache });
  assert.strictEqual(calls, 3, 'product page, store, ad');
  assert.ok(a.sheet.links.filter((l) => l.label !== 'Board card').every((l) => l.ok === true));
  assert.ok(!a.missing.includes('a link check') || a.sheet.links.some((l) => l.ok == null));
  const b = await productSheet(SCORED, { day: '2026-11-06', fetch, cache });
  assert.strictEqual(calls, 3, 'the second run takes them from the cache');
  assert.deepStrictEqual(b.sheet.links, a.sheet.links);
  const ctl = new AbortController();
  ctl.abort();
  const c = await productSheet(SCORED, { day: '2026-11-06', fetch, signal: ctl.signal });
  assert.strictEqual(calls, 3, 'aborted: no checks');
  assert.ok(c.sheet && c.one_line);
});

test('productSheet never throws: an empty or odd pick still gets a sheet that says what is missing', async () => {
  for (const p of [null, {}, { name: 'Only a name' }, { id: 'x', price: { amount: 'abc', currency: 'XYZ' }, links: {} }]) {
    const out = await productSheet(p, { day: '2026-11-06' });
    assert.ok(out.sheet && typeof out.one_line === 'string');
    assert.ok(out.missing.includes('a selling price'));
    assert.strictEqual(out.one_line, 'No price yet. Blocker: none');
  }
  const loss = await productSheet({ id: 'l', name: 'Tiny thing', price: { amount: 5, currency: 'EUR' }, src: 'eu', links: {} }, { day: '2026-11-06' });
  assert.match(oneLineOf(loss.sheet), /^Loses €\d+ an order in NZ/);
  assert.deepStrictEqual(missingOf(loss.sheet).slice(0, 1), ['a supplier price (estimated from the selling price)']);
});

test('launchStepsOf: the sheet fills the 🚀 launch card (every field valid for launch.mjs), its margin close to the sheet\'s, no ticks', () => {
  const sheet = sheetOf(Object.assign({}, FULL, { supplier: Object.assign({}, FULL.supplier, { status: 'fact' }) }), { day: DAY });
  const steps = launchStepsOf(sheet);
  assert.deepStrictEqual(Object.keys(steps), ['sourcing', 'margin', 'compliance', 'research', 'creatives', 'launch']);
  for (const [k, st] of Object.entries(steps)) {
    const c = cleanStep(k, st);
    assert.ok(c, k);
    assert.deepStrictEqual(c.v, st.v, `${k}: every value survives the card's own clean-up`);
    assert.strictEqual(c.done, false);
    assert.ok(!Object.values(c.v).includes(true), `${k}: no tick set for Connor`);
  }
  const card = marginOf(marginInputs(steps));
  const o = sheet.economics.markets[0].offers[0];
  assert.ok(Math.abs(card.contribution - o.contribution) <= o.refunds + 0.26 + 0.02, `card ${card.contribution} vs sheet ${o.contribution}`);
  assert.strictEqual(steps.launch.v.budget, 20);
  assert.match(steps.launch.v.kill, /€40\.00: Stop unless there is 1 sale/);
  assert.strictEqual(steps.creatives.v.hook1, 'Hook A');
  const sum = summaryOf({ facts: {}, steps });
  assert.ok(sum.margin && sum.margin.be_roas > 0);
  const blocked = launchStepsOf(sheetOf({ id: 'k', name: 'Teeth whitening kit', price: 49.95, cur: 'EUR' }, { day: DAY }));
  assert.deepStrictEqual(blocked.launch.v, {});
  assert.match(blocked.launch.note, /^No test: Blocked/);
  const guess = launchStepsOf(sheetOf({ id: 'g', name: 'Thing', price: 39.95, cur: 'EUR' }, { day: DAY }));
  assert.strictEqual(guess.margin.v.cogs, undefined, 'a guessed supplier price is not put on the card');
  assert.strictEqual(guess.sourcing.v.unit, undefined);
  assert.strictEqual(STEPS.length, 7);
});

test('GET /validate.js needs the PIN and serves the kit as a script; nothing else on that path', async () => {
  const ORIGIN = 'https://winner-hunter.example.workers.dev';
  const env = await seededEnv();
  const anon = await handle(new Request(ORIGIN + '/validate.js'), env, { now: NOW });
  assert.strictEqual(anon.status, 401);
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const call = (init = {}) => handle(new Request(ORIGIN + '/validate.js', { ...init, headers: { cookie, ...init.headers } }), env, { now: NOW });
  const js = await call();
  assert.strictEqual(js.status, 200);
  assert.strictEqual(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.strictEqual(await js.text(), VALIDATE_JS);
  assert.strictEqual((await call({ method: 'POST' })).status, 405);
});

test('the audience card of wh-audience: its problem, buyer line and first-test hooks land on the sheet and in the test plan', () => {
  const card = {
    problem: { line: 'Physical discomfort (14 of 99 statements)', themes: [] }, one_line: 'travellers, 61.6% women 35-64, CH; pain: physical discomfort',
    personas: [{ label: 'Travellers', gender: 'mostly women (61.6% of reach)', ages: '35-64 (71.3% of reach)', countries: { launch: ['CH'], eu_reach: [] }, situation: [{ label: 'Traveller' }] }],
    angles: [{ hook: 'Packing for the next trip? Add this.' }, { hook: 'The flat old pillow that digs in by the end of the day.', first_test: true }, { hook: 'Side sleeper? Watch this first.', first_test: true }, { hook: 'What the price gets.', first_test: true }],
    targeting: { control: { audience: 'Advantage+ audience on, no interests (let Meta find the buyers)' } },
  };
  const s = sheetOf({ id: 'p', name: '4D pillow', price: 89.95, cur: 'EUR', audience: card }, { day: DAY });
  assert.strictEqual(s.product.problem, 'Physical discomfort (14 of 99 statements)');
  assert.strictEqual(s.audience.persona.label, 'Travellers');
  assert.deepStrictEqual(s.audience.persona.countries, ['CH']);
  assert.deepStrictEqual(s.test_plan.angles, ['The flat old pillow that digs in by the end of the day.', 'Side sleeper? Watch this first.', 'What the price gets.']);
  const md = renderSheet(s);
  assert.match(md, /- Buyer: travellers, 61\.6% women 35-64, CH; pain: physical discomfort \(audience card\)/);
  assert.match(md, /targeting: see the audience card/);
  const thin = sheetOf({ id: 'q', name: 'X', price: 30, cur: 'EUR', audience: { problem: { line: 'not enough customer statements to say' }, angles: [] } }, { day: DAY });
  assert.strictEqual(thin.product.problem, '', 'no problem line when the card says it has too few statements');
});
