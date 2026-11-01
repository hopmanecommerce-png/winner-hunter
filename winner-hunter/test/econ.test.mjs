// Unit economics and the decision log (worker/src/econ.mjs, migrations/0020_unit_economics.sql): the numbers of one order
// (also as /econ.js, the code the board runs while you type), the verdict and its reasons, the settings, /api/econ, the
// margin on /api/ads and its two sorts, the decision log with Undo, and a database without the new tables, on an
// in-memory D1 (node:sqlite) with every migration applied.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import * as app from '../worker/src/app.mjs';
import { ECON_JS, cleanSettings, cleanInputs, mergeInputs, parsePrice, parseWeight, evaluate, econKey, NOT_READY } from '../worker/src/econ.mjs';
import { statements } from '../lib/d1.mjs';
import { memoryDb } from './helpers/sqlite-d1.mjs';
import { NOW } from './helpers/seed.mjs';
import { econEnv, TT_ID, TWIN } from './helpers/econ-seed.mjs';

const ORIGIN = 'https://winner-hunter.example.workers.dev';
const MIGRATION = fs.readFileSync(new URL('../worker/migrations/0020_unit_economics.sql', import.meta.url), 'utf8');
const iso = (ms) => new Date(ms).toISOString();
const DAY = iso(NOW).slice(0, 10); // 2026-10-17: the duty per parcel applies, the handling fee not yet
const NOV = '2026-11-01'; // both apply
const NOV_MS = Date.UTC(2026, 10, 1, 9);
const DEF = cleanSettings(null);
const plain = (r) => (r ? { ...r } : r);
const { handle, productKey } = app;
// The login cookie as the board makes it (tokenFor where the board has it, makeToken from the PIN before).
const token = (env, now) => (app.tokenFor ? app.tokenFor(env, now) : app.makeToken(env.BOARD_PIN, now));

async function session(env) {
  const cookie = `__Host-wh=${await token(env, NOW)}`;
  const call = (path, init = {}, now = NOW) => handle(new Request(ORIGIN + path, { ...init, headers: { cookie, ...init.headers } }), env, { now });
  return {
    get: async (path, now) => (await call(path, {}, now)).json(),
    post: (path, body, { now = NOW, headers = {} } = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, now),
    call,
  };
}
const post = async (s, path, body, opts) => {
  const res = await s.post(path, body, opts);
  return { status: res.status, ...(await res.json()) };
};
// The two ads on one product page as the board shows them: two products (it groups by advertiser + title) or one (it groups
// by product page). Their supplier price is one either way; their decisions follow the board.
const twinsOn = async (s) => (await s.get('/api/ads?view=all&limit=100')).ads.filter((x) => x.title.startsWith('Twin Pod')).map((x) => x.title).sort();

// ---------------------------------------------------------------------------
// The table, the numbers, the verdict
// ---------------------------------------------------------------------------

test('migration 0020: only CREATE … IF NOT EXISTS (safe on every deploy, nothing dropped or changed); the log takes approved or rejected', () => {
  const st = statements(MIGRATION);
  assert.deepStrictEqual(st.map((x) => x.split('(')[0].trim()), ['CREATE TABLE IF NOT EXISTS econ_inputs', 'CREATE TABLE IF NOT EXISTS econ_settings', 'CREATE TABLE IF NOT EXISTS decision_log', 'CREATE INDEX IF NOT EXISTS decision_log_product ON decision_log']);
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /\b(DROP|ALTER|DELETE|UPDATE|INSERT|REPLACE)\b/i);
  const fresh = new DatabaseSync(':memory:');
  for (let i = 0; i < 3; i++) for (const x of st) fresh.exec(x);
  const db = memoryDb(); // every migration, this one included
  db.prepare("INSERT INTO econ_inputs (product_key, cost_text) VALUES ('eu|a.test/products/x', '¥24')").run();
  db.prepare("INSERT INTO decision_log (product_key, decision, at) VALUES ('eu|1|x', 'approved', '2026-11-01')").run();
  for (const x of st) db.exec(x); // again, on a database with data
  assert.strictEqual(db.prepare('SELECT cost_text FROM econ_inputs').get().cost_text, '¥24', 'kept');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM decision_log').get().n, 1);
  assert.throws(() => db.prepare("INSERT INTO decision_log (product_key, decision, at) VALUES ('eu|1|x', 'maybe', 'x')").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("INSERT INTO decision_log (product_key, decision, level, at) VALUES ('eu|1|x', 'approved', 'blue', 'x')").run(), /CHECK constraint failed/);
  assert.throws(() => db.prepare("INSERT INTO decision_log (product_key, decision, at) VALUES (NULL, 'approved', 'x')").run(), /NOT NULL/);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'decision_log_product'").get());
});

test('parsePrice: a price as typed or pasted, its currency, a decimal comma, thousands, a range (the top, what small orders pay); not a price: null', () => {
  assert.deepStrictEqual(parsePrice('¥23.50', 'EUR'), { amount: 23.5, cur: 'CNY', low: null }, '¥ on a supplier price is the yuan (1688)');
  assert.deepStrictEqual(parsePrice('23,5 元'), { amount: 23.5, cur: 'CNY', low: null });
  assert.deepStrictEqual(parsePrice('12.50-15.00', 'CNY'), { amount: 15, cur: 'CNY', low: 12.5 });
  assert.deepStrictEqual(parsePrice('¥12.5 ~ ¥15'), { amount: 15, cur: 'CNY', low: 12.5 });
  assert.deepStrictEqual(parsePrice(8.5, 'USD'), { amount: 8.5, cur: 'USD', low: null });
  for (const [x, cur] of [['US $3.20', 'USD'], ['$3.20', 'USD'], ['3.20 USD', 'USD'], ['€2,80', 'EUR'], ['2.80 EUR', 'EUR'], ['2 euro', 'EUR'], ['£4', 'GBP'], ['HK$12', 'HKD'], ['A$5', 'AUD'], ['AU$5', 'AUD'],
    ['CA$5', 'CAD'], ['C$5', 'CAD'], ['NZ$5', 'NZD'], ['S$5', 'SGD'], ['US$5', 'USD'], ['JP¥500', 'JPY'], ['CHF 12', 'CHF'], ['RMB 9', 'CNY'], ['CN¥ 9', 'CNY']]) assert.strictEqual(parsePrice(x).cur, cur, x);
  assert.strictEqual(parsePrice('24', 'CNY').cur, 'CNY', 'without a currency: the one given');
  assert.deepStrictEqual(['1,250.00', '1.250,00', '1,250', '0,250', '8,50', '5.'].map((x) => parsePrice(x).amount), [1250, 1250, 1250, 0.25, 8.5, 5]);
  for (const bad of ['', '¥', 'abc', '-3', '−3', '3 for ¥10 each ¥4', '1,2,3', null, undefined, {}, NaN, -1]) assert.strictEqual(parsePrice(bad), null, String(bad));
});

test('parseWeight: grams; kilos with kg or a decimal point; 1 g to 50 kg', () => {
  assert.deepStrictEqual(['300', '300 g', '300g', '0,3 kg', '0.3kg', '0.3', '1.2 kilo', 300, '12 gram'].map(parseWeight), [300, 300, 300, 300, 300, 300, 1200, 300, 12]);
  for (const bad of ['', 'heavy', '0', '60000', '50.1 kg', -5, 0, 1e9, null, '1,5 kilo heavy']) assert.strictEqual(parseWeight(bad), null, String(bad));
});

