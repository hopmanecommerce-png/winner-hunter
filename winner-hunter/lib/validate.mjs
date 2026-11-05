/*
 * The validate step of the daily pipeline and the batch tool's parts (validate.mjs is the command line). productSheet
 * is what the daily job calls for each pick (research/2026-11-05-winner-system/shared/INTERFACES.md, section 3): the
 * scored product in, the product sheet out (worker/src/validate.mjs works it out), with the digest's numbers and what
 * was missing. It never throws for missing data, never writes to D1 and sends nothing: the only network it uses is an
 * optional link check through ctx.fetch, within ctx.signal.
 */
import { VALIDATE, sheetOf, renderSheet, digestOf, csvRow, CSV_COLS } from '../worker/src/validate.mjs';
import { fromPaste, cleanUrl, platformOf } from '../worker/src/sourcing.mjs';
import { zhGuess } from '../worker/src/pipeline.mjs';
import { SHORT } from '../worker/src/risk.mjs';

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
 * { url: { ok, status, checked } }; a link checked on `day` before (cache) is not checked again: a browser check in the
 * cache (via: 'browser') counts as one. A shop's 403 or 429 counts as "did not open", with its status. Facebook's 403 is
 * its bot wall for every script: ok null ("not checkable by script"), never "broken".
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
      // Facebook answers every script with 403 (its Ad Library opens in a browser): not a broken link, just not checkable here.
      const wall = res.status === 403 && /(^|\.)facebook\.com$/i.test(new URL(u).hostname);
      out[u] = wall ? { ok: null, status: 'bot wall (403)', checked: day } : { ok: res.status >= 200 && res.status < 400, status: res.status, checked: day };
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
    const name = s.name.length > 70 ? s.name.slice(0, 68).replace(/\s+\S*$/, '') + '…' : s.name;
    L.push(`| [${name.replace(/\|/g, '\\|')}](${safeName(s.id)}.md) | ${d.market || '–'} | ${o ? '€' + o.price.toFixed(2) : '–'} | ${d.margin_eur != null ? '€' + d.margin_eur.toFixed(2) : '–'}${d.cost_status && d.cost_status !== 'fact' ? ' est.' : ''} | ${d.be_cpa_eur != null ? '€' + d.be_cpa_eur.toFixed(2) : '–'} | ${d.be_roas != null ? d.be_roas + '×' : '–'} | ${s.level} | ${d.main_blocker.replace(/\|/g, '\\|')} | ${t.go ? `€${t.budget} (${t.mode})` : 'no'} |`);
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
      pick = pickFromScored(Object.assign({}, raw)); // the scorer's shape or the sheet's own
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
    links: links ? { checked: Object.keys(links).length, opened: Object.values(links).filter((x) => x.ok === true).length, broken: Object.values(links).filter((x) => x.ok === false).length, walled: Object.values(links).filter((x) => x.ok == null).length } : null,
    digest: sheets.map((s) => Object.assign({ id: s.id, name: s.name }, digestOf(s))), ms: Date.now() - started,
  };
  files['summary.json'] = JSON.stringify(Object.assign({}, summary, { ms: undefined }), null, 2) + '\n'; // no timing in the file: the same input, the same file
  return { sheets, files, summary };
}

/** The links of a batch worth checking. */
export const linksOf = (picks) => picks.map((x) => pickFromScored(x)).flatMap((p) => [p.product_url, p.store_url, p.ad_url, p.supplier && p.supplier.url]).filter(Boolean);

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


// ---------------------------------------------------------------------------
// The daily job's step: productSheet(pick, ctx)
// ---------------------------------------------------------------------------

/**
 * A scored product (shared/INTERFACES.md, section 2: key, id, name, src, category, sub, score, pillars, risk, price
 * { amount, currency, eur }, econ, evidence [{ signal, value, kind, source, date, link }], links { product_url,
 * store_url, ad_library[], board }, markets) as the sheet takes it. A pick already in the sheet's own shape passes as it is.
 * Fields the scorer may add: jev { p, flags, main, sub }, supplier { url, cost, weight_g, moq }, zh, audience, made_to_order.
 */
