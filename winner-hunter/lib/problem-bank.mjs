/*
 * The query bank (problem-queries.json): read it, check it, and turn it into the searches of a run.
 *   const bank = loadBank();                  → the checked bank (throws on the first thing that is wrong, with where)
 *   planFor(bank, 'reddit', ['sub', 'search']) → every search of that platform, in the order runs walk through them
 *   interleave(lists, weights)               → one item of each platform in turn, weighted
 * A plan only ever holds problem searches: the patterns, area words and topics of the bank, never a product.
 */
import fs from 'node:fs';
import { compilePhrase, fold, searchPhrase } from './problem-text.mjs';

export const BANK_FILE = new URL('../problem-queries.json', import.meta.url);
export const KINDS = ['complaint', 'need', 'question', 'struggle'];
export const SIGNAL_KINDS = ['intensity', 'pay', 'seeking', 'tried', 'agree'];
// Words that turn a problem search into a product search. The bank's searches never use them (the test checks).
export const PRODUCT_WORDS = ['buy', 'best', 'review', 'reviews', 'cheap', 'deals', 'amazon', 'aliexpress', 'temu', 'product', 'gadget', 'kopen', 'beste', 'goedkoop', 'aanbieding', 'kaufen', 'gunstig', 'angebot', 'testsieger'];
const SUB = /^[A-Za-z0-9_]{2,21}$/;
const AREA = /^[a-z][a-z0-9_]{1,30}$/;

export function loadBank(file = BANK_FILE) {
  return validateBank(JSON.parse(fs.readFileSync(file, 'utf8')));
}

/** Throws an Error naming the first problem (e.g. "areas.pets.keywords.nl: at least 3"). Returns the bank. */
export function validateBank(b) {
  const bad = (where, why) => { throw new Error(`problem-queries.json ${where}: ${why}`); };
  const strings = (x, where, min, max = 80) => {
    if (!Array.isArray(x)) bad(where, 'must be a list');
    if (x.length < min) bad(where, `at least ${min}`);
    const seen = new Set();
    for (const s of x) {
      if (typeof s !== 'string' || !s.trim()) bad(where, 'an empty entry');
      if (s.length > max) bad(where, `"${s.slice(0, 30)}…" is longer than ${max} characters`);
      const k = fold(s);
      if (!k) bad(where, `"${s}" has no letters`);
      if (seen.has(k)) bad(where, `"${s}" is in it twice`);
      seen.add(k);
    }
  };
  if (!b || typeof b !== 'object') bad('', 'not a JSON object');
  const langs = b.languages;
  if (!Array.isArray(langs) || !langs.length || langs.some((l) => !['en', 'nl', 'de'].includes(l))) bad('languages', 'a list of en, nl and de');
  for (const l of langs) {
    const list = b.patterns && b.patterns[l];
    if (!Array.isArray(list) || list.length < 5) bad(`patterns.${l}`, 'at least 5 patterns');
    const seen = new Set();
    list.forEach((x, i) => {
      const where = `patterns.${l}[${i}]`;
      if (!x || typeof x.p !== 'string' || !x.p.trim() || x.p.length > 80) bad(where, 'p: the pattern, 1 to 80 characters');
      if (!KINDS.includes(x.kind)) bad(where, `kind: one of ${KINDS.join(', ')}`);
      if (x.search != null && typeof x.search !== 'boolean') bad(where, 'search: true or false');
      if (/^\s*\.\.\.|\.\.\.\s*$/.test(x.p)) bad(where, '"..." goes between words, not at the start or the end');
      if (!compilePhrase(x.p).length) bad(where, 'no words');
      const k = fold(x.p);
      if (seen.has(k)) bad(where, `"${x.p}" is in the list twice`);
      seen.add(k);
    });
  }
  const areas = b.areas;
  if (!areas || typeof areas !== 'object' || Object.keys(areas).length < 1) bad('areas', 'at least one area');
  for (const [key, a] of Object.entries(areas)) {
    const where = `areas.${key}`;
    if (!AREA.test(key)) bad(where, 'the key: lower case letters, digits and _');
    if (!a || typeof a.label !== 'string' || !a.label.trim()) bad(where, 'label: its name on the board');
    for (const l of langs) {
      strings(a.keywords && a.keywords[l], `${where}.keywords.${l}`, 3, 60);
      strings(a.topics && a.topics[l], `${where}.topics.${l}`, 2, 80);
      const subs = (a.subreddits && a.subreddits[l]) ?? [];
      if (!Array.isArray(subs)) bad(`${where}.subreddits.${l}`, 'a list (it can be empty)');
      for (const s of subs) if (!SUB.test(s)) bad(`${where}.subreddits.${l}`, `"${s}" is not a subreddit name (letters, digits and _, no r/)`);
    }
  }
  for (const l of langs) {
    const subs = (b.general && b.general.subreddits && b.general.subreddits[l]) ?? [];
    if (!Array.isArray(subs)) bad(`general.subreddits.${l}`, 'a list (it can be empty)');
    for (const s of subs) if (!SUB.test(s)) bad(`general.subreddits.${l}`, `"${s}" is not a subreddit name`);
  }
  for (const s of SIGNAL_KINDS) for (const l of langs) strings(b.signals && b.signals[s] && b.signals[s][l], `signals.${s}.${l}`, 1, 80);
  for (const [cc, c] of Object.entries(b.countries || {})) {
    if (!/^[A-Z]{2}$/.test(cc)) bad(`countries.${cc}`, 'a two-letter country code (NL, DE, US)');
    strings(c.cues || [], `countries.${cc}.cues`, 0, 60);
    for (const s of c.communities || []) if (!SUB.test(s)) bad(`countries.${cc}.communities`, `"${s}" is not a community name`);
  }
  // The searches: never a product word (a pattern with search: false, and the signals, are never searched).
  for (const item of searchTexts(b)) {
    const w = fold(item.text).split(' ').find((x) => PRODUCT_WORDS.includes(x));
    if (w) bad(item.where, `"${item.text}" searches for products ("${w}"): only problems go in the searches`);
  }
  return b;
}

