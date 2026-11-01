#!/usr/bin/env node
/*
 * Applies worker/migrations/*.sql to the D1 database over the REST API. Every statement is idempotent
 * (CREATE … IF NOT EXISTS; an ADD COLUMN that is already there is skipped), so this simply runs on every workflow run.
 * First it saves D1 Time Travel's bookmark in the log: the database as it was before, to go back to when a migration
 * goes wrong (README, "Undo a migration").
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… [D1_DATABASE_ID=…] node winner-hunter/migrate.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings, migrate } from './lib/d1.mjs';

const DIR = new URL('./worker/migrations/', import.meta.url);

/** D1 Time Travel's bookmark for this moment, or '' when Cloudflare does not give one. Never throws. */
export async function bookmark({ accountId, databaseId, token }, doFetch = globalThis.fetch) {
  try {
    const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/time_travel/bookmark`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const j = await res.json();
    return j && j.success && j.result && typeof j.result.bookmark === 'string' ? j.result.bookmark : '';
  } catch (e) {
    return '';
  }
}

/** The bookmark first, then the migrations. Throws when the settings are missing or a migration fails. */
export async function main({ env = process.env, doFetch = globalThis.fetch, log = console.log } = {}) {
  const s = d1Settings(env);
  if (!s) throw Object.assign(new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)'), { settings: true });
  const mark = await bookmark(s, doFetch);
  if (mark) log(`::notice title=D1 restore point::Before migrating, D1 was at bookmark ${mark}. To go back: cd winner-hunter/worker && npx wrangler d1 time-travel restore winner-hunter-clean --bookmark=${mark}`);
  else log('::warning::No D1 Time Travel bookmark before migrating (Cloudflare did not give one): to go back, restore by time (README, "Undo a migration")');
  const db = d1Client(s, { doFetch });
  const files = fs.readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort();
  const n = await migrate(db, files.map((f) => fs.readFileSync(new URL(f, DIR), 'utf8')));
  log(`D1 tables ready (${n} statements)`);
  return { n, bookmark: mark };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(e.settings ? `::error::${e.message}` : `::error::${e.message} (check that CF_API_TOKEN has Account → D1 → Edit and CF_ACCOUNT_ID is right)`);
    process.exitCode = 1;
  });
}
