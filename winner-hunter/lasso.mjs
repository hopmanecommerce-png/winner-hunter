#!/usr/bin/env node
/*
 * Lasso stores: the weekly discovery of Shopify stores that use Lasso's hosted checkout (lib/lasso.mjs; which methods work,
 * tested on real data: docs/research/lasso-discovery.md). Off unless started: Actions → Lasso stores → Run workflow;
 * weekly (Mondays) only with the repository variable LASSO_STORES = on.
 * Where it looks (LASSO_SOURCES, default all of them, in this order; a store several name is credited to the first):
 *   dns      who points at Lasso's checkout CNAME and its portal address: OTX and Mnemonic passive DNS, free, no key
 *   urlscan  pages that load Lasso's scripts or Whop's pixel, Lasso's checkout and portal pages (urlscan.io, free)
 *   board    the shops on the board's tables (google.mjs BOARD_SQL and the Google tab), at most BOARD_MAX new ones a run
 *   ads      Scrape Creators' Meta Ad Library search for the next keywords of lasso-keywords.txt: the shops the ads link
 *            to. Paid: LASSO_CREDITS is a hard cap of credits a run (default 50); 0, or no SCRAPECREATORS_API_KEY: off
 *   extra    lasso-extra.txt, LASSO_EXTRA ("a.com b.com") and LASSO_EXTRA_FILE (any list or CSV: a reverse-CNAME export)
 * Then every store saved before, and the domain a store's checkout sits on. Each is checked live (its page, its checkout,
 * its best sellers). The same store under another domain is one store: by the board's registrable domain, a redirect, or the
 * same Lasso store id (its other domains go into aliases). A domain checked in the last 30 days (7 when it did not answer)
 * is not checked again (D1 lasso_candidates). A store found for the first time is saved with source and found_at: the
 * board's "Lasso checkout" filter takes it in at its next read, and its chip counts it among the new stores of the week.
 *   node winner-hunter/lasso.mjs                → lasso-out/lasso-stores.csv and lasso-stores.json (LASSO_OUT: another folder)
 *   [URLSCAN_API_KEY=…]                         an urlscan.io API key (free account): more searches a day, older scans
 *   [LASSO_DAYS=30]                             how far back to search urlscan (without a key: 30 days at most)
 *   [LASSO_SOURCES="dns urlscan"]               only these sources (all: every one)
 *   [SCRAPECREATORS_API_KEY=… LASSO_CREDITS=50] the paid ad searches and their hard cap of credits a run
 *   [LASSO_KEYWORDS="a | b"]                    these keywords for the ad searches instead of the next ones of lasso-keywords.txt
 *   [LASSO_DRY_RUN=1]                           find and check, write nothing in D1 (the files still list every store)
 *   CF_API_TOKEN + CF_ACCOUNT_ID                read and save in D1 (lasso_stores, lasso_candidates, state lasso_run)
 *   LASSO_ADS=1 (+ D1 + a browser)              each store's active ads outside the EU go into world_ads with the keyword
 *                                               "lasso: <store>": the next World Hunter run puts their products in the
 *                                               🌍 Inbox under its usual rules (Shopify, an ad 7+ days old, no supplements…)
 * Red: not one source answered, D1 did not give the saved stores, or did not take the new ones. Yellow: a source failed,
 * or Scrape Creators refused the key or had no credits left (the free sources still ran).
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
import { DNS_TARGETS, reverseDns, boardStores, parseKeywords, adsClient } from './lib/lasso-sources.mjs';
import { registrable } from './worker/src/lasso.mjs';
import { ADS_SQL } from './world.mjs';
import { BOARD_SQL as BOARD_SHOPS } from './google.mjs';

const PAUSE_MS = 5000; // between two Ad Library searches (as world.mjs)
const BLOCKS_THEN_STOP = 6; // Ad Library refusals in a row: stop the ad part for this run
export const MAX_AD_SEARCHES = 150;
export const SOURCES = ['dns', 'urlscan', 'board', 'ads', 'extra'];
export const RECHECK_DAYS = 30; // a domain checked this recently is not checked again …
export const RETRY_DAYS = 7; // … one that did not answer: after a week
export const BOARD_MAX = 300; // shops of the board checked a run; the rest the next runs
export const DEFAULT_CREDITS = 50; // Scrape Creators credits a run for the ad searches (≈ $0.09 at the $47 pack)
export const MAX_CREDITS = 1000; // a LASSO_CREDITS above this is a typo
export const CURSOR_KEY = 'lasso_cursor'; // D1 state: where the ad searches go on in lasso-keywords.txt
export const RUN_KEY = 'lasso_run'; // D1 state: the last run, for the board's chip
// The board's shops: google.mjs's (EU winners of 60 days, outside the EU, TikTok's Meta shops) and the Google tab's.
export const BOARD_SQL = [...BOARD_SHOPS, ["SELECT DISTINCT store_url AS u FROM google_products WHERE active = 1 AND COALESCE(store_url, '') != ''", false]];

const COLS = ['store', 'host', 'confidence', 'live', 'script', 'lasso_store_id', 'lasso_since', 'checkout_url', 'name', 'country', 'currency', 'lang', 'products', 'best_sellers', 'how'];
const v = (c) => `json_extract(value, '$.${c}')`;
// One row per store. first_seen stays the first time it was found; last_seen is the last check that still found Lasso.
// source and found_at are written when the row is made, never after: a store saved before keeps its own (NULL: the
// research list and earlier runs, so not new).
export const STORES_SQL = `INSERT INTO lasso_stores (${COLS.join(', ')}, first_seen, last_seen, checked_at, source, found_at)
SELECT ${COLS.map(v).join(', ')}, COALESCE(${v('first_seen')}, ?2), CASE WHEN ${v('confidence')} != '' THEN ?2 END, ?2, ${v('source')}, ${v('found_at')} FROM json_each(?1) WHERE true
ON CONFLICT(store) DO UPDATE SET ${COLS.slice(1).filter((c) => c !== 'how').map((c) => `${c} = excluded.${c}`).join(', ')},
  how = CASE WHEN excluded.how != '' THEN excluded.how ELSE lasso_stores.how END,
  first_seen = MIN(COALESCE(lasso_stores.first_seen, excluded.first_seen), excluded.first_seen),
  last_seen = CASE WHEN excluded.confidence != '' THEN excluded.checked_at ELSE lasso_stores.last_seen END, checked_at = excluded.checked_at`;
// A store's aliases, all of them (the ones it had and the ones this run found under it), for the stores that gained one.
export const ALIASES_SQL = `UPDATE lasso_stores SET aliases = json_extract(x.value, '$.aliases') FROM json_each(?1) AS x
WHERE lasso_stores.store = json_extract(x.value, '$.store')`;
// Every domain checked (the saved stores apart): what it was, so it is left alone for RECHECK_DAYS.
export const CANDIDATES_SQL = `INSERT INTO lasso_candidates (domain, source, first_seen, checked_at, result, store)
SELECT ${['domain', 'source'].map(v).join(', ')}, ?2, ?2, ${['result', 'store'].map(v).join(', ')} FROM json_each(?1) WHERE true
ON CONFLICT(domain) DO UPDATE SET checked_at = excluded.checked_at, result = excluded.result, store = excluded.store`;
const KNOWN_SQL = 'SELECT store, confidence, aliases, lasso_store_id FROM lasso_stores';
const RECENT_SQL = "SELECT domain FROM lasso_candidates WHERE checked_at >= ?1 AND (result != 'down' OR checked_at >= ?2)";

const RANK = { high: 0, medium: 1, low: 2 };
const truthy = (x) => /^(1|yes|true|on)$/i.test(String(x || '').trim());
const iso = (t) => new Date(t).toISOString();
const splitList = (s) => String(s || '').split(/[\s,;]+/).filter(Boolean);
/** What a check found, for lasso_candidates. */
const resultOf = (r) => (r.confidence === 'low' ? 'left' : r.confidence ? (r.live ? 'lasso' : 'closed') : r.status && r.status < 500 ? 'no' : 'down');
const isNew = (r) => !!r.found_at && r.live === 1 && (r.confidence === 'high' || r.confidence === 'medium');

