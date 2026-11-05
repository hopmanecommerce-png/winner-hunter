/*
 * Audience engine: one audience card per product, with no human in the loop. The daily job (shared/INTERFACES.md in
 * product-research, research/2026-11-05-winner-system) calls audienceCard(pick, ctx) for every daily pick.
 *
 *   1. enrich   the pick with what the board already knows: title, ad copy, Jev's buyer, problem type and category
 *   2. phrase   the English search words (lib/audience-phrase.mjs; Jev picks when the candidates disagree)
 *   3. collect  competitor reach splits and customer statements (lib/audience-collect.mjs), cache first, under the
 *               day's credit budget and the step's abort signal
 *   4. label    each statement with Jev (lib/audience-jev.mjs), or the word lists when Jev is off or fails
 *   5. card     personas, triggers, objections, words, 5 angles, Meta targeting (lib/audience-card.mjs); Jev ranks
 *               the draft hooks and flags claims
 * Never throws: a missing source is a line in `missing`, and the card says what it rests on.
 */
import { audienceClient, collect, ctxCache, memoryCache, VERSION as COLLECT_VERSION } from './audience-collect.mjs';
import { candidates } from './audience-phrase.mjs';
import { jevClient, labelStatements, choosePhrase, rankHooks } from './audience-jev.mjs';
import { buildCard, cardMarkdown, CARD_VERSION } from './audience-card.mjs';
import { sharesOf } from './audience-meta.mjs';
import { CATEGORIES, SEP } from '../worker/src/jev-questions.mjs';

export const VERSION = `card ${CARD_VERSION} / collect ${COLLECT_VERSION}`;
export const DEFAULTS = { perPick: 14, jevCalls: 10, statements: 120, ads: 3 };
export const BASELINE_KEY = 'audience:baseline';
const MAX_IDS = 3000;

// ---------------------------------------------------------------------------
// 1. What the board already knows (read-only, primary-key lookups only: D1 counts every row read)
// ---------------------------------------------------------------------------

/** "Main > Sub" from a pick's category fields, matched to Jev's taxonomy even when sub is shortened ("Beds"). */
export function subOf(main, sub) {
  if (!main && !sub) return '';
  const s = String(sub || '');
  if (s.includes(SEP) && CATEGORIES.includes(s)) return s;
  const exact = `${main}${SEP}${s}`;
  if (CATEGORIES.includes(exact)) return exact;
  const low = s.toLowerCase();
  return CATEGORIES.find((c) => c.startsWith(`${main}${SEP}`) && low && c.toLowerCase().includes(low)) || '';
}

const readJevAnswers = (row) => {
  try {
    const a = JSON.parse(row.answers || '{}');
    const ch = a.choices || {};
    return { audience: ch.audience ? ch.audience.c : null, problemtype: ch.problemtype ? ch.problemtype.c : null, season: ch.season ? ch.season.c : null, gift: a.p ? a.p.gift ?? null : null };
  } catch (e) {
    return {};
  }
};

