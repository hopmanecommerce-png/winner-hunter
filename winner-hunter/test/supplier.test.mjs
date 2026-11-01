// Suppliers (worker/src/supplier.mjs, migrations/0060_sourcing.sql): the scoring (weights, automatic scores, gates,
// ties), the decision record, the clean-up of what is typed, /supplier.js (the code the board runs) and /api/supplier,
// on an in-memory D1 (node:sqlite) with every migration applied: the showerhead's scorecard is seeded there.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { marginOf } from '../worker/src/launch.mjs';
import { CRITERIA, GATES, CHECKS, summaryOf, decide, undecide, recheck, cleanSetup, setupOf, cleanSupplier, cleanChecks, parseTests, parseQuestions, landedOf, messageOf, SUPPLIER_JS, KIT, ownKey } from '../worker/src/supplier.mjs';
import { statements } from '../lib/d1.mjs';
import { memoryDb } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

const ORIGIN = 'https://winner-hunter.example.workers.dev';
const MIGRATION = fs.readFileSync(new URL('../worker/migrations/0060_sourcing.sql', import.meta.url), 'utf8');
const SEED = 'own|muravai-filtered-showerhead';
const iso = (ms) => new Date(ms).toISOString();
const DAY = 864e5;

// Everything known and good: every gate yes, every test passed, every criterion that has no Auto scored by hand.
const YES = { samples: 'yes', certs: 'yes', identity: 'yes', defects: 'yes' };
const TESTS = parseTests('! Leak test\n! Filter teardown\nFlow rate\nDrop test');
const PASS = { 'leak-test': 'pass', 'filter-teardown': 'pass', 'flow-rate': 'pass', 'drop-test': 'pass' };
const HAND = { reliability: 4, compliance: 4, returns: 3, scale: 3 };
const sup = (o = {}) => ({ name: 'Factory', unit: 2, ship_eu: 6, from: 'cn', days_eu: 9, gates: { ...YES }, tests: { ...PASS }, scores: { ...HAND }, ...o });
const card = (suppliers, setup = {}, extra = {}) => ({ setup: { tests: TESTS, ...setup }, suppliers, ...extra });
const rowsOf = (p, now) => summaryOf(p, now).rows;
const bySlot = (p, slot) => rowsOf(p).find((r) => r.slot === slot);

