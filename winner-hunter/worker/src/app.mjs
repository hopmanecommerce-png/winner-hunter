/*
 * The Winner Hunter board: a PIN-protected page plus a tiny JSON API on top of D1 (binding DB).
 *   GET  /            board (or the PIN screen)        POST /login   PIN form → cookie
 *   GET  /api/ads     ads of a view, counts, last run, alert banner   POST /api/hide  seen / rejected / none, starred / unstarred
 *   GET  /export.csv  the current view as CSV           GET  /logout
 *   GET  /api/ad/:id  the ad itself (text, video/images, CTA) for the in-board viewer (adview.mjs)
 *   GET  /api/markets EU reach a day per country over the board's products (Market Radar)
 * All SQL is parameterized; sort orders come from a fixed list.
 */

import { adView } from './adview.mjs';

const COOKIE = '__Host-wh';
const MAX_AGE = 90 * 864e2; // seconds
// The hard rules (same as lib/score.mjs): rows that fail any of them are never shown, counted or exported.
// Shopify is checked before a row is ever saved, so every row in D1 passed it.
export const MIN_ACTIVE_ADS = 75;
export const MIN_AGE_DAYS = 7;
export const MAX_AGE_DAYS = 42; // ad age today: the age when last seen + the whole days since
export const MIN_REACH_PER_DAY = 500;
const PIN_TRIES = 10; // wrong PINs per IP per 15 minutes
const PIN_WINDOW = 15 * 60000;
const STALE_HOURS = 36; // no finished run for this long: red banner
const TOKEN_DAYS = 7; // a Meta token expiring within this many days: red banner

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

// One product = one advertiser + one product title: duplicates of it collapse into its best ad (most reach a day).
// The first bound parameter of every query on BASE is "now" (ISO), for the ad age today.
const KEY = `COALESCE(w.advertiser_page_id, '') || '|' || lower(trim(COALESCE(NULLIF(w.product_title, ''), w.ad_id)))`;
const RPD = `CAST(COALESCE(w.reach_eu, 0) AS REAL) / MAX(COALESCE(w.ad_age_days, 0), 1)`;
const AGE_NOW = `(COALESCE(w.ad_age_days, 0) + MAX(CAST(julianday(?1) - julianday(w.last_seen) AS INTEGER), 0))`;
const PASS = `(COALESCE(w.active_ads, 0) >= ${MIN_ACTIVE_ADS} AND w.ad_age_days IS NOT NULL AND ${AGE_NOW} BETWEEN ${MIN_AGE_DAYS} AND ${MAX_AGE_DAYS} AND ${RPD} >= ${MIN_REACH_PER_DAY})`;
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

const SNAP_SQL = `SELECT w.ad_id, ${KEY} AS gk, w.product_title, w.price, w.compare_at_price, w.currency, w.advertiser, w.active_ads,
  w.ad_age_days, w.reach_eu, w.scaled_count, w.keyword, w.store_url, w.product_url, w.ad_library_url, w.image_url,
  w.first_seen, w.last_seen, w.data FROM winners w`;
// Store signals (bestsellers.mjs, once a day), read with the winners and kept on each row: w.bs (best-seller rank)
// and w.tp (the store's Trustpilot score).
const BS_SQL = 'SELECT product_key, rank, ok, history FROM bestseller';
const TRUST_SQL = 'SELECT store, status, score, reviews, profile FROM store_trust';
const VERSION_SQL = `SELECT (SELECT MAX(rowid) FROM winners) AS r, (SELECT updated_at FROM state WHERE key = 'last_run') AS u`;
const SNAP_MS = 15 * 60000; // read again after this long anyway
const SNAPS = new WeakMap(); // per D1 binding
let LAST = null; // on Cloudflare (one database): shared by the requests this isolate serves

