/*
 * One batch of the hunt: search the official Meta Ad Library API for active ads, check which stores run on
 * Shopify, find the product in the store, count the competitor's active ads and check every ad against the rules
 * (lib/score.mjs: Shopify, 75+ active ads, 7–42 days live, 500+ EU reach a day).
 *
 *   const { results, stats, cache } = await hunt({ tokens, queries: ['dress'], countries: ['NL', 'BE'] });
 *
 * The API returns ordinary (non-political) ads only for ads delivered in the EU/UK. Outside the EU (score.mjs WORLD,
 * e.g. countries: ['US', 'NZ']) it returns the ads there that also ran in the EU or UK, without reach: that hunt
 * skips the reach rule, keeps where each ad aims (target_locations) and marks its records world = 1.
 * It has no landing URL: the store comes from the domain shown on the ad, the product from the store's own
 * search (Shopify /search/suggest.json) using the ad's link title.
 *
 * Meta meters ads_archive per hour. Close to the limit the hunter slows down; a block (613 and friends) that would
 * take longer than maxBlockWaitMin moves on to the next token (META_TOKEN_2, _3); with none left the batch stops
 * with stats.blocked and still checks what it found.
 */
import { DEFAULTS, NON_STORE, SHOPIFY_HDR, hostOf, hostKey, noTemplate, scoreAd, adUrl, fmtDay, isWorld } from './score.mjs';
import { sized } from './storephoto.mjs';

const DAY = 864e5;
const CACHE_TTL = DAY; // a competitor's active-ad count is reused for 24 hours
const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
export const FIELDS = ['id', 'page_id', 'page_name', 'ad_creative_bodies', 'ad_creative_link_captions', 'ad_creative_link_titles',
  'ad_delivery_start_time', 'ad_delivery_stop_time', 'ad_snapshot_url', 'eu_total_reach', 'publisher_platforms',
  'age_country_gender_reach_breakdown'].join(',');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where an ad mainly runs: [[country, % of its EU/UK reach], …], biggest first. */
