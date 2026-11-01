#!/usr/bin/env node
/*
 * Momentum, once a day (momentum.yml): where each product on the board is heading. It reads the board's own tables and
 * writes one row a day of numbers (D1 table momentum_daily) and a summary per product for the board (table momentum).
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… [SERPAPI_KEY=…] [TRENDS_MAX=5] [TRENDS_DAYS=14] [MOMENTUM_MINUTES=20] node winner-hunter/momentum.mjs
 *
 * 1. The board's products: outside the EU (world_products), the EU board (winners, one product per advertiser + title),
 *    TikTok (tiktok_products), each with its store's best-seller rank and how long its ads were seen running (world_ads).
 * 2. The same item in other stores: the same words in the title, the supplier's photo id in the photo's file name, or a
 *    photo that looks the same (a fingerprint made in the runner's Chrome; without Chrome only the first two).
 * 3. Today's numbers saved (one row, upserted: a second run on a day replaces it), the last 45 days read back.
 * 4. Google Trends through SerpApi for shortlisted products only (a launch card, approved ✓, starred, approved on the
 *    TikTok tab), at most TRENDS_MAX a run, each again after TRENDS_DAYS days. Only with the SERPAPI_KEY secret.
 * 5. A summary per product for the board, the run's own record, and days older than 120 removed.
 * Only D1 can make it fail: no Chrome, no SerpApi key or a lookup that fails only leaves that part out.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chunks, d1Client, d1Settings, STRICT } from './lib/d1.mjs';
import { pool } from './lib/meta.mjs';
import { sized } from './lib/storephoto.mjs';
import { productKey } from './lib/bestsellers.mjs';
import { itemsOf, historyOf, rivalsOf, summaryOf, trendsQuery, trendsUrl, trendsOf, partsOf, splitMap, hashInPage, dayOf, daysBetween,
  DAY, HISTORY_DAYS, KEEP_DAYS, EU_KEY } from './lib/momentum.mjs';
import { scoreOf, crowdOf } from './worker/src/momentum.mjs';

// ---- What it reads. Big tables a slice at a time (rowid), as world.mjs does: one big answer can fail.
export const WORLD_SQL = 'SELECT rowid AS rid, product_key, ad_id, active, product_title, price, image_url, store_url, product_url, advertiser, markets, ads, new14, shop_ads, eu_rpd, first_seen, last_seen FROM world_products';
// pass: on the EU board when last seen (the rules) and seen in the last 45 days, as the store signals pick them (bestsellers.mjs).
export const EU_SQL = `SELECT rowid AS rid, ad_id, ${EU_KEY} AS gk, product_title, price, active_ads, ad_age_days, reach_eu, scaled_count, store_url, product_url, image_url, first_seen, last_seen,
  CASE WHEN json_valid(data) THEN json_extract(data, '$.top_countries') END AS tc, CASE WHEN (${STRICT}) AND last_seen >= ?1 THEN 1 ELSE 0 END AS pass FROM winners`;
export const TIKTOK_SQL = 'SELECT rowid AS rid, id, title, shop, image_url, price_min, sold_us, creators, updated_at, decision, decided_at FROM tiktok_products';
export const BEST_SQL = 'SELECT rowid AS rid, product_key, rank, ok, history, checked_at FROM bestseller';
// How long each product's ads were seen running: from Meta's start date to the last time the hunt saw the ad.
export const SURVIVAL_SQL = `SELECT product_key, MAX(CAST(julianday(last_seen) - julianday(start_at, 'unixepoch') AS INTEGER)) AS survived,
  SUM(CASE WHEN julianday(last_seen) - julianday(start_at, 'unixepoch') >= 30 THEN 1 ELSE 0 END) AS long_ads
FROM world_ads WHERE product_key != '' AND start_at > 0 GROUP BY product_key`;
export const DECIDED_SQL = "SELECT 'seen' AS kind, ad_id, at FROM hidden WHERE status = 'seen' UNION ALL SELECT 'star' AS kind, ad_id, at FROM stars";
export const LAUNCH_SQL = 'SELECT product_key, pinned, decision, updated_at FROM launches';
export const HISTORY_SQL = 'SELECT day, part, body FROM momentum_daily WHERE day >= ?1 AND day < ?2 ORDER BY day, part';
export const CACHE_SQL = "SELECT key, body FROM momentum WHERE key IN ('images', 'trends')";
// ---- What it writes: one bound JSON array per query (D1 takes at most 100 bound values).
export const DAILY_SQL = `INSERT INTO momentum_daily (day, part, body, updated_at)
SELECT json_extract(value, '$.day'), json_extract(value, '$.part'), json_extract(value, '$.body'), ?2 FROM json_each(?1) WHERE true
ON CONFLICT(day, part) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`;
export const SAVE_SQL = `INSERT INTO momentum (key, body, updated_at)
SELECT json_extract(value, '$.key'), json_extract(value, '$.body'), ?2 FROM json_each(?1) WHERE true
ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`;
// Summary rows of an older, bigger run that this run did not write again.
export const STALE_SQL = `DELETE FROM momentum WHERE ((key >= 'board:' AND key < 'board;') OR (key >= 'tiktok:' AND key < 'tiktok;'))
  AND key NOT IN (SELECT value FROM json_each(?1))`;

const PHOTO_RETRY_DAYS = 7; // a photo that could not be read is tried again after this long
const PHOTO_MAX = 1500; // photos fingerprinted per run: the rest the next run
const BATCH = 40; // photos per trip to the browser
const jsonOf = (s, or) => {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' ? v : or;
  } catch (e) {
    return or;
  }
};
/** A short fingerprint of a photo's address: a new photo gets a new fingerprint of its own. */
const fpOf = (u) => {
  let h = 0x811c9dc5;
  for (const ch of String(u || '')) h = Math.imul(h ^ ch.codePointAt(0), 0x01000193) >>> 0;
  return h.toString(36);
};

