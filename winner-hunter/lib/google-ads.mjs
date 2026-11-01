/*
 * Google's ad library (the Google Ads Transparency Center), read through the Scrape Creators API: the client, what its
 * answers mean, and our rules on them. google.mjs runs the hunt; docs/google-ads/README.md maps every field to a rule.
 *
 *   const api = googleClient({ key, cap: 300 });            every call checks the credit cap before it is sent
 *   await api.searchAdvertisers('posture', 'NL')            { advertisers: [{ id, name, region, estimate }], domains }   1 credit
 *   await api.companyAds({ domain | advertiserId, … })      { ads, cursor, estimate }                                     1 credit a page
 *   await api.adDetails(creativeUrl)                        { firstShown, lastShown, regions, impressions, variations, … } 1 credit (0 cached)
 *   googleRules(facts, { now })                             our four rules, each 'exact', 'approx' or not checked (unknown)
 *
 * Endpoints, parameters, fields and prices: docs.scrapecreators.com (OpenAPI spec read 2026-11-01). The vendor says its
 * Google answers "might not all be 100% the same", so every field is read defensively: a missing or odd field is
 * unknown, never a pass. Nothing here throws on odd data; the client throws GoogleApiError (stop: the run should end).
 * Pure: fetch, sleep and the clock are passed in, so the tests run on fixtures (test/fixtures/google).
 */
import { DAY, NON_STORE, MIN_ACTIVE_ADS, MIN_AGE_DAYS, MAX_AGE_DAYS, MIN_REACH_PER_DAY, hostOf, hostKey, fmtCompact } from './score.mjs';
import { productKey } from './bestsellers.mjs';
import { EU_CODES } from './eu.mjs';

