/*
 * The board's Problems tab: problems people complain about, from the Problem Database (problems-collect.mjs and
 * problems-process.mjs fill the tables, migrations/0040_problems.sql; docs/problem-db/README.md).
 *   GET  /api/problems?q=&area=&lang=&country=&platform=&min=&trend=&pay=&view=&sort=&offset=&limit=
 *        { problems, total, offset, limit, facets, areas, runs, sample }: the problems that match, a page at a time
 *   GET  /api/problems/<id>          { problem, quotes }: one problem, with up to 50 quotes from the posts behind it
 *   POST /api/problems {id, decision}  'saved', 'starred', 'ignored', or '' to take it back
 *   GET  /problems.csv?…  /problems.json?…   every problem that matches the same filters, as a download
 * For another tool (matching products later): GET /api/problems?view=all&limit=200&offset=… lists every problem with
 * its id, statement, quotes and matched_products (an empty list for now), behind the same PIN as the board.
 * The problems are read once and kept in memory until processing writes again (state 'problem_process' and the last
 * rowid): a page costs one small check and your decisions, not a read of every problem.
 * app.mjs checks the PIN cookie, the origin and the JSON before any of this runs. All SQL is parameterized.
 */

export const VIEWS = ['open', 'saved', 'starred', 'ignored', 'all'];
export const DECISIONS = ['saved', 'starred', 'ignored'];
export const TRENDS = ['rising', 'new', 'steady', 'falling'];
export const SORTS = {
  intensity: (a, b) => b.intensity - a.intensity || b.mentions - a.mentions,
  volume: (a, b) => b.mentions - a.mentions || b.engagement - a.engagement,
  growth: (a, b) => b.growth - a.growth || b.mentions - a.mentions,
  engagement: (a, b) => b.engagement - a.engagement || b.mentions - a.mentions,
  wtp: (a, b) => b.wtp - a.wtp || b.mentions - a.mentions,
  newest: (a, b) => (a.first_seen < b.first_seen ? 1 : a.first_seen > b.first_seen ? -1 : 0) || b.mentions - a.mentions,
  recent: (a, b) => (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0) || b.mentions - a.mentions,
};
const PAGE = 40;
const MAX_PAGE = 200;
const MAX_EXPORT = 5000;
const ID = /^p_[a-f0-9]{12}(?:-\d{1,3})?$/;

const COLS = 'id, active, title, statement, area, lang, langs, country, countries, platforms, mentions, authors, engagement, first_seen, last_seen, trend, growth, monthly, intensity, wtp, wtp_signals, keywords, quotes, flags, matched_products, named_by, updated_at, sample';
export const LIST_SQL = `SELECT ${COLS} FROM problems WHERE active = 1 LIMIT ${MAX_EXPORT}`;
const VERSION_SQL = "SELECT (SELECT updated_at FROM state WHERE key = 'problem_process') AS u, (SELECT MAX(rowid) FROM problems) AS r";
const DECIDED_SQL = 'SELECT problem_id, decision, at FROM problem_decisions';
export const QUOTES_SQL = `SELECT id, platform, kind, url, title, body, score, replies, created_at, lang FROM problem_mentions WHERE problem_id = ?
  ORDER BY COALESCE(score, 0) + COALESCE(replies, 0) DESC, id LIMIT 50`;

const jsonOf = (s, or) => {
  try {
    const v = JSON.parse(s || '');
    return v == null ? or : v;
  } catch (e) {
    return or;
  }
};
const num = (x) => (x == null || !Number.isFinite(Number(x)) ? 0 : Number(x));
const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
const arr = (x) => (Array.isArray(x) ? x : []);
/** Lower case without accents, for the search box: "losung" finds "Lösung". */
export const foldText = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss');