export function marketsOf(a) {
  const cc = {};
  for (const row of a.age_country_gender_reach_breakdown || []) {
    let t = 0;
    for (const g of row.age_gender_breakdowns || []) t += (+g.male || 0) + (+g.female || 0) + (+g.unknown || 0);
    if (row.country) cc[row.country] = (cc[row.country] || 0) + t;
  }
  const sum = Object.values(cc).reduce((x, y) => x + y, 0);
  if (!sum) return [];
  return Object.entries(cc).sort((x, y) => y[1] - x[1]).map(([c, v]) => [c, Math.round((v * 100) / sum)]).filter(([, p]) => p > 0).slice(0, 5);
}
// Cut text by characters, not UTF-16 units, so an emoji is never split (a half emoji breaks URLs).
export const cut = (t, n) => Array.from(String(t || '')).slice(0, n).join('');
const norm = (t) => noTemplate(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export async function hunt(opts, deps = {}) {
  const o = Object.assign({ countries: ['NL'], max: 1500, api: 'v24.0', base: 'https://graph.facebook.com', pageCap: 500, apiConcurrency: 2, settings: {} }, opts);
  const doFetch = deps.fetch || globalThis.fetch;
  const log = deps.log || ((m) => console.log(m));
  const world = isWorld(o.countries); // outside the EU: no reach rule
  const S = Object.assign({}, DEFAULTS, world ? { reach: false } : {}, o.settings);
  const now = deps.now || Date.now();
  const waitScale = deps.waitScale ?? 1;
  let usage = { pct: 0, regainMin: 0 };
  const stats = { apiCalls: 0, ads: 0, stores: 0, shopify: 0, counted: 0, cached: 0, gated: 0, products: 0, waits: 0, retries: 0, skipped: 0, usagePeak: 0, stoppedEarly: false, blocked: false };
  // deadline (ms timestamp): close to it the batch stops searching (at half the time left) and counting (at the
  // deadline) and scores what it has, so a long run always ends with its winners saved.
  const started = Date.now();
  const late = (share = 1) => !!o.deadline && Date.now() > started + (o.deadline - started) * share;
  const tokens = (o.tokens || []).filter(Boolean);
  if (!tokens.length) throw new Error('No access token: set the META_TOKEN secret');
  if (!o.queries || !o.queries.length) throw new Error('Nothing to search');
  let ti = Math.min(Math.max(0, o.tokenStart || 0), tokens.length - 1);
  stats.token = ti;
  const withToken = (url) => {
    const u = new URL(url);
    u.searchParams.set('access_token', tokens[ti]);
    return u.toString();
  };
  function nextToken(why) {
    if (ti >= tokens.length - 1) return false;
    ti++;
    stats.token = ti;
    stats.tokenSwitches = (stats.tokenSwitches || 0) + 1;
    usage = { pct: 0, regainMin: 0 };
    log(`${why}: switching to Meta token ${ti + 1} of ${tokens.length}`);
    return true;
  }

  // ---- Meta Ad Library API ----
  // x-business-use-case-usage (or x-app-usage): call count, CPU and time, 0–100%. Above the ceiling we slow down.
  const ceiling = o.usageCeiling ?? 75;
  const maxWaitMs = (o.maxBlockWaitMin ?? 30) * 60000;
  let blocked = null;
  function readUsage(res) {
    const h = res.headers && res.headers.get && (res.headers.get('x-business-use-case-usage') || res.headers.get('x-app-usage'));
    if (!h) return;
    try {
      const j = JSON.parse(h);
      const rows = Array.isArray(Object.values(j)[0]) ? Object.values(j).flat() : [j];
      let pct = 0;
      let regainMin = 0;
      for (const r of rows) {
        pct = Math.max(pct, r.call_count || 0, r.total_cputime || 0, r.total_time || 0);
        regainMin = Math.max(regainMin, r.estimated_time_to_regain_access || 0);
      }
      usage = { pct, regainMin };
      stats.usagePeak = Math.max(stats.usagePeak, pct);
    } catch (e) {
      // not JSON: ignore
    }
  }
  async function graph(url) {
    if (blocked) throw blocked;
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      // Close to Meta's hourly limit: pause (longer the closer we are) so the meter can drop.
      if (usage.pct >= ceiling) {
        const ms = Math.min(5 * 60000, 30000 * (1 + Math.floor((usage.pct - ceiling) / 5))) * waitScale;
        stats.paced = (stats.paced || 0) + 1;
        if (stats.paced === 1 || stats.paced % 20 === 0) log(`Meta usage ${usage.pct}%: slowing down (${Math.round(ms / 1000)}s pause)`);
        await sleep(ms);
        usage.pct = Math.max(0, usage.pct - 5); // the next answer brings the real value
      }
      stats.apiCalls++;
      url = withToken(url);
      const used = ti;
      let j;
      try {
        const res = await doFetch(url);
        readUsage(res);
        j = await res.json();
      } catch (e) {
        if (attempt >= 3) throw new Error('Meta API unreachable: ' + e.message);
        await sleep(2000 * (attempt + 1) * waitScale);
        continue;
      }
      const err = j && j.error;
      if (!err) return j;
      if (err.code === 190) {
        if (used !== ti || nextToken(`Meta token ${ti + 1} invalid or expired`)) continue;
        throw Object.assign(new Error('Meta access token invalid or expired: make a new one and update the META_TOKEN secret'), { token: true });
      }
      // Too much data in one answer (the per-country breakdown is big): ask for smaller pages.
      if (/reduce the amount of data/i.test(err.message || '') && attempt < 6) {
        const u = new URL(url);
        const lim = Number(u.searchParams.get('limit') || 250);
        if (lim > 10) {
          u.searchParams.set('limit', String(Math.max(10, Math.floor(lim / 2))));
          url = u.toString();
          continue;
        }
      }
      // Meta's temporary errors ("An unknown error occurred"): retry a few times, with smaller pages.
      if ((err.code === 1 || err.code === 2 || err.is_transient) && attempt < 4) {
        const u = new URL(url);
        const lim = Number(u.searchParams.get('limit') || 0);
        if (lim > 25) u.searchParams.set('limit', String(Math.floor(lim / 2)));
        url = u.toString();
        stats.retries++;
        await sleep(5000 * (attempt + 1) * waitScale);
        continue;
      }
      if (err.code === 10 || /identity|confirm/i.test(err.message || '')) {
        throw Object.assign(new Error('Meta says: ' + err.message + ' (confirm your identity at facebook.com/ID)'), { token: true });
      }
      if (RATE_CODES.has(err.code) || /limit/i.test(err.message || '')) {
        // Meta's own estimate when it gives one, else 1, 2, 4… minutes. Retrying during a block keeps it going,
        // so never hammer: stop once the wait would pass the limit.
        const ms = (usage.regainMin ? (usage.regainMin + 1) * 60000 : Math.min(60000 * 2 ** attempt, 10 * 60000)) * waitScale;
        const left = o.deadline ? o.deadline - Date.now() : Infinity;
        if (waited + ms > maxWaitMs || ms > left) {
          // A parallel request may already have switched: then just retry on the new token.
          if (used !== ti || nextToken(`Meta token ${ti + 1} hit its hourly limit`)) {
            waited = 0;
            continue;
          }
          stats.blocked = true;
          blocked = Object.assign(new Error(`Meta blocked us: hourly limit reached (${err.code})` + (usage.regainMin ? `, access back in ~${usage.regainMin} min` : '')), { blocked: true });
          log(blocked.message + ': stopping, scoring what was found');
          throw blocked;
        }
        waited += ms;
        stats.waits++;
        log(`Meta API limit (${err.code}): waiting ${Math.round(ms / 1000)}s`);
        await sleep(ms);
        continue;
      }
      throw new Error(`Meta API error ${err.code}: ${err.message}`);
    }
  }

  function archiveUrl(params) {
    const p = new URLSearchParams(Object.assign({
      ad_reached_countries: JSON.stringify(o.countries),
      ad_active_status: 'ACTIVE',
      ad_type: 'ALL',
    }, params));
    return `${o.base}/${o.api}/ads_archive?${p}`;
  }

  async function* pages(firstUrl, cap) {
    let url = firstUrl;
    let n = 0;
    while (url && n < cap) {
      const j = await graph(url);
      const data = Array.isArray(j.data) ? j.data : [];
      n += data.length;
      yield data;
      url = j.paging && j.paging.next ? j.paging.next : null;
      if (!data.length) break;
    }
  }

  // ---- Shopify (store domain from the ad, product via the store's search) ----
  async function getText(url, timeout = 15000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await doFetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { Accept: 'application/json' } });
      const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
      return { status: res.status, text: await res.text(), headers, url: res.url || url };
    } catch (e) {
      return { status: 0, text: '', headers: '', url, error: e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(t);
    }
  }

  const shopCache = new Map();
  function shopCheck(domain) {
    if (!shopCache.has(domain)) {
      shopCache.set(domain, (async () => {
        stats.stores++;
        for (const host of [domain, 'www.' + domain]) {
          const r = await getText(`https://${host}/meta.json`);
          let meta = null;
          try {
            const j = JSON.parse(r.text);
            if (j && /\.myshopify\.com$/i.test(j.myshopify_domain || '')) {
              meta = { name: j.name || '', myshopify: j.myshopify_domain, currency: j.currency || '', products: typeof j.published_products_count === 'number' ? j.published_products_count : null };
            }
          } catch (e) {
            // not JSON
          }
          if (meta || SHOPIFY_HDR.test(r.headers)) {
            stats.shopify++;
            return { shopify: true, host: hostKey(hostOf(r.url) || host), meta };
          }
          if (r.status) return { shopify: false, status: r.status };
        }
        return { shopify: false, error: 'unreachable' };
      })());
    }
    return shopCache.get(domain);
  }

  const productCache = new Map();
  function productFind(shop, title) {
    const key = shop.host + '|' + norm(title);
    if (!productCache.has(key)) {
      productCache.set(key, (async () => {
        const q = cut(noTemplate(title), 60);
        if (!q) return null;
        const r = await getText(`https://${shop.host}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=1`);
        try {
          const p = JSON.parse(r.text).resources.results.products[0];
          if (!p) return null;
          stats.products++;
          const num = (v) => (v == null || v === '' || Number(v) === 0 ? null : Number(v));
          const img = p.image || p.featured_image?.url || '';
          return { title: p.title, price: num(p.price), compareAt: num(p.compare_at_price_max ?? p.compare_at_price), currency: shop.meta?.currency || '',
            url: `https://${shop.host}${String(p.url || '').split('?')[0]}`, image: img ? sized(img) : '' };
        } catch (e) {
          return null;
        }
      })());
    }
    return productCache.get(key);
  }

  // ---- 1. search, only ads in the rules' age window (7–42 days) ----
  // The API lists the newest ads first, so without a date filter every result is a day old.
  // The window is split in 3 so each age range gets its share of max.
  const isoDay = (d) => new Date(now - d * DAY).toISOString().slice(0, 10);
  const step = Math.max(1, Math.ceil((S.ageMax - S.ageMin + 1) / 3));
  const windows = [0, 1, 2].map((i) => [S.ageMin + i * step, Math.min(S.ageMax, S.ageMin + (i + 1) * step - 1)]).filter(([a, b]) => a <= b);
  const ads = new Map();
  search: for (const q of o.queries) {
    for (const w of windows) {
      if (late(0.5)) {
        stats.stoppedEarly = true;
        log(`Time is half up: stopped searching at "${q}", scoring what was found`);
        break search;
      }
      const dates = { ad_delivery_date_min: isoDay(w[1]), ad_delivery_date_max: isoDay(w[0]) };
      const cap = Math.ceil(o.max / windows.length);
      try {
        for await (const batch of pages(archiveUrl(Object.assign({ search_terms: q, fields: world ? FIELDS + ',target_locations' : FIELDS, limit: String(Math.min(250, cap)) }, dates)), cap)) {
          for (const a of batch) if (a && a.id && !ads.has(String(a.id))) ads.set(String(a.id), toAd(a, q, now));
        }
      } catch (e) {
        // One keyword that keeps failing must not stop the run (an expired token still does).
        if (e.token) throw e;
        if (e.blocked) break search;
        stats.skipped++;
        log(`"${q}" ${w[0]}–${w[1]} days old: skipped (${e.message})`);
      }
    }
  }
  stats.ads = ads.size;

  // ---- 2. stores ----
  const byDomain = new Map();
  for (const ad of ads.values()) if (ad.cap && !NON_STORE.test(ad.cap)) byDomain.set(ad.cap, true);
  await pool([...byDomain.keys()], 6, async (d) => byDomain.set(d, await shopCheck(d).catch(() => ({ shopify: false, error: 'check failed' }))));

  // ---- 3. products: the store's own search with the ad's link title (no Meta requests) ----
  const shopAds = [...ads.values()].filter((ad) => ad.title && byDomain.get(ad.cap)?.shopify);
  await pool(shopAds, 8, async (ad) => {
    ad.product = await productFind(byDomain.get(ad.cap), ad.title).catch(() => null);
  });

  const seenTitle = {};
  for (const ad of ads.values()) {
    const k = ad.pageId + '|' + norm(ad.title);
    seenTitle[k] = (seenTitle[k] || 0) + 1;
  }
  const storeOf = (ad) => (ad.cap && !NON_STORE.test(ad.cap) ? byDomain.get(ad.cap) : null);
  function inputsFor(ad, pi, dupesOverride) {
    const t = norm(ad.title);
    const dupes = dupesOverride ?? Math.max(1, t ? seenTitle[ad.pageId + '|' + t] || 1 : 1, t && pi ? (pi.titles || {})[t] || 0 : 0);
    return {
      shop: storeOf(ad) || null,
      cnt: pi ? { count: pi.count } : null,
      reach: typeof ad.reachEU === 'number' ? { eu: ad.reachEU, uk: null, br: null } : { err: 'not published' },
      product: ad.product || null,
      dupes,
    };
  }

  // ---- 4. competitors: active ads, same-title duplicates, age spread ----
  // Counting costs Meta requests, so only advertisers with an ad that passes every other rule (checked as if
  // they had the most ads), and never twice within 24 hours.
  const cache = o.cache || {};
  const fresh = (e) => !!e && now - (e.t || 0) < CACHE_TTL;
  const need = new Set();
  const usedCache = new Set();
  for (const ad of ads.values()) {
    if (!ad.pageId) continue;
    const shop = storeOf(ad);
    if (!shop?.shopify) continue;
    if (fresh(cache[ad.pageId])) {
      usedCache.add(ad.pageId);
      continue;
    }
    if (need.has(ad.pageId)) continue;
    const best = scoreAd(ad, inputsFor(ad, { count: 1e6, titles: {} }, 3), S, now);
    if (best.verdict === 'skip') {
      stats.gated++;
      continue;
    }
    need.add(ad.pageId);
  }
  stats.cached = usedCache.size;
  await pool([...need], o.apiConcurrency, async (pid) => {
    if (late()) {
      if (!stats.outOfTime) log(`Time is up: stopped counting after ${stats.counted}/${need.size} competitors`);
      stats.outOfTime = stats.stoppedEarly = true;
      return;
    }
    try {
      await countCompetitor(pid);
    } catch (e) {
      if (e.token) throw e;
      if (e.blocked) return;
      stats.skipped++;
      log(`competitor ${pid}: skipped (${e.message})`);
    }
  });
  async function countCompetitor(pid) {
    let count = 0;
    const titles = {};
    const buckets = new Set();
    for await (const batch of pages(archiveUrl({ search_page_ids: JSON.stringify([pid]), fields: 'id,ad_creative_link_titles,ad_delivery_start_time', limit: String(Math.min(500, o.pageCap)) }), o.pageCap)) {
      for (const a of batch) {
        count++;
        const t = norm((a.ad_creative_link_titles || [])[0]);
        if (t) titles[t] = (titles[t] || 0) + 1;
        const d = a.ad_delivery_start_time ? Math.floor((now - Date.parse(a.ad_delivery_start_time)) / DAY) : null;
        if (d != null) buckets.add(d < 7 ? 0 : d <= 20 ? 1 : d <= 40 ? 2 : 3);
      }
    }
    // Only titles used in 2+ ads matter (duplicates); keeps the memory small.
    const dup = Object.fromEntries(Object.entries(titles).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 60));
    cache[pid] = { t: now, count, titles: dup, buckets: buckets.size, capped: count >= o.pageCap };
    stats.counted++;
  }

  // ---- 5. check every ad against the rules ----
  const out = [];
  for (const ad of ads.values()) {
    const pi = cache[ad.pageId] && fresh(cache[ad.pageId]) ? cache[ad.pageId] : null;
    const ev = scoreAd(ad, inputsFor(ad, pi), S, now);
    if (pi && pi.capped) ev.items.find((i) => i.key === 'ads').text += ` (${o.pageCap}+ counted)`;
    if (pi && pi.buckets >= 3) ev.items.find((i) => i.key === 'ads').text += ' · ad ages spread out (consistent testing)';
    out.push({ ad, ev, shop: storeOf(ad), product: ad.product || null, pi });
  }

  // ---- 6. only ads that pass every rule (pending = unknown: not saved), the best per advertiser + product ----
  const best = new Map();
  for (const r of out) {
    if (r.ev.verdict !== 'winner') continue;
    const k = r.ad.pageId + '|' + (r.product ? r.product.url : norm(r.ad.title) || norm(r.ad.body).slice(0, 80) || r.ad.id);
    if (!best.has(k) || best.get(k).ev.reachPerDay < r.ev.reachPerDay) best.set(k, r);
  }
  const results = [...best.values()].sort((a, b) => b.ev.reachPerDay - a.ev.reachPerDay);
  return { results: results.map((r) => record(r, o)), stats, cache };
}