async function session(env) {
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const call = (path, init = {}, now = NOW) => handle(new Request(ORIGIN + path, { ...init, headers: { cookie, ...init.headers } }), env, { now });
  return {
    get: async (path) => (await call(path)).json(),
    post: (path, body, { now = NOW, headers = {} } = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, now),
    call,
  };
}
const api = async (s, body, opts) => {
  const res = await s.post('/api/supplier', body, opts);
  return { status: res.status, ...(await res.json()) };
};

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test('migration 0060: additive and safe to run again and again; the showerhead is seeded once (not again after a remove), with its tests and questions and no suppliers', () => {
  const st = statements(MIGRATION);
  assert.deepStrictEqual(st.map((x) => /^(CREATE TABLE IF NOT EXISTS|INSERT OR IGNORE INTO) \w+/.exec(x)[0]), ['CREATE TABLE IF NOT EXISTS sourcing', 'INSERT OR IGNORE INTO sourcing', 'INSERT OR IGNORE INTO state'], 'a new table and two guarded inserts');
  const sqlOnly = st.join('\n').replace(/'(?:[^']|'')*'/g, "''"); // the SQL without its text values
  assert.ok(!/\b(ALTER|DROP|DELETE|UPDATE|REPLACE)\b/i.test(sqlOnly), 'nothing that changes or removes what is there');
  const db = memoryDb(); // every migration, this one included
  const seeded = () => db.prepare('SELECT * FROM sourcing').all().map((r) => ({ ...r }));
  assert.deepStrictEqual(seeded().map((r) => r.product_key), [SEED]);
  for (let i = 0; i < 3; i++) for (const x of st) db.exec(x); // the workflows run every migration on every run
  assert.strictEqual(seeded().length, 1, 'still one');
  // Your changes stay: the seed never writes over a row
  db.prepare("UPDATE sourcing SET suppliers = '{\"s1\":{\"name\":\"Mine\"}}' WHERE product_key = ?").run(SEED);
  for (const x of st) db.exec(x);
  assert.deepStrictEqual(JSON.parse(seeded()[0].suppliers), { s1: { name: 'Mine' } });
  // Removed on the board: it does not come back
  db.prepare('DELETE FROM sourcing').run();
  for (let i = 0; i < 2; i++) for (const x of st) db.exec(x);
  assert.strictEqual(seeded().length, 0);
  assert.strictEqual(db.prepare("SELECT value FROM state WHERE key = 'seed_sourcing_showerhead'").get().value, 'migration 0060');
  // A fresh database: the table and the seed, twice is the same as once
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(fs.readFileSync(new URL('../worker/migrations/0001_init.sql', import.meta.url), 'utf8'));
  for (let i = 0; i < 2; i++) for (const x of st) fresh.exec(x);
  const [row] = fresh.prepare('SELECT * FROM sourcing').all();
  assert.strictEqual(fresh.prepare('SELECT COUNT(*) AS n FROM sourcing').get().n, 1);
  // The seed: the checklist and the questions, no invented suppliers, no decision
  assert.deepStrictEqual([row.suppliers, row.checks, row.choice], ['{}', '{}', '{}']);
  const setup = JSON.parse(row.setup);
  assert.deepStrictEqual(cleanSetup(setup), setup, 'the seed is clean as the board saves it');
  assert.ok(setup.tests.length >= 6 && setup.tests.filter((t) => t.must).length >= 2, 'its sample tests, must-pass ones among them');
  assert.ok(setup.tests.some((t) => /leak/i.test(t.label)) && setup.tests.some((t) => /teardown/i.test(t.label)) && setup.tests.some((t) => /flow/i.test(t.label)));
  assert.ok(setup.questions.length >= 8 && setup.questions.every((q) => q.en && q.zh), 'its questions, in English and Chinese');
  assert.ok(setup.certs.length > 50, 'the certificates it needs');
  const facts = JSON.parse(row.facts);
  assert.deepStrictEqual([facts.source, facts.link, facts.price, facts.cur], ['own', 'https://muravai.com/en-in/products/the-filtered-showerhead', 59.99, 'USD']);
  assert.match(facts.img, /^https:\/\//);
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test('weights: quality and delivery first (25, 25, 15, 15, 10, 5, 5 = 100); yours change the score; all 0 or nonsense falls back to the defaults', () => {
  assert.deepStrictEqual(CRITERIA.map((c) => [c.k, c.w]), [['quality', 25], ['delivery', 25], ['reliability', 15], ['cost', 15], ['compliance', 10], ['returns', 5], ['scale', 5]]);
  assert.strictEqual(CRITERIA.reduce((a, c) => a + c.w, 0), 100);
  assert.deepStrictEqual(setupOf({}).weights, Object.fromEntries(CRITERIA.map((c) => [c.k, c.w])));
  // quality 5 (every test), delivery 2 (9 days), reliability 4, cost 5 (the only one: the cheapest), compliance 4, returns 3, scale 3
  const p = card({ s1: sup() });
  assert.deepStrictEqual(Object.fromEntries(Object.entries(bySlot(p, 1).parts).map(([k, v]) => [k, v.v])), { quality: 5, delivery: 2, reliability: 4, cost: 5, compliance: 4, returns: 3, scale: 3 });
  // (25×5 + 25×2 + 15×4 + 15×5 + 10×4 + 5×3 + 5×3) / 5 = 76
  assert.strictEqual(bySlot(p, 1).score, 76);
  // Only quality counts: 100. Only delivery counts: 2/5 = 40.
  const only = (k) => Object.fromEntries(CRITERIA.map((c) => [c.k, c.k === k ? 50 : 0]));
  assert.strictEqual(bySlot(card({ s1: sup() }, { weights: only('quality') }), 1).score, 100);
  assert.strictEqual(bySlot(card({ s1: sup() }, { weights: only('delivery') }), 1).score, 40);
  // Delivery counts double: (25×5 + 50×2 + 15×4 + 15×5 + 10×4 + 5×3 + 5×3) / 5 = 86 points of 125 = 68.8
  assert.strictEqual(bySlot(card({ s1: sup() }, { weights: { delivery: 50 } }), 1).score, 68.8);
  assert.deepStrictEqual(setupOf({ weights: Object.fromEntries(CRITERIA.map((c) => [c.k, 0])) }).weights, setupOf({}).weights, 'all 0: the defaults');
  assert.deepStrictEqual(cleanSetup({ weights: { quality: '30,5', delivery: -1, cost: 101, scale: 'x', nope: 5 } }).weights, { quality: 30.5 }, 'a weight is 0 to 100');
  assert.strictEqual(setupOf({ weights: { quality: 30.5 } }).weights.delivery, 25, 'a weight not set is its default');
});

test('automatic scores: delivery from the days and your limit, cost from the break-even ROAS at your price (else against the cheapest), quality from the sample tests; your own score wins; not scored counts 0', () => {
  const del = (days, max = 12) => bySlot(card({ s1: sup({ days_eu: days }) }, { max_days: max }), 1).parts.delivery.v;
  assert.deepStrictEqual([1, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13].map((d) => del(d)), [5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0], 'the bands, and 0 over the limit');
  assert.strictEqual(del(13, 14), 1, 'the limit is yours');
  assert.strictEqual(del(undefined), null, 'no days: no score');
  // US and both markets
  const us = card({ s1: sup({ days_eu: 3, days_us: 8, ship_us: 7 }) }, { market: 'us' });
  assert.deepStrictEqual([bySlot(us, 1).days, bySlot(us, 1).parts.delivery.v], [8, 2]);
  const both = card({ s1: sup({ days_eu: 3, days_us: 8, ship_us: 7 }) }, { market: 'both' });
  assert.deepStrictEqual([bySlot(both, 1).days, bySlot(both, 1).parts.delivery.v], [8, 2], 'both markets: the slower one');
  assert.strictEqual(bySlot(card({ s1: sup({ days_eu: 3 }) }, { market: 'both' }), 1).days, null, 'both: needs both');

  // Cost with your price: 49.95 incl. 21% VAT, 3% fees; 2 units × 2.10 + 6.50 shipping + €5 EU duty and fees = 15.70.
  // 49.95 / 1.21 = 41.28 − 1.50 fees − 15.70 = 24.08 left: break-even ROAS 2.07 → 3.
  const priced = card({ s1: sup({ unit: 2.1, ship_eu: 6.5 }) }, { price: 49.95, units: 2 });
  const r = bySlot(priced, 1);
  assert.deepStrictEqual([r.landed, r.duty, r.be_roas, r.parts.cost.v, r.cost_basis], [15.7, 5, 2.07, 3, 'margin']);
  assert.strictEqual(r.be_roas, marginOf({ price: 49.95, cogs: 4.2, ship: 11.5, fees: 3, vat: 21 }).be_roas, 'the launch card’s margin');
  const roas = (unit) => bySlot(card({ s1: sup({ unit, ship_eu: 0, ddp: true }) }, { price: 30, vat: 0, fees: 0 }), 1);
  assert.deepStrictEqual([11, 15, 18, 20, 21, 30, 31].map((u) => roas(u).parts.cost.v), [5, 4, 3, 2, 1, 0, 0], 'ROAS 1.58, 2, 2.5, 3, 3.33, a loss, a loss');
  // Without a price: against the cheapest (5 × cheapest / its landed cost, at least 1)
  const rel = card({ s1: sup({ unit: 2, ship_eu: 3, ddp: true }), s2: sup({ unit: 4, ship_eu: 6, ddp: true }), s3: sup({ unit: 40, ship_eu: 10, ddp: true }), s4: sup({ unit: undefined }) });
  assert.deepStrictEqual([1, 2, 3, 4].map((x) => bySlot(rel, x).parts.cost.v), [5, 3, 1, null]);
  assert.strictEqual(bySlot(rel, 2).cost_basis, 'cheapest');
  // The cheapest one is out (21 days: over the limit): the bar is the cheapest still in, and no score goes over 5
  const barred = card({ s1: sup({ unit: 1, ship_eu: 1, ddp: true, days_eu: 21 }), s2: sup({ unit: 2, ship_eu: 3, ddp: true }), s3: sup({ unit: 4, ship_eu: 6, ddp: true }) });
  assert.deepStrictEqual([1, 2, 3].map((x) => bySlot(barred, x).parts.cost.v), [5, 5, 3]);
  const allOut = card({ s1: sup({ unit: 2, ship_eu: 3, ddp: true, days_eu: 30 }), s2: sup({ unit: 4, ship_eu: 6, ddp: true, days_eu: 30 }) });
  assert.deepStrictEqual([1, 2].map((x) => bySlot(allOut, x).parts.cost.v), [5, 3], 'every one out: against the cheapest of all');

  // Quality: every test passed 5; a test not done counts as not passed; a must-pass fail 0; nothing tested: no score
  const q = (tests) => bySlot(card({ s1: sup({ tests }) }), 1).parts.quality.v;
  assert.strictEqual(q(PASS), 5);
  assert.strictEqual(q({ 'leak-test': 'pass', 'filter-teardown': 'pass' }), 3, '1 + 4 × 2/4');
  assert.strictEqual(q({ ...PASS, 'drop-test': 'fail' }), 4, '1 + 4 × 3/4');
  assert.strictEqual(q({ ...PASS, 'leak-test': 'fail' }), 0, 'a must-pass test failed');
  assert.strictEqual(q({}), null);
  // Your score wins over Auto; a criterion with neither counts 0
  const mine = bySlot(card({ s1: sup({ scores: { ...HAND, delivery: 5, quality: 1 } }) }), 1);
  assert.deepStrictEqual([mine.parts.delivery, mine.parts.quality.v], [{ v: 5, auto: 2, manual: true, w: 25 }, 1]);
  const bare = bySlot(card({ s1: { name: 'Bare', days_eu: 3 } }), 1);
  assert.deepStrictEqual([bare.score, bare.scored], [25, 1], 'only delivery known (5 of 5 × 25): the rest counts 0');
});

test('gates: samples, certificates (pass when the product needs none), delivery within your limit, identity, defects, the must-pass tests; open until known; one fail and it is out of the pick', () => {
  const gates = (o, setup) => Object.fromEntries(bySlot(card({ s1: sup(o) }, setup), 1).gates.map((g) => [g.k, g.state]));
  assert.deepStrictEqual(GATES.map((g) => g.k), ['samples', 'certs', 'delivery', 'identity', 'defects', 'sample']);
  assert.deepStrictEqual(gates({}), { samples: 'pass', certs: 'pass', delivery: 'pass', identity: 'pass', defects: 'pass', sample: 'pass' });
  assert.deepStrictEqual(gates({ gates: {}, tests: {} }), { samples: 'open', certs: 'open', delivery: 'pass', identity: 'open', defects: 'open', sample: 'open' }, 'not answered: open');
  assert.deepStrictEqual(gates({ gates: { ...YES, samples: 'no', certs: 'no', identity: 'no', defects: 'no' } }), { samples: 'fail', certs: 'fail', delivery: 'pass', identity: 'fail', defects: 'fail', sample: 'pass' });
  assert.strictEqual(gates({ gates: { ...YES, certs: 'no' } }, { certs_needed: false }).certs, 'pass', 'no certificates needed');
  assert.strictEqual(gates({ days_eu: 13 }).delivery, 'fail', 'over the default limit of 12');
  assert.strictEqual(gates({ days_eu: 13 }, { max_days: 14 }).delivery, 'pass');
  assert.strictEqual(gates({ days_eu: undefined }).delivery, 'open');
  assert.strictEqual(gates({ tests: { ...PASS, 'filter-teardown': 'fail' } }).sample, 'fail');
  assert.strictEqual(gates({ tests: { 'leak-test': 'pass' } }).sample, 'open', 'a must-pass test not done yet');
  assert.strictEqual(gates({ tests: {} }, { tests: parseTests('Flow rate') }).sample, 'pass', 'no must-pass test: nothing to fail');
  const r = bySlot(card({ s1: sup({ days_eu: 20 }) }), 1);
  assert.deepStrictEqual([r.status, r.failed, r.gates.find((g) => g.k === 'delivery').why], ['fail', ['Delivery days'], '20 days to NL/DE: over your 12']);
  // A failed gate is last and never the pick, whatever its score
  const p = card({ s1: sup({ days_eu: 2, gates: { ...YES, identity: 'no' } }), s2: sup({ days_eu: 9, scores: { ...HAND, reliability: 1 } }) });
  const s = summaryOf(p);
  assert.ok(bySlot(p, 1).score > bySlot(p, 2).score);
  assert.deepStrictEqual([s.rows.map((x) => x.slot), s.pick, s.backup], [[2, 1], 2, null]);
  assert.deepStrictEqual(decide(p, { slot: 1 }, iso(NOW)), { error: 'It fails a gate: Identity', status: 409 }, 'fail = do not choose');
});

test('ties: the same score goes to the better quality, then the faster delivery, then fewer open gates, then the lower landed cost, then the first added', () => {
  const rank = (p) => summaryOf(p).rows.map((r) => r.slot);
  const flat = { quality: 3, delivery: 3, reliability: 3, cost: 3, compliance: 3, returns: 3, scale: 3 };
  const tie = (o = {}) => sup({ ...o, scores: { ...flat, ...(o.scores || {}) } }); // every criterion scored by hand
  // quality 4 + delivery 2 against quality 2 + delivery 4: the same score, 60; quality wins
  let p = card({ s1: tie({ scores: { quality: 2, delivery: 4 } }), s2: tie({ scores: { quality: 4, delivery: 2 } }) });
  assert.deepStrictEqual([bySlot(p, 1).score, bySlot(p, 2).score], [60, 60]);
  assert.deepStrictEqual(rank(p), [2, 1], 'better quality first');
  // The same quality: delivery 4 + reliability 2 against delivery 2 + reliability 4, both weighted 15: the same score
  p = card({ s1: tie({ scores: { delivery: 2, reliability: 4 } }), s2: tie({ scores: { delivery: 4, reliability: 2 } }) }, { weights: { delivery: 15 } });
  assert.strictEqual(bySlot(p, 1).score, bySlot(p, 2).score);
  assert.deepStrictEqual(rank(p), [2, 1], 'then faster delivery');
  p = card({ s1: tie({ gates: { samples: 'yes' } }), s2: tie({}) });
  assert.deepStrictEqual([bySlot(p, 1).open.length, bySlot(p, 2).open.length, rank(p)], [3, 0, [2, 1]], 'then fewer gates open');
  p = card({ s1: tie({ unit: 3 }), s2: tie({ unit: 2 }) });
  assert.deepStrictEqual(rank(p), [2, 1], 'then the lower landed cost');
  p = card({ s1: tie({ unit: undefined }), s2: tie({}) });
  assert.deepStrictEqual(rank(p), [2, 1], 'a cost not known is last among equals');
  p = card({ s3: tie({}), s1: tie({}), s2: tie({}) });
  assert.deepStrictEqual(rank(p), [1, 2, 3], 'then the first added');
  assert.deepStrictEqual(summaryOf(p).rows.map((r) => r.rank), [1, 2, 3]);
});

test('landed cost: units × unit cost + shipping, + the EU duty and fees (€5) on an order from outside the EU unless the price is DDP; from an EU warehouse none', () => {
  const set = setupOf({ units: 2 });
  assert.deepStrictEqual(landedOf({ unit: 2, ship_eu: 6, from: 'cn' }, set, 'eu'), { cogs: 4, ship: 11, duty: 5, total: 15 });
  assert.strictEqual(landedOf({ unit: 2, ship_eu: 6 }, set, 'eu').duty, 5, 'where it ships from not filled in: counted as outside the EU');
  assert.strictEqual(landedOf({ unit: 2, ship_eu: 6, from: 'cn', ddp: true }, set, 'eu').total, 10);
  assert.strictEqual(landedOf({ unit: 2, ship_eu: 6, from: 'eu' }, set, 'eu').total, 10);
  assert.strictEqual(landedOf({ unit: 2, ship_us: 6, from: 'cn' }, set, 'us').total, 10, 'the US duty is not worked out (a flag says so)');
  assert.strictEqual(landedOf({ unit: 2, ship_eu: 6 }, setupOf({ duty_eu: 0 }), 'eu').total, 8, 'the duty is a setting');
  assert.strictEqual(landedOf({ unit: 2 }, set, 'eu'), null);
  assert.strictEqual(KIT.EU_PARCEL, 5);
  const both = bySlot(card({ s1: sup({ ship_eu: 6, ship_us: 12, days_us: 7 }) }, { market: 'both' }), 1);
  assert.strictEqual(both.landed, 14, 'both markets: the dearer one (2 + 12)');
});

test('the summary: the pick and a backup, the verdict, and the flags (red first)', () => {
  const flags = (p, now) => summaryOf(p, now).flags.map((f) => f.k);
  assert.deepStrictEqual([summaryOf({}).verdict, flags({}), summaryOf({}).level], ['No suppliers yet', ['none'], 'amber']);
  // One supplier, no sample tested (its sample gate open), 51/100: 10 + 12 + 15 + 8 + 3 + 3 without quality
  assert.deepStrictEqual(flags(card({ s1: sup({ tests: {} }) })), ['few', 'nosample', 'confirm', 'weak']);
  const good = card({ s1: sup(), s2: sup({ unit: 3 }), s3: sup({ unit: 4 }) });
  const s = summaryOf(good);
  assert.deepStrictEqual([s.verdict, s.pick, s.backup, s.flags, s.level], ['Choose Factory', 1, 2, [], 'green'], 'every gate passed, every criterion scored');
  const open = card({ s1: sup({ gates: { samples: 'yes' } }), s2: sup({ days_eu: 30 }), s3: sup({ days_eu: 31 }) });
  assert.strictEqual(summaryOf(open).verdict, 'Best now: Factory');
  assert.strictEqual(summaryOf(open).flags.find((f) => f.k === 'confirm').text, 'Before you pay for stock, confirm for Factory: Certificates, Identity, Defects');
  const none = card({ s1: sup({ days_eu: 30 }), s2: sup({ days_eu: 31 }), s3: sup({ days_eu: 40 }) });
  assert.deepStrictEqual([summaryOf(none).verdict, flags(none), summaryOf(none).level], ['No supplier passes the gates', ['allfail'], 'red']);
  assert.ok(flags(card({ s1: { name: 'X', days_eu: 3 }, s2: { days_eu: 4 }, s3: { days_eu: 5 } })).includes('weak'), 'best score under 60');
  assert.ok(flags(card({ s1: sup(), s2: sup(), s3: sup() }, { market: 'us' })).includes('usduty'), 'to the US from outside the US, not DDP');
  assert.ok(!flags(card({ s1: sup({ ddp: true }), s2: sup({ from: 'us' }), s3: sup({ ddp: true }) }, { market: 'us' })).includes('usduty'));
  // After a decision: the choice fails a gate now, another one scores higher, the re-check is overdue
  const chosen = { ...good, choice: decide(good, { slot: 2, note: 'x' }, iso(NOW)).choice };
  assert.strictEqual(summaryOf(chosen, NOW).verdict, 'Your choice: Factory');
  assert.deepStrictEqual(summaryOf(chosen, NOW).chosen, { slot: 2, name: 'Factory', at: iso(NOW), next: iso(NOW + 90 * DAY), overdue: false, row: 2 });
  const later = { ...chosen, suppliers: { ...chosen.suppliers, s2: sup({ unit: 3, days_eu: 15, scores: { reliability: 1 } }) } };
  assert.deepStrictEqual(flags(later, NOW + 91 * DAY), ['chosenfail', 'overdue', 'better']);
  assert.match(summaryOf(later, NOW + 91 * DAY).flags[1].text, /^Re-check overdue since 2027-01-15/);
  assert.strictEqual(summaryOf(later, NOW + 91 * DAY).level, 'red');
});

test('clean-up: only known fields, https links, decimal commas, gates yes or no, scores 0 to 5, results only for the product’s tests; tests and questions from lines', () => {
  const setup = { tests: TESTS };
  assert.deepStrictEqual(cleanSupplier({
    name: '  Yuyao\u0000 Factory ', link: 'detail.1688.com/offer/1.html', route: '1688', from: 'mars', unit: '2,15', ship_eu: '€ 6.40', days_eu: '9.4', ddp: 'yes', measured: true,
    moq: -5, repeat: 140, note: 'line 1\nline 2', junk: 1, gates: { samples: 'yes', certs: 'maybe', delivery: 'yes', sample: 'yes', __proto__: 'no' },
    scores: { quality: '4', delivery: 6, cost: 2.5, reliability: 0 }, tests: { 'leak-test': 'pass', 'flow-rate': 'meh', nope: 'pass', constructor: 'pass' },
  }, setup), {
    name: 'Yuyao  Factory', link: 'https://detail.1688.com/offer/1.html', route: '1688', unit: 2.15, ship_eu: 6.4, days_eu: 9, measured: true, note: 'line 1\nline 2',
    gates: { samples: 'yes' }, scores: { quality: 4, reliability: 0 }, tests: { 'leak-test': 'pass' },
  }, 'the automatic gates (delivery, sample tests) cannot be set by hand');
  for (const bad of ['javascript:alert(1)', 'ftp://x.test', 'https://', 'not a link', 'data:text/html,x']) assert.strictEqual(cleanSupplier({ link: bad }).link, undefined, bad);
  assert.strictEqual(cleanSupplier({ link: 'http://shop.test/a' }).link, 'https://shop.test/a');
  assert.deepStrictEqual(cleanSupplier(null), { gates: {}, scores: {}, tests: {} });
  assert.deepStrictEqual(cleanSetup({ market: 'mars', max_days: 0, units: 0, price: '49,95', vat: 19, fees: 'x', cur: 'USD', certs_needed: 'no', duty_eu: 3 }), { price: 49.95, vat: 19, duty_eu: 3, cur: 'USD' }, 'at least 1 day and 1 unit; certificates needed unless false');
  assert.deepStrictEqual(cleanSetup({ certs_needed: false, market: 'both', max_days: '7' }), { market: 'both', max_days: 7, certs_needed: false });
  assert.deepStrictEqual(parseTests('! Leak test: 30 min\n\nFlow rate\n!Teardown\nFlow rate'), [
    { k: 'leak-test-30-min', label: 'Leak test: 30 min', must: true }, { k: 'flow-rate', label: 'Flow rate', must: false },
    { k: 'teardown', label: 'Teardown', must: true }, { k: 'flow-rate-2', label: 'Flow rate', must: false },
  ], 'one per line, ! = must pass, the same label twice gets its own key');
  assert.strictEqual(parseTests('漏水测试')[0].k, 't1', 'a label without letters a-z gets a key by its place');
  assert.strictEqual(parseTests(Array.from({ length: 20 }, (_, i) => 'Test ' + i).join('\n')).length, 15);
  assert.deepStrictEqual(parseQuestions('Are you the factory? | 您是工厂吗？\nPrice at 100?\n | 只有中文'), [{ en: 'Are you the factory?', zh: '您是工厂吗？' }, { en: 'Price at 100?' }], 'a question needs its English');
  assert.deepStrictEqual(setupOf({ tests: [] }).tests, [], 'no tests is your choice');
  assert.ok(setupOf({}).tests.length >= 4 && setupOf({}).questions.length >= 8, 'a new product: the general tests and questions');
  assert.deepStrictEqual(cleanChecks({ shortlist: true, message: 'yes', nope: true, samples: true }), { shortlist: true, samples: true });
  assert.strictEqual(CHECKS.length, 7);
  assert.deepStrictEqual([ownKey('Posture Corrector Pro!'), ownKey('Café Lamp'), ownKey('淋浴喷头')], ['own|posture-corrector-pro', 'own|cafe-lamp', ownKey('淋浴喷头')]);
  assert.match(ownKey('淋浴喷头'), /^own\|p-[a-z0-9]+$/);
});

test('the decision record: the supplier as it is now, a backup, why, the date and the next re-check in 90 days; taken back and replaced ones stay in the history (10)', () => {
  const p = card({ s1: sup({ name: 'A', link: 'https://detail.1688.com/offer/1.html', lead: 15, moq: 50 }), s2: sup({ name: 'B', unit: 3 }), s3: sup({ name: 'C', days_eu: 30 }) });
  const at = iso(NOW);
  const d = decide(p, { slot: 1, note: '  Best sample\nfast answers ' }, at).choice;
  assert.deepStrictEqual(Object.keys(d), ['current', 'past']);
  const c = d.current;
  assert.deepStrictEqual([c.slot, c.name, c.link, c.unit, c.ship_eu, c.days_eu, c.lead, c.moq, c.score, c.status, c.landed, c.market, c.max_days, c.note, c.at, c.next],
    [1, 'A', 'https://detail.1688.com/offer/1.html', 2, 6, 9, 15, 50, bySlot(p, 1).score, 'pass', 13, 'eu', 12, 'Best sample\nfast answers', at, iso(NOW + 90 * DAY)]);
  assert.deepStrictEqual(c.backup, { slot: 2, name: 'B', score: bySlot(p, 2).score, link: '' }, 'the next best that fails no gate');
  assert.deepStrictEqual(c.parts, { quality: 5, delivery: 2, reliability: 4, cost: 5, compliance: 4, returns: 3, scale: 3 });
  assert.strictEqual(decide(p, { slot: 1, backup: 0 }, at).choice.current.backup, null, 'no backup');
  assert.deepStrictEqual(decide(p, { slot: 1, backup: 3 }, at), { error: 'The backup fails a gate: Delivery days', status: 409 });
  assert.deepStrictEqual(decide(p, { slot: 1, backup: 1 }, at), { error: 'Bad backup', status: 400 });
  assert.deepStrictEqual(decide(p, { slot: 4 }, at), { error: 'No supplier in that slot', status: 404 });
  // A re-check: its numbers now and your note; the next one 90 days on
  let q = { ...p, choice: d };
  const r = recheck(q, { note: 'Price same, no complaints' }, iso(NOW + 80 * DAY)).choice.current;
  assert.deepStrictEqual([r.rechecks.length, r.rechecks[0].note, r.rechecks[0].score, r.rechecks[0].unit, r.rechecks[0].days, r.next], [1, 'Price same, no complaints', bySlot(p, 1).score, 2, 9, iso(NOW + 170 * DAY)]);
  assert.deepStrictEqual(recheck(p, {}, at), { error: 'Choose a supplier first', status: 409 });
  // Replaced, then taken back: both kept, the newest first
  q = { ...q, choice: decide(q, { slot: 2 }, iso(NOW + DAY)).choice };
  assert.deepStrictEqual([q.choice.current.name, q.choice.past.map((x) => [x.name, x.why])], ['B', [['A', 'replaced']]]);
  q = { ...q, choice: undecide(q, iso(NOW + 2 * DAY)).choice };
  assert.deepStrictEqual([q.choice.current, q.choice.past.map((x) => [x.name, x.why, x.ended])], [null, [['B', 'taken back', iso(NOW + 2 * DAY)], ['A', 'replaced', iso(NOW + DAY)]]]);
  assert.deepStrictEqual(undecide(q, at), { error: 'No decision to take back', status: 409 });
  for (let i = 0; i < 12; i++) q = { ...q, choice: decide(q, { slot: 1 + (i % 2) }, iso(NOW + (3 + i) * DAY)).choice };
  assert.strictEqual(q.choice.past.length, 10, 'the history keeps the last 10');
});

test('the first message: the product’s questions, numbered, in English or Chinese', () => {
  const p = { setup: { questions: parseQuestions('Are you the factory? | 您是工厂吗？\nPrice at 100?') } };
  assert.strictEqual(messageOf(p, 'en'), 'Hello,\nI run an online store in the Netherlands and Germany (and the US), and I am comparing suppliers for this product (see the photo). Could you answer these questions?\n1. Are you the factory?\n2. Price at 100?\nThank you!');
  assert.strictEqual(messageOf(p, 'zh'), '您好！\n我在荷兰和德国（以及美国）经营网店，正在为这款产品（见图片）比较供应商。请回答以下问题：\n1. 您是工厂吗？\n2. Price at 100?\n谢谢！', 'a question without Chinese goes in English');
  assert.match(messageOf({}, 'zh'), /营业执照/, 'a new product: the general questions');
});

test('/supplier.js is the kit on its own: in a bare context it gives the same answers as the module', () => {
  const ctx = vm.createContext({ window: {}, URL });
  vm.runInContext(SUPPLIER_JS, ctx);
  const K = ctx.window.SUPPLIER;
  const same = (a, b, what) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), what);
  same(Object.keys(K), Object.keys(KIT), 'the same functions and lists');
  const p = card({ s1: sup({ unit: 2.1, ship_eu: 6.5 }), s2: sup({ days_eu: 30 }), s3: sup({ gates: {}, tests: { 'leak-test': 'fail' } }) }, { price: 49.95, units: 2, market: 'eu' });
  same(K.summaryOf(p, NOW), summaryOf(p, NOW), 'the whole summary');
  same(K.decide(p, { slot: 1, note: 'n' }, iso(NOW)), decide(p, { slot: 1, note: 'n' }, iso(NOW)), 'the decision');
  same(K.cleanSupplier({ unit: '2,5', link: 'shop.test' }, {}), cleanSupplier({ unit: '2,5', link: 'shop.test' }, {}));
  assert.match(SUPPLIER_JS, /^'use strict';\nwindow\.SUPPLIER = \(function supplierKit\(L\) \{/);
});

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

test('/api/supplier and /supplier.js need the PIN; /supplier.js is the kit as a script', async () => {
  const env = await seededEnv();
  const anon = (path, init) => handle(new Request(ORIGIN + path, init), env, { now: NOW });
  assert.strictEqual((await anon('/api/supplier')).status, 401);
  assert.strictEqual((await anon(`/api/supplier?key=${encodeURIComponent(SEED)}`)).status, 401);
  assert.strictEqual((await anon('/api/supplier', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: SEED, remove: true }) })).status, 401);
  assert.strictEqual((await anon('/supplier.js')).status, 401);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM sourcing').get().n, 1, 'nothing removed');
  const s = await session(env);
  const js = await s.call('/supplier.js');
  assert.deepStrictEqual([js.status, js.headers.get('content-type'), js.headers.get('x-content-type-options')], [200, 'text/javascript; charset=utf-8', 'nosniff']);
  assert.strictEqual(await js.text(), SUPPLIER_JS);
  assert.strictEqual((await s.call('/supplier.js', { method: 'POST' })).status, 405);
  assert.strictEqual((await s.call('/api/supplier', { method: 'PUT' })).status, 405);
});

