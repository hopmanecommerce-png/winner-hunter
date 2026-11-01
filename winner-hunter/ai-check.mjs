#!/usr/bin/env node
/*
 * The AI read for the board: a cheap Claude model (lib/ai-check.mjs) reads each board product once; the answers go into
 * D1 table ai_checks for the board's collapsed "AI read · experimental" (worker/src/ai.mjs) and for ai-eval.mjs.
 * A run: collect the batches earlier runs left, send the products without a current read in one Message Batch (half
 * price) within the spend caps, and wait a while for it. A batch still running is collected by the next run.
 *   CF_API_TOKEN=… CF_ACCOUNT_ID=… ANTHROPIC_API_KEY=… [AI_MODEL=claude-haiku-5-5] [AI_MAX_USD=0.50] [AI_MONTH_USD=5]
 *   [AI_LIMIT=500] [AI_WAIT_MINUTES=20] [AI_IMAGES=0] node winner-hunter/ai-check.mjs
 * Off without ANTHROPIC_API_KEY. Spend: each request's worst case counts against AI_MAX_USD a run and AI_MONTH_USD a
 * month, until its answer is in and its real cost replaces it. Which products: those outside the EU still running and
 * the EU's still on the board (undecided first, the newest and best first), then every product you approved or
 * rejected, so ai-eval.mjs can compare. Asked again when the title, price, photo or store changes, the ad's words become
 * known, or the prompt (VERSION) or the model changes; 3 tries per input. Never sent: your decisions, notes or reasons.
 * This repository is public: the log and the summary hold counts and money only, no product names.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings, STRICT, chunks } from './lib/d1.mjs';
import { MODEL, VERSION, priceOf, requestOf, inputHash, worstCase, costOf, readAnswer, anthropicApi, problemOf, AiError } from './lib/ai-check.mjs';
import { flagsOf } from './worker/src/ai-schema.mjs';

export const MAX_TRIES = 3;
export const MAX_WAIT_MINUTES = 30; // the job's 45 minutes leave room for the eval after the wait
const LIVE_DAYS = 45; // an EU product last seen longer ago than this is off the board (the rules allow 42 days)
const POLL_MS = 30000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One product = one advertiser + one product title: the same key as app.mjs (KEY) and launches ('eu|' + this).
export const KEY = `COALESCE(w.advertiser_page_id, '') || '|' || lower(trim(COALESCE(NULLIF(w.product_title, ''), w.ad_id)))`;
const RPD = `CAST(COALESCE(w.reach_eu, 0) AS REAL) / MAX(COALESCE(w.ad_age_days, 0), 1)`;
const DATA = (path) => `CASE WHEN json_valid(w.data) THEN json_extract(w.data, '${path}') END`;
/** EU products on the board (the rules, seen in the last 45 days: ?1) or decided, one row per product (its ad with a photo and the most reach a day). */
export const EU_SQL = `SELECT gk, title, price, was, currency, store_url, product_url, image_url, keyword, copy, store_products, rpd, hid, hat FROM (
  SELECT ${KEY} AS gk, w.product_title AS title, w.price, w.compare_at_price AS was, w.currency, w.store_url, w.product_url, w.image_url, w.keyword,
    ${DATA('$.ad_copy')} AS copy, ${DATA('$.store_products')} AS store_products, ${RPD} AS rpd,
    MAX(CASE h.status WHEN 'rejected' THEN 2 WHEN 'seen' THEN 1 ELSE 0 END) OVER (PARTITION BY ${KEY}) AS hid,
    MAX(COALESCE(h.at, '')) OVER (PARTITION BY ${KEY}) AS hat,
    MAX(CASE WHEN ${STRICT} AND w.last_seen >= ?1 THEN 1 ELSE 0 END) OVER (PARTITION BY ${KEY}) AS live,
    ROW_NUMBER() OVER (PARTITION BY ${KEY} ORDER BY (COALESCE(w.image_url, '') != '') DESC, ${RPD} DESC, w.ad_id) AS rn
  FROM winners w LEFT JOIN hidden h ON h.ad_id = w.ad_id
) WHERE rn = 1 AND (live = 1 OR hid > 0)`;
/** Products outside the EU still running, or decided. has_text: its ad's words are known. */
export const WORLD_SQL = `SELECT p.product_key, p.product_title AS title, p.price, p.compare_at_price AS was, p.currency, p.image_url, p.store_url, p.product_url,
  p.keyword, p.store_products, p.markets, p.first_seen, COALESCE(i.product_type, '') AS type,
  EXISTS (SELECT 1 FROM world_ads a WHERE a.product_key = p.product_key AND COALESCE(a.body, '') != '') AS has_text,
  CASE h.status WHEN 'rejected' THEN 2 WHEN 'seen' THEN 1 ELSE 0 END AS hid, COALESCE(h.at, '') AS hat
FROM world_products p LEFT JOIN world_items i ON i.product_key = p.product_key LEFT JOIN hidden h ON h.ad_id = p.ad_id
WHERE p.active = 1 OR h.status IN ('seen', 'rejected')`;
const WORLD_ADS_SQL = `SELECT product_key, title, COALESCE(body, '') AS body FROM world_ads WHERE product_key IN (SELECT value FROM json_each(?1)) ORDER BY copies DESC, last_seen DESC`;
const ROWS_SQL = 'SELECT product_key, status, input_hash, tries, no_image FROM ai_checks';
const PENDING_BATCHES_SQL = "SELECT DISTINCT batch_id FROM ai_checks WHERE status = 'pending' AND batch_id IS NOT NULL";
const IN_BATCH_SQL = "SELECT product_key, custom_id, input_flags, est FROM ai_checks WHERE batch_id = ?1 AND status = 'pending'";
/** A batch on its way: every product it holds, in one statement. The last answer stays until the new one is in. */
export const PENDING_SQL = `INSERT INTO ai_checks (product_key, status, model, version, input_hash, batch_id, custom_id, input_flags, no_image, est, tries, asked_at, error)
SELECT json_extract(value, '$.key'), 'pending', ?3, ${VERSION}, json_extract(value, '$.hash'), ?2, json_extract(value, '$.cid'), json_extract(value, '$.flags'),
  json_extract(value, '$.noimg'), json_extract(value, '$.est'), json_extract(value, '$.tries'), ?4, '' FROM json_each(?1) WHERE true
ON CONFLICT(product_key) DO UPDATE SET status = 'pending', model = excluded.model, version = excluded.version, input_hash = excluded.input_hash,
  batch_id = excluded.batch_id, custom_id = excluded.custom_id, input_flags = excluded.input_flags, no_image = excluded.no_image, est = excluded.est,
  tries = excluded.tries, asked_at = excluded.asked_at, error = ''`;