function toAd(a, q, now) {
  const cap = String((a.ad_creative_link_captions || [])[0] || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/^www\d?\./, '');
  const domain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(cap) ? cap : '';
  const startMs = a.ad_delivery_start_time ? Date.parse(a.ad_delivery_start_time) : 0;
  const stopMs = a.ad_delivery_stop_time ? Date.parse(a.ad_delivery_stop_time) : 0;
  return {
    id: String(a.id),
    pageId: String(a.page_id || ''),
    pageName: String(a.page_name || ''),
    active: !stopMs || stopMs > now,
    start: startMs ? Math.floor(startMs / 1000) : 0,
    end: stopMs ? Math.floor(stopMs / 1000) : 0,
    coll: 1,
    plat: (a.publisher_platforms || []).map((x) => String(x).toUpperCase()),
    cap: domain,
    links: domain ? [`https://${domain}/`] : [],
    title: cut(noTemplate((a.ad_creative_link_titles || [])[0]), 200),
    body: cut(noTemplate((a.ad_creative_bodies || [])[0]), 600),
    cta: '',
    reachEU: typeof a.eu_total_reach === 'number' ? a.eu_total_reach : null,
    markets: marketsOf(a),
    targets: (a.target_locations || []).filter((l) => l && !l.excluded && l.name).map((l) => String(l.name)),
    query: q,
  };
}

