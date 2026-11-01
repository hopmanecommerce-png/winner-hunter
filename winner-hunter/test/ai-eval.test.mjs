// ai-eval.mjs: how often the AI read's fit agrees with your approve / reject decisions. The maths on known numbers, then
// the whole script on an in-memory D1: blind decisions apart from those made after opening the AI read, your reasons,
// the report saved in D1, and nothing but counts in a GitHub Actions log (this repository is public).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { d1Client } from '../lib/d1.mjs';
import { agreement, auc, wilson, bestThreshold, pairsOf, report, misses, textOf, argsOf, main, MIN_N } from '../ai-eval.mjs';
import { d1Rest } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-3, `${msg}: ${a} is not ${b}`);
const iso = (ms) => new Date(ms).toISOString();
const DAY = 864e5;
// Three approved, five rejected (worked out by hand in the comments).
const SET = [[90, true], [80, true], [40, true], [70, false], [30, false], [20, false], [10, false], [40, false]].map(([fit, approved]) => ({ fit, approved }));

test('agreement: accuracy, balanced accuracy, Cohen\'s kappa, precision, recall and the AUC on numbers worked out by hand', () => {
  const a = agreement(SET, 50);
  assert.deepStrictEqual([a.n, a.approved, a.rejected, a.tp, a.fp, a.fn, a.tn], [8, 3, 5, 2, 1, 1, 4]);
  near(a.accuracy, 0.75, 'accuracy 6 of 8');
  near(a.balanced, (2 / 3 + 4 / 5) / 2, 'balanced');
  near(a.kappa, (0.75 - 34 / 64) / (1 - 34 / 64), 'kappa: chance agreement 34/64');
  near(a.precision, 2 / 3, 'precision');
  near(a.recall, 2 / 3, 'recall');
  near(a.base, 5 / 8, 'always "reject"');
  near(a.auc, 13.5 / 15, 'AUC: 13.5 of 15 pairs in order, the tie at 40 counts half');
  near(a.ci[0], 0.40926, 'Wilson low');
  near(a.ci[1], 0.92852, 'Wilson high');
  assert.strictEqual(auc(SET.filter((p) => p.approved)), null, 'no rejected products: no AUC');
  assert.strictEqual(wilson(0, 0), null);
  const none = agreement([], 50);
  assert.deepStrictEqual([none.n, none.accuracy, none.kappa, none.auc, none.ci], [0, null, null, null, null]);
  assert.strictEqual(agreement([{ fit: 90, approved: true }, { fit: 80, approved: true }], 50).kappa, null, 'one kind of decision: kappa says nothing');
  assert.deepStrictEqual(bestThreshold(SET), { threshold: 75, balanced: (2 / 3 + 1) / 2 }, 'the best balance, the threshold nearest 50 on a tie (75 and 80)');
  assert.strictEqual(bestThreshold([{ fit: 50, approved: true }]), null);
});

test('pairsOf: one pair per decided product with an AI read, by its last decision; blind unless you opened the read before deciding', () => {
  const decisions = [
    { k: 'eu|1|a', ad_id: 'a1', status: 'rejected', at: '2026-10-10T00:00:00.000Z', title: 'A' },
    { k: 'eu|1|a', ad_id: 'a2', status: 'seen', at: '2026-10-12T00:00:00.000Z', title: 'A' },
    { k: 'eu|2|b', ad_id: 'b1', status: 'rejected', at: '2026-10-12T00:00:00.000Z', title: 'B' },
    { k: 'world|c.test/products/c', ad_id: 'c1', status: 'rejected', at: '2026-10-12T00:00:00.000Z', title: 'C' },
    { k: 'eu|9|no-read', ad_id: 'n1', status: 'seen', at: '2026-10-12T00:00:00.000Z', title: 'N' },
  ];
  const ai = [
    { product_key: 'eu|1|a', fit: 70, confidence: 'high', verdict: '{"saturation":"low"}', flags: '[]', opened_at: '2026-10-11T00:00:00.000Z' },
    { product_key: 'eu|2|b', fit: 20, confidence: 'medium', verdict: 'broken', flags: '["injection"]', opened_at: '2026-10-13T00:00:00.000Z' },
    { product_key: 'world|c.test/products/c', fit: 55, confidence: 'bogus', verdict: '{}', flags: null, opened_at: null },
    { product_key: 'eu|8|undecided', fit: 90, confidence: 'high', verdict: '{}', flags: '[]', opened_at: null },
  ];
  const p = pairsOf(decisions, ai, [{ ad_id: 'b1', action: 'rejected', reasons: '["saturated","price"]' }]);
  assert.deepStrictEqual(p.map((x) => [x.key, x.approved, x.fit, x.blind, x.scope, x.confidence]), [
    ['eu|1|a', true, 70, false, 'eu', 'high'], ['eu|2|b', false, 20, true, 'eu', 'medium'], ['world|c.test/products/c', false, 55, true, 'world', 'low']]);
  assert.deepStrictEqual(p[1].reasons, ['saturated', 'price']);
  assert.strictEqual(p[1].injection, true);
  assert.strictEqual(p[0].saturation, 'low');
});

