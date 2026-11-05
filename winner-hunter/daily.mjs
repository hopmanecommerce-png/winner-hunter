#!/usr/bin/env node
/*
 * Today's winners, once a day (daily-winners.yml, about 06:00 Asia/Bangkok, after the night's hunts and momentum): 5 to 10
 * products with everything prepared, so Connor's only step is a tap on the board.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… [TYPESAFE_API_KEY=…] [SCRAPECREATORS_API_KEY=…] node winner-hunter/daily.mjs [--force] [--day YYYY-MM-DD]
 *   node winner-hunter/daily.mjs --local copy.sqlite [--tiktok-csv export.csv] [--out ~/winner-daily] [--board https://…] [--force]
 *
 *   1 collect   the board's tables (EU, outside the EU, TikTok, store signals, Jev, momentum, decisions, your prices)
 *   2 score     the Winner Score on every product (lib/winner-score.mjs), Connor's niches learned from his decisions
 *   3 select    the day's 5 to 10 by the rules in lib/daily-picks.mjs (bar, dedupe, rotation); fewer when fewer pass
 *   4 prepare   per pick: the audience card (wh-audience) and the product sheet (wh-validate), each with its own timeout
 *               and the day's budget; a step that fails or is missing leaves that part of the card "not prepared"
 *   5 publish   D1 daily_picks, daily_runs (with the digest), winner_scores (the history); with --out also YYYY-MM-DD.md,
 *               latest.md and YYYY-MM-DD.csv in that folder
 *   6 learn     the backtest on every decision (lib/score-backtest.mjs): its AUC kept per day (score_backtests), a full
 *               report on Mondays, and new weights only when they rank the decisions clearly better (state winner_weights)
 *
 * Safe to run again: a day that is done is left alone unless --force (decided picks are always kept). Only collect, score
 * and select can fail the run; the digest then says where. The Actions log gets counts only (the repository is public).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings, migrate } from './lib/d1.mjs';
import { tablesFrom, factsFrom, localDb } from './lib/winner-facts.mjs';
import { scoreAll, learnNiche, SPEC, VERSION } from './lib/winner-score.mjs';
import { selectDaily, RULES } from './lib/daily-picks.mjs';
import { digestMd, digestCsv, bangkokDay, withBoard } from './lib/daily-digest.mjs';
import { backtest, backtestMd } from './lib/score-backtest.mjs';
import { splitMap } from './lib/momentum.mjs';
import { parseCsv } from './lib/csv.mjs';

const MIN = 60e3;
// What each stage may take before the run moves on (collect, score and select fail the run; the others only their part).
export const LIMITS = { collect: 8 * MIN, score: 4 * MIN, select: 1 * MIN, prepare: 12 * MIN, step: 90e3, publish: 3 * MIN, learn: 4 * MIN };
export const HISTORY_TOP = 1500; // products whose score is kept per day (plus every pick)
export const CANDIDATES = 25; // candidates prepared in order until 10 picks pass their product sheet
const DAY_MS = 864e5;

const RUN_SQL = 'SELECT day, status, finished_at FROM daily_runs WHERE day = ?1';
const SHOWN_SQL = 'SELECT day, product_key, data, decision FROM daily_picks WHERE day >= ?1 ORDER BY day';
export const START_SQL = `INSERT INTO daily_runs (day, status, started_at, updated_at) VALUES (?1, 'running', ?2, ?2)
ON CONFLICT(day) DO UPDATE SET status = 'running', started_at = excluded.started_at, finished_at = NULL, error = NULL, updated_at = excluded.updated_at`;
export const RUN_SAVE_SQL = `UPDATE daily_runs SET status = ?2, finished_at = ?3, picks = ?4, pool = ?5, summary = ?6, digest_md = ?7, digest_csv = ?8, error = ?9, updated_at = ?3 WHERE day = ?1`;
export const PICKS_SQL = `INSERT INTO daily_picks (day, product_key, rank, id, score, level, title, data)
SELECT ?1, json_extract(value, '$.key'), json_extract(value, '$.rank'), json_extract(value, '$.id'), json_extract(value, '$.score'), json_extract(value, '$.level'),
  json_extract(value, '$.title'), json_extract(value, '$.data') FROM json_each(?2) WHERE true
ON CONFLICT(day, product_key) DO UPDATE SET rank = excluded.rank, id = excluded.id, score = excluded.score, level = excluded.level, title = excluded.title, data = excluded.data`;
// A forced re-run: picks of the day that are no longer picked go, unless Connor already decided on them.
export const STALE_PICKS_SQL = `DELETE FROM daily_picks WHERE day = ?1 AND decision IS NULL AND product_key NOT IN (SELECT value FROM json_each(?2))`;
export const SCORES_SQL = `INSERT INTO winner_scores (day, part, body, updated_at)
SELECT ?1, json_extract(value, '$.part'), json_extract(value, '$.body'), ?2 FROM json_each(?3) WHERE true
ON CONFLICT(day, part) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`;
export const SCORES_STALE_SQL = 'DELETE FROM winner_scores WHERE day = ?1 AND part >= ?2';
export const BACKTEST_SQL = `INSERT INTO score_backtests (day, n, pos, auc, cv, weights, report, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(day) DO UPDATE SET n = excluded.n, pos = excluded.pos, auc = excluded.auc, cv = excluded.cv, weights = excluded.weights, report = COALESCE(excluded.report, score_backtests.report), updated_at = excluded.updated_at`;
const STATE_SQL = "SELECT key, value FROM state WHERE key IN ('winner_weights', 'daily_budget')";
const SET_STATE_SQL = 'INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';
export const CACHE_GET_SQL = 'SELECT body FROM daily_cache WHERE key = ?1 AND (until IS NULL OR until >= ?2)';
export const CACHE_PUT_SQL = `INSERT INTO daily_cache (key, body, until, updated_at) VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(key) DO UPDATE SET body = excluded.body, until = excluded.until, updated_at = excluded.updated_at`;

const jsonOf = (s, or = null) => {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' ? v : or;
  } catch {
    return or;
  }
};

/** Runs fn with a time limit: { ok, ms, value | error }. A stage that runs out of time is not waited for. */
export async function stage(name, ms, fn, log = []) {
  const t0 = Date.now();
  let timer;
  const ctrl = new AbortController();
  try {
    const value = await Promise.race([fn(ctrl.signal), new Promise((_, no) => { timer = setTimeout(() => { ctrl.abort(); no(new Error(`${name} took longer than ${Math.round(ms / 1000)} s`)); }, ms); })]);
    log.push({ stage: name, ok: true, ms: Date.now() - t0 });
    return { ok: true, value };
  } catch (e) {
    log.push({ stage: name, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 300) });
    return { ok: false, error: e };
  } finally {
    clearTimeout(timer);
  }
}

