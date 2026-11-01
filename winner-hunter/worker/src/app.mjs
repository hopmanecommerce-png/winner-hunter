/*
 * The Winner Hunter board: a PIN-protected page plus a tiny JSON API on top of D1 (binding DB).
 *   GET  /            board (or the PIN screen)        POST /login   PIN form → cookie
 *   GET  /api/ads     ads of a view, counts, last run, alert banner   POST /api/hide  seen / rejected / none, starred / unstarred
 *   GET  /export.csv  the current view as CSV           GET  /logout
 *   GET  /api/ad/:id  the ad itself (text, video/images, CTA) (adview.mjs; the board no longer uses it: off unless AD_VIEWER = "on")
 *   GET  /api/markets EU reach a day per country over the board's products (Market Radar); ?scope=world: facts per market outside the EU
 *   ?scope=world on /api/ads and /export.csv: the products outside the EU (world.mjs), judged by proof signals, not reach
 *   ?scope=google on /api/ads, /api/markets and /export.csv: the Google tab (google.mjs), each rule marked exact, approximated or not checked
 *   ?lasso=1 on /api/ads and /export.csv: only the products of stores that use the Lasso checkout (lasso.mjs)
 * All SQL is parameterized; sort orders come from a fixed list.
 */

import { tiktokDecide, tiktokList } from './tiktok.mjs';
import { AI_JS, aiList, aiPost } from './ai.mjs';
import { adView } from './adview.mjs';
import { TRAITS, AD_TRAITS, CHOICES, AD_CHOICES, SEP, YES_AT, VERSION } from './jev-questions.mjs';
import { MOMENTUM_JS, readMomentum, attachMomentum, momentumFactor, byMomentum, momentumCard, momentumApi } from './momentum.mjs';
import { MARKET_RULES } from './market-rules.mjs';
import { LAUNCH_JS, launchList, launchPost } from './launch.mjs';
import { SOURCING_JS, sourcingGet, sourcingPost } from './sourcing.mjs';
import { GOOGLE_SQL, TIKTOK_SHOPS_SQL, GOOGLE_CSV_COLS, googleRow, crossLink, googleProof, googleFacts, googleMarketsOf, googleAlert } from './google.mjs';
import { ECON_JS, econContext, econAd, econBoard, econSorts, econGet, econPost, decisionsGet, decisionsPost, decisionLogged, tiktokLogged } from './econ.mjs';
import { RISK_JS, riskChecks, riskHide, riskOut, riskList, riskPost } from './risk.mjs';
import { LASSO_JS, readLasso, attachLasso, lassoBoard, lassoView, lassoCard } from './lasso.mjs';
import { PIPELINE_JS, pipelineGet, pipelinePost, pipelineImage } from './pipeline.mjs';

const COOKIE = '__Host-wh';
const MAX_AGE = 90 * 864e2; // seconds
// The hard rules (same as lib/score.mjs): rows that fail any of them are never shown, counted or exported.
// Shopify is checked before a row is ever saved, so every row in D1 passed it.
export const MIN_ACTIVE_ADS = 75;
export const MIN_AGE_DAYS = 7; // measured when last seen, and today
export const MAX_AGE_DAYS = 42; // ad age today: the whole days since it started (ad_start_date)
export const MIN_REACH_PER_DAY = 500;
const PIN_TRIES = 10; // PIN tries per IP (IPv6: per /64) per 15 minutes, counted before the PIN is compared
const NET_TRIES = 30; // and per network around it (IPv6: /48, IPv4: /24)
const PIN_WINDOW = 15 * 60000;
const STALE_HOURS = 36; // the EU hunt only runs by hand: a run older than this no longer shows a banner, unless it hangs
const WORLD_STALE_HOURS = 24; // the hunt outside the EU runs every 6 hours
const TOKEN_DAYS = 7; // a Meta token expiring within this many days: red banner

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// One advertiser + one product title. Jev's answers on an EU product are kept under this key ('eu|' + it), and the SQL
// views below (the ad prefetch, Jev's queue) collapse duplicates by it. The board itself groups by the product page
// (groupKey below), so the same product under two titles or two advertisers is one product there.
// The first bound parameter of every query on BASE is "now" (ISO), for the ad age today.
const KEY = `COALESCE(w.advertiser_page_id, '') || '|' || lower(trim(COALESCE(NULLIF(w.product_title, ''), w.ad_id)))`;
const RPD = `CAST(COALESCE(w.reach_eu, 0) AS REAL) / MAX(COALESCE(w.ad_age_days, 0), 1)`;
// Age today: the whole days since the ad started (a UTC day). An old row without a start date: the age when last seen
// + the whole days since, which can be a day short.
const AGE_NOW = `COALESCE(CAST(julianday(?1) - julianday(NULLIF(w.ad_start_date, '')) AS INTEGER), COALESCE(w.ad_age_days, 0) + MAX(CAST(julianday(?1) - julianday(w.last_seen) AS INTEGER), 0))`;
// The age when measured must pass too: reach a day over a 5-day-old ad is not the same figure.
const PASS = `(COALESCE(w.active_ads, 0) >= ${MIN_ACTIVE_ADS} AND w.ad_age_days >= ${MIN_AGE_DAYS} AND ${AGE_NOW} BETWEEN ${MIN_AGE_DAYS} AND ${MAX_AGE_DAYS} AND ${RPD} >= ${MIN_REACH_PER_DAY})`;
const BASE = `WITH g AS (
  SELECT w.ad_id, w.product_title, w.price, w.compare_at_price, w.currency, w.advertiser, w.active_ads,
    w.ad_age_days, w.reach_eu, w.scaled_count, w.keyword, w.store_url, w.product_url, w.ad_library_url, w.image_url,
    w.first_seen, w.last_seen, w.data, ${RPD} AS rpd, ${AGE_NOW} AS age_now, ${PASS} AS pass,
    ROW_NUMBER() OVER (PARTITION BY ${KEY}, ${PASS} ORDER BY ${RPD} DESC, w.ad_id) AS rn,
    MAX(CASE h.status WHEN 'rejected' THEN 2 WHEN 'seen' THEN 1 ELSE 0 END) OVER (PARTITION BY ${KEY}) AS hid,
    MAX(s.ad_id IS NOT NULL) OVER (PARTITION BY ${KEY}) AS star,
    ROW_NUMBER() OVER (PARTITION BY ${KEY} ORDER BY ${PASS} DESC, ${RPD} DESC, w.ad_id) AS rk
  FROM winners w LEFT JOIN hidden h ON h.ad_id = w.ad_id LEFT JOIN stars s ON s.ad_id = w.ad_id
), v AS (
  SELECT * FROM g WHERE pass AND rn = 1
), k AS (
  SELECT * FROM g WHERE rk = 1
)`;
// v: the board (products that pass every rule). k: every product once, its best ad (passing first): the ★ list keeps
// a starred product after it ages out of the rules.

// ---------------------------------------------------------------------------
// The board's data: read the winners once, work everything out here
// ---------------------------------------------------------------------------
// D1's free plan stops at 5 million rows read a day, and every page used to scan the whole table several times.
// Now the winners are read in one plain scan and kept in memory; a two-row check per request (the newest row and
// the last run's save time) says when to read them again. Seen / rejected / starred are small tables, read on every
// request. The rules, products, views, counts and markets are worked out below, as the SQL BASE above does.

// An ad's top countries as Meta gives them: "FR 91%, BE 9%, LU 1%" (in data.top_countries).
export const parseCountries = (s) => [...String(s || '').matchAll(/\b([A-Z]{2}) (\d{1,3})%/g)].map((m) => [m[1], Math.min(100, Number(m[2]))]);

const SNAP_SQL = `SELECT w.ad_id, ${KEY} AS jk, w.product_title, w.price, w.compare_at_price, w.currency, w.advertiser, w.active_ads,
  w.ad_age_days, w.ad_start_date, w.reach_eu, w.scaled_count, w.keyword, w.store_url, w.product_url, w.ad_library_url, w.image_url,
  w.first_seen, w.last_seen, w.data FROM winners w`;
// Store signals (bestsellers.mjs, once a day), read with the winners and kept on each row: w.bs (best-seller rank)
// and w.tp (the store's Trustpilot score).
const BS_SQL = 'SELECT product_key, rank, ok, history FROM bestseller';
const TRUST_SQL = 'SELECT store, status, score, reviews, profile FROM store_trust';
// Outside the EU (world.mjs): products from the public Ad Library, with proof signals instead of reach. Read with the
// winners; they take part in ★, ✓, notes and decisions like any product, but stay off the EU tabs.
const WORLD_SQL = `SELECT w.* FROM world_products w`;
// The EU products Jev has no answers for yet, best reach a day first: one row per product, those on the board and those approved (✓). ?1 now, ?2 how many.
export const EU_TODO_SQL = `SELECT gk, product_title AS title, image_url, store_url, product_url, price, compare_at_price, currency, advertiser, keyword, ad_age_days AS days, scaled_count AS ads, data
FROM (SELECT w.*, ${KEY} AS gk, ${RPD} AS rpd, ROW_NUMBER() OVER (PARTITION BY ${KEY} ORDER BY (COALESCE(w.image_url, '') != '') DESC, ${RPD} DESC) AS rn
  FROM winners w WHERE ${PASS} OR w.ad_id IN (SELECT ad_id FROM hidden WHERE status = 'seen'))
WHERE rn = 1 AND ('eu|' || gk) NOT IN (SELECT product_key FROM world_checks WHERE COALESCE(version, 1) >= ${VERSION}) ORDER BY rpd DESC LIMIT ?2`;
export const EU_LEFT_SQL = EU_TODO_SQL.replace(/^SELECT .*? AS ads, data\n/, 'SELECT COUNT(*) AS n\n').replace(' ORDER BY rpd DESC LIMIT ?2', '');
const CHECK_SQL = 'SELECT product_key, people, animals, gymwear, physical, category, category_conf, input, checked_at, main, sub, main_conf, sub_conf, product_score, ad_score, answers, used FROM world_checks';
// world_data, not world_run: the hunt outside the EU saves its progress every few minutes, but only changes the board's table once.
// google_data: the Google hunt wrote google_products (google.mjs).
const VERSION_SQL = `SELECT (SELECT MAX(rowid) FROM winners) AS r, (SELECT updated_at FROM state WHERE key = 'last_run') AS u, (SELECT updated_at FROM state WHERE key = 'world_data') AS wu, (SELECT updated_at FROM state WHERE key = 'world_check') AS jc, (SELECT updated_at FROM state WHERE key = 'google_data') AS gd`;
const SNAP_MS = 15 * 60000; // read again after this long anyway
const SNAPS = new WeakMap(); // per D1 binding
let LAST = null; // on Cloudflare (one database): shared by the requests this isolate serves
// A read of the tables on its way. The board asks /api/ads and /api/markets at the same moment: on a fresh isolate
// both need the tables, and one read serves both (half the D1 rows read, no second wait).
const READING = new WeakMap(); // per D1 binding
let READ = null; // on Cloudflare, as LAST

/** All winners rows, read again only when a run saved something (or after 15 minutes). */
export async function snapshot(DB, now = Date.now()) {
  const v = await DB.prepare(VERSION_SQL).first();
  const ver = `${v && v.r}|${v && v.u}|${v && v.wu}|${v && v.jc}|${v && v.gd}`;
  const shared = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
  let s = SNAPS.get(DB) || (shared ? LAST : null);
  if (!s || s.ver !== ver || now - s.at > SNAP_MS || now < s.at) {
    let r = READING.get(DB) || (shared ? READ : null);
    if (!r || r.ver !== ver) {
      r = { ver, rows: readTables(DB) };
      READING.set(DB, r);
      if (shared) READ = r;
      const done = () => {
        if (READING.get(DB) === r) READING.delete(DB);
        if (READ === r) READ = null;
      };
      r.rows.then(done, done); // a failed read is not kept: the next request reads again
    }
    s = { ver, at: now, rows: await r.rows };
    SNAPS.set(DB, s);
    if (shared) LAST = s;
  }
  return s.rows;
}

/**
 * The board's product: the product page the ad links to (store domain + handle, as productKey), so the same product
 * under two titles or two advertisers is one product: one decision, one note. An ad without a product page: its
 * advertiser + title (KEY), as before.
 */
export const groupKey = (w) => productKey(w.product_url) || w.jk;

