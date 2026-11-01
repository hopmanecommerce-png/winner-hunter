#!/usr/bin/env node
/*
 * Asks Jev about the products outside the EU it has no answers for and stores them in D1 table world_checks; the board
 * shows them. Only adds data: nothing is hidden or removed here. A product is asked again when the questions change, and
 * once more when its ad's words become known. Then the EU's products, then the Google tab's (google.mjs), with what is left.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… TYPESAFE_API_KEY=… [JEV_MINUTES=15] node winner-hunter/world-check.mjs
 * No key, no balance or a changed API is no failed hunt: the run says so in D1 state 'world_check', and the board shows it.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings } from './lib/d1.mjs';
import { pool } from './lib/meta.mjs';
import { checkProduct, JevError, PRICE_PER_TOKEN } from './lib/jev.mjs';
import { VERSION } from './worker/src/jev-questions.mjs';
import { EU_TODO_SQL, EU_LEFT_SQL } from './worker/src/app.mjs';
import { productKey } from './lib/bestsellers.mjs';

const MAX_PER_RUN = 1000; // about 40 cents at 10,000 tokens a product
const AT_ONCE = 3; // 8 at once ran into waits of 4 seconds and more (2026-11-01)
const FAILS_THEN_STOP = 10;

// New products; those answered by an older question set; and, once more, those answered before their ad's words were known.
export const TODO_SQL = `SELECT p.product_key, p.product_title AS title, p.image_url, p.store_url, p.price, p.compare_at_price, p.currency, p.store_products, p.advertiser, p.likes, p.keyword,
  p.markets, p.ads, p.days, p.new14, p.creatives, COALESCE(i.product_type, '') AS type
FROM world_products p LEFT JOIN world_items i ON i.product_key = p.product_key LEFT JOIN world_checks c ON c.product_key = p.product_key
WHERE p.active = 1 AND (c.product_key IS NULL OR COALESCE(c.version, 1) < ${VERSION}
  OR (COALESCE(c.ad_text, 0) = 0 AND p.product_key IN (SELECT product_key FROM world_ads WHERE product_key != '' AND COALESCE(body, '') != '')))
ORDER BY p.first_seen LIMIT ${MAX_PER_RUN}`;
const LEFT_SQL = `SELECT COUNT(*) AS n FROM world_products p LEFT JOIN world_checks c ON c.product_key = p.product_key WHERE p.active = 1 AND (c.product_key IS NULL OR COALESCE(c.version, 1) < ${VERSION})`;
const ADS_OF_SQL = `SELECT a.product_key, a.title, COALESCE(a.body, '') AS body, a.image_url, a.copies, a.last_seen FROM world_ads a WHERE a.product_key IN (SELECT value FROM json_each(?1)) ORDER BY a.copies DESC, a.last_seen DESC`;
const COLS = ['key', 'model', 'input', 'people', 'animals', 'gymwear', 'physical', 'category', 'category_conf', 'tokens', 'version', 'main', 'sub', 'main_conf', 'sub_conf', 'product_score', 'ad_score', 'answers', 'used', 'ad_text'];
const DB_COLS = (c) => (c === 'key' ? 'product_key' : c);
export const SAVE_SQL = `INSERT INTO world_checks (${COLS.map(DB_COLS).join(', ')}, checked_at)
SELECT ${COLS.map((c) => `json_extract(value, '$.${c}')`).join(', ')}, ?2 FROM json_each(?1) WHERE true
ON CONFLICT(product_key) DO UPDATE SET ${COLS.filter((c) => c !== 'key').map((c) => `${c} = excluded.${c}`).join(', ')}, checked_at = excluded.checked_at`;

// The Google tab's products (google.mjs), with what is left of the run after the ones outside the EU and the EU's. Saved under
// 'google|' + the product page. A product page Jev already answered for outside the EU is not asked again: the board uses that answer.
const GOOGLE_WHERE = `g.active = 1 AND (c.product_key IS NULL OR COALESCE(c.version, 1) < ${VERSION}) AND (w.product_key IS NULL OR COALESCE(w.version, 1) < ${VERSION})`;
export const GOOGLE_TODO_SQL = `SELECT g.product_key, g.product_title AS title, g.image_url, g.store_url, g.price, g.compare_at_price, g.currency, g.store_products, g.advertiser, g.keyword,
  g.copies, g.days, g.regions, COALESCE(g.product_type, '') AS type
FROM google_products g LEFT JOIN world_checks c ON c.product_key = 'google|' || g.product_key LEFT JOIN world_checks w ON w.product_key = g.product_key
WHERE ${GOOGLE_WHERE} ORDER BY g.first_seen LIMIT ?1`;
export const GOOGLE_LEFT_SQL = `SELECT COUNT(*) AS n FROM google_products g LEFT JOIN world_checks c ON c.product_key = 'google|' || g.product_key LEFT JOIN world_checks w ON w.product_key = g.product_key WHERE ${GOOGLE_WHERE}`;
const GOOGLE_ADS_SQL = "SELECT product_key, headline, image_url FROM google_ads WHERE product_key IN (SELECT value FROM json_each(?1)) AND COALESCE(headline, '') != '' ORDER BY seen_at DESC";

/** A Google product's ads for Jev: their headlines (the words Google shows), the first picture, where they ran. */
export function googleAdsOf(rows, p) {
  let countries = [];
  try {
    countries = JSON.parse(p.regions || '[]');
  } catch (e) {
    countries = [];
  }
  return { titles: [...new Set(rows.map((r) => String(r.headline || '').trim()).filter(Boolean))].slice(0, 5), texts: [], image: (rows.find((r) => r.image_url) || {}).image_url || '',
    countries: Array.isArray(countries) ? countries : [], count: p.copies ?? null, days: p.days ?? null, new14: null, creatives: p.copies ?? null };
}

