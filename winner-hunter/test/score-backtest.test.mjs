// The backtest (lib/score-backtest.mjs) and the daily digest (lib/daily-digest.mjs).
import test from 'node:test';
import assert from 'node:assert';
import { auc, aucCi, precisionAt, rng, backtest, backtestMd, learnWeights, labelled } from '../lib/score-backtest.mjs';
import { digestMd, digestCsv, dayLabel, bangkokDay, withBoard, blockerOf, moneyOf } from '../lib/daily-digest.mjs';

test('AUC: 1 when every approval scores higher, 0 the other way, 0.5 for ties; null without both kinds', () => {
  assert.strictEqual(auc([{ s: 3, y: 1 }, { s: 2, y: 1 }, { s: 1, y: 0 }]), 1);
  assert.strictEqual(auc([{ s: 1, y: 1 }, { s: 2, y: 0 }]), 0);
  assert.strictEqual(auc([{ s: 1, y: 1 }, { s: 1, y: 0 }]), 0.5);
  assert.strictEqual(auc([{ s: 1, y: 1 }]), null);
});

test('AUC matches the pairwise count on random data (ties included)', () => {
  const r = rng(3);
  const pairs = [...Array(200)].map(() => ({ s: Math.round(r() * 20), y: r() < 0.35 ? 1 : 0 }));
  let w = 0;
  let k = 0;
  for (const p of pairs.filter((x) => x.y === 1)) for (const q of pairs.filter((x) => x.y === 0)) { w += p.s > q.s ? 1 : p.s === q.s ? 0.5 : 0; k++; }
  assert.ok(Math.abs(auc(pairs) - w / k) < 1e-12);
});

test('the bootstrap interval is reproducible with a seed and holds the AUC', () => {
  const r = rng(5);
  const pairs = [...Array(120)].map(() => { const y = r() < 0.3 ? 1 : 0; return { s: r() + y * 0.4, y }; });
  const a = aucCi(pairs, { n: 300, seed: 9 });
  assert.deepStrictEqual(a, aucCi(pairs, { n: 300, seed: 9 }));
  assert.ok(a[0] <= auc(pairs) && auc(pairs) <= a[1]);
  assert.strictEqual(precisionAt([{ s: 3, y: 1 }, { s: 2, y: 0 }, { s: 1, y: 1 }], 2), 0.5);
});

// A labelled set where approvals have more market proof: the score must find that, out of fold too.
function synthetic(nPos = 30, nNeg = 60, seed = 2) {
  const r = rng(seed);
  const facts = [];
  const decisions = [];
  for (let i = 0; i < nPos + nNeg; i++) {
    const y = i < nPos ? 1 : 0;
    const strong = y ? r() < 0.85 : r() < 0.2;
    const key = `world|s${i}.test/products/p${i}`;
    facts.push({ key, src: 'world', title: `Product ${i}`, product_url: `https://s${i}.test/products/p${i}`, store_url: `https://s${i}.test/`, price: 39 + Math.round(r() * 40), cur: 'EUR',
      ad_days: strong ? 60 + Math.round(r() * 100) : 8 + Math.round(r() * 10), copies: strong ? 12 : 1, bs_rank: strong ? 1 + Math.round(r() * 5) : null, bs_ok: true, store_products: 30,
      jev: { p: { physical: 0.99, people: 0.01, problem: r(), wow: r(), clear3s: r() }, main: i % 3 ? 'Home' : 'Pets' } });
    decisions.push({ key, y, at: `2026-10-${String(10 + (i % 20)).padStart(2, '0')}T08:00:00Z` });
  }
  // One approval the current rules forbid (a supplement), and one decision without a product.
  facts.push({ key: 'world|sup.test/products/gummies', src: 'world', title: 'Sleep gummies with melatonin', price: 29, cur: 'EUR', ad_days: 90, copies: 30, jev: { p: { people: 0.98 }, main: 'Food and supplements' } });
  decisions.push({ key: 'world|sup.test/products/gummies', y: 1, at: '2026-10-20T08:00:00Z' }, { key: 'world|gone.test/products/x', y: 0, at: '2026-10-21T08:00:00Z' });
  return { facts, decisions };
}

test('the backtest finds an approvals-have-proof pattern, in sample and cross-validated, and keeps the forbidden approval apart', () => {
  const { facts, decisions } = synthetic();
  const b = backtest(facts, decisions, { day: '2026-11-05', cutoff: '2026-10-25', bootstrap: 200, repeats: 3 });
  assert.strictEqual(b.n, 91);
  assert.strictEqual(b.missing, 1);
  assert.ok(b.auc_prior > 0.75, String(b.auc_prior));
  assert.ok(b.cv.mean > 0.75, String(b.cv.mean));
  assert.strictEqual(b.policy.removed, 1);
  assert.match(b.policy.approvals_now_out[0].why, /eat or take/);
  assert.ok(b.cv_policy.mean >= b.cv.mean);
  assert.ok(b.holdout && b.holdout.test > 0 && b.holdout.train > 0);
  assert.ok(b.baselines.find((x) => x.name === 'Proof pillar').auc > 0.75);
  const md = backtestMd(b);
  assert.match(md, /cross-validated/);
  assert.match(md, /Sleep gummies/);
  const again = backtest(facts, decisions, { day: '2026-11-05', cutoff: '2026-10-25', bootstrap: 200, repeats: 3 });
  assert.deepStrictEqual(again.cv, b.cv, 'seeded: the same report twice');
});