/** The batch steps of the other streams, if their modules are there: { audience, sheet } (each null when missing). */
export async function loadSteps(base = path.dirname(fileURLToPath(import.meta.url))) {
  const tryImport = async (rel, names) => {
    const file = path.join(base, rel);
    if (!fs.existsSync(file)) return null;
    try {
      const m = await import(file);
      for (const n of names) if (typeof m[n] === 'function') return m[n];
    } catch (e) {
      return null;
    }
    return null;
  };
  return {
    audience: await tryImport('lib/audience.mjs', ['audienceCard']),
    sheet: (await tryImport('lib/validate.mjs', ['productSheet'])) || (await tryImport('worker/src/validate.mjs', ['productSheet'])),
  };
}

/** A D1-backed cache for the batch steps ({ get, put }), shared across days. */
const cacheOf = (db, now) => ({
  async get(key) {
    const rows = await db.query(CACHE_GET_SQL, [String(key), new Date(now).toISOString()]);
    return rows.length ? jsonOf(rows[0].body, null) : null;
  },
  async put(key, value, days = 30) {
    await db.query(CACHE_PUT_SQL, [String(key), JSON.stringify(value), new Date(now + days * DAY_MS).toISOString(), new Date(now).toISOString()]);
  },
});

/** The compact daily history of a score: [score, level, proof, demand, competition, margin, fit]. */
const histRow = (s) => [s.score, s.level, s.pillars.proof, s.pillars.demand, s.pillars.competition, s.pillars.margin, s.pillars.fit];

