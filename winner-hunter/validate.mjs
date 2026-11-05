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
import { VALIDATE, sheetOf, renderSheet, digestOf, csvRow, CSV_COLS } from './worker/src/validate.mjs';
import { fromPaste, cleanUrl, platformOf } from './worker/src/sourcing.mjs';

const today = () => new Date().toISOString().slice(0, 10);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const safeName = (id) => String(id).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'product';

const SWITCHES = new Set(['check-links']); // flags that never take a value

/** argv after the command into { _: [positional], flag: value | true }. */
export function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (SWITCHES.has(k) || v == null || v.startsWith('--')) out[k] = true;
      else {
        out[k] = v;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kungfubuy quotes
// ---------------------------------------------------------------------------

const unesc = (s) => String(s || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const offerOf = (u) => (/1688\.com\/offer\/(\d{6,20})\.html/.exec(unesc(u)) || [])[1] || '';

/** One CSV line into fields (quotes and doubled quotes as in RFC 4180). */
function csvFields(line) {
  const o = [];
  let c = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        c += '"';
        i++;
      } else if (ch === '"') q = false;
      else c += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      o.push(c);
      c = '';
    } else c += ch;
  }
  o.push(c);
  return o;
}

/**
 * Kungfubuy quotes as the kit takes them: [{ id, day, offer (its 1688 offer id), asked (the link you sent), sku, spec,
 * country, goods_cny, weight_g, eur: [1..5 units] }], from the raw quotation export (JSON) or the flat CSV. Quotes
 * without a price are left out.
 */
