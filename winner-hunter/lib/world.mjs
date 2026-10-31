/*
 * Outside the EU, without reach. Meta's Ad Library API only returns shop ads that ran in the EU or UK (tested
 * 2026-10-28), but the public Ad Library website lists a country's ads for any country, with the ad's start date, its
 * copies, where it links and the page's likes. No login. This file holds the pure parts: reading that page, what is on
 * the board, and adding ads up to products. lib/adlibrary.mjs opens the pages, world.mjs runs the night.
 */
import { landing, productOf, NON_STORE, hostKey, hostOf, noTemplate, SHOPIFY_HDR } from './score.mjs';
import { sized } from './storephoto.mjs';

const DAY = 864e5;

// The markets to hunt (Connor, 2026-10-31): first Switzerland, Norway, Australia, New Zealand, Dubai, US, Canada, then the
// ones that passed the low-hassle screen (research/2026-10-31-easy-markets). Meta's Ad Library has no city filter, so
// Dubai means the whole UAE. The board has the same list (worker/src/app.mjs WORLD_MARKETS).
export const MARKETS = ['CH', 'NO', 'AU', 'NZ', 'AE', 'US', 'CA', 'SG', 'JE', 'HK', 'MO', 'JP', 'KR', 'MY', 'TW', 'IL', 'LI'];
export const LANGS = { CH: ['de', 'fr'], NO: ['no'], AU: ['en'], NZ: ['en'], AE: ['en'], US: ['en'], CA: ['en'], SG: ['en'], JE: ['en'], HK: ['en', 'zh'], MO: ['zh'], JP: ['ja'], KR: ['ko'], MY: ['en'], TW: ['zh'], IL: ['en'], LI: ['de'] };
export const MIN_DAYS = 7; // a younger ad proves nothing yet (the same lower limit as the EU board)
export const KEEP_DAYS = 10; // an ad counts as running for this long after it was last seen (the keywords take 2-3 nights)

/** keywords-world.txt: 'en: dog harness | de: hundegeschirr | fr: harnais chien | no: hundesele | …' → [{ en, de, fr, no, … }]. */
export function parseWorldKeywords(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const row = {};
    for (const part of line.split('|')) {
      const m = /^\s*([a-z]{2})\s*:\s*(.+?)\s*$/.exec(part);
      if (m) row[m[1]] = m[2];
    }
    if (row.en) out.push(row);
  }
  return out;
}

/** The searches for one keyword line: [{ cc, q }], every market in its own languages (English where a word is missing). */
export function searchesOf(row, markets = MARKETS) {
  const out = [];
  for (const cc of markets) {
    const words = new Set((LANGS[cc] || ['en']).map((l) => row[l] || row.en));
    for (const q of words) out.push({ cc, q });
  }
  return out;
}

export const libraryUrl = ({ cc, q, pageId }) => {
  const p = new URLSearchParams({ active_status: 'active', ad_type: 'all', country: cc, media_type: 'all' });
  if (pageId) {
    p.set('search_type', 'page');
    p.set('view_all_page_id', pageId);
  } else {
    p.set('q', q);
    p.set('search_type', 'keyword_unordered');
  }
  return `https://www.facebook.com/ads/library/?${p}`;
};

/**
 * The JSON blocks of an Ad Library page → { ads: raw ads, count }. count is null when the page holds no search result
 * at all (a block or a page that did not load, not "nothing found"). Meta shows 50001 for "more than 50,000".
 */
export function readLibrary(blocks) {
  const ads = new Map();
  let count = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    if (o.ad_archive_id && o.snapshot) {
      ads.set(String(o.ad_archive_id), o);
      return;
    }
    if (o.search_results_connection && typeof o.search_results_connection.count === 'number') count = o.search_results_connection.count;
    for (const k of Object.keys(o)) walk(o[k]);
  };
  for (const b of blocks || []) {
    try {
      walk(typeof b === 'string' ? JSON.parse(b) : b);
    } catch (e) {
      // not JSON
    }
  }
  return { ads: [...ads.values()], count };
}

const cut = (t, n) => Array.from(String(t ?? '')).slice(0, n).join('');
const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? cut(u, 1000) : '');