async function readTables(DB) {
  // A table that is not there yet (an older database): the board works without it. Any other error fails the read, so
  // it is not kept: a brief D1 error must not hide ranks, Trustpilot, Jev or the products outside the EU for 15 minutes.
  const optional = (sql) => DB.prepare(sql).all().then((r) => r.results || [], (e) => {
    if (/no such (table|column)/i.test(String(e && e.message))) return [];
    throw e;
  });
  const [{ results: eu }, bs, tp, world, jev, google] = await Promise.all([DB.prepare(SNAP_SQL).all(), optional(BS_SQL), optional(TRUST_SQL), optional(WORLD_SQL), optional(CHECK_SQL), optional(GOOGLE_SQL)]);
  const checks = new Map(jev.map((c) => [c.product_key, c]));
  for (const w of eu) {
    w.gk = groupKey(w);
    const c = checks.get('eu|' + w.jk);
    w.jev = c ? checkOf(c) : null;
  }
  const worlds = world.map((w) => worldRow(w, checks.get(w.product_key)));
  // Google (google.mjs): Jev's answer under 'google|' + its product page, else the one outside the EU for the same page.
  // Who shows the same product or shop on Meta or TikTok, both ways: read only when there are Google products.
  const googles = google.map((g) => { const c = checks.get('google|' + g.product_key) || checks.get(g.product_key); return googleRow(g, c ? checkOf(c) : null); });
  if (googles.length) crossLink(googles, eu.concat(worlds), await optional(TIKTOK_SHOPS_SQL), { key: productKey, store: storeOf });
  const results = eu.concat(worlds, googles);
  const best = new Map(bs.map((b) => [b.product_key, b]));
  const trust = new Map(tp.map((t) => [t.store, t]));
  for (const w of results) {
    const key = productKey(w.product_url);
    const b = best.get(key);
    if (b) w.bs = b;
    const t = trust.get(key.split('/')[0] || storeOf(w.store_url));
    if (t) w.tp = t;
  }
  attachMomentum(results, await readMomentum(DB)); // momentum.mjs: the daily trend summaries (w.mo), a few rows, not one per product
  attachLasso(results, await readLasso(DB)); // lasso.mjs: the product's store uses the Lasso checkout (w.lasso)
  return results;
}

// ---------------------------------------------------------------------------
// Store best sellers: proof that a product sells (its rank in its own store's best-seller list, top 50).
// productKey and movement are the same as in lib/bestsellers.mjs.
// ---------------------------------------------------------------------------

/** 'store.com/products/handle' for a product page (locale prefix and query dropped), else ''. */
export function productKey(u) {
  let x;
  try {
    x = new URL(u);
  } catch (e) {
    return '';
  }
  if (!/^https?:$/.test(x.protocol)) return '';
  const m = /\/products\/([^/?#]+)/.exec(x.pathname);
  if (!m) return '';
  let handle = m[1];
  try {
    handle = decodeURIComponent(handle);
  } catch (e) {
    // keep it as it is
  }
  handle = handle.replace(/\.(js|json)$/i, '').toLowerCase();
  const host = x.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\d?\./, '');
  return handle && host ? `${host}/products/${handle}` : '';
}

/** How the rank moved over about a week: { from, to, days } (from null: it was not in the top 50 then), or null. */
export function movement(history) {
  const h = Array.isArray(history) ? history : [];
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  const daysBack = (e) => Math.round((Date.parse(last[0]) - Date.parse(e[0])) / 864e5);
  const base = [...h].reverse().find((e) => daysBack(e) >= 7) || (daysBack(h[0]) >= 2 ? h[0] : null);
  return base ? { from: base[1], to: last[1], days: daysBack(base) } : null;
}

/** For the card: { rank (null: not in the store's top 50), move: { from, days } | null }, or null when unknown. */
export function bestOf(b) {
  if (!b || !Number(b.ok)) return null;
  let h = [];
  try {
    h = JSON.parse(b.history || '[]');
  } catch (e) {
    h = [];
  }
  const m = movement(h);
  return { rank: b.rank == null ? null : Number(b.rank), move: m ? { from: m.from, days: m.days } : null };
}

/**
 * For the card: the store's Trustpilot facts { status, score, reviews, profile }, or null. status: 'page' (its
 * Trustpilot page) or 'widget' (a real widget on the store) with a score; 'nopage': not on Trustpilot; 'badge' and
 * 'none': only the store was checked (it names Trustpilot without a real widget, or not at all).
 */
export function trustOf(t) {
  if (!t || !['page', 'widget', 'nopage', 'badge', 'none'].includes(t.status)) return null;
  const n = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
  return { status: t.status, score: n(t.score), reviews: n(t.reviews), profile: t.profile || '' };
}

// ---------------------------------------------------------------------------
// Outside the EU: no reach figure exists there, so a product shows which proof signals it has. Each threshold is a
// plain fact on the card. Checked against the EU board, where reach is known: products with more ad copies, more
// shop ads, a store best-seller rank or more Trustpilot reviews get more reach a day (research/2026-10-31-*, product
// research repo). Age could not be checked there (the EU board only holds ads up to 42 days).
// ---------------------------------------------------------------------------
export const WORLD_MARKETS = ['CH', 'NO', 'AU', 'NZ', 'AE', 'US', 'CA', 'SG', 'JE', 'HK', 'MO', 'JP', 'KR', 'MY', 'TW', 'IL', 'LI']; // same as lib/world.mjs MARKETS
export const PROOF = { days: 30, ads: 5, markets: 2, shop: 75, reviews: 100 };
const jsonOf = (s, or) => { try { return JSON.parse(s || '') ?? or; } catch (e) { return or; } };

/** A world_products row in the shape of a winners row (reach_eu empty, ad_age_days the age of its oldest running ad). */
export function worldRow(w, check) {
  const jev = check ? checkOf(check) : null;
  return { ...w, jev, gk: 'world|' + w.product_key, ad_age_days: w.days, reach_eu: null, scaled_count: w.ads, active_ads: w.shop_ads, data: '{}',
    world: { markets: jsonOf(w.markets, {}), creatives: num(w.creatives), new14: num(w.new14), in_eu: w.in_eu == null ? null : Number(w.in_eu), eu_rpd: w.eu_rpd == null ? null : Number(w.eu_rpd), shop_eu_rpd: w.shop_eu_rpd == null ? null : Number(w.shop_eu_rpd),
      likes: w.likes == null ? null : Number(w.likes), page_id: w.page_id || '', active: Number(w.active) !== 0, store_products: w.store_products == null ? null : Number(w.store_products) } };
}

/** A world_checks row for the board. An answer from the first, smaller question set has only the four rules and a category. */
function checkOf(c) {
  const a = jsonOf(c.answers, {});
  const p = { people: num(c.people), animals: num(c.animals), gymwear: num(c.gymwear), physical: num(c.physical), ...(a.p || {}) };
  return { ...p, p, main: c.main || c.category || '', sub: c.sub || '', main_conf: c.main_conf == null ? null : Number(c.main_conf), sub_conf: c.sub_conf == null ? null : Number(c.sub_conf),
    product_score: c.product_score == null ? null : Number(c.product_score), ad_score: c.ad_score == null ? null : Number(c.ad_score),
    choices: Object.fromEntries(Object.entries(a.choices || {}).map(([k, x]) => [k, x && x.c])), used: c.used || '', input: c.input || '', at: c.checked_at || '' };
}

/** What Jev says about a product against the board's rules: the questions it answered yes to (0.5 or more). */
export function jevFlags(c) {
  if (!c) return [];
  const face = c.p ? c.p.face : c.face;
  return [['people', c.people >= YES_AT], ['animals', c.animals >= YES_AT], ['gymwear', c.gymwear >= YES_AT], ['digital', c.physical < YES_AT], ['face', face >= YES_AT]].filter((x) => x[1]).map((x) => x[0]);
}
const jevUnsure = (c) => !!c && [c.people, c.animals, c.gymwear, c.physical].some((v) => v > 0.15 && v < 0.85);
const yesTo = (c, k) => !!c && !!c.p && c.p[k] >= YES_AT;
const BLOCKERS = TRAITS.filter((t) => t.group === 'blockers').map((t) => t.k);
/** The board's Jev filter: clean, noblock, unsure, none, one of jevFlags, main:, sub:, yes:<trait>, choice:<k>:<v>, pmin: or amin:. */
export function jevMatches(want, c) {
  if (want === 'none') return !c;
  if (!c) return false;
  if (want === 'clean') return !jevFlags(c).length;
  if (want === 'unsure') return jevUnsure(c);
  if (want === 'noblock') return !BLOCKERS.some((k) => yesTo(c, k));
  const [kind, ...rest] = want.split(':');
  const v = rest.join(':');
  if (kind === 'main') return c.main === v;
  if (kind === 'sub') return `${c.main}${SEP}${c.sub}` === v;
  if (kind === 'yes') return yesTo(c, v);
  if (kind === 'choice') return c.choices[rest[0]] === rest.slice(1).join(':');
  if (kind === 'pmin') return c.product_score != null && c.product_score >= Number(v);
  if (kind === 'amin') return c.ad_score != null && c.ad_score >= Number(v);
  return jevFlags(c).includes(want);
}

// What makes a product harder to sell from here ranks it lower in the Inbox, by Jev's yes answers (0.5 or more): people
// or pets take it × 0.3, returns, health claims, brands and shipping limits × 0.5 each, the rest × 0.8 each; never
// below × 0.2. An EU product people or pets take stays out of the Inbox (Browse still lists it, with its tag).
export const RISK = { people: 0.3, animals: 0.3, sizing: 0.5, medical: 0.5, brand: 0.5, restricted: 0.5, kids: 0.8, skin: 0.8, electric: 0.8, fragile: 0.8, bulky: 0.8 };
export const RISK_FLOOR = 0.2;
const RED_RISKS = ['restricted', 'medical', 'skin']; // a red tag on the card
const TRAIT_LABEL = Object.fromEntries(TRAITS.map((t) => [t.k, t.label]));
/** { x: the Inbox factor, why: [{ k, label, x }], red: [keys] }, or null without an answer. */
export function riskOf(c) {
  if (!c) return null;
  const yes = (k) => !!c.p && c.p[k] >= YES_AT;
  const why = Object.entries(RISK).filter(([k]) => yes(k)).map(([k, x]) => ({ k, label: TRAIT_LABEL[k], x }));
  return { x: Math.round(Math.max(RISK_FLOOR, why.reduce((f, w) => f * w.x, 1)) * 1000) / 1000, why, red: RED_RISKS.filter(yes) };
}
const takenIn = (r) => !r.world && !!r.jev && !!r.jev.p && (r.jev.p.people >= YES_AT || r.jev.p.animals >= YES_AT);

/** For the board's breakdown and filter: how many undecided products have each answer. Sorted by count, nothing is picked. */
export function jevSummary(rows) {
  const count = (items) => [...items.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  const mains = new Map();
  const subs = new Map();
  const choices = new Map();
  let checked = 0;
  let pStrong = 0;
  let aStrong = 0;
  let noBlock = 0;
  const yes = new Map();
  for (const r of rows) {
    const c = r.jev;
    if (!c) continue;
    checked++;
    mains.set(c.main, (mains.get(c.main) || 0) + 1);
    if (c.sub) {
      if (!subs.has(c.main)) subs.set(c.main, new Map());
      subs.get(c.main).set(c.sub, (subs.get(c.main).get(c.sub) || 0) + 1);
    }
    for (const [k, v] of Object.entries(c.p)) if (v >= YES_AT) yes.set(k, (yes.get(k) || 0) + 1);
    for (const [k, v] of Object.entries(c.choices)) {
      if (!choices.has(k)) choices.set(k, new Map());
      choices.get(k).set(v, (choices.get(k).get(v) || 0) + 1);
    }
    if (c.product_score >= 3) pStrong++;
    if (c.ad_score >= 3) aStrong++;
    if (c.p && !BLOCKERS.some((k) => c.p[k] >= YES_AT)) noBlock++;
  }
  const group = (g, list = TRAITS) => list.filter((t) => t.group === g).map((t) => ({ k: t.k, label: t.label, n: yes.get(t.k) || 0 })).sort((a, b) => b.n - a.n);
  const allChoices = { ...CHOICES, ...AD_CHOICES };
  return { total: rows.length, checked, noBlock, pStrong, aStrong,
    mains: count(mains).map((m) => ({ ...m, subs: count(subs.get(m.name) || new Map()) })),
    blockers: group('blockers'), product: group('product'), ad: group('ad', AD_TRAITS),
    rules: group('rules').filter((t) => t.k !== 'physical'),
    choices: Object.entries(allChoices).map(([k, c]) => ({ k, label: c.label, items: count(choices.get(k) || new Map()) })) };
}

/** The proof signals of one product: [{ k, ok, text }]; ok null: not known (yet). n: how many it has. */
export function proofOf(r) {
  const m = Object.keys(r.world.markets);
  const age = num(r.age_now ?? r.ad_age_days);
  const rank = bsRank(r);
  const known = r.bs && Number(r.bs.ok);
  const tp = r.tp && (r.tp.status === 'page' || r.tp.status === 'widget') ? num(r.tp.reviews) : null;
  const tpKnown = !!r.tp && ['page', 'widget', 'nopage'].includes(r.tp.status); // badge and none: only the store was read, not Trustpilot
  const items = [
    { k: 'days', ok: age >= PROOF.days, text: `Oldest ad running ${age} days (${PROOF.days}+)` },
    { k: 'ads', ok: num(r.scaled_count) >= PROOF.ads, text: `${num(r.scaled_count)} ads for this product (${PROOF.ads}+)` },
    { k: 'markets', ok: m.length >= PROOF.markets, text: `In ${m.length} of ${WORLD_MARKETS.length} markets (${PROOF.markets}+)` },
    { k: 'shop', ok: r.active_ads == null ? null : num(r.active_ads) >= PROOF.shop, text: r.active_ads == null ? 'Shop\'s active ads not counted yet' : `Shop runs ${num(r.active_ads)} active ads (${PROOF.shop}+)` },
    { k: 'best', ok: known ? rank != null : null, text: !known ? 'Store best-seller list not read yet' : rank != null ? `#${rank} best seller in its store` : 'Not in its store\'s top 50' },
    { k: 'trust', ok: !tpKnown ? null : (tp ?? 0) >= PROOF.reviews, text: !tpKnown ? 'Trustpilot not checked yet' : `${tp ?? 0} Trustpilot reviews (${PROOF.reviews}+)` },
  ];
  return { n: items.filter((i) => i.ok).length, of: items.length, items };
}

const bsRank = (r) => (r.bs && Number(r.bs.ok) && r.bs.rank != null ? Number(r.bs.rank) : null);
/** How many products its store sells, when known (EU: the hunt's store check; outside the EU: the scan). */
export function storeSize(r) {
  const n = r.world ? r.world.store_products : r.google ? r.google.store_products : dataOf(r).store_products;
  return n == null || !Number.isFinite(Number(n)) ? null : Number(n);
}
/**
 * The inbox puts products that sell first, by their rank among what their store sells: × 1.5 in its top 10 and top 2%,
 * × 1.2 in its top 50 and top 10%. In a store of 8 products every product is in its top 10, so the rank says little
 * there; with the store's size unknown, no boost.
 */
export const sellsBoost = (r) => {
  const k = bsRank(r);
  const n = storeSize(r);
  if (k == null || !(n > 0)) return 1;
  return k <= 10 && k <= 0.02 * n ? 1.5 : k <= 50 && k <= 0.1 * n ? 1.2 : 1;
};

const num = (x) => Number(x) || 0;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const better = (a, b) => b.rpd - a.rpd || cmp(a.ad_id, b.ad_id); // < 0: a first
/** A winners row's data column (the full record), read once per row. */
function dataOf(w) {
  if (!w._d) {
    try { w._d = JSON.parse(w.data || '{}') || {}; } catch (e) { w._d = {}; }
  }
  return w._d;
}
function countriesOf(w) {
  if (!w._mk) w._mk = parseCountries(dataOf(w).top_countries);
  return w._mk;
}

/** An EU ad's age today: the whole days since it started; an old row without a start date, its age when last seen + the days since. */
export function ageNow(w, now) {
  const start = Date.parse(w.ad_start_date || '');
  if (Number.isFinite(start)) return Math.trunc((now - start) / 864e5);
  const seen = Date.parse(w.last_seen);
  return Number.isFinite(seen) ? num(w.ad_age_days) + Math.max(Math.trunc((now - seen) / 864e5), 0) : null;
}

/**
 * The rules at `now`, one product per product page (groupKey), with its status. v: the board (each product's best
 * passing ad: most reach a day). k: every product once, its best ad (passing first): the ★ and ✓ Made ad lists keep
 * a product after it ages out of the rules. w: the products outside the EU that still run. ids: the ads of each product (gk), for /api/hide. hat: when it was
 * marked seen (made ad) or rejected. byAd: ad id → its product's group.
 */
export function products(rows, hidden = [], stars = [], now = Date.now()) {
  const hidOf = new Map(hidden.map((h) => [h.ad_id, { hid: h.status === 'rejected' ? 2 : h.status === 'seen' ? 1 : 0, at: h.at || '' }]));
  const starred = new Set(stars.map((x) => x.ad_id));
  const groups = new Map();
  const byAd = new Map();
  for (const w of rows) {
    // A product outside the EU: its age was worked out at the scan, and its ad may have been last seen days before that.
    const age = w.world ? num(w.ad_age_days) : ageNow(w, now);
    const rpd = num(w.reach_eu) / Math.max(num(w.ad_age_days), 1);
    // A product from outside the EU has no reach: it is judged by its proof signals and never reaches the EU tabs.
    const pass = !w.world && !w.google && num(w.active_ads) >= MIN_ACTIVE_ADS && w.ad_age_days != null && num(w.ad_age_days) >= MIN_AGE_DAYS && age != null && age >= MIN_AGE_DAYS && age <= MAX_AGE_DAYS && rpd >= MIN_REACH_PER_DAY ? 1 : 0;
    // A Google product (google.mjs) passed its rules when the hunt checked it; today its ad must still be 7–42 days old.
    const gpass = w.google && w.google.active && age != null && age >= MIN_AGE_DAYS && age <= MAX_AGE_DAYS ? 1 : 0;
    const r = Object.assign({}, w, { rpd, age_now: age, pass: w.world ? w.world.active : w.google ? gpass : pass, mk: countriesOf(w) });
    if (w.world) r.proof = proofOf(r);
    if (w.google) r.proof = googleProof(r, bsRank(r));
    let g = groups.get(w.gk);
    if (!g) groups.set(w.gk, (g = { hid: 0, hat: '', star: 0, best: null, any: null, ids: [], jev: null }));
    g.ids.push(w.ad_id);
    byAd.set(w.ad_id, g);
    if (!g.jev && w.jev) g.jev = w.jev;
    // One decision per product. Ads that used to be two products (two titles) can each have one: the latest counts.
    const h = hidOf.get(w.ad_id);
    if (h && (h.at > g.hat || (h.at === g.hat && h.hid > g.hid))) { g.hid = h.hid; g.hat = h.at; }
    if (starred.has(w.ad_id)) g.star = 1;
    if (pass && (!g.best || better(r, g.best) < 0)) g.best = r;
    if (!g.any || pass > g.any.pass || (pass === g.any.pass && better(r, g.any) < 0)) g.any = r;
  }
  const v = [];
  const k = [];
  const w = [];
  const gl = [];
  for (const g of groups.values()) {
    // Jev answered per advertiser + title: the product shows the answer of its best ad, else of another ad of it.
    if (g.best) v.push(Object.assign(g.best, { hid: g.hid, hat: g.hat, star: g.star, jev: g.best.jev || g.jev }));
    k.push(g.any === g.best ? g.any : Object.assign(g.any, { hid: g.hid, hat: g.hat, star: g.star, jev: g.any.jev || g.jev }));
    if (g.any.world && g.any.world.active) w.push(g.any);
    if (g.any.google && g.any.pass) gl.push(g.any); // gl: the Google tab
  }
  return { v, k, w, gl, groups, byAd };
}

// Every decision (all of them: an old "Bad store" must stay undoable), for what the board learns.
const DECIDED_SQL = "SELECT ad_id, action, reasons, store, price, currency FROM feedback WHERE action IN ('seen', 'rejected', 'keep')";

/** The board from D1: winners (cached, also as rows: every ad as read), seen / rejected and stars (fresh). */
async function board(env, now) {
  const [rows, h, s, f] = await Promise.all([
    snapshot(env.DB, now),
    env.DB.prepare('SELECT ad_id, status, at FROM hidden').all(),
    env.DB.prepare('SELECT ad_id FROM stars').all(),
    env.DB.prepare(DECIDED_SQL).all(),
  ]);
  const list = products(rows, h.results, s.results, now);
  return Object.assign(list, { rows, taste: tasteOf(withFacts(f.results, list.byAd)) });
}

/**
 * Decisions with what the board knows of their product now: Jev's category (its niche: the answer its card shows, so
 * learning trains the category you saw) and, for older rows, its currency. Call after products(): it sets the cards' answers.
 */
function withFacts(fb, byAd) {
  return fb.map((f) => {
    const g = byAd.get(f.ad_id);
    const shown = g && (g.best || g.any);
    return Object.assign({}, f, { niche: (shown && shown.jev && shown.jev.main) || '', currency: f.currency || (shown && shown.currency) || '' });
  });
}

// ---------------------------------------------------------------------------
// Feedback: why you reject, keep or make an ad for a product. The board learns from it (tasteOf).
// ---------------------------------------------------------------------------

export const REASONS = {
  bad: { price: 'Too expensive', saturated: 'Saturated', niche: 'Not my niche', quality: 'Looks low quality', store: 'Bad store', ship: 'Hard to ship', ad: 'Weak ad' },
  good: { wow: 'Wow product', margin: 'Good margin', ad: 'Strong ad', niche: 'My niche', easy: 'Easy to ship' },
};
const ACTION_OF = { seen: 'seen', rejected: 'rejected', starred: 'keep' };
const DECISIONS = new Set(Object.values(ACTION_OF));
const reasonsOf = (s) => { try { const r = JSON.parse(s || '[]'); return Array.isArray(r) ? r.map(String) : []; } catch (e) { return []; } };
export const storeOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; } };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const PRIOR = 2; // a niche starts as if it had 2 decisions at your usual approval rate
const NO_PRICE = 0.75; // a product without a price, while you have a price limit for it

