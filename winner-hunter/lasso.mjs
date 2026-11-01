#!/usr/bin/env node
/*
 * Lasso stores (optional, off: lasso-stores.yml runs only when you start it by hand). Finds Shopify stores whose checkout
 * runs on Lasso (lassocommerce.com: a checkout with upsells and order bumps, payments through Whop) and saves their best
 * sellers. A store that pays for such a checkout runs ads as a rule: a lead for products that sell
 * (docs/research/lasso-stores.md).
 *   [CF_API_TOKEN=… CF_ACCOUNT_ID=…] [URLSCAN_API_KEY=…] [LASSO_MINUTES=20] [LASSO_DAYS=30] [LASSO_CSV=lasso.csv] node winner-hunter/lasso.mjs
 *
 * 1. Candidates, free and without a key (lib/lasso.mjs): hosts with a CNAME to Lasso's checkout (AlienVault OTX passive
 *    DNS, and DuckDuckGo's Tracker Radar), pages that called Lasso or loaded its script in the last LASSO_DAYS days
 *    (urlscan.io search; URLSCAN_API_KEY only raises the limits), and every store already in D1 (checked again, so a
 *    store that left Lasso or closed is marked 'gone').
 * 2. Each candidate is checked on the store itself: Lasso's script on its home page ('script'), or else Lasso's checkout
 *    on its checkout host ('checkout'). Nothing unverified is saved. One Shopify store on several domains is saved once.
 * 3. Per store: its best sellers (Storefront API, Shopify's own sales order; shipping protection and free gifts left out)
 *    and its number of products.
 * Saved in D1 table lasso_stores (first_seen kept) and state 'lasso_run'. Without D1 settings nothing is saved; LASSO_CSV
 * writes the stores to a file instead (a run on your own computer). The log and the summary only count: this repository
 * is public and so are its Actions logs, so no store name is ever printed.
 * Ends red when no source answered, or D1 could not be read or written; yellow when a source failed or time ran out.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings, chunks } from './lib/d1.mjs';
import { pool } from './lib/meta.mjs';
import {
  LASSO_CNAME, OLD_CNAME, URLSCAN_QUERIES, SCRIPT_HOST, otxPassiveDns, otxHosts, urlscanSearch, urlscanHosts, ddgRadar, ddgHosts, pageStore, storeOf,
  cleanHost, checkoutHostOf, checkStore, checkCheckout, shopMeta, bestSellers, catalogSize, storeKind, topProducts, adLibraryUrl,
} from './lib/lasso.mjs';

const DAY = 864e5;
const GONE_AFTER_DAYS = 120; // a store marked gone this long ago is not checked again

const COLS = ['domain', 'store_id', 'checkout_host', 'verdict', 'script', 'title', 'lang', 'currency', 'country', 'business_country', 'ships_to', 'products', 'kind', 'best', 'sources'];
export const SAVE_SQL = `INSERT INTO lasso_stores (${COLS.join(', ')}, first_seen, last_seen, checked_at)
SELECT ${COLS.map((c) => `json_extract(value, '$.${c}')`).join(', ')}, ?2, ?2, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(domain) DO UPDATE SET ${COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}, last_seen = excluded.last_seen, checked_at = excluded.checked_at`;
export const GONE_SQL = `UPDATE lasso_stores SET verdict = 'gone', checked_at = ?2 WHERE domain IN (SELECT value FROM json_each(?1))`;
export const KNOWN_SQL = `SELECT domain, checkout_host, verdict FROM lasso_stores WHERE verdict != 'gone' OR checked_at >= ?1`;

/** The candidates: Map store → { store, checkoutHost, sources: Set } from OTX answers, urlscan results, DuckDuckGo hosts and known rows. */
export function candidatesOf({ otx = [], urlscan = [], ddg = [], known = [] } = {}) {
  const out = new Map();
  const add = (store, source, checkoutHost = '') => {
    const s = cleanHost(store);
    if (!s || /(^|\.)(myshopify\.com|lassocheckout\.com|lassocommerce\.com|lassocart\.com)$/.test(s)) return;
    const c = out.get(s) || { store: s, checkoutHost: '', sources: new Set() };
    c.sources.add(source);
    if (checkoutHost && !c.checkoutHost) c.checkoutHost = cleanHost(checkoutHost);
    out.set(s, c);
  };
  for (const { target, json } of otx) for (const h of otxHosts(json, target)) add(storeOf(h.host), 'otx', h.host);
  for (const results of urlscan) {
    for (const h of urlscanHosts(results)) {
      const store = pageStore(h.host);
      add(store, 'urlscan', store !== h.host && /^(checkout|secure|pay)\./.test(h.host) ? h.host : '');
    }
  }
  for (const h of ddg) add(storeOf(h), 'ddg', h);
  for (const k of known) add(k.domain, 'known', k.checkout_host || '');
  return out;
}

