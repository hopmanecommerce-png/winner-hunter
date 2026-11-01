#!/usr/bin/env node
/*
 * Loads TikTok products into D1 for the board's TikTok tab. Updates what it knows, keeps your Approved and Reject decisions,
 * and removes undecided products that are no longer in the file.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… node winner-hunter/tiktok-import.mjs rows.json
 * rows.json: an array with the fields in lib/tiktok.mjs.
 */
import fs from 'node:fs';
import { chunks, d1Client, d1Settings } from './lib/d1.mjs';
import { PRUNE_SQL, UPSERT_SQL, validateRows } from './lib/tiktok.mjs';

const file = process.argv[2];
if (!file) throw new Error('Usage: tiktok-import.mjs rows.json');
const s = d1Settings();
if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID');
const rows = validateRows(JSON.parse(fs.readFileSync(file, 'utf8')));
const db = d1Client(s);
for (const part of chunks(rows)) await db.query(UPSERT_SQL, [JSON.stringify(part)]);
await db.query(PRUNE_SQL, [JSON.stringify(rows.map((r) => r.id))]);
const [{ n }] = await db.query('SELECT COUNT(*) AS n FROM tiktok_products');
console.log(`Imported ${rows.length} rows, ${n} in the table`);