/** The ads of a product, the ones with the most copies first: unique titles and words, and the first picture. */
export function adsOf(rows, product) {
  const uniq = (xs, n) => [...new Set(xs.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, n);
  let countries = [];
  try {
    countries = Object.keys(JSON.parse(product.markets || '{}'));
  } catch (e) {
    countries = [];
  }
  return { titles: uniq(rows.map((r) => r.title), 5), texts: uniq(rows.map((r) => r.body), 3), image: (rows.find((r) => r.image_url) || {}).image_url || '',
    countries, count: product.ads ?? null, days: product.days ?? null, new14: product.new14 ?? null, creatives: product.creatives ?? null };
}

/** The ad's words saved with an EU product. */
export function copyOf(data) {
  try {
    const c = JSON.parse(data || '{}').ad_copy;
    return c ? [String(c)] : [];
  } catch (e) {
    return [];
  }
}

export async function checkAll({ db, key, doFetch = globalThis.fetch, now = Date.now, log = console.log, deadline = Infinity, pause, atOnce = AT_ONCE }) {
  const when = () => new Date(now()).toISOString();
  const t = { checked: 0, skipped: 0, left: 0, tokens: 0, stopped: '' };
  if (!key) {
    t.stopped = 'no TYPESAFE_API_KEY';
    log(`Jev check skipped: ${t.stopped}`);
    await db.setState('world_check', { ...t, at: when(), cost: 0 });
    return t;
  }
  const todo = await db.query(TODO_SQL);
  // Outside the EU first, the EU's with what is left of this run. EU pictures are old Facebook links: one that is gone is no reason to skip.
  const eu = todo.length < MAX_PER_RUN ? await db.query(EU_TODO_SQL, [when(), MAX_PER_RUN - todo.length]) : [];
  // Then the Google tab's. A database without its table yet: none.
  const room = MAX_PER_RUN - todo.length - eu.length;
  const google = room > 0 ? await db.query(GOOGLE_TODO_SQL, [room]).catch((e) => { if (/no such table/i.test(e.message)) return []; throw e; }) : [];
  const adsBy = new Map();
  if (todo.length) {
    for (const a of await db.query(ADS_OF_SQL, [JSON.stringify(todo.map((p) => p.product_key))])) {
      if (!adsBy.has(a.product_key)) adsBy.set(a.product_key, []);
      adsBy.get(a.product_key).push(a);
    }
  }
  const gAdsBy = new Map();
  if (google.length) {
    for (const a of await db.query(GOOGLE_ADS_SQL, [JSON.stringify(google.map((p) => p.product_key))])) {
      if (!gAdsBy.has(a.product_key)) gAdsBy.set(a.product_key, []);
      gAdsBy.get(a.product_key).push(a);
    }
  }
  const rows = [];
  let fails = 0;
  let lost = null;
  const save = async () => {
    const part = rows.splice(0);
    if (!part.length) return;
    try {
      await db.query(SAVE_SQL, [JSON.stringify(part), when()]);
    } catch (e) {
      rows.push(...part); // paid for: the next save takes them along
      throw e;
    }
  };
  const jobs = [
    ...todo.map((p) => ({ id: p.product_key, label: p.product_key, what: { key: p.product_key, title: p.title, type: p.type, store: p.store_url, image: p.image_url, price: p.price, was: p.compare_at_price, currency: p.currency,
      products: p.store_products, advertiser: p.advertiser, likes: p.likes, keyword: p.keyword, ads: adsOf(adsBy.get(p.product_key) || [], p) } })),
    ...eu.map((p) => ({ id: 'eu|' + p.gk, label: p.store_url || p.gk, what: { key: productKey(p.product_url), title: p.title, store: p.store_url, image: p.image_url, must: false, price: p.price, was: p.compare_at_price, currency: p.currency,
      advertiser: p.advertiser, keyword: p.keyword, ads: { titles: [p.title], texts: copyOf(p.data), count: p.ads ?? null, days: p.days ?? null, countries: [] } } })),
    ...google.map((p) => ({ id: 'google|' + p.product_key, label: p.product_key, what: { key: p.product_key, title: p.title, type: p.type, store: p.store_url, image: p.image_url, price: p.price, was: p.compare_at_price,
      currency: p.currency, products: p.store_products, advertiser: p.advertiser, keyword: p.keyword, ads: googleAdsOf(gAdsBy.get(p.product_key) || [], p) } })),
  ];
  try {
    await pool(jobs, atOnce, async (job) => {
      if (t.stopped || now() > deadline) return;
      try {
        const a = await checkProduct(job.what, { key, doFetch, ...(pause ? { pause } : {}) });
        rows.push({ key: job.id, ...a });
        t.checked++;
        t.tokens += a.tokens;
        fails = 0;
        if (rows.length >= 50) await save();
      } catch (e) {
        if (!(e instanceof JevError)) throw e; // D1: that is a real failure
        t.skipped++;
        fails++;
        log(`Jev: ${job.label} skipped (${e.message})`);
        if (e.stop) t.stopped = e.status === 401 || e.status === 403 ? 'the API key was refused' : e.status === 402 ? 'no balance left' : e.message;
        else if (fails >= FAILS_THEN_STOP) t.stopped = `${FAILS_THEN_STOP} failures in a row (${e.message})`;
      }
    });
  } finally {
    // Also after a failure: what is answered stays, and the board can say how far it got.
    await save().catch((e) => { lost = e; });
    const [left] = await db.query(LEFT_SQL).catch(() => [{ n: 0 }]);
    const [euLeft] = await db.query(EU_LEFT_SQL, [when()]).catch(() => [{ n: 0 }]);
    const [gLeft] = await db.query(GOOGLE_LEFT_SQL).catch(() => [{ n: 0 }]);
    t.left = (Number(left && left.n) || 0) + (Number(euLeft && euLeft.n) || 0) + (Number(gLeft && gLeft.n) || 0);
    await db.setState('world_check', { ...t, at: when(), cost: Math.round(t.tokens * PRICE_PER_TOKEN * 1e4) / 1e4 }).catch(() => {});
  }
  if (lost) throw lost;
  log(`Jev: ${t.checked} products checked, ${t.skipped} skipped, ${t.left} left, about $${(t.tokens * PRICE_PER_TOKEN).toFixed(4)}${t.stopped ? `, stopped: ${t.stopped}` : ''}`);
  return t;
}

async function main() {
  const s = d1Settings(process.env);
  if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID');
  const minutes = Math.min(Math.max(Number(process.env.JEV_MINUTES) || 15, 1), 60);
  const t = await checkAll({ db: d1Client(s), key: String(process.env.TYPESAFE_API_KEY || '').trim(), deadline: Date.now() + minutes * 60000 });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**Jev:** ${t.checked} products checked, ${t.skipped} skipped, ${t.left} left${t.stopped ? `, stopped: ${t.stopped}` : ''}.\n`);
  if (t.stopped) console.log(`::warning::Jev check stopped: ${t.stopped}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}
