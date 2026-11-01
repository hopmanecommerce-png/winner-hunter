#!/usr/bin/env node
/*
 * Groups the collected posts and comments into problems (lib/problem-cluster.mjs) and writes them to D1 for the board's
 * Problems tab. Costs nothing: no credits. The optional Claude step (lib/problem-llm.mjs) names and merges problems
 * when ANTHROPIC_API_KEY is set and PROBLEM_LLM is not off, at most PROBLEM_LLM_MAX_USD per run.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node winner-hunter/problems-process.mjs
 * Settings (env): PROBLEM_DRY_RUN=1 works it all out and writes nothing. PROBLEM_LLM=off: no Claude even with a key.
 * PROBLEM_LLM_MODEL (default claude-opus-5-5; claude-haiku-5-5 costs about a fortieth), PROBLEM_LLM_MAX_USD (default
 * 0.50), PROBLEM_LLM_MAX_CALLS (8). PROBLEM_MIN_MENTIONS (2): smaller groups are no problem yet. PROBLEM_WINDOW_DAYS (400):
 * older posts are left out. PROBLEM_SIMILARITY (0.3): how alike two complaints must be to be one problem.
 * The log holds counts only, never a quote: this repository's Actions logs are public.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings } from './lib/d1.mjs';
import { areaLabels, loadBank } from './lib/problem-bank.mjs';
import { mergedProblem, processMentions } from './lib/problem-cluster.mjs';
import { deactivateProblems, readMentions, readProblems, saveProblems, setMentionFields } from './lib/problem-db.mjs';
import { LLM_DEFAULTS, nameProblems } from './lib/problem-llm.mjs';

const DAY = 864e5;
const numOr = (x, or, min, max) => {
  const n = Number(x);
  return x == null || x === '' || !Number.isFinite(n) ? or : Math.min(max, Math.max(min, n));
};

/** The settings of a run, from the environment. */
export function settingsOf(env = process.env) {
  return {
    dryRun: /^(1|true|yes)$/i.test(String(env.PROBLEM_DRY_RUN || '')),
    sample: /^(1|true|yes)$/i.test(String(env.PROBLEM_SAMPLE || '')),
    minMentions: numOr(env.PROBLEM_MIN_MENTIONS, 2, 1, 50),
    windowDays: numOr(env.PROBLEM_WINDOW_DAYS, 400, 30, 3650),
    threshold: numOr(env.PROBLEM_SIMILARITY, 0.3, 0.1, 0.9),
    llm: String(env.PROBLEM_LLM || '').toLowerCase() !== 'off' && !!String(env.ANTHROPIC_API_KEY || '').trim(),
    llmModel: String(env.PROBLEM_LLM_MODEL || '').trim() || LLM_DEFAULTS.model,
    llmMaxUsd: numOr(env.PROBLEM_LLM_MAX_USD, LLM_DEFAULTS.maxUsd, 0, 20),
    llmMaxCalls: numOr(env.PROBLEM_LLM_MAX_CALLS, LLM_DEFAULTS.maxCalls, 0, 100),
  };
}

const jsonOr = (s, or) => {
  try {
    return JSON.parse(s || '') ?? or;
  } catch (e) {
    return or;
  }
};

/**
 * One processing run. db: lib/d1.mjs client. client: the Anthropic SDK client, or null (no Claude). Returns the
 * summary (also saved in state 'problem_process' for the board, unless dry run).
 */
