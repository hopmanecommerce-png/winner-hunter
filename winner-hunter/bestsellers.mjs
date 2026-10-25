#!/usr/bin/env node
/*
 * Store best sellers: for every product on the board (and every ★ product), its rank in its own store's best-seller
 * list (top 50, lib/bestsellers.mjs). Once a day, after the hunt (winner-hunter.yml), and for a test link
 * (preview-board.yml). Saved in D1 table `bestseller`; the board shows it on the card.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… [BS_MINUTES=15] node winner-hunter/bestsellers.mjs
 *
 * One request per store for its list, plus one per product the first time (its Shopify id). A store without a list
 * (headless, API off) is no warning: its products simply get no rank. Only a D1 failure ends red.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings, chunks, STRICT } from './lib/d1.mjs';
import { pool } from './lib/meta.mjs';
import { productKey, storeTop, productId, rankOf, addDay } from './lib/bestsellers.mjs';

const DAY = 864e5;
const KEEP_DAYS = 60; // rows not checked for this long are removed

const WANTED_SQL = `SELECT DISTINCT product_url FROM winners
WHERE product_url LIKE '%/products/%' AND ((${STRICT} AND last_seen >= ?1) OR ad_id IN (SELECT ad_id FROM stars))`;
export const SAVE_SQL = `INSERT INTO bestseller (product_key, store, product_id, rank, ok, checked_at, history)
SELECT json_extract(value, '$.key'), json_extract(value, '$.store'), json_extract(value, '$.id'), json_extract(value, '$.rank'),
  json_extract(value, '$.ok'), ?2, json_extract(value, '$.history') FROM json_each(?1) WHERE true
ON CONFLICT(product_key) DO UPDATE SET store = excluded.store, product_id = excluded.product_id, rank = excluded.rank,
  ok = excluded.ok, checked_at = excluded.checked_at, history = excluded.history`;

/**
 * deps: { db, doFetch, now, log, deadline (ms) }. Returns { products, stores, ranked, noList, saved }.
 * Throws only when D1 cannot be read or written.
 */
export async function refresh({ db, doFetch = globalThis.fetch, now = Date.now, log = console.log, deadline = Infinity }) {
  const start = now();
  const day = new Date(start).toISOString().slice(0, 10);
  const wanted = await db.query(WANTED_SQL, [new Date(start - 45 * DAY).toISOString()]);
  const known = new Map((await db.query('SELECT product_key, product_id, history FROM bestseller')).map((r) => [r.product_key, r]));

  // Products by store; one product page once.
  const byStore = new Map();
  for (const { product_url: url } of wanted) {
    const key = productKey(url);
    if (!key) continue;
    const store = key.split('/')[0];
    if (!byStore.has(store)) byStore.set(store, new Map());
    byStore.get(store).set(key, url);
  }

  const rows = [];
  const t = { products: 0, stores: byStore.size, ranked: 0, noList: 0, saved: 0 };
  await pool([...byStore], 6, async ([store, products]) => {
    if (now() > deadline) return;
    const { top, error } = await storeTop(store, { doFetch });
    if (!top) t.noList++;
    for (const [key, url] of products) {
      const old = known.get(key);
      let history = [];
      try {
        history = JSON.parse((old && old.history) || '[]');
      } catch (e) {
        history = [];
      }
      const handle = key.split('/products/')[1];
      let id = (old && old.product_id) || null;
      let rank = null;
      if (top) {
        rank = rankOf(top, { id, handle });
        if (!id && rank) id = top[rank - 1].id;
        if (!id && now() < deadline) {
          id = await productId(url, { doFetch });
          if (id) rank = rankOf(top, { id, handle });
        }
        history = addDay(history, day, rank);
      }
      if (rank) t.ranked++;
      t.products++;
      // No list today: the rank is unknown (ok 0), the history stays as it was.
      rows.push({ key, store, id, rank: top ? rank : null, ok: top ? 1 : 0, history: JSON.stringify(history), error });
    }
  });

  const iso = new Date(now()).toISOString();
  for (const part of chunks(rows.map(({ error, ...r }) => r), 200)) {
    await db.query(SAVE_SQL, [JSON.stringify(part), iso]);
    t.saved += part.length;
  }
  await db.query('DELETE FROM bestseller WHERE checked_at < ?1', [new Date(start - KEEP_DAYS * DAY).toISOString()]);
  log(`Store best sellers: ${t.products} products in ${t.stores} stores · ${t.ranked} in their store's top 50 · ${t.noList} stores give no list`);
  return t;
}

async function main() {
  const s = d1Settings();
  if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)');
  const minutes = Math.min(Math.max(Number(process.env.BS_MINUTES) || 15, 1), 60);
  const t = await refresh({ db: d1Client(s), deadline: Date.now() + minutes * 60000 });
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**Store best sellers:** ${t.products} products in ${t.stores} stores, ${t.ranked} in their store's top 50, ${t.noList} stores give no list.\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::Store best sellers: ${e.message}`);
    process.exitCode = 1;
  });
}