test('cleanSettings: the defaults (the EU customs of 2026); every number within its bounds; decimal commas; the customs days; shipping tiers sorted; rates; red never under green', () => {
  assert.deepStrictEqual(DEF, cleanSettings({}));
  assert.deepStrictEqual([DEF.vat_pct, DEF.fee_pct, DEF.fee_fixed, DEF.refund_pct, DEF.agent_fee, DEF.cost_cur, DEF.cost_guess_pct, DEF.weight_guess_g, DEF.direct, DEF.duty_eur, DEF.duty_from, DEF.duty_max,
    DEF.handling_eur, DEF.handling_from, DEF.lines, DEF.target_roas, DEF.green_roas, DEF.red_roas, DEF.min_profit, DEF.young_days, DEF.big_store, DEF.focused_store],
  [21, 2.9, 0.3, 5, 1, 'CNY', 15, 300, true, 3, '2026-07-01', 150, 2, '2026-11-01', 1, 2.5, 2, 3, 10, 14, 500, 50], '€3 duty a parcel from 1 July 2026, €2 handling an item line from 1 November 2026');
  assert.deepStrictEqual(DEF.ship, [[100, 2.8], [250, 3.9], [500, 5.5], [1000, 8.9], [2000, 15.5]]);
  assert.ok(DEF.fx.USD > 0 && DEF.fx.CNY > 0 && DEF.fx.AUD > 0 && !('EUR' in DEF.fx));
  const s = cleanSettings({ vat_pct: '19', fee_pct: '1,9', refund_pct: 80, lines: '2.6', green_roas: 3.5, red_roas: 2, duty_from: '', handling_from: '2026-13-01', direct: 'no', cost_cur: 'USD', junk: 1,
    ship: [['500', '5'], [100, 2], ['x', 1], [100, 9], [60000, 1]], fx: { usd: 1, USD: '0,9', XYZ: -1, EUR: 2, CNY: 0.13 } });
  assert.deepStrictEqual([s.vat_pct, s.fee_pct, s.refund_pct, s.lines, s.green_roas, s.red_roas, s.duty_from, s.handling_from, s.direct, s.cost_cur], [19, 1.9, 5, 3, 3.5, 3.5, '', '2026-11-01', true, 'USD'],
    'out of bounds: the default; red from green at least; an empty day: never; not a day: the default');
  assert.ok(!('junk' in s));
  assert.deepStrictEqual(s.ship, [[100, 2], [500, 5]], 'sorted by weight, one price a weight, the rest dropped');
  assert.deepStrictEqual(s.fx, { USD: 0.9, CNY: 0.13 });
  assert.strictEqual(cleanSettings({ fx: {} }).cost_cur, 'EUR', 'no yuan rate: a supplier price without a currency is in euros');
  assert.deepStrictEqual(cleanSettings({ ship: [] }).ship, DEF.ship, 'no tier left: the defaults');
  assert.deepStrictEqual(cleanSettings(JSON.parse('{"__proto__": {"vat_pct": 1}, "fx": {"__proto__": 5, "constructor": 2}}')).vat_pct, 21);
  assert.deepStrictEqual(cleanSettings(JSON.parse('{"fx": {"__proto__": 5, "constructor": 2}}')).fx, {});
});

test('cleanInputs: what is saved for a product; what cannot be read is named and not saved', () => {
  assert.deepStrictEqual(cleanInputs({ cost: ' ¥23.50 ', weight: '0,3 kg', price: '44,95' }, DEF), { inputs: { cost_text: '¥23.50', weight: 300, price: 44.95 }, errors: {} });
  assert.deepStrictEqual(cleanInputs({ cost: '', weight: null, price: undefined }, DEF), { inputs: { cost_text: null, weight: null, price: null }, errors: {} });
  assert.deepStrictEqual(cleanInputs(null, DEF), { inputs: { cost_text: null, weight: null, price: null }, errors: {} });
  assert.deepStrictEqual(cleanInputs({ cost: 3.2, price: '$50' }, DEF).inputs, { cost_text: '3.2', weight: null, price: 43 }, "a bare number is in the settings' currency; your price in dollars counts in euros");
  const bad = cleanInputs({ cost: 'lots', weight: 'heavy', price: '-3' }, DEF);
  assert.deepStrictEqual(bad.inputs, { cost_text: null, weight: null, price: null });
  assert.deepStrictEqual(Object.keys(bad.errors), ['cost', 'weight', 'price']);
  assert.strictEqual(cleanInputs({ cost: '12 XYZ' }, DEF).errors.cost, 'Not a price: try ¥23.50, $3.20 or €2.80', 'no rate for that currency');
  assert.ok(cleanInputs({ cost: '¥' + '9'.repeat(100) }, DEF).errors.cost, 'too big');
  assert.strictEqual(cleanInputs({ cost: 'a\u0000b ¥5\nc' }, DEF).inputs.cost_text, 'a b ¥5 c', 'control characters: a space');
});

const BASIS = { src: 'eu', price: 49.95, cur: 'EUR', age: 20, products: 12, risks: [], checked: true };
const TYPED = { cost_text: '¥24', weight: 200, price: null };

test('evaluate: one order line by line: VAT, payment fees, refunds, the landed cost (supplier, agent, shipping, EU duty and handling), the margin, break-even ROAS and CPA, profit at the plan ROAS', () => {
  const e = evaluate(BASIS, TYPED, DEF, NOV);
  // 49.95 with 21% VAT: 8.67 VAT, 41.28 before VAT. Fees 2.9% + €0.30 = 1.75. Refunds 5% of 41.28 = 2.06. Landed: ¥24 × 0.12
  // = 2.88 + agent 1 + shipping 3.90 (200 g: the tier up to 250 g) + duty 3 + handling 2 = 12.78. Margin 41.28 − 1.75 − 2.06
  // − 12.78 = 24.69 (49.4%). Break-even ROAS 49.95 / 24.69 = 2.02. At ROAS 2.5 the ads cost 19.98: 4.71 profit. Green at
  // break-even 2 needs a margin of 24.98: 0.29 less cost, a supplier price of 2.59 (¥21.61), or a price of 51.07.
  assert.deepStrictEqual(e.m, {
    price: 49.95, price_from: 'theirs', theirs: { price: 49.95, cur: 'EUR', rate: 1, eur: 49.95 }, vat: 8.67, vat_pct: 21, net: 41.28, fees: 1.75, fee_pct: 2.9, fee_fixed: 0.3, refunds: 2.06, refund_pct: 5,
    cost: 2.88, cost_from: 'yours', guess_pct: 15, cost_amount: 24, cost_cur: 'CNY', cost_low: null, agent: 1, weight: 200, weight_from: 'yours', ship: 3.9, ship_tier: 'up to 250 g', ship_from: 'tier', duty: 3, handling: 2, lines: 1,
    landed: 12.78, contribution: 24.69, pct: 49.4, be_roas: 2.02, be_cpa: 24.69, target_roas: 2.5, profit: 4.71, max_cost: 2.59, max_cost_cny: 21.61, min_price: 51.07, min_price_free: false,
  });
  assert.deepStrictEqual(e.guess, { cost: false, weight: false });
  assert.strictEqual(e.level, 'amber');
  assert.deepStrictEqual(e.reasons, [
    { k: 'roas', level: 'amber', text: 'Break-even ROAS 2.02× (green up to 2×)' },
    { k: 'age', level: 'green', text: 'Its ads run 20 days' },
    { k: 'focused', level: 'green', text: 'Focused store: 12 products' },
    { k: 'norisk', level: 'green', text: 'No risk flags from Jev' },
  ]);
  // At 51.07 it is green: the price the numbers said.
  const atMin = evaluate(BASIS, { ...TYPED, price: 51.07 }, DEF, NOV);
  assert.deepStrictEqual([atMin.level, atMin.m.be_roas, atMin.m.price_from], ['green', 2, 'yours']);
  assert.deepStrictEqual(atMin.reasons.find((r) => r.k === 'yours'), { k: 'yours', level: 'info', text: 'Your price €51.07; their store asks €49.95' });
  // And at a supplier price of 2.59 too.
  assert.strictEqual(evaluate(BASIS, { ...TYPED, cost_text: '€2.59' }, DEF, NOV).m.be_roas, 2);
});

