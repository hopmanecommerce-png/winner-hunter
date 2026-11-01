#!/usr/bin/env node
/*
 * How often the AI read agrees with you: its fit (D1 ai_checks, ai-check.mjs) against your approve / reject decisions on
 * the board (D1 hidden, with your reasons from feedback). A fit of --threshold (default 50) or more counts as "approve".
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node winner-hunter/ai-eval.mjs [--threshold 50] [--details] [--json]
 * Prints counts and rates only, safe for a public Actions log. --details (never in GitHub Actions) also lists where you
 * and the AI disagree most, by product. --json prints the report as JSON. The report goes into D1 state 'ai_eval' too,
 * for the board's AI read.
 * The honest test is the blind decisions: made before you opened that product's AI read on the board (or before it
 * existed). A decision after you opened it may have followed it, so those are counted apart.
 * Agreement alone flatters a model when you reject most products ("always reject" scores the share you reject), so the
 * report also gives Cohen's kappa (agreement beyond chance: 0 none, 1 full) and the AUC (does a higher fit go with your
 * approvals: 0.5 a coin, 1 a perfect order).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings } from './lib/d1.mjs';
import { KEY } from './ai-check.mjs';
import { flagsOf } from './worker/src/ai-schema.mjs';
import { REASONS, groupKey } from './worker/src/app.mjs';

export const THRESHOLD = 50;
export const MIN_N = 20; // fewer decisions than this say little
/** Every approve (seen) and reject on the board. keyOf() gives each the product key the AI read uses. */
export const DECISIONS_SQL = `SELECT 'eu' AS src, ${KEY} AS jk, w.product_url, h.ad_id, h.status, h.at, w.product_title AS title FROM hidden h JOIN winners w ON w.ad_id = h.ad_id WHERE h.status IN ('seen', 'rejected')
UNION ALL SELECT 'world', p.product_key, NULL, h.ad_id, h.status, h.at, p.product_title FROM hidden h JOIN world_products p ON p.ad_id = h.ad_id WHERE h.status IN ('seen', 'rejected')`;
/** A decision's product key: 'eu|' + the board's group (product page, else advertiser + title), or 'world|' + its product. */
export const keyOf = (d) => (d.src === 'world' ? 'world|' + d.jk : 'eu|' + groupKey(d));
const AI_SQL = 'SELECT product_key, fit, confidence, verdict, flags, checked_at, opened_at FROM ai_checks WHERE fit IS NOT NULL';
const FEEDBACK_SQL = "SELECT ad_id, action, reasons FROM feedback WHERE action IN ('seen', 'rejected') AND ad_id IS NOT NULL";

const jsonOf = (s, or) => {
  try {
    return JSON.parse(s || '') ?? or;
  } catch (e) {
    return or;
  }
};
const listOf = (s) => {
  const r = jsonOf(s, []);
  return Array.isArray(r) ? r.map(String) : [];
};

/**
 * One pair per decided product with an AI read: { key, title, approved, fit, confidence, blind, scope, reasons,
 * saturation, claims_risk, injection, at }. A product decided twice counts once, by its last decision.
 */
export function pairsOf(decisions, aiRows, feedback = []) {
  const ai = new Map(aiRows.filter((r) => r.fit != null).map((r) => [r.product_key, r]));
  const why = new Map(feedback.map((f) => [f.ad_id, listOf(f.reasons)]));
  const last = new Map();
  for (const d of decisions) {
    const was = last.get(d.k);
    if (!was || String(d.at || '') > String(was.at || '')) last.set(d.k, d);
  }
  const out = [];
  for (const d of last.values()) {
    const a = ai.get(d.k);
    if (!a) continue;
    const v = jsonOf(a.verdict, {});
    out.push({
      key: d.k, title: String(d.title || ''), approved: d.status === 'seen', fit: Number(a.fit), confidence: ['high', 'medium', 'low'].includes(a.confidence) ? a.confidence : 'low',
      blind: !(a.opened_at && d.at && String(a.opened_at) <= String(d.at)), scope: String(d.k).startsWith('world|') ? 'world' : 'eu', reasons: why.get(d.ad_id) || [],
      saturation: v.saturation || '', claims_risk: v.claims_risk || '', injection: flagsOf(a.flags).includes('injection'), at: d.at || '',
    });
  }
  return out;
}

/** The Wilson 95% interval of k out of n, [low, high] (null without data). */
export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** The chance that an approved product has a higher fit than a rejected one (ties count half), or null. */
export function auc(pairs) {
  const xs = pairs.map((p) => [p.fit, p.approved]).sort((a, b) => a[0] - b[0]);
  let pos = 0;
  let neg = 0;
  let ranks = 0;
  for (let i = 0; i < xs.length;) {
    let j = i;
    while (j < xs.length && xs[j][0] === xs[i][0]) j++;
    const rank = (i + 1 + j) / 2; // the average rank of a run of equal fits
    for (let k = i; k < j; k++) (xs[k][1] ? (pos++, (ranks += rank)) : neg++);
    i = j;
  }
  return pos && neg ? (ranks - (pos * (pos + 1)) / 2) / (pos * neg) : null;
}

