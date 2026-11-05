/*
 * The Winner Score's backtest: does it rank the products Connor approved above the ones he rejected? It re-runs on its own
 * (the daily job's learn step, every night; a longer report every week) on whatever decisions the board holds.
 *
 *   auc         the chance that a random approved product scores higher than a random rejected one (0.5 = a coin flip)
 *   ci          a 95% bootstrap interval of that AUC (seeded, so a re-run gives the same numbers)
 *   cv          the AUC when Connor's niches are learned without the products being scored (k folds, repeated): the
 *               honest number, since the in-sample AUC lets a decision vote on its own product
 *   holdout     learned on decisions before a day, tested on those after it (out of time)
 *   policy      the same without approvals his current rules forbid (a supplement he approved in October): the score is
 *               built to put those last, so they count against it in the raw AUC
 *   baselines   reach a day (the EU Inbox's base), Jev's product score, each pillar alone, the score without fit
 *
 * Pure: facts and decisions in, numbers out. Decisions are Connor's taste, not sales: a high AUC means the score agrees with
 * him, not that a product sells.
 */
import { scoreProduct, learnNiche, SPEC } from './winner-score.mjs';

/** A seeded random number generator (mulberry32), so every report is reproducible. */
export function rng(seed = 7) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** AUC of [{ s, y }] (ties count half), or null without both classes. O(n log n). */
export function auc(pairs) {
  const p = pairs.filter((x) => x && (x.y === 0 || x.y === 1) && Number.isFinite(x.s));
  const pos = p.filter((x) => x.y === 1).length;
  const neg = p.length - pos;
  if (!pos || !neg) return null;
  const sorted = p.slice().sort((a, b) => a.s - b.s);
  let rankSum = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j].s === sorted[i].s) j++;
    const avg = (i + j + 1) / 2; // ranks i+1..j, averaged
    for (let k = i; k < j; k++) if (sorted[k].y === 1) rankSum += avg;
    i = j;
  }
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** A 95% bootstrap interval of the AUC: [low, high] (null when too few). */
export function aucCi(pairs, { n = 1000, seed = 7 } = {}) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = pairs.map(() => pairs[Math.floor(r() * pairs.length)]);
    const a = auc(s);
    if (a != null) out.push(a);
  }
  if (out.length < n / 2) return null;
  out.sort((a, b) => a - b);
  return [out[Math.floor(0.025 * out.length)], out[Math.min(out.length - 1, Math.floor(0.975 * out.length))]];
}

/** Share of approvals among the top k by score (k ≤ n), and the base rate. */
export function precisionAt(pairs, k) {
  const top = pairs.slice().sort((a, b) => b.s - a.s).slice(0, k);
  return top.length ? top.filter((x) => x.y === 1).length / top.length : null;
}

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const sd = (xs) => {
  const m = mean(xs);
  return xs.length > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)) : null;
};

/** The labelled set: one row per decided product the facts know, { key, y, at, f, cat }. */
export function labelled(facts, decisions) {
  const byKey = new Map(facts.map((f) => [f.key, f]));
  const out = [];
  let missing = 0;
  for (const d of decisions) {
    const f = byKey.get(d.key);
    if (!f) {
      missing++;
      continue;
    }
    out.push({ key: d.key, y: d.y, at: d.at, from: d.from, test: !!d.test, f, cat: (f.jev && f.jev.main) || f.category || 'Other', src: f.src });
  }
  return { rows: out, missing };
}

/** Score the labelled rows with Connor's niches learned from `train` only (null: no learning, the snuggro prior). */
function scored(rows, train, ctx) {
  const niche = train ? learnNiche(train.map((r) => ({ y: r.y, cat: r.cat }))) : null;
  return rows.map((r) => ({ r, out: scoreProduct(r.f, { ...ctx, niche }) }));
}

