#!/usr/bin/env node
/*
 * Asks Jev about every product outside the EU that it has not seen yet and stores the answers in D1 table world_checks; the
 * board shows them. Only adds data: nothing is hidden or removed here. Each product is asked once.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… TYPESAFE_API_KEY=… [JEV_MINUTES=15] node winner-hunter/world-check.mjs
 * No key, no balance or a changed API is no failed hunt: the run says so in D1 state 'world_check', and the board shows it.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings } from './lib/d1.mjs';
import { pool } from './lib/meta.mjs';
import { checkProduct, JevError, PRICE_PER_TOKEN } from './lib/jev.mjs';

const MAX_PER_RUN = 1000; // about 10 cents at 2,400 tokens a product
const AT_ONCE = 3; // 8 at once ran into waits of 4 seconds and more (2026-11-01)
const FAILS_THEN_STOP = 10;

export const TODO_SQL = `SELECT p.product_key, p.product_title AS title, p.image_url, p.store_url, COALESCE(i.product_type, '') AS type
FROM world_products p LEFT JOIN world_items i ON i.product_key = p.product_key
WHERE p.active = 1 AND p.product_key NOT IN (SELECT product_key FROM world_checks) ORDER BY p.first_seen LIMIT ${MAX_PER_RUN}`;
const LEFT_SQL = 'SELECT COUNT(*) AS n FROM world_products WHERE active = 1 AND product_key NOT IN (SELECT product_key FROM world_checks)';
export const SAVE_SQL = `INSERT INTO world_checks (product_key, model, input, people, animals, gymwear, physical, category, category_conf, tokens, checked_at)
SELECT json_extract(value, '$.key'), json_extract(value, '$.model'), json_extract(value, '$.input'), json_extract(value, '$.people'), json_extract(value, '$.animals'),
  json_extract(value, '$.gymwear'), json_extract(value, '$.physical'), json_extract(value, '$.category'), json_extract(value, '$.category_conf'), json_extract(value, '$.tokens'), ?2
FROM json_each(?1) WHERE true
ON CONFLICT(product_key) DO UPDATE SET model = excluded.model, input = excluded.input, people = excluded.people, animals = excluded.animals, gymwear = excluded.gymwear,
  physical = excluded.physical, category = excluded.category, category_conf = excluded.category_conf, tokens = excluded.tokens, checked_at = excluded.checked_at`;

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
  try {
    await pool(todo, atOnce, async (p) => {
      if (t.stopped || now() > deadline) return;
      try {
        const a = await checkProduct({ title: p.title, type: p.type, store: p.store_url, image: p.image_url }, { key, doFetch, ...(pause ? { pause } : {}) });
        rows.push({ key: p.product_key, ...a });
        t.checked++;
        t.tokens += a.tokens;
        fails = 0;
        if (rows.length >= 50) await save();
      } catch (e) {
        if (!(e instanceof JevError)) throw e; // D1: that is a real failure
        t.skipped++;
        fails++;
        log(`Jev: ${p.product_key} skipped (${e.message})`);
        if (e.stop) t.stopped = e.status === 401 || e.status === 403 ? 'the API key was refused' : e.status === 402 ? 'no balance left' : e.message;
        else if (fails >= FAILS_THEN_STOP) t.stopped = `${FAILS_THEN_STOP} failures in a row (${e.message})`;
      }
    });
  } finally {
    // Also after a failure: what is answered stays, and the board can say how far it got.
    await save().catch((e) => { lost = e; });
    const [left] = await db.query(LEFT_SQL).catch(() => [{ n: 0 }]);
    t.left = Number(left && left.n) || 0;
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