/** Every text the bank searches with, and where it is in the file. */
export function searchTexts(b) {
  const out = [];
  for (const l of b.languages) {
    (b.patterns[l] || []).forEach((x, i) => { if (x.search !== false) out.push({ where: `patterns.${l}[${i}]`, text: x.p }); });
    for (const [key, a] of Object.entries(b.areas)) {
      for (const k of ['keywords', 'topics']) (a[k][l] || []).forEach((t, i) => out.push({ where: `areas.${key}.${k}.${l}[${i}]`, text: t }));
    }
  }
  return out;
}

/** The area labels for the board: { pets: 'Pets', … }. */
export const areaLabels = (b) => Object.fromEntries(Object.entries(b.areas).map(([k, a]) => [k, a.label]));

/**
 * Visits every (pattern, keyword) pair once, the keyword moving on each turn of the patterns, so a short run already
 * holds several keywords: p = i mod P, k = (i div P + p) mod K.
 */
export function pairs(P, K) {
  const out = [];
  for (let i = 0; i < P * K; i++) out.push([i % P, (Math.floor(i / P) + (i % P)) % K]);
  return out;
}

/** One item of each list in turn: [[a1, a2], [b1]] → a1, b1, a2. */
export function roundRobin(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

/**
 * Every search of one platform, in the order the runs walk through them. modes (what the platform can search):
 *   'sub'    a subreddit searched for a pattern ("is there a way to" in r/DIY); also the general subreddits (area '')
 *   'search' the whole platform, a pattern with an area keyword ("is there a way to" dog)
 *   'topic'  an area topic as it is ("dog hair everywhere"), for video platforms: the complaints are in the comments
 * Areas and languages take turns (one stream each, round robin), so a run of a few credits already spans them.
 * An item: { platform, mode, q, sub, area, lang, pattern }.
 */
export function planFor(b, platform, modes) {
  const streams = [];
  const patterns = (l) => b.patterns[l].filter((x) => x.search !== false);
  for (const l of b.languages) {
    for (const [area, a] of Object.entries(b.areas)) {
      const s = [];
      const P = patterns(l);
      if (modes.includes('sub')) {
        for (const sub of (a.subreddits && a.subreddits[l]) || []) for (const x of P) s.push({ platform, mode: 'sub', q: searchPhrase(x.p), sub, area, lang: l, pattern: x.p });
      }
      if (modes.includes('topic')) for (const t of a.topics[l]) s.push({ platform, mode: 'topic', q: t, sub: '', area, lang: l, pattern: '' });
      if (modes.includes('search')) {
        const K = a.keywords[l];
        for (const [p, k] of pairs(P.length, K.length)) s.push({ platform, mode: 'search', q: `"${searchPhrase(P[p].p)}" ${K[k]}`, sub: '', area, lang: l, pattern: P[p].p });
      }
      // Within an area: its subreddit searches, topics and keyword searches take turns too.
      const byMode = ['sub', 'topic', 'search'].map((m) => s.filter((x) => x.mode === m));
      if (s.length) streams.push(roundRobin(byMode));
    }
    if (modes.includes('sub')) {
      const g = [];
      for (const sub of (b.general && b.general.subreddits && b.general.subreddits[l]) || []) for (const x of patterns(l)) g.push({ platform, mode: 'sub', q: searchPhrase(x.p), sub, area: '', lang: l, pattern: x.p });
      if (g.length) streams.push(g);
    }
  }
  return roundRobin(streams);
}

/**
 * The platforms' plans as one queue, weighted: { reddit: 3, youtube: 1 } gives reddit, reddit, reddit, youtube, … A
 * platform whose plan runs out leaves the queue. Yields { platform, index }: index is the place in that platform's plan.
 */
export function* interleave(lengths, weights, starts = {}) {
  const at = {};
  const left = {};
  for (const p of Object.keys(lengths)) {
    at[p] = 0;
    left[p] = lengths[p];
  }
  const order = Object.keys(lengths).filter((p) => lengths[p] > 0);
  while (order.some((p) => left[p] > 0)) {
    for (const p of order) {
      for (let w = 0; w < Math.max(1, weights[p] || 1) && left[p] > 0; w++) {
        const index = ((starts[p] || 0) + at[p]) % lengths[p];
        at[p]++;
        left[p]--;
        yield { platform: p, index };
      }
    }
  }
}
