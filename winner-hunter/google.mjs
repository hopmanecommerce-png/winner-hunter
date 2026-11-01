#!/usr/bin/env node
/*
 * The Google hunt: products that Shopify stores advertise on Google (Search, Shopping, YouTube, Display), from Google's ad
 * library (the Ads Transparency Center) through the Scrape Creators API, checked with the board's rules wherever Google's
 * data allows it (lib/google-ads.mjs googleRules; field by field in docs/google-ads/README.md). Off by default: it runs when
 * started by hand, or on its schedule once the repository variable GOOGLE_HUNT is 'on' (google-hunter.yml).
 *   SCRAPECREATORS_API_KEY=… CF_API_TOKEN=… CF_ACCOUNT_ID=… [GOOGLE_CREDITS=300] [GOOGLE_DRY_RUN=1] node winner-hunter/google.mjs
 *   node winner-hunter/google.mjs --fixtures     SAMPLE DATA (test/fixtures/google): no key, no credits, nothing saved
 *
 * Where it looks, in this order: typed domains or advertiser ids (GOOGLE_DOMAINS); shops already on the Meta and TikTok tabs
 * (GOOGLE_BOARD_DOMAINS a run: a shop on two ad networks is the strongest signal); then the next keywords of keywords.txt
 * (cursor: D1 state 'google_cursor'), each through Google's advertiser search in every GOOGLE_REGIONS region, which gives
 * advertisers and shop domains. Google cannot search ad text: a keyword finds advertiser names and shop domains only.
 * Per advertiser or domain: its ads shown in the last 3 days (1 credit a page, at most GOOGLE_PAGES pages; Google's estimate
 * of how many is the "75+ ads" rule), then the details of up to GOOGLE_DETAILS ads in the 7–42-day window (1 credit each;
 * free from the vendor's cache within a week, and never paid for twice in a week here). Then the same store checks as the
 * Meta hunts, all free: Shopify (meta.json), the product page (the ad's own link, else the store's search with the ad's
 * headline), its price, photo and type, and the EU board's category screen (lib/world.mjs screenEU). One row per product
 * page in D1 table google_products; only products that fail no rule (reach may be unknown) are saved.
 *
 * Credits: GOOGLE_CREDITS is a hard cap; a call that could pass it is never sent. An advertiser or domain looked at is not
 * looked at again for 3 days, and a stopped run goes on where it stopped next time (the cursor only moves past keywords
 * whose advertisers were all looked at). GOOGLE_DRY_RUN=1: everything but the D1 writes, the products printed instead.
 * The run's status is in D1 state 'google_run' (the board's Google tab shows it). Red: the key refused, no credits left,
 * every request failed, or D1 refused the products.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings, chunks } from './lib/d1.mjs';
import { pool } from './lib/meta.mjs';
import { wrap } from './lib/keywords.mjs';
import { keywordsOf } from './run.mjs';
import { DAY, NON_STORE, MIN_ACTIVE_ADS, MIN_AGE_DAYS, MAX_AGE_DAYS, fmtCompact } from './lib/score.mjs';
import { checkStore, fetchProduct, suggestProduct, screenEU } from './lib/world.mjs';
import { googleClient, googleRules, euImpressions, creativeUrl, advertiserUrl, advertiserIdOf, domainOf, byProduct, bestOf, howMany, timeOf, RUNNING_DAYS, SECRET } from './lib/google-ads.mjs';

export const RECHECK_DAYS = 3; // an advertiser or domain looked at is not looked at (or paid for) again for this long
export const DETAILS_DAYS = 7; // an ad's details are kept this long (the vendor's own cache is asked for one this young too)
const STORE_DAYS = 14; // a store's Shopify check
const KEEP_DAYS = 60; // rows nobody decided on and not seen for this long go
export const MAX_CREDITS = 5000; // a GOOGLE_CREDITS above this is a typo
export const MAX_MINUTES = 120;
export const DEFAULTS = { credits: 300, minutes: 60, regions: ['NL', 'DE', 'FR'], details: 4, pages: 2, boardDomains: 10 };
const FORMAT_RANK = { image: 0, video: 1, text: 2 };

const num = (k) => `json_extract(value, '$.${k}')`;
export const PRODUCT_COLS = ['product_key', 'ad_id', 'active', 'verdict', 'rules', 'product_title', 'price', 'compare_at_price', 'currency', 'image_url', 'product_type', 'store_url',
  'product_url', 'advertiser', 'advertiser_id', 'creative_id', 'region', 'ads_estimate', 'ads_window', 'first_shown', 'last_shown', 'days', 'regions', 'formats', 'copies',
  'impr_lower', 'impr_upper', 'impr_scope', 'store_products', 'keyword', 'via', 'first_seen', 'last_seen', 'run_id'];
// A row a newer run wrote is never overwritten (run ids are start times); ad_id and first_seen never change, so your
// decisions stay with the product.
export const PRODUCTS_SQL = `INSERT INTO google_products (${PRODUCT_COLS.join(', ')})
SELECT ${PRODUCT_COLS.map(num).join(', ')} FROM json_each(?1) WHERE true
ON CONFLICT(product_key) DO UPDATE SET ${PRODUCT_COLS.filter((c) => !['product_key', 'ad_id', 'first_seen'].includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')}
  WHERE excluded.run_id >= COALESCE(google_products.run_id, '')`;
// A saved product checked again that now fails a rule leaves the board: update only, a product that fails is never added.
export const RECHECK_SQL = `UPDATE google_products SET active = 0, verdict = json_extract(x.value, '$.verdict'), rules = json_extract(x.value, '$.rules'), last_seen = ?2, run_id = ?3
FROM json_each(?1) AS x WHERE google_products.product_key = json_extract(x.value, '$.product_key') AND ?3 >= COALESCE(google_products.run_id, '')
RETURNING google_products.product_key`;
const AD_COLS = ['creative_id', 'advertiser_id', 'advertiser', 'format', 'first_shown', 'last_shown', 'domain', 'product_key', 'headline', 'image_url', 'regions', 'impr_lower', 'impr_upper',
  'eu_lower', 'eu_upper', 'details_at'];
export const ADS_SQL = `INSERT INTO google_ads (${AD_COLS.join(', ')}, seen_at) SELECT ${AD_COLS.map(num).join(', ')}, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(creative_id) DO UPDATE SET ${AD_COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}, seen_at = excluded.seen_at`;
export const TARGETS_SQL = `INSERT INTO google_targets (target, name, estimate, result, checked_at) SELECT ${['target', 'name', 'estimate', 'result'].map(num).join(', ')}, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(target) DO UPDATE SET name = excluded.name, estimate = excluded.estimate, result = excluded.result, checked_at = excluded.checked_at`;
export const STORES_SQL = `INSERT INTO google_stores (store, shopify, host, currency, products, myshopify, checked_at)
SELECT ${['store', 'shopify', 'host', 'currency', 'products', 'myshopify'].map(num).join(', ')}, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(store) DO UPDATE SET shopify = excluded.shopify, host = excluded.host, currency = excluded.currency, products = excluded.products, myshopify = excluded.myshopify, checked_at = excluded.checked_at`;
// Shops already on the board's other tabs: the EU Meta board (seen in the last 60 days), outside the EU (Meta) and the
// TikTok tab's Meta matches. [sql, takes the date]: D1 refuses a bound value a query does not use.
export const BOARD_SQL = [
  ["SELECT DISTINCT store_url AS u FROM winners WHERE last_seen >= ?1 AND COALESCE(store_url, '') != ''", true],
  ["SELECT DISTINCT store_url AS u FROM world_products WHERE active = 1 AND COALESCE(store_url, '') != ''", false],
  ["SELECT DISTINCT ads_domain AS u FROM tiktok_products WHERE COALESCE(ads_domain, '') != ''", false],
];

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
/** A rule's mark: ✓ exact, ≈ approximately, ? not checked, ✗ failed, … waiting for an answer. */
export const mark = (i) => (i.state === 'bad' ? '✗' : i.state === 'pending' ? '…' : i.state === 'unknown' ? '?' : i.how === 'exact' ? '✓' : '≈');