/** One raw ad → the row for world_ads, or null when it no longer runs. */
export function toRow(raw, cc, keyword) {
  if (raw.is_active === false || raw.end_date_active === false) return null;
  const s = raw.snapshot || {};
  const card = (Array.isArray(s.cards) && s.cards[0]) || {};
  const img = (Array.isArray(s.images) && s.images[0]) || {};
  const vid = (Array.isArray(s.videos) && s.videos[0]) || {};
  const link = String(s.link_url || card.link_url || '');
  const caption = String(s.caption || card.caption || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  const lh = landing({ links: link ? [link] : [], cap: caption });
  const store = lh && !NON_STORE.test(lh.key) ? lh.key : '';
  const prod = lh ? productOf({ lh }) : null;
  return {
    ad_id: String(raw.ad_archive_id),
    cc,
    page_id: String(raw.page_id || s.page_id || ''),
    page_name: cut(s.page_name || raw.page_name || '', 200),
    likes: Number.isFinite(Number(s.page_like_count)) && s.page_like_count != null ? Number(s.page_like_count) : null,
    collation_id: String(raw.collation_id || raw.ad_archive_id),
    copies: Math.max(1, Number(raw.collation_count) || 1),
    start_at: Number(raw.start_date) || null,
    link: cut(lh ? lh.url : link, 1000),
    caption: cut(caption, 200),
    title: cut(noTemplate(s.title || card.title || ''), 200),
    image_url: https(img.resized_image_url || img.original_image_url || card.resized_image_url || card.original_image_url || vid.video_preview_image_url || card.video_preview_image_url || ''),
    keyword: cut(keyword || '', 100),
    store,
    product_key: store && prod && prod.kind === 'product' ? prod.key : '',
  };
}

// ---------------------------------------------------------------------------
// What is on the board (CLAUDE.md, board exclusions)
// ---------------------------------------------------------------------------
const words = (s) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${s})(?![\\p{L}\\p{N}])`, 'iu');
// Pet food is on the board (Connor, 2026-10-31: all of the categories he had left open stay on). Without this, the food words would take it off.
const PET_FOOD = words('(?:dog|cat|pet|puppy|kitten)[\\s-]+(?:food|treats?)(?![\\s-]+(?:bowl|mat|dispenser|container|storage))|hundefutter|katzenfutter|hundemat|kattemat|croquettes?');
// Words that only mean something you take or eat: they count anywhere, also in a product's description.
const OUT_ANYWHERE = [
  ['supplement', words('dietary supplements?|food supplements?|nahrungserg[äa]nzung\\w*|kosttilskudd|kosttillskott|compl[eé]ment alimentaire|gummies|protein powder|greens powder|creatine|kreatin|shilajit|ashwagandha')],
];
// These also appear on ordinary goods ("cuts food in seconds", "magnesium alloy", "vitamin C serum"): name and type only.
const OUT_IN_NAME = [
  ['supplement', words('supplements?|suppl[eé]ments?|vitamins?|vitamines?|kapseln|g[ée]lules|collag[eè]ne?|kollagen|probiotics?|probiotique|whey|magnesium|omega[\\s-]?3')],
  ['food or drink', words('food|foods|lebensmittel|nourriture|snacks?|drink mix|beverages?|energy drink|tea blend|herbal tea|matcha|protein bar|superfood')],
  ['gymwear', words('gymwear|gym wear|gym[\\s-]+(?:shorts|shirts?|leggings?|tank|tops?|stringer)|workout[\\s-]+(?:shorts|shirts?|leggings?|tops?)|activewear|sportswear|sportbekleidung|fitnessbekleidung|treningsklær')],
];
// Not products at all, though stores list them as products.
const NOT_A_PRODUCT = words('shipping protection|order protection|shipping (?:&|and) order protection|package protection|shipping insurance|gift ?cards?|geschenk(?:gutschein|karte)\\w*|carte cadeau|gavekort|upsell');
const NOT_EATEN = words('food (?:processor|container|storage|warmer|chopper|scale|grade|bowl|mat|dehydrator|dispenser)|face|serum|cream|creme|crème|lotion|shampoo|mask|masque|maske|alloy|machine|maschine');

/**
 * { out: '' | why it is off the board }. head: the product's name, type and tags.
 * body: its description. Words miss some: Reject handles those.
 */
export function classify(head, body = '') {
  const name = String(head || '');
  const all = `${name}\n${body || ''}`;
  if (NOT_A_PRODUCT.test(name)) return { out: 'not a product' };
  if (PET_FOOD.test(name)) return { out: '' };
  for (const [why, re] of OUT_ANYWHERE) if (re.test(all)) return { out: why };
  if (!NOT_EATEN.test(name)) for (const [why, re] of OUT_IN_NAME) if (re.test(name)) return { out: why };
  return { out: '' };
}

// ---------------------------------------------------------------------------
// Stores and products (Shopify's open endpoints, no Meta requests)
// ---------------------------------------------------------------------------
// Shopify answers 429 across its stores once one address asks too much (seen 2026-10-31: 286 of 292 stores in a row). A 429
// is not "no such product": everybody waits, then asks again.
let coolUntil = 0;
export const COOL_MS = 45000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const resetCooling = () => { coolUntil = 0; };

async function getText(doFetch, url, { timeout = 15000, tries = 3, coolMs = COOL_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (Date.now() < coolUntil) await wait(coolUntil - Date.now());
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await doFetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { Accept: 'application/json' } });
      if (res.status === 429 && attempt + 1 < tries) {
        coolUntil = Math.max(coolUntil, Date.now() + coolMs * (attempt + 1));
        continue;
      }
      const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
      return { status: res.status, text: await res.text(), headers, url: res.url || url };
    } catch (e) {
      return { status: 0, text: '', headers: '', url, error: e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(t);
    }
  }
}

/** Is the store on Shopify? { shopify, host, currency, products, myshopify }. shopify null: it did not answer. */
export async function checkStore(store, doFetch = globalThis.fetch, opts = {}) {
  let answered = false;
  for (const host of [store, 'www.' + store]) {
    const r = await getText(doFetch, `https://${host}/meta.json`, opts);
    if (r.status === 429) return { shopify: null, host: store, currency: '', products: null, myshopify: '' }; // still limited: asked again next run
    if (r.status) answered = true;
    let j = null;
    try {
      j = JSON.parse(r.text);
    } catch (e) {
      // not JSON
    }
    const shop = j && /\.myshopify\.com$/i.test(j.myshopify_domain || '');
    if (shop || SHOPIFY_HDR.test(r.headers)) {
      return { shopify: 1, host: hostKey(hostOf(r.url) || host), currency: (shop && j.currency) || '', products: shop && typeof j.published_products_count === 'number' ? j.published_products_count : null,
        myshopify: shop ? j.myshopify_domain : '' };
    }
  }
  return { shopify: answered ? 0 : null, host: store, currency: '', products: null, myshopify: '' };
}

