#!/usr/bin/env node
/*
 * The hunt outside the EU: every run the next keywords in every market of lib/world.mjs, through the public Ad Library.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… [META_TOKEN=…] [WORLD_MINUTES=120] [WORLD_PAGES=80] [WORLD_SEARCH_SHARE=0.7] node winner-hunter/world.mjs
 *
 * Saved after every few searches, so a run cut short loses little; the keyword cursor is in D1 state 'world_cursor'.
 * After the searches: which stores run on Shopify, what the products are, how many active ads their shops run per
 * market, whether the shop runs ads in the EU at all (needs META_TOKEN), then the board's table world_products.
 * The run's status is in D1 state 'world_run' (shown on the board). It ends red when Facebook refused almost every search.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings, chunks } from './lib/d1.mjs';
import { pool } from './lib/meta.mjs';
import { EU_CODES } from './lib/eu.mjs';
import { openLibrary } from './lib/adlibrary.mjs';
import { MARKETS, KEEP_DAYS, parseWorldKeywords, searchesOf, toRow, checkStore, fetchProduct, suggestProduct, addUp, euFacts } from './lib/world.mjs';

const DAY = 864e5;
const PAUSE_MS = 5000; // between two searches
const SAVE_EVERY = 14; // searches between two saves
const BLOCKS_THEN_WAIT = 3; // blocked searches in a row: pause, a fresh start often passes
const BLOCKS_THEN_STOP = 6; // … and this many: stop for tonight
const WAIT_MS = 120000;
const STORE_DAYS = 14; // a store's Shopify check and a product's facts are read again after this long
const PAGE_DAYS = 7; // a shop's ad count per market is read again after this long
const MAX_GUESSES = 400; // ad titles per run looked up in their store's search

const USAGE_STOP = 60; // % of Meta's hourly limit: the EU check stops here

/** Meta's usage header: the highest of call count, CPU and time, 0–100. */
function usagePct(res) {
  const h = res && res.headers && res.headers.get && (res.headers.get('x-business-use-case-usage') || res.headers.get('x-app-usage'));
  if (!h) return 0;
  try {
    const j = JSON.parse(h);
    const rows = Array.isArray(Object.values(j)[0]) ? Object.values(j).flat() : [j];
    return Math.max(0, ...rows.map((r) => Math.max(r.call_count || 0, r.total_cputime || 0, r.total_time || 0)));
  } catch (e) {
    return 0;
  }
}

const num = (k) => `json_extract(value, '$.${k}')`;
export const ADS_SQL = `INSERT INTO world_ads (ad_id, cc, page_id, page_name, likes, collation_id, copies, start_at, link, caption, title, image_url, keyword, store, product_key, first_seen, last_seen)
SELECT ${['ad_id', 'cc', 'page_id', 'page_name', 'likes', 'collation_id', 'copies', 'start_at', 'link', 'caption', 'title', 'image_url', 'keyword', 'store', 'product_key'].map(num).join(', ')}, ?2, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(ad_id, cc) DO UPDATE SET page_name = excluded.page_name, likes = excluded.likes, copies = excluded.copies, link = excluded.link, title = excluded.title,
  image_url = CASE WHEN excluded.image_url != '' THEN excluded.image_url ELSE world_ads.image_url END, store = excluded.store,
  product_key = CASE WHEN excluded.product_key != '' THEN excluded.product_key ELSE world_ads.product_key END, keyword = CASE WHEN excluded.keyword != '' THEN excluded.keyword ELSE world_ads.keyword END, last_seen = excluded.last_seen`;