/** A pick as it is saved and shown: the scored product without the bulky parts, plus its card and sheet. */
export function pickOut(p) {
  const { evidence, ...rest } = p;
  return { ...rest, evidence: (evidence || []).slice(0, 16) };
}

/**
 * One daily run. db: query(sql, params) → rows (lib/d1.mjs, or localDb on a copy). Returns the run's record; never
 * throws for a stage that fails (the record says which).
 */
export async function runDaily({ db, env = {}, now = Date.now(), day = null, force = false, tiktokRows = null, steps = null, out = '', board = '', dry = false, write = true } = {}) {
  const today = day || bangkokDay(now);
  const iso = new Date(now).toISOString();
  const log = [];
  const budget = { credits: Number(env.DAILY_CREDITS || 200), jevUsd: Number(env.DAILY_JEV_USD || 0.5), spent: { credits: 0, jevUsd: 0 } };
  const save = !dry && write;
  const rec = { day: today, status: 'running', started_at: iso, stages: log, counts: {}, version: VERSION };

  // ---- 0. Done already? Then leave it (a second trigger, the fallback schedule).
  if (!force) {
    const done = await db.query(RUN_SQL, [today]).catch(() => []);
    if (done.length && (done[0].status === 'ok' || done[0].status === 'short')) return { ...rec, status: done[0].status, skipped: true };
  }
  if (save) await db.query(START_SQL, [today, iso]);

  // ---- 1. Collect.
  const c = await stage('collect', LIMITS.collect, async () => {
    const t = await tablesFrom(db, { tiktok: !tiktokRows });
    const shown = await db.query(SHOWN_SQL, [new Date(Date.parse(today + 'T00:00:00Z') - 30 * DAY_MS).toISOString().slice(0, 10)]).catch(() => []);
    const st = await db.query(STATE_SQL).catch(() => []);
    return { t, shown, state: Object.fromEntries(st.map((r) => [r.key, jsonOf(r.value, null)])) };
  }, log);
  if (!c.ok) return finish(db, rec, { failed: { stage: 'collect', error: String(c.error.message || c.error) }, save, out, board, now });
  const { t, shown: shownRows, state } = c.value;
  const built = factsFrom(t, { tiktokRows });
  // Decisions on earlier picks (the Today tab) count as decisions too.
  const pickDecided = shownRows.filter((r) => r.decision).map((r) => ({ key: r.product_key, y: r.decision === 'reject' ? 0 : 1, at: r.day, from: 'today:' + r.decision }));
  const decisions = [...built.decisions.filter((d) => !pickDecided.some((x) => x.key === d.key)), ...pickDecided];
  const decided = new Set([...built.decided, ...pickDecided.map((d) => d.key)]);
  rec.counts = { eu: built.eu.length, world: built.world.length, tiktok: built.tiktok.length, decisions: decisions.length };

  // ---- 2. Score.
  const weights = state.winner_weights && state.winner_weights.weights ? state.winner_weights.weights : null;
  const s = await stage('score', LIMITS.score, async () => {
    const cats = new Map(built.facts.map((f) => [f.key, (f.jev && f.jev.main) || f.category || 'Other']));
    const niche = learnNiche(decisions.map((d) => ({ y: d.y, cat: cats.get(d.key) || 'Other' })));
    return { ...scoreAll(built.facts, { day: today, niche, weights, econSettings: t.econSettings }), niche };
  }, log);
  if (!s.ok) return finish(db, rec, { failed: { stage: 'score', error: String(s.error.message || s.error) }, save, out, board, now });
  const { ranked, gated } = s.value;
  rec.counts.ranked = ranked.length;
  rec.counts.gated = gated.length;

  // ---- 3. Select.
  const shown = new Map();
  let lastDay = '';
  const yesterday = new Set();
  for (const r of shownRows) if (r.day < today) { shown.set(r.product_key, r.day); lastDay = r.day > lastDay ? r.day : lastDay; }
  for (const r of shownRows) if (r.day === lastDay) { const d = jsonOf(r.data, {}); if (d.category) yesterday.add(d.category); }
  // Candidates: the day's rules with room for more than 10, so a pick the product sheet turns red is replaced, not padded.
  const sel = await stage('select', LIMITS.select, async () => selectDaily(ranked, { day: today, decided, shown, yesterday, rules: { ...RULES, max: CANDIDATES } }), log);
  if (!sel.ok) return finish(db, rec, { failed: { stage: 'select', error: String(sel.error.message || sel.error) }, save, out, board, now });
  const chosen = sel.value;
  rec.counts.passed = chosen.passed;
  rec.counts.candidates = chosen.picks.length;
  rec.passed_over = chosen.skipped;

  // ---- 4. Prepare. First the product sheet of each candidate in order (cheap, no credits): its margin per market with real
  // weights and shipping is the last gate (red, or a break-even CPA under the bar, is out). Then the audience card of the
  // picks that stay (the step that spends credits), each step on its own clock.
  const st = steps || (await loadSteps());
  const prep = { audience: 0, sheet: 0, failed: 0, dropped: [], missing: [] };
  if (!st.audience) prep.missing.push('audience step not installed');
  if (!st.sheet) prep.missing.push('product sheet step not installed');
  const kept = [];
  await stage('prepare', LIMITS.prepare, async (signal) => {
    const cache = cacheOf(db, now);
    // ctx.db: read-only lookups, called as db(sql, params) or db.query(sql, params) (both work).
    const read = (q, a) => (/^\s*(SELECT|WITH)\b/i.test(String(q)) ? db.query(q, a) : Promise.reject(new Error('ctx.db is read-only')));
    read.query = read;
    const ctx = { now: iso, day: today, budget, cache, env, fetch: globalThis.fetch, db: read };
    const run = async (k, fn, p) => {
      const r = await stage(`${k}:${p.key}`, LIMITS.step, (sig) => fn(p, { ...ctx, signal: sig }), []);
      if (r.ok && r.value) { p[k] = r.value; prep[k]++; return r.value; }
      prep.failed++;
      return null;
    };
    for (const p of chosen.picks) {
      if (signal.aborted || kept.length >= RULES.max) break;
      const sh = st.sheet ? await run('sheet', st.sheet, p) : null;
      const cpa = sh && Number.isFinite(Number(sh.breakeven_cpa_eur)) ? Number(sh.breakeven_cpa_eur) : null;
      // The sheet's link check: a product page that does not open (a 404, a closed store) is out; an unknown answer stays.
      const page = sh && sh.sheet && Array.isArray(sh.sheet.links) ? sh.sheet.links.find((l) => /^product page$/i.test(l.label || '')) : null;
      if (sh && (sh.level === 'red' || (cpa != null && cpa < RULES.minCpa) || (page && page.ok === false))) {
        prep.dropped.push({ key: p.key, why: page && page.ok === false ? `product page does not open (${page.status})` : sh.level === 'red' ? 'product sheet: red' : `product sheet: break-even CPA €${Math.round(cpa)}` });
        continue;
      }
      kept.push(p);
    }
    for (const p of kept) {
      if (signal.aborted) break;
      if (!st.audience) break;
      const a = await run('audience', st.audience, p);
      if (a && Number.isFinite(Number(a.credits_used))) budget.spent.credits += Number(a.credits_used);
      budget.credits = Math.max(0, Number(env.DAILY_CREDITS || 200) - budget.spent.credits);
    }
  }, log);
  // A prepare stage that ran out of time keeps the candidates it had not reached yet, in order, up to 10.
  for (const p of chosen.picks) if (kept.length < RULES.max && !kept.includes(p) && !prep.dropped.some((d) => d.key === p.key) && !p.sheet) kept.push(p);
  kept.sort((a, b) => b.score - a.score || b.level - a.level || (a.key < b.key ? -1 : 1));
  kept.forEach((p, i) => { p.pick = i + 1; });
  rec.prepare = prep;
  rec.budget = budget.spent;
  const shortfall = kept.length < RULES.min;
  const message = kept.length === 0 ? 'No product passed the quality bar today.'
    : shortfall ? `Only ${kept.length} product${kept.length === 1 ? '' : 's'} passed the quality bar today (the bar is never lowered to fill the list).` : '';

  // ---- 5. Publish.
  const picks = kept.map(pickOut);
  const pub = await stage('publish', LIMITS.publish, async () => {
    if (save) {
      const rows = picks.map((p) => ({ key: p.key, rank: p.pick, id: p.id, score: p.score, level: p.level, title: p.name, data: JSON.stringify(p) }));
      for (const row of rows) await db.query(PICKS_SQL, [today, JSON.stringify([row])]); // one pick a query: a card and a sheet can be 60 KB
      await db.query(STALE_PICKS_SQL, [today, JSON.stringify(picks.map((p) => p.key))]);
      const hist = new Map(ranked.slice(0, HISTORY_TOP).map((x) => [x.key, histRow(x)]));
      for (const p of kept) hist.set(p.key, histRow(p));
      const parts = splitMap(hist, 400000).map((body, i) => ({ part: i, body: JSON.stringify(body) }));
      for (const part of parts) await db.query(SCORES_SQL, [today, iso, JSON.stringify([part])]);
      await db.query(SCORES_STALE_SQL, [today, parts.length]);
    }
  }, log);
  if (!pub.ok) rec.publish_error = String(pub.error.message || pub.error);

  // ---- 6. Learn: the backtest on every decision, its AUC per day, new weights only when clearly better.
  await stage('learn', LIMITS.learn, async () => {
    const b = backtest(built.facts, decisions, { day: today, ctx: { weights, econSettings: t.econSettings }, bootstrap: 300, repeats: 5 });
    const weekly = new Date(today + 'T12:00:00Z').getUTCDay() === 1 || force;
    rec.backtest = { n: b.n, pos: b.pos, auc: b.auc_prior, cv: b.cv_policy.mean, suggested: b.weights.weights, adopt: b.weights.adopt };
    if (save) {
      await db.query(BACKTEST_SQL, [today, b.n, b.pos, b.auc_prior, b.cv_policy.mean, JSON.stringify({ used: weights || SPEC.weights, suggested: b.weights }),
        weekly ? backtestMd(b, { title: `Winner Score backtest, week of ${today}` }) : null, iso]);
      if (b.weights.adopt) await db.query(SET_STATE_SQL, ['winner_weights', JSON.stringify({ weights: b.weights.weights, day: today, auc: b.weights.auc, prior_auc: b.weights.prior_auc, n: b.n }), iso]);
    }
  }, log);

  return finish(db, rec, { picks, message, shortfall, save, out, board, now, pool: ranked.length + gated.length });
}