test('evaluate: the EU customs of 2026 by day: none before 1 July, the €3 duty a parcel from then, + €2 handling an item line from 1 November; over €150 before VAT red (no IOSS); from EU stock none', () => {
  const on = (day, s = DEF, b = BASIS) => evaluate(b, TYPED, s, day).m;
  assert.deepStrictEqual([on('2026-06-30').duty, on('2026-06-30').handling], [0, 0]);
  assert.deepStrictEqual([on('2026-07-01').duty, on('2026-07-01').handling], [3, 0]);
  assert.deepStrictEqual([on(DAY).duty, on(DAY).handling, on(DAY).contribution, on(DAY).be_roas], [3, 0, 26.69, 1.87], 'October: the duty only, green');
  assert.deepStrictEqual([on(NOV).duty, on(NOV).handling], [3, 2], 'about €5 an order from China');
  assert.strictEqual(on(NOV, cleanSettings({ lines: 3 })).handling, 6, 'per item line');
  const stock = evaluate(BASIS, TYPED, cleanSettings({ direct: false }), NOV);
  assert.deepStrictEqual([stock.m.duty, stock.m.handling], [0, 0]);
  assert.ok(stock.reasons.some((r) => r.k === 'stock' && r.level === 'info'));
  const pricey = evaluate({ ...BASIS, price: 200 }, TYPED, DEF, NOV);
  assert.deepStrictEqual([pricey.m.net, pricey.m.duty, pricey.m.handling, pricey.level], [165.29, 0, 2, 'red']);
  assert.deepStrictEqual(pricey.reasons[0], { k: 'over', level: 'red', text: '€165.29 before VAT is over €150.00: no IOSS and no flat duty, so the buyer pays VAT and import duty at the door' });
  assert.strictEqual(evaluate({ ...BASIS, price: 181.5 }, TYPED, DEF, NOV).m.duty, 3, '€150.00 before VAT: still the flat duty');
  assert.strictEqual(on(NOV, cleanSettings({ handling_from: '' })).handling, 0, 'an empty day: never');
});

test('evaluate: the verdict and its reasons: loss, red and amber break-even ROAS, a thin margin, heavy parcels, young ads, store size, risks (red or amber), guesses, other currencies, no price', () => {
  const lv = (e) => e.reasons.map((r) => `${r.level}:${r.k}`);
  // 9.95: 8.22 before VAT − 0.59 fees − 0.41 refunds − 12.78 landed = −5.56.
  const loss = evaluate({ ...BASIS, price: 9.95 }, TYPED, DEF, NOV);
  assert.deepStrictEqual([loss.level, loss.m.be_roas, loss.m.be_cpa, loss.reasons[0].text], ['red', null, 0, 'Loses €5.56 on every order before ads']);
  // 29.95: 24.75 before VAT − 1.17 fees − 1.24 refunds − 12.78 landed = 9.57: break-even 3.13, under €10 to pay for ads.
  const thin = evaluate({ ...BASIS, price: 29.95 }, TYPED, DEF, NOV);
  assert.deepStrictEqual(lv(thin), ['red:roas', 'amber:thin', 'green:age', 'green:focused', 'green:norisk']);
  assert.strictEqual(thin.reasons[0].text, 'Break-even ROAS 3.13×: ads must bring in 3.13× what they cost just to break even (red from 3×)');
  assert.strictEqual(thin.reasons[1].text, '€9.57 per order to pay for ads: a CPA above that loses money (amber under €10.00)');
  const heavy = evaluate(BASIS, { ...TYPED, weight: 3200 }, DEF, NOV);
  assert.deepStrictEqual([heavy.m.ship, heavy.m.ship_tier], [29.5, 'over 2000 g'], 'the last tier + 2 started kilos at €7');
  assert.ok(lv(heavy).includes('amber:heavy'));
  const risky = evaluate({ src: 'world', price: 49.95, cur: 'EUR', age: 9, products: 900, risks: [{ k: 'electric', text: 'Battery or electric' }, { k: 'brand', text: 'Brand or copy risk' }], checked: true }, TYPED, DEF, NOV);
  assert.deepStrictEqual(lv(risky), ['red:risk:brand', 'amber:roas', 'amber:young', 'amber:bigstore', 'amber:risk:electric'], 'red first, then amber, each in its own order');
  assert.strictEqual(risky.level, 'red');
  assert.deepStrictEqual(risky.reasons.slice(2, 4).map((r) => r.text), ['Its oldest ad runs 9 days: young (amber under 14)', 'Big store: 900 products, its ads may sell the store more than this product']);
  const guess = evaluate({ ...BASIS, checked: false }, null, DEF, NOV);
  assert.deepStrictEqual([guess.guess, guess.m.cost, guess.m.weight, guess.m.cost_from, guess.m.min_price_free], [{ cost: true, weight: true }, 7.49, 300, 'guess', true]);
  assert.deepStrictEqual(guess.reasons.filter((r) => r.level === 'info').map((r) => r.k), ['cost', 'weight', 'nojev']);
  assert.strictEqual(guess.reasons.find((r) => r.k === 'cost').text, 'Supplier price is a guess: 15% of the selling price (€7.49). Type the 1688 price.');
  const range = evaluate(BASIS, { ...TYPED, cost_text: '12.50-15.00' }, DEF, NOV);
  assert.deepStrictEqual([range.m.cost, range.m.cost_low], [1.8, 12.5]);
  assert.strictEqual(range.reasons.find((r) => r.k === 'range').text, 'Price range ¥12.50 to ¥15.00: the top is used, what small orders pay');
  const aud = evaluate({ ...BASIS, price: 79, cur: 'AUD' }, null, DEF, NOV);
  assert.deepStrictEqual([aud.m.price, aud.m.theirs], [45.03, { price: 79, cur: 'AUD', rate: 0.57, eur: 45.03 }]);
  assert.strictEqual(aud.reasons.find((r) => r.k === 'fx').text, 'Their 79.00 AUD is €45.03 at €0.57 per AUD');
  const none = evaluate({ ...BASIS, price: null }, null, DEF, NOV);
  assert.deepStrictEqual([none.m, none.level, none.reasons[0]], [null, 'amber', { k: 'price', level: 'amber', text: 'No price known: type what you would sell it for' }]);
  assert.strictEqual(evaluate({ ...BASIS, price: 12, cur: 'XYZ' }, null, DEF, NOV).reasons[0].text, 'No euro rate for XYZ in Settings: type your selling price');
  assert.strictEqual(evaluate({ ...BASIS, price: 12, cur: 'XYZ' }, { price: 45 }, DEF, NOV).m.price, 45, 'your price needs no rate');
  assert.strictEqual(evaluate(BASIS, { cost_text: '5 XYZ' }, DEF, NOV).guess.cost, true, 'a supplier price without a rate: the guess');
  assert.strictEqual(evaluate(null, null, null, NOV).level, 'amber', 'nothing known: no crash');
  const green = evaluate({ ...BASIS, price: 69.95 }, TYPED, DEF, NOV);
  assert.deepStrictEqual([green.level, lv(green)], ['green', ['green:roas', 'green:age', 'green:focused', 'green:norisk']]);
});

