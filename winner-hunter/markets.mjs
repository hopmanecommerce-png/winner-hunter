#!/usr/bin/env node
/*
 * Untapped markets outside the EU, for every shop on the board (and every ★ and ✓ Made ad product), after the hunt
 * (winner-hunter.yml) and for a test link (preview-board.yml). Per shop, Meta's Ad Library API: where its active ads
 * are aimed (target_locations), up to MAX_PAGES pages of PER_PAGE ads (most shops: one request). Saved in D1 table
 * `market_cover` as the shop's distinct targetings; the board turns them into markets (lib/markets.mjs coverOf) when it
 * reads them. A shop is checked again after REDO_DAYS.
 *   META_TOKEN=… CF_API_TOKEN=… CF_ACCOUNT_ID=… [MK_MINUTES=20] [MK_MAX=1200] [MK_STOP_PCT=80] node winner-hunter/markets.mjs
 *
 * Gentle on the Meta hourly limit it shares with the hunt: it stops (and saves what it has) as soon as Meta's usage
 * passes stopPct or Meta says the limit is reached; the next run goes on with the shops still unchecked. Only a D1
 * failure or no working token ends red.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings, chunks, STRICT } from './lib/d1.mjs';
import { pool } from './lib/meta.mjs';
import { compactAims, coverOf, EU } from './lib/markets.mjs';

const DAY = 864e5;
export const REDO_DAYS = 7; // a shop's markets are checked again after this long
export const PER_PAGE = 500; // ads per request (only id and target_locations: small)
export const MAX_PAGES = 4; // up to 2,000 active ads per shop; more: saved as partial (the board then can't tell, unless worldwide)
const TIMEOUT_MS = 60000; // one Meta request, answer included
const SLICE = 100; // shops checked between two saves
const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);

// Shops of the products on the board (as bestsellers.mjs picks them), not checked in the last REDO_DAYS, best first.
export const WANTED_SQL = `SELECT w.advertiser_page_id AS page_id,
  MAX(CAST(COALESCE(w.reach_eu, 0) AS REAL) / MAX(COALESCE(w.ad_age_days, 0), 1)) AS best
FROM winners w LEFT JOIN market_cover m ON m.page_id = w.advertiser_page_id
WHERE COALESCE(w.advertiser_page_id, '') != '' AND (m.checked_at IS NULL OR m.checked_at < ?2)
  AND ((${STRICT} AND w.last_seen >= ?1) OR w.ad_id IN (SELECT ad_id FROM stars) OR w.ad_id IN (SELECT ad_id FROM hidden WHERE status = 'seen'))
GROUP BY w.advertiser_page_id ORDER BY best DESC, w.advertiser_page_id LIMIT ?3`;
export const SAVE_SQL = `INSERT INTO market_cover (page_id, aims, sampled, partial, checked_at)
SELECT json_extract(value, '$.page_id'), json_extract(value, '$.aims'), json_extract(value, '$.sampled'), json_extract(value, '$.partial'), ?2
FROM json_each(?1) WHERE true
ON CONFLICT(page_id) DO UPDATE SET aims = excluded.aims, sampled = excluded.sampled, partial = excluded.partial, checked_at = excluded.checked_at`;

/** Meta's usage header (x-business-use-case-usage or x-app-usage): the highest of call count, CPU and time, 0–100. */
export function usageOf(res) {
  const h = res && res.headers && res.headers.get && (res.headers.get('x-business-use-case-usage') || res.headers.get('x-app-usage'));
  if (!h) return 0;
  try {
    const j = JSON.parse(h);
    const rows = Array.isArray(Object.values(j)[0]) ? Object.values(j).flat() : [j];
    return Math.max(0, ...rows.map((r) => Math.max(r.call_count || 0, r.total_cputime || 0, r.total_time || 0)));
  } catch (e) {
    return 0;
  }
}

/**
 * deps: { db, tokens, doFetch, now, log, deadline (ms), max (shops), stopPct, api, base, sleep, timeoutMs }. Returns
 * { wanted, checked, worldwide, partial (more ads than read), blind (ads without targeting), unknownGroups: [names], saved,
 * stopped: '' | 'time' | 'meta-limit' | 'token', usagePeak }. Both partial and blind shops are saved as partial. Throws only when D1 cannot be read or written, or no token works.
 */