/** LASSO_SOURCES: 'all' (or nothing) or some of SOURCES; anything else throws. */
export function sourcesOf(text) {
  const list = splitList(String(text || '').toLowerCase());
  if (!list.length || list.includes('all')) return [...SOURCES];
  const bad = list.filter((s) => !SOURCES.includes(s));
  if (bad.length) throw new Error(`LASSO_SOURCES: unknown ${bad.join(', ')} (use all, or some of: ${SOURCES.join(' ')})`);
  return SOURCES.filter((s) => list.includes(s));
}

/**
 * One run. deps: { doFetch, db (optional), lib (optional: openLibrary's answer, for LASSO_ADS), key (urlscan), days, extra,
 * now, log, sleep, pauseMs, maxAdSearches, concurrency, sources, scKey + credits + keywords + rotate (the ad searches),
 * dryRun, boardMax }. → { searches, scan_errors, candidates, stores: rows with a Lasso sign, found: the stores new this run,
 * saved, skipped (checked lately), by: per source { named, checked, lasso, new }, credits, keywords, ads, ad_searches,
 * health ('ok' | 'warning' | 'failed'), alert }.
 */
export async function discover({ doFetch = globalThis.fetch, db = null, lib = null, key = '', days = 30, extra = [], now = Date.now, log = console.log,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = PAUSE_MS, maxAdSearches = MAX_AD_SEARCHES, concurrency = 4,
  sources = SOURCES, scKey = '', credits = 0, keywords = [], rotate = true, dryRun = false, boardMax = BOARD_MAX } = {}) {
  const started = now();
  const t = { searches: 0, scan_errors: 0, candidates: 0, stores: [], found: [], saved: 0, skipped: 0, by: {}, credits: null, keywords: 0, ads: 0, ad_searches: 0,
    health: 'ok', alert: '', dry_run: !!dryRun };
  for (const s of [...SOURCES, 'sister', 'saved']) t.by[s] = { named: 0, checked: 0, lasso: 0, new: 0 };
  const on = new Set(sources);
  const ran = []; // per source that ran: did it answer at all
  const problems = [];
  const fail = (msg) => Object.assign(t, { health: 'failed', alert: msg });
  const write = db && !dryRun ? db : null; // a dry run reads D1 and writes nothing

  // ---- 0. What D1 knows: the stores (their domains, aliases, Lasso store ids), and the domains checked lately ----
  const known = { rows: [], byKey: new Map(), byId: new Map(), recent: new Set() };
  if (db) {
    try {
      known.rows = await db.query(KNOWN_SQL);
      const recent = await db.query(RECENT_SQL, [iso(started - RECHECK_DAYS * 864e5), iso(started - RETRY_DAYS * 864e5)]);
      for (const r of recent) known.recent.add(r.domain);
    } catch (e) {
      return fail(`D1 did not give the saved Lasso stores: ${e.message}`), t;
    }
    // A store's own domain before another store's alias.
    for (const r of known.rows) if (registrable(r.store)) known.byKey.set(registrable(r.store), r);
    for (const r of known.rows) {
      for (const a of splitList(r.aliases)) if (registrable(a) && !known.byKey.has(registrable(a))) known.byKey.set(registrable(a), r);
      if (r.lasso_store_id && !known.byId.has(r.lasso_store_id)) known.byId.set(r.lasso_store_id, r);
    }
  }

  // ---- 1. The sources: candidates by registrable domain ----
  const found = new Map();
  const named = new Map(); // source → the domains it named
  const add = (domain, how, source, first = '', last = '') => {
    const d = hostKey(String(domain || '').toLowerCase().replace(/\.$/, ''));
    const k = registrable(d);
    if (!k) return;
    if (!named.has(source)) named.set(source, new Set());
    named.get(source).add(k);
    t.by[source].named = named.get(source).size;
    const own = known.byKey.get(k);
    const saved = !!(own && own.confidence); // checked again below anyway, under its own domain
    const at = saved ? registrable(own.store) : k;
    if (!saved && !found.has(at) && known.recent.has(k)) return void t.skipped++;
    let c = found.get(at);
    if (!c) found.set(at, (c = { domain: saved ? own.store : d, how: [], sources: [], first_seen: '', last_seen: '', saved }));
    if (how && !c.how.includes(how)) c.how.push(how);
    if (!c.sources.includes(source)) c.sources.push(source);
    if (first && (!c.first_seen || first < c.first_seen)) c.first_seen = first;
    if (last && (!c.last_seen || last > c.last_seen)) c.last_seen = last;
  };

  if (on.has('dns')) {
    // Who points at Lasso's checkout CNAME and portal address: the store is the domain the record sits under.
    let answered = 0;
    for (const target of DNS_TARGETS) {
      const got = await reverseDns(target, { doFetch, sleep });
      answered += 2 - got.failed.length;
      for (const h of got.hosts) add(registrable(h.host), `dns: ${h.via.join(' + ')}`, 'dns', h.first);
      log(`passive DNS ${target}: ${got.hosts.length} hostnames${got.failed.length ? ` (no answer from ${got.failed.map((s) => `${s}: ${got.errors[s]}`).join(', ')})` : ''}`);
    }
    ran.push(['dns', answered > 0]);
    if (answered < DNS_TARGETS.length * 2) problems.push(`passive DNS answered ${answered} of ${DNS_TARGETS.length * 2} lookups`);
  }

  if (on.has('urlscan')) {
    const scans = [];
    for (const q of URLSCAN_QUERIES) {
      const got = await sweep(q, { doFetch, key, days, now: started, sleep });
      t.searches += got.searches;
      t.scan_errors += got.errors;
      scans.push(...got.scans);
      log(`urlscan ${q}: ${got.scans.length} scans (${got.searches} searches, ${got.errors} errors)`);
    }
    for (const c of candidatesOf(scans)) for (const how of c.how) add(c.domain, how, 'urlscan', c.first_seen, c.last_seen);
    ran.push(['urlscan', t.scan_errors < t.searches]);
    if (t.scan_errors >= t.searches) problems.push(`urlscan.io answered none of ${t.searches} searches`);
    else if (t.scan_errors) problems.push(`urlscan.io did not answer ${t.scan_errors} of ${t.searches} searches: those days are searched again next run`);
  }

  if (on.has('board') && db) {
    try {
      let n = 0;
      for (const d of await boardStores(db, BOARD_SQL, { now: started })) {
        if (n >= boardMax) break;
        const before = found.size;
        add(d, 'on the board', 'board');
        if (found.size > before) n++;
      }
      ran.push(['board', true]);
    } catch (e) {
      ran.push(['board', false]);
      problems.push(`the board's shops not read: ${e.message}`);
    }
  }

  let cursor = null;
  if (on.has('ads')) {
    if (!String(scKey || '').trim()) log('ad searches: off (no SCRAPECREATORS_API_KEY)');
    else if (!(credits > 0)) log('ad searches: off (LASSO_CREDITS is 0)');
    else if (keywords.length) {
      const api = adsClient({ key: scKey, cap: credits, fetch: doFetch, sleep });
      const at = rotate && db ? Number(await db.getState(CURSOR_KEY).catch(() => 0)) || 0 : 0;
      const start = ((at % keywords.length) + keywords.length) % keywords.length;
      let answered = 0;
      let i = 0;
      for (; i < keywords.length; i++) {
        const kw = keywords[(start + i) % keywords.length];
        try {
          const got = await api.search(kw);
          answered++;
          for (const d of got.domains) add(d, `ad: ${kw}`, 'ads');
        } catch (e) {
          if (e.kind === 'cap') break; // this keyword waits for the next run
          if (e.stop) {
            problems.push(e.message); // the key, no credits, the vendor down: the free sources still count
            break;
          }
        }
      }
      t.keywords = i;
      t.credits = api.stats();
      if (rotate) cursor = (start + i) % keywords.length;
      ran.push(['ads', answered > 0]);
      log(`ad searches: ${i} keywords, ${t.credits.spent} of ${t.credits.cap} credits`);
    }
  }

  if (on.has('extra')) for (const d of domainsIn(extra.join('\n'))) add(d, 'asked for', 'extra'); // checkout.store.com → store.com

  // The stores saved before are checked again: one that left Lasso is marked, and a quiet week loses none.
  for (const r of known.rows) {
    const k = registrable(r.store);
    if (!r.confidence || !k) continue;
    if (!found.has(k)) found.set(k, { domain: r.store, how: [], sources: [], first_seen: '', last_seen: '', saved: true });
  }
  t.candidates = found.size;

  // ---- 2. Each one live; the same store under several names counted once ----
  const rows = new Map(); // registrable domain of the store → its row
  const runIds = new Map(); // Lasso store id → the row of this run that has it
  const aliases = new Map(); // store (as saved) → domains to add to its aliases
  const memory = new Map(); // registrable domain → its lasso_candidates row
  const alias = (store, d) => {
    const a = registrable(d);
    if (!a || a === registrable(store)) return;
    if (!aliases.has(store)) aliases.set(store, new Set());
    aliases.get(store).add(a);
  };
  const merge = ({ c, r }) => {
    const src = c.saved ? 'saved' : c.sources[0];
    t.by[src].checked++;
    const k = registrable(r.store) || registrable(c.domain);
    const mem = c.saved ? null : { domain: registrable(c.domain), source: src, result: resultOf(r), store: '' };
    if (mem) memory.set(mem.domain, mem);
    if (!r.confidence) {
      // A saved store that answered and shows no Lasso any more is saved as gone (its own row, wherever it answered from).
      // One that did not answer stays as it was.
      const mine = registrable(c.domain);
      if (db && c.saved && r.status && r.status < 500 && !rows.has(mine)) rows.set(mine, { ...r, store: c.domain, how: '', first_seen: null });
      return;
    }
    t.by[src].lasso++;
    // Saved before (its domain, an alias, its Lasso store id; a saved store checked again that now answers under another
    // domain is still itself), or one of this run with the same Lasso store id.
    const own = known.byKey.get(k) || (r.lasso_store_id && known.byId.get(r.lasso_store_id)) || (c.saved && known.byKey.get(registrable(c.domain))) || null;
    const home = own ? registrable(own.store) : (r.lasso_store_id && runIds.get(r.lasso_store_id)) || k;
    if (home !== k) {
      const store = own ? own.store : rows.get(home).store;
      alias(store, r.store);
      alias(store, c.domain);
      if (mem) mem.store = store;
      return;
    }
    // A saved store keeps its row (us.store.com that now answers as store.com is still us.store.com).
    const store = own ? own.store : r.store;
    if (mem) mem.store = store;
    alias(store, c.domain); // it sent us on to its store (a redirect): that domain is the store's too
    if (r.lasso_store_id && !runIds.has(r.lasso_store_id)) runIds.set(r.lasso_store_id, k);
    const old = rows.get(k);
    const how = [...new Set([...(old ? String(old.how).split('; ') : []), ...c.how])].filter(Boolean).join('; ');
    const first = [old && old.first_seen, c.first_seen].filter(Boolean).sort()[0] || null;
    const last = [old && old.last_seen, c.last_seen].filter(Boolean).sort().pop() || null; // the last scan on urlscan (D1 keeps its own)
    const fresh = !own; // never saved before, under any of its names
    const meta = { store, how, first_seen: first, last_seen: last, source: fresh ? (old && old.source) || src : null, found_at: fresh ? iso(started) : null };
    if (!old || !old.confidence || RANK[r.confidence] < RANK[old.confidence]) rows.set(k, { ...r, ...meta });
    else Object.assign(old, meta);
  };
  // Checked at the same time, merged one by one in a fixed order: a store whose checkout sits on its own domain before
  // its other names, then by domain.
  const checkAll = async (list) => {
    const got = [];
    await pool(list, concurrency, async (c) => got.push({ c, r: await checkLassoStore(c.domain, { doFetch, now: now() }) }));
    const main = (x) => (registrable(hostOf(x.r.checkout_url) || '') === registrable(x.r.store) ? 0 : 1);
    got.sort((a, b) => main(a) - main(b) || (a.c.domain < b.c.domain ? -1 : a.c.domain > b.c.domain ? 1 : 0));
    for (const x of got) merge(x);
  };
  await checkAll([...found.values()]);
  // A store's checkout can sit on another of its domains (madebybellablu.com → checkout.bellablunashville.com): that domain
  // is checked too, once. Mostly it is the same store under a second name, sometimes a sister store.
  const sisters = new Map();
  for (const r of rows.values()) {
    const d = hostKey(String(hostOf(r.checkout_url) || '').replace(/^(checkout|secure|pay)\./, ''));
    const k = registrable(d);
    if (k && k !== registrable(r.store) && !found.has(k) && !rows.has(k) && !sisters.has(k) && !known.byKey.has(k) && !known.recent.has(k)) {
      sisters.set(k, { domain: d, how: [`checkout of ${r.store}`], sources: ['sister'], first_seen: '', last_seen: '', saved: false });
      t.by.sister.named = sisters.size;
    }
  }
  t.candidates += sisters.size;
  await checkAll([...sisters.values()]);
  t.stores = [...rows.values()].filter((r) => r.confidence)
    .sort((a, b) => RANK[a.confidence] - RANK[b.confidence] || b.live - a.live || (b.products ?? 0) - (a.products ?? 0) || (a.store < b.store ? -1 : 1));
  // Every alias a store gained (the ones it had kept), on its row for the files.
  const aliasRows = [];
  for (const [store, add] of aliases) {
    const was = splitList((known.byKey.get(registrable(store)) || {}).aliases);
    const all = [...new Set([...was, ...add])].filter((a) => a !== registrable(store));
    if (all.length > was.length) aliasRows.push({ store, aliases: all.join(' ') });
    const row = rows.get(registrable(store));
    if (row) row.aliases = all.join(' ');
  }
  t.found = t.stores.filter(isNew);
  for (const r of t.found) t.by[r.source].new++;

  // ---- 3. D1 ----
  if (write) {
    const list = [...rows.values()].map((r) => ({ ...r, best_sellers: JSON.stringify(r.best_sellers || []), how: r.how || '' }));
    try {
      for (const part of chunks(list, 100)) {
        await write.query(STORES_SQL, [JSON.stringify(part), iso(now())]);
        t.saved += part.length;
      }
      for (const part of chunks(aliasRows, 200)) await write.query(ALIASES_SQL, [JSON.stringify(part)]);
      for (const part of chunks([...memory.values()], 200)) await write.query(CANDIDATES_SQL, [JSON.stringify(part), iso(now())]);
      if (cursor != null) await write.setState(CURSOR_KEY, String(cursor), now());
    } catch (e) {
      fail(`Lasso stores not saved in D1: ${e.message}`);
    }
  }

  // ---- 4. their ads outside the EU, for the hunt (LASSO_ADS) ----
  if (write && lib && t.health !== 'failed') {
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
      for (const part of chunks(ads, 200)) await write.query(ADS_SQL, [JSON.stringify(part), iso(now())]);
      t.ads = ads.length;
    } catch (e) {
      fail(`Lasso stores' ads not saved in D1: ${e.message}`);
    }
  }

  if (t.health !== 'failed') {
    if (ran.length && !ran.some(([, ok]) => ok)) fail(problems.join('; ') || 'no source answered');
    else if (problems.length) Object.assign(t, { health: 'warning', alert: problems.join('; ') });
  }
  if (write) {
    // The run for the board's chip (worker/src/lasso.mjs): counts only, no store names.
    const by = Object.fromEntries(Object.entries(t.by).filter(([, x]) => x.named || x.checked));
    await write.setState(RUN_KEY, { at: iso(now()), started_at: iso(started), health: t.health, alert: t.alert, new: t.found.length, checked: [...Object.values(t.by)].reduce((n, x) => n + x.checked, 0),
      by, credits: t.credits ? { spent: t.credits.spent, cap: t.credits.cap } : null }, now()).catch((e) => log(`::warning::run state not saved: ${e.message}`));
  }
  return t;
}

