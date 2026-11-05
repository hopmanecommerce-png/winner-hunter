#!/usr/bin/env node
/*
 * The Winner Score from the command line: rank every product, or run the backtest, on D1 or on a local copy.
 *   node winner-hunter/winner-score.mjs rank --local copy.sqlite [--tiktok-csv export.csv] [--top 30] [--out dir] [--day YYYY-MM-DD]
 *   node winner-hunter/winner-score.mjs backtest --local copy.sqlite [--cutoff 2026-10-31] [--out dir]
 *   (CF_API_TOKEN and CF_ACCOUNT_ID instead of --local read the live board; it only reads.)
 * rank writes top.json (the scored products of shared/INTERFACES.md), top.csv and top.md (a ranked table plus the same list
 * sorted by break-even CPA, a plain fact). backtest writes backtest.json and backtest.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings } from './lib/d1.mjs';
import { tablesFrom, factsFrom, localDb } from './lib/winner-facts.mjs';
import { scoreAll, learnNiche } from './lib/winner-score.mjs';
import { selectDaily, RULES } from './lib/daily-picks.mjs';
import { backtest, backtestMd } from './lib/score-backtest.mjs';
import { bangkokDay } from './lib/daily-digest.mjs';
import { parseCsv, toCsv } from './lib/csv.mjs';

/** The top n by the daily rules (the bar, dedupe and a looser rotation: up to 5 a category), for a one-off list. */
export function topList(ranked, { n = 30, decided = new Set(), day } = {}) {
  return selectDaily(ranked, { day, decided, rules: { ...RULES, max: n, min: Math.min(5, n), perCategory: Math.max(5, Math.ceil(n / 6)) } });
}

const md = (picks) => {
  const row = (p) => `| ${p.pick} | [${p.name.replace(/\|/g, '/').slice(0, 60)}](${(p.links && (p.links.product_url || p.links.tiktok)) || ''}) | ${p.src} | ${p.category || ''} | ${p.score} | ${p.level}/4 | ${['proof', 'demand', 'competition', 'margin', 'fit'].map((k) => p.pillars[k].toFixed(2)).join(' / ')} | ${p.risk.mult} | ${p.econ ? '€' + Math.round(p.econ.breakeven_cpa_eur) + (p.econ.supplier === 'est' ? ' est.' : '') : 'n/a'} | ${p.why.replace(/\|/g, '/')} |`;
  const head = '| # | Product | Source | Category | Score | Ladder | Proof / demand / competition / margin / fit | Risk × | Break-even CPA | Why |\n|---:|---|---|---|---:|---|---|---:|---:|---|';
  const byCpa = picks.slice().sort((a, b) => ((b.econ && b.econ.breakeven_cpa_eur) || 0) - ((a.econ && a.econ.breakeven_cpa_eur) || 0));
  return `## Ranked by Winner Score\n\n${head}\n${picks.map(row).join('\n')}\n\n## The same products by break-even CPA (a plain fact, highest first)\n\n${head}\n${byCpa.map(row).join('\n')}\n`;
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = {};
  for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) a[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  const db = a.local ? await localDb(a.local) : d1Settings() ? d1Client(d1Settings()) : null;
  if (!db || !['rank', 'backtest'].includes(cmd)) {
    console.error('usage: winner-score.mjs rank|backtest --local <sqlite> [--tiktok-csv f] [--top 30] [--out dir] [--day d] [--cutoff d]');
    process.exitCode = 1;
    return;
  }
  const day = a.day || bangkokDay();
  const out = a.out || '.';
  fs.mkdirSync(out, { recursive: true });
  const t = await tablesFrom(db, { tiktok: !a['tiktok-csv'] });
  const tiktokRows = a['tiktok-csv'] ? parseCsv(fs.readFileSync(a['tiktok-csv'], 'utf8')) : null;
  const built = factsFrom(t, { tiktokRows });
  if (cmd === 'backtest') {
    const b = backtest(built.facts.filter((f) => built.decisions.some((d) => d.key === f.key)), built.decisions, { day, cutoff: a.cutoff || null, ctx: { econSettings: t.econSettings } });
    fs.writeFileSync(path.join(out, 'backtest.json'), JSON.stringify(b, null, 1));
    fs.writeFileSync(path.join(out, 'backtest.md'), backtestMd(b));
    console.log(`backtest: ${b.n} decisions, AUC ${b.auc_prior}, cross-validated ${b.cv.mean} (policy ${b.cv_policy.mean}); ${path.join(out, 'backtest.md')}`);
    return;
  }
  const cats = new Map(built.facts.map((f) => [f.key, (f.jev && f.jev.main) || f.category || 'Other']));
  const niche = learnNiche(built.decisions.map((d) => ({ y: d.y, cat: cats.get(d.key) || 'Other' })));
  const { ranked, gated } = scoreAll(built.facts, { day, niche, econSettings: t.econSettings });
  const top = topList(ranked, { n: Number(a.top || 30), decided: built.decided, day });
  const list = top.picks.map((p) => ({ ...p, rank: p.pick }));
  fs.writeFileSync(path.join(out, 'top.json'), JSON.stringify({ day, generated_at: new Date().toISOString(), scored: ranked.length + gated.length, passed: top.passed, skipped: top.skipped, picks: list }, null, 1));
  fs.writeFileSync(path.join(out, 'top.csv'), toCsv(list.map((p) => ({ rank: p.rank, key: p.key, name: p.name, src: p.src, category: p.category, score: p.score, level: p.level, ...p.pillars, risk: p.risk.mult,
    flags: p.risk.flags.join('; '), price_eur: p.econ ? p.econ.price_eur : '', breakeven_cpa_eur: p.econ ? p.econ.breakeven_cpa_eur : '', supplier: p.econ ? p.econ.supplier : '', why: p.why,
    product_url: p.links.product_url || '', ad_library: p.links.ad_library || '' })), ['rank', 'key', 'name', 'src', 'category', 'score', 'level', 'proof', 'demand', 'competition', 'margin', 'fit', 'risk', 'flags', 'price_eur', 'breakeven_cpa_eur', 'supplier', 'why', 'product_url', 'ad_library']));
  fs.writeFileSync(path.join(out, 'top.md'), md(list));
  console.log(`rank: ${ranked.length} ranked, ${gated.length} gated, ${top.passed} passed the bar; top ${list.length} in ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