export const STORES_SQL = `INSERT INTO world_stores (store, shopify, host, currency, products, myshopify, checked_at)
SELECT ${['store', 'shopify', 'host', 'currency', 'products', 'myshopify'].map(num).join(', ')}, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(store) DO UPDATE SET shopify = excluded.shopify, host = excluded.host, currency = excluded.currency, products = excluded.products, myshopify = excluded.myshopify, checked_at = excluded.checked_at`;
export const ITEMS_SQL = `INSERT INTO world_items (product_key, title, price, compare_at_price, currency, image_url, product_type, out, checked_at)
SELECT ${['product_key', 'title', 'price', 'compare_at_price', 'currency', 'image_url', 'product_type', 'out'].map(num).join(', ')}, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(product_key) DO UPDATE SET title = excluded.title, price = excluded.price, compare_at_price = excluded.compare_at_price, currency = excluded.currency, image_url = excluded.image_url,
  product_type = excluded.product_type, out = excluded.out, checked_at = excluded.checked_at`;
export const PAGES_SQL = `INSERT INTO world_pages (page_id, counts, in_eu, checked_at, eu_checked_at, eu_rpd, eu_ads)
SELECT ${['page_id', 'counts', 'in_eu', 'checked_at', 'eu_checked_at', 'eu_rpd', 'eu_ads'].map(num).join(', ')} FROM json_each(?1) WHERE true
ON CONFLICT(page_id) DO UPDATE SET counts = excluded.counts, in_eu = excluded.in_eu, checked_at = excluded.checked_at, eu_checked_at = excluded.eu_checked_at, eu_rpd = excluded.eu_rpd, eu_ads = excluded.eu_ads`;
const PRODUCT_COLS = ['product_key', 'ad_id', 'active', 'product_title', 'price', 'compare_at_price', 'currency', 'image_url', 'store_url', 'product_url', 'ad_library_url', 'advertiser', 'page_id', 'likes',
  'keyword', 'markets', 'ads', 'creatives', 'days', 'new14', 'shop_ads', 'in_eu', 'eu_rpd', 'shop_eu_rpd', 'store_products', 'first_seen', 'last_seen', 'run_id'];
export const PRODUCTS_SQL = `INSERT INTO world_products (${PRODUCT_COLS.join(', ')})
SELECT ${PRODUCT_COLS.map(num).join(', ')} FROM json_each(?1) WHERE true
ON CONFLICT(product_key) DO UPDATE SET ${PRODUCT_COLS.filter((c) => !['product_key', 'ad_id', 'first_seen'].includes(c)).map((c) => `${c} = excluded.${c}`).join(', ')}`;

/** Every row of a query, a slice at a time (one big answer can fail). */
async function allRows(db, sql, args = [], size = 5000) {
  const out = [];
  for (let last = 0; ;) {
    const part = await db.query(`${sql} ${/ where /i.test(sql) ? 'AND' : 'WHERE'} rowid > ?${args.length + 1} ORDER BY rowid LIMIT ${size}`, [...args, last]);
    out.push(...part);
    if (part.length < size) return out;
    last = part[part.length - 1].rid;
  }
}

/**
 * deps: { db, lib (openLibrary's answer), keywords, doFetch, now, log, deadline, maxPages, tokens, sleep, pauseMs, base }.
 * Returns { searches, blocked, ads, stores, products, health ('ok' | 'failed'), stopped ('done' | 'time' | 'blocked') }.
 */
export async function hunt(opts) {
  const t = {};
  try {
    return await night(opts, t);
  } catch (e) {
    // Never left at "running": the board shows the failure and the workflow ends red.
    const { db, now = Date.now, log = console.log } = opts;
    const when = new Date(now()).toISOString();
    Object.assign(t, { status: 'failed', health: 'failed', alert: `Scan buiten de EU gestopt / Scan outside the EU stopped: ${e.message}`.slice(0, 300), finished_at: when, updated_at: when });
    await db.setState('world_run', t, new Date(now())).catch((x) => log(`::warning::Could not mark the scan failed: ${x.message}`));
    throw e;
  }
}