/** The files of a run: <dir>/lasso-stores.csv and lasso-stores.json. */
export function writeOut(dir, stores) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lasso-stores.csv'), toCsv(stores));
  fs.writeFileSync(path.join(dir, 'lasso-stores.json'), JSON.stringify(stores, null, 1));
}

/** The run's line for the log and the summary: counts only (a public repository's summary is public). */
export function summaryOf(t) {
  const n = (c) => t.stores.filter((r) => r.confidence === c).length;
  const per = SOURCES.concat('sister').filter((s) => t.by[s].named || t.by[s].checked).map((s) => `${s} ${t.by[s].new} new of ${t.by[s].lasso} Lasso in ${t.by[s].checked} checked`);
  return `Lasso stores: ${t.found.length} new${t.dry_run ? ' (dry run: nothing saved)' : ''}; ${t.stores.length} with Lasso (${n('high')} sure, ${n('medium')} likely, ${n('low')} left Lasso) `
    + `of ${t.candidates} checked, ${t.skipped} left alone (checked lately)` + (per.length ? `; ${per.join(', ')}` : '')
    + (t.credits ? `; ${t.credits.spent} of ${t.credits.cap} credits, ${t.keywords} keywords` : '') + `; ${t.searches} urlscan searches (${t.health})`;
}