/** Pairs { s, y } from scored rows, with a value function on the score's output. */
const pairsBy = (list, val) => list.map(({ r, out }) => ({ s: val(out, r), y: r.y, key: r.key, src: r.src })).filter((p) => Number.isFinite(p.s));

/** k folds of the rows, stratified by label, seeded. */
function folds(rows, k, seed) {
  const r = rng(seed);
  const shuffle = (a) => {
    const b = a.slice();
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  };
  const out = Array.from({ length: k }, () => []);
  [...shuffle(rows.filter((x) => x.y === 1)), ...shuffle(rows.filter((x) => x.y === 0))].forEach((x, i) => out[i % k].push(x));
  return out;
}

/** The cross-validated AUC: niches learned on k−1 folds, the k-th scored; repeated with other folds. { mean, sd, runs }. */
export function cvAuc(rows, { k = 5, repeats = 10, seed = 11, ctx = {}, val = (o) => o.score } = {}) {
  const runs = [];
  for (let rep = 0; rep < repeats; rep++) {
    const parts = folds(rows, Math.min(k, rows.length), seed + rep);
    const pairs = [];
    parts.forEach((test, i) => {
      const train = parts.filter((_, j) => j !== i).flat();
      pairs.push(...pairsBy(scored(test, train, ctx), val));
    });
    const a = auc(pairs);
    if (a != null) runs.push(a);
  }
  return { mean: r3(mean(runs)), sd: r3(sd(runs)), runs: runs.length };
}

