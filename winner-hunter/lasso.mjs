#!/usr/bin/env node
/*
 * Lasso stores, a discovery source (off unless started; docs/research/lasso-stores.md). Finds the Shopify stores that use
 * Lasso's hosted checkout (lib/lasso.mjs) with urlscan.io's free search, checks each one live (its script, its checkout,
 * its best sellers) and writes the list. Actions → Lasso stores → Run workflow; weekly only with the repository variable
 * LASSO_STORES = on.
 *   node winner-hunter/lasso.mjs                → lasso-out/lasso-stores.csv and lasso-stores.json (LASSO_OUT: another folder)
 *   [URLSCAN_API_KEY=…]                         an urlscan.io API key (free account): more searches a day, older scans
 *   [LASSO_DAYS=30]                             how far back to search (urlscan without a key: 30 days at most)
 *   [LASSO_EXTRA="a.com b.com"]                 more domains to check
 *   [LASSO_EXTRA_FILE=list.csv]                 … and every address in a file, e.g. a reverse-CNAME export (checkout.x.com → x.com)
 *   CF_API_TOKEN + CF_ACCOUNT_ID                also saved in D1 (table lasso_stores); the stores saved before are checked again
 *   LASSO_ADS=1 (+ D1 + a browser)              each store's active ads outside the EU go into world_ads with the keyword
 *                                               "lasso: <store>": the next World Hunter run puts their products in the
 *                                               🌍 Inbox under its usual rules (Shopify, an ad 7+ days old, no supplements…)
 * The run ends red when urlscan answered not one search, or the list could not be saved in D1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings, chunks } from './lib/d1.mjs';
import { pool } from './lib/meta.mjs';
import { hostOf, hostKey } from './lib/score.mjs';
import { toRow } from './lib/world.mjs';
import { openLibrary } from './lib/adlibrary.mjs';
import { URLSCAN_QUERIES, sweep, candidatesOf, checkLassoStore, marketsOf, toCsv, domainsIn } from './lib/lasso.mjs';
import { ADS_SQL } from './world.mjs';

const PAUSE_MS = 5000; // between two Ad Library searches (as world.mjs)
const BLOCKS_THEN_STOP = 6; // Ad Library refusals in a row: stop the ad part for this run
export const MAX_AD_SEARCHES = 150;

const COLS = ['store', 'host', 'confidence', 'live', 'script', 'lasso_store_id', 'lasso_since', 'checkout_url', 'name', 'country', 'currency', 'lang', 'products', 'best_sellers', 'how'];
const v = (c) => `json_extract(value, '$.${c}')`;
// One row per store. first_seen stays the first time it was found; last_seen is the last check that still found Lasso.
export const STORES_SQL = `INSERT INTO lasso_stores (${COLS.join(', ')}, first_seen, last_seen, checked_at)
SELECT ${COLS.map(v).join(', ')}, COALESCE(${v('first_seen')}, ?2), CASE WHEN ${v('confidence')} != '' THEN ?2 END, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(store) DO UPDATE SET ${COLS.slice(1).filter((c) => c !== 'how').map((c) => `${c} = excluded.${c}`).join(', ')},
  how = CASE WHEN excluded.how != '' THEN excluded.how ELSE lasso_stores.how END,
  first_seen = MIN(COALESCE(lasso_stores.first_seen, excluded.first_seen), excluded.first_seen),
  last_seen = CASE WHEN excluded.confidence != '' THEN excluded.checked_at ELSE lasso_stores.last_seen END, checked_at = excluded.checked_at`;

const RANK = { high: 0, medium: 1, low: 2 };
const truthy = (x) => /^(1|yes|true|on)$/i.test(String(x || '').trim());
const iso = (t) => new Date(t).toISOString();

/**
 * One run. deps: { doFetch, db (optional), lib (optional: openLibrary's answer, for LASSO_ADS), key, days, extra, now,
 * log, sleep, pauseMs, maxAdSearches }. → { searches, scan_errors, candidates, stores: rows with a Lasso sign, saved, ads,
 * ad_searches, health ('ok' | 'warning' | 'failed'), alert }.
 */