export async function processRun({ db, bank = loadBank(), now = Date.now(), settings = settingsOf({}), client = null, log = console.log } = {}) {
  const s = settings;
  const started = new Date(now).toISOString();
  const rows = await readMentions(db, { since: new Date(now - s.windowDays * DAY).toISOString(), sample: s.sample });
  const out = processMentions(rows, { bank, now, minMentions: s.minMentions, threshold: s.threshold });
  const labels = areaLabels(bank);
  let llm = { used: false, stopped: s.llm ? '' : 'off' };
  if (s.llm && client && out.problems.length) {
    const storedRows = await readProblems(db, s.sample);
    const stored = new Map(storedRows.map((r) => [r.id, { ...r, flags: jsonOr(r.flags, []) }]));
    llm = await nameProblems(out.problems, { client, model: s.llmModel, maxUsd: s.llmMaxUsd, maxCalls: s.llmMaxCalls, labels, stored, log: (m) => log(m) });
    applyClaude(out, llm);
  } else if (s.llm && !client) llm = { used: false, stopped: 'the Anthropic SDK is not installed (npm install @anthropic-ai/sdk)' };
  const problems = out.problems;
  const before = new Map(rows.map((r) => [r.id, r]));
  const changed = out.fields.filter((f) => {
    const r = before.get(f.id);
    return !r || r.lang !== f.lang || r.country !== f.country || Number(r.relevant) !== f.relevant || (r.problem_id || null) !== f.problem_id;
  });
  const summary = {
    status: 'done', started_at: started, finished_at: '', dry_run: s.dryRun, sample: s.sample, ...out.stats, problems: problems.length,
    mentions_changed: changed.length, areas: labels, min_mentions: s.minMentions,
    llm: { used: !!llm.used, model: llm.used ? llm.model : '', calls: llm.calls || 0, usd: llm.usd || 0, named: llm.named || 0, cached: llm.cached || 0, merged: llm.merged || 0,
      rejected: llm.rejected || 0, refused: llm.refused || 0, failed: llm.failed || 0, stopped: llm.stopped || '' },
  };
  if (!s.dryRun) {
    await saveProblems(db, problems, now);
    await deactivateProblems(db, problems.map((p) => p.id), s.sample, now);
    await setMentionFields(db, changed);
  }
  summary.finished_at = new Date(now).toISOString();
  if (!s.dryRun) await db.setState('problem_process', summary, now);
  log(`Problems: ${problems.length} from ${out.stats.relevant} relevant of ${out.stats.mentions} mentions (${out.stats.copies} copies counted once), ${changed.length} mentions updated${s.dryRun ? ' (dry run: nothing written)' : ''}`);
  if (llm.used) log(`Claude (${llm.model}): ${llm.calls} calls, $${llm.usd}, ${llm.named} named, ${llm.cached} names kept, ${summary.llm.merged} merged${llm.stopped ? `, stopped: ${llm.stopped}` : ''}`);
  else if (s.llm) log(`Claude step skipped: ${llm.stopped}`);
  return summary;
}

/** Claude's names on the problems, and its "same problem" groups merged (the biggest keeps its id). */
export function applyClaude(out, llm) {
  const byId = new Map(out.problems.map((p) => [p.id, p]));
  let merged = 0;
  for (const ids of llm.same || []) {
    const ps = ids.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => b.mentions - a.mentions || (a.id < b.id ? -1 : 1));
    if (ps.length < 2) continue;
    const keep = ps[0];
    const m = mergedProblem(ps.flatMap((p) => p.member_ids), out);
    Object.assign(m, { id: keep.id });
    for (const p of ps.slice(1)) byId.delete(p.id);
    byId.set(keep.id, m);
    merged += ps.length - 1;
  }
  out.problems = [...byId.values()];
  for (const p of out.problems) {
    const n = llm.names && llm.names.get(p.id);
    if (!n) continue;
    p.title = n.title;
    p.statement = n.statement;
    p.named_by = `claude:${n.model}`;
    p.flags = n.noise ? ['noise'] : [];
  }
  // Mentions follow their problem into the merged one.
  const of = new Map();
  for (const p of out.problems) for (const id of p.member_ids) of.set(id, p.id);
  for (const f of out.fields) if (f.problem_id && !byId.has(f.problem_id)) f.problem_id = of.get(f.id) || null;
  llm.merged = merged;
}

async function claudeClient(env) {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic({ apiKey: String(env.ANTHROPIC_API_KEY).trim(), maxRetries: 2, timeout: 120000 });
  } catch (e) {
    return null;
  }
}

export async function main({ env = process.env, log = console.log } = {}) {
  const d1 = d1Settings(env);
  if (!d1) throw Object.assign(new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)'), { settings: true });
  const settings = settingsOf(env);
  const client = settings.llm ? await claudeClient(env) : null;
  return processRun({ db: d1Client(d1), settings, client, log });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::Problem processing failed: ${e.message}`);
    process.exitCode = 1;
  });
}