test('mergeInputs: what you typed wins, field by field; else the supplier you chose in Sourcing (its price, weight and shipping quote)', () => {
  assert.deepStrictEqual(mergeInputs(null, null), { cost_text: null, weight: null, price: null, ship: null, from: { cost: null, weight: null } });
  assert.deepStrictEqual(mergeInputs(null, { cost: 2.5, weight: 180, ship: 4.1 }), { cost_text: '€2.5', weight: 180, price: null, ship: 4.1, from: { cost: 'sourcing', weight: 'sourcing' } });
  assert.deepStrictEqual(mergeInputs({ cost_text: '¥24', weight: null, price: 44.95 }, { cost: 2.5, weight: 180, ship: null }),
    { cost_text: '¥24', weight: 180, price: 44.95, ship: null, from: { cost: 'yours', weight: 'sourcing' } });
  assert.deepStrictEqual(mergeInputs(null, { cost: 0, weight: 0, ship: -1 }), mergeInputs(null, null), 'no price, no weight, no quote');
  const e = evaluate(BASIS, mergeInputs(null, { cost: 2.88, weight: 200, ship: 4.1 }), DEF, NOV);
  assert.deepStrictEqual([e.m.cost, e.m.cost_from, e.m.weight, e.m.weight_from, e.m.ship, e.m.ship_from, e.m.ship_tier, e.guess], [2.88, 'sourcing', 200, 'sourcing', 4.1, 'quote', "the chosen supplier's quote", { cost: false, weight: false }]);
  assert.deepStrictEqual(e.reasons.filter((r) => r.level === 'info').map((r) => r.text), ['Supplier price from Sourcing: €2.88, the supplier you chose', 'Shipping as the chosen supplier quotes it: €4.10']);
  assert.strictEqual(e.m.landed, 12.98, '2.88 + agent 1 + the quote 4.10 + duty 3 + handling 2');
  assert.strictEqual(evaluate(BASIS, mergeInputs(null, { ship: 4.1 }), DEF, NOV).guess.weight, false, 'a quote needs no weight');
});

test('/econ.js is the kit on its own: run in a bare context it gives the same answers as the module', () => {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(ECON_JS, ctx);
  const K = ctx.window.ECON;
  assert.deepStrictEqual(Object.keys(K), ['DEFAULTS', 'cleanSettings', 'cleanInputs', 'mergeInputs', 'parsePrice', 'parseWeight', 'toEur', 'shipOf', 'customsOf', 'evaluate']);
  const same = (a, b, what) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), what);
  const raw = { vat_pct: '19', ship: [[250, 4], [1000, 9]], fx: { USD: 0.9, CNY: 0.13, AUD: 0.6 } };
  const s = cleanSettings(raw);
  same(K.cleanSettings(raw), s, 'settings');
  same(K.cleanInputs({ cost: '$3,20', weight: '0,4kg', price: '59,95' }, s), cleanInputs({ cost: '$3,20', weight: '0,4kg', price: '59,95' }, s), 'inputs');
  for (const [b, i, d] of [[BASIS, TYPED, NOV], [{ ...BASIS, price: 79, cur: 'AUD', risks: [{ k: 'skin', text: 'Cosmetics' }] }, null, DAY], [{ ...BASIS, price: 9.95 }, TYPED, '2026-06-01'], [{ price: null }, null, NOV]]) {
    same(K.evaluate(b, i, s, d), evaluate(b, i, s, d), JSON.stringify(b).slice(0, 40));
  }
  const sourced = { cost: 2.5, weight: 180, ship: 4.1 };
  same(K.mergeInputs(TYPED, sourced), mergeInputs(TYPED, sourced), 'what you typed, else Sourcing');
  same(K.evaluate(BASIS, K.mergeInputs(null, sourced), s, NOV), evaluate(BASIS, mergeInputs(null, sourced), s, NOV), 'a supplier chosen in Sourcing');
  assert.match(ECON_JS, /^'use strict';\nwindow\.ECON = \(function econKit\(\) \{/);
});

test('econKey: by product page in the EU (whether the board groups by advertiser + title or by page); outside the EU its own key', () => {
  assert.strictEqual(econKey({ world: {}, gk: 'world|a.test/products/x' }, productKey), 'world|a.test/products/x');
  assert.strictEqual(econKey({ gk: '501|posture', product_url: 'https://www.shop.test/products/PC?variant=1' }, productKey), 'eu|shop.test/products/pc');
  assert.strictEqual(econKey({ gk: '501|posture', product_url: 'https://shop.test/' }, productKey), 'eu|501|posture', 'no product page: its advertiser + title');
  assert.strictEqual(econKey({ gk: 'shop.test/products/pc', jk: '501|posture', product_url: '' }, productKey), 'eu|501|posture', 'grouped by page: jk is the advertiser + title');
  assert.strictEqual(econKey(null), '');
});

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