const HERE = new URL('./', import.meta.url);

async function main() {
  const env = process.env;
  const s = d1Settings(env);
  const db = s ? d1Client(s) : null;
  const sources = sourcesOf(env.LASSO_SOURCES);
  const dryRun = truthy(env.LASSO_DRY_RUN);
  const credits = Math.min(Math.max(Math.floor(Number(env.LASSO_CREDITS ?? DEFAULT_CREDITS)) || 0, 0), MAX_CREDITS);
  const typed = String(env.LASSO_KEYWORDS || '').split('|').map((k) => k.trim().toLowerCase()).filter(Boolean);
  const keywords = typed.length ? typed : parseKeywords(fs.readFileSync(new URL('lasso-keywords.txt', HERE), 'utf8'));
  // lasso-extra.txt's comments name addresses too: they are not domains to check.
  const listed = fs.readFileSync(new URL('lasso-extra.txt', HERE), 'utf8').split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
  const extra = domainsIn([listed, env.LASSO_EXTRA || '', env.LASSO_EXTRA_FILE ? fs.readFileSync(env.LASSO_EXTRA_FILE, 'utf8') : ''].join('\n'));
  let lib = null;
  if (truthy(env.LASSO_ADS) && !dryRun) {
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
    const t = await discover({ db, lib, key: String(env.URLSCAN_API_KEY || '').trim(), days: Math.min(Math.max(Number(env.LASSO_DAYS) || 30, 1), 365), extra,
      sources, scKey: String(env.SCRAPECREATORS_API_KEY || '').trim(), credits, keywords, rotate: !typed.length, dryRun });
    writeOut(env.LASSO_OUT || 'lasso-out', t.stores);
    const line = summaryOf(t) + (db ? (dryRun ? '' : `, ${t.saved} saved in D1`) : ', not saved (no D1 settings)') + (lib ? `, ${t.ads} ads from ${t.ad_searches} Ad Library searches` : '');
    console.log(line);
    // A public repository's summary is public: counts only, the list is in the run's artifact.
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `\n**${line}.** The list (new stores have a source and found_at): this run's artifact *lasso-stores*.\n`);
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
