/*
 * Proof that a product sells: its rank in its store's own best-seller list.
 * Every Shopify store answers its Storefront API without a token, and sortKey BEST_SELLING is Shopify's own sales
 * order (the same call the Koala Inspector extension uses). Headless stores and stores that switch the API off
 * answer nothing: their products get no rank (unknown, not "not selling").
 *
 *   productKey('https://www.store.com/nl/products/lamp?x=1') → 'store.com/products/lamp'   ('' when not a product page)
 *   await storeTop('store.com')     → { top: [{ id, handle }, …] } best first (TOP_N), or { error }
 *   await productId(url)            → '123' (Shopify product id from <product page>.js) or null
 *   rankOf(top, { id, handle })     → 1… or null (not in the top)
 *   addDay(history, day, rank)      → the history with today's rank (one per day, last HISTORY_DAYS)
 *   movement(history)               → { from, to, days } (from null: new in the top) or null (too little history)
 * The board (worker/src/app.mjs) has its own copy of productKey and movement: keep them the same.
 */
import { hostOf, hostKey } from './score.mjs';

export const TOP_N = 50;
export const API_VERSION = '2026-10';
export const HISTORY_DAYS = 15;
const DAY = 864e5;
const QUERY = `query ($n: Int!) { products(first: $n, sortKey: BEST_SELLING) { nodes { id handle } } }`;

/** 'store.com/products/handle' for a product page (locale prefix and query dropped), else ''. */
export function productKey(u) {
  const host = hostOf(u);
  if (!host) return '';
  const m = /\/products\/([^/?#]+)/.exec(new URL(u).pathname);
  if (!m) return '';
  let handle = m[1];
  try {
    handle = decodeURIComponent(handle);
  } catch (e) {
    // keep it as it is
  }
  handle = handle.replace(/\.(js|json)$/i, '').toLowerCase();
  return handle ? `${hostKey(host)}/products/${handle}` : '';
}

const idOf = (gid) => String(gid ?? '').split('/').pop();

async function timed(doFetch, url, init, timeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    return await doFetch(url, Object.assign({ signal: ctrl.signal, redirect: 'follow' }, init));
  } finally {
    clearTimeout(t);
  }
}

/** The store's best sellers, best first: { top: [{ id, handle }] } or { error } (never throws). */
export async function storeTop(store, { n = TOP_N, doFetch = globalThis.fetch, timeout = 15000 } = {}) {
  try {
    const res = await timed(doFetch, `https://${store}/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { n } }),
    }, timeout);
    if (res.status === 429) return { error: 'HTTP 429', limited: true }; // says nothing about this store
    const j = await res.json().catch(() => null);
    const nodes = j && j.data && j.data.products && j.data.products.nodes;
    if (!Array.isArray(nodes)) return { error: j && j.errors ? 'api error' : 'HTTP ' + res.status };
    return { top: nodes.map((p) => ({ id: idOf(p.id), handle: String(p.handle || '').toLowerCase() })) };
  } catch (e) {
    return { error: e.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

/** A product page's Shopify product id (from <page>.js), or null. */
export async function productId(url, { doFetch = globalThis.fetch, timeout = 15000 } = {}) {
  try {
    const u = new URL(url);
    const res = await timed(doFetch, `${u.origin}${u.pathname.replace(/\/$/, '')}.js`, { headers: { Accept: 'application/json' } }, timeout);
    const j = await res.json().catch(() => null);
    return j && j.id != null ? String(j.id) : null;
  } catch (e) {
    return null;
  }
}

/** 1-based rank of the product in the store's list (by id, else by handle), or null. */
export function rankOf(top, { id, handle } = {}) {
  let i = id ? top.findIndex((p) => p.id === String(id)) : -1;
  if (i < 0 && handle) i = top.findIndex((p) => p.handle === handle);
  return i < 0 ? null : i + 1;
}

/** History [[day, rank|null], …] with `rank` for `day` (replacing that day), oldest first, last HISTORY_DAYS days. */
export function addDay(history, day, rank) {
  const h = (Array.isArray(history) ? history : []).filter((e) => Array.isArray(e) && e[0] !== day);
  h.push([day, rank ?? null]);
  h.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const first = new Date(Date.parse(day) - (HISTORY_DAYS - 1) * DAY).toISOString().slice(0, 10);
  return h.filter((e) => e[0] >= first);
}

/**
 * How the rank moved: from the newest entry at least 7 days before the latest one, or else the oldest entry when
 * it is at least 2 days older. { from, to, days } (from null: it was not in the top then), or null.
 */
export function movement(history) {
  const h = Array.isArray(history) ? history : [];
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  const daysBack = (e) => Math.round((Date.parse(last[0]) - Date.parse(e[0])) / DAY);
  const base = [...h].reverse().find((e) => daysBack(e) >= 7) || (daysBack(h[0]) >= 2 ? h[0] : null);
  return base ? { from: base[1], to: last[1], days: daysBack(base) } : null;
}