test('/api/econ, /api/decisions and /econ.js need the PIN; /econ.js is the kit as a script; other methods are refused', async () => {
  const env = await econEnv();
  const anon = (path, init) => handle(new Request(ORIGIN + path, init), env, { now: NOW });
  for (const p of ['/api/econ', '/api/econ?part=settings', '/api/decisions', '/econ.js']) assert.strictEqual((await anon(p)).status, 401, p);
  for (const p of ['/api/econ', '/api/decisions']) assert.strictEqual((await anon(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"settings":{"vat_pct":1}}' })).status, 401, p);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM econ_settings').get().n, 0);
  const s = await session(env);
  const js = await s.call('/econ.js');
  assert.strictEqual(js.status, 200);
  assert.strictEqual(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.strictEqual(js.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(js.headers.get('cache-control'), 'no-store');
  assert.strictEqual(await js.text(), ECON_JS);
  assert.strictEqual((await s.call('/econ.js', { method: 'POST' })).status, 405);
  for (const p of ['/api/econ', '/api/decisions']) assert.strictEqual((await s.call(p, { method: 'PUT' })).status, 405, p);
  assert.deepStrictEqual(await s.get('/api/econ?part=settings'), { settings: DEF, defaults: DEF, day: DAY, ready: true });
  assert.deepStrictEqual(await s.get('/api/decisions'), { rows: [], total: 0, offset: 0, counts: { approved: 0, rejected: 0 }, board: { approved: 0, rejected: 0 }, ready: true });
});

test('/api/ads: every card has its unit economics (its key, what they come from, the verdict); Browse sorts by margin and by break-even ROAS, also outside the EU', async () => {
  const env = await econEnv();
  const s = await session(env);
  const j = await s.get('/api/ads?view=all&limit=100');
  const a = j.ads.find((x) => x.title === 'Twin Pod A');
  assert.deepStrictEqual(a.econ.basis, { src: 'eu', price: 49.95, cur: 'EUR', age: 20, products: 12, risks: [], checked: false });
  assert.deepStrictEqual(a.econ, { key: TWIN, basis: a.econ.basis, inputs: null, sourced: null, ...evaluate(a.econ.basis, null, DEF, DAY) }, 'by its product page, worked out with the settings and the day');
  for (const x of j.ads.filter((t) => t.title.startsWith('Twin Pod'))) assert.strictEqual(x.econ.key, TWIN, 'one product page: one key, as one product or two');
  assert.strictEqual(j.ads.find((x) => x.title === 'Linen Summer Dress').econ.key, 'eu|500|linen summer dress', 'no product page: its advertiser + title');
  assert.ok(j.ads.every((x) => ['green', 'amber', 'red'].includes(x.econ.level) && x.econ.reasons.length && x.econ.guess.cost));
  const margins = (await s.get('/api/ads?view=all&sort=profit&limit=100')).ads.map((x) => x.econ.m.contribution);
  assert.deepStrictEqual(margins, [...margins].sort((x, y) => y - x), 'most margin per order first');
  const roas = (await s.get('/api/ads?view=all&sort=beroas&limit=100')).ads.map((x) => x.econ.m.be_roas ?? Infinity);
  assert.deepStrictEqual(roas, [...roas].sort((x, y) => x - y), 'lowest break-even ROAS first');
  assert.strictEqual(margins.length, j.ads.length);
  // A supplier price changes the order: the cheapest product to make leads.
  await post(s, '/api/econ', { key: 'eu|shop5.test/products/item-5', cost: '¥1', weight: 90 });
  assert.strictEqual((await s.get('/api/ads?view=all&sort=beroas')).ads[0].title, 'Cooling Dog Mat');
  // Outside the EU: A$79 in euros, Jev's battery an amber risk.
  const w = await s.get('/api/ads?scope=world&view=all&sort=profit');
  assert.deepStrictEqual(w.ads.map((x) => x.title), ['Pillow Pod']);
  assert.deepStrictEqual([w.ads[0].econ.key, w.ads[0].econ.m.price, w.ads[0].econ.basis.age], ['world|strong.test/products/pod', 45.03, 210]);
  assert.deepStrictEqual(w.ads[0].econ.reasons.filter((r) => r.k.startsWith('risk:')), [{ k: 'risk:electric', level: 'amber', text: 'Battery or electric' }]);
  const inbox = await s.get('/api/ads?view=inbox');
  assert.ok(inbox.ads.length && inbox.ads.every((x) => x.econ && x.econ.key.startsWith('eu|')), 'the Inbox has them too (the Decision card)');
});

test('/api/econ: your supplier price, weight and price for a product, saved by its product page: the numbers follow at once, on its cards too; empty clears them', async () => {
  const env = await econEnv();
  const s = await session(env);
  const r = await post(s, '/api/econ', { key: TWIN, cost: '¥24', weight: '200 g', price: '' }, { now: NOV_MS });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.ok, r.key, r.econ.key, r.econ.inputs], [true, TWIN, TWIN, TYPED]);
  assert.deepStrictEqual(r.econ.m, evaluate(BASIS, TYPED, DEF, NOV).m, 'the worked example: the same order');
  assert.deepStrictEqual(plain(env.db.prepare('SELECT * FROM econ_inputs').get()), { product_key: TWIN, cost: 2.88, cost_text: '¥24', weight_g: 200, price: null, updated_at: iso(NOV_MS) });
  const twins = (await s.get('/api/ads?view=all&limit=100')).ads.filter((x) => x.title.startsWith('Twin Pod'));
  assert.ok(twins.length >= 1);
  for (const x of twins) assert.deepStrictEqual([x.econ.inputs, x.econ.m.contribution, x.econ.guess.cost], [TYPED, 26.69, false], 'every card of the product page; in October no handling fee yet');
  const yours = await post(s, '/api/econ', { key: TWIN, cost: '¥24', weight: '200 g', price: '59,95' });
  assert.deepStrictEqual([yours.econ.inputs.price, yours.econ.m.price, yours.econ.m.price_from], [59.95, 59.95, 'yours']);
  const cleared = await post(s, '/api/econ', { key: TWIN, cost: '', weight: '', price: '' });
  assert.deepStrictEqual([cleared.status, cleared.econ.inputs, cleared.econ.guess], [200, null, { cost: true, weight: true }]);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM econ_inputs').get().n, 0, 'nothing typed: no row');
  const world = await post(s, '/api/econ', { key: 'world|strong.test/products/pod', cost: '$5', weight: '0.4' });
  assert.deepStrictEqual([world.status, world.econ.m.cost, world.econ.m.weight, world.econ.m.price], [200, 4.3, 400, 45.03]);
  const tt = await post(s, '/api/econ', { key: `tiktok|${TT_ID}`, cost: '¥30' });
  assert.deepStrictEqual([tt.status, tt.econ.m.price, tt.econ.m.cost, tt.econ.basis.risks], [200, 47.96, 3.6, [{ k: 'bulky', text: 'Big or heavy' }]], '$55.77 on TikTok, in euros');
});