/** A problems row as the board and the API give it. */
export function problemOut(r) {
  const quotes = arr(jsonOf(r.quotes, [])).filter((q) => q && https(q.url)).map((q) => ({
    id: String(q.id || ''), text: String(q.text || ''), url: https(q.url), platform: String(q.platform || ''), lang: String(q.lang || ''), at: String(q.at || ''), score: num(q.score),
  }));
  const w = obj(jsonOf(r.wtp_signals, {}));
  return {
    id: String(r.id), active: Number(r.active) !== 0, title: String(r.title || ''), statement: String(r.statement || ''), area: String(r.area || ''),
    lang: String(r.lang || ''), langs: obj(jsonOf(r.langs, {})), country: String(r.country || ''), countries: obj(jsonOf(r.countries, {})), platforms: obj(jsonOf(r.platforms, {})),
    mentions: num(r.mentions), authors: num(r.authors), engagement: num(r.engagement), first_seen: String(r.first_seen || ''), last_seen: String(r.last_seen || ''),
    trend: TRENDS.includes(r.trend) ? r.trend : 'steady', growth: num(r.growth), monthly: arr(jsonOf(r.monthly, [])).filter((m) => Array.isArray(m) && m.length === 2).map(([m, n]) => [String(m), num(n)]),
    intensity: num(r.intensity), wtp: num(r.wtp), wtp_signals: { pay: num(w.pay), seeking: num(w.seeking), tried: num(w.tried) },
    keywords: arr(jsonOf(r.keywords, [])).map(String).slice(0, 12), quotes, flags: arr(jsonOf(r.flags, [])).map(String),
    matched_products: arr(jsonOf(r.matched_products, [])), named_by: String(r.named_by || 'rules'), updated_at: String(r.updated_at || ''), sample: Number(r.sample) === 1,
    decision: null, decided_at: '',
  };
}

// ---------------------------------------------------------------------------
// Problems in memory, read again only when processing wrote (or after 15 minutes)
// ---------------------------------------------------------------------------
const SNAP_MS = 15 * 60000;
const SNAPS = new WeakMap();
let LAST = null; // on Cloudflare: shared by the requests this isolate serves

const optional = (p) => p.then((r) => r, (e) => {
  if (/no such table/i.test(String(e && e.message))) return null; // before the migration: an empty tab
  throw e;
});

async function snapshot(DB, now) {
  const v = await optional(DB.prepare(VERSION_SQL).first());
  if (!v) return [];
  const ver = `${v.u}|${v.r}`;
  const shared = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
  let s = SNAPS.get(DB) || (shared ? LAST : null);
  if (!s || s.ver !== ver || now - s.at > SNAP_MS || now < s.at) {
    const res = await optional(DB.prepare(LIST_SQL).all());
    s = { ver, at: now, rows: ((res && res.results) || []).map(problemOut) };
    for (const p of s.rows) p.find = foldText([p.title, p.statement, p.keywords.join(' '), ...p.quotes.map((q) => q.text)].join(' '));
    SNAPS.set(DB, s);
    if (shared) LAST = s;
  }
  return s.rows;
}

async function decisions(DB) {
  const res = await optional(DB.prepare(DECIDED_SQL).all());
  return new Map(((res && res.results) || []).map((d) => [d.problem_id, d]));
}

/** The query's filters, checked: anything unknown is left out. */
export function filtersOf(p) {
  const s = (k, n = 40) => String(p.get(k) || '').trim().slice(0, n);
  const min = Math.floor(Number(p.get('min')));
  return {
    q: s('q', 80), area: s('area'), lang: /^[a-z]{2}$/.test(s('lang')) ? s('lang') : '', country: /^[A-Z]{2}$/.test(s('country')) ? s('country') : '',
    platform: /^[a-z]{2,20}$/.test(s('platform')) ? s('platform') : '', min: Number.isFinite(min) && min > 1 ? Math.min(min, 10000) : 1,
    trend: TRENDS.includes(s('trend')) ? s('trend') : '', pay: s('pay') === '1', view: VIEWS.includes(s('view')) ? s('view') : 'open',
    sort: Object.hasOwn(SORTS, s('sort')) ? s('sort') : 'intensity',
  };
}

/** The problems that pass the filters, sorted (ties: the id), with your decisions on them. */
export function filterProblems(rows, f, decided = new Map()) {
  const q = foldText(f.q);
  const out = [];
  for (const r of rows) {
    const d = decided.get(r.id);
    const p = d ? { ...r, decision: d.decision, decided_at: d.at || '' } : r;
    if (f.view === 'open' ? p.decision : f.view !== 'all' && p.decision !== f.view) continue;
    if (f.area && p.area !== f.area) continue;
    if (f.lang && !p.langs[f.lang]) continue;
    if (f.country && !p.countries[f.country]) continue;
    if (f.platform && !p.platforms[f.platform]) continue;
    if (p.mentions < f.min) continue;
    if (f.trend && p.trend !== f.trend) continue;
    if (f.pay && !(p.wtp_signals.pay > 0)) continue;
    if (q && !q.split(/\s+/).every((w) => p.find.includes(w))) continue;
    out.push(p);
  }
  return out.sort((a, b) => SORTS[f.sort](a, b) || (a.id < b.id ? -1 : 1));
}

