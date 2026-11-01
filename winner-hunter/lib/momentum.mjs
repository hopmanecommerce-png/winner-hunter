/*
 * Momentum, the job's pure parts: momentum.mjs reads D1 and runs these once a day; worker/src/momentum.mjs scores and shows
 * the summaries they make. No D1, no network here.
 *   itemsOf(rows, opts)          the board's products (EU, outside the EU, TikTok) as one list, with today's numbers
 *   historyOf(dailyRows)         momentum_daily → Map product key → [[day, numbers], …] oldest first
 *   trend / rankTrend / soldTrend / priceChange    a number now against about a week ago
 *   rivalsOf(items, opts)        other stores selling the same item: same words, the supplier's photo or a photo that looks the same
 *   summaryOf(item, hist, extra) the summary the board reads (worker/src/momentum.mjs scores it)
 *   trendsQuery / trendsOf       Google Trends through SerpApi: the search words, and the answer in a few numbers
 *   partsOf(map, maxBytes)       JSON rows of at most maxBytes, for D1
 */
import { productKey } from './bestsellers.mjs';

export const DAY = 864e5;
export const HISTORY_DAYS = 45; // daily rows read back: TikTok's numbers only change with an import, weeks apart
export const SPARK_DAYS = 14; // days on a sparkline
export const KEEP_DAYS = 120; // daily rows older than this are removed
export const NEW_DAYS = 14; // a rival store first seen this recently is a new one
export const LIVE_DAYS = 30; // an EU product seen this recently still counts as a rival
export const SAME_PHOTO = 6; // photos whose fingerprints differ in at most this many of 64 bits look the same

const num = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const round = (x, d = 2) => {
  const f = 10 ** d;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
};
/** 'YYYY-MM-DD' (UTC) of a time in ms or an ISO date, '' when there is none. */
export const dayOf = (t) => {
  const ms = typeof t === 'number' ? t : Date.parse(t || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '';
};
/** Whole days from day a to day b ('YYYY-MM-DD'). */
export const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
const jsonOf = (s, or) => {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' ? v : or;
  } catch (e) {
    return or;
  }
};
const hostOf = (u) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\d?\./, '');
  } catch (e) {
    return '';
  }
};
const intOr = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? undefined : Math.round(Number(x)));
const numOr = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? undefined : Number(x));

// ---------------------------------------------------------------------------
// The products: one list from the board's tables
// ---------------------------------------------------------------------------

/** An EU product's group key, as the board makes it (app.mjs KEY): advertiser page id + the title in lower case. */
export const EU_KEY = `COALESCE(advertiser_page_id, '') || '|' || lower(trim(COALESCE(NULLIF(product_title, ''), ad_id)))`;
const ttTitle = (t) => String(t || '').replace(/^\s*【[^】]*】\s*/, '').trim();

/**
 * The products as one list. rows: { world, eu, tiktok } (the SELECTs in momentum.mjs), best: Map product page key →
 * bestseller row, survival: Map world product key → { survived, long_ads }, decided: Set of product keys (approved,
 * starred, a launch card). Each item: { key, src, title, store, img, first, live, tracked, today, sv, sl, geo }.
 * tracked: on the board or decided (it gets a snapshot and a summary); live: still selling, so it counts as a rival.
 */