/** The pick plus the board's own facts. db: (sql, params) → rows, read-only; any failure just leaves a field empty. */
export async function enrich(pick, db) {
  const links = pick.links || {};
  const p = {
    id: pick.id || pick.key || '', key: pick.key || '', name: pick.name || pick.title || '', title: pick.title || '', phrase: pick.phrase || '',
    url: pick.product_url || links.product_url || pick.url || '', store: (pick.stores && pick.stores[0]) || pick.store || '',
    ad: pick.ad_copy || '', ad_ids: [...new Set([...(pick.ad_ids || []), ...(links.ad_library || []).map((u) => (/[?&]id=(\d+)/.exec(u) || [])[1])].filter(Boolean).map(String))],
    markets: pick.markets || [], main: (pick.category && pick.category.main) || (typeof pick.category === 'string' ? pick.category : '') || pick.main || '',
    sub: '', jev: pick.jev && (pick.jev.audience || pick.jev.problemtype) ? pick.jev : {},
  };
  p.sub = subOf(p.main, (pick.category && pick.category.sub) || pick.sub);
  if (!db) return p;
  const q = async (sql, params) => {
    try {
      return (await db(sql, params)) || [];
    } catch (e) {
      return [];
    }
  };
  if (p.ad_ids[0] && (!p.ad || !p.title)) {
    const [w] = await q('SELECT product_title, product_url, store_url, data FROM winners WHERE ad_id = ?', [p.ad_ids[0]]);
    if (w) {
      let d = {};
      try {
        d = JSON.parse(w.data || '{}');
      } catch (e) {
        d = {};
      }
      p.title = p.title || w.product_title || '';
      p.ad = p.ad || d.ad_copy || '';
      p.url = p.url || w.product_url || '';
      p.store = p.store || (w.store_url ? new URL(w.store_url).hostname : '');
    }
  }
  if (p.key && !p.jev.audience) {
    const [c] = await q('SELECT main, sub, answers FROM world_checks WHERE product_key = ?', [p.key]);
    if (c) {
      p.jev = readJevAnswers(c);
      if (!p.sub && c.main && c.sub) p.sub = subOf(c.main, c.sub);
      if (!p.main) p.main = c.main || '';
    }
  }
  if (p.key && p.key.startsWith('world|') && !p.ad) {
    const [w] = await q('SELECT body, title FROM world_ads WHERE product_key = ? LIMIT 1', [p.key]);
    if (w) {
      p.ad = w.body || '';
      p.title = p.title || w.title || '';
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// The reach baseline: the average split of every ad read so far, kept in the cache under one key.
// ---------------------------------------------------------------------------
export async function loadBaseline(cache, seed = null) {
  const v = cache ? await cache.get(BASELINE_KEY).catch(() => null) : null;
  const b = v && v.data && v.data.n ? v.data : seed && seed.n ? seed : { n: 0, sums: { cells: {}, bands: {}, sexes: { F: 0, M: 0, U: 0 } }, ids: [] };
  return b;
}

/** Add new ads to the baseline (each ad once, by id). Returns { baseline (for demographics()), state (to store) }. */
export function addToBaseline(state, ads) {
  const s = JSON.parse(JSON.stringify(state || { n: 0, sums: { cells: {}, bands: {}, sexes: { F: 0, M: 0, U: 0 } }, ids: [] }));
  const ids = new Set(s.ids || []);
  for (const a of ads || []) {
    if (!a || !a.id || ids.has(a.id)) continue;
    const sh = sharesOf(a);
    if (!sh) continue;
    ids.add(a.id);
    s.n++;
    for (const [k, v] of Object.entries(sh.cells)) s.sums.cells[k] = (s.sums.cells[k] || 0) + v;
    for (const [k, v] of Object.entries(sh.bands)) s.sums.bands[k] = (s.sums.bands[k] || 0) + v;
    for (const k of ['F', 'M', 'U']) s.sums.sexes[k] = (s.sums.sexes[k] || 0) + sh.sexes[k];
  }
  s.ids = [...ids].slice(-MAX_IDS);
  return { state: s, baseline: baselineFromState(s) };
}

export function baselineFromState(s) {
  if (!s || !s.n) return { n: 0, cells: {}, bands: {}, sexes: { F: 0, M: 0, U: 0 } };
  const div = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, v / s.n]));
  return { n: s.n, cells: div(s.sums.cells), bands: div(s.sums.bands), sexes: { F: (s.sums.sexes.F || 0) / s.n, M: (s.sums.sexes.M || 0) / s.n, U: (s.sums.sexes.U || 0) / s.n } };
}

// ---------------------------------------------------------------------------
// The batch step
// ---------------------------------------------------------------------------

/**
 * One audience card. pick: the scored product (shared/INTERFACES.md) or a research candidate { id, name, phrase, markets,
 * category, ad_ids }. ctx: { now, day, signal, budget: { credits, jevUsd }, cache, env, fetch, db, markets, perPick,
 * jevCalls, log, seedBaseline, sleep }.
 * Returns { card, markdown, one_line, credits_used, jev: { calls, tokens, cost }, missing[] }. Never throws.
 */