export async function discover({ doFetch = globalThis.fetch, db = null, lib = null, key = '', days = 30, extra = [], now = Date.now, log = console.log,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = PAUSE_MS, maxAdSearches = MAX_AD_SEARCHES, concurrency = 4 } = {}) {
  const t = { searches: 0, scan_errors: 0, candidates: 0, stores: [], saved: 0, ads: 0, ad_searches: 0, health: 'ok', alert: '' };
  // ---- 1. urlscan: the pages that load Lasso's script, and its checkout pages ----
  const scans = [];
  for (const q of URLSCAN_QUERIES) {
    const got = await sweep(q, { doFetch, key, days, now: now(), sleep });
    t.searches += got.searches;
    t.scan_errors += got.errors;
    scans.push(...got.scans);
    log(`urlscan ${q}: ${got.scans.length} scans (${got.searches} searches, ${got.errors} errors)`);
  }
  const found = new Map(candidatesOf(scans).map((c) => [c.domain, c]));
  for (const d of extra) if (d && !found.has(d)) found.set(d, { domain: d, how: ['asked for'], first_seen: '' });
  // The stores saved before are checked again: one that left Lasso is marked, and a quiet week loses none.
  if (db) {
    for (const r of await db.query("SELECT store FROM lasso_stores WHERE confidence != ''").catch(() => [])) {
      if (!found.has(r.store)) found.set(r.store, { domain: r.store, how: [], first_seen: '' });
    }
  }
  t.candidates = found.size;

  // ---- 2. each one live: a store page, a checkout, the same store under two addresses counted once ----
  const rows = new Map();
  const check = async (c) => {
    const r = await checkLassoStore(c.domain, { doFetch, now: now() });
    if (!r.confidence) {
      // A saved store that answered and shows no Lasso any more is saved as gone. One that did not answer stays as it was.
      if (db && !c.how.length && r.status && r.status < 500 && !rows.has(r.store)) rows.set(r.store, { ...r, how: '', first_seen: null });
      return;
    }
    const old = rows.get(r.store);
    const how = [...new Set([...(old ? String(old.how).split('; ') : []), ...c.how])].filter(Boolean).join('; ');
    const first = [old && old.first_seen, c.first_seen].filter(Boolean).sort()[0] || null;
    const last = [old && old.last_seen, c.last_seen].filter(Boolean).sort().pop() || null; // the last scan on urlscan (D1 keeps its own)
    if (!old || !old.confidence || RANK[r.confidence] < RANK[old.confidence]) rows.set(r.store, { ...r, how, first_seen: first, last_seen: last });
    else Object.assign(old, { how, first_seen: first, last_seen: last });
  };
  await pool([...found.values()], concurrency, check);
  // A store's checkout can sit on another of its domains (madebybellablu.com → checkout.bellablunashville.com): that domain
  // is checked too, once. Mostly it is the same store under a second name, sometimes a sister store.
  const sisters = new Map();
  for (const r of rows.values()) {
    const d = hostKey(String(hostOf(r.checkout_url) || '').replace(/^(checkout|secure|pay)\./, ''));
    if (d && d !== r.store && !found.has(d) && !rows.has(d) && !sisters.has(d)) sisters.set(d, { domain: d, how: [`checkout of ${r.store}`], first_seen: '' });
  }
  t.candidates += sisters.size;
  await pool([...sisters.values()], concurrency, check);
  t.stores = [...rows.values()].filter((r) => r.confidence)
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || b.live - a.live || (b.products ?? 0) - (a.products ?? 0) || (a.store < b.store ? -1 : 1));

  // ---- 3. D1 ----
  if (db) {
    const list = [...rows.values()].map((r) => ({ ...r, best_sellers: JSON.stringify(r.best_sellers || []), how: r.how || '' }));
    try {
      for (const part of chunks(list, 100)) {
        await db.query(STORES_SQL, [JSON.stringify(part), iso(now())]);
        t.saved += part.length;
      }
    } catch (e) {
      t.health = 'failed';
      t.alert = `Lasso stores not saved in D1: ${e.message}`;
    }
  }

  // ---- 4. their ads outside the EU, for the hunt (LASSO_ADS) ----
  if (db && lib && t.health !== 'failed') {
    let inRow = 0;
    const ads = [];
    ads: for (const r of t.stores.filter((s) => s.live && s.confidence !== 'low')) {
      for (const cc of marketsOf(r)) {
        if (t.ad_searches >= maxAdSearches) break ads;
        // Only the store's own ads: a search for its domain also finds ads that just share a word with it.
        const own = (got) => got.ads.map((raw) => toRow(raw, cc, `lasso: ${r.store}`)).filter((row) => row && row.store === r.store);
        // The domain as words first (it also matches the ad's link); when that finds none of its own ads among other
        // shops' (aussie-flair.com → "Flair Dancewear"), the domain as one exact phrase.
        let got = await lib.search({ cc, q: r.store });
        t.ad_searches++;
        let mine = got.blocked ? [] : own(got);
        if (!got.blocked && !mine.length && t.ad_searches < maxAdSearches) {
          await sleep(pauseMs);
          got = await lib.search({ cc, q: r.store, exact: true });
          t.ad_searches++;
          mine = got.blocked ? [] : own(got);
        }
        if (got.blocked) {
          if (++inRow >= BLOCKS_THEN_STOP) {
            log(`Ad Library refused ${inRow} searches in a row: the other stores next run`);
            break ads;
          }
        } else inRow = 0;
        ads.push(...mine);
        await sleep(pauseMs);
      }
    }
    try {
      for (const part of chunks(ads, 200)) await db.query(ADS_SQL, [JSON.stringify(part), iso(now())]);
      t.ads = ads.length;
    } catch (e) {
      t.health = 'failed';
      t.alert = `Lasso stores' ads not saved in D1: ${e.message}`;
    }
  }

  if (t.health !== 'failed') {
    if (t.searches && t.scan_errors >= t.searches) {
      t.health = 'failed';
      t.alert = `urlscan.io answered none of ${t.searches} searches`;
    } else if (t.scan_errors) {
      t.health = 'warning';
      t.alert = `urlscan.io did not answer ${t.scan_errors} of ${t.searches} searches: those days are searched again next run`;
    }
  }
  return t;
}

