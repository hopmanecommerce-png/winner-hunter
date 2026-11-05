/*
 * Audience engine, stage 1: collect. What real customers say about a problem, and who the competitors' ads reach.
 *
 *   Meta Ad Library ad details   EU reach by country x age x gender, the targeting the advertiser set, the full ad text
 *   Reddit comment search        what people write about the problem, in their own words
 *   TikTok keyword search        the most-discussed videos about the product, then their comments
 *   YouTube search ("… review")  the most-discussed review, then its comments
 *   Reddit post search           (optional) the biggest thread about it, then its comments
 *   TikTok Shop search           (optional) the best-selling US listing, then its buyers' reviews
 *
 * All of it through Scrape Creators (1 credit a call) with scrapeCreators() from lib/google-ads.mjs: a hard credit cap per
 * run, 401/402 stop the run, a vendor outage stops it. On top of that: a credit cap per product, a deadline, and a cache.
 * Pulls are cached by what was asked (the query, the video, the ad id), not by product, so a niche pulled once serves
 * every product in it for TTL days at no cost: the daily run gets cheaper as the cache fills.
 *
 * Privacy: a voice item keeps the text, its likes, its date and the public link. Never a name, a handle or a photo.
 */
import { scrapeCreators } from './google-ads.mjs';

export const VERSION = 1;
export const SECRET = 'SCRAPECREATORS_API_KEY';
export const KINDS = {
  fb_ad: { path: '/v1/facebook/adLibrary/ad', cost: 1 },
  fb_search: { path: '/v1/facebook/adLibrary/search/ads', cost: 1 },
  reddit_search: { path: '/v1/reddit/search', cost: 1 },
  reddit_thread: { path: '/v1/reddit/post/comments', cost: 1 },
  tiktok_search: { path: '/v1/tiktok/search/keyword', cost: 1 },
  tiktok_comments: { path: '/v1/tiktok/video/comments', cost: 1 },
  youtube_search: { path: '/v1/youtube/search', cost: 1 },
  youtube_comments: { path: '/v1/youtube/video/comments', cost: 1 },
  shop_search: { path: '/v1/tiktok/shop/search', cost: 1 },
  shop_product: { path: '/v1/tiktok/product', cost: 1 },
};
const DAY = 864e5;
export const TTL = { voice: 21 * DAY, ad: 30 * DAY }; // problem talk changes slowly; an ad's reach split too
export const MAX_TEXT = 600; // characters kept per statement
export const MAX_ITEMS = 120; // statements kept per pull