// The scorer passes the risk radar's findings as phrases ("Docs: Claims", "Block: Cosmetic") and returns ("Sizes"). Back to
// the Jev answers behind them, so this sheet's radar reads what the scorer's did (risk.mjs JEV: Jev's trait → radar key).
const KEY_OF = Object.fromEntries(Object.entries(SHORT).map(([k, v]) => [String(v).toLowerCase(), k]));
const TRAIT_OF = { eat: 'people', pet_eat: 'animals', cosmetics: 'skin', brand: 'brand', claims: 'medical', ce: 'electric', kids: 'kids', food: 'foodcontact', ship: 'restricted', sizing: 'sizing', fragile: 'fragile', bulky: 'bulky' };
function jevFromRisk(risk) {
  if (!risk || typeof risk !== 'object') return null;
  const words = [...(Array.isArray(risk.flags) ? risk.flags : []), ...(Array.isArray(risk.returns) ? risk.returns : [])].map((f) => String(f || '').replace(/^(Block|Docs|OK)\s*:\s*/i, '').replace(/^↩\s*/, '').trim().toLowerCase());
  // The scorer's radar had Jev's answers (or found nothing): what its flags don't name was a no, so a category guess
  // (risk.mjs CATS, only for unanswered questions) can't add what the scorer's radar didn't find.
  const p = Object.fromEntries([...new Set(Object.values(TRAIT_OF))].map((t) => [t, 0]));
  p.physical = 1;
  for (const w of words) {
    const k = KEY_OF[w] || (w.startsWith('size') ? 'sizing' : w);
    if (TRAIT_OF[k]) p[TRAIT_OF[k]] = 1;
    if (k === 'digital') p.physical = 0;
  }
  return { p, yesno: true, from: 'the scorer\'s risk flags' };
}

/**
 * A scored product (shared/INTERFACES.md, section 2: key, id, name, src, category, sub, score, pillars, risk, price
 * { amount, currency, eur }, econ, evidence [{ signal, value, kind, source, date, link }], links { product_url,
 * store_url, ad_library (a link or a list), board }, image, markets) as the sheet takes it. A pick already in the sheet's
 * own shape passes as it is. Fields the scorer may add: jev { p, flags, main, sub } (else its risk flags stand in),
 * supplier { url, cost, weight_g, moq }, zh, audience, made_to_order.
 */
export function pickFromScored(p) {
  if (!p || typeof p !== 'object') return {};
  if (!p.links && !p.src && !(p.price && typeof p.price === 'object')) return p; // the sheet's own shape
  const links = p.links || {};
  const price = p.price && typeof p.price === 'object' ? p.price : null;
  const ads = Array.isArray(links.ad_library) ? links.ad_library : links.ad_library ? [links.ad_library] : [];
  const ev = (Array.isArray(p.evidence) ? p.evidence : []).filter((e) => e && (e.signal || e.text) && !/^breakeven|^margin/.test(String(e.signal || ''))).slice(0, 8).map((e) => ({
    text: e.text || `${String(e.signal).replace(/_/g, ' ')}: ${e.value}`, url: e.link || '', status: e.kind === 'fact' ? 'fact' : e.kind === 'claim' ? 'claim (unverified)' : 'estimate', date: e.date || '',
  }));
  const pillars = p.pillars && typeof p.pillars === 'object' ? Object.fromEntries(Object.entries(p.pillars).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) : v])) : null;
  const zh = p.zh || zhGuess(p.name || '') || '';
  const jev = p.jev && typeof p.jev === 'object' ? p.jev : jevFromRisk(p.risk);
  return {
    id: p.id || p.key, key: p.key || '', name: p.name || '', source: p.src || p.source || '',
    price: price ? (price.amount != null ? price.amount : price.eur) : p.price, cur: price ? (price.amount != null ? price.currency || 'EUR' : 'EUR') : p.cur,
    markets: Array.isArray(p.markets) ? p.markets : [], product_url: links.product_url || p.product_url || '', store_url: links.store_url || p.store_url || '',
    ad_url: ads[0] || p.ad_url || '', board_url: links.board || '', img: p.img || p.image || links.img || '',
    category: p.category ? (typeof p.category === 'string' ? { main: p.category, sub: p.sub || '' } : p.category) : null,
    jev, risks: Array.isArray(p.risks) ? p.risks : [], supplier: p.supplier || null, zh, audience: p.audience || null, made_to_order: !!p.made_to_order, problem: p.problem || '',
    score: p.score != null ? { total: typeof p.score === 'number' ? p.score : p.score.total, breakdown: pillars, level: p.level, why: p.why || '', claims: ev.some((e) => /claim/.test(e.status)) } : null,
    evidence: ev,
  };
}