/** The end of a run: its record and digest in D1 (and on disk with --out). */
async function finish(db, rec, { picks = [], message = '', shortfall = false, failed = null, save, out, board, now, pool = 0 }) {
  const iso = new Date(now).toISOString();
  rec.status = failed ? 'failed' : shortfall ? 'short' : 'ok';
  rec.finished_at = iso;
  rec.picks = picks.length;
  const asOf = new Date(now + 7 * 3600e3).toISOString().slice(11, 16) + ' ICT';
  const md = digestMd({ day: rec.day, picks, message: failed ? '' : message, failed, asOf });
  const csv = digestCsv({ day: rec.day, picks });
  rec.digest_md = md;
  if (save) {
    const summary = JSON.stringify({ stages: rec.stages, counts: rec.counts, passed_over: rec.passed_over || {}, prepare: rec.prepare || null, budget: rec.budget || null, backtest: rec.backtest || null, version: rec.version, rules: RULES });
    await db.query(RUN_SAVE_SQL, [rec.day, rec.status, iso, picks.length, pool, summary, md, csv, failed ? `${failed.stage}: ${failed.error}`.slice(0, 500) : null]).catch((e) => {
      rec.save_error = String(e.message || e);
    });
  }
  if (out) writeDigest(out, rec.day, md, csv, board);
  return rec;
}