/** The client: scrapeCreators() on the audience endpoints. cap: the most credits this run may spend. */
export function audienceClient({ key, cap, fetch, sleep, timeout } = {}) {
  return scrapeCreators({ key, cap, fetch, sleep, timeout, kinds: KINDS });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const str = (v, n = MAX_TEXT) => Array.from(String(v ?? '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');
const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = String(v ?? '').replace(/[, ]/g, '');
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(t);
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2].toLowerCase() === 'k' ? 1e3 : m[2].toLowerCase() === 'm' ? 1e6 : 1));
};
const iso = (v) => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : /^\d+$/.test(String(v)) ? Number(v) : NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
};
/** Like str, but keeps line breaks (an ad's first line is its hook). */
const lines = (v, n) => Array.from(String(v ?? '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()).slice(0, n).join('');
const https = (u) => (/^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : '');
/** A statement worth keeping: words, not only emoji, tags or a link. */
export function usable(text) {
  const t = String(text || '');
  const words = t.replace(/https?:\/\/\S+/g, ' ').replace(/[@#]\S+/g, ' ').match(/\p{L}{2,}/gu) || [];
  return words.length >= 4;
}
/** The cache key of a query: case, spacing and punctuation do not make a new pull. */
export const queryKey = (q) => String(q || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// ---------------------------------------------------------------------------
// Readers: one vendor answer → small records. Pure, so the tests run on saved answers.
// ---------------------------------------------------------------------------

/** Meta ad details → { id, page, started, ended, active, body, title, link, cta, platforms, targeting, reach }. */
export function readFbAd(j) {
  if (!j || typeof j !== 'object') return null;
  const snap = j.snapshot || {};
  const eu = j.aaa_info || j.eu_transparency || {};
  const cells = {};
  const byCountry = {};
  let total = 0;
  for (const row of Array.isArray(eu.age_country_gender_reach_breakdown) ? eu.age_country_gender_reach_breakdown : []) {
    const cc = String(row && row.country || '').toUpperCase().slice(0, 2);
    for (const g of Array.isArray(row && row.age_gender_breakdowns) ? row.age_gender_breakdowns : []) {
      const age = String(g && g.age_range || '').trim();
      if (!/^(\d{2}-\d{2}|65\+)$/.test(age)) continue;
      for (const [sex, k] of [['F', 'female'], ['M', 'male'], ['U', 'unknown']]) {
        const v = Math.max(0, num(g[k]));
        if (!v) continue;
        cells[`${sex}|${age}`] = (cells[`${sex}|${age}`] || 0) + v;
        if (cc) byCountry[cc] = (byCountry[cc] || 0) + v;
        total += v;
      }
    }
  }
  const ages = eu.age_audience && typeof eu.age_audience === 'object' ? { min: num(eu.age_audience.min) || null, max: num(eu.age_audience.max) || null } : null;
  const locations = (Array.isArray(eu.location_audience) ? eu.location_audience : []).filter((l) => l && !l.excluded).map((l) => str(l.name, 60)).filter(Boolean);
  const body = lines(snap.body && typeof snap.body === 'object' ? snap.body.text : snap.body, 4000);
  const cards = Array.isArray(snap.cards) ? snap.cards : [];
  return {
    id: str(j.adArchiveID || j.ad_archive_id || '', 30),
    page: str(j.pageName || snap.page_name || '', 120),
    started: iso(j.startDate || j.startDateString),
    ended: iso(j.endDate || j.endDateString),
    active: j.isActive === true,
    body: body || lines(cards[0] && cards[0].body, 4000),
    title: str(snap.title || (cards[0] && cards[0].title) || '', 200),
    link: https(snap.link_url || (cards[0] && cards[0].link_url)),
    cta: str(snap.cta_text || '', 40),
    platforms: (Array.isArray(j.publisherPlatform) ? j.publisherPlatform : []).map((p) => str(p, 30)),
    targeting: { ages, gender: str(eu.gender_audience || '', 20) || null, locations },
    reach: { total: num(eu.eu_total_reach) || total, cells, byCountry },
  };
}

/** Meta Ad Library keyword search → ads (as the vendor sorts them: most impressions first) that link to a shop. */
export function readFbSearch(j) {
  return (Array.isArray(j && j.searchResults) ? j.searchResults : [])
    .map((a) => ({ id: str(a && a.ad_archive_id, 30), page: str(a && a.page_name, 120), link: https(a && a.snapshot && (a.snapshot.link_url || (Array.isArray(a.snapshot.cards) && a.snapshot.cards[0] && a.snapshot.cards[0].link_url))),
      started: iso(a && a.start_date), active: !!(a && a.is_active), copies: num(a && a.collation_count) }))
    .filter((a) => /^\d{6,}$/.test(a.id) && a.link && !/facebook\.com|instagram\.com|fb\.me/.test(a.link));
}

const voice = (src, kind, text, { likes = 0, date = null, url = '', rating = null, q = '', on = '' } = {}) =>
  ({ src, kind, text: str(text), likes: Math.max(0, num(likes)), date, url: https(url), rating, q, on: str(on, 160) });

/** Reddit search, comments → voice items. */
export function readRedditComments(j, q) {
  const out = [];
  for (const c of Array.isArray(j && j.comments) ? j.comments : []) {
    const text = c && (c.body || c.text);
    if (!usable(text)) continue;
    out.push(voice('reddit', 'comment', text, { likes: c.votes ?? c.ups ?? c.score, date: iso(c.created_at_iso || c.created_utc), url: c.url, q, on: c.post && c.post.title }));
  }
  return out.slice(0, MAX_ITEMS);
}

/** Reddit search, posts → threads (biggest first) and the post texts as voice items. */
export function readRedditPosts(j, q) {
  const posts = (Array.isArray(j && j.posts) ? j.posts : Array.isArray(j && j.data) ? j.data : []).filter((p) => p && p.title);
  const threads = posts.map((p) => ({ url: https(p.url && /reddit\.com/.test(p.url) ? p.url : p.permalink ? 'https://www.reddit.com' + p.permalink : ''),
    title: str(p.title, 200), comments: num(p.num_comments), votes: num(p.ups ?? p.score), date: iso(p.created_at_iso || p.created_utc), sub: str(p.subreddit, 60) }))
    .filter((t) => t.url).sort((a, b) => b.comments - a.comments);
  const items = posts.filter((p) => usable(p.selftext)).map((p) => voice('reddit', 'post', `${p.title}. ${p.selftext}`,
    { likes: p.ups ?? p.score, date: iso(p.created_at_iso || p.created_utc), url: p.url || (p.permalink ? 'https://www.reddit.com' + p.permalink : ''), q }));
  return { threads, items: items.slice(0, MAX_ITEMS) };
}

/** A Reddit thread's comments (with replies) → voice items. */
export function readRedditThread(j, q, on = '') {
  const out = [];
  const walk = (list, depth) => {
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || out.length >= MAX_ITEMS) return;
      if (usable(c.body)) out.push(voice('reddit', 'comment', c.body, { likes: c.ups ?? c.score, date: iso(c.created_at_iso || c.created_utc), url: c.url, q, on }));
      if (depth < 3 && c.replies && Array.isArray(c.replies.items)) walk(c.replies.items, depth + 1);
    }
  };
  walk(j && j.comments, 0);
  return out;
}

/** TikTok keyword search → videos, most comments first. */
export function readTikTokVideos(j) {
  return (Array.isArray(j && j.search_item_list) ? j.search_item_list : Array.isArray(j && j.videos) ? j.videos : [])
    .map((v) => {
      const s = (v && v.statistics) || {};
      const id = str(v && v.aweme_id, 30);
      const url = https(v && v.url) || (id && v.author && v.author.unique_id ? `https://www.tiktok.com/@${v.author.unique_id}/video/${id}` : '');
      return { id, url, desc: str(v && v.desc, 300), comments: num(s.comment_count), plays: num(s.play_count), likes: num(s.digg_count), date: iso(v && v.create_time), ad: !!(v && v.is_ad) };
    })
    .filter((v) => v.url && !v.ad).sort((a, b) => b.comments - a.comments);
}

/** TikTok video comments → voice items. */
export function readTikTokComments(j, q, on = '') {
  const out = [];
  for (const c of Array.isArray(j && j.comments) ? j.comments : []) {
    if (!c || !usable(c.text)) continue;
    out.push(voice('tiktok', 'comment', c.text, { likes: c.digg_count, date: iso(c.create_time), url: on, q, on }));
  }
  return out.slice(0, MAX_ITEMS);
}

/** YouTube search → videos (shorts too), most comments first, then most views. */
export function readYouTubeVideos(j) {
  const list = [...(Array.isArray(j && j.videos) ? j.videos : []), ...(Array.isArray(j && j.shorts) ? j.shorts : [])];
  return list.map((v) => ({ id: str(v && v.id, 20), url: https(v && v.url) || (v && v.id ? `https://www.youtube.com/watch?v=${v.id}` : ''), title: str(v && v.title, 200),
    views: num(v && (v.viewCountInt ?? v.viewCountText)), comments: num(v && (v.commentCountInt ?? v.commentCountText)), date: iso(v && v.publishedTime) }))
    .filter((v) => v.url).sort((a, b) => b.comments - a.comments || b.views - a.views);
}

/** YouTube video comments → voice items (the creator's own comments left out: often an affiliate link). */
export function readYouTubeComments(j, q, on = '') {
  const out = [];
  for (const c of Array.isArray(j && j.comments) ? j.comments : []) {
    if (!c || (c.author && c.author.isCreator) || !usable(c.content)) continue;
    out.push(voice('youtube', 'comment', c.content, { likes: c.engagement && c.engagement.likes, date: iso(c.publishedTime), url: on, q, on }));
  }
  return out.slice(0, MAX_ITEMS);
}

/** TikTok Shop search → products, best sellers first. */
export function readShopProducts(j) {
  return (Array.isArray(j && j.products) ? j.products : [])
    .map((p) => ({ id: str(p && p.product_id, 30), url: https(p && (p.url || (p.seo_url && p.seo_url.canonical_url))), title: str(p && p.title, 200),
      sold: num(p && (p.sold_info ? p.sold_info.sold_count : p.sold_count)), rating: Number(p && (p.rate_info ? p.rate_info.score : p.rating)) || null,
      reviews: num(p && (p.rate_info ? p.rate_info.review_count : p.review_count)) }))
    .filter((p) => p.url).sort((a, b) => b.sold - a.sold);
}

/** TikTok Shop product → its buyers' reviews as voice items. */
export function readShopReviews(j, q, on = '') {
  const info = (j && (j.product_info || j)) || {};
  const rev = info.product_detail_review || (j && j.product_detail_review) || {};
  const out = [];
  for (const r of Array.isArray(rev.review_items) ? rev.review_items : []) {
    const x = (r && r.review) || {};
    const text = x.display_text || (Array.isArray(x.display_review_text) ? x.display_review_text.map((t) => t && t.plain_text).join(' ') : '');
    if (!usable(text)) continue;
    out.push(voice('tiktok_shop', 'review', text, { date: iso(x.review_timestamp), rating: num(x.rating) || null, url: on, q, on }));
  }
  return out.slice(0, MAX_ITEMS);
}

// ---------------------------------------------------------------------------
// The cache: a file folder (research runs, tests) or D1 (the daily job). Same interface.
// ---------------------------------------------------------------------------

/** In memory (tests). */
export function memoryCache(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); }, map: m };
}