/**
 * A verified store → its lasso_stores row (best, ships_to, sources: JSON text). currency and business_country are the
 * shop's own (/meta.json); ships_to: the countries it sells to, so its market.
 */
export function rowOf(c, s, verdict, checkoutHost, best, products, meta = null) {
  const script = s.lasso ? s.lasso.script || 'lasso-script' : s.marks.includes('inline') ? 'inline' : '';
  return {
    domain: c.store,
    store_id: (s.lasso && s.lasso.storeId) || '',
    checkout_host: checkoutHost,
    verdict,
    script,
    title: String((meta && meta.name) || s.siteName || s.title || '').slice(0, 120),
    lang: s.lang || '',
    currency: (meta && meta.currency) || s.currency || '',
    country: s.country || '',
    business_country: (meta && meta.country) || '',
    ships_to: JSON.stringify((meta && meta.shipsTo) || []),
    products: products ?? null,
    kind: storeKind(products),
    best: JSON.stringify(best.map((p) => ({ title: p.title, url: p.url, price: p.price, compare_at: p.compareAt, currency: p.currency, image: p.image }))),
    sources: JSON.stringify([...c.sources].sort()),
  };
}

const CSV_COLS = ['domain', 'verdict', 'checkout_host', 'title', 'lang', 'currency', 'business_country', 'ships_to', 'products', 'kind', 'best_1', 'price_1', 'url_1', 'best_2', 'price_2', 'best_3', 'price_3', 'ad_library'];
const cell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));