/** GOOGLE_CREDITS as the run's hard cap: DEFAULTS.credits when empty, at least 1, at most MAX_CREDITS. */
export const creditsOf = (v) => (String(v ?? '').trim() === '' ? DEFAULTS.credits : Math.min(Math.max(Math.floor(Number(v)) || 0, 1), MAX_CREDITS));
export const minutesOf = (v) => Math.min(Math.max(Number(v) || DEFAULTS.minutes, 1), MAX_MINUTES);
/** "store.com | AR123… | other.com" → [{ kind: 'domain' | 'adv', value }]; anything else is left out. */
export function targetsOf(text) {
  const out = [];
  for (const raw of String(text || '').split(/[|,\s]+/)) {
    const adv = advertiserIdOf(raw.trim());
    const d = adv ? '' : domainOf(raw);
    if (adv) out.push({ kind: 'adv', value: adv });
    else if (d && !NON_STORE.test(d)) out.push({ kind: 'domain', value: d });
  }
  return out;
}
export const regionsOf = (v) => {
  const list = String(v || '').toUpperCase().split(/[,\s|]+/).filter((x) => /^[A-Z]{2}$/.test(x));
  return list.length ? [...new Set(list)] : DEFAULTS.regions;
};

/**
 * One run. deps: { api (googleClient), db (lib/d1.mjs client, or null: nothing read or saved), doFetch (the stores), keywords,
 * typed (keywords typed in: the cursor stays), targets ([{ kind, value }] typed in), regions, now, log, deadline (ms), dryRun,
 * sample (the data is SAMPLE DATA), details, pages, boardDomains, shopOpts, atOnce }.
 * Returns the run's totals: { …, products: [rows built], health ('ok' | 'warning' | 'failed'), stopped, alert }.
 */