/**
 * What your decisions say. fb: decisions with niche (Jev's main category of the product) and currency (withFacts).
 * Niche: a yes (✓, or an old ★) counts for its niche; a no only when the reason was "Not my niche" (a price, a bad
 * store or a weak ad says nothing about the niche). A niche's weight is its approval rate against your overall rate,
 * smoothed, between 0.3 and 3: 1 is as usual. The search keyword that found an ad is not learned (it is often an accident).
 * Stores rejected as "Bad store" leave the inbox. Price, per currency: once two products in one currency were "too
 * expensive", everything in that currency from the cheapest of those up ranks at half.
 */
export function tasteOf(fb = []) {
  const niches = new Map();
  const blocked = new Map();
  const pricey = new Map();
  let yes = 0;
  let no = 0;
  for (const f of fb) {
    if (!DECISIONS.has(f.action)) continue; // notes and board notes are not decisions
    const r = reasonsOf(f.reasons);
    const bad = f.action === 'rejected';
    if (!bad || r.includes('niche')) {
      if (bad) no++;
      else yes++;
      const niche = String(f.niche || '').trim();
      if (niche) {
        const x = niches.get(niche) || { good: 0, bad: 0 };
        if (bad) x.bad++;
        else x.good++;
        niches.set(niche, x);
      }
    }
    if (bad && r.includes('store') && storeOf(f.store)) blocked.set(storeOf(f.store), (blocked.get(storeOf(f.store)) || 0) + 1);
    const cur = String(f.currency || '').trim().toUpperCase();
    if (bad && r.includes('price') && Number(f.price) > 0 && cur) {
      if (!pricey.has(cur)) pricey.set(cur, []);
      pricey.get(cur).push(Number(f.price));
    }
  }
  const rate = (yes + 1) / (yes + no + 2); // your approval rate, never quite 0 or 1
  const weights = new Map([...niches].map(([k, x]) => [k, Math.round(clamp((x.good + PRIOR * rate) / (x.good + x.bad + PRIOR) / rate, 0.3, 3) * 100) / 100]));
  const maxPrice = new Map([...pricey].filter(([, p]) => p.length >= 2).map(([c, p]) => [c, Math.min(...p)]));
  return { niches, weights, blocked, maxPrice, rate };
}

/**
 * How well a product fits what you taught the board: { x (1 = no opinion yet), niche: { name, w } or null, why: [{ text, x }] }.
 * A price is only compared with your limit in its own currency; a product without a price, while you have a limit
 * for it, ranks at three quarters (and says so) instead of slipping through.
 */
export function fitWhy(r, taste) {
  const out = { x: 1, niche: null, why: [] };
  if (!taste) return out;
  const name = r.jev && r.jev.main;
  const w = name ? taste.weights.get(name) : undefined;
  if (w != null && w !== 1) {
    out.niche = { name, w };
    out.why.push({ text: `${w > 1 ? 'Your niche' : 'Not your niche'}: ${name}`, x: w });
  }
  const cur = String(r.currency || '').trim().toUpperCase();
  const limit = cur ? taste.maxPrice.get(cur) : null;
  const price = Number(r.price);
  if (price > 0 && limit != null && price >= limit) out.why.push({ text: `Too expensive for you: ${cur} ${limit} and up`, x: 0.5 });
  else if (!(price > 0) && (cur ? limit != null : taste.maxPrice.size > 0)) out.why.push({ text: 'No price to check against your price limit', x: NO_PRICE });
  out.x = Math.round(out.why.reduce((f, y) => f * y.x, 1) * 1000) / 1000;
  return out;
}
/** The inbox sorts by reach a day × this. */
export const fitOf = (r, taste) => fitWhy(r, taste).x;