// An answer replaces the last one; a failure keeps it. Only for rows still waiting on this batch (?2).
const OK = (col) => `${col} = CASE WHEN excluded.status = 'ok' THEN excluded.${col} ELSE ai_checks.${col} END`;
export const ANSWER_SQL = `INSERT INTO ai_checks (product_key, status, batch_id, fit, confidence, verdict, flags, answer_model, tokens_in, tokens_out, cost, error, no_image, est, checked_at)
SELECT json_extract(value, '$.key'), json_extract(value, '$.status'), ?2, json_extract(value, '$.fit'), json_extract(value, '$.confidence'), json_extract(value, '$.verdict'),
  json_extract(value, '$.flags'), json_extract(value, '$.model'), json_extract(value, '$.tin'), json_extract(value, '$.tout'), json_extract(value, '$.cost'),
  json_extract(value, '$.error'), COALESCE(json_extract(value, '$.noimg'), 0), 0, ?3 FROM json_each(?1) WHERE true
ON CONFLICT(product_key) DO UPDATE SET status = excluded.status, ${['fit', 'confidence', 'verdict', 'flags', 'answer_model', 'tokens_in', 'tokens_out', 'cost', 'checked_at'].map(OK).join(', ')},
  error = excluded.error, no_image = MAX(COALESCE(ai_checks.no_image, 0), excluded.no_image), est = 0
WHERE ai_checks.batch_id = excluded.batch_id AND ai_checks.status = 'pending'`;

const jsonOf = (s, or) => {
  try {
    return JSON.parse(s || '') ?? or;
  } catch (e) {
    return or;
  }
};
const bounded = (x, def, lo, hi) => (x == null || String(x).trim() === '' || !Number.isFinite(Number(x)) ? def : Math.min(Math.max(Number(x), lo), hi));
const usd = (x) => `$${(Number(x) || 0).toFixed(x >= 1 ? 2 : 4)}`;

/**
 * Every product the AI may read, in the order it should: undecided outside the EU (newest first), undecided EU (most
 * reach a day first), then decided (the last decision first). Each: { key, source, title, …, has_text, hid, hat }.
 */
