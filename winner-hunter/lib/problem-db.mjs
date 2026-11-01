/*
 * The Problem Database in D1 (tables: worker/migrations/0040_problems.sql), over lib/d1.mjs's client.
 *   await saveMentions(db, mentions, { now, runId })  → rows sent (a post seen again gets its new likes, not a second row)
 *   await commentsFetchedSince(db, ids, sinceIso)    → the posts of `ids` whose comments were read after sinceIso
 *   await readMentions(db, { since, sample })         → what problems-process.mjs groups
 *   await saveProblems(db, problems, now) / setMentionFields(db, rows) / deactivateProblems(db, keepIds, sample)
 * One bound JSON array per query (D1 takes at most 100 bound values). A row is only rewritten when something in it
 * changed: D1 counts every row written.
 */
import crypto from 'node:crypto';
import { chunks } from './d1.mjs';

// lang on a new row: the language of the query or the platform's own guess. problems-process.mjs reads it as a hint and
// writes its own answer back.
export const MENTION_COLS = ['id', 'platform', 'kind', 'parent_id', 'url', 'community', 'title', 'body', 'area', 'query', 'score', 'replies', 'created_at', 'author_hash', 'lang'];

// A mention seen again: its new counts and its last_seen, the longer text if it grew; the area, query and language it
// was found with first stay. Nothing is written when the counts are the same and it was seen less than a day ago.
export const MENTION_UPSERT_SQL = `INSERT INTO problem_mentions (${MENTION_COLS.join(', ')}, first_seen, last_seen, run_id, sample)
SELECT ${MENTION_COLS.map((c) => `json_extract(value, '$.${c}')`).join(', ')}, ?2, ?2, ?3, COALESCE(json_extract(value, '$.sample'), 0) FROM json_each(?1) WHERE true
ON CONFLICT(id) DO UPDATE SET score = COALESCE(excluded.score, problem_mentions.score), replies = COALESCE(excluded.replies, problem_mentions.replies),
  body = CASE WHEN length(COALESCE(excluded.body, '')) > length(COALESCE(problem_mentions.body, '')) THEN excluded.body ELSE problem_mentions.body END,
  last_seen = excluded.last_seen, run_id = excluded.run_id
WHERE excluded.score IS NOT problem_mentions.score OR excluded.replies IS NOT problem_mentions.replies OR COALESCE(problem_mentions.last_seen, '') < date(excluded.last_seen, '-1 day')
  OR length(COALESCE(excluded.body, '')) > length(COALESCE(problem_mentions.body, ''))`;

export async function saveMentions(db, mentions, { now = Date.now(), runId = '' } = {}) {
  const at = new Date(now).toISOString();
  let n = 0;
  for (const part of chunks(mentions.map((m) => Object.fromEntries(MENTION_COLS.map((c) => [c, m[c] ?? null]).concat([['sample', m.sample ? 1 : 0]]))))) {
    await db.query(MENTION_UPSERT_SQL, [JSON.stringify(part), at, runId]);
    n += part.length;
  }
  return n;
}

/** The ids among `ids` whose comments were fetched at or after sinceIso: those are not fetched again (no credit spent). */
export async function commentsFetchedSince(db, ids, sinceIso) {
  if (!ids.length) return new Set();
  const rows = await db.query('SELECT id FROM problem_mentions WHERE id IN (SELECT value FROM json_each(?1)) AND comments_at >= ?2', [JSON.stringify(ids), sinceIso]);
  return new Set(rows.map((r) => r.id));
}

export async function markComments(db, ids, now = Date.now()) {
  if (!ids.length) return;
  await db.query('UPDATE problem_mentions SET comments_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))', [JSON.stringify(ids), new Date(now).toISOString()]);
}

// A page of mentions after the id ?3 (D1 answers stay small: 2,000 rows of up to 2,000 characters a page).
export const READ_MENTIONS_SQL = `SELECT id, platform, kind, parent_id, url, community, title, body, area, query, score, replies, created_at, author_hash, lang, country,
  relevant, problem_id, first_seen, sample FROM problem_mentions WHERE sample = ?1 AND (COALESCE(created_at, '') = '' OR created_at >= ?2) AND id > ?3 ORDER BY id LIMIT ?4`;