test('/api/econ refuses a bad key, an unknown product, what cannot be read, other sites and bad JSON; every value goes in as a bound parameter', async () => {
  const env = await econEnv();
  const s = await session(env);
  for (const bad of ['', 'shop|1', 'eu|', 42, [TWIN], 'eu|' + 'x'.repeat(1000)]) assert.deepStrictEqual(await post(s, '/api/econ', { key: bad, cost: '¥5' }), { status: 400, error: 'Bad key' }, JSON.stringify(bad).slice(0, 30));
  for (const unknown of ['eu|nope.test/products/x', 'world|nope.test/products/x', 'tiktok|42', "tiktok|1' OR '1'='1"]) assert.deepStrictEqual(await post(s, '/api/econ', { key: unknown, cost: '¥5' }), { status: 404, error: 'Unknown product' }, unknown);
  const unread = await post(s, '/api/econ', { key: TWIN, cost: 'lots', weight: '1 ton' });
  assert.deepStrictEqual([unread.status, unread.error, Object.keys(unread.errors)], [400, 'Not a price: try ¥23.50, $3.20 or €2.80', ['cost', 'weight']]);
  assert.deepStrictEqual(await post(s, '/api/econ', { settings: [1] }), { status: 400, error: 'Bad settings' });
  assert.deepStrictEqual(await post(s, '/api/econ', { settings: 'cheap' }), { status: 400, error: 'Bad settings' });
  assert.deepStrictEqual(await post(s, '/api/econ', [1, 2]), { status: 400, error: 'Bad JSON' });
  assert.strictEqual((await s.post('/api/econ', { key: TWIN, cost: '¥5' }, { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.strictEqual((await s.post('/api/econ', { key: TWIN, cost: '¥5' }, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.strictEqual((await s.post('/api/econ', 'not json')).status, 400);
  assert.strictEqual((await s.post('/api/econ', { key: TWIN, cost: 'x'.repeat(9000) })).status, 413);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM econ_inputs').get().n, 0, 'nothing saved');
  const evil = "¥1'); DROP TABLE econ_inputs; --";
  const kept = await post(s, '/api/econ', { key: TWIN, cost: evil });
  assert.deepStrictEqual([kept.status, kept.econ.inputs.cost_text, kept.econ.m.cost], [200, evil, 0.12], 'kept as text, read as ¥1');
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM econ_inputs').get().n, 1);
  assert.ok(!env.DB.log.some((l) => /DROP|¥1|twin\.test/.test(l.sql)), 'what you typed never goes into the SQL');
});

test('/api/econ: the € table: every Inbox and ✓ product and the TikTok products you approved, each with its verdict; filters, counts, sorted by any column, a page at a time', async () => {
  const env = await econEnv();
  const s = await session(env);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9001', status: 'seen' })).status, 200);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9002', status: 'rejected' })).status, 200);
  assert.strictEqual((await s.post('/api/tiktok', { id: TT_ID, decision: 'approved' })).status, 200);
  const all = await s.get('/api/econ?limit=100');
  const inboxEU = (await s.get('/api/ads?view=inbox&limit=100')).total;
  assert.strictEqual(all.total, inboxEU + 1 + 2, 'the EU Inbox, the Inbox outside the EU, ✓ and the TikTok ✓');
  assert.deepStrictEqual([all.counts.green + all.counts.amber + all.counts.red, all.counts.all], [all.total, all.total]);
  assert.deepStrictEqual([all.sort, all.dir, all.day, all.ready, all.settings], ['level', 'asc', DAY, true, DEF]);
  const by = (t) => all.rows.find((x) => x.title === t);
  assert.ok(!by('Heated Neck Pillow'), 'rejected: off the table');
  assert.deepStrictEqual(Object.keys(by('Posture Corrector Pro')), ['key', 'src', 'status', 'id', 'title', 'img', 'ad', 'product', 'shop', 'at', 'econ']);
  assert.deepStrictEqual([by('Posture Corrector Pro').status, by('Posture Corrector Pro').at, by('Posture Corrector Pro').src], ['approved', iso(NOW), 'eu']);
  assert.deepStrictEqual([by('Pillow Pod').src, by('Pillow Pod').status, by('Pillow Pod').econ.level], ['world', 'inbox', 'amber']);
  const rhino = by('Rhino Straps');
  assert.deepStrictEqual([rhino.key, rhino.src, rhino.status, rhino.econ.m.price, rhino.econ.basis.checked], [`tiktok|${TT_ID}`, 'tiktok', 'approved', 47.96, true]);
  assert.ok(all.rows.every((x, i, a) => !i || ['green', 'amber', 'red'].indexOf(a[i - 1].econ.level) <= ['green', 'amber', 'red'].indexOf(x.econ.level)), 'green first by default');
  const titles = async (q) => (await s.get('/api/econ?limit=100&' + q)).rows.map((x) => x.title);
  assert.deepStrictEqual(await titles('src=world'), ['Pillow Pod']);
  assert.deepStrictEqual((await titles('status=approved&sort=title')), ['Posture Corrector Pro', 'Rhino Straps']);
  const twins = await twinsOn(s);
  assert.deepStrictEqual((await titles('q=twin&sort=title')), twins);
  const reds = await s.get('/api/econ?level=red&limit=100');
  assert.ok(reds.rows.length && reds.rows.every((x) => x.econ.level === 'red') && reds.total === all.counts.red && reds.counts.all === all.total, 'a level filter keeps the counts of all');
  assert.deepStrictEqual(await titles('real=1'), [], 'no supplier price typed yet');
  await post(s, '/api/econ', { key: TWIN, cost: '¥24' });
  assert.deepStrictEqual(await titles('real=1&sort=title'), twins, 'every card of the product page');
  const col = { profit: (x) => x.econ.m && x.econ.m.contribution, roas: (x) => x.econ.m && x.econ.m.be_roas, price: (x) => x.econ.m && x.econ.m.price, landed: (x) => x.econ.m && x.econ.m.landed,
    days: (x) => x.econ.basis.age, store: (x) => x.econ.basis.products, title: (x) => x.title.toLowerCase(), new: (x) => x.at || null };
  for (const [k, get] of Object.entries(col)) {
    for (const dir of ['asc', 'desc']) {
      const v = (await s.get(`/api/econ?limit=100&sort=${k}&dir=${dir}`)).rows.map(get);
      const known = v.filter((x) => x != null);
      assert.deepStrictEqual(v.slice(0, known.length), known, `${k} ${dir}: unknown last`);
      assert.ok(known.every((x, i) => !i || (dir === 'asc' ? (typeof x === 'string' ? known[i - 1].localeCompare(x) <= 0 : known[i - 1] <= x) : (typeof x === 'string' ? known[i - 1].localeCompare(x) >= 0 : known[i - 1] >= x))), `${k} ${dir}`);
    }
  }
  const p1 = await s.get('/api/econ?limit=5&sort=title');
  const p2 = await s.get('/api/econ?limit=5&offset=5&sort=title');
  assert.deepStrictEqual([p1.rows.length, p2.rows.length, p2.offset, p1.total], [5, 5, 5, all.total]);
  assert.ok(!p1.rows.some((x) => p2.rows.some((y) => y.key === x.key && y.title === x.title)), 'two pages, no row twice');
  const odd = await s.get('/api/econ?sort=constructor&dir=up&level=blue&src=__proto__&limit=-5&offset=-3');
  assert.deepStrictEqual([odd.sort, odd.dir, odd.total, odd.offset, odd.rows.length], ['level', 'asc', all.total, 0, 1], 'anything else: the default');
});

test('/api/econ: the settings are saved cleaned and every number follows them; null puts the defaults back', async () => {
  const env = await econEnv();
  const s = await session(env);
  const r = await post(s, '/api/econ', { settings: { vat_pct: '19', green_roas: '2,5', fx: { USD: 0.9 }, junk: '<b>' } }, { now: NOW + 1000 });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual([r.settings.vat_pct, r.settings.green_roas, r.settings.fx, r.settings.cost_cur, 'junk' in r.settings], [19, 2.5, { USD: 0.9 }, 'EUR', false], 'no yuan rate left: supplier prices in euros');
  assert.deepStrictEqual(plain(env.db.prepare('SELECT key, value, updated_at FROM econ_settings').get()), { key: 'settings', value: JSON.stringify(r.settings), updated_at: iso(NOW + 1000) });
  assert.deepStrictEqual((await s.get('/api/econ?part=settings')).settings, r.settings);
  const a = (await s.get('/api/ads?view=all&limit=100')).ads.find((x) => x.title === 'Twin Pod A');
  assert.deepStrictEqual([a.econ.m.vat_pct, a.econ.m.vat], [19, 7.98], '49.95 with 19% VAT');
  const back = await post(s, '/api/econ', { settings: null });
  assert.deepStrictEqual([back.status, back.settings], [200, DEF]);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM econ_settings').get().n, 0);
  assert.strictEqual((await s.get('/api/ads?view=all&limit=100')).ads.find((x) => x.title === 'Twin Pod A').econ.m.vat_pct, 21);
});

test('a supplier chosen in 🔎 Sourcing counts on the cards, the € table and in the log, unless you typed your own; without its tables as before', async () => {
  const env = await econEnv();
  env.db.prepare('INSERT INTO product_sourcing (product_key, supplier_cost, weight_g, ship_cost, updated_at) VALUES (?, 2.5, 180, 4.1, ?)').run(TWIN, iso(NOW));
  const s = await session(env);
  const card = async (view = 'all') => (await s.get(`/api/ads?view=${view}&limit=100`)).ads.find((x) => x.title === 'Twin Pod A').econ;
  let e = await card();
  assert.deepStrictEqual([e.inputs, e.sourced, e.m.cost, e.m.cost_from, e.m.weight, e.m.ship, e.m.ship_from, e.guess.cost], [null, { cost: 2.5, weight: 180, ship: 4.1 }, 2.5, 'sourcing', 180, 4.1, 'quote', false]);
  assert.ok((await s.get('/api/econ?real=1&q=twin&limit=100')).rows.length >= 1, 'a chosen supplier is a real price');
  const typed = await post(s, '/api/econ', { key: TWIN, cost: '¥24' });
  assert.deepStrictEqual([typed.econ.m.cost, typed.econ.m.cost_from, typed.econ.m.weight_from, typed.econ.m.ship], [2.88, 'yours', 'sourcing', 4.1], 'what you typed wins; the rest from Sourcing');
  e = await card();
  assert.deepStrictEqual([e.m.cost, e.m.cost_from], [2.88, 'yours']);
  await s.post('/api/hide', { ad_id: '8001', status: 'seen' });
  const f = JSON.parse(env.db.prepare('SELECT facts FROM decision_log').get().facts);
  assert.deepStrictEqual([f.econ.sourced, f.econ.m.ship_from, f.econ.m.cost_from], [{ cost: 2.5, weight: 180, ship: 4.1 }, 'quote', 'yours'], 'the log keeps where each number came from');
  env.db.exec('DROP TABLE product_suppliers; DROP TABLE product_sourcing;');
  e = await card('made'); // approved: on ✓ now
  assert.deepStrictEqual([e.sourced, e.m.ship_from, e.m.cost_from], [null, 'tier', 'yours'], 'no Sourcing tables (an older database): as before');
  await s.post('/api/hide', { ad_id: '8001', status: 'none' });
  assert.strictEqual((await s.post('/api/hide', { ad_id: '8001', status: 'seen' })).status, 200);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM decision_log').get().n, 2, 'still logged');
});

// ---------------------------------------------------------------------------
// The decision log
// ---------------------------------------------------------------------------

const logRows = (env) => env.db.prepare('SELECT * FROM decision_log ORDER BY id').all().map(plain);

test('decision log: approve and reject on the board are logged with the facts and numbers of that moment; Undo and Remove from ✓ take it back; a new decision replaces the old; the star is no decision', async () => {
  const env = await econEnv();
  const s = await session(env);
  const keyA = (await twinsOn(s)).length === 2 ? 'eu|801|twin pod a' : TWIN; // the product as /api/hide decides on it
  await post(s, '/api/econ', { key: TWIN, cost: '¥24', weight: 200 });
  assert.strictEqual((await s.post('/api/hide', { ad_id: '8001', status: 'seen' }, { now: NOW + 1000 })).status, 200);
  const [a] = logRows(env);
  assert.deepStrictEqual([a.id, a.product_key, a.ad_id, a.source, a.decision, a.title, a.level, a.profit, a.be_roas, a.at, a.undone_at, a.undo_via],
    [1, keyA, '8001', 'eu', 'approved', 'Twin Pod A', 'green', 26.69, 1.87, iso(NOW + 1000), null, null], 'green in October');
  const f = JSON.parse(a.facts);
  assert.deepStrictEqual([f.title, f.price, f.cur, f.age, f.products, f.rpd, f.ad], ['Twin Pod A', 49.95, 'EUR', 20, 12, 20000, 'https://www.facebook.com/ads/library/?id=9001']);
  assert.deepStrictEqual([f.econ.key, f.econ.inputs, f.econ.level, f.econ.guess, f.econ.m.contribution, f.econ.m.landed], [TWIN, TYPED, 'green', { cost: false, weight: false }, 26.69, 10.78]);
  assert.deepStrictEqual(f.econ.reasons.map((r) => r.k), ['roas', 'age', 'focused', 'nojev']);
  // Undo on the board: taken back.
  await s.post('/api/hide', { ad_id: '8001', status: 'none' }, { now: NOW + 3000 });
  assert.deepStrictEqual(logRows(env).map((r) => [r.id, r.undone_at, r.undo_via]), [[1, iso(NOW + 3000), 'board']]);
  // Decided again, then otherwise: the newer replaces the older.
  await s.post('/api/hide', { ad_id: '8001', status: 'rejected' }, { now: NOW + 4000 });
  await s.post('/api/hide', { ad_id: '8001', status: 'seen' }, { now: NOW + 5000 });
  assert.deepStrictEqual(logRows(env).slice(1).map((r) => [r.id, r.decision, r.undone_at, r.undo_via]), [[2, 'rejected', iso(NOW + 5000), 'replaced'], [3, 'approved', null, null]]);
  // Remove from ✓ (the same status none as Undo): taken back.
  await s.post('/api/hide', { ad_id: '8001', status: 'none' }, { now: NOW + 6000 });
  assert.deepStrictEqual(logRows(env)[2].undo_via, 'board');
  // The star, a refused decision and an unknown ad: nothing logged.
  const n = logRows(env).length;
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'starred' })).status, 200);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'maybe' })).status, 400);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '123456', status: 'seen' })).status, 404);
  assert.strictEqual(logRows(env).length, n);
  // Outside the EU and on the TikTok tab: logged the same way.
  await s.post('/api/hide', { ad_id: '1001', status: 'seen' }, { now: NOW + 7000 });
  await s.post('/api/tiktok', { id: TT_ID, decision: 'approved' }, { now: NOW + 8000 });
  const [w, t] = logRows(env).slice(-2);
  assert.deepStrictEqual([w.product_key, w.source, w.title, w.level, JSON.parse(w.facts).proof.of], ['world|strong.test/products/pod', 'world', 'Pillow Pod', 'amber', 6]);
  assert.deepStrictEqual([t.product_key, t.ad_id, t.source, t.title, t.level, JSON.parse(t.facts).sold], [`tiktok|${TT_ID}`, TT_ID, 'tiktok', 'Rhino Straps', 'amber', 152000]);
  await s.post('/api/tiktok', { id: TT_ID, decision: '' }, { now: NOW + 9000 });
  assert.deepStrictEqual([logRows(env).at(-1).undone_at, logRows(env).at(-1).undo_via], [iso(NOW + 9000), 'board']);
  // The log as the board reads it: the newest first, only what stands unless asked.
  const standing = await s.get('/api/decisions');
  assert.deepStrictEqual(standing.rows.map((r) => [r.key, r.decision, r.latest]), [['world|strong.test/products/pod', 'approved', true]]);
  assert.deepStrictEqual([standing.total, standing.counts], [1, { approved: 1, rejected: 0 }]);
  assert.deepStrictEqual(standing.board, { approved: 1, rejected: 0 }, 'every decision on the board now (Pillow Pod), also from before the log: the approval rate');
  const every = await s.get('/api/decisions?undone=1&limit=3');
  assert.deepStrictEqual([every.total, every.rows.length, every.rows[0].key, every.rows[0].undo_via], [5, 3, `tiktok|${TT_ID}`, 'board'], 'five decisions: taking one back adds no row');
  assert.deepStrictEqual((await s.get('/api/decisions?undone=1&d=rejected')).rows.map((r) => r.id), [2]);
  assert.deepStrictEqual(Object.keys(every.rows[0]), ['id', 'key', 'ad_id', 'src', 'decision', 'title', 'level', 'profit', 'be_roas', 'facts', 'at', 'undone_at', 'undo_via', 'latest']);
});