export async function hunt(opts) {
  const t = {};
  try {
    return await night(opts, t);
  } catch (e) {
    // Never left at "running": the board shows the failure and the workflow ends red.
    const { db, dryRun, now = Date.now, log = console.log } = opts;
    const when = new Date(now()).toISOString();
    Object.assign(t, { status: 'failed', health: 'failed', alert: `Google-hunt gestopt / Google hunt stopped: ${e.message}`.slice(0, 300), finished_at: when, updated_at: when });
    if (db && !dryRun) await db.setState('google_run', publicRun(t), new Date(now())).catch((x) => log(`::warning::Could not mark the Google hunt failed: ${x.message}`));
    throw e;
  }
}

/** The run as the board keeps it (state 'google_run'): the totals, not the products. */
const publicRun = (t) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'rows'));

async function night({ api, db = null, doFetch = globalThis.fetch, keywords = [], typed = null, targets: given = [], regions = DEFAULTS.regions, now = Date.now, log = console.log,
  deadline = Infinity, dryRun = false, sample = false, details = DEFAULTS.details, pages = DEFAULTS.pages, boardDomains = DEFAULTS.boardDomains, shopOpts = {}, atOnce = 3 }, t) {
  const started = now();
  const startIso = new Date(started).toISOString();
  const write = !!db && !dryRun;
  Object.assign(t, { id: startIso, started_at: startIso, status: 'running', dry_run: !write, sample: !!sample, regions, cursor: null, keywords: 0, searches: 0, targets: 0,
    pages: 0, details: 0, cached: 0, gated: 0, few_ads: 0, no_window: 0, stores: 0, shopify: 0, not_shopify: 0, no_product: 0, restricted: 0, pending: 0, undecided: 0, products: 0,
    winners: 0, partial: 0, saved: 0, rechecked: 0, retired: 0, skipped_recent: 0, failed_calls: 0, stopped: 'done', error: '', health: null, alert: '', credits: api.stats() });
  const warnings = [];
  const warn = (m) => {
    warnings.push(String(m).slice(0, 200));
    log(`::warning::${m}`);
  };
  const progress = async () => {
    t.updated_at = new Date(now()).toISOString();
    t.credits = api.stats();
    if (write) await db.setState('google_run', publicRun(t), new Date(now()));
  };
  await progress();

  // ---- what D1 knows: looked at lately, ads already paid for, stores, products (their ad_id never changes) ----
  // A table that is not there yet (a dry run before the first migration): nothing known.
  const read = async (sql, args = []) => (db ? db.query(sql, args).catch((e) => {
    if (/no such table/i.test(e.message)) return [];
    throw e;
  }) : []);
  const ago = (days) => new Date(started - days * DAY).toISOString();
  const lately = new Set((await read('SELECT target FROM google_targets WHERE checked_at >= ?1', [ago(RECHECK_DAYS)])).map((r) => r.target));
  const paid = new Map((await read('SELECT * FROM google_ads WHERE details_at >= ?1', [ago(DETAILS_DAYS)])).map((r) => [r.creative_id, r]));
  const storeRows = new Map((await read('SELECT * FROM google_stores WHERE checked_at >= ?1', [ago(STORE_DAYS)])).map((r) => [r.store, r]));
  const known = new Map((await read('SELECT product_key, ad_id, first_seen, active FROM google_products')).map((r) => [r.product_key, r]));

  // ---- the queue: typed targets, shops on the other tabs, then the keywords ----
  const queued = new Set();
  const queue = [];
  const add = (x) => {
    const id = `${x.kind === 'adv' ? 'adv' : 'domain'}:${x.value}`;
    if (queued.has(id)) return false;
    queued.add(id);
    if (x.via !== 'typed' && lately.has(id)) {
      t.skipped_recent++;
      return false;
    }
    queue.push({ ...x, id });
    return true;
  };
  for (const x of given) add({ ...x, via: 'typed', keyword: '' });
  if (boardDomains > 0 && db) {
    let n = 0;
    for (const [sql, dated] of BOARD_SQL) {
      const rows = await read(sql, dated ? [ago(KEEP_DAYS)] : []).catch((e) => { // a table that is not there yet: no shops from it
        if (!/no such table/i.test(e.message)) warn(`Shops from the other tabs: ${e.message}`);
        return [];
      });
      for (const r of rows) {
        const d = domainOf(r.u);
        if (n >= boardDomains) break;
        if (d && !NON_STORE.test(d) && add({ kind: 'domain', value: d, via: 'board', keyword: '' })) n++;
      }
    }
  }

  // ---- stores and products, free (Shopify's open endpoints), once per run ----
  const shops = new Map();
  const newStores = [];
  const storeOf = (domain) => {
    if (!shops.has(domain)) {
      shops.set(domain, (async () => {
        const c = storeRows.get(domain);
        if (c) return { key: domain, shopify: Number(c.shopify), host: c.host || domain, currency: c.currency || '', products: c.products ?? null, myshopify: c.myshopify || '' };
        t.stores++;
        const s = await checkStore(domain, doFetch, shopOpts).catch(() => ({ shopify: null, host: domain }));
        if (s.shopify != null) newStores.push({ store: domain, shopify: s.shopify, host: s.host || domain, currency: s.currency || '', products: s.products ?? null, myshopify: s.myshopify || '' });
        if (s.shopify) t.shopify++;
        return { key: domain, ...s };
      })());
    }
    return shops.get(domain);
  };
  const items = new Map();
  const itemOf = (key, st) => {
    if (!items.has(key)) items.set(key, fetchProduct(key, { host: st.host || st.key, currency: st.currency || '' }, doFetch, shopOpts).catch(() => null));
    return items.get(key);
  };

  // ---- one advertiser or domain ----
  const day0 = isoDay(started - (RUNNING_DAYS - 1) * DAY);
  const day1 = isoDay(started);
  // creative id → what its ad came to (a promise). An ad is claimed before anything is awaited, so two advertisers or
  // domains looked at the same moment never pay for one ad twice.
  const claims = new Map();
  const touched = new Set(); // product keys found since the last save
  const doneTargets = [];
  const newAds = [];
  const lo = started - (MAX_AGE_DAYS + 1) * DAY; // first shown after this: 42 days or younger today
  const hi = started - MIN_AGE_DAYS * DAY; // … and before this: 7 days or older

  async function listOf(x) {
    const q = x.kind === 'adv' ? { advertiserId: x.value } : { domain: x.value };
    const ads = new Map();
    let estimate = null;
    let complete = false;
    let cursor = '';
    for (let p = 0; p < Math.max(1, pages); p++) {
      const page = await api.companyAds({ ...q, startDate: day0, endDate: day1, cursor });
      t.pages++;
      // No answer to read (a 404, or success false): unknown, not "no ads". A later page without one: the pages so far.
      if (!page) {
        if (p === 0) return { none: true };
        break;
      }
      if (p === 0) estimate = page.estimate;
      for (const a of page.ads) if (!ads.has(a.creativeId)) ads.set(a.creativeId, a);
      if (!page.cursor || !page.ads.length) {
        complete = true;
        break;
      }
      if (estimate != null && estimate < MIN_ACTIVE_ADS) break; // fails the 75+ rule anyway: no more pages
      cursor = page.cursor;
    }
    // Asked for ads shown in the last days; one Google says stopped before that does not count as running.
    const running = [...ads.values()].filter((a) => a.lastShown == null || started - a.lastShown < RUNNING_DAYS * DAY);
    return { ads: running, estimate, complete, listed: running.length };
  }

  async function detailsOf(a) {
    const row = paid.get(a.creativeId);
    if (row) {
      t.cached++;
      const parse = (s, or) => { try { return JSON.parse(s || '') ?? or; } catch (e) { return or; } };
      return { cachedRow: true, format: row.format || a.format, firstShown: timeOf(row.first_shown), lastShown: timeOf(row.last_shown), regions: parse(row.regions, []),
        impressions: row.impr_lower == null ? null : { lower: row.impr_lower, upper: row.impr_upper }, eu: row.eu_lower == null ? null : { lower: row.eu_lower, upper: row.eu_upper },
        domain: row.domain || '', key: row.product_key || '', headline: row.headline || '', image: row.image_url || '' };
    }
    const d = await api.adDetails(creativeUrl(a.advertiserId, a.creativeId), { cacheMaxAge: `${DETAILS_DAYS}d` });
    t.details++;
    if (!d) return null;
    const v = d.variations.find((x) => x.destination) || d.variations[0] || {};
    return { format: d.format || a.format, firstShown: d.firstShown, lastShown: d.lastShown, regions: d.regions, impressions: d.impressions, eu: euImpressions(d.regionStats),
      domain: v.destination ? v.destination.domain : '', key: v.destination ? v.destination.key : '', headline: v.headline || v.description || '', image: v.image || '' };
  }

  /** One ad → { key, ev, ad, item, st } (ev: the rules), or { off: why } when it is no product for the board. */
  async function adOf(a, x, counts) {
    const d = await detailsOf(a);
    if (!d) return { off: 'no details' };
    // The list's dates first: the vendor says a detail's firstShown can be empty where the list has it.
    const ad = { ...a, format: a.format || d.format, firstShown: a.firstShown ?? d.firstShown, lastShown: a.lastShown ?? d.lastShown, regions: d.regions || [], impressions: d.impressions,
      eu: d.eu, headline: d.headline, image: d.image || a.image, domain: d.domain || (x.kind === 'domain' ? x.value : '') };
    const keep = (product = '') => newAds.push({ creative_id: ad.creativeId, advertiser_id: ad.advertiserId, advertiser: ad.advertiser, format: ad.format, first_shown: iso(ad.firstShown),
      last_shown: iso(ad.lastShown), domain: ad.domain, product_key: product, headline: ad.headline, image_url: ad.image, regions: JSON.stringify(ad.regions),
      impr_lower: ad.impressions ? ad.impressions.lower : null, impr_upper: ad.impressions ? ad.impressions.upper : null, eu_lower: ad.eu ? ad.eu.lower : null, eu_upper: ad.eu ? ad.eu.upper : null,
      details_at: d.cachedRow ? (paid.get(ad.creativeId) || {}).details_at : new Date(now()).toISOString() });
    if (!ad.domain) {
      keep();
      return { off: 'no shop link' };
    }
    if (NON_STORE.test(ad.domain)) {
      keep();
      return { off: 'marketplace' };
    }
    const st = await storeOf(ad.domain);
    if (!st.shopify) {
      keep();
      if (st.shopify === 0) t.not_shopify++;
      return { off: st.shopify === 0 ? 'not shopify' : 'store did not answer', pending: st.shopify == null };
    }
    // The product page: the ad's own link, else the store's search with the ad's headline (only when it is about the same thing).
    let key = d.key && d.key.split('/')[0] === ad.domain ? d.key : '';
    if (!key && ad.headline) {
      const k = await suggestProduct(ad.headline, st.host || ad.domain, doFetch, ad.domain, shopOpts).catch(() => null);
      if (k == null) {
        keep();
        return { off: 'store did not answer', pending: true };
      }
      key = k;
    }
    if (!key) {
      t.no_product++;
      keep();
      return { off: 'no product page' };
    }
    keep(key);
    const item = await itemOf(key, st);
    if (!item) {
      t.no_product++;
      return { off: 'no product page' };
    }
    const off = screenEU([item.title, ad.headline].filter(Boolean).join('\n'), item.product_type).out;
    if (off) {
      t.restricted++;
      return { off };
    }
    const ev = googleRules({ store: st, ads: counts, ad, impressions: { eu: ad.eu, all: ad.impressions } }, { now: started });
    return { key, ev, ad, item, st, x, counts };
  }

  async function look(x) {
    t.targets++;
    let st = null;
    if (x.kind === 'domain') {
      st = await storeOf(x.value);
      if (!st.shopify) {
        if (st.shopify === 0) t.not_shopify++;
        else t.pending++;
        // Not Shopify: never looked at again within the week. No answer: asked again next run.
        if (st.shopify === 0) doneTargets.push({ target: x.id, name: x.value, estimate: null, result: 'not shopify' });
        return;
      }
    }
    const list = await listOf(x);
    if (list.none) {
      // Google's library had no answer for it (paid only when the vendor says so): not looked at again for 3 days.
      doneTargets.push({ target: x.id, name: x.name || x.value, estimate: null, result: 'no answer' });
      return;
    }
    const counts = { estimate: list.estimate, windowDays: RUNNING_DAYS, listed: list.listed, complete: list.complete };
    const name = (list.ads[0] && list.ads[0].advertiser) || x.name || x.value;
    // The 75+ rule as googleRules reads it: Google's estimate, else the ads counted when every page was read.
    const few = list.listed < MIN_ACTIVE_ADS && (list.estimate != null ? list.estimate < MIN_ACTIVE_ADS : list.complete);
    if (few || (list.estimate == null && !list.complete && list.listed < MIN_ACTIVE_ADS)) {
      if (few) t.few_ads++;
      doneTargets.push({ target: x.id, name, estimate: list.estimate, result: few ? 'fewer than 75 ads' : 'ads not counted' });
      return;
    }
    // Ads in the 7–42-day window: Shopping and display first (they show one product), then the oldest (the most proven).
    const inWindow = (a) => a.firstShown == null || (a.firstShown > lo && a.firstShown <= hi);
    const mine = list.ads.filter((a) => !claims.has(a.creativeId));
    const dated = mine.filter((a) => a.firstShown != null && inWindow(a));
    const undated = mine.filter((a) => a.firstShown == null);
    const pick = [...dated.sort((p, q) => (FORMAT_RANK[p.format] ?? 3) - (FORMAT_RANK[q.format] ?? 3) || p.firstShown - q.firstShown), ...undated].slice(0, Math.max(1, details));
    for (const a of pick) claims.set(a.creativeId, adOf(a, x, counts).catch((e) => ({ off: 'failed', error: e })));
    const theirs = list.ads.filter((a) => claims.has(a.creativeId) && !pick.includes(a) && inWindow(a));
    if (!pick.length && !theirs.length) {
      t.no_window++;
      doneTargets.push({ target: x.id, name, estimate: list.estimate, result: 'no ad 7–42 days old' });
      return;
    }
    const got = await Promise.all([...pick, ...theirs].map((a) => claims.get(a.creativeId)));
    // What its other ads found is kept whatever happened to one of them.
    for (const r of got) if (r.key) touched.add(r.key);
    const stopper = got.find((r) => r.error && r.error.stop);
    if (stopper) throw stopper.error; // the key, the credits, the cap or an outage: the run stops (after saving what it has)
    const broken = got.filter((r) => r.error);
    if (broken.length) {
      // One ad whose details failed (asked again next run): this advertiser is looked at again, the others go on.
      t.failed_calls += broken.length;
      warn(`${x.kind === 'adv' ? 'Advertiser' : 'Domain'} ${x.value}: ${broken.length} ad(s) not read (${broken[0].error.message}): asked again next run`);
      return;
    }
    if (got.some((r) => r.pending)) t.pending++;
    else doneTargets.push({ target: x.id, name, estimate: list.estimate, result: got.some((r) => r.key) ? 'products' : 'no product' });
  }

  // ---- saving: products rebuilt from every ad of this run, so two advertisers selling one product make one card ----
  const rows = [];
  async function save() {
    const at = new Date(now()).toISOString();
    const done = await Promise.all(claims.values());
    const all = byProduct(done.filter((r) => r.key && r.ev), (r) => r.key);
    const build = [];
    const fail = [];
    for (const key of touched) {
      const list = all.get(key) || [];
      const best = bestOf(list);
      if (!best) continue;
      const row = productRow(key, best, list, { known: known.get(key), at, runId: t.id });
      if (best.ev.verdict === 'winner' || best.ev.verdict === 'partial') build.push(row);
      else if (best.ev.verdict === 'skip' && known.has(key) && Number(known.get(key).active) === 1) fail.push({ product_key: key, verdict: best.ev.verdict, rules: row.rules });
      else if (best.ev.verdict === 'pending') t.undecided++; // Google gave no date or count yet: looked at again in 3 days
    }
    touched.clear();
    for (const r of build) {
      const i = rows.findIndex((x) => x.product_key === r.product_key);
      if (i >= 0) rows[i] = r;
      else rows.push(r);
    }
    t.products = rows.length;
    t.winners = rows.filter((r) => r.verdict === 'winner').length;
    t.partial = rows.filter((r) => r.verdict === 'partial').length;
    if (!write) {
      newAds.length = 0;
      doneTargets.length = 0;
      newStores.length = 0;
      return;
    }
    for (const part of chunks(build, 100)) {
      await db.query(PRODUCTS_SQL, [JSON.stringify(part)]);
      t.saved += part.length;
      for (const r of part) if (!known.has(r.product_key)) known.set(r.product_key, { ad_id: r.ad_id, first_seen: r.first_seen, active: 1 });
    }
    for (const part of chunks(fail, 200)) t.rechecked += (await db.query(RECHECK_SQL, [JSON.stringify(part), at, t.id])).length;
    for (const part of chunks(newAds.splice(0), 200)) await db.query(ADS_SQL, [JSON.stringify(part), at]);
    for (const part of chunks(newStores.splice(0), 200)) await db.query(STORES_SQL, [JSON.stringify(part), at]);
    for (const part of chunks(doneTargets.splice(0), 200)) await db.query(TARGETS_SQL, [JSON.stringify(part), at]);
    if (build.length || fail.length) await db.setState('google_data', { run: t.id }, new Date(now())); // the board reads its tables again
  }

  // ---- the run ----
  let stop = '';
  const stopWith = (e) => {
    stop = stop || e.kind;
    t.error = t.error || e.message;
    log(`${e.kind === 'cap' ? '' : '::error::'}${e.message}`);
  };
  async function work(list) {
    await pool(list, atOnce, async (x) => {
      if (stop) return;
      if (now() > deadline) {
        stop = stop || 'time';
        return;
      }
      try {
        await look(x);
      } catch (e) {
        if (e.stop) return stopWith(e);
        t.failed_calls++;
        warn(`${x.kind === 'adv' ? 'Advertiser' : 'Domain'} ${x.value}: skipped (${e.message})`);
      }
    });
    await save();
    await progress();
  }

  await work(queue.splice(0));
  const all = typed && typed.length ? typed : keywords;
  const n = all.length;
  let start = 0;
  if (!(typed && typed.length) && n) {
    let next = null;
    try {
      const raw = db ? await db.getState('google_cursor') : null;
      next = raw == null ? null : Number(JSON.parse(raw).next);
    } catch (e) {
      next = null;
    }
    start = wrap(Number.isFinite(next) ? next : 0, n);
    t.cursor = start;
  }
  for (let i = 0; i < n && !stop; i++) {
    if (now() > deadline) {
      stop = 'time';
      break;
    }
    const kw = all[(start + i) % n];
    let searchFailed = false;
    for (const region of regions) {
      try {
        const found = await api.searchAdvertisers(kw, region);
        t.searches++;
        for (const d of found.domains) if (!NON_STORE.test(d)) add({ kind: 'domain', value: d, via: 'keyword', keyword: kw });
        for (const a of found.advertisers) {
          // Google's own estimate in the search: under 75 the advertiser cannot pass the 75+ rule. Looked at for free.
          if (a.estimate != null && a.estimate < MIN_ACTIVE_ADS) {
            t.gated++;
            continue;
          }
          add({ kind: 'adv', value: a.id, name: a.name, region: a.region || region, via: 'keyword', keyword: kw });
        }
      } catch (e) {
        if (e.stop) {
          stopWith(e);
          break;
        }
        searchFailed = true;
        t.failed_calls++;
        warn(`"${kw}" in ${region}: search failed (${e.message}): searched again next run`);
      }
    }
    if (stop) break;
    const batch = queue.splice(0).map((x) => ({ ...x, keyword: x.keyword || kw }));
    await work(batch); // what the searches that answered found
    if (stop) break; // this keyword's advertisers were not all looked at: searched again next run (those looked at are skipped)
    if (searchFailed) {
      // A region's search did not answer: the cursor stays at this keyword, and this run's keywords end here.
      stop = 'search';
      break;
    }
    t.keywords++;
    if (!(typed && typed.length)) {
      t.cursor = wrap(start + i + 1, n);
      if (write) await db.setState('google_cursor', { next: t.cursor }, new Date(now()));
    }
  }

  // ---- tidy up: products whose ad is older than 42 days today, or not checked for a month, leave the board (the board
  // already hides the first kind; this keeps them out of the store signals). What nobody decided on and was not seen for a
  // long time goes. ----
  if (write) {
    t.retired = (await db.query('UPDATE google_products SET active = 0 WHERE active = 1 AND (first_shown < ?1 OR last_seen < ?2) RETURNING product_key',
      [new Date(started - (MAX_AGE_DAYS + 1) * DAY).toISOString(), ago(30)])).length;
    if (t.retired) await db.setState('google_data', { run: t.id, step: 'retired' }, new Date(now()));
    const old = ago(KEEP_DAYS);
    await db.query('DELETE FROM google_products WHERE active = 0 AND last_seen < ?1 AND ad_id NOT IN (SELECT ad_id FROM stars) AND ad_id NOT IN (SELECT ad_id FROM hidden)', [old]);
    await db.query('DELETE FROM google_ads WHERE seen_at < ?1', [old]);
    await db.query('DELETE FROM google_targets WHERE checked_at < ?1', [old]);
  }

  // ---- health ----
  const c = api.stats();
  t.credits = c;
  // Why it stopped: 'done', 'cap' (GOOGLE_CREDITS reached: the plan), 'time', 'search' (a search failed: that keyword next
  // run), 'outage' (the vendor failed calls in a row), 'no-credits' (402) or 'key' (401).
  t.stopped = stop === 'credits' ? 'no-credits' : stop || 'done';
  const problems = [];
  if (stop === 'key') problems.push('de API-sleutel is geweigerd / the API key was refused');
  if (stop === 'credits') problems.push('geen credits meer bij Scrape Creators / no credits left at Scrape Creators');
  if (c.failed > 0 && c.ok === 0) problems.push(`elke aanvraag mislukte / every request failed (${t.error || 'no answer'})`);
  else if (stop === 'outage') warn(`Scrape Creators stopped answering: ${t.error}`);
  if (problems.length) {
    t.health = 'failed';
    t.alert = `Google-hunt mislukt / Google hunt failed: ${problems.join('; ')}`;
  } else if (warnings.length || t.pending) {
    t.health = 'warning';
    t.alert = `${warnings.length + (t.pending ? 1 : 0)} waarschuwing(en) / warning(s): ${warnings[0] || `${t.pending} store(s) did not answer: asked again next run`}`;
  } else t.health = 'ok';
  t.status = t.stopped;
  t.finished_at = new Date(now()).toISOString();
  await progress();
  t.rows = rows;
  log(`Google: ${t.searches} searches · ${t.targets} advertisers/domains · ${t.details} ads read (${t.cached} kept) · ${t.products} products (${t.winners} all four rules, ${t.partial} reach unknown)`
    + ` · ${t.restricted} off the EU board · ${t.not_shopify} not Shopify · ${c.spent} of ${c.cap} credits${c.remaining != null ? ` (${fmtCompact(c.remaining)} left)` : ''}`
    + ` · stopped: ${t.stopped}${t.dry_run ? ' · DRY RUN: nothing saved' : ''}${sample ? ' · SAMPLE DATA' : ''} · ${t.health}`);
  return t;
}