const price = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) === 0 ? null : Number(v));
const strip = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 1500);

/** A product from its store: /products/handle.json. Prices there are in the store's own currency. null when it has none. */
export async function fetchProduct(key, { host, currency = '' }, doFetch = globalThis.fetch, opts = {}) {
  const handle = key.split('/products/')[1];
  if (!handle) return null;
  const r = await getText(doFetch, `https://${host}/products/${encodeURIComponent(handle)}.json`, opts);
  let p = null;
  try {
    p = JSON.parse(r.text).product;
  } catch (e) {
    return null;
  }
  if (!p || !p.title) return null;
  const v = (Array.isArray(p.variants) && p.variants[0]) || {};
  const tags = Array.isArray(p.tags) ? p.tags.join(' ') : p.tags;
  const c = classify([p.title, p.product_type, tags].filter(Boolean).join(' \n '), strip(p.body_html));
  const src = (p.image && p.image.src) || (Array.isArray(p.images) && p.images[0] && p.images[0].src) || '';
  return { title: cut(p.title, 200), price: price(v.price), compare_at_price: price(v.compare_at_price), currency: cut(v.price_currency || currency, 8), image_url: src ? sized(src) : '',
    product_type: cut(p.product_type, 100), out: c.out ? 1 : 0 };
}

const wordsOf = (t) => new Set(String(t || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));

/**
 * The product an ad without a product link is about: the store's own search with the ad's title. Its key, or ''. A search
 * always answers something, so the product must share a word with the ad's title ("Free shipping today" finds nothing).
 * store: the name the store is known by here, so the key matches links from ads (a store's host can be another domain).
 */