test('two ads on one product page: one supplier price; their decisions follow the board (two products by advertiser + title: each its own log line; one product by page: one)', async () => {
  const env = await econEnv();
  const s = await session(env);
  const twins = await twinsOn(s);
  await s.post('/api/hide', { ad_id: '8001', status: 'seen' }, { now: NOW + 1000 });
  await s.post('/api/hide', { ad_id: '8002', status: 'rejected' }, { now: NOW + 2000 });
  const rows = () => logRows(env).map((r) => [r.product_key, r.decision, r.undone_at, r.undo_via]);
  if (twins.length === 2) {
    // Two products on the board: neither decision touches the other, also not when one is taken back.
    assert.deepStrictEqual(rows(), [['eu|801|twin pod a', 'approved', null, null], ['eu|802|twin pod b', 'rejected', null, null]]);
    await s.post('/api/hide', { ad_id: '8001', status: 'none' }, { now: NOW + 3000 });
    assert.deepStrictEqual(rows(), [['eu|801|twin pod a', 'approved', iso(NOW + 3000), 'board'], ['eu|802|twin pod b', 'rejected', null, null]]);
  } else {
    // One product on the board: the reject replaced the approve.
    assert.deepStrictEqual(twins, ['Twin Pod A']);
    assert.deepStrictEqual(rows(), [[TWIN, 'approved', iso(NOW + 2000), 'replaced'], [TWIN, 'rejected', null, null]]);
  }
  assert.deepStrictEqual(logRows(env).map((r) => JSON.parse(r.facts).econ.key), [TWIN, TWIN], 'one supplier price for the page');
});

