#!/usr/bin/env node
/*
 * Product sheets for a batch of picks: the "Prepare" step of the daily pipeline, and a tool for one product by hand.
 * The money, the compliance list, the supplier path and the test plan come from worker/src/validate.mjs (the same code
 * the board can run). Nothing here sends anything anywhere: it reads files, optionally checks that links open (a GET
 * with a short timeout), and writes files.
 *
 *   node validate.mjs sheets --in picks.json --out dir [--day YYYY-MM-DD] [--quotes file] [--audience dir] [--check-links]
 *                            [--home NZ] [--max-seconds 120]
 *     picks.json: an array of picks, or { picks: [...] } (the pick shape: research/2026-11-05-winner-system/shared/validate-status.md)
 *     --quotes: Kungfubuy's quotation export (the raw JSON of research/2026-10-31-source-snapshots, or the flat CSV of
 *               research/2026-11-05-winner-system/wh-validate/data): a pick whose 1688 link matches a quote uses it
 *     --audience: a folder of audience cards (<id>.json, wh-audience): a pick without .audience gets its card
 *     --check-links: every product, store, ad and supplier link is opened once (cached per day in <out>/links.json)
 *   Writes <out>/<id>.json, <out>/<id>.md, <out>/index.md, <out>/sheets.csv and <out>/summary.json, and prints the summary.
 *   The same input on the same day gives the same files (the link cache keeps the checks of that day).
 *
 *   node validate.mjs paste <picks.json> <id> "<1688 link or what the 1688 app shares>"
 *     Puts the link, and the price and MOQ in the shared text, on that pick's supplier (the next sheet uses them).
 *
 *   node validate.mjs calc --name "Cooling pillowcase" --price "NZ$59.95" [--cost ¥18] [--weight 250] [--markets NZ,AU,NL]
 *     One sheet to the terminal (markdown).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sheetOf, renderSheet } from './worker/src/validate.mjs';
import { argsOf, quotesFrom, checkLinks, picksFrom, runSheets, pasteInto, linksOf } from './lib/validate.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** The audience cards of a folder: { id: card } (wh-audience's <id>.json). */
function audienceFrom(dir) {
  const out = {};
  if (!dir || !fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const card = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out[card.id || f.slice(0, -5)] = card;
    } catch (e) {
      // a card that cannot be read is left out
    }
  }
  return out;
}

async function cmdSheets(a) {
  if (!a.in || !a.out) throw new Error('usage: node validate.mjs sheets --in picks.json --out dir [--day YYYY-MM-DD] [--quotes file] [--audience dir] [--check-links] [--home NZ]');
  const day = isDay(a.day) ? a.day : today();
  const picks = picksFrom(fs.readFileSync(a.in, 'utf8'));
  const quotes = a.quotes ? quotesFrom(fs.readFileSync(a.quotes, 'utf8')) : [];
  const audience = audienceFrom(a.audience);
  fs.mkdirSync(a.out, { recursive: true });
  let links = null;
  if (a['check-links']) {
    const cacheFile = path.join(a.out, 'links.json');
    let cache = {};
    try {
      cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      cache = {};
    }
    const budgetMs = Math.max(5, Math.min(Number(a['max-seconds']) || 120, 600)) * 1000;
    links = await checkLinks(linksOf(picks), { day: today(), cache, budgetMs }); // stamped with the day it was checked, not the sheet's day
    fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(Object.entries(Object.assign({}, cache, links)).sort()), null, 2) + '\n');
  }
  const { files, summary } = await runSheets(picks, { day, quotes, audience, links, home: a.home });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(a.out, name), text);
  console.log(JSON.stringify(summary, null, 2));
  return summary.sheets > 0 || picks.length === 0 ? 0 : 1;
}

function cmdPaste(a) {
  const [file, id, ...rest] = a._;
  if (!file || !id || !rest.length) throw new Error('usage: node validate.mjs paste <picks.json> <id> "<1688 link or share text>"');
  const text = fs.readFileSync(file, 'utf8');
  const j = JSON.parse(text);
  const picks = Array.isArray(j) ? j : j.picks;
  const pick = pasteInto(picks, id, rest.join(' '));
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n');
  console.log(JSON.stringify(pick.supplier, null, 2));
  return 0;
}

function cmdCalc(a) {
  if (!a.name || !a.price) throw new Error('usage: node validate.mjs calc --name "…" --price "NZ$59.95" [--cost ¥18] [--weight 250] [--markets NZ,AU,NL] [--day YYYY-MM-DD]');
  const pick = { id: 'calc', name: String(a.name), price: String(a.price), markets: a.markets ? String(a.markets).split(',').map((s) => s.trim()) : [], source: a.source || 'world' };
  if (a.cost || a.weight) pick.supplier = { cost: a.cost ? String(a.cost) : undefined, weight_g: a.weight ? Number(a.weight) : undefined };
  const s = sheetOf(pick, { day: isDay(a.day) ? a.day : today(), settings: a.home ? { home: a.home } : {} });
  process.stdout.write(renderSheet(s));
  return 0;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const a = argsOf(rest);
  if (cmd === 'sheets') return cmdSheets(a);
  if (cmd === 'paste') return cmdPaste(a);
  if (cmd === 'calc') return cmdCalc(a);
  console.error('usage: node validate.mjs sheets | paste | calc (see the top of validate.mjs)');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(String((e && e.message) || e));
    process.exit(1);
  });
}