export function itemsOf({ world = [], eu = [], tiktok = [] }, { best = new Map(), survival = new Map(), decided = new Set(), now = Date.now() } = {}) {
  const items = [];
  const today = dayOf(now);
  const rankOf = (url, key) => {
    const b = best.get(productKey(url) || key || '');
    if (!b || !Number(b.ok)) return undefined;
    if (dayOf(b.checked_at) && daysBetween(dayOf(b.checked_at), today) > 2) return undefined; // not checked lately: unknown
    return b.rank == null ? 0 : Number(b.rank);
  };
  for (const w of world) {
    const key = 'world|' + w.product_key;
    const markets = jsonOf(w.markets, {});
    const ccs = Object.keys(markets);
    const active = Number(w.active) !== 0;
    const s = survival.get(w.product_key) || {};
    const top = ccs.sort((a, b) => (Number(markets[b] && markets[b].ads) || 0) - (Number(markets[a] && markets[a].ads) || 0))[0] || '';
    items.push({
      key, src: 'world', title: w.product_title || '', store: String(w.product_key).split('/')[0], img: w.image_url || '', url: w.product_url || '',
      first: w.first_seen || '', live: active, tracked: active || decided.has(key), geo: top,
      today: clean({ a: intOr(w.ads), s: intOr(w.shop_ads), n: intOr(w.new14), m: ccs.length || undefined, e: intOr(w.eu_rpd), b: rankOf(w.product_url, w.product_key), p: numOr(w.price), x: active ? undefined : 0 }),
      sv: intOr(s.survived), sl: intOr(s.long_ads),
    });
  }
  // EU: one product per advertiser + title (as the board), its best ad (most reach a day) gives the numbers.
  const groups = new Map();
  for (const w of eu) {
    if (!groups.has(w.gk)) groups.set(w.gk, []);
    groups.get(w.gk).push(w);
  }
  const rpd = (w) => (Number(w.reach_eu) || 0) / Math.max(Number(w.ad_age_days) || 0, 1);
  for (const [gk, rows] of groups) {
    const bestAd = rows.reduce((x, y) => (rpd(y) > rpd(x) || (rpd(y) === rpd(x) && y.ad_id < x.ad_id) ? y : x));
    const key = 'eu|' + gk;
    const last = rows.map((r) => r.last_seen || '').sort().pop() || '';
    const ages = rows.map((r) => Number(r.ad_age_days)).filter(Number.isFinite);
    const page = rows.map((r) => r.product_url).find((u) => productKey(u)) || bestAd.product_url || '';
    items.push({
      key, src: 'eu', title: bestAd.product_title || '', store: hostOf(bestAd.store_url) || hostOf(page), img: rows.map((r) => r.image_url).find(Boolean) || '', url: page,
      first: rows.map((r) => r.first_seen || '').filter(Boolean).sort()[0] || '',
      live: !!last && daysBetween(dayOf(last), today) <= LIVE_DAYS, tracked: rows.some((r) => Number(r.pass) === 1) || decided.has(key),
      geo: (/\b([A-Z]{2}) \d{1,3}%/.exec(String(bestAd.tc || '')) || [])[1] || '',
      today: clean({ a: intOr(bestAd.scaled_count), s: intOr(bestAd.active_ads), e: Math.round(rpd(bestAd)) || undefined, b: rankOf(page), p: numOr(bestAd.price), w: dayOf(last) || undefined }),
      sv: ages.length ? Math.max(...ages) : undefined, sl: ages.filter((a) => a >= 30).length || undefined,
    });
  }
  for (const t of tiktok) {
    const key = 'tiktok|' + t.id;
    items.push({
      // No first-seen day: updated_at is the day of the import, so every TikTok shop would look new after each one.
      key, src: 'tiktok', title: ttTitle(t.title), store: 'tiktok:' + String(t.shop || t.id).trim().toLowerCase(), shop: String(t.shop || ''), img: t.image_url || '', url: '',
      first: '', live: true, tracked: true, geo: 'US',
      today: clean({ o: intOr(t.sold_us), c: intOr(t.creators), p: numOr(t.price_min), t: dayOf(t.updated_at) || undefined }),
    });
  }
  return items;
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'number' && !Number.isFinite(v))));

// ---------------------------------------------------------------------------
// History and trends
// ---------------------------------------------------------------------------

/** momentum_daily rows ({ day, body }) → Map product key → [[day, numbers], …], oldest first, one entry a day. */
export function historyOf(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const body = jsonOf(r.body, {});
    for (const [k, v] of Object.entries(body)) {
      if (!v || typeof v !== 'object') continue;
      if (!out.has(k)) out.set(k, []);
      out.get(k).push([r.day, v]);
    }
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (let i = list.length - 1; i > 0; i--) if (list[i][0] === list[i - 1][0]) list.splice(i - 1, 1); // one a day: the later one
  }
  return out;
}