export async function audienceCard(pick, ctx = {}) {
  const missing = [];
  const log = ctx.log || (() => {});
  const now = ctx.now ? Date.parse(ctx.now) || Date.now() : Date.now();
  const env = ctx.env || {};
  let api = null;
  let jev = null;
  let credits = 0;
  try {
    const cache = ctx.cache ? (ctx.cache.raw ? ctx.cache.raw : ctxCache(ctx.cache)) : memoryCache();
    const p = await enrich(pick, ctx.db);
    const budget = ctx.budget || {};
    const perPick = Math.max(0, Math.min(ctx.perPick ?? DEFAULTS.perPick, budget.credits ?? Infinity));
    if (String(env.SCRAPECREATORS_API_KEY || '').trim() && perPick > 0) {
      api = audienceClient({ key: env.SCRAPECREATORS_API_KEY, cap: perPick, fetch: ctx.fetch, sleep: ctx.sleep });
    } else missing.push(perPick > 0 ? 'no SCRAPECREATORS_API_KEY: cached data only' : 'no credits left today: cached data only');
    const jevOk = String(env.TYPESAFE_API_KEY || '').trim() && (budget.jevUsd == null || budget.jevUsd > 0) && ctx.jev !== false;
    if (jevOk) jev = jevClient({ key: env.TYPESAFE_API_KEY, fetch: ctx.fetch, pause: ctx.sleep, cap: ctx.jevCalls ?? DEFAULTS.jevCalls });
    else missing.push('Jev off (no TYPESAFE_API_KEY or no budget): word lists only');

    // 2. The search phrase.
    const cands = candidates({ phrase: p.phrase, name: p.name, title: p.title, url: p.url, sub: p.sub, main: p.main, ad: p.ad });
    let phrase = cands[0] || { phrase: '', how: 'none' };
    if (jev && cands.length > 1 && !p.phrase && !ctx.signal?.aborted) {
      const chosen = await choosePhrase(cands, { client: jev, product: { title: p.title || p.name, url: p.url, sub: p.sub, ad: p.ad } });
      if (chosen) phrase = { phrase: chosen, how: `Jev chose from ${cands.length}` };
    }
    if (!phrase.phrase) missing.push('no English search phrase: no customer statements pulled');

    // 3. Collect.
    const collected = await collect({ id: p.id, phrase: phrase.phrase, ad_ids: p.ad_ids, shop: ctx.shop }, { api, cache, now, perPick, signal: ctx.signal, log, ads: DEFAULTS.ads, threads: ctx.threads ?? 1 });
    credits = collected.credits;
    if (collected.stopped && collected.stopped !== 'no API key (cache only)') missing.push(`data pull stopped: ${collected.stopped}`);
    for (const e of collected.errors.slice(0, 3)) missing.push(e);

    // The baseline: every ad read so far, this pick's ads included.
    const state = await loadBaseline(cache, ctx.seedBaseline);
    const { state: next, baseline } = addToBaseline(state, collected.ads);
    if (next.n !== state.n) await cache.put(BASELINE_KEY, { at: new Date(now).toISOString(), data: next }).catch(() => {});

    // 4. Label statements.
    const jevInfo = { used: false, labelled: 0, error: '' };
    if (jev && collected.voice.length && !ctx.signal?.aborted) {
      const r = await labelStatements(collected.voice, { client: jev, product: { name: p.name || p.title, phrase: phrase.phrase }, max: ctx.statements ?? DEFAULTS.statements });
      jevInfo.used = r.labelled > 0;
      jevInfo.labelled = r.labelled;
      jevInfo.error = r.error;
      if (r.error) missing.push(`Jev labelling: ${r.error}`);
    }
    // Statements Jev did not reach are read by the word lists only: drop the partial .jev marks on none.
    const input = { pick: p, phrase: { ...phrase, candidates: cands }, collected, baseline, jev: jevInfo, now, markets: ctx.markets };

    // 5. The card; Jev ranks the drafts, then the card is built again with that ranking (pure, cheap).
    let card = buildCard(input);
    if (jev && card.drafts.length && !ctx.signal?.aborted) {
      const ranking = await rankHooks(card.drafts.map((d) => d.hook), { client: jev, product: { name: card.name, phrase: card.phrase }, persona: card.personas[0] && card.personas[0].label });
      if (ranking) card = buildCard({ ...input, jev: { ...jevInfo, ranking } });
      else missing.push('Jev hook ranking: no answer (drafts in rule order)');
    }
    if (!card.reach) missing.push('no EU reach data');
    if (card.data.statements < 30) missing.push(`only ${card.data.statements} customer statements`);
    card.missing = missing;
    return { card, markdown: cardMarkdown(card), one_line: card.one_line, credits_used: credits, jev: jev ? jev.stats() : null, missing };
  } catch (e) {
    log(`audience ${pick && (pick.id || pick.key)}: ${e && e.stack ? e.stack : e}`);
    missing.push(`error: ${e && e.message ? e.message : e}`);
    return { card: null, markdown: '', one_line: '', credits_used: credits || (api ? api.stats().spent : 0), jev: jev ? jev.stats() : null, missing };
  }
}