/** Pillar weights that rank the decisions best under cross-validation, pulled to the spec's own (bounded, see SPEC). */
export function learnWeights(rows, { ctx = {}, step = 0.05, lambda = 0.5, seed = 11, minGain = 0.02 } = {}) {
  const prior = { ...SPEC.weights };
  const keys = Object.keys(prior);
  // Pillars per row once (the niche learned out of fold), then only the weights change.
  const parts = folds(rows, Math.min(5, rows.length), seed);
  const cache = [];
  parts.forEach((test, i) => {
    const train = parts.filter((_, j) => j !== i).flat();
    for (const { r, out } of scored(test, train, ctx)) cache.push({ y: r.y, p: out.pillars, m: out.risk.gate ? 0 : out.risk.mult });
  });
  const value = (w) => {
    const sum = keys.reduce((s, k) => s + w[k], 0) || 1;
    const a = auc(cache.map((c) => ({ y: c.y, s: c.m * keys.reduce((s, k) => s + w[k] * c.p[k], 0) / sum })));
    const dist = keys.reduce((s, k) => s + (w[k] / sum - prior[k]) ** 2, 0);
    return { a, obj: (a || 0) - lambda * dist };
  };
  let best = { ...prior };
  let bestV = value(best);
  const start = bestV.a;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const k of keys) {
      for (const d of [-step, step]) {
        const w = { ...best, [k]: Math.max(0, Math.min(0.6, best[k] + d)) };
        const v = value(w);
        if (v.obj > bestV.obj + 1e-9) {
          best = w;
          bestV = v;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  const sum = keys.reduce((s, k) => s + best[k], 0) || 1;
  const weights = Object.fromEntries(keys.map((k) => [k, Math.round((best[k] / sum) * 100) / 100]));
  const gain = (bestV.a || 0) - (start || 0);
  return { weights, auc: r3(bestV.a), prior_auc: r3(start), gain: r3(gain), adopt: gain >= minGain && rows.length >= 50 };
}

/**
 * The whole report. facts: every product (lib/winner-facts.mjs), decisions: Connor's ({ key, y, at }), opts: { day,
 * cutoff (holdout day), ctx (econ settings, weights) }.
 */
export function backtest(facts, decisions, { day = null, cutoff = null, ctx = {}, bootstrap = 1000, seed = 7, repeats = 10 } = {}) {
  const { rows, missing } = labelled(facts, decisions);
  const base = { ...ctx, day };
  const all = scored(rows, rows, base); // in sample: niches learned on every decision
  const prior = scored(rows, null, base); // no learning at all: the snuggro prior only
  const score = (o) => o.score;
  const inSample = pairsBy(all, score);
  const priorPairs = pairsBy(prior, score);
  const gatedApproved = all.filter(({ r, out }) => r.y === 1 && out.risk.gate).map(({ r, out }) => ({ key: r.key, title: r.f.title, why: out.risk.why }));
  const policyRows = rows.filter((r) => !gatedApproved.some((g) => g.key === r.key));
  const cv = cvAuc(rows, { ctx: base, repeats, seed: seed + 4 });
  const cvPolicy = cvAuc(policyRows, { ctx: base, repeats, seed: seed + 4 });

  // Out of time: niches learned before the cutoff, the rest scored.
  let holdout = null;
  if (cutoff) {
    const train = rows.filter((r) => String(r.at) < cutoff);
    const test = rows.filter((r) => String(r.at) >= cutoff);
    const pairs = pairsBy(scored(test, train, base), score);
    holdout = { cutoff, train: train.length, test: test.length, pos: test.filter((r) => r.y === 1).length, auc: r3(auc(pairs)), ci: (aucCi(pairs, { n: bootstrap, seed }) || []).map(r3) };
  }

  // Baselines and each pillar alone, on the prior scoring (no learning, so nothing leaks).
  const val = {
    'Winner Score (snuggro prior, no learning)': (o) => o.score,
    'Score without fit (market evidence only)': (o) => (o.risk.gate ? 0 : o.pillars.proof * 0.3 + o.pillars.demand * 0.1 + o.pillars.competition * 0.15 + o.pillars.margin * 0.25) * o.risk.mult,
    'Proof pillar': (o) => o.pillars.proof,
    'Demand pillar': (o) => o.pillars.demand,
    'Competition pillar': (o) => o.pillars.competition,
    'Margin pillar': (o) => o.pillars.margin,
    'Fit pillar': (o) => o.pillars.fit,
    'Risk gate and multiplier only': (o) => (o.risk.gate ? 0 : o.risk.mult),
    'EU reach a day (the EU Inbox base)': (o, r) => (r.f.reach_day == null ? NaN : r.f.reach_day),
    "Jev's product score (0-4)": (o, r) => (r.f.jev && r.f.jev.product_score != null ? r.f.jev.product_score : NaN),
  };
  const baselines = Object.entries(val).map(([name, fn]) => {
    const pairs = pairsBy(prior, fn);
    return { name, n: pairs.length, pos: pairs.filter((p) => p.y === 1).length, auc: r3(auc(pairs)), ci: (aucCi(pairs, { n: bootstrap, seed }) || []).map(r3) };
  });
  // Real tests (🧭 Pipeline: scale or kill) on their own: the number that matters once there are some.
  const tests = inSample.filter((p) => rows.find((r) => r.key === p.key && r.test));
  const testsOut = { n: tests.length, scale: tests.filter((p) => p.y === 1).length, auc: r3(auc(tests)) };
  const bySrc = {};
  for (const src of [...new Set(rows.map((r) => r.src))]) {
    const pairs = inSample.filter((p) => p.src === src);
    bySrc[src] = { n: pairs.length, pos: pairs.filter((p) => p.y === 1).length, auc: r3(auc(pairs)) };
  }
  const pos = rows.filter((r) => r.y === 1).length;
  const top = (k) => r3(precisionAt(priorPairs, Math.min(k, priorPairs.length)));
  const weights = learnWeights(policyRows, { ctx: base, seed: seed + 4 });
  const ranks = prior.slice().sort((a, b) => b.out.score - a.out.score).map(({ r, out }, i) => ({ rank: i + 1, key: r.key, y: r.y, score: out.score, gate: out.risk.gate, title: r.f.title, src: r.src, cat: r.cat }));
  return {
    day, n: rows.length, pos, neg: rows.length - pos, missing, spec_version: SPEC && 1,
    auc_prior: r3(auc(priorPairs)), ci_prior: (aucCi(priorPairs, { n: bootstrap, seed }) || []).map(r3),
    auc_in_sample: r3(auc(inSample)), cv, cv_policy: cvPolicy, holdout,
    policy: { removed: gatedApproved.length, approvals_now_out: gatedApproved, n: policyRows.length, auc_prior: r3(auc(pairsBy(prior.filter(({ r }) => policyRows.includes(r)), score))) },
    precision: { base_rate: r3(pos / Math.max(rows.length, 1)), at10: top(10), at20: top(20), at30: top(30) },
    baselines, by_source: bySrc, tests: testsOut, weights, ranks,
  };
}

/** The report as Markdown (plain English, for the research folder and the weekly report). */
export function backtestMd(b, { title = 'Winner Score backtest' } = {}) {
  const ci = (c) => (c && c.length === 2 ? ` (95% ${c[0].toFixed(2)} to ${c[1].toFixed(2)})` : '');
  const f = (x) => (x == null ? 'n/a' : x.toFixed(2));
  const lines = [`# ${title}`, '', `Day: ${b.day || 'n/a'}. Decisions with facts: ${b.n} (${b.pos} approved, ${b.neg} rejected); ${b.missing} decisions had no product in the data.`, '',
    '| Measure | AUC |', '|---|---|',
    `| Winner Score, snuggro prior (no learning) | ${f(b.auc_prior)}${ci(b.ci_prior)} |`,
    `| Winner Score, niches learned, cross-validated (${b.cv.runs} runs) | ${f(b.cv.mean)} ± ${f(b.cv.sd)} |`,
    `| Same, without the ${b.policy.removed} approvals the current rules forbid | ${f(b.cv_policy.mean)} ± ${f(b.cv_policy.sd)} |`,
    `| Winner Score, niches learned on every decision (in sample, flattered) | ${f(b.auc_in_sample)} |`];
  if (b.holdout) lines.push(`| Out of time: learned before ${b.holdout.cutoff}, tested on ${b.holdout.test} later decisions (${b.holdout.pos} approved) | ${f(b.holdout.auc)}${ci(b.holdout.ci)} |`);
  lines.push('', `Precision: of the top 10 by score ${f(b.precision.at10)} were approved, top 20 ${f(b.precision.at20)}, top 30 ${f(b.precision.at30)}; the base rate is ${f(b.precision.base_rate)}.`, '',
    '| Baseline or part (snuggro prior) | n | Approved | AUC |', '|---|---:|---:|---|',
    ...b.baselines.map((x) => `| ${x.name} | ${x.n} | ${x.pos} | ${f(x.auc)}${ci(x.ci)} |`), '',
    b.tests && b.tests.n ? `Real tests (🧭 Pipeline): ${b.tests.n} (${b.tests.scale} scaled), AUC ${f(b.tests.auc)}. A real test outranks a tap on the same product.` : 'Real tests (🧭 Pipeline: scale or kill): none yet. The first ones become the main label.', '',
    `Weights the decisions suggest (cross-validated, pulled to the spec): ${Object.entries(b.weights.weights).map(([k, v]) => `${k} ${v}`).join(', ')}; AUC ${f(b.weights.auc)} against ${f(b.weights.prior_auc)} with the spec's weights (${b.weights.adopt ? 'adopted' : 'not adopted: the gain is under 0.02 or there are fewer than 50 decisions'}).`,
    '', 'Decisions are Connor\'s taste, not sales. An AUC near 0.5 means the score does not follow his choices; 0.7 or more means it mostly does.');
  if (b.policy.approvals_now_out.length) lines.push('', `Approvals the current rules forbid (scored 0 on purpose): ${b.policy.approvals_now_out.map((x) => `${x.title || x.key} (${x.why})`).join('; ')}.`);
  return lines.join('\n') + '\n';
}