export async function suggestProduct(title, host, doFetch = globalThis.fetch, store = host) {
  const q = cut(noTemplate(title), 60);
  if (!q) return '';
  const r = await getText(doFetch, `https://${host}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=1`);
  try {
    const p = JSON.parse(r.text).resources.results.products[0];
    const m = /\/products\/([^/?#]+)/.exec(String((p && p.url) || ''));
    if (!m) return '';
    const handle = decodeURIComponent(m[1]).toLowerCase();
    const named = wordsOf(`${p.title || ''} ${handle}`);
    if (![...wordsOf(q)].some((w) => named.has(w))) return '';
    return `${hostKey(store)}/products/${handle}`;
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Ads → products
// ---------------------------------------------------------------------------
/** What Meta's API says about a shop's active EU ads → { in_eu, eu_rpd, eu_ads }: only reach it publishes, per day of ad life. */
export function euFacts(ads, seen, now = Date.now()) {
  const list = Array.isArray(ads) ? ads : [];
  let best = null;
  const out = {};
  for (const a of list) {
    const reach = Number(a.eu_total_reach);
    const start = Date.parse(a.ad_delivery_start_time || '');
    if (!Number.isFinite(reach) || reach <= 0 || !Number.isFinite(start)) continue;
    const rpd = reach / Math.max(Math.floor((now - start) / DAY), 1);
    if (best == null || rpd > best) best = rpd;
    if (seen.has(String(a.id))) out[String(a.id)] = Math.round(rpd);
  }
  return { in_eu: list.length ? 1 : 0, eu_rpd: best == null ? null : Math.round(best), eu_ads: JSON.stringify(out) };
}

/**
 * The ads still running, added up per product. Only products on a Shopify store, not off the board, with an ad at
 * least MIN_DAYS old. ads: world_ads rows. items: Map product_key → world_items row. stores: Map store → world_stores
 * row. pages: Map page_id → { counts: {cc: n}, in_eu, eu_rpd, eu_ads: {ad id: reach a day} }. known: Map product_key → { ad_id, first_seen } (ad_id never changes).
 */
export function addUp(ads, { items, stores, pages, known = new Map(), now = Date.now() }) {
  const groups = new Map();
  for (const a of ads) {
    if (!a.product_key) continue;
    if (!groups.has(a.product_key)) groups.set(a.product_key, []);
    groups.get(a.product_key).push(a);
  }
  const out = [];
  const iso = new Date(now).toISOString();
  for (const [key, rows] of groups) {
    const item = items.get(key);
    if (!item || item.out) continue;
    const store = key.split('/')[0];
    const shop = stores.get(store);
    if (!shop || !shop.shopify) continue;
    const daysOf = (a) => (a.start_at ? Math.max(0, Math.floor((now - a.start_at * 1000) / DAY)) : 0);
    const oldest = rows.reduce((x, y) => (daysOf(y) > daysOf(x) || (daysOf(y) === daysOf(x) && y.ad_id < x.ad_id) ? y : x));
    const days = daysOf(oldest);
    if (days < MIN_DAYS) continue;
    const byCc = new Map();
    const creatives = new Map();
    const fresh = new Set();
    for (const a of rows) {
      const d = daysOf(a);
      if (!byCc.has(a.cc)) byCc.set(a.cc, { creatives: new Map(), ids: new Set(), days: 0, new14: new Set() });
      const m = byCc.get(a.cc);
      m.creatives.set(a.collation_id, Math.max(m.creatives.get(a.collation_id) || 0, a.copies || 1));
      m.days = Math.max(m.days, d);
      if (d <= 14) {
        m.new14.add(a.ad_id);
        fresh.add(a.ad_id);
      }
      creatives.set(a.collation_id, Math.max(creatives.get(a.collation_id) || 0, a.copies || 1));
    }
    const markets = {};
    for (const cc of MARKETS) {
      const m = byCc.get(cc);
      if (m) markets[cc] = { ads: [...m.creatives.values()].reduce((x, y) => x + y, 0), days: m.days, new14: m.new14.size };
    }
    if (!Object.keys(markets).length) continue;
    const pageCount = new Map();
    for (const a of rows) if (a.page_id) pageCount.set(a.page_id, (pageCount.get(a.page_id) || 0) + 1);
    const pageId = [...pageCount].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([p]) => p)[0] || oldest.page_id;
    const page = pages.get(pageId);
    const counts = (page && page.counts) || {};
    const shopAds = Object.entries(counts).filter(([cc]) => markets[cc]).reduce((x, [, n]) => Math.max(x, Number(n) || 0), 0);
    const fromPage = rows.find((a) => a.page_id === pageId) || oldest;
    const euAds = (page && page.eu_ads) || {};
    const euHits = rows.map((a) => Number(euAds[a.ad_id])).filter((n) => Number.isFinite(n) && n > 0);
    const k = known.get(key);
    out.push({
      product_key: key,
      // Its own id space: the same ad can also be an EU winner, and a decision on one must not reach the other.
      ad_id: (k && k.ad_id) || 'w' + oldest.ad_id,
      active: 1,
      product_title: item.title || oldest.title,
      price: item.price,
      compare_at_price: item.compare_at_price,
      currency: item.currency || shop.currency || '',
      image_url: item.image_url || oldest.image_url || '',
      store_url: `https://${shop.host || store}/`,
      product_url: `https://${shop.host || store}/products/${key.split('/products/')[1]}`,
      ad_library_url: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(oldest.ad_id)}`,
      advertiser: fromPage.page_name || '',
      page_id: pageId || '',
      likes: fromPage.likes ?? null,
      keyword: oldest.keyword || rows.map((a) => a.keyword).find(Boolean) || '',
      markets: JSON.stringify(markets),
      ads: [...creatives.values()].reduce((x, y) => x + y, 0),
      creatives: creatives.size,
      days,
      new14: fresh.size,
      shop_ads: shopAds || null,
      in_eu: page && page.in_eu != null ? Number(page.in_eu) : null,
      eu_rpd: euHits.length ? Math.round(Math.max(...euHits)) : null,
      shop_eu_rpd: page && page.eu_rpd ? Math.round(Number(page.eu_rpd)) : null,
      store_products: shop.products ?? null,
      first_seen: (k && k.first_seen) || rows.map((a) => a.first_seen).filter(Boolean).sort()[0] || iso,
      last_seen: rows.map((a) => a.last_seen).filter(Boolean).sort().pop() || iso,
    });
  }
  return out;
}