/**
 * A number now against about a week ago. points: [[day, value, seen?]] oldest first; the last one is now. The older
 * number: the newest one 7 or more days before (at most 21), else the oldest one 3 or more days before. seen: the day the
 * source last saw the product (the EU board): when it did not move, nothing new was measured and there is no trend.
 * c: the change against the older number (at least `floor`), from −1 to +1. null: no older number yet.
 */
export function trend(points, floor = 1) {
  const p = (points || []).filter(([, v]) => num(v));
  if (p.length < 2) return null;
  const [lastDay, to, seenTo] = p[p.length - 1];
  const back = (d) => daysBetween(d, lastDay);
  const older = p.slice(0, -1).filter(([d]) => back(d) >= 3 && back(d) <= 21);
  if (!older.length) return null;
  const weekish = older.filter(([d]) => back(d) >= 7);
  const base = weekish.length ? weekish[weekish.length - 1] : older[0];
  if (seenTo && base[2] && seenTo === base[2]) return null; // the same measurement twice: nothing new
  const from = base[1];
  return { c: round(clamp((to - from) / Math.max(Math.abs(from), floor), -1, 1)), from, to, days: back(base[0]) };
}

/**
 * The best-seller rank's move, as the board's movement() (lower is better). points: [[day, rank]], 0 or null: checked and
 * not in the store's top 50. The older rank: the newest one 7+ days before the last, else the oldest when 2+ days before.
 * c: entered the top 50 +0.5 (+0.75 into the top 10), left it −0.5, else 1/10 per place, from −1 to +1; both outside: 0.
 */
export function rankTrend(points) {
  const p = (points || []).filter(([, v]) => v === null || num(v));
  if (p.length < 2) return null;
  const [lastDay, lastRank] = p[p.length - 1];
  const back = (d) => daysBetween(d, lastDay);
  const base = [...p].reverse().find(([d]) => back(d) >= 7) || (back(p[0][0]) >= 2 ? p[0] : null);
  if (!base) return null;
  const from = base[1] > 0 ? base[1] : null;
  const to = lastRank > 0 ? lastRank : null;
  let c = 0;
  if (from == null && to != null) c = to <= 10 ? 0.75 : 0.5;
  else if (from != null && to == null) c = -0.5;
  else if (from != null && to != null) c = round(clamp((from - to) / 10, -1, 1));
  return { c, from, to, days: back(base[0]) };
}