export function quotesFrom(text) {
  const t = String(text || '').trim();
  const out = [];
  if (t.startsWith('[') || t.startsWith('{')) {
    const j = JSON.parse(t);
    for (const q of Array.isArray(j) ? j : j.quotes || []) {
      if (q.eur && q.id) {
        out.push(q); // already in the kit's shape
        continue;
      }
      const p = (q.product || [])[0] || {};
      const oi = Array.isArray(p.order_items) ? p.order_items[0] : p.order_items;
      let ri = {};
      try {
        ri = JSON.parse(unesc(p.relates_information)) || {};
      } catch (e) {
        ri = {};
      }
      for (const [country, v] of Object.entries(ri)) {
        const eur = [v.nameOne, v.nameTwo, v.nameThree, v.nameFour, v.nameFive].map((x) => Number(x) || 0);
        if (!eur[0]) continue;
        const w = Math.max(Number(oi && oi.weight) || 0, Number(oi && oi.quotation_weight) || 0);
        out.push({ id: q.order_no, day: String(q.create_at || '').slice(0, 10), offer: offerOf(oi && oi.goods_url), asked: unesc(p.un_good_url || ''), sku: (oi && oi.goods_sku) || '',
          spec: (oi && oi.goods_spec) || '', country, goods_cny: Number(oi && oi.price_selling) || 0, weight_g: w || null, eur });
      }
    }
    return out;
  }
  const lines = t.split(/\r?\n/);
  const h = csvFields(lines[0]);
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const r = Object.fromEntries(csvFields(line).map((v, i) => [h[i], v]));
    const eur = [r.eur1, r.eur2, r.eur3, r.eur4, r.eur5].map((x) => Number(x) || 0);
    if (!eur[0]) continue;
    const w = Math.max(Number(r.weight_g) || 0, Number(r.quote_weight_g) || 0);
    out.push({ id: r.order_no, day: String(r.created || '').slice(0, 10), offer: offerOf(r.link_1688), asked: r.asked_link || '', sku: r.sku || '', spec: r.spec || '', country: r.country,
      goods_cny: Number(r.goods_cny) || 0, weight_g: w || null, eur });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Link checks
// ---------------------------------------------------------------------------

/**
 * Whether each link opens: a GET (redirects followed) with a timeout, a few at a time, within a time budget. Returns
 * { url: { ok, status, checked } }; a link checked on `day` before (cache) is not checked again. A 403 or 429 from a bot
 * wall counts as "did not open" with its status, so the sheet says so rather than guessing.
 */
export async function checkLinks(urls, { day = today(), cache = {}, fetch: doFetch = globalThis.fetch, timeoutMs = 8000, budgetMs = 60000, at = 3 } = {}) {
  const out = {};
  const todo = [];
  for (const u of [...new Set(urls.filter((x) => typeof x === 'string' && /^https:\/\//i.test(x)))]) {
    if (cache[u] && cache[u].checked === day) out[u] = cache[u];
    else todo.push(u);
  }
  const end = Date.now() + budgetMs;
  const one = async (u) => {
    if (Date.now() > end) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await doFetch(u, { method: 'GET', redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'Mozilla/5.0 (link check)', accept: 'text/html,*/*' } });
      out[u] = { ok: res.status >= 200 && res.status < 400, status: res.status, checked: day };
      try {
        await res.body?.cancel?.();
      } catch (e) {
        // the body is not needed
      }
    } catch (e) {
      out[u] = { ok: false, status: e && e.name === 'AbortError' ? 'timeout' : 'error', checked: day };
    } finally {
      clearTimeout(timer);
    }
  };
  for (let i = 0; i < todo.length; i += at) await Promise.all(todo.slice(i, i + at).map(one));
  return out;
}

// ---------------------------------------------------------------------------
// A batch
// ---------------------------------------------------------------------------

/** The picks of a file: an array, or { picks }. */
export function picksFrom(text) {
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : Array.isArray(j.picks) ? j.picks : [];
  return list.filter((p) => p && typeof p === 'object' && (p.id || p.name));
}

/** The index page: every sheet in one table, sorted by a plain fact (the break-even CPA in its test market, most first). */
export function indexOf(sheets, day) {
  const rows = sheets.map((s) => ({ s, d: digestOf(s) })).sort((a, b) => (b.d.be_cpa_eur ?? -1) - (a.d.be_cpa_eur ?? -1) || a.s.name.localeCompare(b.s.name));
  const L = [`# Product sheets, ${day}`, '', `${sheets.length} sheet${sheets.length === 1 ? '' : 's'}, sorted by break-even CPA in the test market (most room for ads first). Verdict: the 💶 thresholds and the risk radar. "est." = the supplier price is still an estimate.`, '',
    '| Product | Market | Price | Margin | Break-even CPA | Break-even ROAS | Verdict | Main blocker | Test |', '|---|---|---:|---:|---:|---:|---|---|---|'];
  for (const { s, d } of rows) {
    const m = s.economics.markets[0];
    const o = m && m.offers[0];
    const t = s.test_plan;
    L.push(`| [${s.name.replace(/\|/g, '\\|')}](${safeName(s.id)}.md) | ${d.market || '–'} | ${o ? '€' + o.price.toFixed(2) : '–'} | ${d.margin_eur != null ? '€' + d.margin_eur.toFixed(2) : '–'}${d.cost_status && d.cost_status !== 'fact' ? ' est.' : ''} | ${d.be_cpa_eur != null ? '€' + d.be_cpa_eur.toFixed(2) : '–'} | ${d.be_roas != null ? d.be_roas + '×' : '–'} | ${s.level} | ${d.main_blocker.replace(/\|/g, '\\|')} | ${t.go ? `€${t.budget} (${t.mode})` : 'no'} |`);
  }
  return L.join('\n') + '\n';
}

/**
 * Sheets for a batch, in memory: { sheets, files: { name: text }, summary }. A pick that fails is in summary.failed with
 * its error; the others still get their sheet.
 */
export async function runSheets(picks, { day = today(), quotes = [], audience = {}, links = null, home, settings } = {}) {
  const started = Date.now();
  const sheets = [];
  const failed = [];
  const files = {};
  const opts = { day, quotes, links: links || {}, settings: Object.assign({}, settings || {}, home ? { home } : {}) };
  const seen = new Set();
  for (const raw of picks) {
    let pick = raw;
    try {
      pick = Object.assign({}, raw);
      if (!pick.audience && pick.id && audience[pick.id]) pick.audience = audience[pick.id];
      const s = sheetOf(pick, opts);
      let name = safeName(s.id);
      while (seen.has(name)) name += '-2';
      seen.add(name);
      sheets.push(s);
      files[name + '.json'] = JSON.stringify(s, null, 2) + '\n';
      files[name + '.md'] = renderSheet(s);
    } catch (e) {
      let id = '?';
      try {
        id = String((raw && (raw.id || raw.name)) || '?');
      } catch (e2) {
        id = '?';
      }
      failed.push({ id, error: String((e && e.message) || e).slice(0, 300) });
    }
  }
  files['index.md'] = indexOf(sheets, day);
  files['sheets.csv'] = [CSV_COLS.join(','), ...sheets.map(csvRow)].join('\n') + '\n';
  const count = (f) => sheets.filter(f).length;
  const summary = {
    day, version: VALIDATE.VERSION, picks: picks.length, sheets: sheets.length, failed,
    levels: { green: count((s) => s.level === 'green'), amber: count((s) => s.level === 'amber'), red: count((s) => s.level === 'red') },
    blocked: count((s) => s.compliance.level === 'block'), tests: count((s) => s.test_plan.go), estimated_cost: count((s) => s.economics.inputs.cost && s.economics.inputs.cost.status !== 'fact'),
    links: links ? { checked: Object.keys(links).length, broken: Object.values(links).filter((x) => !x.ok).length } : null,
    digest: sheets.map((s) => Object.assign({ id: s.id, name: s.name }, digestOf(s))), ms: Date.now() - started,
  };
  files['summary.json'] = JSON.stringify(Object.assign({}, summary, { ms: undefined }), null, 2) + '\n'; // no timing in the file: the same input, the same file
  return { sheets, files, summary };
}

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

/** The links of a batch worth checking. */
const linksOf = (picks) => picks.flatMap((p) => [p.product_url, p.store_url, p.ad_url, p.supplier && p.supplier.url]).filter(Boolean);

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
    links = await checkLinks(linksOf(picks), { day, cache, budgetMs });
    fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(Object.entries(Object.assign({}, cache, links)).sort()), null, 2) + '\n');
  }
  const { files, summary } = await runSheets(picks, { day, quotes, audience, links, home: a.home });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(a.out, name), text);
  console.log(JSON.stringify(summary, null, 2));
  return summary.sheets > 0 || picks.length === 0 ? 0 : 1;
}

/** paste: a 1688 link (or the app's share text) onto one pick's supplier. Returns the pick as it is now. */
export function pasteInto(picks, id, text) {
  const pick = picks.find((p) => String(p.id) === String(id));
  if (!pick) throw new Error(`No pick with id ${id}`);
  const got = fromPaste(text);
  if (!got.url) throw new Error('No link found in the text');
  const sup = Object.assign({}, pick.supplier || {});
  sup.url = cleanUrl(got.url) || got.url;
  sup.platform = platformOf(sup.url);
  if (got.unit_price != null) sup.cost = `${got.currency === 'CNY' ? '¥' : got.currency === 'USD' ? '$' : '€'}${got.unit_price}`;
  if (got.moq != null) sup.moq = got.moq;
  if (got.title) sup.title = got.title;
  sup.pasted = new Date().toISOString().slice(0, 10);
  sup.status = 'estimate'; // a listing's price: confirm it with the supplier or a quote
  pick.supplier = sup;
  return pick;
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
