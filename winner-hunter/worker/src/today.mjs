/*
 * Today's winners on the board: the daily picks of daily.mjs (D1 daily_picks, daily_runs), the first screen.
 *   GET  /api/today?day=YYYY-MM-DD        { ready, day, days, run, banner, picks }: the newest day unless one is asked for
 *   POST /api/today { day, key, decision: 'keep' | 'reject' | 'launch' | null, reason }   Connor's tap on a pick
 *   GET  /api/today/digest?day=&format=md|csv   the day's digest as a file, with this board's address in its links
 * A tap here marks the pick (daily_picks.decision); the board's own decision (✓ / ✗ on the product, the TikTok tab, a
 * launch card) is sent by the page through the endpoints it already uses, so every part of the board agrees and the
 * score's learning sees it. Reads are a few rows (the day's picks, 14 days of runs). All SQL is parameterized.
 * app.mjs checks the PIN cookie, the origin and the JSON before any of this runs.
 */

export const DECISIONS = ['keep', 'reject', 'launch'];
export const REASONS = ['wow', 'my niche', 'good margin', 'easy to ship', 'not my niche', 'too expensive', 'hard to source', 'brand or copy risk', 'claims or rules', 'sizes or returns', 'seen it before', 'other'];
const DAYS_SQL = 'SELECT day, status, picks, pool, started_at, finished_at, error FROM daily_runs ORDER BY day DESC LIMIT 14';
const RUN_SQL = 'SELECT day, status, picks, pool, started_at, finished_at, summary, error FROM daily_runs WHERE day = ?1';
const PICKS_SQL = 'SELECT day, product_key, rank, id, score, level, title, data, decision, reason, decided_at FROM daily_picks WHERE day = ?1 ORDER BY rank';
const DIGEST_SQL = 'SELECT day, digest_md, digest_csv FROM daily_runs WHERE day = ?1';
const DECIDE_SQL = 'UPDATE daily_picks SET decision = ?3, reason = ?4, decided_at = ?5 WHERE day = ?1 AND product_key = ?2';

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
/** The day in Asia/Bangkok (UTC+7, no daylight saving). */
export const bangkokDay = (t) => new Date(Number(t) + 7 * 3600e3).toISOString().slice(0, 10);
const jsonOf = (s, or) => {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' ? v : or;
  } catch (e) {
    return or;
  }
};
const missing = (e) => /no such table/i.test(String(e && e.message));

/**
 * The line above the cards: red when today's run failed, has not run by 07:00 in Bangkok or is still running late;
 * amber when it found fewer than 5. null when all is well (or there are no runs at all yet: the tab explains that).
 */
export function bannerOf(days, now) {
  const today = bangkokDay(now);
  const hour = new Date(Number(now) + 7 * 3600e3).getUTCHours();
  const r = (days || []).find((d) => d.day === today);
  if (!days || !days.length) return null;
  if (!r) return hour >= 7 ? { level: 'red', text: `No daily run yet today (${today}). The last run was ${days[0].day}: ${days[0].status}.` } : null;
  if (r.status === 'failed') return { level: 'red', text: `Today's run failed${r.error ? `: ${String(r.error).slice(0, 160)}` : ''}. Yesterday's picks stay below until the next run.` };
  if (r.status === 'running') return hour >= 7 ? { level: 'red', text: 'Today\'s run started but has not finished.' } : { level: 'amber', text: 'Today\'s run is still going.' };
  if (r.status === 'short') return { level: 'amber', text: `Only ${r.picks} product${r.picks === 1 ? '' : 's'} passed the quality bar today (the bar is never lowered).` };
  return null;
}

/** A pick for the page: the saved scored product, with Connor's tap on it. */
function pickOut(row) {
  const d = jsonOf(row.data, {});
  return { ...d, key: row.product_key, rank: row.rank, id: row.id || d.id, score: row.score ?? d.score, level: row.level ?? d.level, name: d.name || row.title || '',
    decision: row.decision || null, reason: row.reason || null, decided_at: row.decided_at || null };
}