/** An Inbox row with its score: base (reach a day, or proof outside the EU) × what you taught it × best seller × Jev's risk, and why. */
function ranked(r, taste, base, boost = 1, extra = null) {
  const fit = fitWhy(r, taste);
  const risk = riskOf(r.jev);
  const x = fit.x * boost * (risk ? risk.x : 1) * (extra ? extra.x : 1); // extra: momentum.mjs's factor, { x, why }
  const why = [...fit.why, ...(boost !== 1 ? [{ text: 'Store best seller', x: boost }] : []), ...(risk ? risk.why.map((y) => ({ text: y.label, x: y.x })) : []), ...(extra ? extra.why : [])];
  return Object.assign({}, r, { fit: fit.x, niche: fit.niche, score: base * x, ranked: { x: Math.round(x * 1000) / 1000, why } });
}

const SORTS = {
  rpd: better,
  new: (a, b) => cmp(b.first_seen ?? '', a.first_seen ?? '') || b.rpd - a.rpd,
  scaled: (a, b) => num(b.scaled_count) - num(a.scaled_count) || b.rpd - a.rpd,
  ads: (a, b) => num(b.active_ads) - num(a.active_ads) || b.rpd - a.rpd,
  reach: (a, b) => num(b.reach_eu) - num(a.reach_eu) || b.rpd - a.rpd,
  best: (a, b) => (bsRank(a) ?? 999) - (bsRank(b) ?? 999) || better(a, b),
  jevp: (a, b) => num(b.jev && b.jev.product_score) - num(a.jev && a.jev.product_score) || better(a, b),
  jeva: (a, b) => num(b.jev && b.jev.ad_score) - num(a.jev && a.jev.ad_score) || better(a, b),
  ...econSorts(better), // profit, beroas: most margin per order, lowest break-even ROAS (econ.mjs)
};

// Outside the EU: the most proof first; every other order is one plain fact.
const stronger = (a, b) => b.proof.n - a.proof.n || num(b.scaled_count) - num(a.scaled_count) || num(b.age_now) - num(a.age_now) || cmp(a.ad_id, b.ad_id);
const WORLD_SORTS = {
  proof: stronger,
  days: (a, b) => num(b.age_now) - num(a.age_now) || stronger(a, b),
  ads: (a, b) => num(b.scaled_count) - num(a.scaled_count) || stronger(a, b),
  markets: (a, b) => Object.keys(b.world.markets).length - Object.keys(a.world.markets).length || stronger(a, b),
  shop: (a, b) => num(b.active_ads) - num(a.active_ads) || stronger(a, b),
  fresh: (a, b) => num(b.world.new14) - num(a.world.new14) || stronger(a, b),
  best: (a, b) => (bsRank(a) ?? 999) - (bsRank(b) ?? 999) || stronger(a, b),
  reviews: (a, b) => num(b.tp && b.tp.reviews) - num(a.tp && a.tp.reviews) || stronger(a, b),
  jevp: (a, b) => num(b.jev && b.jev.product_score) - num(a.jev && a.jev.product_score) || stronger(a, b),
  jeva: (a, b) => num(b.jev && b.jev.ad_score) - num(a.jev && a.jev.ad_score) || stronger(a, b),
  eu: (a, b) => num(b.world.eu_rpd ?? b.world.shop_eu_rpd) - num(a.world.eu_rpd ?? a.world.shop_eu_rpd) || stronger(a, b),
  new: (a, b) => cmp(b.first_seen ?? '', a.first_seen ?? '') || stronger(a, b),
  ...econSorts(stronger), // profit, beroas (econ.mjs)
};

/** The products outside the EU: filters, one market (?cc=AU), sort and page. The Inbox: most proof first, × what you taught the board × Jev's risks. */
function worldView(p, list, csv) {
  const view = p.get('view') === 'inbox' ? 'inbox' : 'all';
  const hidden = view === 'all' && p.get('hidden') === '1';
  let out = list.w.filter((r) => (view === 'inbox' ? inboxOk(r, list.taste) : hidden ? r.hid > 0 : r.hid === 0));
  const cc = String(p.get('cc') || '').toUpperCase();
  if (WORLD_MARKETS.includes(cc)) out = out.filter((r) => r.world.markets[cc]);
  if (p.get('noteu') === '1') out = out.filter((r) => r.world.in_eu === 0);
  if (p.get('p4') === '1') out = out.filter((r) => r.proof.n >= 4);
  if (p.get('fresh') === '1') out = out.filter((r) => r.world.new14 > 0);
  if (p.get('jev')) out = out.filter((r) => jevMatches(String(p.get('jev')).slice(0, 80), r.jev));
  const q = String(p.get('q') || '').trim().slice(0, 80).toLowerCase();
  if (q) out = out.filter((r) => [r.product_title, r.advertiser, r.store_url, r.keyword].some((x) => String(x ?? '').toLowerCase().includes(q)));
  if (view === 'inbox') out = out.map((r) => ranked(r, list.taste, r.proof.n + 1, 1, momentumFactor(r))).sort((a, b) => b.score - a.score || stronger(a, b));
  else out.sort(Object.hasOwn(WORLD_SORTS, p.get('sort') || '') ? WORLD_SORTS[p.get('sort')] : stronger);
  const limit = csv ? 5000 : Math.min(Math.max(parseInt(p.get('limit'), 10) || (view === 'inbox' ? 20 : 40), 1), 100);
  const offset = offsetOf(p, csv);
  return { view, total: out.length, offset, rows: out.slice(offset, offset + limit) };
}

// Google (google.mjs): all four rules checked first (reach approximated, not unknown), then the most proof.
const imprDay = (r) => (r.google.impr ? num(r.google.impr.lower) / Math.max(num(r.ad_age_days), 1) : -1);
const surer = (a, b) => (b.google.verdict === 'winner') - (a.google.verdict === 'winner') || b.proof.n - a.proof.n || num(b.scaled_count) - num(a.scaled_count) || num(b.age_now) - num(a.age_now) || cmp(a.ad_id, b.ad_id);
const GOOGLE_SORTS = {
  proof: surer,
  days: (a, b) => num(b.age_now) - num(a.age_now) || surer(a, b),
  copies: (a, b) => num(b.scaled_count) - num(a.scaled_count) || surer(a, b),
  ads: (a, b) => num(b.active_ads) - num(a.active_ads) || surer(a, b),
  regions: (a, b) => b.google.regions.length - a.google.regions.length || surer(a, b),
  impr: (a, b) => imprDay(b) - imprDay(a) || surer(a, b),
  best: (a, b) => (bsRank(a) ?? 999) - (bsRank(b) ?? 999) || surer(a, b),
  reviews: (a, b) => num(b.tp && b.tp.reviews) - num(a.tp && a.tp.reviews) || surer(a, b),
  jevp: (a, b) => num(b.jev && b.jev.product_score) - num(a.jev && a.jev.product_score) || surer(a, b),
  jeva: (a, b) => num(b.jev && b.jev.ad_score) - num(a.jev && a.jev.ad_score) || surer(a, b),
  new: (a, b) => cmp(b.first_seen ?? '', a.first_seen ?? '') || surer(a, b),
};

/**
 * The Google tab: filters (?full=1 all four rules checked, ?meta=1 / 0 also / not on the Meta board, ?tiktok=1, ?cc=NL a
 * country its ads were shown in, ?jev=), sort and page. The Inbox: proof + 1 (one more with all four rules checked) × what you
 * taught the board × Jev's risks; like the EU, nothing people or pets take.
 */
function googleView(p, list, csv) {
  const view = p.get('view') === 'inbox' ? 'inbox' : 'all';
  const hidden = view === 'all' && p.get('hidden') === '1';
  let out = list.gl.filter((r) => (view === 'inbox' ? inboxOk(r, list.taste) : hidden ? r.hid > 0 : r.hid === 0));
  const cc = String(p.get('cc') || '').toUpperCase();
  if (/^[A-Z]{2}$/.test(cc)) out = out.filter((r) => r.google.regions.includes(cc));
  if (p.get('full') === '1') out = out.filter((r) => r.google.verdict === 'winner');
  if (p.get('meta') === '1') out = out.filter((r) => r.google.cross.meta);
  if (p.get('meta') === '0') out = out.filter((r) => !r.google.cross.meta);
  if (p.get('tiktok') === '1') out = out.filter((r) => r.google.cross.tiktok);
  if (p.get('jev')) out = out.filter((r) => jevMatches(String(p.get('jev')).slice(0, 80), r.jev));
  const q = String(p.get('q') || '').trim().slice(0, 80).toLowerCase();
  if (q) out = out.filter((r) => [r.product_title, r.advertiser, r.store_url, r.keyword].some((x) => String(x ?? '').toLowerCase().includes(q)));
  if (view === 'inbox') out = out.map((r) => ranked(r, list.taste, r.proof.n + 1 + (r.google.verdict === 'winner' ? 1 : 0))).sort((a, b) => b.score - a.score || surer(a, b));
  else out.sort(Object.hasOwn(GOOGLE_SORTS, p.get('sort') || '') ? GOOGLE_SORTS[p.get('sort')] : surer);
  const limit = csv ? 5000 : Math.min(Math.max(parseInt(p.get('limit'), 10) || (view === 'inbox' ? 20 : 40), 1), 100);
  const offset = offsetOf(p, csv);
  return { view, total: out.length, offset, rows: out.slice(offset, offset + limit) };
}

/** One view of the board: filters, one market (?cc=FR: best first by the reach a day there), sort and page. */
export function viewOf(p, list, { csv = false } = {}) {
  const view = ['starred', 'made', 'inbox'].includes(p.get('view')) ? p.get('view') : 'all';
  if (p.get('scope') === 'world' && (view === 'all' || view === 'inbox')) return worldView(p, list, csv);
  if (p.get('scope') === 'google' && (view === 'all' || view === 'inbox')) return googleView(p, list, csv);
  let out;
  let sort = SORTS.rpd;
  let limit = 100;
  let offset = 0;
  if (view === 'starred') {
    out = list.k.filter((r) => r.star); // seen, rejected or out of the rules too: a star is kept until you take it off
    limit = csv ? 5000 : 100;
  } else if (view === 'made') {
    out = list.k.filter((r) => r.hid === 1); // every product you made an ad for (✓), out of the rules too
    sort = (a, b) => cmp(b.hat, a.hat) || better(a, b); // the last one you made first
    limit = csv ? 5000 : 100;
    offset = offsetOf(p, csv);
  } else if (view === 'inbox') {
    // Not decided yet; reach a day × what you taught the board × the store's best-seller rank × Jev's risks.
    out = list.v.filter((r) => inboxOk(r, list.taste)).map((r) => ranked(r, list.taste, r.rpd, sellsBoost(r), momentumFactor(r)));
    sort = (a, b) => b.score - a.score || cmp(a.ad_id, b.ad_id);
    limit = csv ? 5000 : Math.min(Math.max(parseInt(p.get('limit'), 10) || 20, 1), 100);
  } else {
    const hidden = p.get('hidden') === '1';
    out = list.v.filter((r) => (hidden ? r.hid > 0 : r.hid === 0));
    const minRpd = Number(p.get('rpd'));
    if (minRpd === 2500 || minRpd === 10000) out = out.filter((r) => r.rpd >= minRpd);
    const q = String(p.get('q') || '').trim().slice(0, 80).toLowerCase();
    if (q) out = out.filter((r) => [r.product_title, r.advertiser, r.store_url, r.keyword].some((x) => String(x ?? '').toLowerCase().includes(q)));
    // Only the board's own sorts: ?sort=__proto__ or constructor is no sort.
    const asked = Object.hasOwn(SORTS, p.get('sort') || '') ? p.get('sort') : 'rpd';
    sort = SORTS[asked];
    const cc = String(p.get('cc') || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) {
      out = out.flatMap((r) => {
        const hit = r.mk.find(([c]) => c === cc);
        return hit ? [Object.assign({}, r, { crpd: (r.rpd * hit[1]) / 100 })] : [];
      });
      if (asked === 'rpd') sort = (a, b) => b.crpd - a.crpd || cmp(a.ad_id, b.ad_id);
    }
    if (p.get('jev')) out = out.filter((r) => jevMatches(String(p.get('jev')).slice(0, 80), r.jev));
    limit = csv ? 5000 : Math.min(Math.max(parseInt(p.get('limit'), 10) || 40, 1), 100);
    offset = offsetOf(p, csv);
  }
  out.sort(sort);
  return { view, total: out.length, offset, rows: out.slice(offset, offset + limit) };
}