test('report and textOf: rates and counts by blind or seen, confidence, market and your reasons; no product names', () => {
  const pairs = SET.map((p, i) => ({ ...p, key: 'eu|' + i + '|x', title: 'Secret product ' + i, confidence: i % 2 ? 'high' : 'low', blind: i !== 3, scope: i < 4 ? 'world' : 'eu', reasons: i === 3 ? ['saturated'] : [], saturation: 'high', injection: i === 0 }));
  const r = report(pairs, { threshold: 50 });
  assert.deepStrictEqual([r.blind.n, r.seen.n, r.by_confidence.high.n, r.by_confidence.low.n, r.by_scope.world.n, r.by_scope.eu.n, r.flagged], [7, 1, 4, 4, 4, 4, 1]);
  assert.deepStrictEqual(r.reasons, [{ side: 'bad', reason: 'saturated', label: 'Saturated', n: 1, mean_fit: 70, ai_saturation_high: 1 }]);
  near(r.fit_mean.approved, 70, 'mean fit approved');
  near(r.fit_mean.rejected, 34, 'mean fit rejected');
  const text = textOf(r);
  assert.match(text, /^AI read vs your decisions \(a fit of 50 or more counts as approve\)$/m);
  assert.match(text, /Decisions with an AI read: 8 \(3 approved, 5 rejected\)/);
  assert.match(text, /Agreement: 75% \(95% CI 41%–93%\); always picking your most common decision would score 63%/);
  assert.match(text, /Cohen's kappa 0\.47 · AUC 0\.90/);
  assert.match(text, /Blind \(decided before opening its AI read\): 7 decisions/);
  assert.match(text, /Saturated 1 \(mean fit 70, AI said high saturation 100%\)/);
  assert.match(text, /Too few decisions to judge it yet \(fewer than 20\)/);
  assert.doesNotMatch(text, /Secret product/);
  assert.match(textOf(report([])), /no decided product has an AI read yet/);
  const m = misses(pairs, 50);
  assert.deepStrictEqual(m.approved_low.map((x) => x.fit), [40]);
  assert.deepStrictEqual(m.rejected_high.map((x) => [x.fit, x.title]), [[70, 'Secret product 3']]);
  assert.strictEqual(MIN_N, 20);
  assert.deepStrictEqual(argsOf(['--threshold', '65', '--details', '--json']), { threshold: 65, details: true, json: true });
  assert.strictEqual(argsOf(['--threshold', 'abc']).threshold, 50);
  assert.strictEqual(argsOf(['--threshold', '500']).threshold, 100);
});

/** Four decided products with an AI read on the seeded board, and two things that do not count. */
async function decided() {
  const env = await seededEnv();
  env.db.prepare(`INSERT INTO world_products (product_key, ad_id, active, product_title, price, currency, store_url, product_url, first_seen, last_seen) VALUES ('pod.test/products/pillow', '1001', 1, 'Pod Pillow', 49, 'AUD', 'https://pod.test/', 'https://pod.test/products/pillow', ?, ?)`).run(iso(NOW - 3 * DAY), iso(NOW));
  const decide = (ad, status, at, reasons = '[]') => {
    env.db.prepare('INSERT INTO hidden (ad_id, status, at) VALUES (?, ?, ?)').run(ad, status, iso(at));
    env.db.prepare("INSERT INTO feedback (ad_id, action, reasons, note, at) VALUES (?, ?, ?, '', ?)").run(ad, status, reasons, iso(at));
  };
  decide('9001', 'seen', NOW - 2 * DAY);
  decide('9002', 'rejected', NOW - DAY, '["saturated"]');
  decide('9003', 'rejected', NOW - DAY);
  decide('1001', 'seen', NOW - DAY);
  decide('9005', 'rejected', NOW - DAY); // no AI read: does not count
  const read = (key, fit, opened, saturation = 'medium') => env.db.prepare("INSERT INTO ai_checks (product_key, status, fit, confidence, verdict, flags, checked_at, opened_at) VALUES (?, 'ok', ?, 'medium', ?, '[]', ?, ?)")
    .run(key, fit, JSON.stringify({ saturation }), iso(NOW - 4 * DAY), opened == null ? null : iso(opened));
  read('eu|501|posture corrector pro', 80, null);
  read('eu|502|heated neck pillow', 30, NOW - 3 * DAY, 'high'); // opened before you decided: not blind
  read('eu|503|pet hair remover roller', 70, NOW); // opened after you decided: blind
  read('world|pod.test/products/pillow', 40, null);
  read('eu|504|led sunset lamp', 90, null); // undecided: does not count
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  return { env, db };
}

test('ai-eval.mjs on D1: the report from your decisions, saved for the board; in GitHub Actions only counts, even with --details', async () => {
  const { env, db } = await decided();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-eval-'));
  try {
    const summary = path.join(dir, 'summary.md');
    fs.writeFileSync(summary, '');
    const lines = [];
    const r = await main({ argv: ['--details'], env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary }, db, out: (x) => lines.push(x), now: () => NOW });
    assert.deepStrictEqual([r.n, r.approved, r.rejected, r.tp, r.fp, r.fn, r.tn], [4, 2, 2, 1, 1, 1, 1]);
    near(r.accuracy, 0.5, 'two of four agree');
    near(r.kappa, 0, 'no better than chance');
    near(r.auc, 0.75, 'three of four pairs in order');
    assert.deepStrictEqual([r.blind.n, r.seen.n], [3, 1], 'opened after deciding still counts as blind');
    near(r.blind.accuracy, 1 / 3, 'blind agreement');
    assert.deepStrictEqual(r.reasons, [{ side: 'bad', reason: 'saturated', label: 'Saturated', n: 1, mean_fit: 30, ai_saturation_high: 1 }]);
    assert.strictEqual(r.ai_reads, 5);
    const out = lines.join('\n') + fs.readFileSync(summary, 'utf8');
    assert.match(out, /Decisions with an AI read: 4 \(2 approved, 2 rejected\)/);
    assert.match(out, /--details is off in GitHub Actions/);
    assert.match(fs.readFileSync(summary, 'utf8'), /^\*\*AI eval\*\*\n\n- AI read vs your decisions/m);
    for (const t of env.db.prepare('SELECT product_title AS t FROM winners').all().map((x) => x.t).concat('Pod Pillow')) assert.ok(!out.includes(t), `no product name in a public log: ${t}`);
    assert.doesNotMatch(out, /pod\.test|eu\|/);
    const state = JSON.parse(env.db.prepare("SELECT value FROM state WHERE key = 'ai_eval'").get().value);
    assert.strictEqual(state.n, 4);
    assert.strictEqual(state.at, iso(NOW));
    assert.deepStrictEqual(state.misses.approved_low.map((x) => [x.title, x.fit]), [['Pod Pillow', 40]], 'the private D1 keeps which products (the board is behind your PIN)');
    assert.deepStrictEqual(state.misses.rejected_high.map((x) => [x.title, x.fit, x.blind]), [['Pet Hair Remover Roller', 70, true]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // On your own computer: --details lists the products, --json the report.
  const local = [];
  await main({ argv: ['--details'], env: {}, db, out: (x) => local.push(x), now: () => NOW });
  assert.match(local.join('\n'), /You approved, the AI did not:\n {2}fit {2}40 {2}approved {2}Pod Pillow\nYou rejected, the AI liked it:\n {2}fit {2}70 {2}rejected {2}Pet Hair Remover Roller/);
  const json = [];
  await main({ argv: ['--json', '--threshold', '35'], env: {}, db, out: (x) => json.push(x), now: () => NOW });
  const j = JSON.parse(json[0]);
  assert.strictEqual(j.threshold, 35);
  assert.deepStrictEqual([j.tp, j.fp, j.fn, j.tn], [2, 1, 0, 1]);
  assert.strictEqual(j.misses, undefined, 'no product names without --details');
});

test('ai-eval.mjs: no AI reads yet (or no table) is no failure; it says so', async () => {
  const env = await seededEnv();
  env.db.exec('DROP TABLE ai_checks');
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const lines = [];
  const r = await main({ argv: [], env: {}, db, out: (x) => lines.push(x), now: () => NOW });
  assert.strictEqual(r.n, 0);
  assert.match(lines.join('\n'), /no decided product has an AI read yet/);
});