/** The mentions to group: real ones (or only the sample), posted after `since` (or of unknown date), at most `limit`. */
export async function readMentions(db, { since = '1970-01-01', sample = false, limit = 100000, page = 2000 } = {}) {
  const out = [];
  let after = '';
  while (out.length < limit) {
    const rows = await db.query(READ_MENTIONS_SQL, [sample ? 1 : 0, since, after, Math.min(page, limit - out.length)]);
    out.push(...rows);
    if (rows.length < page) break;
    after = rows[rows.length - 1].id;
  }
  return out;
}

// What processing writes back on a mention, only for rows where one of them changed.
export const MENTION_FIELDS_SQL = `UPDATE problem_mentions SET lang = json_extract(j.value, '$.lang'), country = json_extract(j.value, '$.country'),
  relevant = json_extract(j.value, '$.relevant'), problem_id = json_extract(j.value, '$.problem_id')
FROM (SELECT value FROM json_each(?1)) AS j WHERE problem_mentions.id = json_extract(j.value, '$.id')`;

export async function setMentionFields(db, rows) {
  let n = 0;
  for (const part of chunks(rows, 400)) {
    await db.query(MENTION_FIELDS_SQL, [JSON.stringify(part)]);
    n += part.length;
  }
  return n;
}

export const PROBLEM_COLS = ['id', 'title', 'statement', 'area', 'lang', 'langs', 'country', 'countries', 'platforms', 'mentions', 'authors', 'engagement',
  'first_seen', 'last_seen', 'trend', 'growth', 'monthly', 'intensity', 'wtp', 'wtp_signals', 'keywords', 'quotes', 'flags', 'named_by', 'llm_key'];
const JSON_COLS = new Set(['langs', 'countries', 'platforms', 'monthly', 'wtp_signals', 'keywords', 'quotes', 'flags']);

/** The row as written, and its hash: an unchanged problem is not written again. */
export function problemRow(p) {
  const row = Object.fromEntries(PROBLEM_COLS.map((c) => [c, JSON_COLS.has(c) ? JSON.stringify(p[c] ?? (c === 'flags' ? [] : {})) : p[c] ?? null]));
  row.sample = p.sample ? 1 : 0;
  row.hash = crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 24);
  return row;
}

// matched_products is never written here: it belongs to the later product-matching step. A problem that was off and
// is found again comes back on.
export const PROBLEM_UPSERT_SQL = `INSERT INTO problems (${PROBLEM_COLS.join(', ')}, sample, hash, active, created_at, updated_at)
SELECT ${PROBLEM_COLS.map((c) => `json_extract(value, '$.${c}')`).join(', ')}, json_extract(value, '$.sample'), json_extract(value, '$.hash'), 1, ?2, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(id) DO UPDATE SET ${PROBLEM_COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}, sample = excluded.sample, hash = excluded.hash, active = 1, updated_at = excluded.updated_at
WHERE problems.hash IS NOT excluded.hash OR problems.active != 1`;

export async function saveProblems(db, problems, now = Date.now()) {
  const at = new Date(now).toISOString();
  let n = 0;
  for (const part of chunks(problems.map(problemRow), 100)) {
    await db.query(PROBLEM_UPSERT_SQL, [JSON.stringify(part), at]);
    n += part.length;
  }
  return n;
}

/** Problems of this kind (real or sample) that this run did not find: off the board, kept for their decision. */
export async function deactivateProblems(db, keepIds, sample = false, now = Date.now()) {
  await db.query('UPDATE problems SET active = 0, updated_at = ?3 WHERE active = 1 AND sample = ?2 AND id NOT IN (SELECT value FROM json_each(?1))',
    [JSON.stringify(keepIds), sample ? 1 : 0, new Date(now).toISOString()]);
}

/** The problems as stored (for stable ids and Claude's names): id, title, statement, flags, named_by, llm_key, active. */
export async function readProblems(db, sample = false) {
  return db.query('SELECT id, title, statement, area, flags, named_by, llm_key, active FROM problems WHERE sample = ?1', [sample ? 1 : 0]);
}