export async function candidates(db, now) {
  const [eu, world] = await Promise.all([db.query(EU_SQL, [new Date(now - LIVE_DAYS * 864e5).toISOString()]), db.query(WORLD_SQL)]);
  const list = [
    ...world.map((w) => ({ key: 'world|' + w.product_key, pk: w.product_key, source: 'world', title: w.title, type: w.type, price: w.price, was: w.was, currency: w.currency,
      image_url: w.image_url, store_url: w.store_url, product_url: w.product_url, keyword: w.keyword, store_products: w.store_products, markets: Object.keys(jsonOf(w.markets, {})),
      has_text: Number(w.has_text) === 1, hid: Number(w.hid) || 0, hat: w.hat || '', order: w.first_seen || '' })),
    ...eu.map((w) => ({ key: 'eu|' + w.gk, source: 'eu', title: w.title, price: w.price, was: w.was, currency: w.currency, image_url: w.image_url, store_url: w.store_url,
      product_url: w.product_url, keyword: w.keyword, store_products: w.store_products, ad_texts: w.copy ? [String(w.copy)] : [], has_text: !!w.copy,
      hid: Number(w.hid) || 0, hat: w.hat || '', order: Number(w.rpd) || 0 })),
  ];
  const group = (c) => (c.hid ? 2 : c.source === 'world' ? 0 : 1);
  const cmp = (a, b) => (a < b ? 1 : a > b ? -1 : 0); // larger first
  return list.sort((a, b) => group(a) - group(b) || (a.hid ? cmp(a.hat, b.hat) : cmp(a.order, b.order)) || (a.key < b.key ? -1 : 1));
}

/** The ad titles and words of the products outside the EU in `list` (the ads with the most copies first). */
async function worldAds(db, list) {
  const keys = list.filter((c) => c.source === 'world').map((c) => c.pk);
  const by = new Map();
  for (let i = 0; i < keys.length; i += 200) {
    for (const a of await db.query(WORLD_ADS_SQL, [JSON.stringify(keys.slice(i, i + 200))])) {
      if (!by.has(a.product_key)) by.set(a.product_key, { titles: [], texts: [] });
      by.get(a.product_key).titles.push(a.title);
      by.get(a.product_key).texts.push(a.body);
    }
  }
  for (const c of list) {
    const a = c.source === 'world' && by.get(c.pk);
    if (a) Object.assign(c, { ad_titles: a.titles, ad_texts: a.texts.filter(Boolean) });
  }
}

/** This month's spend, USD: real costs of answers in, worst cases of requests out. { month, usd }. */
async function spendOf(db, now) {
  const month = new Date(now).toISOString().slice(0, 7);
  const s = jsonOf(await db.getState('ai_spend'), {});
  return { month, usd: s && s.month === month ? Number(s.usd) || 0 : 0 };
}
async function addSpend(db, now, delta) {
  const s = await spendOf(db, now);
  s.usd = Math.max(0, Math.round((s.usd + delta) * 1e6) / 1e6);
  await db.setState('ai_spend', s, new Date(now));
  return s.usd;
}

/**
 * Collects one batch when it has ended: each answer read and checked (readAnswer), saved, and its real cost put in
 * place of its worst case. Returns 'ended', 'running', 'gone' (the API no longer has it: asked again next run) or
 * 'error' (t.stopped says why).
 */