export const API = 'https://api.scrapecreators.com';
export const PATHS = { search: '/v1/google/adLibrary/advertisers/search', ads: '/v1/google/company/ads', ad: '/v1/google/ad' };
// Credits per call (the docs). Company ads with get_ad_details=true would cost 25: the hunt never asks for that.
export const COST = { search: 1, ads: 1, ad: 1 };
export const TRANSPARENCY = 'https://adstransparency.google.com';
// Google has no "active" flag: an ad shown in the last RUNNING_DAYS days still runs. The hunt also asks Google only for
// ads shown in that window (start_date / end_date), so number_of_ads_estimate is the advertiser's ads running now.
export const RUNNING_DAYS = 3;
export const SECRET = 'SCRAPECREATORS_API_KEY';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v, n = 2000) => (v == null || typeof v === 'object' ? '' : Array.from(String(v).trim()).slice(0, n).join(''));
/** A count from a number or a numeric string ("600000", "1,200"); null when there is none. */
export const int = (v) => {
  if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
/** A time in ms from an ISO date, or from seconds / ms since 1970 (number or digits); null when unreadable. */
export function timeOf(v) {
  if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return null;
  if (/^\d{9,13}$/.test(String(v).trim())) {
    const n = Number(v);
    return String(v).trim().length > 11 ? n : n * 1000;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}
const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim().slice(0, 1000) : '');
const isoDay = (ms) => (ms == null ? '' : new Date(ms).toISOString().slice(0, 10));
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

// ---------------------------------------------------------------------------
// Ids, links and domains
// ---------------------------------------------------------------------------
const ADV = /^AR\d{5,30}$/;
const CRE = /^CR\d{5,30}$/;
const CC = /^[A-Z]{2}$/;
/** An advertiser id (AR + digits) or a creative id (CR + digits), else ''. */
export const advertiserIdOf = (v) => (ADV.test(str(v)) ? str(v) : '');
export const creativeIdOf = (v) => (CRE.test(str(v)) ? str(v) : '');
const ccOf = (v) => (CC.test(str(v).toUpperCase()) ? str(v).toUpperCase() : '');
/** The ids in a Transparency Center link: { advertiserId, creativeId } (either can be ''). */
export function idsOfUrl(u) {
  const m = /\/advertiser\/(AR\d{5,30})(?:\/creative\/(CR\d{5,30}))?/.exec(str(u));
  return { advertiserId: m ? m[1] : '', creativeId: m && m[2] ? m[2] : '' };
}
// The board only links to links made here, from ids that passed the checks above: never to a URL out of an answer.
const regionQs = (region) => (ccOf(region) ? `?region=${ccOf(region)}` : '');
export const advertiserUrl = (id, region = '') => (advertiserIdOf(id) ? `${TRANSPARENCY}/advertiser/${id}${regionQs(region)}` : '');
export const creativeUrl = (adv, cre, region = '') => (advertiserIdOf(adv) && creativeIdOf(cre) ? `${TRANSPARENCY}/advertiser/${adv}/creative/${cre}${regionQs(region)}` : '');
export const domainUrl = (domain) => (domainOf(domain) ? `${TRANSPARENCY}/?domain=${encodeURIComponent(domainOf(domain))}` : '');

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
/** A shop's name as the board keys stores: 'store.com' from 'https://www.Store.com/x', 'store.com/products/y' or 'store.com'. */
export function domainOf(v) {
  let s = str(v, 500).toLowerCase();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = 'https://' + s;
  const host = hostOf(s);
  const key = host ? hostKey(host) : '';
  return DOMAIN.test(key) ? key : '';
}

/**
 * Where an ad sends people, from a variation's destinationUrl. Google often gives only the shown domain
 * ('shop.store.com'), sometimes a path. { domain, url, key }: key is the board's product key
 * ('store.com/products/handle', lib/bestsellers.mjs productKey) when the path names a product page, else ''.
 */
export function destinationOf(v) {
  const raw = str(v, 1000);
  const domain = domainOf(raw);
  if (!domain) return null;
  const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw.replace(/^\/+/, '');
  return { domain, url: https(url) || `https://${domain}/`, key: productKey(url) };
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------
/** Impressions as a range from { min, max } or { lower, upper }: { lower, upper } (upper null: open-ended), or null. */
export function boundsOf(o) {
  if (!o || typeof o !== 'object') return null;
  const lower = int(o.lower ?? o.min ?? o.lowerBound ?? o.lower_bound);
  const upper = int(o.upper ?? o.max ?? o.upperBound ?? o.upper_bound);
  if (lower == null && upper == null) return null;
  return { lower: lower ?? 0, upper: upper != null && upper >= (lower ?? 0) ? upper : null };
}
const FORMATS = new Set(['text', 'image', 'video']);
const formatOf = (v) => (FORMATS.has(str(v).toLowerCase()) ? str(v).toLowerCase() : '');

/** GET /v1/google/adLibrary/advertisers/search → { advertisers: [{ id, name, region, estimate }], domains }. */
export function parseAdvertiserSearch(j) {
  const list = j && Array.isArray(j.advertisers) ? j.advertisers : [];
  const seen = new Set();
  const advertisers = [];
  for (const a of list) {
    const id = a && typeof a === 'object' ? advertiserIdOf(a.advertiser_id ?? a.advertiserId ?? a.id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    advertisers.push({ id, name: str(a.name ?? a.advertiser_name ?? a.advertiserName, 200), region: ccOf(a.region), estimate: int(a.number_of_ads_estimate ?? a.numberOfAdsEstimate) });
  }
  const sites = j && Array.isArray(j.websites) ? j.websites : [];
  return { advertisers, domains: uniq(sites.map((w) => domainOf(w && typeof w === 'object' ? w.domain ?? w.website : w))) };
}

/** One ad of a company's list: { advertiserId, creativeId, advertiser, format, image, firstShown, lastShown } or null. */
export function adOfList(a) {
  if (!a || typeof a !== 'object') return null;
  const fromUrl = idsOfUrl(a.adUrl ?? a.ad_url ?? a.url);
  const creativeId = creativeIdOf(a.creativeId ?? a.creative_id) || fromUrl.creativeId;
  const advertiserId = advertiserIdOf(a.advertiserId ?? a.advertiser_id) || fromUrl.advertiserId;
  if (!creativeId || !advertiserId) return null;
  return { advertiserId, creativeId, advertiser: str(a.advertiserName ?? a.advertiser_name, 200), format: formatOf(a.format), image: https(a.imageUrl ?? a.image_url),
    firstShown: timeOf(a.firstShown ?? a.first_shown), lastShown: timeOf(a.lastShown ?? a.last_shown) };
}

/** GET /v1/google/company/ads → { ads, cursor (null: last page), estimate (Google's number_of_ads_estimate, null when not given) }. */
export function parseCompanyAds(j) {
  const list = j && Array.isArray(j.ads) ? j.ads : [];
  const seen = new Set();
  const ads = [];
  for (const raw of list) {
    const a = adOfList(raw);
    if (!a || seen.has(a.creativeId)) continue;
    seen.add(a.creativeId);
    ads.push(a);
  }
  const cursor = str(j && j.cursor, 2000);
  return { ads, cursor: cursor || null, estimate: int(j && (j.number_of_ads_estimate ?? j.numberOfAdsEstimate)) };
}

/**
 * GET /v1/google/ad → { advertiserId, creativeId, format, firstShown, lastShown, impressions, regions, regionStats,
 * variations: [{ destination, headline, description, text, image }], cached } or null. Spend and targeting (political
 * ads only) are left out: no rule uses them.
 */
export function parseAdDetails(j) {
  if (!j || typeof j !== 'object') return null;
  const fromUrl = idsOfUrl(j.url ?? j.adUrl);
  const creativeId = creativeIdOf(j.creativeId ?? j.creative_id) || fromUrl.creativeId;
  const advertiserId = advertiserIdOf(j.advertiserId ?? j.advertiser_id) || fromUrl.advertiserId;
  if (!creativeId || !advertiserId) return null;
  const regionStats = (Array.isArray(j.regionStats) ? j.regionStats : []).map((r) => (r && typeof r === 'object' && ccOf(r.regionCode ?? r.region_code) ? {
    cc: ccOf(r.regionCode ?? r.region_code), firstShown: timeOf(r.firstShown), lastShown: timeOf(r.lastShown), impressions: boundsOf(r.impressions),
    platforms: (Array.isArray(r.platformImpressions) ? r.platformImpressions : []).map((p) => (p && typeof p === 'object' ? { platform: str(p.platform ?? p.name, 40), impressions: boundsOf(p.impressions ?? p) } : null)).filter((p) => p && p.platform),
  } : null)).filter(Boolean);
  const regions = uniq([...(Array.isArray(j.creativeRegions) ? j.creativeRegions : []).map((r) => ccOf(r && typeof r === 'object' ? r.regionCode ?? r.region_code : r)), ...regionStats.map((r) => r.cc)]);
  const variations = (Array.isArray(j.variations) ? j.variations : []).map((v) => (v && typeof v === 'object' ? {
    destination: destinationOf(v.destinationUrl ?? v.destination_url ?? v.displayUrl), headline: str(v.headline, 300), description: str(v.description, 600), text: str(v.allText ?? v.all_text, 1500),
    image: https(v.imageUrl ?? v.image_url) || https(Array.isArray(v.images) ? v.images[0] : ''),
  } : null)).filter(Boolean);
  return { advertiserId, creativeId, format: formatOf(j.format), firstShown: timeOf(j.firstShown ?? j.first_shown), lastShown: timeOf(j.lastShown ?? j.last_shown),
    impressions: boundsOf(j.overallImpressions ?? j.overall_impressions), regions, regionStats, variations, cached: j.cached === true };
}

/** Impressions in the EU: the sum of the EU countries' ranges (Google publishes them per country), or null when it gave none. */
export function euImpressions(regionStats) {
  const eu = (regionStats || []).filter((r) => EU_CODES.includes(r.cc) && r.impressions);
  if (!eu.length) return null;
  const lower = eu.reduce((s, r) => s + r.impressions.lower, 0);
  const upper = eu.every((r) => r.impressions.upper != null) ? eu.reduce((s, r) => s + r.impressions.upper, 0) : null;
  return { lower, upper, regions: eu.map((r) => r.cc) };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------
/** stop: the run should end (the key, no credits, the cap). kind: key | credits | cap | bad | blocked | server | network | format. */
export class GoogleApiError extends Error {
  constructor(message, { status = 0, kind = 'server', stop = false } = {}) {
    super(message);
    Object.assign(this, { status, kind, stop });
  }
}

/**
 * The Scrape Creators client for Google's ad library. cap: the most credits this run may spend; a call that could pass it
 * is never sent (GoogleApiError kind 'cap'). Each answer says what it cost (credits_charged): that is counted; an answer
 * that does not say counts its listed price, so the cap holds. 401 (key) and 402 (no credits) stop the run, a 404 is
 * nothing found (null), 429 and 5xx are asked again twice. The key never appears in an error or a log.
 */
export function googleClient({ key, fetch: doFetch = globalThis.fetch, cap = 0, base = API, sleep = wait, tries = 3, timeout = 60000 } = {}) {
  const k = String(key || '').trim();
  if (!k) throw new GoogleApiError(`No API key: add the GitHub secret ${SECRET}`, { kind: 'key', stop: true });
  const limit = Math.max(0, Math.floor(Number(cap) || 0));
  const t = { spent: 0, cap: limit, remaining: null, calls: 0, cached: 0, failed: 0, by: { search: 0, ads: 0, ad: 0 } };
  let held = 0; // credits of calls on their way: calls at the same moment can never pass the cap together
  const hide = (s) => String(s ?? '').split(k).join('***');

  async function call(kind, params) {
    const cost = COST[kind];
    const u = new URL(PATHS[kind], base);
    for (const [name, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(name, String(v));
    for (let attempt = 1; ; attempt++) {
      if (t.spent + held + cost > t.cap) throw new GoogleApiError(`Credit cap reached: ${t.spent} of ${t.cap} credits spent`, { kind: 'cap', stop: true });
      held += cost;
      let res;
      let body = null;
      try {
        res = await doFetch(u.toString(), { headers: { 'x-api-key': k, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
        const text = await res.text();
        try {
          body = JSON.parse(text);
        } catch (e) {
          body = null;
        }
      } catch (e) {
        held -= cost;
        if (attempt < tries) {
          await sleep(2000 * attempt);
          continue;
        }
        t.failed++;
        throw new GoogleApiError(`Scrape Creators unreachable (${hide(e.message || e.name)})`, { kind: 'network' });
      }
      held -= cost;
      t.calls++;
      const said = body && typeof body === 'object' ? int(body.credits_charged) : null;
      const charged = said != null ? said : res.status === 401 || res.status === 402 || res.status === 404 ? 0 : cost;
      t.spent += charged;
      t.by[kind] += charged;
      if (body && int(body.credits_remaining) != null) t.remaining = int(body.credits_remaining);
      const why = hide(body && typeof body === 'object' ? str(body.message ?? body.error, 200) : '');
      if (res.status === 401) throw new GoogleApiError(`Scrape Creators refused the API key (401): check the GitHub secret ${SECRET}`, { status: 401, kind: 'key', stop: true });
      if (res.status === 402) throw new GoogleApiError('Scrape Creators: no credits left (402): buy credits at app.scrapecreators.com', { status: 402, kind: 'credits', stop: true });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < tries) {
          await sleep(3000 * attempt);
          continue;
        }
        t.failed++;
        throw new GoogleApiError(`Scrape Creators HTTP ${res.status}${why ? ': ' + why : ''}`, { status: res.status, kind: 'server' });
      }
      if (res.status === 404) return null;
      if (!res.ok) {
        t.failed++;
        throw new GoogleApiError(`Scrape Creators HTTP ${res.status}${why ? ': ' + why : ''}`, { status: res.status, kind: res.status === 403 ? 'blocked' : 'bad' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        t.failed++;
        throw new GoogleApiError('Scrape Creators: an answer that is not JSON', { status: res.status, kind: 'format' });
      }
      if (body.success === false) return null; // answered, nothing to read (counted, as the vendor charges these)
      if (body.cached === true) t.cached++;
      return body;
    }
  }

  return {
    stats: () => ({ ...t, by: { ...t.by } }),
    /** Advertisers whose name matches, and websites that match (Google's own search box). region: 2 letters, default US. */
    async searchAdvertisers(query, region = '') {
      const q = str(query, 100);
      if (!q) return { advertisers: [], domains: [] };
      const j = await call('search', { query: q, region: ccOf(region) });
      return j ? parseAdvertiserSearch(j) : { advertisers: [], domains: [] };
    },
    /**
     * One page of a company's ads, by domain or advertiser id. startDate / endDate (YYYY-MM-DD): ads shown in those days.
     * region: 2 letters (default anywhere). platform: google_search | google_shopping | youtube | google_maps | google_play.
     */
    async companyAds({ domain = '', advertiserId = '', region = '', startDate = '', endDate = '', platform = '', format = '', cursor = '' } = {}) {
      const d = domainOf(domain);
      const a = advertiserIdOf(advertiserId);
      if (!d && !a) throw new GoogleApiError('companyAds needs a domain or an advertiser id', { kind: 'bad' });
      const j = await call('ads', { domain: a ? '' : d, advertiser_id: a, topic: 'all', region: ccOf(region), start_date: startDate, end_date: endDate,
        platform: /^(google_search|google_shopping|youtube|google_maps|google_play)$/.test(platform) ? platform : '', format: formatOf(format), cursor: str(cursor, 2000) });
      return j ? parseCompanyAds(j) : { ads: [], cursor: null, estimate: null };
    },
    /** One ad's details. cacheMaxAge: the vendor's cached copy when it is this young costs nothing ('1d' … '30d'). */
    async adDetails(url, { cacheMaxAge = '7d' } = {}) {
      const { advertiserId, creativeId } = idsOfUrl(url);
      if (!advertiserId || !creativeId) throw new GoogleApiError('adDetails needs a Transparency Center creative link', { kind: 'bad' });
      const j = await call('ad', { url: creativeUrl(advertiserId, creativeId), cache_max_age: /^(1|3|7|14|30)d$/.test(cacheMaxAge) ? cacheMaxAge : '' });
      return j ? parseAdDetails(j) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// The rules on Google's data
// ---------------------------------------------------------------------------
export const RULE_LABELS = { shopify: 'Shopify store', ads: 'Advertiser 75+ ads', age: 'Ad live 7–42 days', reach: '500+ EU reach a day' };
// How a rule was checked: 'exact' (the same rule on the same kind of fact as on Meta), 'approx' (the closest fact Google
// gives, said in the text) or 'none' (not checked: Google gives nothing to check it with).
export const HOW = ['exact', 'approx', 'none'];
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Our four rules on what Google says about one ad and its shop. facts:
 *   store  { key: 'store.com', shopify: 1 | 0 | null (no answer), host, myshopify }
 *   ads    { estimate: Google's estimate of the advertiser's ads shown in the last windowDays days | null, windowDays,
 *            listed: ads of the advertiser seen on the pages read, complete: every page was read }
 *   ad     { firstShown, lastShown } (ms)
 *   impressions { eu: { lower, upper, regions } | null, all: { lower, upper } | null }
 * items: [{ key, label, state: 'ok' | 'bad' | 'unknown' | 'pending', how: 'exact' | 'approx' | 'none', text }].
 * verdict: 'winner' (all four pass, exactly or approximately), 'partial' (none fails, reach unknown: Google published no
 * figure), 'pending' (the shop, the advertiser's count or the dates are not known yet: not saved, asked again) or 'skip'.
 * A rule that was not checked is 'unknown', never a pass.
 */
export function googleRules(facts, { now = Date.now(), runningDays = RUNNING_DAYS } = {}) {
  const f = facts || {};
  const items = [];
  const put = (key, state, how, text) => items.push({ key, label: RULE_LABELS[key], state, how, text });

  // 1. Shopify store: the same check as on Meta (lib/world.mjs checkStore: the shop's meta.json, Shopify's headers).
  const st = f.store || null;
  if (!st || !st.key) put('shopify', 'bad', 'exact', 'No shop website in this ad');
  else if (NON_STORE.test(st.key)) put('shopify', 'bad', 'exact', `${st.key} is a marketplace or big brand`);
  else if (st.shopify === 1 || st.shopify === true) put('shopify', 'ok', 'exact', st.myshopify || `${st.host || st.key} runs on Shopify`);
  else if (st.shopify === 0 || st.shopify === false) put('shopify', 'bad', 'exact', `${st.key} is not a Shopify store`);
  else put('shopify', 'pending', 'exact', `${st.key} did not answer: asked again next run`);

  // 2. Advertiser 75+ ads: Meta counts active ads; Google gives an estimate of the ads shown in a date window.
  const a = f.ads || {};
  const win = a.windowDays || runningDays;
  const est = int(a.estimate);
  const listed = int(a.listed) || 0;
  if (est != null && est >= MIN_ACTIVE_ADS) put('ads', 'ok', 'approx', `~${fmtCompact(est)} ads shown in the last ${win} days (Google's estimate, not a count of active ads)`);
  else if (est != null && listed < MIN_ACTIVE_ADS) put('ads', 'bad', 'approx', `~${fmtCompact(est)} ads shown in the last ${win} days (needs ${MIN_ACTIVE_ADS}+; Google's estimate)`);
  else if (listed >= MIN_ACTIVE_ADS) put('ads', 'ok', 'approx', `${listed}+ ads shown in the last ${win} days (counted on the pages read)`);
  else if (a.complete) put('ads', 'bad', 'approx', `${plural(listed, 'ad')} shown in the last ${win} days (needs ${MIN_ACTIVE_ADS}+)`);
  else put('ads', 'unknown', 'none', 'Google gave no count of this advertiser\'s ads');

  // 3. Ad live 7–42 days: Google's first-shown date, as Meta's start date; still running = shown in the last days.
  const ad = f.ad || {};
  const first = timeOf(ad.firstShown);
  const last = timeOf(ad.lastShown);
  let days = null;
  if (first == null) put('age', 'unknown', 'none', 'Google gave no first-shown date');
  else {
    days = Math.max(0, Math.floor((now - first) / DAY));
    const since = last == null ? null : Math.max(0, Math.floor((now - last) / DAY));
    const shown = `first shown ${isoDay(first)}${last != null ? `, last shown ${isoDay(last)}` : ''}`;
    if (since != null && since >= runningDays) put('age', 'bad', 'exact', `Stopped: last shown ${plural(since, 'day')} ago (${shown})`);
    else if (days < MIN_AGE_DAYS) put('age', 'bad', 'exact', `Live ${plural(days, 'day')} (needs ${MIN_AGE_DAYS}+; ${shown})`);
    else if (days > MAX_AGE_DAYS) put('age', 'bad', 'exact', `Live ${plural(days, 'day')} (max 6 weeks; ${shown})`);
    else put('age', 'ok', 'exact', `Live ${plural(days, 'day')} (${shown})`);
  }

  // 4. 500+ EU reach a day: Google publishes no reach. Where it publishes impression ranges (per EU country, else in total),
  // the range per day of ad life is checked: impressions count showings, not people, so this is looser than Meta's rule.
  const imp = f.impressions || {};
  const range = imp.eu ? { b: imp.eu, scope: 'EU' } : imp.all ? { b: imp.all, scope: 'total (not only EU)' } : null;
  let perDay = null;
  if (!range) put('reach', 'unknown', 'none', 'Google publishes no reach or impressions for this ad: not checked');
  else {
    const d = Math.max(days ?? 0, 1);
    perDay = { lower: range.b.lower / d, upper: range.b.upper == null ? null : range.b.upper / d, scope: range.scope };
    const span = `Google's range ${fmtCompact(range.b.lower)}–${range.b.upper == null ? '?' : fmtCompact(range.b.upper)} over ${plural(d, 'day')}; impressions, not people`;
    if (perDay.lower >= MIN_REACH_PER_DAY) put('reach', 'ok', 'approx', `${fmtCompact(Math.floor(perDay.lower))}+ ${range.scope} impressions a day (${span})`);
    else if (perDay.upper != null && perDay.upper < MIN_REACH_PER_DAY) put('reach', 'bad', 'approx', `At most ${fmtCompact(Math.floor(perDay.upper))} ${range.scope} impressions a day (needs ${MIN_REACH_PER_DAY}+; ${span})`);
    else put('reach', 'unknown', 'approx', `${fmtCompact(Math.floor(perDay.lower))} to ${perDay.upper == null ? '?' : fmtCompact(Math.floor(perDay.upper))} ${range.scope} impressions a day: the range is too wide to tell (${span})`);
  }

  const bad = items.find((i) => i.state === 'bad');
  const open = items.some((i) => i.state === 'pending' || (i.state === 'unknown' && i.key !== 'reach'));
  const verdict = bad ? 'skip' : open ? 'pending' : items.some((i) => i.state === 'unknown') ? 'partial' : 'winner';
  return { verdict, skip: bad ? bad.text : null, items, days, perDay };
}

/** How many rules were checked how: { exact, approx, unknown } (unknown: not checked, or a range too wide to tell). */
export const howMany = (items) => ({
  exact: (items || []).filter((i) => i.how === 'exact' && i.state !== 'unknown').length,
  approx: (items || []).filter((i) => i.how === 'approx' && i.state !== 'unknown').length,
  unknown: (items || []).filter((i) => i.state === 'unknown').length,
});

// ---------------------------------------------------------------------------
// Ads → products: one card per product page
// ---------------------------------------------------------------------------
const VERDICT_RANK = { winner: 3, partial: 2, pending: 1, skip: 0 };
/**
 * The best ad of one product: the best verdict, then the most impressions a day, then the oldest. ads: [{ ev, ad }]
 * (ev: googleRules's answer).
 */
export function bestOf(ads) {
  return [...(ads || [])].sort((x, y) => (VERDICT_RANK[y.ev.verdict] ?? 0) - (VERDICT_RANK[x.ev.verdict] ?? 0)
    || ((y.ev.perDay && y.ev.perDay.lower) || 0) - ((x.ev.perDay && x.ev.perDay.lower) || 0)
    || (x.ad.firstShown ?? Infinity) - (y.ad.firstShown ?? Infinity) || (x.ad.creativeId < y.ad.creativeId ? -1 : 1))[0] || null;
}

/**
 * Ads grouped by the product page they sell, the board's own key (lib/bestsellers.mjs productKey: store domain without
 * www, handle, no locale or query): Map key → [ad]. keyOf: an ad's key ('' or null: no product page, left out).
 */
export function byProduct(ads, keyOf = (a) => a && a.productKey) {
  const out = new Map();
  for (const a of ads || []) {
    const k = a ? keyOf(a) : '';
    if (!k) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(a);
  }
  return out;
}