function record({ ad, ev, shop, product, pi }, o) {
  return {
    id: ad.id,
    score: ev.score,
    verdict: ev.verdict,
    checklist: ev.items.map((i) => ({ key: i.key, label: i.label, state: i.state, text: i.text })),
    market: o.countries.join(','),
    world: isWorld(o.countries) ? 1 : 0,
    targets: (ad.targets || []).join(', '),
    keyword: ad.query,
    product_title: (product && product.title) || ad.title,
    price: product ? product.price : null,
    compare_at_price: product ? product.compareAt : null,
    currency: (product && product.currency) || shop?.meta?.currency || '',
    discount_pct: ev.discount,
    product_url: product ? product.url : ad.links[0] || '',
    store_url: shop?.shopify ? `https://${shop.host}/` : ad.links[0] || '',
    store_products: shop?.meta?.products ?? null,
    advertiser: ad.pageName,
    advertiser_page_id: ad.pageId,
    active_ads: pi ? pi.count : null,
    ad_library_url: adUrl(ad.id),
    ad_age_days: ev.days,
    ad_start_date: fmtDay(ad.start),
    scaled_count: ev.dupes,
    headline: ad.title,
    ad_copy: ad.body,
    reach_eu: ad.reachEU,
    top_countries: ad.markets.map(([c, p]) => `${c} ${p}%`).join(', '),
    image_url: product ? product.image : '',
    image_source: product && product.image ? 'product' : '',
  };
}