const offsetOf = (p, csv) => (csv ? 0 : Math.min(Math.max(parseInt(p.get('offset'), 10) || 0, 0), 100000));

const inInbox = (r) => r.hid === 0; // the ★ is gone from the board (2026-10-31): an old star no longer keeps a product out
const blockedBy = (r, taste) => !!(taste && taste.blocked.size && taste.blocked.has(storeOf(r.store_url)));
/** In the Inbox: not decided yet, not from a store you called bad, and (EU) nothing Jev says people or pets take. */
const inboxOk = (r, taste) => inInbox(r) && !blockedBy(r, taste) && !takenIn(r);
const NEW_MS = 864e5; // found in the last day: new

export const countsOf = (list, now = Date.now(), scope = 'eu') => {
  const on = scope === 'world' ? list.w : scope === 'google' ? list.gl : list.v;
  return {
    all: on.filter((r) => r.hid === 0).length,
    inbox: on.filter((r) => inboxOk(r, list.taste)).length,
    fresh: on.filter((r) => inboxOk(r, list.taste) && now - Date.parse(r.first_seen) < NEW_MS).length,
    starred: list.k.filter((r) => r.star).length,
    made: list.k.filter((r) => r.hid === 1).length,
    hidden: on.filter((r) => r.hid > 0).length,
    world: list.w.filter((r) => r.hid === 0).length,
    eu: list.v.filter((r) => r.hid === 0).length,
    google: list.gl.filter((r) => r.hid === 0).length,
  };
};

/** The board's ads (not hidden) whose ad view is missing or older than ?2, best first: prefetch.mjs opens these ahead. */
export const PREFETCH_SQL = `${BASE} SELECT v.ad_id FROM v LEFT JOIN ad_views a ON a.ad_id = v.ad_id
WHERE v.hid = 0 AND (a.fetched_at IS NULL OR a.fetched_at < ?2) ORDER BY v.rpd DESC LIMIT ?3`;

/**
 * Market Radar: per country the EU reach a day the board's products (not seen or rejected) get there
 * (reach a day × the country's share), how many products reach it, how many have it as their #1 country,
 * and the product that gets the most there. Countries by reach a day, biggest first.
 */
export function marketsOf(rows) {
  const m = new Map();
  let total = 0;
  for (const r of rows) {
    (r.mk || parseCountries(r.tc)).forEach(([cc, pct], i) => {
      const x = m.get(cc) || { cc, rpd: 0, products: 0, leads: 0, top: null };
      const v = (Number(r.rpd) || 0) * pct / 100;
      x.rpd += v;
      x.products++;
      if (i === 0) x.leads++;
      if (!x.top || v > x.top.rpd) x.top = { id: r.ad_id, title: String(r.product_title || '').slice(0, 120), rpd: v };
      m.set(cc, x);
      total += v;
    });
  }
  const markets = [...m.values()]
    .map((x) => ({ ...x, rpd: Math.round(x.rpd), share: total ? Math.round((x.rpd / total) * 1000) / 10 : 0, top: x.top && { ...x.top, rpd: Math.round(x.top.rpd) } }))
    .sort((a, b) => b.rpd - a.rpd || a.cc.localeCompare(b.cc));
  return { markets, total_rpd: Math.round(total), products: rows.length };
}

/**
 * The Market Radar outside the EU: every market, also an empty one, with facts instead of reach: products, shops,
 * products with 4+ proof signals, ads started in the last 14 days, the age of its oldest ad, and the rules for selling there.
 */
export function worldMarketsOf(rows) {
  const m = new Map(WORLD_MARKETS.map((cc) => [cc, { cc, products: 0, shops: new Set(), strong: 0, new14: 0, days: 0, top: null }]));
  for (const r of rows) {
    for (const [cc, x] of Object.entries(r.world.markets)) {
      const k = m.get(cc);
      if (!k) continue;
      k.products++;
      k.shops.add(storeOf(r.store_url));
      if (r.proof.n >= 4) k.strong++;
      k.new14 += num(x.new14);
      k.days = Math.max(k.days, num(x.days));
      if (!k.top || stronger(r, k.top) < 0) k.top = r;
    }
  }
  const total = [...m.values()].reduce((a, x) => a + x.products, 0);
  const markets = [...m.values()].map((x) => ({ cc: x.cc, products: x.products, shops: x.shops.size, strong: x.strong, new14: x.new14, days: x.days,
    share: total ? Math.round((x.products / total) * 1000) / 10 : 0, top: x.top && { id: x.top.ad_id, title: String(x.top.product_title || '').slice(0, 120), n: x.top.proof.n },
    rules: MARKET_RULES.markets[x.cc] || null }))
    .sort((a, b) => b.products - a.products || WORLD_MARKETS.indexOf(a.cc) - WORLD_MARKETS.indexOf(b.cc));
  return { scope: 'world', markets, products: rows.length, proof: PROOF, rules_as_of: MARKET_RULES.as_of, rules_note: MARKET_RULES.note };
}

// Momentum (momentum.mjs): rising products that are not crowded first. The Inbox ranks × the same factor (ranked(): 1 for
// a product without numbers yet, so it keeps its place).
SORTS.mom = byMomentum(better);
WORLD_SORTS.mom = byMomentum(stronger);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = async (s) => crypto.subtle.digest('SHA-256', enc.encode(s));

function same(a, b) {
  a = String(a);
  b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

// The cookie: "<expiry>.<HMAC(pin + expiry)>", keyed with a server key and BOARD_PIN. The server key is BOARD_SECRET when
// that Worker secret is set, else a random key the board makes at the first login and keeps in D1 (state 'cookie_key').
// Neither is in the code: with a key from the PIN alone (before 2026-11) anyone could make the cookie for a PIN guess
// and try PINs on any page without the login's limit, and one copied cookie gave the PIN away offline. Those cookies no
// longer open the board: every phone logs in once more. Changing BOARD_PIN or BOARD_SECRET, or deleting state
// 'cookie_key', logs every phone out (a key read from D1 is kept up to 5 minutes).
const KEY_ROW = 'cookie_key';
const KEY_MS = 5 * 60000;
const KEYS = new WeakMap(); // per D1 binding
let KEPT = null; // on Cloudflare, as LAST
/** The server key for the cookie; '' when the board has none yet. make: the first login makes it. */
export async function cookieKey(env, now = Date.now(), make = false) {
  if (env.BOARD_SECRET) return String(env.BOARD_SECRET);
  const shared = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
  const kept = KEYS.get(env.DB) || (shared ? KEPT : null);
  if (kept && now >= kept.at && now - kept.at < KEY_MS) return kept.key;
  const read = async () => String((await env.DB.prepare(`SELECT value FROM state WHERE key = '${KEY_ROW}'`).first('value')) || '');
  let key = await read();
  if (!key && make) {
    await env.DB.prepare('INSERT OR IGNORE INTO state (key, value, updated_at) VALUES (?, ?, ?)').bind(KEY_ROW, b64url(crypto.getRandomValues(new Uint8Array(32))), new Date(now).toISOString()).run();
    key = await read(); // two first logins at the same moment: both use the one that was saved
  }
  if (key) {
    const e = { key, at: now };
    KEYS.set(env.DB, e);
    if (shared) KEPT = e;
  }
  return key;
}
async function sign(pin, exp, secret = '') {
  const key = await crypto.subtle.importKey('raw', await sha256(secret ? `winner-hunter-board|${secret}|${pin}` : 'winner-hunter-board|' + pin), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`board|${pin}|${exp}`)));
}
/** A cookie value for this PIN and server key (without a key: the old PIN-only cookie, which no longer opens the board). */
export async function makeToken(pin, now = Date.now(), secret = '') {
  const exp = Math.floor(now / 1000) + MAX_AGE;
  return `${exp}.${await sign(pin, exp, secret)}`;
}
/** The cookie POST /login gives (for tests and tools). */
export const tokenFor = async (env, now = Date.now()) => makeToken(env.BOARD_PIN, now, await cookieKey(env, now, true));
async function authed(req, env, now) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)__Host-wh=([0-9]+)\.([A-Za-z0-9_-]{20,100})(?:;|$)/);
  if (!m || !env.BOARD_PIN) return false;
  const exp = Number(m[1]) * 1000;
  // Expired, or valid for longer than the board ever gives a cookie: no.
  if (exp < now || exp > now + MAX_AGE * 1000 + 5 * 60000) return false;
  const key = await cookieKey(env, now);
  return !!key && same(m[2], await sign(env.BOARD_PIN, m[1], key));
}