/** What a sheet still lacks, in plain words, for the job's run summary and the board. */
export function missingOf(sheet) {
  const out = [];
  const i = sheet.economics.inputs;
  const m = sheet.economics.markets[0];
  const o = m && m.offers[0];
  if (!i.price) out.push('a selling price');
  if (i.cost && i.cost.status === 'guess') out.push('a supplier price (estimated from the selling price)');
  if (i.grams && i.grams.status === 'guess') out.push('the packed weight (a guess)');
  if (o && o.ship_status !== 'fact') out.push(`a shipping quote for ${m.name}`);
  if (!sheet.audience) out.push('the audience card');
  if (sheet.compliance.radar && !sheet.compliance.radar.jev) out.push('Jev\'s answers (compliance from the words only)');
  if (sheet.links.some((l) => l.ok == null)) out.push('a link check');
  return out;
}

/** The digest's phrase for a sheet, at most 110 characters: "Margin €19, break-even CPA €19 in NZ (est.). Blocker: none". */
export function oneLineOf(sheet) {
  const d = digestOf(sheet);
  const whole = (x) => `€${Math.round(x)}`;
  const block = d.main_blocker.replace(/^No blocker found/, 'none').replace(/^Block: /, '').replace(/^Docs: /, 'papers for ');
  const money = d.margin_eur == null ? 'No price yet' : d.margin_eur <= 0 ? `Loses ${whole(-d.margin_eur)} an order in ${d.market}` : `Margin ${whole(d.margin_eur)}, break-even CPA ${whole(d.be_cpa_eur)} in ${d.market}${d.cost_status && d.cost_status !== 'fact' ? ' (est.)' : ''}`;
  const line = `${money}. Blocker: ${block}`;
  return line.length <= 110 ? line : line.slice(0, 107).replace(/[\s,;:.]+\S*$/, '') + '...';
}

/**
 * The daily job's validate step (INTERFACES.md): { sheet, md, one_line, margin_eur, breakeven_cpa_eur, main_blocker,
 * market, level, test, missing, spent }. ctx: { day, now, signal, fetch, cache ({ get, put }, sync or async), quotes
 * (Kungfubuy quotes, optional), settings, check_links (default: when ctx.fetch is given) }. Never throws: a pick it cannot
 * read still gets a sheet that says what is missing.
 */
export async function productSheet(pick, ctx = {}) {
  const day = isDay(ctx.day) ? ctx.day : isDay(String(ctx.now || '').slice(0, 10)) ? String(ctx.now).slice(0, 10) : today();
  let mine;
  try {
    mine = pickFromScored(pick);
  } catch (e) {
    mine = { id: (pick && pick.id) || 'unreadable', name: (pick && pick.name) || 'Unreadable pick' };
  }
  let links = {};
  const doCheck = ctx.check_links !== false && typeof ctx.fetch === 'function' && !(ctx.signal && ctx.signal.aborted);
  if (doCheck) {
    const urls = linksOf([mine]);
    const cached = {};
    if (ctx.cache && typeof ctx.cache.get === 'function') {
      for (const u of urls) {
        try {
          const v = await ctx.cache.get('link:' + u);
          if (v && v.checked === day) cached[u] = v;
        } catch (e) {
          // no cache: check it
        }
      }
    }
    const end = new Promise((resolve) => ctx.signal && ctx.signal.addEventListener('abort', () => resolve(null), { once: true }));
    const checked = await Promise.race([checkLinks(urls, { day, cache: cached, fetch: ctx.fetch, timeoutMs: 6000, budgetMs: 15000 }), end]);
    links = checked || cached;
    if (checked && ctx.cache && typeof ctx.cache.put === 'function') {
      for (const [u, v] of Object.entries(checked)) {
        if (cached[u]) continue;
        try {
          await ctx.cache.put('link:' + u, v, 1);
        } catch (e) {
          // the cache is a saving, not a need
        }
      }
    }
  }
  let sheet;
  try {
    sheet = sheetOf(mine, { day, quotes: Array.isArray(ctx.quotes) ? ctx.quotes : [], links, settings: ctx.settings });
  } catch (e) {
    sheet = sheetOf({ id: mine.id, name: mine.name }, { day, settings: ctx.settings }); // the bare sheet: it says what is missing
  }
  const d = digestOf(sheet);
  return {
    sheet, md: renderSheet(sheet), one_line: oneLineOf(sheet), margin_eur: d.margin_eur, breakeven_cpa_eur: d.be_cpa_eur, main_blocker: d.main_blocker, market: d.market, level: sheet.level,
    test: sheet.test_plan.go ? { budget_eur: sheet.test_plan.budget, daily_eur: sheet.test_plan.daily, mode: sheet.test_plan.mode } : null, missing: missingOf(sheet), spent: { credits: 0, jevUsd: 0 },
  };
}
