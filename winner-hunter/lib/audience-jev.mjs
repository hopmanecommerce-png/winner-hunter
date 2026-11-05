/*
 * Audience engine: Jev (TypeSafe's decision model) for the three judgement calls of an audience card. Jev only answers
 * typed questions (choice, noul, score): it never writes text. So code writes every line, and Jev picks:
 *   labelStatements  what each customer statement is: a pain, a trigger, a doubt, a good result, a want, a question, or
 *                    off topic. 20 statements per request (each its own question), so a product costs a handful of calls
 *   choosePhrase     which English search phrase names the product, when the candidates disagree
 *   rankHooks        which draft hook would most likely stop the persona scrolling, and whether a hook makes a claim
 * A run has a hard cap on requests (cap). Without a key, or on any error, the caller falls back to the word lists in
 * lib/audience-text.mjs and says so on the card: a card never waits for Jev.
 */
import { MODEL, JevError, PRICE_PER_TOKEN } from './jev.mjs';

export const API = 'https://api.typesafe.ai/v1/systemone';
export const SECRET = 'TYPESAFE_API_KEY';
export const BATCH = 20;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => Array.from(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n).join('');

/** A capped Jev client: ask(questions, state) → answers. cap: most requests this run. stats(): calls, tokens, cost. */
export function jevClient({ key, fetch: doFetch = globalThis.fetch, pause = wait, cap = 300, tries = 4, timeout = 60000 } = {}) {
  const k = String(key || '').trim();
  if (!k) throw new JevError(`No API key: add the GitHub secret ${SECRET}`, { stop: true });
  const t = { calls: 0, tokens: 0, failed: 0, cap };
  async function ask(questions, state) {
    if (t.calls >= t.cap) throw new JevError(`Jev request cap reached (${t.cap})`, { stop: true });
    t.calls++;
    const body = JSON.stringify({ model: MODEL, questions, state });
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await doFetch(API, { method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(timeout) });
      } catch (e) {
        if (attempt >= tries) {
          t.failed++;
          throw new JevError(`no answer (${e.name})`);
        }
        await pause(2000 * attempt);
        continue;
      }
      if (res.ok) {
        let j;
        try {
          j = await res.json();
        } catch (e) {
          t.failed++;
          throw new JevError(`unreadable answer (${e.name})`);
        }
        t.tokens += Number(j && j.usage && j.usage.input_tokens) || 0;
        return (j && j.answers) || {};
      }
      if ((res.status === 429 || res.status >= 500) && attempt < tries) {
        const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        await pause(after > 0 ? Math.min(after, 60) * 1000 : 3000 * attempt);
        continue;
      }
      t.failed++;
      throw new JevError(`HTTP ${res.status}`, { status: res.status, stop: res.status === 401 || res.status === 402 || res.status === 403 });
    }
  }
  return { ask, stats: () => ({ ...t, cost: Math.round(t.tokens * PRICE_PER_TOKEN * 1e6) / 1e6 }) };
}

// What a statement is. Option text → the kind used by the card (lib/audience-text.mjs KINDS), '' = off topic.
export const STATEMENT_OPTIONS = {
  'A problem, frustration or pain the writer has with the situation today': 'pain',
  'A moment, event or reason that made the writer need or buy it now': 'trigger',
  'A doubt, worry or reason not to buy this kind of product': 'objection',
  'A good result, relief or praise after using this kind of product': 'outcome',
  'The writer wants it, asks where to buy it, or bought it': 'intent',
  'A question about how this kind of product works or fits': 'question',
  'Not about this product or its problem (a joke, a tag, small talk)': '',
};

/**
 * Jev's kind for each statement: items get .jev = kind ('' = off topic) and .jevConf. Returns { labelled, calls, error }.
 * product: { name, phrase } (the state). At most max statements, liked first. Stops at the first error and keeps what it has.
 */