/** The files of a run: <dir>/lasso-stores.csv and lasso-stores.json. */
export function writeOut(dir, stores) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lasso-stores.csv'), toCsv(stores));
  fs.writeFileSync(path.join(dir, 'lasso-stores.json'), JSON.stringify(stores, null, 1));
}

async function main() {
  const env = process.env;
  const s = d1Settings(env);
  const db = s ? d1Client(s) : null;
  let lib = null;
  if (truthy(env.LASSO_ADS)) {
    if (!db) console.log('::warning::LASSO_ADS needs CF_API_TOKEN and CF_ACCOUNT_ID (the ads go into D1): skipped');
    else {
      const launch = async () => {
        const { chromium } = await import('playwright-core').catch(() => import('playwright'));
        return chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch(env.CHROME_PATH ? { executablePath: env.CHROME_PATH } : {}));
      };
      lib = await openLibrary({ launch }).catch((e) => {
        console.log(`::warning::No browser for the Ad Library (${e.message}): the stores are listed, their ads are not`);
        return null;
      });
    }
  }
  try {
    const extra = domainsIn([env.LASSO_EXTRA || '', env.LASSO_EXTRA_FILE ? fs.readFileSync(env.LASSO_EXTRA_FILE, 'utf8') : ''].join('\n'));
    const t = await discover({ db, lib, key: String(env.URLSCAN_API_KEY || '').trim(), days: Math.min(Math.max(Number(env.LASSO_DAYS) || 30, 1), 365), extra });
    writeOut(env.LASSO_OUT || 'lasso-out', t.stores);
    const n = (c) => t.stores.filter((r) => r.confidence === c).length;
    const line = `Lasso stores: ${t.stores.length} (${n('high')} sure, ${n('medium')} likely, ${n('low')} left Lasso) of ${t.candidates} candidates, ${t.searches} urlscan searches`
      + (db ? `, ${t.saved} saved in D1` : ', not saved (no D1 settings)') + (lib ? `, ${t.ads} ads from ${t.ad_searches} Ad Library searches` : '') + ` (${t.health})`;
    console.log(line);
    // A public repository's summary is public: counts only, the list is in the run's artifact.
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n**${line}.** The list: this run's artifact *lasso-stores*.\n`);
    if (t.health === 'failed') {
      console.log(`::error::${t.alert}`);
      process.exitCode = 1;
    } else if (t.alert) console.log(`::warning::${t.alert}`);
  } finally {
    if (lib) await lib.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::Lasso stores: ${e.message}`);
    process.exitCode = 1;
  });
}
