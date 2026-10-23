/*
 * The hard requirements of a winner (no points): an ad passes all four or it is out.
 *   1. Shopify store (verified)   2. advertiser has 75+ active ads   3. ad live 7 to 42 days   4. 500+ EU reach per day
 * Everything else (ads for the same product, store size, reach, countries) is information only.
 */

export const DAY = 864e5;

// The rules (also in the board's SQL, worker/src/app.mjs, and lib/d1.mjs).
export const MIN_ACTIVE_ADS = 75;
export const MIN_AGE_DAYS = 7;
export const MAX_AGE_DAYS = 42;
export const MIN_REACH_PER_DAY = 500;

export const DEFAULTS = {
  ageMin: MIN_AGE_DAYS, // the Ad Library search only asks for ads in this age window
  ageMax: MAX_AGE_DAYS,
  minAds: MIN_ACTIVE_ADS,
  minReachPerDay: MIN_REACH_PER_DAY,
};

// Catalog ads carry template fields like {{product.name}} instead of real text.
export const noTemplate = (t) => String(t || '').replace(/\{\{[^{}]*\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim();

export const FB_HOST = /(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch|messenger\.com|m\.me|instagram\.com|whatsapp\.com|wa\.me|threads\.net)$/;
export const NON_STORE = /(^|\.)(google\.[a-z.]+|youtube\.com|youtu\.be|apple\.com|amazon\.[a-z.]+|amzn\.(to|eu)|a\.co|ebay\.[a-z.]+|etsy\.com|walmart\.com|temu\.com|shein\.com|aliexpress\.[a-z.]+|alibaba\.com|tiktok\.com|linkedin\.com|twitter\.com|x\.com|pinterest\.[a-z.]+|reddit\.com|spotify\.com|bol\.com|zalando\.[a-z.]+|target\.com|bestbuy\.com|wish\.com|wayfair\.com|ikea\.com|booking\.com|airbnb\.[a-z.]+|microsoft\.com)$/;
export const SHOPIFY_HDR = /^(powered-by:\s*shopify|x-shopid:|x-shopify-stage:|x-sorting-hat-shopid:|x-shardid:)/im;

export function hostOf(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    return x.hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch (e) {
    return null;
  }
}

export const hostKey = (h) => h.replace(/^www\d?\./, '');

function unwrap(u) {
  try {
    const x = new URL(u);
    if (FB_HOST.test(x.hostname) && x.pathname === '/l.php' && x.searchParams.get('u')) return x.searchParams.get('u');
  } catch (e) {
    // not a URL
  }
  return u;
}

/** Where the ad sends people: { host, key, url } or null. Cached on the ad. */
export function landing(ad) {
  if (ad.lh !== undefined) return ad.lh;
  let res = null;
  for (const raw of ad.links || []) {
    if (/\{\{|%7B%7B/.test(raw) && !/^https?:\/\/[^/{}%]+\//i.test(raw)) continue;
    const u = unwrap(raw);
    const host = hostOf(u);
    if (!host || FB_HOST.test(host)) continue;
    res = { host, key: hostKey(host), url: u };
    break;
  }
  if (!res && ad.cap) {
    const c = String(ad.cap).trim().toLowerCase();
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(c) && !FB_HOST.test(c)) res = { host: c, key: hostKey(c), url: 'https://' + c + '/' };
  }
  ad.lh = res;
  return res;
}

/** The product (or collection) an ad links to: { kind, handle, key, url } or null. */
export function productOf(ad) {
  const lh = landing(ad);
  if (!lh) return null;
  let path;
  try {
    path = decodeURIComponent(new URL(lh.url).pathname).toLowerCase();
  } catch (e) {
    return null;
  }
  let m = /\/products\/([^/?#]+)/.exec(path);
  if (m) {
    const handle = m[1].replace(/\.(js|json)$/, '');
    return { kind: 'product', handle, key: lh.key + '/products/' + handle, url: 'https://' + lh.host + '/products/' + handle };
  }
  m = /\/collections\/([^/?#]+)/.exec(path);
  if (m) return { kind: 'collection', handle: m[1], key: lh.key + '/collections/' + m[1], url: 'https://' + lh.host + '/collections/' + m[1] };
  return null;
}

export const fmtInt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
export const fmtCompact = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : fmtInt(n));
export const fmtDay = (sec) => (sec ? new Date(sec * 1000).toISOString().slice(0, 10) : '');
const SYMBOL = { EUR: '€', USD: '$', GBP: '£', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', CHF: 'CHF ', SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', PLN: 'zł ', CZK: 'Kč ', JPY: '¥' };
export const money = (v, cur) => (v == null ? '–' : (SYMBOL[cur] || (cur ? cur + ' ' : '')) + Number(v).toFixed(2).replace(/\.00$/, ''));
export const adUrl = (id) => `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}`;

export function adAgeDays(ad, now) {
  if (!ad.start) return null;
  const endMs = !ad.active && ad.end ? ad.end * 1000 : now || Date.now();
  return Math.max(0, Math.floor((endMs - ad.start * 1000) / DAY));
}

const SALE_RE = /(\d{2}\s?%|sale\b|\bsold out|korting|uitverkoop|soldes|rebajas|saldi|sconto|rabatt|réduction|descuento|clearance|black friday|cyber monday|warehouse|anniversary|jubileum|free shipping|gratis verzending|livraison gratuite|envío gratis|kostenloser versand|limited stock|only today|vandaag)/i;

export const RULES = {
  shopify: 'Shopify store',
  ads: 'Advertiser active ads',
  age: 'Ad age',
  reach: 'EU reach per day',
};

/**
 * Checks one ad against the four rules. Every input except `ad` may be missing:
 *   shop    – Shopify check for the landing domain: { shopify, meta:{products,currency…} } | 'pending' | null
 *   cnt     – advertiser active-ad count: { count } | 'pending' | null (count unavailable)
 *   reach   – { eu } | { err } | null
 *   product – Shopify product: { price, compareAt, currency, title } | null
 *   dupes   – how many ads use the same product/creative (≥ 1, information only)
 * verdict: 'winner' (passes all), 'skip' (fails one), 'pending' (Shopify or the active-ad count still unknown).
 * items: one per rule, { key, label, state: 'ok' | 'bad' | 'pending', text }. score: 100 for a winner, else 0
 * (the database column; never shown).
 */
export function scoreAd(ad, inp, S, now) {
  S = Object.assign({}, DEFAULTS, S || {});
  inp = inp || {};
  const items = [];
  const put = (key, state, text) => items.push({ key, label: RULES[key], state, text });
  let skip = null;
  const fail = (key, text) => {
    put(key, 'bad', text);
    skip = skip || text;
  };

  // 1. Shopify store
  const lh = landing(ad);
  const shop = inp.shop;
  if (!lh) fail('shopify', 'No shop website in this ad');
  else if (NON_STORE.test(lh.key)) fail('shopify', `${lh.key} is a marketplace or big brand`);
  else if (shop === 'pending' || shop === undefined) put('shopify', 'pending', `Checking ${lh.key}…`);
  else if (shop && shop.shopify) put('shopify', 'ok', shop.meta && shop.meta.myshopify ? shop.meta.myshopify : `${shop.host || lh.key} runs on Shopify`);
  else fail('shopify', shop && shop.error ? `${lh.key} did not answer (${shop.error})` : `${lh.key} is not a Shopify store`);

  // 2. Advertiser active ads
  const cnt = inp.cnt;
  if (cnt === 'pending' || cnt === undefined || !cnt || !(cnt.count > 0)) put('ads', 'pending', 'Counting their active ads…');
  else if (cnt.count >= S.minAds) put('ads', 'ok', `${fmtInt(cnt.count)} active ads`);
  else fail('ads', `Only ${fmtInt(cnt.count)} active ads (needs ${S.minAds}+)`);

  // 3. Ad age
  const days = adAgeDays(ad, now);
  const d = (n) => `${n} day${n === 1 ? '' : 's'}`;
  if (days == null) fail('age', 'Start date unknown');
  else if (days < S.ageMin) fail('age', `Live ${d(days)} (needs ${S.ageMin}+)`);
  else if (days > S.ageMax) fail('age', `Live ${d(days)} (max 6 weeks)`);
  else put('age', 'ok', `Live ${d(days)}`);

  // 4. EU reach per day of ad life
  const r = inp.reach;
  const rt = r && typeof r.eu === 'number' ? r.eu : null;
  const rpd = rt == null ? null : reachPerDay(rt, days);
  if (rt == null) fail('reach', r && r.err ? `Reach unavailable (${r.err})` : 'Reach unavailable');
  else if (rpd >= S.minReachPerDay) put('reach', 'ok', `${fmtCompact(Math.floor(rpd))} EU reach a day`);
  else fail('reach', `${fmtCompact(Math.floor(rpd))} EU reach a day (needs ${S.minReachPerDay}+)`);

  // Information only
  const dupes = Math.max(1, inp.dupes || 1, ad.coll || 1);
  const p = inp.product && inp.product !== 'pending' && !inp.product.err ? inp.product : null;
  const off = p && p.compareAt > p.price ? Math.round((1 - p.price / p.compareAt) * 100) : 0;
  const saleCopy = SALE_RE.test(ad.title + ' ' + ad.body + ' ' + ad.cta);

  const pending = items.some((i) => i.state === 'pending');
  const verdict = skip ? 'skip' : pending ? 'pending' : 'winner';
  return { score: verdict === 'winner' ? 100 : 0, verdict, skip, items, days, dupes, reachTotal: rt, reachPerDay: rpd, discount: off || null, saleCopy };
}

/** EU reach per day of ad life (a day-old ad counts as one day). */
export const reachPerDay = (reach, age) => (reach ? reach / Math.max(age || 0, 1) : 0);

/** A stored record passes the rules (run.mjs saves only these; the board shows only these). */
export const passesRules = (r) => r.verdict === 'winner' && (r.active_ads ?? 0) >= MIN_ACTIVE_ADS && r.ad_age_days != null && r.ad_age_days >= MIN_AGE_DAYS
  && r.ad_age_days <= MAX_AGE_DAYS && reachPerDay(r.reach_eu, r.ad_age_days) >= MIN_REACH_PER_DAY;