/** The rank history of a product: the store signals' own (bestseller.history, 15 days) and the daily rows, a day each. */
export function rankPoints(bsHistory, hist) {
  const by = new Map();
  for (const [d, v] of hist || []) if (v && v.b !== undefined) by.set(d, v.b > 0 ? v.b : null);
  for (const e of Array.isArray(bsHistory) ? bsHistory : []) if (Array.isArray(e) && /^\d{4}-\d{2}-\d{2}$/.test(e[0])) by.set(e[0], num(e[1]) && e[1] > 0 ? e[1] : null);
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * TikTok sales: lifetime counts, read on the day of each import (t), so one count per import. v: units sold a day
 * between the last two counts. c: that pace against its lifetime sales (5% of them in 30 days is 0, 50% is +1, 0.5% is
 * −1), with 3+ counts also whether it speeds up or slows down (half each). speeds: units a day between each two counts.
 */
export function soldTrend(points) {
  const obs = [];
  const seen = new Set();
  for (const [day, o, t] of points || []) {
    const d = t || day;
    if (!num(o) || seen.has(d)) continue;
    seen.add(d);
    obs.push([d, o]);
  }
  obs.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (obs.length < 2) return null;
  const speed = (a, b) => {
    const days = daysBetween(a[0], b[0]);
    return days >= 1 && b[1] >= a[1] ? (b[1] - a[1]) / days : null;
  };
  const n = obs.length;
  const v1 = speed(obs[n - 2], obs[n - 1]);
  if (v1 == null) return null;
  const last = obs[n - 1][1];
  const share = last > 0 ? (v1 * 30) / last : 0;
  let c = clamp(Math.log10(Math.max(share, 1e-6) / 0.05), -1, 1);
  const v0 = n >= 3 ? speed(obs[n - 3], obs[n - 2]) : null;
  if (v0 != null) c = (c + clamp((v1 - v0) / Math.max(v0, 1), -1, 1)) / 2;
  const speeds = [];
  for (let i = 1; i < n; i++) {
    const v = speed(obs[i - 1], obs[i]);
    if (v != null) speeds.push(Math.round(v));
  }
  return { c: round(c), v: Math.round(v1), speeds: speeds.slice(-SPARK_DAYS), share: round(share, 3) };
}

/** The price now against the oldest price in the last 14 days, in % (rounded), or null. */
export function priceChange(points) {
  const p = (points || []).filter(([, v]) => num(v) && v > 0);
  if (p.length < 2) return null;
  const [lastDay, to] = p[p.length - 1];
  const base = p.find(([d]) => daysBetween(d, lastDay) <= 14);
  if (!base || base[0] === lastDay) return null;
  return Math.round((to / base[1] - 1) * 100);
}

/** One value a day for the last SPARK_DAYS days up to `day` (null: no number that day). */
export function sparkOf(points, day, days = SPARK_DAYS) {
  const by = new Map((points || []).filter(([, v]) => num(v)).map(([d, v]) => [d, v]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(by.has(dayOf(Date.parse(day) - i * DAY)) ? by.get(dayOf(Date.parse(day) - i * DAY)) : null);
  while (out.length && out[0] == null) out.shift();
  return out;
}

// ---------------------------------------------------------------------------
// The same item in other stores: by its words, the supplier's photo, or a photo that looks the same
// ---------------------------------------------------------------------------

// Words that say nothing about what the product is: grammar (EN, NL, DE, FR, NO), sales words, sizes, colours.
const STOP = new Set(`a an the and or for with without of to in on at by from your you our my this that these those is are be it its as
  new sale hot best top premium original official genuine upgraded upgrade pro plus max ultra super deluxe luxury quality
  free shipping ship limited offer deal deals today only now buy get gift gifts edition version style design item product products
  set kit pack pcs pc piece pieces unit units size sizes color colors colour colours black white grey gray
  de het een en van voor met op der die das und mit für fur le la les et pour avec du des un une og med til av`.split(/\s+/).filter(Boolean));
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu;
const CJK_ANY = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

/** The words that say what a product is: lower case, no accents, no grammar, sales words, sizes or the store's own name. */
export function tokensOf(title, store = '') {
  let s = String(title || '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
  s = s.replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)/g, ' ');
  const out = new Set();
  for (const run of s.match(CJK) || []) for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  const own = ownName(store);
  let first = true;
  for (let w of s.replace(CJK_ANY, ' ').split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2 || /^\d/.test(w) || STOP.has(w)) continue;
    // The store's own name in front is its brand ("Glowify Sunset Lamp" on glowify.com); elsewhere it is the product
    // ("Bladeless Neck Fan" on fan.com).
    const brand = first && own.has(w);
    first = false;
    if (brand) continue;
    if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
    if (!STOP.has(w)) out.add(w);
  }
  return out;
}
/** A store's own name: its domain's first label, also without get / try / buy / shop / the / my in front. */
function ownName(store) {
  const label = String(store || '').toLowerCase().replace(/^tiktok:/, '').split('.')[0];
  return new Set([label, label.replace(/^(?:get|try|buy|shop|the|my)/, '')].filter((x) => x.length >= 3));
}

/**
 * The same (or a very similar) item by its words: 2+ words in common that are 60% of all their words, or 3+ that are
 * half of them, or 3+ that are 80% of the shorter title (a short title inside a long one).
 */
export function sameWords(a, b) {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  if (shared < 2) return false;
  const all = shared / (a.size + b.size - shared);
  if (all >= 0.6) return true;
  return shared >= 3 && (all >= 0.5 || shared / Math.min(a.size, b.size) >= 0.8);
}

/**
 * The supplier's own photo id in a photo's file name, or ''. Stores that import the same AliExpress or 1688 listing keep
 * its file names (S + 32 hex, H + 32 hex, O1CN01…, HTB1…), so the same id in two stores is the same item. Shopify's size
 * and copy suffixes are dropped.
 */
export function supplierImageId(url) {
  let f = '';
  try {
    f = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
  } catch (e) {
    return '';
  }
  for (let i = 0; i < 3; i++) {
    f = f.replace(/\.(jpe?g|png|webp|gif|avif|heic)$/i, '')
      .replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '')
      .replace(/_(\d+x\d*|x\d+|\d+x|small|medium|large|grande|compact|master|pico|icon|thumb)(@\dx)?$/i, '')
      .replace(/_q\d+$/i, '');
  }
  const m = /^([SH][0-9a-f]{32}[A-Za-z0-9]?)$/i.exec(f) || /^(O1CN01[0-9A-Za-z]{12,})/.exec(f) || /^((?:HTB1|UTB8)[0-9A-Za-z_]{16,})/.exec(f);
  return m ? m[1].toLowerCase() : '';
}