/**
 * Meta's debug_token for every token: [{ n, valid, expiresAt (ms, 0 = never) }] or [{ n, error }] when the check
 * itself failed. Never throws; a token never appears in what it returns.
 */
export async function checkTokens(tokens, { fetch: doFetch = globalThis.fetch, base = 'https://graph.facebook.com', api = 'v21.0', timeout = 15000 } = {}) {
  return Promise.all((tokens || []).map(async (tok, i) => {
    const n = i + 1;
    const hide = (m) => String(m || '').split(tok).join('***');
    try {
      const u = new URL(`${base}/${api}/debug_token`);
      u.searchParams.set('input_token', tok);
      u.searchParams.set('access_token', tok);
      const res = await doFetch(u.toString(), { signal: AbortSignal.timeout(timeout) });
      const j = await res.json().catch(() => null);
      if (j && j.error) return j.error.code === 190 ? { n, valid: false, expiresAt: null } : { n, error: hide(`Meta API error ${j.error.code}: ${j.error.message}`) };
      const d = j && j.data;
      if (!d) return { n, error: 'HTTP ' + res.status };
      const exp = Number(d.expires_at) || 0;
      return { n, valid: d.is_valid !== false, expiresAt: exp ? exp * 1000 : 0 };
    } catch (e) {
      return { n, error: hide(e.message) };
    }
  }));
}

export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}