/** One JSON file per key in dir (node only). */
export async function fileCache(dir) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(dir, { recursive: true });
  const file = (k) => path.join(dir, k.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 180) + '.json');
  return {
    async get(k) {
      try {
        return JSON.parse(await fs.readFile(file(k), 'utf8'));
      } catch (e) {
        return null;
      }
    },
    async put(k, v) {
      await fs.writeFile(file(k), JSON.stringify(v));
    },
  };
}

/**
 * D1 (lib/d1.mjs client: db.query(sql, params) → rows), table audience_cache (key, at, data), for runs outside the daily
 * job. One row per key, read by its primary key: never a scan. The daily job passes its own cache instead (ctxCache).
 */
export function d1Cache(db) {
  return {
    async get(k) {
      const rows = await db.query('SELECT at, data FROM audience_cache WHERE key = ?', [k]);
      if (!rows || !rows.length) return null;
      try {
        return { at: rows[0].at, data: JSON.parse(rows[0].data) };
      } catch (e) {
        return null;
      }
    },
    async put(k, v) {
      await db.query('INSERT INTO audience_cache (key, at, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at, data = excluded.data',
        [k, v.at, JSON.stringify(v.data)]);
    },
  };
}

/** The daily job's cache (shared/INTERFACES.md: get(key) → value, put(key, value, days)) in this module's shape. */
export function ctxCache(c, days = 30) {
  return {
    async get(k) {
      const v = await c.get(k);
      return v && typeof v === 'object' && 'at' in v && 'data' in v ? v : null;
    },
    async put(k, v) {
      await c.put(k, v, k.startsWith('fbad:') ? Math.round(TTL.ad / DAY) : Math.round(TTL.voice / DAY) || days);
    },
  };
}