export async function refresh({ db, tokens, doFetch = globalThis.fetch, now = Date.now, log = console.log, deadline = Infinity, max = 1200, stopPct = 80,
  api = 'v24.0', base = 'https://graph.facebook.com', sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = TIMEOUT_MS }) {
  const keys = (tokens || []).filter(Boolean);
  if (!keys.length) throw new Error('No META_TOKEN: add it as a GitHub secret (see winner-hunter/README.md)');
  const start = now();
  const wanted = await db.query(WANTED_SQL, [new Date(start - 45 * DAY).toISOString(), new Date(start - REDO_DAYS * DAY).toISOString(), max]);
  const t = { wanted: wanted.length, checked: 0, worldwide: 0, partial: 0, blind: 0, unknownGroups: [], saved: 0, stopped: '', usagePeak: 0 };
  const unknown = new Set();
  let ti = 0;
  const reached = JSON.stringify([...EU, 'GB']); // required by the API: every shop ad it can show ran in the EU or UK

  // One request, the answer included, within timeoutMs (a stalled answer must never hang the run).
  async function get(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { signal: ctrl.signal });
      const pct = usageOf(res);
      t.usagePeak = Math.max(t.usagePeak, pct);
      return { pct, j: await res.json() };
    } finally {
      clearTimeout(timer);
    }
  }

  // One page of a shop's ads (null: Meta's limit, stop for tonight). Both workers share the token index: a worker only
  // moves on to the next token when the one it used is still the current one (as lib/meta.mjs graph() does).
  async function page(url0) {
    let url = url0;
    let tries = 0;
    for (;;) {
      const used = ti;
      const u = new URL(url);
      u.searchParams.set('access_token', keys[used]);
      let r;
      try {
        r = await get(u.toString());
      } catch (e) {
        if (++tries >= 3) throw new Error('Meta API unreachable: ' + (e.name === 'AbortError' ? 'no answer in time' : e.message));
        const lim = Number(u.searchParams.get('limit'));
        if (e.name === 'AbortError' && lim > 50) { // too slow: ask for a smaller page (as lib/meta.mjs graph() does)
          u.searchParams.set('limit', String(Math.max(50, Math.floor(lim / 2))));
          u.searchParams.delete('access_token');
          url = u.toString();
        }
        await sleep(3000 * tries);
        continue;
      }
      const err = r.j && r.j.error;
      if (!err) {
        if (r.pct >= stopPct) t.stopped = t.stopped || 'meta-limit';
        return r.j;
      }
      if (err.code === 190 || RATE_CODES.has(err.code) || /limit/i.test(err.message || '')) {
        if (used !== ti) continue; // the other worker already switched: try the new token
        if (ti < keys.length - 1) { ti++; continue; }
        if (err.code === 190) throw Object.assign(new Error('Meta access token invalid or expired: make a new one and update the META_TOKEN secret'), { token: true });
        t.stopped = 'meta-limit';
        return null;
      }
      if (err.code === 10 || /identity|confirm/i.test(err.message || '')) { // the account, not this shop: stop
        throw Object.assign(new Error('Meta says: ' + err.message + ' (confirm your identity at facebook.com/ID)'), { token: true });
      }
      if (/reduce the amount of data/i.test(err.message || '') && Number(u.searchParams.get('limit')) > 50) {
        u.searchParams.set('limit', String(Math.floor(Number(u.searchParams.get('limit')) / 2)));
        u.searchParams.delete('access_token');
        url = u.toString();
        continue;
      }
      if ((err.code === 1 || err.code === 2 || err.is_transient) && ++tries < 3) {
        await sleep(5000 * tries);
        continue;
      }
      throw new Error(`Meta API error ${err.code}: ${err.message}`);
    }
  }

  // A shop's distinct targetings, up to MAX_PAGES pages; stops early once it aims everywhere. null: Meta's limit.
  async function aimsOf(pid) {
    const p = new URLSearchParams({ search_page_ids: JSON.stringify([pid]), ad_reached_countries: reached, ad_active_status: 'ACTIVE',
      ad_type: 'ALL', fields: 'id,target_locations', limit: String(PER_PAGE) });
    let url = `${base}/${api}/ads_archive?${p}`;
    const seen = new Map();
    let sampled = 0;
    let blind = 0; // ads without target_locations: where they aim is unknown
    for (let n = 0; n < MAX_PAGES && url; n++) {
      const j = await page(url);
      if (!j) return null;
      for (const a of Array.isArray(j.data) ? j.data : []) {
        sampled++;
        const c = compactAims(a.target_locations);
        if (c.length) seen.set(JSON.stringify(c), c);
        else blind++;
      }
      url = j.paging && j.paging.next && Array.isArray(j.data) && j.data.length ? j.paging.next : '';
      if (coverOf([...seen.values()]) === '*') return { aims: [...seen.values()], sampled, partial: 0, more: 0, blind: 0 };
    }
    return { aims: [...seen.values()], sampled, partial: url || blind ? 1 : 0, more: url ? 1 : 0, blind: blind ? 1 : 0 };
  }

  const iso = () => new Date(now()).toISOString();
  // In slices of SLICE shops, each saved before the next starts: a run cut short keeps what it checked.
  for (let i = 0; i < wanted.length && !t.stopped; i += SLICE) {
    const rows = [];
    await pool(wanted.slice(i, i + SLICE), 2, async ({ page_id: pid }) => {
      if (t.stopped) return;
      if (now() > deadline) { t.stopped = 'time'; return; }
      let r;
      try {
        r = await aimsOf(pid);
      } catch (e) {
        if (e.token) { t.stopped = 'token'; t.error = e.message; return; }
        log(`shop ${pid}: skipped (${e.message})`);
        return;
      }
      if (!r) return; // Meta's limit: this shop waits for the next run
      const cover = coverOf(r.aims, unknown);
      if (cover === '*') t.worldwide++;
      t.partial += r.more;
      t.blind += r.blind;
      t.checked++;
      rows.push({ page_id: String(pid), aims: JSON.stringify(r.aims), sampled: r.sampled, partial: r.partial });
    });
    for (const part of chunks(rows, 200)) {
      await db.query(SAVE_SQL, [JSON.stringify(part), iso()]);
      t.saved += part.length;
    }
  }
  await db.query('DELETE FROM market_cover WHERE checked_at < ?1', [new Date(start - 60 * DAY).toISOString()]);
  t.unknownGroups = [...unknown].sort();
  if (t.unknownGroups.length) log(`::warning::Unknown Meta country groups (shops with them show no markets until lib/markets.mjs knows them): ${t.unknownGroups.join(', ')}`);
  if (t.stopped === 'token') throw Object.assign(new Error(t.error), { saved: t.saved });
  log(`Markets outside the EU: ${t.checked} of ${t.wanted} shops checked · ${t.worldwide} already aim worldwide · ${t.partial} with more ads than read · ${t.blind} with ads without targeting`
    + `${t.stopped ? ` · stopped (${t.stopped === 'time' ? 'time is up' : 'Meta limit'}), the rest next run` : ''} · Meta peak ${t.usagePeak}%`);
  return t;
}

async function main() {
  const s = d1Settings();
  if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)');
  const env = process.env;
  const minutes = Math.min(Math.max(Number(env.MK_MINUTES) || 20, 1), 60);
  const t = await refresh({ db: d1Client(s), tokens: [env.META_TOKEN, env.META_TOKEN_2, env.META_TOKEN_3], deadline: Date.now() + minutes * 60000,
    max: Math.min(Math.max(Number(env.MK_MAX) || 1200, 1), 5000), stopPct: Math.min(Math.max(Number(env.MK_STOP_PCT) || 80, 10), 95) });
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n**Markets outside the EU:** ${t.checked} of ${t.wanted} shops checked, ${t.worldwide} already aim worldwide`
      + `${t.stopped ? `, stopped (${t.stopped}): the rest next run` : ''}.${t.unknownGroups.length ? ` Unknown country groups: ${t.unknownGroups.join(', ')}.` : ''}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::Markets outside the EU: ${e.message}`);
    process.exitCode = 1;
  });
}
