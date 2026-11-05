#!/usr/bin/env node
/*
 * Audience cards for a list of products, outside the daily job (research runs, a first fill, a local test).
 * The daily job calls lib/audience.mjs audienceCard() directly; this is the same step on files.
 *
 *   node audience.mjs --picks picks.json --out cards/ [--cache data/cache] [--credits 200] [--per-pick 14]
 *                     [--markets NZ,AU] [--db board-copy.sqlite] [--only id,id] [--no-jev] [--shop]
 *
 * picks.json: a list of scored products (shared/INTERFACES.md) or research candidates { id, name, phrase, markets,
 * category: { main, sub }, ad_ids }. Env: SCRAPECREATORS_API_KEY (paid pulls, under --credits), TYPESAFE_API_KEY (Jev).
 * --db: a local SQLite copy of the board (read-only) for titles, ad copy and Jev's answers. Never the live D1.
 * Writes <out>/<id>.json, <out>/<id>.md, <out>/index.md and <out>/run.json. Prints one line per product.
 */
import fs from 'node:fs';
import path from 'node:path';
import { audienceCard, VERSION } from './lib/audience.mjs';
import { fileCache } from './lib/audience-collect.mjs';

export function parseArgs(argv) {
  const o = { picks: '', out: '', cache: '', credits: 200, perPick: 14, markets: [], db: '', only: [], jev: true, shop: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--picks') o.picks = v();
    else if (a === '--out') o.out = v();
    else if (a === '--cache') o.cache = v();
    else if (a === '--credits') o.credits = Math.max(0, Number(v()) || 0);
    else if (a === '--per-pick') o.perPick = Math.max(0, Number(v()) || 0);
    else if (a === '--markets') o.markets = String(v() || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
    else if (a === '--db') o.db = v();
    else if (a === '--only') o.only = String(v() || '').split(',').filter(Boolean);
    else if (a === '--no-jev') o.jev = false;
    else if (a === '--shop') o.shop = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.picks || !o.out) throw new Error('usage: node audience.mjs --picks picks.json --out dir [--cache dir] [--credits n] [--per-pick n] [--markets NZ,AU] [--db copy.sqlite] [--only ids] [--no-jev] [--shop]');
  return o;
}

const safeId = (s) => String(s || 'pick').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'pick';

async function sqliteQuery(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  return (sql, params = []) => db.prepare(sql).all(...params);
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const o = parseArgs(argv);
  const log = deps.log || ((m) => console.log(m));
  const picks = JSON.parse(fs.readFileSync(o.picks, 'utf8'));
  const list = (Array.isArray(picks) ? picks : picks.picks || []).filter((p) => !o.only.length || o.only.includes(p.id) || o.only.includes(p.key));
  fs.mkdirSync(o.out, { recursive: true });
  const cache = await fileCache(o.cache || path.join(o.out, '.cache'));
  const db = o.db ? await sqliteQuery(o.db) : null;
  let left = o.credits;
  const rows = [];
  const started = new Date().toISOString();
  for (const pick of list) {
    const t0 = Date.now();
    const r = await audienceCard(pick, { now: new Date().toISOString(), cache: { raw: cache }, env: { SCRAPECREATORS_API_KEY: env.SCRAPECREATORS_API_KEY, TYPESAFE_API_KEY: o.jev ? env.TYPESAFE_API_KEY : '' },
      budget: { credits: left }, perPick: o.perPick, markets: o.markets, db, shop: o.shop, fetch: deps.fetch, sleep: deps.sleep, log, jev: o.jev });
    left = Math.max(0, left - (r.credits_used || 0));
    const id = safeId(pick.id || pick.key);
    if (r.card) {
      fs.writeFileSync(path.join(o.out, `${id}.json`), JSON.stringify(r.card, null, 2));
      fs.writeFileSync(path.join(o.out, `${id}.md`), r.markdown);
    }
    const row = { id, name: r.card ? r.card.name : pick.name || '', one_line: r.one_line, phrase: r.card ? r.card.phrase : '', statements: r.card ? r.card.data.statements : 0,
      ads_with_reach: r.card ? r.card.data.ads_with_reach : 0, credits: r.credits_used || 0, jev_calls: r.jev ? r.jev.calls : 0, seconds: Math.round((Date.now() - t0) / 100) / 10, missing: r.missing };
    rows.push(row);
    log(`${id}: ${row.statements} statements, ${row.ads_with_reach} ad(s) with reach, ${row.credits} credits, Jev ${row.jev_calls} calls, ${row.seconds}s${row.missing.length ? ` | missing: ${row.missing.join('; ')}` : ''}`);
  }
  const run = { version: VERSION, started, finished: new Date().toISOString(), picks: rows.length, credits_used: o.credits - left, credits_cap: o.credits, rows };
  fs.writeFileSync(path.join(o.out, 'run.json'), JSON.stringify(run, null, 2));
  const md = ['# Audience cards', '', `Built ${run.finished.slice(0, 16).replace('T', ' ')} UTC, ${VERSION}. ${rows.length} products, ${run.credits_used} ScrapeCreators credits.`, '',
    '| Product | Audience in one line | Statements | Ads with reach | Credits | Missing |', '|---|---|---|---|---|---|',
    ...rows.map((r) => `| [${r.name.replace(/\|/g, '/')}](${r.id}.md) | ${String(r.one_line || '').replace(/\|/g, '/')} | ${r.statements} | ${r.ads_with_reach} | ${r.credits} | ${r.missing.join('; ').replace(/\|/g, '/')} |`), ''];
  fs.writeFileSync(path.join(o.out, 'index.md'), md.join('\n'));
  log(`done: ${rows.length} cards, ${run.credits_used} credits`);
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