// ---------------------------------------------------------------------------
// The plan for one product
// ---------------------------------------------------------------------------

/**
 * Everything for one product. pick: { id, phrase (English search words), ad_ids[], shop (also TikTok Shop reviews) }.
 * o: { api (audienceClient), cache, now, perPick (credits for this product), deadline (ms), log, threads (Reddit threads),
 *      videos (TikTok videos to read), shop }.
 * Returns { ads[], voice[], pulls[], credits, errors[] }. Never throws for one source: a failed source is a line in errors,
 * and a stop (key, credits, the run's cap, an outage) ends the plan with what it has (stopped: the reason).
 */
export async function collect(pick, o) {
  const now = o.now ?? Date.now();
  const log = o.log || (() => {});
  const res = { ads: [], voice: [], pulls: [], credits: 0, errors: [], stopped: '' };
  const perPick = Math.max(0, Math.floor(o.perPick ?? 14));
  const phrase = str(pick.phrase, 80);
  const late = () => (!!o.deadline && Date.now() > o.deadline) || !!(o.signal && o.signal.aborted);

  // One pull: from the cache when it is young enough, else from the vendor (when the product's credits allow).
  async function pull(cacheKey, ttl, kind, params, read) {
    const hit = o.cache ? await o.cache.get(cacheKey).catch(() => null) : null;
    if (hit && hit.at && now - Date.parse(hit.at) < ttl) {
      res.pulls.push({ key: cacheKey, kind, cached: true, at: hit.at, n: Array.isArray(hit.data) ? hit.data.length : hit.data ? 1 : 0 });
      return hit.data;
    }
    if (res.stopped) return null;
    if (!o.api) {
      res.stopped = 'no API key (cache only)';
      return null;
    }
    if (late()) {
      res.stopped = 'deadline';
      return null;
    }
    if (res.credits + KINDS[kind].cost > perPick) {
      res.stopped = 'product credit cap';
      return null;
    }
    const before = o.api.stats().spent;
    let j;
    try {
      j = await o.api.call(kind, params);
    } catch (e) {
      res.credits += o.api.stats().spent - before;
      if (e && e.stop) res.stopped = e.kind || 'stop';
      res.errors.push(`${kind}: ${e && e.message}`);
      log(`audience ${pick.id}: ${kind} failed (${e && e.message})`);
      return null;
    }
    const spent = o.api.stats().spent - before;
    res.credits += spent;
    const data = j ? read(j) : null;
    const at = new Date(now).toISOString();
    res.pulls.push({ key: cacheKey, kind, cached: false, at, credits: spent, n: Array.isArray(data) ? data.length : data ? 1 : 0 });
    if (o.cache && data != null) await o.cache.put(cacheKey, { at, data }).catch((e) => res.errors.push(`cache: ${e.message}`));
    return data;
  }

  // 1. The competitor ads: who they reach (EU), what they say. The vendor's own cache of an ad is free (cache_max_age).
  for (const id of (pick.ad_ids || []).map((x) => String(x).replace(/\D/g, '')).filter(Boolean).slice(0, o.ads ?? 3)) {
    const ad = await pull(`fbad:${id}`, TTL.ad, 'fb_ad', { id, cache_max_age: '30d', trim: 'true' }, readFbAd);
    if (ad && ad.id) res.ads.push(ad);
  }
  if (!phrase) return res;
  const q = queryKey(phrase);

  // 1b. No competitor ad with EU reach numbers (a product outside the EU, a research idea): the Ad Library in Ireland,
  // an EU country that reads English, finds who advertises the same thing there. Its top ads give the reach split.
  if (!res.ads.some((a) => a.reach && a.reach.total > 0) && (o.euSearch ?? 'IE')) {
    const cc = o.euSearch || 'IE';
    const found = await pull(`fbsearch:${cc}:${q}`, TTL.voice, 'fb_search', { query: phrase, country: cc, status: 'ACTIVE', trim: 'true' }, (j) => readFbSearch(j).slice(0, 10));
    for (const f of (found || []).filter((x) => x.active).slice(0, o.searchAds ?? 2)) {
      const ad = await pull(`fbad:${f.id}`, TTL.ad, 'fb_ad', { id: f.id, cache_max_age: '30d', trim: 'true' }, readFbAd);
      if (ad && ad.id) res.ads.push({ ...ad, found: `Ad Library search "${phrase}" in ${cc}` });
    }
  }

  // 2. Reddit: comments that use the words, in all of Reddit.
  const rc = await pull(`reddit:c:${q}`, TTL.voice, 'reddit_search', { query: phrase, filter: 'comments', sort: 'relevance', timeframe: 'all', trim: 'true' }, (j) => readRedditComments(j, phrase));
  if (rc) res.voice.push(...rc);

  // 3. TikTok: the most-discussed videos, then their comments.
  const vids = await pull(`tiktok:s:${q}`, TTL.voice, 'tiktok_search', { query: phrase, sort_by: 'relevance', trim: 'true' }, (j) => readTikTokVideos(j).slice(0, 10));
  for (const v of (vids || []).filter((x) => x.comments >= 10).slice(0, o.videos ?? 2)) {
    const tc = await pull(`tiktok:c:${v.id}`, TTL.voice, 'tiktok_comments', { url: v.url, trim: 'true' }, (j) => readTikTokComments(j, phrase, v.url));
    if (tc) res.voice.push(...tc);
  }

  // 4. YouTube: the most-discussed review, then its comments.
  const yv = await pull(`youtube:s:${q}`, TTL.voice, 'youtube_search', { query: `${phrase} review`, includeExtras: 'true' }, (j) => readYouTubeVideos(j).slice(0, 10));
  for (const v of (yv || []).filter((x) => x.comments >= 5).slice(0, o.reviews ?? 1)) {
    const yc = await pull(`youtube:c:${v.id}`, TTL.voice, 'youtube_comments', { url: v.url, order: 'top' }, (j) => readYouTubeComments(j, phrase, v.url));
    if (yc) res.voice.push(...yc);
  }

  // 5. (optional) The biggest Reddit thread about it.
  if ((o.threads ?? 1) > 0) {
    const rp = await pull(`reddit:p:${q}`, TTL.voice, 'reddit_search', { query: phrase, filter: 'posts', sort: 'relevance', timeframe: 'all', trim: 'true' }, (j) => readRedditPosts(j, phrase));
    if (rp) {
      res.voice.push(...(rp.items || []));
      for (const t of (rp.threads || []).filter((x) => x.comments >= 5).slice(0, o.threads ?? 1)) {
        const tc = await pull(`reddit:t:${queryKey(t.url)}`, TTL.voice, 'reddit_thread', { url: t.url, trim: 'true' }, (j) => readRedditThread(j, phrase, t.title));
        if (tc) res.voice.push(...tc);
      }
    }
  }

  // 6. (optional) US buyers' reviews of the best-selling TikTok Shop listing.
  if (pick.shop ?? o.shop) {
    const sp = await pull(`shop:s:${q}`, TTL.voice, 'shop_search', { query: phrase, region: 'US' }, (j) => readShopProducts(j).slice(0, 10));
    const best = (sp || [])[0];
    if (best) {
      const rv = await pull(`shop:p:${best.id || queryKey(best.url)}`, TTL.voice, 'shop_product', { url: best.url, region: 'US' }, (j) => readShopReviews(j, phrase, best.url));
      if (rv) res.voice.push(...rv);
    }
  }
  return res;
}