async function collect(db, api, id, { price, t, now, log }) {
  let b;
  try {
    b = await api.status(id);
  } catch (e) {
    const p = problemOf(e, api.Anthropic);
    if (!p) throw e;
    if (p.gone) {
      await db.query("UPDATE ai_checks SET status = 'error', error = 'batch_gone', est = 0 WHERE batch_id = ?1 AND status = 'pending'", [id]);
      log('AI check: a batch from an earlier run is gone; its products are asked again');
      return 'gone';
    }
    t.stopped = p.text;
    return 'error';
  }
  if (b.processing_status !== 'ended') return 'running';
  const rows = new Map((await db.query(IN_BATCH_SQL, [id])).map((r) => [r.custom_id, r]));
  const out = [];
  const at = new Date(now()).toISOString();
  try {
    for await (const r of api.results(id)) {
      const row = rows.get(r.custom_id);
      if (!row) continue; // asked again in a newer batch meanwhile
      rows.delete(r.custom_id);
      const res = (r && r.result) || {};
      const item = { key: row.product_key, est: Number(row.est) || 0, cost: 0 };
      if (res.type === 'succeeded') {
        const usage = (res.message && res.message.usage) || {};
        Object.assign(item, { cost: costOf(usage, price), tin: Number(usage.input_tokens) || 0, tout: Number(usage.output_tokens) || 0 });
        try {
          const a = readAnswer(res.message, { flags: flagsOf(row.input_flags) });
          Object.assign(item, { status: 'ok', fit: a.value.fit, confidence: a.value.confidence, verdict: JSON.stringify(a.value), flags: JSON.stringify(a.flags), model: String(res.message.model || '').slice(0, 80), error: '' });
        } catch (e) {
          if (!(e instanceof AiError)) throw e;
          Object.assign(item, { status: 'error', error: e.reason });
        }
      } else if (res.type === 'errored') {
        const err = (res.error && (res.error.error || res.error)) || {};
        const type = String(err.type || 'error').replace(/[^a-z_]/g, '').slice(0, 40);
        Object.assign(item, { status: 'error', error: 'api_' + type, noimg: type === 'invalid_request_error' ? 1 : 0 }); // most often a photo the API could not fetch
      } else Object.assign(item, { status: 'error', error: String(res.type || 'no_result').replace(/[^a-z_]/g, '').slice(0, 20) }); // expired, canceled
      out.push(item);
    }
  } catch (e) {
    const p = problemOf(e, api.Anthropic);
    if (!p) throw e;
    t.stopped = p.text; // nothing saved from this batch: it is collected again next run
    return 'error';
  }
  for (const row of rows.values()) out.push({ key: row.product_key, est: Number(row.est) || 0, cost: 0, status: 'error', error: 'no_result' });
  for (const part of chunks(out, 200)) await db.query(ANSWER_SQL, [JSON.stringify(part), id, at]);
  t.collected += out.length;
  t.ok += out.filter((x) => x.status === 'ok').length;
  t.errors += out.filter((x) => x.status !== 'ok').length;
  const cost = out.reduce((a, x) => a + x.cost, 0);
  t.cost_usd += cost;
  t.month_usd = await addSpend(db, now(), out.reduce((a, x) => a + x.cost - x.est, 0));
  log(`AI check: ${out.length} answers in (${out.filter((x) => x.status === 'ok').length} read, ${out.filter((x) => x.status !== 'ok').length} failed), cost ${usd(cost)}`);
  return 'ended';
}

/**
 * One run. api: anthropicApi() (null: no key, the AI read is off). env: AI_MODEL, AI_MAX_USD, AI_MONTH_USD, AI_LIMIT,
 * AI_WAIT_MINUTES, AI_IMAGES. Saves its summary in D1 state 'ai_check'. Throws only when D1 fails.
 */
