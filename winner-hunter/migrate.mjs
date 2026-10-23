#!/usr/bin/env node
/*
 * Applies worker/migrations/*.sql to the D1 database over the REST API. Every statement is idempotent
 * (CREATE … IF NOT EXISTS; an ADD COLUMN that is already there is skipped), so this simply runs on every workflow run.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… [D1_DATABASE_ID=…] node winner-hunter/migrate.mjs
 */
import fs from 'node:fs';
import { d1Client, d1Settings, migrate } from './lib/d1.mjs';

const s = d1Settings();
if (!s) {
  console.log('::error::No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)');
  process.exit(1);
}
const dir = new URL('./worker/migrations/', import.meta.url);
const db = d1Client(s);
try {
  const files = fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort();
  const n = await migrate(db, files.map((f) => fs.readFileSync(new URL(f, dir), 'utf8')));
  console.log(`D1 tables ready (${n} statements)`);
} catch (e) {
  console.log(`::error::${e.message} (check that CF_API_TOKEN has Account → D1 → Edit and CF_ACCOUNT_ID is right)`);
  process.exit(1);
}