/** The rows as CSV (one line per store, its top 3 products). */
export function toCsv(rows) {
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) {
    const b = JSON.parse(r.best || '[]');
    const p = (i, k) => (b[i] ? b[i][k] : '');
    const ships = JSON.parse(r.ships_to || '[]');
    lines.push([r.domain, r.verdict, r.checkout_host, r.title, r.lang, r.currency, r.business_country, ships.length > 12 ? `${ships.length} countries` : ships.join(' '), r.products, r.kind, p(0, 'title'), p(0, 'price'), p(0, 'url'),
      p(1, 'title'), p(1, 'price'), p(2, 'title'), p(2, 'price'), adLibraryUrl(r.domain)].map(cell).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * cfg:  { minutes (1–60, default 20), days (urlscan look-back, default 30) }
 * deps: { db (null: nothing saved), doFetch, now, log, summary, otx(host), urlscan(query) }
 * Returns { candidates, checked, verified, script, checkout, mirrors, new, gone, saved, sources, rows, health, problems, warnings }.
 */
export async function run(cfg = {}, deps = {}) {
  const { db = null, doFetch = globalThis.fetch, now = Date.now, log = console.log, summary = () => {} } = deps;
  const otx = deps.otx || ((host) => otxPassiveDns(host, { doFetch }));
  const urlscan = deps.urlscan || ((q) => urlscanSearch(q, { doFetch }));
  const ddg = deps.ddg || (() => ddgRadar({ doFetch }));
  const start = now();
  const minutes = Math.min(Math.max(Number(cfg.minutes) || 20, 1), 60);
  const days = Math.min(Math.max(Number(cfg.days) || 30, 1), 365);
  const deadline = start + minutes * 60000;
  const iso = new Date(start).toISOString();
  const t = { candidates: 0, checked: 0, verified: 0, script: 0, checkout: 0, mirrors: 0, new: 0, gone: 0, saved: 0, sources: {}, rows: [], health: 'ok', problems: [], warnings: [] };
  const warn = (m) => {
    t.warnings.push(m);
    log(`::warning::${m}`);
  };

  // What D1 already knows: checked again (a store that left Lasso turns 'gone'). D1 not readable: nothing is saved.
  let known = [];
  let save = !!db;
  if (db) {
    try {
      known = await db.query(KNOWN_SQL, [new Date(start - GONE_AFTER_DAYS * DAY).toISOString()]);
    } catch (e) {
      save = false;
      t.problems.push(['D1 lezen mislukt', 'D1 could not be read']);
      log(`::error::Lasso stores: ${e.message}`);
    }
  }

  // 1. Candidates. A source that fails is a warning; every source failing is red.
  let answered = 0;
  const otxAnswers = [];
  for (const target of [LASSO_CNAME, OLD_CNAME]) {
    const name = 'otx ' + target.split('.')[0];
    const j = await Promise.resolve().then(() => otx(target)).catch((e) => ({ error: e.message }));
    if (j && !j.error) {
      answered++;
      otxAnswers.push({ target, json: j });
      t.sources[name] = otxHosts(j, target).length;
    } else {
      t.sources[name] = 'failed';
      warn(`OTX passive DNS (${target}) did not answer: ${(j && j.error) || 'error'}`);
    }
  }
  const urlscanAnswers = [];
  for (const q of URLSCAN_QUERIES) {
    const name = 'urlscan ' + ((/"([^"]+)"/.exec(q) || [])[1] || q.split(':')[0]);
    const r = await Promise.resolve().then(() => urlscan(`${q} AND date:>now-${days}d`)).catch((e) => ({ error: e.message, results: [] }));
    const got = (r && r.results) || [];
    if (got.length) urlscanAnswers.push(got);
    if (r && !r.error) answered++;
    t.sources[name] = r && r.error ? 'failed' : got.length;
    if (r && r.error) warn(`urlscan.io search did not answer (${r.error})${got.length ? `: ${got.length} results before that` : ''}`);
  }
  const radar = await Promise.resolve().then(ddg).catch((e) => ({ error: e.message }));
  const ddgList = radar && !radar.error ? ddgHosts(radar) : [];
  t.sources.ddg = radar && !radar.error ? ddgList.length : 'failed'; // a small extra: its failing is no warning
  if (!answered) t.problems.push(['geen bron antwoordde (OTX, urlscan.io)', 'no source answered (OTX, urlscan.io)']);
  const cands = [...candidatesOf({ otx: otxAnswers, urlscan: urlscanAnswers, ddg: ddgList, known }).values()].sort((a, b) => (a.store < b.store ? -1 : 1));
  t.candidates = cands.length;

  // 2. Each candidate checked on the store itself.
  const knownSet = new Set(known.map((k) => cleanHost(k.domain)));
  const found = [];
  const gone = [];
  let late = 0;
  await pool(cands, 6, async (c) => {
    if (now() > deadline) {
      late++;
      return;
    }
    t.checked++;
    const s = await checkStore(c.store, { doFetch });
    const script = s.live && (s.marks.includes('tag') || s.marks.includes('inline'));
    const tagHost = s.lasso ? checkoutHostOf(s.lasso.checkoutUrl) : '';
    const host = [tagHost && tagHost !== SCRIPT_HOST ? tagHost : '', c.checkoutHost, `checkout.${c.store}`].find(Boolean);
    const co = !script && s.live ? await checkCheckout(host, { doFetch }) : { lasso: false };
    const verdict = script ? 'script' : co.lasso ? 'checkout' : '';
    if (!verdict) {
      // A store that does not answer at all may be down for a moment: only a clear "no Lasso" or a closed store counts.
      if (knownSet.has(c.store) && (s.live || s.status >= 400)) gone.push(c.store);
      return;
    }
    const meta = await shopMeta(c.store, { doFetch });
    // The checkout host as far as it is known: the script's, the one that served Lasso, or the CNAME from the source.
    const checkoutHost = tagHost || (co.lasso ? host : c.checkoutHost);
    found.push({ c, s, meta, verdict, checkoutHost, shop: s.myshopify || (meta && meta.myshopify) || c.store });
  });

  // One row per Shopify store, the same domain every week: the one D1 already has, else the one with the most
  // sources, else the first by name. Its other domains are left out (counted as mirrors).
  const byShop = new Map();
  for (const f of found) byShop.set(f.shop, [...(byShop.get(f.shop) || []), f]);
  const rank = (a, b) => knownSet.has(b.c.store) - knownSet.has(a.c.store) || b.c.sources.size - a.c.sources.size || (a.c.store < b.c.store ? -1 : 1);
  const picked = [...byShop.values()].map((g) => g.sort(rank)[0]);
  t.mirrors = found.length - picked.length;

  // 3. Its best sellers and product count (without them when time is up: the store is still saved).
  await pool(picked, 6, async ({ c, s, meta, verdict, checkoutHost }) => {
    const intime = now() <= deadline;
    const b = intime ? await bestSellers(c.store, { n: 10, doFetch }) : {};
    const products = meta && meta.products != null ? meta.products : intime ? await catalogSize(c.store, { doFetch }) : null;
    t.rows.push(rowOf(c, s, verdict, checkoutHost, topProducts(b.products, 5), products, meta));
    t[verdict]++;
  });
  t.rows.sort((a, b) => (a.domain < b.domain ? -1 : 1));
  t.verified = t.rows.length;
  t.new = t.rows.filter((r) => !knownSet.has(r.domain)).length;
  t.gone = gone.length;
  if (late) warn(`Time is up (${minutes} min): ${late} of ${cands.length} candidates were not checked (next run)`);

  // Saved in D1 (counts only in the log: the repository is public).
  if (save) {
    try {
      for (const part of chunks(t.rows, 200)) {
        await db.query(SAVE_SQL, [JSON.stringify(part), iso]);
        t.saved += part.length;
      }
      for (const part of chunks(gone, 500)) await db.query(GONE_SQL, [JSON.stringify(part), iso]);
      await db.setState('lasso_run', { at: iso, candidates: t.candidates, verified: t.verified, new: t.new, gone: t.gone, sources: t.sources }, new Date(now()));
    } catch (e) {
      t.problems.push([`opslaan in D1 mislukt (${t.saved} van ${t.rows.length})`, `D1 save failed (${t.saved} of ${t.rows.length})`]);
      log(`::error::Lasso stores: ${e.message}`);
    }
  }

  t.health = t.problems.length ? 'failed' : t.warnings.length ? 'warning' : 'ok';
  const src = Object.entries(t.sources).map(([k, v]) => `${k} ${v}`).join(', ');
  const line = `Lasso stores: ${t.verified} verified (${t.script} script, ${t.checkout} checkout only) · ${t.new} new · ${t.gone} gone · ${t.mirrors} extra domains of a store · ${t.candidates} candidates (${src}) · ${db ? `${t.saved} saved in D1` : 'not saved (no D1 settings)'} · ${t.health}`;
  log(line);
  summary(`## Lasso stores ${iso.slice(0, 16).replace('T', ' ')} UTC\n\n**${line}**\n${t.problems.length ? `\nRun mislukt / Run failed: ${t.problems.map((p) => p[1]).join('; ')}\n` : ''}`);
  if (t.problems.length) log(`::error::Run mislukt: ${t.problems.map((p) => p[0]).join('; ')} / Run failed: ${t.problems.map((p) => p[1]).join('; ')}`);
  return t;
}

async function main() {
  const env = process.env;
  const key = String(env.URLSCAN_API_KEY || '').trim();
  const mask = (m) => (key.length >= 8 ? String(m).split(key).join('***') : String(m));
  const s = d1Settings(env);
  if (!s) console.log('::notice title=Lasso stores::No CF_API_TOKEN / CF_ACCOUNT_ID: nothing is saved in D1 (counts only, or LASSO_CSV)');
  const t = await run({ minutes: env.LASSO_MINUTES, days: env.LASSO_DAYS }, {
    db: s ? d1Client(s) : null,
    urlscan: (q) => urlscanSearch(q, { key }),
    log: (m) => console.log(mask(m)),
    summary: (m) => env.GITHUB_STEP_SUMMARY && fs.appendFileSync(env.GITHUB_STEP_SUMMARY, mask(m)),
  });
  if (env.LASSO_CSV) fs.writeFileSync(env.LASSO_CSV, toCsv(t.rows));
  if (t.health === 'failed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::Lasso stores: ${e.message}`);
    process.exitCode = 1;
  });
}