export async function aiCheck({ db, api = null, env = {}, now = Date.now, log = console.log, sleep = wait, pollMs = POLL_MS }) {
  const model = String(env.AI_MODEL || '').trim() || MODEL;
  const price = priceOf(model, env);
  const maxUsd = bounded(env.AI_MAX_USD, 0.5, 0, 50);
  const monthUsd = bounded(env.AI_MONTH_USD, 5, 0, 500);
  const limit = Math.round(bounded(env.AI_LIMIT, 500, 0, 10000));
  const waitMs = bounded(env.AI_WAIT_MINUTES, 0, 0, MAX_WAIT_MINUTES) * 60000;
  const t = { model, submitted: 0, collected: 0, ok: 0, errors: 0, pending: 0, left: 0, est_usd: 0, cost_usd: 0, month_usd: 0, max_usd: maxUsd, month_max_usd: monthUsd, batch: '', off: '', stopped: '' };
  const finish = async () => {
    const [p] = await db.query("SELECT COUNT(*) AS n FROM ai_checks WHERE status = 'pending'").catch(() => [{ n: 0 }]);
    t.pending = Number(p && p.n) || 0;
    t.est_usd = Math.round(t.est_usd * 1e6) / 1e6;
    t.cost_usd = Math.round(t.cost_usd * 1e6) / 1e6;
    await db.setState('ai_check', { ...t, at: new Date(now()).toISOString() }, new Date(now()));
    return t;
  };
  if (!api) {
    t.off = 'no ANTHROPIC_API_KEY';
    log('AI check off: no ANTHROPIC_API_KEY secret (the board shows no AI read)');
    return finish();
  }
  if (!price) {
    t.off = `no price known for ${model.slice(0, 60)}`;
    log(`AI check off: no price known for ${model.slice(0, 60)}, so no spend cap; set AI_PRICE_IN and AI_PRICE_OUT (USD per million tokens)`);
    return finish();
  }

  // 1. What earlier runs sent.
  for (const { batch_id: id } of await db.query(PENDING_BATCHES_SQL)) {
    if (t.stopped) break;
    await collect(db, api, id, { price, t, now, log });
  }

  // 2. What to ask: no current read, not waiting in a batch, fewer than 3 failed tries on this input.
  const spend = await spendOf(db, now());
  t.month_usd = spend.usd;
  const have = new Map((await db.query(ROWS_SQL)).map((r) => [r.product_key, r]));
  const todo = [];
  const seen = new Set(); // one request per product: a repeated custom_id would make the API refuse the whole batch
  for (const c of await candidates(db, now())) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    const hash = inputHash(c, model);
    const row = have.get(c.key);
    const same = !!row && row.input_hash === hash;
    if (row && row.status === 'pending') continue;
    if (same && row.status === 'ok') continue;
    if (same && row.status === 'error' && Number(row.tries) >= MAX_TRIES) continue;
    todo.push({ c, hash, tries: same ? Number(row.tries) || 0 : 0, noimg: same && Number(row.no_image) === 1 });
  }
  const want = todo.length;
  todo.splice(t.stopped ? 0 : limit);
  await worldAds(db, todo.map((x) => x.c));
  let budget = Math.max(0, Math.min(maxUsd, monthUsd - spend.usd));
  const send = [];
  for (const x of todo) {
    const req = requestOf(x.c, { model, image: env.AI_IMAGES !== '0' && !x.noimg });
    const est = worstCase(req, price);
    if (est > budget) break; // in order: the next ones wait for the next run
    budget -= est;
    send.push({ ...x, req, est });
  }
  t.left = want - send.length;

  // 3. One batch, saved at once: a batch D1 cannot hold is cancelled, so nothing is paid for that nobody reads.
  if (send.length && !t.stopped) {
    let b;
    try {
      b = await api.submit(send.map((x) => x.req));
    } catch (e) {
      const p = problemOf(e, api.Anthropic);
      if (!p) throw e;
      t.stopped = p.text;
      t.left = want;
    }
    if (b) {
      const at = new Date(now()).toISOString();
      try {
        for (const part of chunks(send.map((x) => ({ key: x.c.key, hash: x.hash, cid: x.req.custom_id, flags: x.req.flags, noimg: x.noimg ? 1 : 0, est: x.est, tries: x.tries + 1 })), 200)) {
          await db.query(PENDING_SQL, [JSON.stringify(part), b.id, model, at]);
        }
      } catch (e) {
        await api.cancel(b.id).catch(() => {});
        throw e;
      }
      t.batch = b.id;
      t.submitted = send.length;
      t.est_usd = send.reduce((a, x) => a + x.est, 0);
      t.month_usd = await addSpend(db, now(), t.est_usd);
      log(`AI check: ${send.length} products sent in one batch (${model}), at most ${usd(t.est_usd)}${t.left ? `; ${t.left} left for the next run` : ''}`);
    }
  } else if (want && !t.stopped) log(`AI check: nothing sent; ${want} products wait for the next run (${limit ? `spend cap: ${usd(budget)} left` : 'AI_LIMIT is 0'})`);

  // 4. Wait for it a while; a batch still running is collected by the next run.
  const until = now() + waitMs;
  while (t.batch && !t.stopped && now() < until) {
    await sleep(Math.min(pollMs, Math.max(until - now(), 0)));
    if ((await collect(db, api, t.batch, { price, t, now, log })) !== 'running') break;
  }
  return finish();
}

/** The run's summary for the Actions page: counts and money only (the repository is public). */
export function summaryOf(t) {
  if (t.off) return `**AI read:** off (${t.off}).`;
  const parts = [`${t.submitted} products sent (at most ${usd(t.est_usd)})`, `${t.ok} read`, `${t.errors} failed`, `${t.pending} waiting in a batch`, `${t.left} left for the next run`];
  return `**AI read** (${t.model}): ${parts.join(', ')}. Cost of answers in this run ${usd(t.cost_usd)}; this month ${usd(t.month_usd)} of ${usd(t.month_max_usd)}.${t.stopped ? ` Stopped: ${t.stopped}.` : ''}`;
}

async function main() {
  const s = d1Settings(process.env);
  if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID');
  const apiKey = String(process.env.ANTHROPIC_API_KEY || '').trim();
  const api = apiKey ? await anthropicApi({ apiKey }) : null;
  const t = await aiCheck({ db: d1Client(s), api, env: process.env });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summaryOf(t)}\n`);
  console.log(summaryOf(t).replace(/\*\*/g, ''));
  if (t.off) console.log(`::notice::AI read off: ${t.off}`);
  if (t.stopped) {
    console.log(`::${/next run/.test(t.stopped) ? 'warning' : 'error'}::AI check stopped: ${t.stopped}`);
    if (!/next run/.test(t.stopped)) process.exitCode = 1; // a refused key or request will not fix itself
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::${String(e.message || e).replace(/\bhttps?:\/\/\S+/gi, '[link]').slice(0, 300)}`);
    process.exit(1);
  });
}