/** The D1 row of one product, from its ads in this run: its best ad's rules, every ad's regions and formats. */
export function productRow(key, best, list, { known = null, at, runId }) {
  const { ad, ev, item, st, x } = best;
  const host = st.host || st.key;
  const handle = key.split('/products/')[1];
  const creatives = new Set(list.map((r) => r.ad.creativeId));
  const imp = ad.eu ? { ...ad.eu, scope: 'eu' } : ad.impressions ? { ...ad.impressions, scope: 'all' } : null;
  return {
    product_key: key,
    ad_id: (known && known.ad_id) || 'g' + ad.creativeId,
    active: 1,
    verdict: ev.verdict,
    rules: JSON.stringify(ev.items),
    product_title: item.title || ad.headline || '',
    price: item.price ?? null,
    compare_at_price: item.compare_at_price ?? null,
    currency: item.currency || st.currency || '',
    image_url: item.image_url || '',
    product_type: item.product_type || '',
    store_url: `https://${host}/`,
    product_url: `https://${host}/products/${handle}`,
    advertiser: ad.advertiser || '',
    advertiser_id: ad.advertiserId,
    creative_id: ad.creativeId,
    region: x.region || '',
    ads_estimate: best.counts ? best.counts.estimate ?? best.counts.listed : null,
    ads_window: RUNNING_DAYS,
    first_shown: iso(ad.firstShown),
    last_shown: iso(ad.lastShown),
    days: ev.days,
    regions: JSON.stringify([...new Set(list.flatMap((r) => r.ad.regions || []))].sort()),
    formats: JSON.stringify([...new Set(list.map((r) => r.ad.format).filter(Boolean))].sort()),
    copies: creatives.size,
    impr_lower: imp ? imp.lower : null,
    impr_upper: imp ? imp.upper : null,
    impr_scope: imp ? imp.scope : '',
    store_products: st.products ?? null,
    keyword: x.keyword || '',
    via: x.via || '',
    first_seen: (known && known.first_seen) || at,
    last_seen: at,
    run_id: runId,
  };
}