/** Counts for the filter menus, over every problem on the board. */
export function facetsOf(rows) {
  const f = { areas: {}, langs: {}, countries: {}, platforms: {}, trends: {} };
  for (const p of rows) {
    f.areas[p.area || ''] = (f.areas[p.area || ''] || 0) + 1;
    for (const k of Object.keys(p.langs)) f.langs[k] = (f.langs[k] || 0) + 1;
    for (const k of Object.keys(p.countries)) f.countries[k] = (f.countries[k] || 0) + 1;
    for (const k of Object.keys(p.platforms)) f.platforms[k] = (f.platforms[k] || 0) + 1;
    f.trends[p.trend] = (f.trends[p.trend] || 0) + 1;
  }
  return f;
}

const strip = ({ find, ...p }) => p;

async function stateOf(DB, keys) {
  const res = await optional(DB.prepare(`SELECT key, value, updated_at FROM state WHERE key IN (${keys.map(() => '?').join(', ')})`).bind(...keys).all());
  const out = {};
  for (const r of (res && res.results) || []) out[r.key] = { ...obj(jsonOf(r.value, {})), updated_at: r.updated_at };
  return out;
}

/** GET /api/problems */
export async function problemsList(env, params, now) {
  const [rows, decided, st] = await Promise.all([snapshot(env.DB, now), decisions(env.DB), stateOf(env.DB, ['problem_run', 'problem_process'])]);
  const f = filtersOf(params);
  const list = filterProblems(rows, f, decided);
  const offset = Math.max(0, Math.min(Math.floor(Number(params.get('offset'))) || 0, 1e6));
  const limit = Math.max(1, Math.min(Math.floor(Number(params.get('limit'))) || PAGE, MAX_PAGE));
  const views = Object.fromEntries(VIEWS.map((v) => [v, 0]));
  for (const r of rows) {
    const d = decided.get(r.id);
    views.all++;
    views[d ? d.decision : 'open']++;
  }
  const run = st.problem_run || null;
  const proc = st.problem_process || null;
  return {
    problems: list.slice(offset, offset + limit).map(strip), total: list.length, offset, limit, filters: f, views, facets: facetsOf(rows),
    areas: proc && proc.areas && typeof proc.areas === 'object' ? proc.areas : {}, sample: rows.some((r) => r.sample),
    runs: {
      collect: run ? { at: run.finished_at || run.updated_at || '', status: run.status || '', health: run.health || '', alert: String(run.alert || '').slice(0, 300), searches: num(run.searches), credits: num(run.credits_sent), cap: num(run.cap), kept: num(run.kept), stopped: String(run.stopped || '') } : null,
      process: proc ? { at: proc.finished_at || proc.updated_at || '', problems: num(proc.problems), relevant: num(proc.relevant), mentions: num(proc.mentions), llm: proc.llm || null } : null,
    },
  };
}