/**
 * dHash of a 9×8 grayscale picture (row by row): is each cell darker than the one to its right by more than `flat` grey
 * levels? 64 bits, 16 hex digits. Without that margin the white background of a supplier photo flips bits on every
 * re-encoding (measured in Chrome: the same photo as a 400 px PNG and a 100 px JPEG was 9 bits apart, with it 0; other
 * products stay 11+ apart).
 */
export const FLAT = 3;
export function dhash(gray, flat = FLAT) {
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (gray[y * 9 + x] + flat < gray[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
const BITS = Array.from({ length: 16 }, (_, i) => (i.toString(2).match(/1/g) || []).length);
/** How many of the 64 bits two fingerprints differ in. */
export function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < 16; i++) d += BITS[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}
/** A fingerprint that says something: not a flat picture (almost all bits the same). */
export const usableHash = (h) => /^[0-9a-f]{16}$/.test(h || '') && hamming(h, '0000000000000000') >= 6 && hamming(h, 'ffffffffffffffff') >= 6;

/**
 * Runs in the browser (Playwright's page.evaluate, the runner's Chrome decodes every photo format): photos as base64 →
 * their dHash. Self-contained on purpose. [{ k, b64 }] → [{ k, h }] (h '' when the photo could not be read).
 */
export async function hashInPage(list) {
  const out = [];
  for (const { k, b64 } of list) {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([bytes]));
      const c = new OffscreenCanvas(72, 64);
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, 72, 64);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bmp, 0, 0, 72, 64);
      const d = g.getImageData(0, 0, 72, 64).data;
      const gray = [];
      for (let cy = 0; cy < 8; cy++) {
        for (let cx = 0; cx < 9; cx++) {
          let s = 0;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const i = ((cy * 8 + y) * 72 + cx * 8 + x) * 4;
            s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          }
          gray.push(s / 64);
        }
      }
      let hex = ''; // as dhash() with its margin of 3 grey levels (FLAT): written out, this runs in the browser
      for (let y = 0; y < 8; y++) {
        let byte = 0;
        for (let x = 0; x < 8; x++) byte = (byte << 1) | (gray[y * 9 + x] + 3 < gray[y * 9 + x + 1] ? 1 : 0);
        hex += byte.toString(16).padStart(2, '0');
      }
      out.push({ k, h: hex });
    } catch (e) {
      out.push({ k, h: '' });
    }
  }
  return out;
}

const DF_MAX = 400; // a word in more titles than this finds no rivals on its own ("dog")
const SAME_HASH_MAX = 25; // a fingerprint shared by more photos than this is a placeholder, not a product
// A row of the fingerprint that many photos share (a white background: no edges) finds nobody on its own. Two photos at
// most SAME_PHOTO bits apart share at least two of the eight rows, so they still meet through a rarer one.
const BAND_MAX = 64;
const pop32 = (x) => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/**
 * Other stores selling the same item, for every item `want` picks. items: [{ key, store, title, img, first, live, hash }].
 * The same item: the same words (sameWords), the same supplier photo id, or a photo that looks the same (dHash, at most
 * SAME_PHOTO bits apart). Only live items in another store count. Returns Map key → { r, rn, rs, rt, how }: r other stores,
 * rn of them first seen in the last NEW_DAYS days, rs up to three names (the newest first), rt of them TikTok shops, how:
 * how many were found by words, supplier photo and look.
 */