/** The products of a run as text, one line each, for the log and a dry run. */
export function lines(rows) {
  return rows.map((r) => {
    let items = [];
    try {
      items = JSON.parse(r.rules);
    } catch (e) {
      items = [];
    }
    const h = howMany(items);
    return `${r.verdict === 'winner' ? 'ALL 4' : '3 of 4'} ${items.map(mark).join('')} (${h.exact} exact, ${h.approx} approx, ${h.unknown} unknown) · ${r.product_title}`
      + ` · ${r.price == null ? '–' : r.price + ' ' + r.currency} · ${r.product_url} · live ${r.days}d · ${JSON.parse(r.regions || '[]').join(',') || '–'} · ${JSON.parse(r.formats || '[]').join(',') || '–'}`
      + ` · ${advertiserUrl(r.advertiser_id)}`;
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const sample = argv.includes('--fixtures') || /^(1|yes|true|on)$/i.test(String(env.GOOGLE_FIXTURES || '').trim());
  const dryRun = sample || argv.includes('--dry-run') || /^(1|yes|true|on)$/i.test(String(env.GOOGLE_DRY_RUN || '').trim());
  let doFetch = globalThis.fetch;
  let key = String(env[SECRET] || '').trim();
  let now = Date.now;
  if (sample) {
    // SAMPLE DATA: the fake API and shops of the tests. No key, no credits, never saved.
    const fake = await import('./test/helpers/fake-google.mjs');
    doFetch = fake.googleFetch([], { now: Date.now() });
    key = fake.SAMPLE_KEY;
    console.log('SAMPLE DATA (test/fixtures/google/sample.json): made-up advertisers and shops, not real. Nothing is saved.');
  } else if (!key) throw new Error(`No ${SECRET}: add it as a GitHub secret (see docs/google-ads/README.md)`);
  const s = sample ? null : d1Settings(env);
  if (!s && !dryRun) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md), or set GOOGLE_DRY_RUN=1');
  const credits = creditsOf(env.GOOGLE_CREDITS);
  const api = googleClient({ key, fetch: doFetch, cap: credits });
  const typed = String(env.GOOGLE_KEYWORDS || '').split('|').map((k) => k.trim()).filter(Boolean);
  const minutes = minutesOf(env.GOOGLE_MINUTES);
  const t = await hunt({
    api, db: s ? d1Client(s) : null, doFetch, now,
    keywords: sample ? ['posture', 'lamp'] : keywordsOf(env),
    typed: typed.length ? typed : null,
    // SAMPLE mode has no D1, so no shops from the other tabs: the sample's one (its reach not published) is typed in instead.
    targets: sample ? [{ kind: 'domain', value: 'glowlamp-sample.example' }] : targetsOf(env.GOOGLE_DOMAINS),
    regions: sample ? ['NL', 'DE'] : regionsOf(env.GOOGLE_REGIONS),
    deadline: Date.now() + minutes * 60000,
    dryRun, sample,
    details: Math.min(Math.max(Number(env.GOOGLE_DETAILS) || DEFAULTS.details, 1), 20),
    pages: Math.min(Math.max(Number(env.GOOGLE_PAGES) || DEFAULTS.pages, 1), 10),
    boardDomains: env.GOOGLE_BOARD_DOMAINS == null || env.GOOGLE_BOARD_DOMAINS === '' ? DEFAULTS.boardDomains : Math.min(Math.max(Number(env.GOOGLE_BOARD_DOMAINS) || 0, 0), 200),
  });
  const out = lines(t.rows);
  if (out.length) console.log((sample ? 'SAMPLE DATA, not real:\n' : '') + out.join('\n'));
  if (env.GITHUB_STEP_SUMMARY) {
    const c = t.credits;
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n## Google hunt${t.dry_run ? ' (dry run: nothing saved)' : ''}${sample ? ' — SAMPLE DATA' : ''}\n`
      + `${t.searches} searches, ${t.targets} advertisers/domains, ${t.details} ads read, **${t.products} products** (${t.winners} pass all four rules, ${t.partial} with reach unknown), `
      + `${c.spent} of ${c.cap} credits (about $${((c.spent * 1.88) / 1000).toFixed(2)} at the $47 pack), stopped: ${t.stopped}, ${t.health}.\n`
      + (out.length ? `\n| Rules | Product |\n|---|---|\n${out.map((l) => `| ${l.split(' · ')[0]} | ${l.split(' · ').slice(1).join(' · ').replace(/\|/g, '/')} |`).join('\n')}\n` : ''));
  }
  if (t.health === 'failed') {
    console.log(`::error::${t.alert}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::Google hunt: ${e.message}`);
    process.exitCode = 1;
  });
}