export async function labelStatements(items, { client, product, max = 120, concurrency = 2 } = {}) {
  const list = [...items].sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, max);
  const batches = [];
  for (let i = 0; i < list.length; i += BATCH) batches.push(list.slice(i, i + BATCH));
  const criteria = Object.fromEntries(Object.keys(STATEMENT_OPTIONS).map((o) => [o, o]));
  let labelled = 0;
  let error = '';
  let next = 0;
  async function worker() {
    while (next < batches.length && !error) {
      const b = batches[next++];
      const questions = {};
      b.forEach((it, i) => {
        questions[`s${i}`] = { type: 'choice', instructions: `What is this ${it.src === 'tiktok_shop' ? 'buyer review' : 'comment'} mainly? Statement: "${clip(it.text, 500)}"`, criteria };
      });
      try {
        const a = await client.ask(questions, { product: { name: clip(product && product.name, 200), search_phrase: clip(product && product.phrase, 80) },
          context: 'Comments and reviews people wrote online about this kind of product or the problem it solves.' });
        b.forEach((it, i) => {
          const x = a[`s${i}`];
          if (!x || !Object.hasOwn(STATEMENT_OPTIONS, x.choice)) return;
          it.jev = STATEMENT_OPTIONS[x.choice];
          it.jevConf = typeof x.confidence === 'number' ? Math.round(x.confidence * 100) / 100 : null;
          labelled++;
        });
      } catch (e) {
        error = e.message || String(e);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
  return { labelled, error };
}

/** Jev's choice of search phrase among candidates [{ phrase }]. Returns the phrase, or null on error / one candidate. */
export async function choosePhrase(cands, { client, product } = {}) {
  const opts = [...new Set((cands || []).map((c) => c.phrase).filter(Boolean))].slice(0, 6);
  if (opts.length < 2) return null;
  try {
    const a = await client.ask({ phrase: { type: 'choice', instructions: 'Which search phrase names this exact product best, the words a shopper would type to find it?', criteria: Object.fromEntries(opts.map((o) => [o, o])) } },
      { product: { title: clip(product.title, 300), page: clip(product.url, 300), category: clip(product.sub, 120), ad_text: clip(product.ad, 600) } });
    return a.phrase && opts.includes(a.phrase.choice) ? a.phrase.choice : null;
  } catch (e) {
    return null;
  }
}

/**
 * Jev's ranking of draft hooks for a persona, plus a claim check per hook. hooks: [{ hook }] or strings. Returns
 * { probs: { hook text: probability of being the best }, claims: { hook text: probability it makes a claim } } or null on error.
 */
export async function rankHooks(hooks, { client, product, persona } = {}) {
  const opts = [...new Set((hooks || []).map((h) => clip(typeof h === 'string' ? h : h.hook, 160)).filter(Boolean))].slice(0, 12);
  if (!opts.length) return null;
  const questions = {
    best: { type: 'choice', instructions: `Which first line of a Facebook or Instagram ad would most likely make ${clip(persona, 120) || 'this buyer'} stop scrolling and keep watching? Judge only the words.`,
      criteria: Object.fromEntries(opts.map((o) => [o, o])) },
  };
  opts.forEach((o, i) => {
    questions[`claim${i}`] = { type: 'noul', instructions: `Does this ad line claim or imply a health, medical, safety or measured result, or address the reader's health, age, money or body? Line: "${o}"`,
      criteria: { true: 'It claims a health, medical, safety or measured result, or speaks to the reader about their health, age, money or body.', false: 'It describes a situation or the product without such a claim.' } };
  });
  try {
    const a = await client.ask(questions, { product: { name: clip(product && product.name, 200), search_phrase: clip(product && product.phrase, 80) } });
    const p = (a.best && a.best.probabilities) || {};
    const probs = {};
    const claims = {};
    opts.forEach((o, i) => {
      probs[o] = typeof p[o] === 'number' ? Math.round(p[o] * 1000) / 1000 : 0;
      const v = a[`claim${i}`] && a[`claim${i}`].noul;
      if (typeof v === 'number') claims[o] = Math.round(v * 100) / 100;
    });
    return { probs, claims };
  } catch (e) {
    return null;
  }
}