async function night({ db, lib, keywords, doFetch = globalThis.fetch, now = Date.now, log = console.log, deadline = Infinity, maxPages = 80, tokens = [], searchShare = 0.7,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = PAUSE_MS, waitMs = WAIT_MS, base = 'https://graph.facebook.com', api = 'v24.0' }, t) {
  const started = now();
  const startIso = new Date(started).toISOString();
  Object.assign(t, { id: startIso, started_at: startIso, status: 'running', searches: 0, blocked: 0, ads: 0, new_ads: 0, stores: 0, products: 0, per_market: {}, pages: 0, eu_checked: 0, stopped: 'done', health: null, alert: '' });
  const progress = () => {
    t.updated_at = new Date(now()).toISOString();
    return db.setState('world_run', t, new Date(now()));
  };
  await progress();

  let cursor = 0;
  try {
    const raw = await db.getState('world_cursor');
    const n = raw == null ? NaN : Number(JSON.parse(raw).next);
    if (Number.isFinite(n)) cursor = n;
  } catch (e) {
    cursor = 0;
  }
  const total = keywords.length;
  if (!total) throw new Error('No keywords in keywords-world.txt');

  const saveAds = async (rows) => {
    for (const part of chunks(rows, 200)) await db.query(ADS_SQL, [JSON.stringify(part), new Date(now()).toISOString()]);
  };

  // A search; blocked ones in a row make it wait, then stop for tonight. false: stop.
  let inRow = 0;
  let rowNow = 0; // the keyword being searched
  let firstRefused = 0; // the keyword where the refusals in a row began: the next run starts there
  const one = async (what, keyword, into) => {
    const got = await lib.search(what);
    t.searches++;
    if (got.blocked) {
      t.blocked++;
      if (!inRow) firstRefused = rowNow;
      inRow++;
      log(`${what.cc} "${what.q || what.pageId}": refused${got.error ? ` (${got.error})` : ''}`);
      if (inRow >= BLOCKS_THEN_STOP) {
        t.stopped = 'blocked';
        return null;
      }
      if (inRow === BLOCKS_THEN_WAIT) {
        log(`Refused ${inRow} times in a row: waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
      await sleep(pauseMs);
      return got;
    }
    inRow = 0;
    for (const raw of got.ads) {
      const row = toRow(raw, what.cc, keyword);
      if (row) into.push(row);
    }
    t.per_market[what.cc] = (t.per_market[what.cc] || 0) + got.ads.length;
    await sleep(pauseMs);
    return got;
  };

  // ---- 1. the next keywords in every market (the rest of the time goes to the stores and products) ----
  const searchEnd = Number.isFinite(deadline) ? started + (deadline - started) * searchShare : Infinity;
  let pending = [];
  let n = 0;
  search: for (let i = 0; i < total; i++) {
    const row = keywords[(cursor + i) % total];
    rowNow = i;
    for (const what of searchesOf(row)) {
      if (now() > searchEnd) {
        t.stopped = 'time';
        break search;
      }
      const got = await one(what, row.en, pending);
      if (!got) {
        await db.setState('world_cursor', { next: (cursor + firstRefused) % total }, new Date(now()));
        break search;
      }
      if (++n % SAVE_EVERY === 0 && pending.length) {
        t.ads += pending.length;
        await saveAds(pending);
        pending = [];
        await progress();
      }
    }
    await db.setState('world_cursor', { next: (cursor + i + 1) % total }, new Date(now()));
  }
  if (pending.length) {
    t.ads += pending.length;
    await saveAds(pending);
  }

  // ---- 2. stores, from their own meta.json ----
  const since = new Date(started - KEEP_DAYS * DAY).toISOString();
  const staleBefore = new Date(started - STORE_DAYS * DAY).toISOString();
  const wantStores = (await db.query(`SELECT DISTINCT a.store FROM world_ads a LEFT JOIN world_stores s ON s.store = a.store
    WHERE a.store != '' AND a.last_seen >= ?1 AND (s.store IS NULL OR s.checked_at < ?2)`, [since, staleBefore])).map((r) => r.store);
  const storeRows = [];
  await pool(wantStores, 4, async (store) => {
    if (now() > deadline) return;
    const s = await checkStore(store, doFetch).catch(() => ({ shopify: null, host: store }));
    if (s.shopify != null) storeRows.push({ store, ...s }); // no answer: asked again next run
  });
  for (const part of chunks(storeRows, 200)) await db.query(STORES_SQL, [JSON.stringify(part), new Date(now()).toISOString()]);
  t.stores = storeRows.filter((s) => s.shopify).length;
  await progress();
  const stores = new Map((await db.query('SELECT store, shopify, host, currency, products FROM world_stores')).map((s) => [s.store, s]));

  // ---- 3. products from their own store: name, price, photo, and what is off the board. Ads that link to a product come
  // first: they are certain, and the guessing below must not eat their time. ----
  const fetchItems = async () => {
    const want = await db.query(`SELECT DISTINCT a.product_key, a.store FROM world_ads a JOIN world_stores s ON s.store = a.store AND s.shopify = 1
      LEFT JOIN world_items i ON i.product_key = a.product_key WHERE a.product_key != '' AND a.last_seen >= ?1 AND (i.product_key IS NULL OR i.checked_at < ?2)`, [since, staleBefore]);
    const rows = [];
    await pool(want, 4, async ({ product_key: key, store }) => {
      if (now() > deadline) return;
      const s = stores.get(store) || {};
      const p = await fetchProduct(key, { host: s.host || store, currency: s.currency || '' }, doFetch).catch(() => null);
      if (p) rows.push({ product_key: key, ...p });
    });
    for (const part of chunks(rows, 200)) await db.query(ITEMS_SQL, [JSON.stringify(part), new Date(now()).toISOString()]);
    return rows.length;
  };
  t.items = await fetchItems();
  await progress();

  // ---- 4. ads without a product link: the store's own search with the ad's title, until it answers, in part of the time left ----
  const guessEnd = Number.isFinite(deadline) ? now() + (deadline - now()) * 0.3 : Infinity;
  const unlinked = await db.query(`SELECT DISTINCT a.store, a.title FROM world_ads a JOIN world_stores s ON s.store = a.store AND s.shopify = 1
    WHERE a.product_key = '' AND a.title != '' AND COALESCE(a.guessed, 0) = 0 AND a.last_seen >= ?1 LIMIT ${MAX_GUESSES}`, [since]);
  await pool(unlinked, 3, async ({ store, title }) => {
    if (now() > guessEnd) return;
    const key = await suggestProduct(title, (stores.get(store) || {}).host || store, doFetch, store).catch(() => null);
    if (key != null) await db.query("UPDATE world_ads SET product_key = ?1, guessed = 1 WHERE store = ?2 AND title = ?3 AND product_key = ''", [key, store, title]);
  });
  t.items += await fetchItems();
  await progress();

  // ---- 5. per shop: its active ads per market (biggest shops first), also a richer view of its products ----
  const rows0 = await allRows(db, 'SELECT rowid AS rid, * FROM world_ads WHERE last_seen >= ?1', [since]);
  const items = new Map((await db.query('SELECT product_key, title, price, compare_at_price, currency, image_url, out FROM world_items')).map((i) => [i.product_key, i]));
  const pageList = await db.query('SELECT page_id, counts, in_eu, checked_at, eu_checked_at, eu_rpd, eu_ads FROM world_pages');
  const pagesRaw = new Map(pageList.map((p) => [p.page_id, p]));
  const wanted = new Map(); // page_id → { cc: rows }
  for (const a of rows0) {
    const item = a.product_key && items.get(a.product_key);
    if (!item || item.out || !a.page_id) continue;
    const m = wanted.get(a.page_id) || {};
    m[a.cc] = (m[a.cc] || 0) + 1;
    wanted.set(a.page_id, m);
  }
  const pageStale = new Date(started - PAGE_DAYS * DAY).toISOString();
  const order = [...wanted.entries()].filter(([p]) => !pagesRaw.get(p) || !pagesRaw.get(p).checked_at || pagesRaw.get(p).checked_at < pageStale)
    .sort((x, y) => Object.values(y[1]).reduce((a, b) => a + b, 0) - Object.values(x[1]).reduce((a, b) => a + b, 0) || (x[0] < y[0] ? -1 : 1));
  let left = maxPages;
  const pageSaves = [];
  const extra = [];
  shops: for (const [pageId, seen] of order) {
    const counts = {};
    for (const cc of Object.keys(seen)) {
      if (left <= 0 || now() > deadline) break shops;
      left--;
      const got = await one({ cc, pageId }, '', extra);
      if (!got) break shops;
      if (got.count != null) counts[cc] = got.count;
    }
    if (Object.keys(counts).length) {
      const old = pagesRaw.get(pageId) || {};
      // A market that was refused keeps its old count and the shop is asked again next run.
      let before = {};
      try {
        before = JSON.parse(old.counts || '{}') || {};
      } catch (e) {
        before = {};
      }
      const allRead = Object.keys(seen).every((cc) => cc in counts);
      pageSaves.push({ page_id: pageId, counts: JSON.stringify({ ...before, ...counts }), in_eu: old.in_eu ?? null, checked_at: allRead ? new Date(now()).toISOString() : old.checked_at ?? null, eu_checked_at: old.eu_checked_at ?? null, eu_rpd: old.eu_rpd ?? null, eu_ads: old.eu_ads ?? null });
      t.pages++;
    }
  }
  if (extra.length) await saveAds(extra.filter((a) => a.store));
  for (const part of chunks(pageSaves, 200)) await db.query(PAGES_SQL, [JSON.stringify(part)]);

  // ---- 6. does the shop run ads in the EU at all, and what reach do they get? Only Meta's API knows, and it only shows ads
  // that reach the EU or UK (tested 2026-10-31: 23 of 26 local shops gave 0 ads for their own market). One request per shop. ----
  const token = (tokens || []).filter(Boolean)[0];
  if (token) {
    const saved = new Map((await db.query('SELECT page_id, counts, in_eu, checked_at, eu_checked_at, eu_rpd, eu_ads FROM world_pages')).map((p) => [p.page_id, p]));
    const seenIds = new Set(rows0.map((a) => String(a.ad_id)));
    const need = [...wanted.keys()].filter((p) => !saved.get(p) || !saved.get(p).eu_checked_at || saved.get(p).eu_checked_at < pageStale).slice(0, 600);
    const rows = [];
    let stop = false;
    await pool(need, 2, async (pid) => {
      if (stop || now() > deadline) return;
      const p = new URLSearchParams({ search_page_ids: JSON.stringify([pid]), ad_reached_countries: JSON.stringify(EU_CODES), ad_active_status: 'ACTIVE', ad_type: 'ALL', fields: 'id,eu_total_reach,ad_delivery_start_time', limit: '200', access_token: token });
      try {
        const res = await doFetch(`${base}/${api}/ads_archive?${p}`, { signal: AbortSignal.timeout(30000) });
        const j = await res.json();
        if (usagePct(res) >= USAGE_STOP) {
          stop = true; // leave room for the EU hunt
          log('EU check stopped: near Meta\'s hourly limit, the rest next run');
        }
        if (j.error) {
          stop = true; // the token or the hourly limit: the rest next run
          log(`EU check stopped: Meta error ${j.error.code}`);
          return;
        }
        const old = saved.get(pid) || {};
        rows.push({ page_id: pid, counts: old.counts ?? null, ...euFacts(j.data, seenIds, now()), checked_at: old.checked_at ?? null, eu_checked_at: new Date(now()).toISOString() });
      } catch (e) {
        log(`EU check of ${pid} skipped (${e.name})`);
      }
    });
    t.eu_checked = rows.length;
    for (const part of chunks(rows, 200)) await db.query(PAGES_SQL, [JSON.stringify(part)]);
  }

  // ---- 7. the board's table ----
  const rows1 = await allRows(db, 'SELECT rowid AS rid, * FROM world_ads WHERE last_seen >= ?1', [since]);
  const parsedPages = new Map((await db.query('SELECT page_id, counts, in_eu, eu_rpd, eu_ads FROM world_pages')).map((p) => {
    let counts = {};
    try {
      counts = JSON.parse(p.counts || '{}') || {};
    } catch (e) {
      counts = {};
    }
    let euAds = {};
    try {
      euAds = JSON.parse(p.eu_ads || '{}') || {};
    } catch (e) {
      euAds = {};
    }
    return [p.page_id, { counts, in_eu: p.in_eu, eu_rpd: p.eu_rpd, eu_ads: euAds }];
  }));
  const known = new Map((await db.query('SELECT product_key, ad_id, first_seen FROM world_products')).map((k) => [k.product_key, k]));
  const items2 = new Map((await db.query('SELECT product_key, title, price, compare_at_price, currency, image_url, out FROM world_items')).map((i) => [i.product_key, i]));
  const products = addUp(rows1, { items: items2, stores, pages: parsedPages, known, now: now() });
  // Written first, and only then the rest goes inactive: a run cut short here leaves the board as it was.
  for (const part of chunks(products.map((p) => ({ ...p, run_id: t.id })), 200)) await db.query(PRODUCTS_SQL, [JSON.stringify(part)]);
  await db.query('UPDATE world_products SET active = 0 WHERE run_id IS NOT ?1', [t.id]);
  t.products = products.length;
  t.new_products = products.filter((p) => p.first_seen >= startIso || !known.has(p.product_key)).length;

  // ---- 8. tidy up: products nobody decided on and no longer seen, old ads ----
  await db.query('DELETE FROM world_ads WHERE last_seen < ?1', [new Date(started - 30 * DAY).toISOString()]);
  await db.query(`DELETE FROM world_products WHERE active = 0 AND last_seen < ?1 AND ad_id NOT IN (SELECT ad_id FROM stars) AND ad_id NOT IN (SELECT ad_id FROM hidden)`, [new Date(started - 60 * DAY).toISOString()]);

  const refused = t.searches ? t.blocked / t.searches : 1;
  // Facebook limits one address after a few hundred searches, so a run ending that way is normal: the next one goes on.
  t.health = refused > 0.8 || t.searches === 0 ? 'failed' : refused > 0.2 ? 'warning' : 'ok';
  if (t.health !== 'ok') t.alert = `Ad Library weigerde ${t.blocked} van ${t.searches} zoekopdrachten / Ad Library refused ${t.blocked} of ${t.searches} searches`;
  t.status = t.stopped;
  t.finished_at = new Date(now()).toISOString();
  await progress();
  log(`Outside the EU: ${t.searches} searches · ${t.blocked} refused · ${t.ads} ads · ${t.stores} new Shopify stores · ${t.pages} shops counted · ${t.eu_checked} EU checks · ${t.products} products · ${t.health}`);
  return t;
}

async function main() {
  const env = process.env;
  const s = d1Settings(env);
  if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)');
  const keywords = parseWorldKeywords(fs.readFileSync(new URL('./keywords-world.txt', import.meta.url), 'utf8'));
  const minutes = Math.min(Math.max(Number(env.WORLD_MINUTES) || 120, 1), 300);
  const db = d1Client(s);
  const launch = async () => {
    const { chromium } = await import('playwright-core').catch(() => import('playwright'));
    return chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch(env.CHROME_PATH ? { executablePath: env.CHROME_PATH } : {}));
  };
  const lib = await openLibrary({ launch });
  try {
    const t = await hunt({ db, lib, keywords, deadline: Date.now() + minutes * 60000, maxPages: Math.max(Number(env.WORLD_PAGES) || 80, 0), tokens: [env.META_TOKEN],
      searchShare: Math.min(Math.max(Number(env.WORLD_SEARCH_SHARE) || 0.7, 0.05), 0.95) });
    if (env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n**Outside the EU:** ${t.searches} searches, ${t.blocked} refused, ${t.ads} ads, ${t.products} products on the board (${t.health}).\n`);
    }
    if (t.health === 'failed') {
      console.log(`::error::${t.alert}`);
      process.exitCode = 1;
    }
  } finally {
    await lib.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::Outside the EU: ${e.message}`);
    process.exitCode = 1;
  });
}
export { MARKETS };