/** Agreement at one threshold: the counts, accuracy (with its interval), balanced accuracy, Cohen's kappa, precision, recall, AUC. */
export function agreement(pairs, threshold = THRESHOLD) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of pairs) {
    const yes = p.fit >= threshold;
    if (yes && p.approved) tp++;
    else if (yes) fp++;
    else if (p.approved) fn++;
    else tn++;
  }
  const n = pairs.length;
  const pos = tp + fn;
  const neg = fp + tn;
  const accuracy = n ? (tp + tn) / n : null;
  const recall = pos ? tp / pos : null;
  const specificity = neg ? tn / neg : null;
  const chance = n ? ((tp + fp) / n) * (pos / n) + ((fn + tn) / n) * (neg / n) : null;
  return {
    n, threshold, approved: pos, rejected: neg, tp, fp, fn, tn, accuracy, ci: wilson(tp + tn, n),
    balanced: recall != null && specificity != null ? (recall + specificity) / 2 : null,
    kappa: n && chance < 1 ? (accuracy - chance) / (1 - chance) : null,
    precision: tp + fp ? tp / (tp + fp) : null, recall, base: n ? Math.max(pos, neg) / n : null, auc: auc(pairs),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
const brief = (a) => ({ n: a.n, accuracy: a.accuracy, kappa: a.kappa, auc: a.auc });

/** The threshold from 5 to 95 with the best balanced accuracy on these decisions (fitted on them, so optimistic), or null. */
export function bestThreshold(pairs) {
  let best = null;
  for (let t = 5; t <= 95; t += 5) {
    const a = agreement(pairs, t);
    if (a.balanced == null) return null;
    if (!best || a.balanced > best.balanced + 1e-9 || (Math.abs(a.balanced - best.balanced) < 1e-9 && Math.abs(t - THRESHOLD) < Math.abs(best.threshold - THRESHOLD))) best = { threshold: t, balanced: a.balanced };
  }
  return best;
}

/** The whole report: everything as rates and counts, no product names. */
export function report(pairs, { threshold = THRESHOLD } = {}) {
  const sub = (f) => brief(agreement(pairs.filter(f), threshold));
  const reasons = [];
  for (const [side, list] of Object.entries(REASONS)) {
    for (const [k, label] of Object.entries(list)) {
      const hit = pairs.filter((p) => (side === 'bad' ? !p.approved : p.approved) && p.reasons.includes(k));
      if (!hit.length) continue;
      const r = { side, reason: k, label, n: hit.length, mean_fit: mean(hit.map((p) => p.fit)) };
      if (k === 'saturated') r.ai_saturation_high = hit.filter((p) => p.saturation === 'high').length / hit.length;
      reasons.push(r);
    }
  }
  return {
    ...agreement(pairs, threshold),
    blind: sub((p) => p.blind),
    seen: sub((p) => !p.blind),
    by_confidence: Object.fromEntries(['high', 'medium', 'low'].map((c) => [c, sub((p) => p.confidence === c)])),
    by_scope: { world: sub((p) => p.scope === 'world'), eu: sub((p) => p.scope === 'eu') },
    flagged: pairs.filter((p) => p.injection).length,
    fit_mean: { approved: mean(pairs.filter((p) => p.approved).map((p) => p.fit)), rejected: mean(pairs.filter((p) => !p.approved).map((p) => p.fit)) },
    best: bestThreshold(pairs),
    reasons,
  };
}

/** Where you and the AI disagree most: approved with the lowest fit, rejected with the highest. Product names: never for a public log. */
export function misses(pairs, threshold = THRESHOLD, n = 5) {
  const pick = (xs) => xs.slice(0, n).map((p) => ({ key: p.key, title: p.title.slice(0, 120), fit: p.fit, decision: p.approved ? 'approved' : 'rejected', blind: p.blind }));
  return {
    approved_low: pick(pairs.filter((p) => p.approved && p.fit < threshold).sort((a, b) => a.fit - b.fit)),
    rejected_high: pick(pairs.filter((p) => !p.approved && p.fit >= threshold).sort((a, b) => b.fit - a.fit)),
  };
}

const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const dec = (x) => (x == null ? '–' : x.toFixed(2));
const one = (a) => (a.n ? `${a.n} (${pct(a.accuracy)})` : '0');

/** The report as text: counts and rates only. */
export function textOf(r) {
  if (!r.n) return 'AI read vs your decisions: no decided product has an AI read yet. Run the AI check, decide some products, then run this again.';
  const lines = [
    `AI read vs your decisions (a fit of ${r.threshold} or more counts as approve)`,
    `Decisions with an AI read${r.since ? ` since ${r.since}` : ''}: ${r.n} (${r.approved} approved, ${r.rejected} rejected)`,
    `Agreement: ${pct(r.accuracy)}${r.ci ? ` (95% CI ${pct(r.ci[0])}–${pct(r.ci[1])})` : ''}; always picking your most common decision would score ${pct(r.base)}`,
    `Balanced accuracy ${pct(r.balanced)} · Cohen's kappa ${dec(r.kappa)} · AUC ${dec(r.auc)} (0.5 is a coin, 1 a perfect order)`,
    `Blind (decided before opening its AI read): ${r.blind.n} decisions, agreement ${pct(r.blind.accuracy)}, kappa ${dec(r.blind.kappa)}, AUC ${dec(r.blind.auc)}`,
    `After opening its AI read: ${r.seen.n} decisions${r.seen.n ? `, agreement ${pct(r.seen.accuracy)}` : ''}`,
    `By confidence: high ${one(r.by_confidence.high)} · medium ${one(r.by_confidence.medium)} · low ${one(r.by_confidence.low)}`,
    `Outside the EU ${one(r.by_scope.world)} · EU ${one(r.by_scope.eu)}`,
    `Mean fit: approved ${r.fit_mean.approved == null ? '–' : Math.round(r.fit_mean.approved)}, rejected ${r.fit_mean.rejected == null ? '–' : Math.round(r.fit_mean.rejected)}`,
  ];
  if (r.best) lines.push(`Best threshold on these decisions: ${r.best.threshold} (balanced accuracy ${pct(r.best.balanced)}); fitted on the same decisions, so optimistic`);
  if (r.reasons.length) lines.push(`Your reasons and the AI's fit: ${r.reasons.map((x) => `${x.label} ${x.n} (mean fit ${Math.round(x.mean_fit)}${x.ai_saturation_high != null ? `, AI said high saturation ${pct(x.ai_saturation_high)}` : ''})`).join(' · ')}`);
  if (r.flagged) lines.push(`${r.flagged} of these reads flagged an injection attempt in the product data`);
  if (r.n < MIN_N) lines.push(`Too few decisions to judge it yet (fewer than ${MIN_N}): decide more products, then run this again.`);
  return lines.join('\n');
}

/**
 * Reads D1 and builds the report: { report, pairs }. since (YYYY-MM-DD): only decisions from that day on, for example
 * after you cleaned up old approvals (2026-11-01's review found 21 of 36 were restricted or needed sizing).
 */
export async function evaluate(db, { threshold = THRESHOLD, since = '', now = Date.now } = {}) {
  const [rows, ai, fb] = await Promise.all([db.query(DECISIONS_SQL), db.query(AI_SQL).catch(() => []), db.query(FEEDBACK_SQL).catch(() => [])]);
  const decisions = rows.filter((d) => !since || String(d.at || '') >= since).map((d) => ({ ...d, k: keyOf(d) }));
  const pairs = pairsOf(decisions, ai, fb);
  return { report: { at: new Date(now()).toISOString(), since: since || null, ai_reads: ai.length, ...report(pairs, { threshold }) }, pairs };
}

export function argsOf(argv) {
  const a = { threshold: THRESHOLD, details: false, json: false, since: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--details') a.details = true;
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--threshold') a.threshold = Math.min(Math.max(Math.round(Number(argv[++i])) || THRESHOLD, 1), 100);
    else if (argv[i] === '--since') a.since = /^\d{4}-\d{2}-\d{2}$/.test(String(argv[i + 1] || '')) ? argv[++i] : (i++, '');
  }
  return a;
}

/** The CLI. In GitHub Actions --details is refused (the logs of this repository are public). */
export async function main({ argv = process.argv.slice(2), env = process.env, db = null, out = console.log, now = Date.now } = {}) {
  const args = argsOf(argv);
  if (!db) {
    const s = d1Settings(env);
    if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID');
    db = d1Client(s);
  }
  const { report: r, pairs } = await evaluate(db, { threshold: args.threshold, since: args.since, now });
  const details = args.details && env.GITHUB_ACTIONS !== 'true';
  await db.setState('ai_eval', { ...r, misses: misses(pairs, args.threshold) }, new Date(now()));
  if (args.json) out(JSON.stringify(details ? { ...r, misses: misses(pairs, args.threshold) } : r, null, 2));
  else out(textOf(r));
  if (args.details && !details) out('--details is off in GitHub Actions: the logs of this repository are public. Run it on your own computer.');
  else if (details && !args.json) {
    const m = misses(pairs, args.threshold);
    const row = (x) => `  fit ${String(x.fit).padStart(3)}  ${x.decision}${x.blind ? '' : ' (after opening the AI read)'}  ${x.title || x.key}`;
    out(['', 'You approved, the AI did not:', ...m.approved_low.map(row), 'You rejected, the AI liked it:', ...m.rejected_high.map(row)].join('\n'));
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n**AI eval**\n\n${textOf(r).split('\n').map((l) => `- ${l}`).join('\n')}\n`);
  return r;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::${String(e.message || e).slice(0, 300)}`);
    process.exit(1);
  });
}