/** GET /api/problems/<id>: the problem and its quotes (the posts and comments behind it, most liked first). */
export async function problemDetail(env, id, now) {
  if (!ID.test(id)) return { status: 400, body: { error: 'Bad id' } };
  const row = await optional(env.DB.prepare(`SELECT ${COLS} FROM problems WHERE id = ?`).bind(id).first());
  if (!row) return { status: 404, body: { error: 'Unknown problem' } };
  const p = problemOut(row);
  const d = await optional(env.DB.prepare('SELECT decision, at FROM problem_decisions WHERE problem_id = ?').bind(id).first());
  if (d) Object.assign(p, { decision: d.decision, decided_at: d.at || '' });
  const res = await optional(env.DB.prepare(QUOTES_SQL).bind(id).all());
  const seen = new Set(); // a copy (a crosspost, the same text again) shows once: the most liked one comes first
  const quotes = ((res && res.results) || []).filter((m) => https(m.url)).map((m) => ({
    id: m.id, text: String(m.kind === 'comment' ? m.body || '' : [m.title, m.body].filter(Boolean).join(' — ')).slice(0, 600), url: https(m.url), platform: m.platform,
    lang: m.lang || '', at: m.created_at || '', score: num(m.score) + num(m.replies),
  })).filter((q) => {
    const k = foldText(q.text).replace(/\W+/g, ' ').trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { status: 200, body: { problem: p, quotes } };
}

/** POST /api/problems {id, decision} */
export async function problemDecide(env, j, now) {
  const id = String((j && j.id) || '');
  const decision = String((j && j.decision) ?? '');
  if (!ID.test(id)) return { status: 400, body: { error: 'Bad id' } };
  if (decision && !DECISIONS.includes(decision)) return { status: 400, body: { error: 'Bad decision' } };
  const known = await env.DB.prepare('SELECT id FROM problems WHERE id = ?').bind(id).first();
  if (!known) return { status: 404, body: { error: 'Unknown problem' } };
  if (decision) {
    await env.DB.prepare('INSERT INTO problem_decisions (problem_id, decision, at) VALUES (?, ?, ?) ON CONFLICT(problem_id) DO UPDATE SET decision = excluded.decision, at = excluded.at')
      .bind(id, decision, new Date(now).toISOString()).run();
  } else await env.DB.prepare('DELETE FROM problem_decisions WHERE problem_id = ?').bind(id).run();
  return { status: 200, body: { ok: true, id, decision: decision || null } };
}

// CSV: quotes around every text cell that needs it; a cell starting with = + - @ gets a ' so a spreadsheet never runs
// it as a formula (as csvCell in app.mjs).
export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const pairs = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k || '?'} ${n}`).join(' / ');
export const CSV_COLS = [
  ['id', (p) => p.id], ['title', (p) => p.title], ['statement', (p) => p.statement], ['area', (p) => p.area], ['lang', (p) => p.lang], ['langs', (p) => pairs(p.langs)],
  ['country', (p) => p.country], ['countries', (p) => pairs(p.countries)], ['platforms', (p) => pairs(p.platforms)], ['mentions', (p) => p.mentions], ['people', (p) => p.authors],
  ['engagement', (p) => p.engagement], ['first_seen', (p) => p.first_seen], ['last_seen', (p) => p.last_seen], ['trend', (p) => p.trend], ['growth', (p) => p.growth],
  ['intensity', (p) => p.intensity], ['wtp', (p) => p.wtp], ['would_pay', (p) => p.wtp_signals.pay], ['seeking', (p) => p.wtp_signals.seeking], ['tried', (p) => p.wtp_signals.tried],
  ['keywords', (p) => p.keywords.join(' / ')], ['top_quote', (p) => (p.quotes[0] ? p.quotes[0].text : '')], ['top_quote_url', (p) => (p.quotes[0] ? p.quotes[0].url : '')],
  ['quote_urls', (p) => p.quotes.map((q) => q.url).join(' ')], ['decision', (p) => p.decision || ''], ['matched_products', (p) => JSON.stringify(p.matched_products)],
  ['named_by', (p) => p.named_by], ['flags', (p) => p.flags.join(' ')], ['sample', (p) => (p.sample ? 1 : 0)],
];
export const toCsv = (list) => [CSV_COLS.map((c) => c[0]).join(','), ...list.map((p) => CSV_COLS.map(([, f]) => csvCell(f(p))).join(','))].join('\r\n') + '\r\n';

/** /problems.csv and /problems.json: every problem that matches (at most 5000). */
export async function problemsExport(env, params, now, kind) {
  const [rows, decided] = await Promise.all([snapshot(env.DB, now), decisions(env.DB)]);
  const f = filtersOf(params);
  const list = filterProblems(rows, f, decided).slice(0, MAX_EXPORT).map(strip);
  const day = new Date(now).toISOString().slice(0, 10);
  if (kind === 'csv') return { type: 'text/csv; charset=utf-8', name: `problems-${f.view}-${day}.csv`, body: toCsv(list) };
  return { type: 'application/json; charset=utf-8', name: `problems-${f.view}-${day}.json`, body: JSON.stringify({ exported_at: new Date(now).toISOString(), filters: f, count: list.length, problems: list }, null, 1) };
}