test('learned weights stay near the spec, and are only adopted with a clear gain and 50+ decisions', () => {
  const { facts, decisions } = synthetic(10, 20);
  const { rows } = labelled(facts, decisions);
  const w = learnWeights(rows);
  const sum = Object.values(w.weights).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(sum - 1) < 0.02);
  for (const v of Object.values(w.weights)) assert.ok(v >= 0 && v <= 0.6);
  assert.strictEqual(w.adopt, false, 'fewer than 50 decisions');
});

test('the digest: a date line, one line per pick with why, audience, margin, CPA, blocker and link; under 25 lines', () => {
  const p = (i, o = {}) => ({ id: `p-${i}`, name: `Product ${i}`, score: 70 - i, why: '#1 in its store, ads 60 days', src: 'world', level: 3, category: 'Home',
    econ: { margin_eur: 21.4, breakeven_cpa_eur: 21.4, supplier: 'est', price_eur: 49.95 }, risk: { flags: ['Docs: CE'], returns: [] }, links: { product_url: 'https://s.test/products/x' }, ...o });
  const picks = [...Array(12)].map((_, i) => p(i));
  picks[0].audience = { one_line: 'Women 35-55 in NL and BE who sleep hot' };
  picks[1].sheet = { margin_eur: 18, breakeven_cpa_eur: 18, main_blocker: 'papers for CE, WEEE', estimate: false };
  const md = digestMd({ day: '2026-11-06', picks, asOf: '06:00 ICT' });
  const lines = md.trim().split('\n');
  assert.ok(lines.length <= 25);
  assert.strictEqual(lines[0], 'Winners for Fri 6 Nov 2026: 12 picks (data to 06:00 ICT)');
  assert.strictEqual(lines.filter((l) => /^\d+\. /.test(l)).length, 10, 'never more than 10 lines of picks');
  assert.match(lines[1], /^1\. Product 0: score 70, #1 in its store, ads 60 days\. Audience: Women 35-55 in NL and BE who sleep hot\. Margin €21, break-even CPA €21 \(est\.\)\. Blocker: needs papers: CE\. \{\{BOARD\}\}\/#today\/p-0$/);
  assert.match(lines[2], /Margin €18, break-even CPA €18\. Blocker: papers for CE, WEEE\./);
  assert.match(withBoard(md, 'https://board.test/'), /https:\/\/board\.test\/#today\/p-0/);
  assert.doesNotMatch(withBoard(md, ''), /\{\{BOARD\}\}/);
  const fail = digestMd({ day: '2026-11-06', picks: [], failed: { stage: 'collect', error: 'Cloudflare D1: HTTP 500' } });
  assert.match(fail, /The run failed at collect: Cloudflare D1: HTTP 500\./);
  const short = digestMd({ day: '2026-11-06', picks: picks.slice(0, 3), message: 'Only 3 products passed the quality bar today (the bar is never lowered to fill the list).' });
  assert.match(short, /Only 3 products passed/);
});

test('the digest helpers: day labels, the Bangkok day, blockers and money fall back to the score', () => {
  assert.strictEqual(dayLabel('2026-11-05'), 'Thu 5 Nov 2026');
  assert.strictEqual(bangkokDay(Date.parse('2026-11-05T16:59:00Z')), '2026-11-05');
  assert.strictEqual(bangkokDay(Date.parse('2026-11-05T17:00:00Z')), '2026-11-06');
  assert.strictEqual(blockerOf({ risk: { flags: [], returns: ['Sizes'] } }), 'Sizes');
  assert.strictEqual(blockerOf({ risk: { flags: ['Ad numbers are the shop page’s, not this product’s'], returns: [] } }), 'none found');
  assert.deepStrictEqual(moneyOf({ econ: { margin_eur: 10, breakeven_cpa_eur: 10, supplier: 'yours' } }), { margin: 10, cpa: 10, est: false });
});

test('the CSV quotes what a sheet would run as a formula', () => {
  const csv = digestCsv({ day: '2026-11-06', picks: [{ id: 'x', name: '=HYPERLINK("http://evil.test")', score: 60, why: 'w', src: 'eu', level: 2, risk: { flags: [], returns: [] }, links: {} }] });
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil\.test""\)"/);
});
