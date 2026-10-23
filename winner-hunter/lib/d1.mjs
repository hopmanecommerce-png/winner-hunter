/*
 * Cloudflare D1 over its REST API (the nightly run on GitHub has no Worker binding).
 *   const db = d1Client({ accountId, databaseId, token });
 *   await db.query(sql, params)          → rows (throws on an error, after one retry)
 *   await db.upsertWinners(records, now) → { saved } or { saved, error }   (never throws)
 *   await db.getState(key) / db.setState(key, value, now) / db.saveRun(run) / db.newWinnersSince(iso)
 *   await migrate(db, [sqlText, …])     → statements run (an ADD COLUMN that is already there is skipped)
 */
import { MIN_ACTIVE_ADS, MIN_AGE_DAYS, MAX_AGE_DAYS, MIN_REACH_PER_DAY } from './score.mjs';

// Table column ← record field.
const COLS = [
  ['ad_id', 'id'], ['score', 'score'], ['verdict', 'verdict'], ['product_title', 'product_title'], ['price', 'price'],
  ['compare_at_price', 'compare_at_price'], ['currency', 'currency'], ['advertiser', 'advertiser'],
  ['advertiser_page_id', 'advertiser_page_id'], ['active_ads', 'active_ads'], ['ad_age_days', 'ad_age_days'],
  ['ad_start_date', 'ad_start_date'], ['reach_eu', 'reach_eu'], ['scaled_count', 'scaled_count'], ['keyword', 'keyword'],
  ['market', 'market'], ['store_url', 'store_url'], ['product_url', 'product_url'], ['ad_library_url', 'ad_library_url'],
  ['image_url', 'image_url'],
];

// One bound JSON array per query (D1 allows at most 100 bound parameters, so no row-per-placeholder).
// A record's own seen_at (old imports) is used as first/last seen, else ?2 (now). A known ad keeps its earliest
// first_seen, and older data never overwrites newer data.
const NEWER = `excluded.last_seen >= COALESCE(winners.last_seen, '')`;
export const UPSERT_SQL = `INSERT INTO winners (${COLS.map(([c]) => c).join(', ')}, first_seen, last_seen, data)
SELECT ${COLS.map(([, f]) => `json_extract(value, '$.${f}')`).join(', ')}, COALESCE(json_extract(value, '$.seen_at'), ?2), COALESCE(json_extract(value, '$.seen_at'), ?2), value FROM json_each(?1) WHERE true
ON CONFLICT(ad_id) DO UPDATE SET ${[...COLS.slice(1).map(([c]) => c), 'last_seen', 'data'].map((c) => `${c} = CASE WHEN ${NEWER} THEN excluded.${c} ELSE winners.${c} END`).join(', ')},
first_seen = MIN(COALESCE(winners.first_seen, excluded.first_seen), excluded.first_seen)`;

// The rules (lib/score.mjs) on a stored row, as the hunter saw it (the board also ages it since last_seen).
export const STRICT = `COALESCE(active_ads, 0) >= ${MIN_ACTIVE_ADS} AND ad_age_days BETWEEN ${MIN_AGE_DAYS} AND ${MAX_AGE_DAYS} AND CAST(COALESCE(reach_eu, 0) AS REAL) / MAX(ad_age_days, 1) >= ${MIN_REACH_PER_DAY}`;

const MAX_BYTES = 1.5e6; // bound JSON per query

/** Splits records into chunks of at most `chunk` records and `maxBytes` of JSON. */
export function chunks(records, chunk = 200, maxBytes = MAX_BYTES) {
  const out = [];
  let cur = [];
  let size = 2;
  for (const r of records) {
    const n = Buffer.byteLength(JSON.stringify(r)) + 1;
    if (cur.length && (cur.length >= chunk || size + n > maxBytes)) (out.push(cur), (cur = []), (size = 2));
    cur.push(r);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** D1 settings from the environment, or null when one is missing. */
export function d1Settings(env = process.env) {
  const s = { accountId: env.CF_ACCOUNT_ID, databaseId: env.D1_DATABASE_ID || '8934aca9-51d3-4f87-9c62-e897843149a1', token: env.CF_API_TOKEN };
  return s.accountId && s.databaseId && s.token ? s : null;
}

export function d1Client({ accountId, databaseId, token }, { doFetch = globalThis.fetch, retryMs = 5000, chunk = 200, maxBytes = MAX_BYTES } = {}) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;

  // One statement; retried once. Throws an Error('Cloudflare D1: …') when it still fails.
  async function query(sql, params = []) {
    let err = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, retryMs));
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sql, params }),
        });
        const j = await res.json().catch(() => null);
        const results = j ? [].concat(j.result || []) : [];
        const bad = results.find((x) => x && x.success === false);
        if (j && j.success && res.ok !== false && !bad) return (results[0] && results[0].results) || [];
        err = (j && [].concat(j.errors || [], (bad && bad.error) || []).map((e) => e.message || e).join('; ')) || 'HTTP ' + res.status;
        if (res.status === 401 || res.status === 403 || /duplicate column name/i.test(err)) break; // does not get better on retry
      } catch (e) {
        err = e.message || String(e);
      }
    }
    throw new Error('Cloudflare D1: ' + err);
  }

  return {
    query,
    /** Insert or update winners by ad id, in chunks. Never throws. */
    async upsertWinners(records, now = new Date()) {
      const iso = new Date(now).toISOString();
      const list = (records || []).filter((r) => r && r.id);
      let saved = 0;
      for (const part of chunks(list, chunk, maxBytes)) {
        try {
          await query(UPSERT_SQL, [JSON.stringify(part), iso]);
        } catch (e) {
          return { saved, error: e.message };
        }
        saved += part.length;
      }
      return { saved };
    },
    async getState(key) {
      const rows = await query('SELECT value FROM state WHERE key = ?1', [key]);
      return rows.length ? rows[0].value : null;
    },
    async setState(key, value, now = new Date()) {
      await query('INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        [key, typeof value === 'string' ? value : JSON.stringify(value), new Date(now).toISOString()]);
    },
    async saveRun(r) {
      await query(`INSERT INTO runs (id, started_at, finished_at, ads_checked, winners, meta_usage_peak, note, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(id) DO UPDATE SET finished_at = excluded.finished_at, ads_checked = excluded.ads_checked, winners = excluded.winners, meta_usage_peak = excluded.meta_usage_peak, note = excluded.note, status = excluded.status`,
      [r.id, r.started_at, r.finished_at ?? null, r.ads_checked ?? 0, r.winners ?? 0, r.meta_usage_peak ?? 0, r.note ?? '', r.status ?? null]);
    },
    async newWinnersSince(iso) {
      const rows = await query(`SELECT COUNT(*) AS n FROM winners WHERE first_seen >= ?1 AND ${STRICT}`, [iso]);
      return rows.length ? Number(rows[0].n) || 0 : 0;
    },
  };
}

/** The SQL statements of a migration file (statements end with ";" at the end of a line; -- comments dropped). */
export function statements(sqlText) {
  return String(sqlText).split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Applies migration files in order. SQLite has no ADD COLUMN IF NOT EXISTS, so an ALTER TABLE … ADD COLUMN that
 * fails with "duplicate column name" (applied before) is skipped; every other error throws.
 */
export async function migrate(db, sqlTexts) {
  let n = 0;
  for (const text of sqlTexts) {
    for (const sql of statements(text)) {
      try {
        await db.query(sql);
        n++;
      } catch (e) {
        if (!/duplicate column name/i.test(e.message)) throw e;
      }
    }
  }
  return n;
}