/** GET /api/today: the newest day (or ?day=), its run and picks, the last 14 days, and the banner. */
export async function todayGet(env, url, now = Date.now()) {
  let days;
  try {
    days = (await env.DB.prepare(DAYS_SQL).all()).results || [];
  } catch (e) {
    if (missing(e)) return { ready: false, day: null, days: [], run: null, banner: null, picks: [], reasons: REASONS };
    throw e;
  }
  const want = url && url.searchParams ? url.searchParams.get('day') : null;
  const ok = (d) => d.status === 'ok' || d.status === 'short';
  // The newest day with picks, unless one is asked for: a failed run today still shows yesterday's picks under its banner.
  const day = isDay(want) ? want : ((days.find(ok) || days[0] || {}).day || null);
  if (!day) return { ready: true, day: null, days, run: null, banner: bannerOf(days, now), picks: [], reasons: REASONS };
  const run = await env.DB.prepare(RUN_SQL).bind(day).first();
  const picks = ((await env.DB.prepare(PICKS_SQL).bind(day).all()).results || []).map(pickOut);
  const summary = run ? jsonOf(run.summary, {}) : {};
  return { ready: true, day, days, banner: bannerOf(days, now), reasons: REASONS, picks,
    run: run ? { day: run.day, status: run.status, picks: run.picks, pool: run.pool, started_at: run.started_at, finished_at: run.finished_at, error: run.error || null,
      counts: summary.counts || null, passed_over: summary.passed_over || {}, prepare: summary.prepare || null, backtest: summary.backtest || null,
      stages: (summary.stages || []).map((s) => ({ stage: s.stage, ok: s.ok, ms: s.ms })) } : null };
}

/** POST /api/today: { day, key, decision, reason }: { status, body }. decision null takes the tap back. */
export async function todayPost(env, j, now = Date.now()) {
  const day = j && j.day;
  const key = j && typeof j.key === 'string' ? j.key : '';
  const decision = j && j.decision != null ? String(j.decision) : null;
  const reason = j && j.reason != null ? String(j.reason).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) : null;
  if (!isDay(day)) return { status: 400, body: { error: 'Bad day' } };
  if (!key || key.length > 400 || !/^(eu|world|tiktok|google|research)\|/.test(key)) return { status: 400, body: { error: 'Bad key' } };
  if (decision != null && !DECISIONS.includes(decision)) return { status: 400, body: { error: 'Bad decision' } };
  const at = decision == null ? null : new Date(now).toISOString();
  const r = await env.DB.prepare(DECIDE_SQL).bind(day, key, decision, decision == null ? null : reason, at).run();
  const changed = r && r.meta ? r.meta.changes : 0;
  if (!changed) return { status: 404, body: { error: 'Not a pick of that day' } };
  return { status: 200, body: { ok: true, day, key, decision, reason: decision == null ? null : reason, decided_at: at } };
}

/** GET /api/today/digest: { status, body, type, name } with {{BOARD}} filled in with this board's own address. */
export async function todayDigest(env, url) {
  const day = url.searchParams.get('day');
  const csv = url.searchParams.get('format') === 'csv';
  let row = null;
  try {
    row = isDay(day) ? await env.DB.prepare(DIGEST_SQL).bind(day).first() : await env.DB.prepare('SELECT day, digest_md, digest_csv FROM daily_runs WHERE digest_md IS NOT NULL ORDER BY day DESC LIMIT 1').first();
  } catch (e) {
    if (!missing(e)) throw e;
  }
  const text = row ? (csv ? row.digest_csv : row.digest_md) : null;
  if (!text) return { status: 404, body: 'No digest for that day.', type: 'text/plain; charset=utf-8' };
  return { status: 200, body: String(text).split('{{BOARD}}').join(url.origin), type: csv ? 'text/csv; charset=utf-8' : 'text/markdown; charset=utf-8', name: `winners-${row.day}.${csv ? 'csv' : 'md'}` };
}