/** Every row of a query, a slice at a time (one big answer can fail). The SELECT has a rowid AS rid and no WHERE. */
async function allRows(db, sql, args = [], size = 5000) {
  const out = [];
  for (let last = 0; ;) {
    const part = await db.query(`${sql} WHERE rowid > ?${args.length + 1} ORDER BY rowid LIMIT ${size}`, [...args, last]);
    out.push(...part);
    if (part.length < size) return out;
    last = part[part.length - 1].rid;
  }
}

/**
 * A photo, small, as base64 for the browser, or '' (not a photo, too big, did not answer). Shopify's CDN sends it 100 px
 * wide: enough for a fingerprint of 9 × 8.
 */
export async function photoOf(url, doFetch = globalThis.fetch) {
  const u = sized(url, 100);
  if (!u) return '';
  try {
    const res = await doFetch(u, { signal: AbortSignal.timeout(15000), redirect: 'follow', headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*' } });
    if (!res.ok || !/^image\//i.test(res.headers.get('content-type') || '')) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length && buf.length <= 3e6 ? buf.toString('base64') : '';
  } catch (e) {
    return '';
  }
}

/** Fingerprints for these items' photos: Map key → hash ('' when the photo could not be read). hasher: hashInPage in a browser. */
export async function hashPhotos(list, { hasher, doFetch = globalThis.fetch, now = Date.now, deadline = Infinity }) {
  const out = new Map();
  for (let i = 0; i < list.length && now() < deadline; i += BATCH) {
    const batch = [];
    await pool(list.slice(i, i + BATCH), 8, async (it) => {
      const b64 = await photoOf(it.img, doFetch);
      if (b64) batch.push({ k: it.key, b64 });
      else out.set(it.key, '');
    });
    if (!batch.length) continue;
    const got = await Promise.resolve().then(() => hasher(batch)).catch(() => []);
    const seen = new Set();
    for (const g of Array.isArray(got) ? got : []) {
      if (!g || typeof g.k !== 'string') continue;
      seen.add(g.k);
      out.set(g.k, /^[0-9a-f]{16}$/.test(g.h || '') ? g.h : '');
    }
    for (const b of batch) if (!seen.has(b.k)) out.set(b.k, ''); // the browser did not answer for it
  }
  return out;
}

/**
 * Google Trends for one product through SerpApi: { q, geo, at, ch, yoy, pk, now, s }, { …, none: 1 } (too few searches
 * to measure) or { …, error } (stop: the account cannot ask more). The key goes to SerpApi only, never into the log.
 */
export async function askTrends(item, { key, doFetch = globalThis.fetch, now = Date.now }) {
  const at = new Date(now()).toISOString();
  const q = trendsQuery(item.title, item.store);
  const geo = /^[A-Z]{2}$/.test(item.geo || '') ? item.geo : '';
  if (!q) return { q: '', geo, at, error: 'no search words in the title' };
  try {
    const res = await doFetch(trendsUrl(q, geo, key), { signal: AbortSignal.timeout(30000), headers: { Accept: 'application/json' } });
    const j = await res.json().catch(() => null);
    const err = j && j.error ? String(j.error) : '';
    if (/hasn.t returned any results|no results/i.test(err)) return { q, geo, at, none: 1 };
    if (!res.ok || !j || err) return { q, geo, at, error: (err || 'HTTP ' + res.status).slice(0, 200), stop: res.status === 401 || res.status === 429 || /run out|limit|invalid api key/i.test(err) };
    const t = trendsOf(j);
    return t ? { q, geo, at, ...t } : { q, geo, at, none: 1 };
  } catch (e) {
    return { q, geo, at, error: e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

/**
 * The run. deps: { db (lib/d1.mjs client), now, log, doFetch, serpKey (SerpApi, '' = no Google Trends), trendsMax,
 * trendsDays, hasher (hashInPage in a browser, or null), photoMax, deadline (ms) }. Returns the run's record.
 */
export async function run({ db, now = Date.now, log = console.log, doFetch = globalThis.fetch, serpKey = '', trendsMax = 5, trendsDays = 14, hasher = null, photoMax = PHOTO_MAX, deadline = Infinity }) {
  const t0 = now();
  const day = dayOf(t0);
  const iso = new Date(t0).toISOString();

  // ---- 1. the board's tables
  const [world, eu, tiktok, best, surv, decidedRows, launches, histRows, cacheRows] = await Promise.all([
    allRows(db, WORLD_SQL), allRows(db, EU_SQL, [new Date(t0 - 45 * DAY).toISOString()]), allRows(db, TIKTOK_SQL), allRows(db, BEST_SQL),
    db.query(SURVIVAL_SQL), db.query(DECIDED_SQL), db.query(LAUNCH_SQL), db.query(HISTORY_SQL, [dayOf(t0 - HISTORY_DAYS * DAY), day]), db.query(CACHE_SQL),
  ]);
  const cache = Object.fromEntries(cacheRows.map((r) => [r.key, jsonOf(r.body, {})]));
  const bestBy = new Map(best.map((b) => [b.product_key, b]));
  const survival = new Map(surv.map((s) => [s.product_key, s]));

  // Decided products, the shortlist for Google Trends first: launch cards (the pin, then go, then the newest), approved, starred.
  const keyOfAd = new Map();
  for (const w of world) keyOfAd.set(String(w.ad_id), 'world|' + w.product_key);
  for (const e of eu) keyOfAd.set(String(e.ad_id), 'eu|' + e.gk);
  const shortlist = [];
  const add = (k) => { if (k && !shortlist.includes(k)) shortlist.push(k); };
  const rank = (l) => (Number(l.pinned) === 1 ? 0 : l.decision === 'go' ? 1 : l.decision === 'no' ? 3 : 2);
  [...launches].sort((a, b) => rank(a) - rank(b) || String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).filter((l) => l.decision !== 'no').forEach((l) => add(l.product_key));
  const byAt = (a, b) => String(b.at || '').localeCompare(String(a.at || ''));
  decidedRows.filter((d) => d.kind === 'seen').sort(byAt).forEach((d) => add(keyOfAd.get(String(d.ad_id))));
  tiktok.filter((t) => t.decision === 'approved').sort((a, b) => String(b.decided_at || '').localeCompare(String(a.decided_at || ''))).forEach((t) => add('tiktok|' + t.id));
  decidedRows.filter((d) => d.kind === 'star').sort(byAt).forEach((d) => add(keyOfAd.get(String(d.ad_id))));
  const decided = new Set([...shortlist, ...launches.map((l) => l.product_key)]);
  const items = itemsOf({ world, eu, tiktok }, { best: bestBy, survival, decided, now: t0 });

  // ---- 2. the same item in other stores. Photo fingerprints are kept (table momentum, 'images') and only made for new photos.
  const old = cache.images || {};
  const images = {};
  const todo = [];
  for (const it of items) {
    const e = old[it.key];
    const fp = fpOf(it.img);
    if (Array.isArray(e) && e[1] === fp && (e[0] || (e[2] && daysBetween(e[2], day) < PHOTO_RETRY_DAYS))) {
      images[it.key] = e;
      if (e[0]) it.hash = e[0];
    } else if (it.img && (it.tracked || it.live)) todo.push(it);
  }
  todo.sort((a, b) => b.tracked - a.tracked);
  const photos = { cached: Object.keys(images).length, hashed: 0, failed: 0, left: 0, off: !hasher };
  if (hasher && todo.length) {
    const got = await hashPhotos(todo.slice(0, photoMax), { hasher, doFetch, now, deadline });
    for (const it of todo) {
      if (!got.has(it.key)) continue;
      const h = got.get(it.key);
      images[it.key] = h ? [h, fpOf(it.img)] : ['', fpOf(it.img), day];
      if (h) { it.hash = h; photos.hashed++; } else photos.failed++;
    }
    photos.left = todo.length - got.size;
  } else photos.left = todo.length;
  const rivals = rivalsOf(items, { now: t0 });

  // ---- 3. today's numbers, and the history up to today
  const tracked = items.filter((it) => it.tracked);
  const todayRows = new Map(tracked.map((it) => [it.key, { ...it.today, ...(rivals.has(it.key) ? { r: rivals.get(it.key).r } : {}) }]));
  const history = historyOf(histRows);
  const histOf = (k) => (history.get(k) || []).concat([[day, todayRows.get(k)]]);
  const days = new Set(histRows.map((r) => r.day)).size + 1;

  // ---- 4. Google Trends for the shortlist (SerpApi), each again after trendsDays days; a failure again after 2
  const trends = cache.trends || {};
  const trendsRun = { off: !serpKey, asked: 0, ok: 0, none: 0, failed: 0 };
  if (serpKey) {
    const byKey = new Map(items.map((it) => [it.key, it]));
    const due = shortlist.filter((k) => byKey.has(k)).filter((k) => {
      const t = trends[k];
      if (!t || !t.at || t.q !== trendsQuery(byKey.get(k).title, byKey.get(k).store)) return true;
      return daysBetween(dayOf(t.at), day) >= (t.error ? 2 : trendsDays);
    });
    for (const k of due.slice(0, Math.max(0, trendsMax))) {
      if (now() > deadline) break;
      const t = await askTrends(byKey.get(k), { key: serpKey, doFetch, now });
      trendsRun.asked++;
      if (t.error) {
        trendsRun.failed++;
        log(`Google Trends for "${t.q}": ${t.error}`);
        if (!trends[k] || trends[k].error) trends[k] = t; // a good answer stays until a new one comes
        if (t.stop) break;
        continue;
      }
      trends[k] = t;
      if (t.none) trendsRun.none++;
      else trendsRun.ok++;
    }
  }
  for (const k of Object.keys(trends)) if (!decided.has(k)) delete trends[k]; // no longer shortlisted

  // ---- 5. the summaries
  const board = new Map();
  const tt = new Map();
  const labels = { up: 0, flat: 0, down: 0, new: 0, stopped: 0 };
  const crowd = [0, 0, 0];
  const how = { words: 0, supplier: 0, look: 0 };
  for (const it of tracked) {
    const b = it.src === 'tiktok' ? null : bestBy.get(productKey(it.url) || (it.src === 'world' ? it.key.slice(6) : ''));
    const r = rivals.get(it.key) || null;
    const mo = summaryOf(it, histOf(it.key), { day, bsHistory: b && Number(b.ok) ? jsonOf(b.history, []) : null, rivals: r, trends: trends[it.key] || null });
    (it.src === 'tiktok' ? tt : board).set(it.key, mo);
    labels[scoreOf(mo).label]++;
    crowd[crowdOf(mo)]++;
    if (r) for (const k of Object.keys(how)) how[k] += r.how[k];
  }

  // ---- 6. writes: today's row (a second run today replaces it), the board's summaries, the job's memory, old days out
  const write = async (sql, rows) => {
    for (const part of chunks(rows, 50, 1.4e6)) await db.query(sql, [JSON.stringify(part), iso]);
  };
  const dayRows = splitMap(todayRows, 900000).map((body, part) => ({ day, part, body: JSON.stringify(body) }));
  await write(DAILY_SQL, dayRows);
  await db.query('DELETE FROM momentum_daily WHERE day = ?1 AND part >= ?2', [day, dayRows.length]);
  const record = {
    at: iso, day, days, ms: 0,
    tracked: { world: tracked.filter((it) => it.src === 'world').length, eu: tracked.filter((it) => it.src === 'eu').length, tiktok: tracked.filter((it) => it.src === 'tiktok').length },
    labels, busy: crowd[1], crowded: crowd[2], rivals_found_by: how, photos, trends: trendsRun,
  };
  const summaries = [...partsOf('board', board, { v: iso }), ...partsOf('tiktok', tt, { v: iso })];
  record.ms = now() - t0;
  await write(SAVE_SQL, [...summaries, { key: 'images', body: JSON.stringify(images) }, { key: 'trends', body: JSON.stringify(trends) }, { key: 'run', body: JSON.stringify(record) }]);
  await db.query(STALE_SQL, [JSON.stringify(summaries.map((s) => s.key))]);
  await db.query('DELETE FROM momentum_daily WHERE day < ?1', [dayOf(t0 - KEEP_DAYS * DAY)]);
  log(`Momentum ${day}: ${tracked.length} products (${record.tracked.world} outside the EU, ${record.tracked.eu} EU, ${record.tracked.tiktok} TikTok) · ${days} days of numbers`
    + ` · ${labels.up} rising, ${labels.flat} steady, ${labels.down} falling, ${labels.stopped} stopped, ${labels.new} too new · ${crowd[1]} getting crowded, ${crowd[2]} crowded`);
  log(`Rivals found by words ${how.words}, supplier photo ${how.supplier}, look ${how.look} · photos: ${photos.hashed} new fingerprints, ${photos.failed} unreadable, ${photos.left} left for later${photos.off ? ' (no browser)' : ''}`
    + ` · Google Trends: ${trendsRun.off ? 'off (no SERPAPI_KEY)' : `${trendsRun.ok} answered, ${trendsRun.none} too few searches, ${trendsRun.failed} failed`}`);
  return record;
}

/** The runner's Chrome (playwright-core, as the hunts) for photo fingerprints, or null when there is none. */
async function chromeHasher() {
  try {
    const { chromium } = await import('playwright-core').catch(() => import('playwright'));
    const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}));
    const page = await browser.newPage();
    return { hash: (list) => page.evaluate(hashInPage, list), close: () => browser.close().catch(() => {}) };
  } catch (e) {
    return null;
  }
}

const intEnv = (v, def, lo, hi) => Math.min(Math.max(Number.isFinite(Number(v)) && String(v).trim() !== '' ? Math.round(Number(v)) : def, lo), hi);

async function main() {
  const env = process.env;
  const s = d1Settings(env);
  if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)');
  const minutes = intEnv(env.MOMENTUM_MINUTES, 20, 1, 25);
  const chrome = await chromeHasher();
  if (!chrome) console.log('::notice::No browser for photo fingerprints: rivals are found by their words and supplier photos only');
  try {
    const t = await run({ db: d1Client(s), serpKey: String(env.SERPAPI_KEY || '').trim(), trendsMax: intEnv(env.TRENDS_MAX, 5, 0, 100), trendsDays: intEnv(env.TRENDS_DAYS, 14, 1, 90),
      hasher: chrome && chrome.hash, deadline: Date.now() + minutes * 60000 });
    if (env.GITHUB_STEP_SUMMARY) {
      const l = t.labels;
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n**Momentum ${t.day}:** ${l.up} rising, ${l.flat} steady, ${l.down} falling, ${l.stopped} stopped, ${l.new} too new; ${t.busy} getting crowded, ${t.crowded} crowded; ${t.days} days of numbers.`
        + ` Google Trends: ${t.trends.off ? 'off (no SERPAPI_KEY secret)' : `${t.trends.ok} answered, ${t.trends.none} too few searches, ${t.trends.failed} failed`}.\n`);
    }
  } finally {
    if (chrome) await chrome.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::Momentum: ${e.message}`);
    process.exitCode = 1;
  });
}