/** YYYY-MM-DD.md, YYYY-MM-DD.csv and latest.md in dir, each written to a temporary file first, then renamed. */
export function writeDigest(dir, day, md, csv, board = '') {
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, text) => {
    const file = path.join(dir, name);
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  };
  const text = withBoard(md, board);
  put(`${day}.md`, text);
  if (csv != null) put(`${day}.csv`, withBoard(csv, board));
  put('latest.md', text);
  return path.join(dir, 'latest.md');
}

// ---------------------------------------------------------------------------
// From the command line (the workflow, or by hand on a local copy)
// ---------------------------------------------------------------------------
function argsOf(argv) {
  const a = { force: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--force') a.force = true;
    else if (k === '--dry') a.dry = true;
    else if (k === '--local') a.local = v();
    else if (k === '--tiktok-csv') a.tiktokCsv = v();
    else if (k === '--out') a.out = v();
    else if (k === '--board') a.board = v();
    else if (k === '--day') a.day = v();
    else if (k === '--now') a.now = Date.parse(v());
    else if (k === '--migrate') a.migrate = true;
  }
  return a;
}

async function main() {
  const env = process.env;
  const a = argsOf(process.argv.slice(2));
  let db;
  if (a.local) {
    const { DatabaseSync } = await import('node:sqlite');
    const sq = new DatabaseSync(a.local);
    db = { query: async (sql, params = []) => { const st = sq.prepare(sql); return /^\s*(SELECT|WITH)/i.test(sql) ? st.all(...params).map((r) => ({ ...r })) : (st.run(...params), []); } };
  } else {
    const s = d1Settings(env);
    if (!s) {
      console.error('daily: CF_API_TOKEN and CF_ACCOUNT_ID are needed (or --local <sqlite copy>)');
      process.exitCode = 1;
      return;
    }
    db = d1Client(s);
  }
  if (a.migrate || !a.local) {
    const dir = new URL('./worker/migrations/', import.meta.url);
    const files = fs.readdirSync(dir).filter((f) => /^0090_daily_winners\.sql$/.test(f));
    await migrate(db, files.map((f) => fs.readFileSync(new URL(f, dir), 'utf8')));
  }
  const tiktokRows = a.tiktokCsv ? parseCsv(fs.readFileSync(a.tiktokCsv, 'utf8')) : null;
  // The workflow passes its inputs through the environment (never into the script's text): a day must look like one.
  const day = a.day || (/^\d{4}-\d{2}-\d{2}$/.test(env.DAILY_DAY || '') ? env.DAILY_DAY : null);
  const force = a.force || env.DAILY_FORCE === 'true';
  const rec = await runDaily({ db, env, now: a.now || Date.now(), day, force, dry: a.dry, tiktokRows, out: a.out || env.DAILY_OUT || '', board: a.board || env.WH_BOARD_URL || '' });
  // Counts only: the Actions log of a public repository is public.
  const line = rec.skipped ? `Today's winners ${rec.day}: already done (${rec.status}), nothing changed.`
    : `Today's winners ${rec.day}: ${rec.status}, ${rec.picks} picks from ${rec.counts.ranked ?? 0} scored products (${rec.counts.passed ?? 0} passed the bar); stages ${rec.stages.map((x) => `${x.stage} ${x.ok ? 'ok' : 'failed'} ${Math.round(x.ms / 1000)}s`).join(', ')}.`;
  console.log(line);
  if (rec.backtest) console.log(`Backtest: ${rec.backtest.n} decisions, AUC ${rec.backtest.auc}, cross-validated ${rec.backtest.cv}${rec.backtest.adopt ? ', new weights adopted' : ''}.`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n**${line}**\n`);
  if (rec.status === 'failed' || rec.save_error) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