function secure(res, { nonce = '', html = false } = {}) {
  const h = res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('X-Frame-Options', 'DENY');
  h.set('Strict-Transport-Security', 'max-age=31536000');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  h.set('Content-Security-Policy', html
    ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; font-src https://fonts.gstatic.com; img-src https:; media-src https:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
    : "default-src 'none'; frame-ancestors 'none'");
  return res;
}
const json = (o, status = 200) => secure(new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
const text = (t, status = 200, headers = {}) => secure(new Response(t, { status, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers) }));
const redirect = (to, cookie) => secure(new Response(null, { status: 303, headers: Object.assign({ Location: to }, cookie ? { 'Set-Cookie': cookie } : {}) }));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function pinPage(nonce, msg = '', status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Winner Hunter</title>
<meta name="theme-color" content="#141415"><meta name="color-scheme" content="dark">
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#141415;--card:#19191b;--ink:#ededed;--muted:#a1a1a6;--line:rgba(237,237,237,.08);--acc:#d9a441;--bad:#e5484d}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;color:var(--ink);-webkit-font-smoothing:antialiased;font:15px/1.4 "IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;background:var(--bg)}
form{width:100%;max-width:360px;display:grid;gap:12px;padding:24px;border-radius:16px;border:1px solid var(--line);background:var(--card)}
.k{font-size:12px;color:var(--muted)}
h1{margin:0;font-size:24px;font-weight:500}p{margin:0;color:var(--muted);font-size:14px}
input{font:500 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.3em;text-align:center;padding:12px;border:1px solid var(--line);border-radius:8px;background:#232325;color:var(--ink);width:100%}
input:focus{border-color:var(--acc);outline:none}
button{font:500 15px inherit;font-family:inherit;padding:12px;border:0;border-radius:8px;background:#ededed;color:#141415;cursor:pointer}
button:hover{background:#fff}
.err{color:var(--bad);font-weight:500}
</style></head><body>
<form method="post" action="/login"><span class="k">Products already selling, with proof</span><h1>Winner Hunter</h1><p>Enter your PIN to open the board.</p>
<input name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="64" required autofocus aria-label="PIN">
${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}<button type="submit">Open</button></form></body></html>`;
  return secure(new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }), { nonce, html: true });
}

const nonceOf = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

/** Whose PIN tries these are: an IPv4 address, or the /64 of an IPv6 address (one phone or home network has all of it). */
export function ipKey(ip) {
  const s = String(ip || '').trim().toLowerCase().slice(0, 64);
  if (!s.includes(':')) return s || 'unknown';
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) return v4[1];
  const [head, tail] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const groups = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}
/** The network around it, which one person can easily hold whole (a free tunnel gives a /48): IPv6 its /48, IPv4 its /24. */
export function netKey(ip) {
  const k = ipKey(ip);
  if (k.endsWith('::/64')) return k.split(':').slice(0, 3).join(':') + '::/48';
  const v4 = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(k);
  return v4 ? v4[1] + '.0/24' : k + '/net';
}

const stateOf = (row) => {
  if (!row) return null;
  try {
    return Object.assign(JSON.parse(row.value), { updated_at: row.updated_at });
  } catch (e) {
    return null;
  }
};
async function stateJson(DB, key) {
  return stateOf(await DB.prepare('SELECT value, updated_at FROM state WHERE key = ?').bind(key).first());
}
/** Several state keys in one query (one D1 round trip): { key: value or null }. */
async function statesJson(DB, keys) {
  const { results } = await DB.prepare(`SELECT key, value, updated_at FROM state WHERE key IN (${keys.map(() => '?').join(', ')})`).bind(...keys).all();
  const rows = new Map((results || []).map((r) => [r.key, r]));
  return Object.fromEntries(keys.map((k) => [k, stateOf(rows.get(k))]));
}

/**
 * The Meta token's problem for the banner, or ''. It expires within 7 days or Meta says it is invalid. Only an answer
 * from the check says so: a token without a known date is fine.
 */
function tokenProblem(token, now) {
  if (token && token.valid === false) return 'Meta token ongeldig / Meta token invalid';
  const exp = token && token.at ? Date.parse(token.at) : NaN;
  if (!Number.isFinite(exp) || exp - now >= TOKEN_DAYS * 864e5) return '';
  const days = Math.floor((exp - now) / 864e5);
  return days < 0 ? 'Meta token verlopen / Meta token expired' : `Meta token verloopt over ${days} dagen / Meta token expires in ${days} days`;
}

/**
 * The banner on top of the EU tab, or null. Red: a recent run failed, a run hangs, or a Meta token expires within 7 days.
 * Yellow: a recent run had warnings. The EU hunt only runs by hand since 1 Nov 2026, so an old finished run is no problem.
 */
export function boardAlert(run, token, now = Date.now()) {
  const red = [];
  const yellow = [];
  if (run) {
    const at = Date.parse(run.finished_at || run.started_at || run.updated_at || '');
    const old = Number.isFinite(at) && now - at > STALE_HOURS * 3600e3;
    if (old && run.status === 'running') red.push('EU-run staat stil / The EU run has stopped moving');
    else if (!old && run.health === 'failed') red.push(run.alert || 'Laatste run mislukt / Last run failed');
    else if (!old && run.health === 'warning') yellow.push(run.alert || 'Laatste run had waarschuwingen / Last run had warnings');
  }
  const tok = tokenProblem(token, now);
  if (tok) red.push(tok);
  if (red.length) return { level: 'red', text: red.join(' · ') };
  if (yellow.length) return { level: 'yellow', text: yellow.join(' · ') };
  return null;
}

/** The problems with the hunt outside the EU, for its tab: { level, text } or null. Every red one, else every yellow one. */
export function worldAlert(run, now = Date.now(), token = null, check = null) {
  const tok = tokenProblem(token, now); // without a working token the "Not in EU" check stops
  const own = worldRunAlert(run, now);
  const red = [own && own.level === 'red' ? own.text : '', tok].filter(Boolean);
  const yellow = [own && own.level === 'yellow' ? own.text : '', check && check.stopped ? `Jev-check gestopt / Jev check stopped: ${check.stopped}` : ''].filter(Boolean);
  if (red.length) return { level: 'red', text: red.join(' · ') };
  if (yellow.length) return { level: 'yellow', text: yellow.join(' · ') };
  return null;
}

function worldRunAlert(run, now) {
  if (!run) return null;
  const at = Date.parse(run.finished_at || run.started_at || '');
  if (run.health === 'failed') return { level: 'red', text: run.alert || 'Laatste scan buiten de EU mislukt / Last scan outside the EU failed' };
  const moved = Date.parse(run.updated_at || run.started_at || '');
  if (run.status === 'running' && Number.isFinite(moved) && now - moved > 3 * 3600e3) return { level: 'red', text: 'Scan buiten de EU staat stil / The scan outside the EU has stopped moving' };
  if (Number.isFinite(at) && now - at > WORLD_STALE_HOURS * 3600e3) return { level: 'red', text: `Geen scan buiten de EU in ${WORLD_STALE_HOURS} uur / No scan outside the EU in ${WORLD_STALE_HOURS} hours` };
  if (run.health === 'warning') return { level: 'yellow', text: run.alert || 'Laatste scan had waarschuwingen / Last scan had warnings' };
  return null;
}
const httpsOr = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
const BIG_STORE = 250; // products in the store
const FEW_COPIES = 5; // copies of the ad for this product

/** One ad as the board gets it: facts, no score (every ad on the board passed the rules). */
export function toAd(r) {
  let d = {};
  try {
    d = JSON.parse(r.data || '{}') || {};
  } catch (e) {
    d = {};
  }
  const off = r.compare_at_price > r.price && r.price > 0 ? Math.round((1 - r.price / r.compare_at_price) * 100) : null;
  const shop = (Array.isArray(d.checklist) ? d.checklist : []).find((c) => c && c.key === 'shopify');
  const products = storeSize(r);
  return {
    id: String(r.ad_id),
    title: r.product_title || '',
    price: r.price,
    was: r.compare_at_price,
    cur: r.currency || '',
    off,
    reach: r.reach_eu,
    rpd: Math.round(r.rpd || 0),
    age: r.age_now ?? r.ad_age_days, // today, if it still runs (the rules)
    age_seen: r.ad_age_days == null ? null : Number(r.ad_age_days), // when it was last measured (last_seen), with its reach and ads
    ads: r.active_ads,
    scaled: r.scaled_count,
    products,
    // A store with a big catalogue that hardly copies this ad: its ads may sell the store, not this product.
    catalogue: products != null && products >= BIG_STORE && (num(r.scaled_count) || 1) < FEW_COPIES,
    // No product page, price or best-seller rank: the title is the ad's own words, the product itself is not known.
    unidentified: !r.world && !r.google && !productKey(r.product_url) && r.price == null && bsRank(r) == null,
    myshopify: shop && /\.myshopify\.com$/i.test(String(shop.text || '')) ? String(shop.text).slice(0, 100) : '',
    adv: r.advertiser || '',
    kw: r.keyword || '',
    store: httpsOr(r.store_url),
    product: httpsOr(r.product_url),
    ad: httpsOr(r.ad_library_url),
    img: httpsOr(r.image_url),
    store_photo: d.image_source === 'store',
    zh: String(d.zh || r.product_title || '').slice(0, 80),
    copy: String(d.ad_copy || '').slice(0, 600),
    countries: String(d.top_countries || '').slice(0, 80),
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    star: !!r.star,
    pass: !!r.pass,
    mk: parseCountries(d.top_countries).slice(0, 5),
    crpd: r.crpd == null ? null : Math.round(r.crpd),
    hidden: r.hid === 2 ? 'rejected' : r.hid === 1 ? 'seen' : '',
    made_at: r.hid === 1 ? r.hat || '' : '', // when you marked it ✓ Made ad
    fit: r.fit == null ? null : r.fit,
    niche: r.niche || null, // the Inbox: what the board learned about its niche, { name, w }
    ranked: r.ranked || null, // the Inbox: how far it moved and why, { x, why: [{ text, x }] }
    risk: riskOf(r.jev), // Jev's risks: { x, why, red }
    best: bestOf(r.bs),
    trust: trustOf(r.tp),
    jev: r.jev ? { ...r.jev, flags: jevFlags(r.jev) } : null,
    world: r.world ? {
      proof: r.proof || null,
      markets: Object.entries(r.world.markets).map(([cc, x]) => [cc, num(x.ads), num(x.days), num(x.new14)]).sort((a, b) => b[1] - a[1] || b[2] - a[2]),
      creatives: r.world.creatives,
      new14: r.world.new14,
      in_eu: r.world.in_eu,
      eu_rpd: r.world.eu_rpd,
      shop_eu_rpd: r.world.shop_eu_rpd,
      likes: r.world.likes,
      page_id: r.world.page_id,
    } : null,
    // Google (google.mjs): its rules, each exact, approximated or not checked; where it ran; who else shows it.
    google: r.google ? googleFacts(r) : null,
    on_google: r.on_google || null, // a Meta product whose product page ('product') or shop ('store') is advertised on Google too
    mo: momentumCard(r), // momentum.mjs: rising or falling, sparkline, ads survived, rivals, crowding; null before its first run
    lasso: lassoCard(r), // lasso.mjs: its store uses the Lasso checkout, { store, sure, at }; null: not a known Lasso store
  };
}

// CSV: quotes around every text cell that needs it; cells starting with = + - @ get a ' so spreadsheets
// never run them as formulas.
export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_COLS = [
  ['ad_id', (a) => a.id], ['product', (a) => a.title], ['price', (a) => a.price],
  ['compare_at', (a) => a.was], ['currency', (a) => a.cur], ['discount_pct', (a) => a.off], ['reach_eu', (a) => a.reach], ['reach_per_day', (a) => a.rpd],
  ['ad_age_days', (a) => a.age], ['active_ads', (a) => a.ads], ['ads_for_product', (a) => a.scaled], ['store_products', (a) => a.products], ['advertiser', (a) => a.adv],
  ['store_url', (a) => a.store], ['product_url', (a) => a.product], ['ad_library_url', (a) => a.ad], ['image_url', (a) => a.img],
  ['keyword', (a) => a.kw], ['first_seen', (a) => a.first_seen], ['last_seen', (a) => a.last_seen], ['status', (a) => a.hidden || (a.star ? 'starred' : '')],
  ['made_at', (a) => a.made_at],
  ['proof_signals', (a) => (a.world && a.world.proof ? a.world.proof.n : null)],
  ['markets_outside_eu', (a) => (a.world ? a.world.markets.map(([c, n, d]) => `${c} ${n} ads ${d}d`).join(' / ') : null)],
  ['new_ads_14d', (a) => (a.world ? a.world.new14 : null)],
  ['in_eu', (a) => (a.world && a.world.in_eu != null ? a.world.in_eu : null)],
  ['eu_reach_per_day_product', (a) => (a.world ? a.world.eu_rpd : null)],
  ['eu_reach_per_day_shop_best_ad', (a) => (a.world ? a.world.shop_eu_rpd : null)],
  ['jev_main', (a) => (a.jev ? a.jev.main : null)],
  ['jev_sub', (a) => (a.jev ? a.jev.sub : null)],
  ['jev_product_score', (a) => (a.jev ? a.jev.product_score : null)],
  ['jev_ad_score', (a) => (a.jev ? a.jev.ad_score : null)],
  ...Object.keys({ ...CHOICES, ...AD_CHOICES }).map((k) => [`jev_${k}`, (a) => (a.jev ? a.jev.choices[k] ?? null : null)]),
  ...[...TRAITS, ...AD_TRAITS].map((t) => [`jev_${t.k}`, (a) => (a.jev ? a.jev.p[t.k] ?? null : null)]),
  ['jev_used', (a) => (a.jev ? a.jev.used : null)],
  ['lasso_checkout', (a) => (a.lasso ? a.lasso.store : null)], // the Lasso checkout store it matched (lasso.mjs)
];
// An export that holds Google products gets their columns too (rules exact / approx / unknown, countries, who else shows it).
export const toCsv = (ads) => {
  const cols = ads.some((a) => a && a.google) ? CSV_COLS.concat(GOOGLE_CSV_COLS) : CSV_COLS;
  return [cols.map((c) => c[0]).join(','), ...ads.map((a) => cols.map(([, f]) => csvCell(f(a))).join(','))].join('\r\n') + '\r\n';
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// One statement counts the try and gives its number in the window (a window older than 15 minutes starts again at 1).
// Tries that arrive at the same moment each get their own number, so no more than PIN_TRIES of them are ever compared.
export const PIN_TRY_SQL = `INSERT INTO pin_tries (ip, n, since) VALUES (?1, 1, ?2) ON CONFLICT(ip) DO UPDATE SET
  n = CASE WHEN pin_tries.since >= ?3 THEN pin_tries.n + 1 ELSE 1 END, since = CASE WHEN pin_tries.since >= ?3 THEN pin_tries.since ELSE ?2 END
RETURNING n`;

async function login(req, env, now) {
  const nonce = nonceOf();
  const ct = req.headers.get('content-type') || '';
  if (!/application\/x-www-form-urlencoded|multipart\/form-data/.test(ct)) return pinPage(nonce, 'Enter your PIN.', 400);
  const ip = ipKey(req.headers.get('cf-connecting-ip'));
  const net = netKey(req.headers.get('cf-connecting-ip'));
  // Counted before the PIN is compared, for the address and for its network. A try that cannot be counted (D1 down, no
  // table) is not compared: no lockout, no login. A phone with its cookie still opens the board.
  let n = NaN;
  let w = NaN;
  try {
    const [a, b] = await Promise.all([ip, net].map((k) => env.DB.prepare(PIN_TRY_SQL).bind(k, now, now - PIN_WINDOW).first()));
    n = Number(a && a.n);
    w = Number(b && b.n);
  } catch (e) {
    console.error(e);
  }
  if (!(n >= 1 && w >= 1)) return pinPage(nonce, 'The board cannot check PINs right now. Try again in a minute.', 503);
  if (n > PIN_TRIES || w > NET_TRIES) return pinPage(nonce, 'Too many wrong PINs. Try again in 15 minutes.', 429);
  const form = await req.formData().catch(() => null);
  const pin = String((form && form.get('pin')) || '').slice(0, 64);
  // Compare hashes in constant time, so the answer time says nothing about the PIN.
  const ok = pin && same(b64url(await sha256(pin)), b64url(await sha256(env.BOARD_PIN)));
  if (!ok) {
    // Windows that are over go, found through the index on since: a wrong PIN never scans the table.
    await env.DB.prepare('DELETE FROM pin_tries WHERE since < ?').bind(now - PIN_WINDOW).run().catch(() => {});
    return pinPage(nonce, 'Wrong PIN.', 401);
  }
  await env.DB.prepare('DELETE FROM pin_tries WHERE ip = ?').bind(ip).run().catch(() => {}); // the network's count runs out by itself
  let key = '';
  try {
    key = await cookieKey(env, now, true);
  } catch (e) {
    console.error(e);
  }
  if (!key) return pinPage(nonce, 'The board cannot sign you in right now. Try again in a minute.', 503);
  return redirect('/', `${COOKIE}=${await makeToken(env.BOARD_PIN, now, key)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
}

async function ads(url, env, now, viewer) {
  // The products and the run states at the same time: the board waits for one round trip to D1, not five in a row.
  // With the unit economics' settings and inputs (econ.mjs): every card gets its margin and verdict, and Browse can sort by them.
  const [list, states, ec, checks] = await Promise.all([board(env, now), statesJson(env.DB, ['last_run', 'world_run', 'token_expires_at', 'world_check', 'google_run']),
    econContext(env.DB, now, { pageKey: productKey }), riskChecks(env)]);
  riskHide(list, url.searchParams, checks, toAd); // ?risk=hide: the risk radar's Block products leave Inbox and Browse (risk.mjs)
  const q = lassoView(url.searchParams, econBoard(list, ec, url.searchParams.get('sort')), viewOf); // + ?lasso=1 and its count (lasso.mjs)
  const scope = ['world', 'google'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'eu';
  const counts = countsOf(list, now, scope);
  if (url.searchParams.get('lasso') === '1') counts.fresh = countsOf(lassoBoard(list), now, scope).fresh; // the Inbox's "new today" as it is filtered (lasso.mjs)
  const { last_run: run, world_run: worldRun, token_expires_at: token } = states;
  // While a run hunts, the board also shows what the run before it found.
  const prev = run && run.status === 'running'
    ? await env.DB.prepare('SELECT started_at, finished_at, ads_checked, winners FROM runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1').first()
    : null;
  return json({
    view: q.view,
    ads: q.rows.map((r) => econAd(toAd(r), r, ec)),
    total: q.total,
    offset: q.offset,
    lasso: q.lasso, // how many products of this view a Lasso checkout store sells: the chip's count (lasso.mjs)
    counts,
    last_run: run,
    prev_run: prev || null,
    world_run: worldRun,
    google_run: states.google_run,
    alert: scope === 'world' ? worldAlert(worldRun, now, token, states.world_check) : scope === 'google' ? googleAlert(states.google_run, now) : boardAlert(run, token, now),
    risk: riskOut(list, q.rows),
    viewer,
  });
}

async function hide(req, url, env, now) {
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return json({ error: 'Wrong origin' }, 403);
  if (!/^application\/json/.test(req.headers.get('content-type') || '')) return json({ error: 'Send JSON' }, 415);
  const body = await req.text();
  if (body.length > 1000) return json({ error: 'Too big' }, 413);
  let j;
  try {
    j = JSON.parse(body);
  } catch (e) {
    return json({ error: 'Bad JSON' }, 400);
  }
  const id = String((j && j.ad_id) || '');
  const status = String((j && j.status) || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json({ error: 'Bad ad_id' }, 400);
  if (!['seen', 'rejected', 'none', 'starred', 'unstarred'].includes(status)) return json({ error: 'Bad status' }, 400);
  // All ads of the same product (advertiser + title), from the winners in memory.
  const rows = await snapshot(env.DB, now);
  const me = rows.find((w) => w.ad_id === id);
  if (!me) return json({ error: 'Unknown ad' }, 404);
  const ids = rows.filter((w) => w.gk === me.gk).map((w) => w.ad_id);
  // One status and one star per product: clear the whole group, then set the new one.
  // The star (stars) and seen / rejected (hidden) are kept apart, so one never wipes the other.
  const star = status === 'starred' || status === 'unstarred';
  const steps = [];
  for (let i = 0; i < ids.length; i += 90) { // D1 takes up to 100 bound values a query
    const part = ids.slice(i, i + 90);
    steps.push(env.DB.prepare(`DELETE FROM ${star ? 'stars' : 'hidden'} WHERE ad_id IN (${part.map(() => '?').join(', ')})`).bind(...part));
  }
  const at = new Date(now).toISOString();
  if (status === 'starred') steps.push(env.DB.prepare('INSERT INTO stars (ad_id, at) VALUES (?, ?) ON CONFLICT(ad_id) DO UPDATE SET at = excluded.at').bind(id, at));
  else if (!star && status !== 'none') steps.push(env.DB.prepare('INSERT INTO hidden (ad_id, status, at) VALUES (?, ?, ?) ON CONFLICT(ad_id) DO UPDATE SET status = excluded.status, at = excluded.at').bind(id, status, at));
  // The decision goes into feedback (reasons and a note come later from /api/feedback); undo takes it out.
  const gone = star ? ['keep'] : ['seen', 'rejected']; // one decision per product: a new one replaces the old
  for (let i = 0; i < ids.length && gone.length; i += 90) {
    const part = ids.slice(i, i + 90);
    steps.push(env.DB.prepare(`DELETE FROM feedback WHERE action IN (${gone.map(() => '?').join(', ')}) AND ad_id IN (${part.map(() => '?').join(', ')})`).bind(...gone, ...part));
  }
  if (Object.hasOwn(ACTION_OF, status)) {
    steps.push(env.DB.prepare('INSERT INTO feedback (ad_id, action, reasons, note, keyword, store, advertiser, title, price, currency, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, ACTION_OF[status], '[]', '', me.keyword ?? '', me.store_url ?? '', me.advertiser ?? '', String(me.product_title ?? '').slice(0, 200), me.price ?? null, me.currency ?? '', at));
  }
  await env.DB.batch(steps);
  return json({ ok: true, ad_id: id, status });
}

async function readJson(req, url, max = 2000) {
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return { err: json({ error: 'Wrong origin' }, 403) };
  if (!/^application\/json/.test(req.headers.get('content-type') || '')) return { err: json({ error: 'Send JSON' }, 415) };
  const body = await req.text();
  if (body.length > max) return { err: json({ error: 'Too big' }, 413) };
  try {
    return { j: JSON.parse(body) || {} };
  } catch (e) {
    return { err: json({ error: 'Bad JSON' }, 400) };
  }
}

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

/**
 * POST /api/feedback. {ad_id, reasons?, note?}: why you made that decision (on its decision row: never on your note
 * about the product, which can be saved after the decision). {general: "…"}: a note about the board.
 * {unblock: "shop.com"}: that store may come back in the inbox.
 */
async function feedback(req, url, env, now) {
  const { j, err } = await readJson(req, url);
  if (err) return err;
  const at = new Date(now).toISOString();
  if (j.general != null) {
    const note = clean(j.general, 1000);
    if (!note) return json({ error: 'Empty note' }, 400);
    await env.DB.prepare("INSERT INTO feedback (action, reasons, note, at) VALUES ('general', '[]', ?, ?)").bind(note, at).run();
    return json({ ok: true });
  }
  if (j.unblock != null) {
    const host = String(j.unblock).toLowerCase();
    const { results } = await env.DB.prepare("SELECT id, reasons, store FROM feedback WHERE action = 'rejected' AND reasons LIKE '%\"store\"%'").all();
    const steps = results.filter((f) => storeOf(f.store) === host)
      .map((f) => env.DB.prepare('UPDATE feedback SET reasons = ? WHERE id = ?').bind(JSON.stringify(reasonsOf(f.reasons).filter((x) => x !== 'store')), f.id));
    if (steps.length) await env.DB.batch(steps);
    return json({ ok: true, unblocked: steps.length });
  }
  const id = String(j.ad_id || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json({ error: 'Bad ad_id' }, 400);
  const row = await env.DB.prepare("SELECT id, action FROM feedback WHERE ad_id = ? AND action IN ('seen', 'rejected', 'keep') ORDER BY id DESC LIMIT 1").bind(id).first();
  if (!row) return json({ error: 'Decide first' }, 404);
  const allowed = REASONS[row.action === 'rejected' ? 'bad' : 'good'];
  const sets = [];
  const vals = [];
  if (Array.isArray(j.reasons)) {
    sets.push('reasons = ?');
    vals.push(JSON.stringify([...new Set(j.reasons.map(String))].filter((r) => Object.hasOwn(allowed, r))));
  }
  if (j.note != null) {
    sets.push('note = ?');
    vals.push(clean(j.note, 500));
  }
  if (!sets.length) return json({ error: 'Nothing to save' }, 400);
  await env.DB.prepare(`UPDATE feedback SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, row.id).run();
  return json({ ok: true });
}

/**
 * Your note on a product (the ad, the competitor, the product), before or after you decide. One per product: a
 * feedback row with action 'note' and the product's facts, so 🧠 lists it and Claude can learn from it.
 *   GET /api/note?ad_id=…        { note, others }: others = your notes on other products of the same store or advertiser
 *   POST /api/note {ad_id, note}  saves it ('' takes it out)
 */
async function note(req, url, env, now) {
  const post = req.method === 'POST';
  let id = url.searchParams.get('ad_id') || '';
  let text = '';
  if (post) {
    const { j, err } = await readJson(req, url);
    if (err) return err;
    id = String(j.ad_id || '');
    text = clean(j.note, 500);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return json({ error: 'Bad ad_id' }, 400);
  const rows = await snapshot(env.DB, now);
  const me = rows.find((w) => w.ad_id === id);
  if (!me) return json({ error: 'Unknown ad' }, 404);
  const ids = rows.filter((w) => w.gk === me.gk).map((w) => w.ad_id); // every ad of this product
  if (post) {
    // The box holds the product's newest note: that one (and any saved after it) is replaced. Two products that are one
    // product page now can each have an older note: those stay, and show below the box.
    let newest = 0;
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const row = await env.DB.prepare(`SELECT MAX(id) AS id FROM feedback WHERE action = 'note' AND ad_id IN (${part.map(() => '?').join(', ')})`).bind(...part).first();
      newest = Math.max(newest, Number(row && row.id) || 0);
    }
    const steps = [];
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      steps.push(env.DB.prepare(`DELETE FROM feedback WHERE action = 'note' AND id >= ? AND ad_id IN (${part.map(() => '?').join(', ')})`).bind(newest, ...part));
    }
    if (text) {
      steps.push(env.DB.prepare("INSERT INTO feedback (ad_id, action, reasons, note, keyword, store, advertiser, title, price, currency, at) VALUES (?, 'note', '[]', ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, text, me.keyword ?? '', me.store_url ?? '', me.advertiser ?? '', String(me.product_title ?? '').slice(0, 200), me.price ?? null, me.currency ?? '', new Date(now).toISOString()));
    }
    await env.DB.batch(steps);
    return json({ ok: true });
  }
  const { results } = await env.DB.prepare("SELECT ad_id, action, note, store, advertiser, title, at FROM feedback WHERE ad_id IS NOT NULL AND note != '' ORDER BY id DESC LIMIT 2000").all();
  const mine = new Set(ids);
  const own = results.find((f) => f.action === 'note' && mine.has(f.ad_id));
  const shop = storeOf(me.store_url);
  const earlier = results.filter((f) => f !== own && f.action === 'note' && mine.has(f.ad_id)); // older notes on this product
  const others = earlier.concat(results.filter((f) => !mine.has(f.ad_id) && ((shop && storeOf(f.store) === shop) || (me.advertiser && f.advertiser === me.advertiser))))
    .slice(0, 5).map((f) => ({ title: f.title || '', note: f.note, at: f.at }));
  return json({ note: own ? own.note : '', others });
}

/**
 * GET /api/learned: what the board learned from your feedback, for the 🧠 page (and for Claude to read). From every
 * decision, as the Inbox uses them: a store blocked long ago is listed, so it can be brought back.
 */
async function learned(env, now) {
  const [rows, { results: fb }, { results: notes }] = await Promise.all([
    snapshot(env.DB, now),
    env.DB.prepare(DECIDED_SQL).all(),
    env.DB.prepare("SELECT action, reasons, note, title, at FROM feedback WHERE note != '' ORDER BY id DESC LIMIT 50").all(),
  ]);
  const taste = tasteOf(withFacts(fb, products(rows, [], [], now).byAd));
  const by = { rejected: 0, keep: 0, seen: 0 };
  const count = { bad: {}, good: {} };
  for (const f of fb) {
    if (!Object.hasOwn(by, f.action)) continue;
    by[f.action]++;
    const side = f.action === 'rejected' ? 'bad' : 'good';
    for (const r of reasonsOf(f.reasons)) if (Object.hasOwn(REASONS[side], r)) count[side][r] = (count[side][r] || 0) + 1;
  }
  const list = (side) => Object.entries(count[side]).map(([key, n]) => ({ key, label: REASONS[side][key], n })).sort((a, b) => b.n - a.n);
  return json({
    decisions: by.rejected + by.keep + by.seen,
    by_action: by,
    reasons: { bad: list('bad'), good: list('good') },
    reason_labels: REASONS,
    approval_rate: Math.round(taste.rate * 100) / 100,
    niches: [...taste.niches].map(([niche, x]) => ({ niche, good: x.good, bad: x.bad, weight: taste.weights.get(niche) })).sort((a, b) => b.weight - a.weight || b.good - a.good || a.niche.localeCompare(b.niche)),
    blocked: [...taste.blocked].map(([store, n]) => ({ store, n })),
    max_prices: [...taste.maxPrice].map(([currency, price]) => ({ currency, price })).sort((a, b) => a.currency.localeCompare(b.currency)),
    no_price: NO_PRICE,
    notes: notes.map((f) => ({ action: f.action, title: f.title || '', note: f.note, reasons: reasonsOf(f.reasons), at: f.at })),
  });
}

async function csv(url, env, now) {
  const [list, checks] = await Promise.all([board(env, now), riskChecks(env)]);
  riskHide(list, url.searchParams, checks); // the CSV is what you look at: with ?risk=hide, no Block products either
  const q = lassoView(url.searchParams, list, (p, l) => viewOf(p, l, { csv: true }), { count: false }); // + ?lasso=1 (lasso.mjs)
  const results = q.rows;
  const day = new Date(now).toISOString().slice(0, 10);
  return text(toCsv(results.map(toAd)), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="winners-${q.view}-${day}.csv"` });
}

/**
 * What econ.mjs (unit economics, the decision log) needs from the board, so it imports nothing from here: the winners as
 * read (snapshot), the board with your decisions, products() and the card data, productKey, and /api/hide itself, which
 * Undo in the decision log calls as the board's own Undo does.
 */
function econDeps(env, now, url) {
  const at = new URL('/api/hide', url.origin);
  return {
    rows: () => snapshot(env.DB, now),
    board: () => board(env, now),
    products,
    toAd,
    pageKey: productKey,
    hide: (adId, status) => hide(new Request(at, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ad_id: adId, status }) }), at, env, now),
  };
}

/**
 * The Worker. `launch(env.BROWSER)` opens a Browser Run browser (index.mjs passes @cloudflare/puppeteer's launch;
 * tests pass a fake). Without it, a META_TOKEN or the BROWSER binding the viewer is off. The board opens the Ad Library either way.
 */
export async function handle(req, env, { html = '', now = Date.now(), launch = null } = {}) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  try {
    if (!env.BOARD_PIN) return text('The board has no PIN yet: add the BOARD_PIN secret and run "Deploy board" again.', 503);
    if (path === '/login' && method === 'POST') return await login(req, env, now);
    if (path === '/logout') return redirect('/', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    if (path === '/robots.txt') return text('User-agent: *\nDisallow: /\n');
    const ok = await authed(req, env, now);
    if (path === '/' && (method === 'GET' || method === 'HEAD')) {
      const nonce = nonceOf();
      if (!ok) return pinPage(nonce);
      return secure(new Response(html.replaceAll('__NONCE__', nonce), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }), { nonce, html: true });
    }
    if (path === '/api/ads' || path === '/api/hide' || path === '/api/markets' || path === '/export.csv' || path === '/api/feedback' || path === '/api/learned' || path === '/api/note') {
      if (!ok) return path === '/export.csv' ? text('Log in first.', 401) : json({ error: 'Log in first' }, 401);
      if (path === '/api/markets' && method === 'GET') {
        const b = await board(env, now);
        if (url.searchParams.get('scope') === 'world') {
          const open = b.w.filter((r) => r.hid === 0);
          return json({ ...worldMarketsOf(open), jev: jevSummary(open) });
        }
        if (url.searchParams.get('scope') === 'google') {
          const open = b.gl.filter((r) => r.hid === 0);
          return json({ ...googleMarketsOf(open), jev: jevSummary(open) });
        }
        const open = b.v.filter((r) => r.hid === 0);
        return json({ ...marketsOf(open), jev: jevSummary(open) });
      }
      if (path === '/api/ads' && method === 'GET') return await ads(url, env, now, env.AD_VIEWER === 'on' && !!(launch && env.BROWSER && String(env.META_TOKEN || '').trim()));
      if (path === '/api/hide' && method === 'POST') return await decisionLogged(req, env, now, econDeps(env, now, url), (r) => hide(r, url, env, now)); // + the decision log (econ.mjs)
      if (path === '/api/feedback' && method === 'POST') return await feedback(req, url, env, now);
      if (path === '/api/learned' && method === 'GET') return await learned(env, now);
      if (path === '/api/note' && (method === 'GET' || method === 'POST')) return await note(req, url, env, now);
      if (path === '/export.csv' && method === 'GET') return await csv(url, env, now);
      return json({ error: 'Method not allowed' }, 405);
    }
    if (path === '/api/tiktok') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (method === 'GET') return json(await tiktokList(env));
      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const { j, err } = await readJson(req, url);
      if (err) return err;
      const out = await tiktokDecide(env, j, now);
      if (out.status === 200) await tiktokLogged(env, out.body, now); // the decision log (econ.mjs); never throws
      return json(out.body, out.status);
    }
    // ---- AI read (ai.mjs): a cheap Claude model's read of each card, collapsed and experimental (ai-check.mjs fills D1
    // table ai_checks). A block of its own: nothing else here uses it. /ai.js: the board's code that shows it.
    if (path === '/api/ai' || path === '/ai.js') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (path === '/ai.js') return method === 'GET' ? text(AI_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }) : json({ error: 'Method not allowed' }, 405);
      const deps = { rows: () => snapshot(env.DB, now) };
      if (method === 'GET') return json(await aiList(env, url.searchParams.get('ids'), deps));
      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const { j, err } = await readJson(req, url);
      if (err) return err;
      const out = await aiPost(env, j, now, deps);
      return json(out.body, out.status);
    }
    // ---- Lasso checkout (lasso.mjs): /lasso.js puts the filter chip, its count and the "Lasso" tag on the board. A block of its own.
    if (path === '/lasso.js') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      return method === 'GET' ? text(LASSO_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }) : json({ error: 'Method not allowed' }, 405);
    }
    // ---- Launch view (launch.mjs): an approved product's launch card, checklist and decision. A block of its own, so the
    // routes above stay as they are. /launch.js: the margin and decision code the board runs while you type.
    if (path === '/api/launch' || path === '/launch.js') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (path === '/launch.js') return method === 'GET' ? text(LAUNCH_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }) : json({ error: 'Method not allowed' }, 405);
      // The board's products, and its ads (each with its product page and its old advertiser + title key), so a launch
      // card saved under the old key of an EU product is still found as that product's card.
      const deps = { board: async () => { const b = await board(env, now); return { products: b.k, rows: b.rows }; }, toAd, pageKey: productKey };
      if (method === 'GET') return json(await launchList(env, url.searchParams.get('pick') === '1', deps));
      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const { j, err } = await readJson(req, url, 8000);
      if (err) return err;
      const out = await launchPost(env, j, now, deps);
      return json(out.body, out.status);
    }
    // ---- 🔎 Sourcing (sourcing.mjs): the supplier match pipeline on a launch card. A block of its own, as the Launch view's.
    // /sourcing.js: the links, the comparison and the messages the panel works out as you type.
    if (path === '/api/sourcing' || path === '/sourcing.js') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (path === '/sourcing.js') return method === 'GET' ? text(SOURCING_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }) : json({ error: 'Method not allowed' }, 405);
      let out;
      if (method === 'GET') out = await sourcingGet(env, url.searchParams, now);
      else if (method === 'POST') {
        const { j, err } = await readJson(req, url, 8000);
        if (err) return err;
        out = await sourcingPost(env, j, now);
      } else return json({ error: 'Method not allowed' }, 405);
      return json(out.body, out.status);
    }
    // ---- Unit economics (econ.mjs): landed cost, margin, break-even ROAS and a red / amber / green verdict for every
    // product, the settings they use, and the decision log with Undo. A block of its own, like the Launch view's.
    // /econ.js: the numbers code the board runs while you type.
    if (path === '/api/econ' || path === '/api/decisions' || path === '/econ.js') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (path === '/econ.js') return method === 'GET' ? text(ECON_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }) : json({ error: 'Method not allowed' }, 405);
      const deps = econDeps(env, now, url);
      const econ = path === '/api/econ';
      let out;
      if (method === 'GET') out = econ ? await econGet(env, url, now, deps) : await decisionsGet(env, url);
      else if (method === 'POST') {
        const { j, err } = await readJson(req, url, 8000);
        if (err) return err;
        out = econ ? await econPost(env, j, now, deps) : await decisionsPost(env, j, now, deps);
      } else return json({ error: 'Method not allowed' }, 405);
      return json(out.body, out.status);
    }
    // ---- 🧭 Pipeline (pipeline.mjs): every approved product from Approved to Launched, its sourcing request pack, its 1688
    // links (Sourcing's candidates) and target markets outside the EU. A block of its own, as Launch and Sourcing.
    // /pipeline.js: the stages, links, pack and texts the board works out as you type. /api/pipeline/image: the photo as a file.
    if (path === '/api/pipeline' || path === '/pipeline.js' || path === '/api/pipeline/image') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (path === '/pipeline.js') return method === 'GET' ? text(PIPELINE_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }) : json({ error: 'Method not allowed' }, 405);
      const deps = { board: async () => { const b = await board(env, now); return { products: b.k, rows: b.rows }; }, toAd, pageKey: productKey };
      if (path === '/api/pipeline/image') {
        if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        const img = await pipelineImage(env, url.searchParams, now, deps);
        if (!img.bytes) return json(img.body, img.status);
        return secure(new Response(img.bytes, { headers: { 'Content-Type': img.type, 'Content-Disposition': `attachment; filename="${img.name}"` } }));
      }
      let out;
      if (method === 'GET') out = await pipelineGet(env, url.searchParams, now, deps);
      else if (method === 'POST') {
        const { j, err } = await readJson(req, url, 8000);
        if (err) return err;
        out = await pipelinePost(env, j, now, deps);
      } else return json({ error: 'Method not allowed' }, 405);
      return json(out.body, out.status);
    }
    // Off unless the Worker has AD_VIEWER = "on": the board no longer uses it, and a Meta token left in the Worker by an
    // older deploy is never sent anywhere.
    if (path.startsWith('/api/ad/') && env.AD_VIEWER === 'on') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const id = path.slice('/api/ad/'.length);
      if (!/^\d{1,25}$/.test(id)) return json({ error: 'Bad ad id' }, 400);
      const out = await adView(id, env, { now, launch });
      return json(out.body, out.status);
    }
    // ---- Momentum (momentum.mjs): the daily trend summaries, read only. A block of its own, as Launch. /momentum.js: the
    // scoring and the sparklines the board draws with.
    if (path === '/api/momentum' || path === '/momentum.js') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (path === '/momentum.js') return text(MOMENTUM_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      const scope = ['tiktok', 'eu'].includes(url.searchParams.get('scope')) ? url.searchParams.get('scope') : 'world';
      // The products in memory and only what was decided (hidden): no stars or feedback read for the panel.
      const lean = async () => products(await snapshot(env.DB, now), (await env.DB.prepare('SELECT ad_id, status, at FROM hidden').all()).results, [], now);
      return json(await momentumApi(env, scope, { board: lean, toAd }));
    }
    // ---- Compliance and risk radar (risk.mjs): Block / Docs / OK per product, and your trademark and documents checks. A
    // block of its own, like the Launch view. /risk.js: the radar's rules, which the board runs as well.
    if (path === '/api/risk' || path === '/risk.js') {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (path === '/risk.js') return method === 'GET' ? text(RISK_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' }) : json({ error: 'Method not allowed' }, 405);
      if (method === 'GET') return json(await riskList(env));
      if (method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const { j, err } = await readJson(req, url);
      if (err) return err;
      const out = await riskPost(env, j, now, { rows: () => snapshot(env.DB, now) });
      return json(out.body, out.status);
    }
    return text('Not found', 404);
  } catch (e) {
    const notReady = /no such table/i.test(String(e && e.message));
    console.error(e);
    return json({ error: notReady ? 'Database not ready: run the Winner Hunter workflow once.' : 'Server error' }, notReady ? 503 : 500);
  }
}