test('/api/supplier: the seeded showerhead first; suppliers, setup, checklist, a decision and a re-check, each saved and cleaned; up to 5; remove', async () => {
  const env = await seededEnv();
  const s = await session(env);
  const list = (await s.get('/api/supplier')).products;
  assert.deepStrictEqual(list.map((x) => [x.key, x.title, x.suppliers, x.verdict, x.chosen]), [[SEED, 'Filtered showerhead (Muravai style)', 0, 'No suppliers yet', null]]);
  assert.match(list[0].img, /^https:\/\/cdn\.shopify\.com\//);
  const one = (await s.get(`/api/supplier?key=${encodeURIComponent(SEED)}`)).product;
  assert.deepStrictEqual([one.key, one.suppliers, one.choice, one.summary.flags.map((f) => f.k)], [SEED, {}, {}, ['none']]);
  const tests = one.summary.setup.tests;
  assert.ok(tests.some((t) => t.must));
  assert.deepStrictEqual(await s.get('/api/supplier?key=own%7Cnope'), { error: 'No scorecard for this product' });
  assert.strictEqual((await s.call('/api/supplier?key=bad')).status, 400);

  // Three suppliers; the second one ships too slowly for the gate
  const leak = tests.find((t) => /leak/i.test(t.label)).k;
  const a = await api(s, { key: SEED, slot: 1, supplier: { name: 'Yuyao A', route: '1688', from: 'cn', unit: '2,10', ship_eu: 6.5, days_eu: 9, gates: YES, tests: { [leak]: 'pass', nope: 'pass' }, scores: HAND, junk: 'x' } }, { now: NOW + 1000 });
  assert.strictEqual(a.status, 200);
  assert.deepStrictEqual(a.product.suppliers.s1, { name: 'Yuyao A', route: '1688', from: 'cn', unit: 2.1, ship_eu: 6.5, days_eu: 9, gates: YES, scores: HAND, tests: { [leak]: 'pass' } }, 'saved cleaned');
  await api(s, { key: SEED, slot: 2, supplier: { name: 'Slow B', unit: 1.2, ship_eu: 4, days_eu: 25, gates: YES, scores: HAND } });
  await api(s, { key: SEED, slot: 3, supplier: { name: 'EU stock C', from: 'eu', unit: 6, ship_eu: 4.5, days_eu: 3, gates: { samples: 'yes', identity: 'yes' }, scores: { reliability: 3 } } });
  let p = (await api(s, { key: SEED, setup: { ...one.setup, price: 49.95, units: 2, max_days: 12 } })).product;
  assert.deepStrictEqual([p.setup.price, p.setup.units, p.setup.tests.length, p.setup.questions.length], [49.95, 2, one.setup.tests.length, one.setup.questions.length], 'the setup is saved whole: its tests and questions stay');
  assert.deepStrictEqual(p.summary.rows.map((r) => [r.slot, r.status]), [[1, 'open'], [3, 'open'], [2, 'fail']]);
  assert.deepStrictEqual([p.summary.pick, p.summary.backup], [1, 3]);
  assert.deepStrictEqual(await api(s, { key: SEED, slot: 6, supplier: { name: 'Six' } }), { status: 400, error: 'A slot is 1 to 5' });
  assert.deepStrictEqual(await api(s, { key: SEED, slot: 0, supplier: {} }), { status: 400, error: 'A slot is 1 to 5' });
  assert.deepStrictEqual(await api(s, { key: SEED, slot: 2, supplier: [1] }), { status: 400, error: 'Bad supplier' });
  assert.deepStrictEqual(await api(s, { key: SEED, slot: 2 }), { status: 400, error: 'Nothing to save' });
  // The checklist
  p = (await api(s, { key: SEED, checks: { shortlist: true, message: true, nope: true } })).product;
  assert.deepStrictEqual([p.checks, p.summary.checks], [{ shortlist: true, message: true }, { done: 2, of: 7 }]);
  // The decision: not one that fails a gate; with a note; it keeps the supplier as it was
  assert.deepStrictEqual(await api(s, { key: SEED, choose: { slot: 2 } }), { status: 409, error: 'It fails a gate: Delivery days' });
  const d = await api(s, { key: SEED, choose: { slot: 1, note: 'Best test results' } }, { now: NOW + 5000 });
  assert.deepStrictEqual([d.status, d.product.choice.current.name, d.product.choice.current.unit, d.product.choice.current.backup.name, d.product.choice.current.at], [200, 'Yuyao A', 2.1, 'EU stock C', iso(NOW + 5000)]);
  assert.deepStrictEqual(d.product.summary.chosen.name, 'Yuyao A');
  assert.strictEqual((await s.get('/api/supplier')).products[0].chosen.name, 'Yuyao A');
  // Your choice and its backup cannot be dropped; another supplier can
  assert.deepStrictEqual(await api(s, { key: SEED, slot: 1, drop: true }), { status: 409, error: 'This is your choice or its backup: take the decision back first' });
  assert.strictEqual((await api(s, { key: SEED, slot: 3, drop: true })).status, 409);
  const dropped = await api(s, { key: SEED, slot: 2, drop: true });
  assert.deepStrictEqual(Object.keys(dropped.product.suppliers).sort(), ['s1', 's3']);
  // A re-check, then the decision taken back
  const r = await api(s, { key: SEED, recheck: { note: 'Same price' } }, { now: NOW + 30 * DAY });
  assert.deepStrictEqual([r.product.choice.current.rechecks[0].note, r.product.choice.current.next], ['Same price', iso(NOW + 120 * DAY)]);
  const u = await api(s, { key: SEED, choose: null });
  assert.deepStrictEqual([u.product.choice.current, u.product.choice.past[0].why], [null, 'taken back']);
  assert.deepStrictEqual(await api(s, { key: SEED, recheck: {} }), { status: 409, error: 'Choose a supplier first' });
  assert.deepStrictEqual(await api(s, { key: SEED }), { status: 400, error: 'Nothing to save' });
  // Removed: gone, and a change after it is a 404 (never a new scorecard)
  assert.deepStrictEqual(await api(s, { key: SEED, remove: true }), { status: 200, ok: true, removed: SEED });
  assert.deepStrictEqual(await api(s, { key: SEED, slot: 1, supplier: { name: 'Late' } }), { status: 404, error: 'No scorecard for this product' });
  assert.deepStrictEqual((await s.get('/api/supplier')).products, []);
});

test('/api/supplier: a scorecard for any product: by name (own key), or from a launch card (its facts come along; no card, no scorecard)', async () => {
  const env = await seededEnv();
  const s = await session(env);
  const own = await api(s, { add: { title: '  Posture Corrector  ', link: 'shop.test/products/pc' } }, { now: NOW + 1000 });
  assert.deepStrictEqual([own.status, own.product.key, own.product.title, own.product.facts.link, own.product.summary.setup.tests.length > 0], [200, 'own|posture-corrector', 'Posture Corrector', 'https://shop.test/products/pc', true]);
  assert.strictEqual((await api(s, { add: { title: 'Posture corrector' } })).product.created_at, iso(NOW + 1000), 'the same name again: the same scorecard');
  assert.deepStrictEqual(await api(s, { add: { title: '' } }), { status: 400, error: 'Give the product a name' });
  assert.deepStrictEqual(await api(s, { add: { title: 'X', link: 'javascript:alert(1)' } }), { status: 400, error: 'Bad link: use an https link' });
  // From a launch card: approve, start the card, then the scorecard under the same key
  const KEY = 'eu|shop1.test/products/item-1';
  assert.deepStrictEqual(await api(s, { start: KEY }), { status: 404, error: 'No launch card for this product: start one in Launch first' });
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9001', status: 'seen' })).status, 200);
  assert.strictEqual((await s.post('/api/launch', { start: KEY })).status, 200);
  const st = await api(s, { start: KEY }, { now: NOW + 2000 });
  assert.deepStrictEqual([st.status, st.product.key, st.product.title, st.product.facts.link, st.product.facts.price, st.product.facts.cur, st.product.facts.launch], [200, KEY, 'Posture Corrector Pro', 'https://shop1.test/products/item-1', 30.95, 'EUR', KEY]);
  assert.strictEqual((await api(s, { start: KEY }, { now: NOW + 9000 })).product.created_at, iso(NOW + 2000), 'started again: the same one');
  for (const bad of ['', 'own|x', 'shop|1', 42, 'eu|' + 'x'.repeat(1000)]) assert.strictEqual((await api(s, { start: bad })).status, 400, String(bad).slice(0, 20));
  // The last touched first. The seed is dated 1 Nov 2026, after the test clock (17 Oct): it comes first here.
  assert.deepStrictEqual((await s.get('/api/supplier')).products.map((x) => x.key), [SEED, KEY, 'own|posture-corrector']);
});

test('/api/supplier: two suppliers saved at the same moment both stay; other sites, bad JSON and big bodies are refused; every value is a bound parameter', async () => {
  const env = await seededEnv();
  const s = await session(env);
  await Promise.all([1, 2, 3].map((slot) => api(s, { key: SEED, slot, supplier: { name: 'S' + slot } })));
  assert.deepStrictEqual(Object.keys(JSON.parse(env.db.prepare('SELECT suppliers FROM sourcing').get().suppliers)).sort(), ['s1', 's2', 's3']);
  const body = { key: SEED, checks: { shortlist: true } };
  assert.strictEqual((await s.post('/api/supplier', body, { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.strictEqual((await s.post('/api/supplier', body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.strictEqual((await s.post('/api/supplier', 'not json')).status, 400);
  assert.strictEqual((await s.post('/api/supplier', '[1]')).status, 400);
  assert.strictEqual((await s.post('/api/supplier', { ...body, x: 'x'.repeat(17000) })).status, 413);
  assert.strictEqual(env.db.prepare('SELECT checks FROM sourcing').get().checks, '{}', 'nothing saved');
  const evil = "'); DELETE FROM sourcing; --";
  assert.strictEqual((await api(s, { key: SEED, slot: 4, supplier: { name: evil, note: evil } })).product.suppliers.s4.name, evil, 'kept as text');
  assert.strictEqual((await api(s, { key: `own|x'; DROP TABLE sourcing; --`, remove: true })).status, 400);
  assert.strictEqual((await api(s, { key: `eu|x'; DROP TABLE sourcing; --`, remove: true })).status, 404);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM sourcing').get().n, 1);
  assert.ok(!env.DB.log.some((l) => /DROP|DELETE FROM sourcing;|Yuyao/.test(l.sql)), 'user text never in the SQL');
});