export function rivalsOf(items, { now = Date.now(), want = (it) => it.tracked } = {}) {
  const toks = items.map((it) => tokensOf(it.title, it.store));
  const index = new Map();
  toks.forEach((ts, i) => { for (const t of ts) { if (!index.has(t)) index.set(t, []); index.get(t).push(i); } });
  const sids = items.map((it) => supplierImageId(it.img));
  const bySid = new Map();
  sids.forEach((sid, i) => { if (sid) { if (!bySid.has(sid)) bySid.set(sid, []); bySid.get(sid).push(i); } });
  // Fingerprints as two 32-bit numbers (fast to compare); only usable ones that are not a placeholder.
  const hashCount = new Map();
  items.forEach((it) => { if (usableHash(it.hash)) hashCount.set(it.hash, (hashCount.get(it.hash) || 0) + 1); });
  const fp = items.map((it) => (usableHash(it.hash) && hashCount.get(it.hash) <= SAME_HASH_MAX ? [parseInt(it.hash.slice(0, 8), 16) >>> 0, parseInt(it.hash.slice(8), 16) >>> 0] : null));
  const bandOf = (f, b) => b * 256 + ((b < 4 ? f[0] >>> (24 - 8 * b) : f[1] >>> (56 - 8 * b)) & 255);
  const bands = new Map();
  fp.forEach((f, i) => {
    if (!f) return;
    for (let b = 0; b < 8; b++) {
      const k = bandOf(f, b);
      if (!bands.has(k)) bands.set(k, []);
      bands.get(k).push(i);
    }
  });
  const newSince = dayOf(now - NEW_DAYS * DAY);
  const out = new Map();
  items.forEach((it, i) => {
    if (!want(it)) return;
    const found = new Map(); // item index → how
    const counts = new Map();
    for (const t of toks[i]) {
      const list = index.get(t);
      if (list.length > DF_MAX) continue;
      for (const j of list) if (j !== i) counts.set(j, (counts.get(j) || 0) + 1);
    }
    for (const [j, n] of counts) if (n >= 2 && sameWords(toks[i], toks[j])) found.set(j, 'words');
    if (sids[i]) for (const j of bySid.get(sids[i])) if (j !== i && !found.has(j)) found.set(j, 'supplier');
    const f = fp[i];
    if (f) {
      const seen = new Set();
      for (let b = 0; b < 8; b++) {
        const list = bands.get(bandOf(f, b));
        if (list.length > BAND_MAX) continue;
        for (const j of list) {
          if (j === i || seen.has(j) || found.has(j)) continue;
          seen.add(j);
          const g = fp[j];
          if (pop32((f[0] ^ g[0]) >>> 0) + pop32((f[1] ^ g[1]) >>> 0) <= SAME_PHOTO) found.set(j, 'look');
        }
      }
    }
    const stores = new Map(); // store → earliest first-seen day ('' unknown)
    const how = { words: 0, supplier: 0, look: 0 };
    for (const [j, h] of found) {
      const o = items[j];
      if (!o.live || !o.store || o.store === it.store) continue;
      const first = dayOf(o.first);
      if (!stores.has(o.store)) how[h]++;
      const had = stores.get(o.store);
      if (had === undefined || (first && (!had || first < had))) stores.set(o.store, first);
    }
    // The newest rivals first (a day unknown: last), then by name.
    const names = [...stores.entries()].sort((a, b) => (!a[1] - !b[1]) || (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0) || (a[0] < b[0] ? -1 : 1));
    out.set(it.key, {
      r: stores.size,
      rn: names.filter(([, f]) => f && f >= newSince).length,
      rs: names.slice(0, 3).map(([s]) => (s.startsWith('tiktok:') ? 'TikTok ' + s.slice(7) : s)),
      rt: names.filter(([s]) => s.startsWith('tiktok:')).length,
      how,
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Google Trends through SerpApi (shortlisted products only)
// ---------------------------------------------------------------------------

/** The search words for a product: the first three words that say what it is (no sales words, sizes or brackets). */
export function trendsQuery(title, store = '') {
  const words = String(title || '').replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)/g, ' ').split(/[^\p{L}\p{N}'’-]+/u)
    .map((w) => w.replace(/^[-'’]+|[-'’]+$/g, ''))
    .filter((w) => w.length >= 2 && !/^\d/.test(w) && !STOP.has(w.toLowerCase()));
  if (words.length > 1 && ownName(store).has(words[0].toLowerCase())) words.shift(); // the store's brand in front
  return words.slice(0, 3).join(' ').toLowerCase().slice(0, 60);
}

/** SerpApi's address for one product (12 months of weekly interest). */
export function trendsUrl(q, geo, key) {
  const p = new URLSearchParams({ engine: 'google_trends', q, data_type: 'TIMESERIES', date: 'today 12-m', api_key: key });
  if (/^[A-Z]{2}$/.test(geo || '')) p.set('geo', geo);
  return 'https://serpapi.com/search.json?' + p;
}

/**
 * SerpApi's Google Trends answer → { ch, yoy, pk, now, s } or null. ch: the last 4 full weeks against the 4 before, in %;
 * yoy: against the first 4 weeks of the year shown; pk: the month of the peak (1–12); now: the last 4 weeks as % of the
 * peak; s: the last 13 weeks for a sparkline.
 */
export function trendsOf(j) {
  const tl = j && j.interest_over_time && Array.isArray(j.interest_over_time.timeline_data) ? j.interest_over_time.timeline_data : null;
  if (!tl) return null;
  const pts = tl.filter((x) => x && !x.partial_data).map((x) => {
    const v = x.values && x.values[0];
    return { t: Number(x.timestamp) * 1000, v: Number(v && (v.extracted_value ?? v.value)) };
  }).filter((x) => Number.isFinite(x.v) && Number.isFinite(x.t));
  if (pts.length < 8) return null;
  const avg = (xs) => xs.reduce((a, x) => a + x.v, 0) / xs.length;
  const last = avg(pts.slice(-4));
  const prev = avg(pts.slice(-8, -4));
  const peak = pts.reduce((a, x) => (x.v > a.v ? x : a), pts[0]);
  const first = pts.length >= 40 ? avg(pts.slice(0, 4)) : null;
  return {
    ch: prev > 0 ? Math.round((last / prev - 1) * 100) : last > 0 ? 100 : 0,
    yoy: first ? Math.round((last / first - 1) * 100) : null,
    pk: peak.v > 0 ? new Date(peak.t).getUTCMonth() + 1 : null,
    now: peak.v > 0 ? Math.round((last / peak.v) * 100) : null,
    s: pts.slice(-13).map((x) => x.v),
  };
}

// ---------------------------------------------------------------------------
// The summary the board reads
// ---------------------------------------------------------------------------

/**
 * One product's summary. hist: its daily rows [[day, numbers]] up to today (today's included). extra: { day (today),
 * bsHistory (the store signals' rank history), rivals ({ r, rn, rs, rt }), trends ({ q, geo, at, ch, … }) }. The score
 * parts go in c (each −1 … +1, worker/src/momentum.mjs weighs them), the sparkline's metric in sm and its days in s.
 */
export function summaryOf(item, hist, { day, bsHistory = null, rivals = null, trends = null } = {}) {
  const series = (f) => hist.map(([d, v]) => [d, v ? v[f] : undefined, v ? v.w || v.t : undefined]);
  const today = (hist.length && hist[hist.length - 1][0] === day ? hist[hist.length - 1][1] : item.today) || {};
  const c = {};
  const mo = { h: hist.length || 1, f: hist.length ? hist[0][0] : day };
  if (item.src === 'tiktok') {
    const sold = soldTrend(series('o'));
    if (sold) {
      c.sold = sold.c;
      mo.v = sold.v;
      if (sold.speeds.length >= 2) mo.s = sold.speeds;
    }
    const cr = trend(dedupeBy(series('c')), 3);
    if (cr) c.creators = cr.c;
    mo.sm = 'sold';
  } else {
    const eu = item.src === 'eu';
    const ads = trend(series('a'), 3);
    if (ads) c.ads = ads.c;
    const shop = trend(series('s'), 10);
    if (shop) c.shop = shop.c;
    if (eu) {
      const reach = trend(series('e'), 500);
      if (reach) c.reach = reach.c;
    } else {
      const mk = trend(series('m'), 2);
      if (mk) c.markets = mk.c;
      if (num(today.a) && today.a > 0 && num(today.n)) c.fresh = round(clamp((2 * today.n) / today.a, 0, 1));
    }
    const rp = rankPoints(bsHistory, hist);
    const rank = rankTrend(rp);
    if (rank) c.rank = rank.c;
    const ranked = rp.filter(([d, v]) => v != null && daysBetween(d, day) < SPARK_DAYS).length;
    if (eu && ranked >= 2) {
      mo.sm = 'rank';
      mo.s = sparkOf(rp.map(([d, v]) => [d, v == null ? 51 : v]), day);
      if (rank) mo.d = [rank.from || 0, rank.to || 0, rank.days];
    } else {
      mo.sm = 'ads';
      const s = sparkOf(series('a'), day);
      if (s.filter((v) => v != null).length >= 2) mo.s = s;
      if (ads) mo.d = [ads.from, ads.to, ads.days];
    }
    if (today.x === 0) mo.stop = 1;
    // The EU board's numbers only change when the EU hunt runs (by hand): the day they were last measured, when none of
    // its days brought new ones, so the board can say why there is no trend.
    const measured = new Set(hist.map(([, v]) => v && v.w).filter(Boolean));
    if (eu && hist.length >= 2 && measured.size === 1) mo.same = [...measured][0];
    if (num(item.sv)) mo.sv = item.sv;
    if (num(item.sl) && item.sl > 0) mo.sl = item.sl;
  }
  if (rivals) {
    Object.assign(mo, { r: rivals.r });
    if (rivals.rn) mo.rn = rivals.rn;
    if (rivals.rs && rivals.rs.length) mo.rs = rivals.rs;
    if (rivals.rt) mo.rt = rivals.rt;
    const rr = trend(series('r'), 1);
    if (rr && rr.to > rr.from) mo.rr = [rr.from, rr.to, rr.days];
  }
  const pc = priceChange(series('p'));
  if (pc != null && pc !== 0) mo.pc = pc;
  if (trends && trends.q && num(trends.ch)) {
    c.trends = round(clamp(trends.ch / 50, -1, 1));
    mo.g = clean({ q: trends.q, geo: trends.geo || undefined, ch: trends.ch, yoy: trends.yoy ?? undefined, pk: trends.pk ?? undefined, now: trends.now ?? undefined, s: trends.s, at: trends.at });
  } else if (trends && trends.q && trends.none) {
    mo.g = clean({ q: trends.q, geo: trends.geo || undefined, none: 1, at: trends.at }); // too few searches to measure: no score part
  }
  mo.c = c;
  return mo;
}
/** TikTok's numbers repeat every day until the next import: one point per import day (t). */
const dedupeBy = (points) => {
  const seen = new Set();
  return points.filter(([d, v, t]) => {
    if (!num(v)) return false;
    const k = t || d;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** A map as plain objects of at most about maxBytes of JSON each (always at least one, maybe empty). */
export function splitMap(map, maxBytes = 400000) {
  const out = [];
  let cur = {};
  let size = 0;
  for (const [k, val] of map) {
    const n = JSON.stringify(k).length + JSON.stringify(val).length + 2;
    if (size && size + n > maxBytes) {
      out.push(cur);
      cur = {};
      size = 0;
    }
    cur[k] = val;
    size += n;
  }
  if (size || !out.length) out.push(cur);
  return out;
}

/**
 * A map of summaries as rows for table momentum: [{ key: prefix:NN, body: '{"v":…,"p":{…}}' }], each at most about
 * maxBytes. The board reads every row of a prefix at once (worker/src/momentum.mjs readMomentum).
 */
export const partsOf = (prefix, map, { maxBytes = 400000, v = '' } = {}) =>
  splitMap(map, maxBytes).map((p, i) => ({ key: `${prefix}:${String(i).padStart(2, '0')}`, body: JSON.stringify({ v, p }) }));