/** All winners rows, read again only when a run saved something (or after 15 minutes). */
export async function snapshot(DB, now = Date.now()) {
  const v = await DB.prepare(VERSION_SQL).first();
  const ver = `${v && v.r}|${v && v.u}`;
  const shared = typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
  let s = SNAPS.get(DB) || (shared ? LAST : null);
  if (!s || s.ver !== ver || now - s.at > SNAP_MS || now < s.at) {
    const optional = (sql) => DB.prepare(sql).all().then((r) => r.results || [], () => []); // no table yet: the board still works
    const [{ results }, bs, tp] = await Promise.all([DB.prepare(SNAP_SQL).all(), optional(BS_SQL), optional(TRUST_SQL)]);
    const best = new Map(bs.map((b) => [b.product_key, b]));
    const trust = new Map(tp.map((t) => [t.store, t]));
    for (const w of results) {
      const key = productKey(w.product_url);
      const b = best.get(key);
      if (b) w.bs = b;
      const t = trust.get(key.split('/')[0] || storeOf(w.store_url));
      if (t) w.tp = t;
    }
    s = { ver, at: now, rows: results };
    SNAPS.set(DB, s);
    if (shared) LAST = s;
  }
  return s.rows;
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

const bsRank = (r) => (r.bs && Number(r.bs.ok) && r.bs.rank != null ? Number(r.bs.rank) : null);
/** The inbox puts products that sell first: × 1.5 in the store's top 10, × 1.2 in its top 50. */
export const sellsBoost = (r) => {
  const k = bsRank(r);
  return k == null ? 1 : k <= 10 ? 1.5 : 1.2;
};

const num = (x) => Number(x) || 0;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const better = (a, b) => b.rpd - a.rpd || cmp(a.ad_id, b.ad_id); // < 0: a first
function countriesOf(w) {
  if (!w._mk) {
    let d = {};
    try { d = JSON.parse(w.data || '{}') || {}; } catch (e) { d = {}; }
    w._mk = parseCountries(d.top_countries);
  }
  return w._mk;
}

/**
 * The rules at `now`, one product per advertiser + title, with its status. v: the board (each product's best
 * passing ad: most reach a day). k: every product once, its best ad (passing first): the ★ and ✓ Made ad lists keep
 * a product after it ages out of the rules. ids: the ads of each product (gk), for /api/hide. hat: when it was
 * marked seen (made ad) or rejected.
 */
export function products(rows, hidden = [], stars = [], now = Date.now()) {
  const hidOf = new Map(hidden.map((h) => [h.ad_id, { hid: h.status === 'rejected' ? 2 : h.status === 'seen' ? 1 : 0, at: h.at || '' }]));
  const starred = new Set(stars.map((x) => x.ad_id));
  const groups = new Map();
  for (const w of rows) {
    const seen = Date.parse(w.last_seen);
    const age = Number.isFinite(seen) ? num(w.ad_age_days) + Math.max(Math.trunc((now - seen) / 864e5), 0) : null;
    const rpd = num(w.reach_eu) / Math.max(num(w.ad_age_days), 1);
    const pass = num(w.active_ads) >= MIN_ACTIVE_ADS && w.ad_age_days != null && age != null && age >= MIN_AGE_DAYS && age <= MAX_AGE_DAYS && rpd >= MIN_REACH_PER_DAY ? 1 : 0;
    const r = Object.assign({}, w, { rpd, age_now: age, pass, mk: countriesOf(w) });
    let g = groups.get(w.gk);
    if (!g) groups.set(w.gk, (g = { hid: 0, hat: '', star: 0, best: null, any: null, ids: [] }));
    g.ids.push(w.ad_id);
    const h = hidOf.get(w.ad_id);
    if (h) { g.hid = Math.max(g.hid, h.hid); if (h.at > g.hat) g.hat = h.at; }
    if (starred.has(w.ad_id)) g.star = 1;
    if (pass && (!g.best || better(r, g.best) < 0)) g.best = r;
    if (!g.any || pass > g.any.pass || (pass === g.any.pass && better(r, g.any) < 0)) g.any = r;
  }
  const v = [];
  const k = [];
  for (const g of groups.values()) {
    if (g.best) v.push(Object.assign(g.best, { hid: g.hid, hat: g.hat, star: g.star }));
    k.push(g.any === g.best ? g.any : Object.assign(g.any, { hid: g.hid, hat: g.hat, star: g.star }));
  }
  return { v, k, groups };
}

/** The board from D1: winners (cached), seen / rejected and stars (fresh). */
async function board(env, now) {
  const [rows, h, s, f] = await Promise.all([
    snapshot(env.DB, now),
    env.DB.prepare('SELECT ad_id, status, at FROM hidden').all(),
    env.DB.prepare('SELECT ad_id FROM stars').all(),
    env.DB.prepare("SELECT action, reasons, keyword, store, price FROM feedback WHERE action != 'general'").all(),
  ]);
  return Object.assign(products(rows, h.results, s.results, now), { taste: tasteOf(f.results) });
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

/**
 * What your decisions say. Per search keyword (niche): weight = (liked + 1) / (rejected + 1), between 0.3 and 3
 * ("not my niche" / "my niche" count double). Stores rejected as "Bad store" leave the inbox. Price: once two
 * products were "too expensive", everything from the cheapest of those up ranks at half.
 */
export function tasteOf(fb = []) {
  const kw = new Map();
  const blocked = new Map();
  const pricey = [];
  for (const f of fb) {
    if (!DECISIONS.has(f.action)) continue; // notes and board notes are not decisions
    const r = reasonsOf(f.reasons);
    const bad = f.action === 'rejected';
    const k = String(f.keyword || '').trim().toLowerCase();
    if (k) {
      const x = kw.get(k) || { good: 0, bad: 0 };
      if (bad) x.bad += r.includes('niche') ? 2 : 1;
      else x.good += r.includes('niche') ? 2 : 1;
      kw.set(k, x);
    }
    if (bad && r.includes('store') && storeOf(f.store)) blocked.set(storeOf(f.store), (blocked.get(storeOf(f.store)) || 0) + 1);
    if (bad && r.includes('price') && Number(f.price) > 0) pricey.push(Number(f.price));
  }
  const weights = new Map([...kw].map(([k, x]) => [k, Math.round(clamp((x.good + 1) / (x.bad + 1), 0.3, 3) * 100) / 100]));
  pricey.sort((a, b) => a - b);
  return { kw, weights, blocked, maxPrice: pricey.length >= 2 ? pricey[0] : null };
}

/** How well a product fits your taste (1 = no opinion yet): the inbox sorts by reach a day × this. */
export function fitOf(r, taste) {
  if (!taste) return 1;
  let w = taste.weights.get(String(r.keyword || '').trim().toLowerCase()) ?? 1;
  if (taste.maxPrice != null && Number(r.price) >= taste.maxPrice) w *= 0.5;
  return w;
}

const SORTS = {
  rpd: better,
  new: (a, b) => cmp(b.first_seen ?? '', a.first_seen ?? '') || b.rpd - a.rpd,
  scaled: (a, b) => num(b.scaled_count) - num(a.scaled_count) || b.rpd - a.rpd,
  ads: (a, b) => num(b.active_ads) - num(a.active_ads) || b.rpd - a.rpd,
  reach: (a, b) => num(b.reach_eu) - num(a.reach_eu) || b.rpd - a.rpd,
  best: (a, b) => (bsRank(a) ?? 999) - (bsRank(b) ?? 999) || better(a, b),
};

/** One view of the board: filters, one market (?cc=FR: best first by the reach a day there), sort and page. */
export function viewOf(p, list, { csv = false } = {}) {
  const view = ['starred', 'made', 'inbox'].includes(p.get('view')) ? p.get('view') : 'all';
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
    out = list.v.filter((r) => inInbox(r) && !blockedBy(r, list.taste)) // not decided yet: not seen, rejected or kept (★)
      .map((r) => Object.assign({}, r, { fit: fitOf(r, list.taste), boost: sellsBoost(r) }));
    sort = (a, b) => b.rpd * b.fit * b.boost - a.rpd * a.fit * a.boost || cmp(a.ad_id, b.ad_id);
    limit = csv ? 5000 : Math.min(Math.max(parseInt(p.get('limit'), 10) || 20, 1), 100);
  } else {
    const hidden = p.get('hidden') === '1';
    out = list.v.filter((r) => (hidden ? r.hid > 0 : r.hid === 0));
    const minRpd = Number(p.get('rpd'));
    if (minRpd === 2500 || minRpd === 10000) out = out.filter((r) => r.rpd >= minRpd);
    const q = String(p.get('q') || '').trim().slice(0, 80).toLowerCase();
    if (q) out = out.filter((r) => [r.product_title, r.advertiser, r.store_url, r.keyword].some((x) => String(x ?? '').toLowerCase().includes(q)));
    sort = SORTS[p.get('sort')] || SORTS.rpd;
    const cc = String(p.get('cc') || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) {
      out = out.flatMap((r) => {
        const hit = r.mk.find(([c]) => c === cc);
        return hit ? [Object.assign({}, r, { crpd: (r.rpd * hit[1]) / 100 })] : [];
      });
      if (!SORTS[p.get('sort')] || p.get('sort') === 'rpd') sort = (a, b) => b.crpd - a.crpd || cmp(a.ad_id, b.ad_id);
    }
    limit = csv ? 5000 : Math.min(Math.max(parseInt(p.get('limit'), 10) || 40, 1), 100);
    offset = offsetOf(p, csv);
  }
  out.sort(sort);
  return { view, total: out.length, offset, rows: out.slice(offset, offset + limit) };
}

const offsetOf = (p, csv) => (csv ? 0 : Math.min(Math.max(parseInt(p.get('offset'), 10) || 0, 0), 100000));

const inInbox = (r) => r.hid === 0 && !r.star;
const blockedBy = (r, taste) => !!(taste && taste.blocked.size && taste.blocked.has(storeOf(r.store_url)));
const NEW_MS = 864e5; // found in the last day: new

export const countsOf = (list, now = Date.now()) => ({
  all: list.v.filter((r) => r.hid === 0).length,
  inbox: list.v.filter((r) => inInbox(r) && !blockedBy(r, list.taste)).length,
  fresh: list.v.filter((r) => inInbox(r) && !blockedBy(r, list.taste) && now - Date.parse(r.first_seen) < NEW_MS).length,
  starred: list.k.filter((r) => r.star).length,
  made: list.k.filter((r) => r.hid === 1).length,
  hidden: list.v.filter((r) => r.hid > 0).length,
});

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

// The cookie: "<expiry>.<HMAC(pin + expiry)>", keyed with a secret derived from BOARD_PIN.
// Changing BOARD_PIN logs every phone out.
async function sign(pin, exp) {
  const key = await crypto.subtle.importKey('raw', await sha256('winner-hunter-board|' + pin), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`board|${pin}|${exp}`)));
}
export async function makeToken(pin, now = Date.now()) {
  const exp = Math.floor(now / 1000) + MAX_AGE;
  return `${exp}.${await sign(pin, exp)}`;
}
async function authed(req, env, now) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)__Host-wh=([0-9]+)\.([A-Za-z0-9_-]{20,100})(?:;|$)/);
  if (!m || !env.BOARD_PIN) return false;
  if (Number(m[1]) * 1000 < now) return false;
  return same(m[2], await sign(env.BOARD_PIN, m[1]));
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
    ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src https:; media-src https:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
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
<meta name="theme-color" content="#04050a"><meta name="color-scheme" content="dark">
<style nonce="${nonce}">
:root{color-scheme:dark;--bg:#04050a;--card:#0b0d18;--ink:#eef1ff;--muted:#8f95b8;--line:rgba(150,160,255,.14);--cy:#2ee6ff;--bad:#ff5c7a;--holo:linear-gradient(110deg,#2ee6ff,#8b5cff 52%,#ff4fd8)}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;color:var(--ink);-webkit-font-smoothing:antialiased;
font:16px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Display","Inter","Segoe UI",Roboto,system-ui,sans-serif;
background:radial-gradient(40vmax 30vmax at 20% 10%,rgba(46,230,255,.16),transparent 70%),radial-gradient(36vmax 28vmax at 85% 0,rgba(255,79,216,.14),transparent 70%),radial-gradient(40vmax 30vmax at 50% 110%,rgba(139,92,255,.16),transparent 70%),var(--bg)}
form{width:100%;max-width:350px;display:grid;gap:14px;padding:30px 24px 24px;border-radius:24px;border:1px solid transparent;
background:linear-gradient(var(--card),var(--card)) padding-box,linear-gradient(135deg,rgba(46,230,255,.6),rgba(139,92,255,.15) 45%,rgba(255,79,216,.55)) border-box;box-shadow:0 30px 80px -30px rgba(46,230,255,.4)}
.orb{position:relative;width:48px;height:48px;border-radius:50%;background:conic-gradient(#2ee6ff,#8b5cff,#ff4fd8,#2ee6ff);animation:s 6s linear infinite;box-shadow:0 0 26px rgba(46,230,255,.5),0 0 46px rgba(255,79,216,.3)}
.orb::before{content:'';position:absolute;inset:4px;border-radius:50%;background:radial-gradient(circle,#fff 0 4px,#0b0d18 5px)}
@keyframes s{to{transform:rotate(360deg)}}
.k{font:600 10.5px ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-top:6px}
h1{margin:-6px 0 0;font-size:26px;font-weight:780;letter-spacing:-.03em}p{margin:0;color:var(--muted);font-size:14px}
input{font:700 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.4em;text-align:center;padding:14px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.04);color:var(--ink);width:100%;outline:none}
input:focus{border-color:var(--cy);box-shadow:0 0 0 3px rgba(46,230,255,.14),0 0 26px -8px var(--cy)}
button{font:700 12.5px ui-monospace,"SF Mono",Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;padding:16px;border:0;border-radius:14px;background:var(--holo);color:#06070d;cursor:pointer;box-shadow:0 0 30px -8px rgba(139,92,255,.9)}
.err{color:var(--bad);font-weight:600}
@media (prefers-reduced-motion:reduce){.orb{animation:none}}
</style></head><body>
<form method="post" action="/login"><span class="orb" aria-hidden="true"></span>
<span class="k">EU ad intelligence</span><h1>Winner Hunter</h1><p>Enter your PIN to open the board.</p>
<input name="pin" type="password" inputmode="numeric" autocomplete="current-password" maxlength="64" required autofocus aria-label="PIN">
${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}<button type="submit">Open</button></form></body></html>`;
  return secure(new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } }), { nonce, html: true });
}

const nonceOf = () => b64url(crypto.getRandomValues(new Uint8Array(16)));
const ipOf = (req) => (req.headers.get('cf-connecting-ip') || 'unknown').slice(0, 64);

async function stateJson(DB, key) {
  const row = await DB.prepare('SELECT value, updated_at FROM state WHERE key = ?').bind(key).first();
  if (!row) return null;
  try {
    return Object.assign(JSON.parse(row.value), { updated_at: row.updated_at });
  } catch (e) {
    return null;
  }
}

/**
 * The banner on top of the board, or null. Red: the last run failed, no run finished in 36 hours, or a Meta
 * token expires within 7 days. Yellow: the last run had warnings.
 */
export function boardAlert(run, token, now = Date.now()) {
  const red = [];
  const yellow = [];
  if (run) {
    if (run.health === 'failed') red.push(run.alert || 'Laatste run mislukt / Last run failed');
    else if (run.health === 'warning') yellow.push(run.alert || 'Laatste run had waarschuwingen / Last run had warnings');
    const at = Date.parse(run.finished_at || run.started_at || run.updated_at || '');
    if (Number.isFinite(at) && now - at > STALE_HOURS * 3600e3) red.push(`Geen run in ${STALE_HOURS} uur / No run in ${STALE_HOURS} hours`);
  }
  const exp = token && token.at ? Date.parse(token.at) : NaN;
  if (Number.isFinite(exp) && exp - now < TOKEN_DAYS * 864e5) {
    const days = Math.floor((exp - now) / 864e5);
    red.push(days < 0 ? 'Meta token verlopen / Meta token expired' : `Meta token verloopt over ${days} dagen / Meta token expires in ${days} days`);
  }
  if (red.length) return { level: 'red', text: red.join(' · ') };
  if (yellow.length) return { level: 'yellow', text: yellow.join(' · ') };
  return null;
}

const httpsOr = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');

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
  return {
    id: String(r.ad_id),
    title: r.product_title || '',
    price: r.price,
    was: r.compare_at_price,
    cur: r.currency || '',
    off,
    reach: r.reach_eu,
    rpd: Math.round(r.rpd || 0),
    age: r.age_now ?? r.ad_age_days,
    ads: r.active_ads,
    scaled: r.scaled_count,
    products: Number.isFinite(Number(d.store_products)) && d.store_products !== null ? Number(d.store_products) : null,
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
    best: bestOf(r.bs),
    trust: trustOf(r.tp),
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
];
export const toCsv = (ads) => [CSV_COLS.map((c) => c[0]).join(','), ...ads.map((a) => CSV_COLS.map(([, f]) => csvCell(f(a))).join(','))].join('\r\n') + '\r\n';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function login(req, env, now) {
  const nonce = nonceOf();
  const ct = req.headers.get('content-type') || '';
  if (!/application\/x-www-form-urlencoded|multipart\/form-data/.test(ct)) return pinPage(nonce, 'Enter your PIN.', 400);
  const key = 'pinfail:' + ipOf(req);
  let fails = { n: 0, since: now };
  try {
    const row = await env.DB.prepare('SELECT value FROM state WHERE key = ?').bind(key).first();
    if (row) fails = JSON.parse(row.value);
  } catch (e) {
    // no state table yet: no lockout
  }
  if (now - fails.since > PIN_WINDOW) fails = { n: 0, since: now };
  if (fails.n >= PIN_TRIES) return pinPage(nonce, 'Too many wrong PINs. Try again in 15 minutes.', 429);
  const form = await req.formData().catch(() => null);
  const pin = String((form && form.get('pin')) || '').slice(0, 64);
  // Compare hashes in constant time, so the answer time says nothing about the PIN.
  const ok = pin && same(b64url(await sha256(pin)), b64url(await sha256(env.BOARD_PIN)));
  try {
    if (ok) await env.DB.prepare('DELETE FROM state WHERE key = ?').bind(key).run();
    else {
      await env.DB.prepare('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .bind(key, JSON.stringify({ n: fails.n + 1, since: fails.since }), new Date(now).toISOString()).run();
      await env.DB.prepare("DELETE FROM state WHERE key LIKE 'pinfail:%' AND updated_at < ?").bind(new Date(now - 864e5).toISOString()).run();
    }
  } catch (e) {
    // counting is best effort
  }
  if (!ok) return pinPage(nonce, 'Wrong PIN.', 401);
  return redirect('/', `${COOKIE}=${await makeToken(env.BOARD_PIN, now)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`);
}

async function ads(url, env, now, viewer) {
  const list = await board(env, now);
  const q = viewOf(url.searchParams, list);
  const counts = countsOf(list, now);
  const run = await stateJson(env.DB, 'last_run');
  // While a run hunts, the board also shows what the run before it found.
  const prev = run && run.status === 'running'
    ? await env.DB.prepare('SELECT started_at, finished_at, ads_checked, winners FROM runs WHERE finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1').first()
    : null;
  return json({
    view: q.view,
    ads: q.rows.map(toAd),
    total: q.total,
    offset: q.offset,
    counts,
    last_run: run,
    prev_run: prev || null,
    alert: boardAlert(run, await stateJson(env.DB, 'token_expires_at'), now),
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
  if (ACTION_OF[status]) {
    steps.push(env.DB.prepare('INSERT INTO feedback (ad_id, action, reasons, note, keyword, store, advertiser, title, price, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, ACTION_OF[status], '[]', '', me.keyword ?? '', me.store_url ?? '', me.advertiser ?? '', String(me.product_title ?? '').slice(0, 200), me.price ?? null, at));
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
 * POST /api/feedback. {ad_id, reasons?, note?}: why you made that decision (on its latest feedback row).
 * {general: "…"}: a note about the board. {unblock: "shop.com"}: that store may come back in the inbox.
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
  const row = await env.DB.prepare("SELECT id, action FROM feedback WHERE ad_id = ? AND action != 'general' ORDER BY id DESC LIMIT 1").bind(id).first();
  if (!row) return json({ error: 'Decide first' }, 404);
  const allowed = REASONS[row.action === 'rejected' ? 'bad' : 'good'];
  const sets = [];
  const vals = [];
  if (Array.isArray(j.reasons)) {
    sets.push('reasons = ?');
    vals.push(JSON.stringify([...new Set(j.reasons.map(String))].filter((r) => r in allowed)));
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
    const steps = [];
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      steps.push(env.DB.prepare(`DELETE FROM feedback WHERE action = 'note' AND ad_id IN (${part.map(() => '?').join(', ')})`).bind(...part));
    }
    if (text) {
      steps.push(env.DB.prepare("INSERT INTO feedback (ad_id, action, reasons, note, keyword, store, advertiser, title, price, at) VALUES (?, 'note', '[]', ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, text, me.keyword ?? '', me.store_url ?? '', me.advertiser ?? '', String(me.product_title ?? '').slice(0, 200), me.price ?? null, new Date(now).toISOString()));
    }
    await env.DB.batch(steps);
    return json({ ok: true });
  }
  const { results } = await env.DB.prepare("SELECT ad_id, action, note, store, advertiser, title, at FROM feedback WHERE ad_id IS NOT NULL AND note != '' ORDER BY id DESC LIMIT 2000").all();
  const mine = new Set(ids);
  const own = results.find((f) => f.action === 'note' && mine.has(f.ad_id));
  const shop = storeOf(me.store_url);
  const others = results.filter((f) => !mine.has(f.ad_id) && ((shop && storeOf(f.store) === shop) || (me.advertiser && f.advertiser === me.advertiser)))
    .slice(0, 5).map((f) => ({ title: f.title || '', note: f.note, at: f.at }));
  return json({ note: own ? own.note : '', others });
}

/** GET /api/learned: what the board learned from your feedback, for the 🧠 page (and for Claude to read). */
async function learned(env) {
  const { results } = await env.DB.prepare('SELECT ad_id, action, reasons, note, keyword, store, advertiser, title, price, at FROM feedback ORDER BY id DESC LIMIT 5000').all();
  const taste = tasteOf(results.filter((f) => f.action !== 'general'));
  const by = { rejected: 0, keep: 0, seen: 0 };
  const count = { bad: {}, good: {} };
  for (const f of results) {
    if (!(f.action in by)) continue;
    by[f.action]++;
    const side = f.action === 'rejected' ? 'bad' : 'good';
    for (const r of reasonsOf(f.reasons)) if (r in REASONS[side]) count[side][r] = (count[side][r] || 0) + 1;
  }
  const list = (side) => Object.entries(count[side]).map(([key, n]) => ({ key, label: REASONS[side][key], n })).sort((a, b) => b.n - a.n);
  return json({
    decisions: by.rejected + by.keep + by.seen,
    by_action: by,
    reasons: { bad: list('bad'), good: list('good') },
    reason_labels: REASONS,
    niches: [...taste.kw].map(([kw, x]) => ({ kw, good: x.good, bad: x.bad, weight: taste.weights.get(kw) })).sort((a, b) => b.weight - a.weight || b.good - a.good),
    blocked: [...taste.blocked].map(([store, n]) => ({ store, n })),
    max_price: taste.maxPrice,
    notes: results.filter((f) => f.note).slice(0, 50).map((f) => ({ action: f.action, title: f.title || '', note: f.note, reasons: reasonsOf(f.reasons), at: f.at })),
  });
}

async function csv(url, env, now) {
  const q = viewOf(url.searchParams, await board(env, now), { csv: true });
  const results = q.rows;
  const day = new Date(now).toISOString().slice(0, 10);
  return text(toCsv(results.map(toAd)), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="winners-${q.view}-${day}.csv"` });
}

/**
 * The Worker. `launch(env.BROWSER)` opens a Browser Run browser (index.mjs passes @cloudflare/puppeteer's launch;
 * tests pass a fake). Without it, a META_TOKEN or the BROWSER binding the viewer is off and "▶ Bekijk ad" opens the Ad Library.
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
        return json(marketsOf((await board(env, now)).v.filter((r) => r.hid === 0)));
      }
      if (path === '/api/ads' && method === 'GET') return await ads(url, env, now, !!(launch && env.BROWSER && String(env.META_TOKEN || '').trim()));
      if (path === '/api/hide' && method === 'POST') return await hide(req, url, env, now);
      if (path === '/api/feedback' && method === 'POST') return await feedback(req, url, env, now);
      if (path === '/api/learned' && method === 'GET') return await learned(env);
      if (path === '/api/note' && (method === 'GET' || method === 'POST')) return await note(req, url, env, now);
      if (path === '/export.csv' && method === 'GET') return await csv(url, env, now);
      return json({ error: 'Method not allowed' }, 405);
    }
    if (path.startsWith('/api/ad/')) {
      if (!ok) return json({ error: 'Log in first' }, 401);
      if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const id = path.slice('/api/ad/'.length);
      if (!/^\d{1,25}$/.test(id)) return json({ error: 'Bad ad id' }, 400);
      const out = await adView(id, env, { now, launch });
      return json(out.body, out.status);
    }
    return text('Not found', 404);
  } catch (e) {
    const notReady = /no such table/i.test(String(e && e.message));
    console.error(e);
    return json({ error: notReady ? 'Database not ready: run the Winner Hunter workflow once.' : 'Server error' }, notReady ? 503 : 500);
  }
}