test('decision log Undo: the newest decision of a product, once, while the board still has it; the product is undecided again, back in the Inbox; TikTok too', async () => {
  const env = await econEnv();
  const s = await session(env);
  const inbox = async () => (await s.get('/api/ads?view=inbox&limit=100')).total;
  const before = await inbox();
  await s.post('/api/hide', { ad_id: '8001', status: 'seen' });
  assert.strictEqual(await inbox(), before - 1);
  const [row] = (await s.get('/api/decisions')).rows;
  const u = await post(s, '/api/decisions', { undo: row.id }, { now: NOW + 5000 });
  assert.strictEqual(u.status, 200);
  assert.deepStrictEqual([u.ok, u.undone.id, u.undone.undone_at, u.undone.undo_via, u.undone.latest], [true, row.id, iso(NOW + 5000), 'log', true]);
  assert.strictEqual(env.db.prepare("SELECT COUNT(*) AS n FROM hidden WHERE ad_id IN ('8001', '8002')").get().n, 0, 'undecided again');
  assert.strictEqual(env.db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE ad_id = '8001' AND action = 'seen'").get().n, 0, 'as the board\'s own Undo: its feedback row goes too');
  assert.strictEqual(await inbox(), before, 'back in the Inbox');
  assert.deepStrictEqual(await post(s, '/api/decisions', { undo: row.id }), { status: 409, error: 'Already taken back' });
  assert.deepStrictEqual([(await s.get('/api/decisions')).total, (await s.get('/api/decisions?undone=1')).total], [0, 1]);
  // Replaced by a newer decision: only the newest can be taken back.
  await s.post('/api/hide', { ad_id: '8001', status: 'seen' });
  await s.post('/api/hide', { ad_id: '8001', status: 'rejected' });
  const [newest, older] = (await s.get('/api/decisions?undone=1')).rows;
  assert.deepStrictEqual([newest.latest, older.latest, older.undo_via], [true, false, 'replaced']);
  assert.deepStrictEqual(await post(s, '/api/decisions', { undo: older.id }), { status: 409, error: 'Already taken back' });
  // The board changed since without the log (an older board, by hand): nothing is taken back.
  env.db.prepare("UPDATE hidden SET status = 'seen' WHERE ad_id = '8001'").run();
  const changed = await post(s, '/api/decisions', { undo: newest.id });
  assert.deepStrictEqual([changed.status, changed.error], [409, 'This product was decided again since (on the board): nothing to take back here']);
  assert.strictEqual(env.db.prepare("SELECT status FROM hidden WHERE ad_id = '8001'").get().status, 'seen', 'the newer decision stays');
  // TikTok: back to undecided on its tab.
  await s.post('/api/tiktok', { id: TT_ID, decision: 'approved' });
  const tt = (await s.get('/api/decisions')).rows.find((r) => r.src === 'tiktok');
  assert.strictEqual((await post(s, '/api/decisions', { undo: tt.id })).status, 200);
  assert.strictEqual(env.db.prepare('SELECT decision FROM tiktok_products WHERE id = ?').get(TT_ID).decision, null);
  for (const bad of ['x', 0, -1, 1.5, null, '1; DROP TABLE decision_log']) assert.deepStrictEqual(await post(s, '/api/decisions', { undo: bad }), { status: 400, error: 'Bad id' }, String(bad));
  assert.deepStrictEqual(await post(s, '/api/decisions', { undo: 999 }), { status: 404, error: 'No such decision' });
  assert.deepStrictEqual(await post(s, '/api/decisions', {}), { status: 400, error: 'Bad id' });
  assert.strictEqual((await s.post('/api/decisions', { undo: 1 }, { headers: { origin: 'https://evil.test' } })).status, 403);
});

test('a database without the new tables (a test link before the merge): the board, its decisions and the TikTok tab work as before; the € view says so', async () => {
  const env = await econEnv();
  env.db.exec('DROP TABLE econ_inputs; DROP TABLE econ_settings; DROP TABLE decision_log;');
  const s = await session(env);
  const j = await s.get('/api/ads?view=all&sort=profit&limit=100');
  assert.ok(j.ads.length > 20 && j.ads.every((a) => a.econ && a.econ.inputs === null), 'the default settings, no inputs');
  assert.strictEqual((await s.post('/api/hide', { ad_id: '8001', status: 'seen' })).status, 200);
  assert.strictEqual(env.db.prepare("SELECT status FROM hidden WHERE ad_id = '8001'").get().status, 'seen');
  assert.strictEqual((await s.post('/api/hide', { ad_id: '8001', status: 'none' })).status, 200);
  assert.strictEqual((await s.post('/api/tiktok', { id: TT_ID, decision: 'approved' })).status, 200);
  assert.deepStrictEqual(await s.get('/api/decisions'), { rows: [], total: 0, offset: 0, counts: { approved: 0, rejected: 0 }, board: { approved: 1, rejected: 0 }, ready: false }, 'the board\'s own decisions still count (the TikTok ✓)');
  assert.strictEqual((await s.get('/api/econ?part=settings')).ready, false);
  const t = await s.get('/api/econ?limit=3');
  assert.deepStrictEqual([t.ready, t.rows.length], [false, 3]);
  assert.deepStrictEqual(await post(s, '/api/econ', { key: TWIN, cost: '¥24' }), { status: 503, error: NOT_READY });
  assert.deepStrictEqual(await post(s, '/api/econ', { settings: { vat_pct: 19 } }), { status: 503, error: NOT_READY });
  assert.deepStrictEqual(await post(s, '/api/econ', { settings: null }), { status: 503, error: NOT_READY });
  assert.deepStrictEqual(await post(s, '/api/decisions', { undo: 1 }), { status: 503, error: NOT_READY });
});

test('a D1 error on the unit economics never keeps the board from opening: the cards come with the default settings', async () => {
  const env = await econEnv();
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => (/FROM econ_inputs$/.test(sql) ? { all: async () => { throw new Error('D1 hiccup (econ)'); }, bind: () => ({}) } : prepare(sql));
  const s = await session(env);
  const res = await s.call('/api/ads?view=all&sort=beroas');
  assert.strictEqual(res.status, 200);
  const j = await res.json();
  assert.ok(j.ads.length > 20 && j.ads.every((a) => a.econ && a.econ.inputs === null));
  assert.strictEqual((await s.call('/api/econ')).status, 500, 'the € view says it could not read');
});
