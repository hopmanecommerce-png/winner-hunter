/*
 * Lasso stores: Shopify stores that send their buyers to Lasso's hosted checkout (lassocommerce.com, "Checkout as a
 * Service": upsells, order bumps, subscriptions, payments over Whop, Stripe, Adyen and NMI). A store pays $149 a month
 * and 1% of its sales for that, so it is mostly a store with paid traffic on a product that sells: a place to find products.
 *
 * How a Lasso store shows itself (checked on live stores, 2026-11-01 and 2026-11-02; docs/research/lasso-stores.md and
 * lasso-discovery.md):
 *   - its pages load <script src="https://checkout.<store>/shopify-scripts/lasso-script-v4.min.js" data-store-id="<24 hex>"
 *     data-checkout-url="checkout.<store>/checkout"> (older: lasso-script-v2.min.js, lasso-script.min.js; for subscriptions:
 *     shopify-scripts/subscriptions-script.js), which talks to api.lassocheckout.com. Some stores run Lasso from theme code
 *     without any of these: their checkout still shows it.
 *   - checkout.<store>/checkout is Lasso's checkout app ("Secure Checkout", with lasso_theme_hint and lasso-dark-boot in it).
 *     Its DNS is a CNAME to 1a28dfb57b1e1efc.vercel-dns-016.com (84 % of the hostnames there are Lasso checkouts; a few are
 *     other apps, so only the page itself is proof). lib/lasso-sources.mjs finds them that way.
 *   - data-store-id is a MongoDB ObjectId: its first 8 hex digits are the moment the store's Lasso account was made.
 * urlscan.io's search finds the pages that load that script, without an account (then only the last 30 days, at most 100
 * results a search, 30 searches a minute: sweep() asks per day window).
 *
 *   findLasso(html)                     → [{ src, version, storeId, checkoutUrl, checkoutHost, apiUrl }], one per script tag
 *   lassoSince(storeId)                 → '2026-06-25' (the day the store joined Lasso) or ''
 *   isLassoCheckout(html)               → is this page Lasso's checkout app?
 *   await urlscanSearch(q, opts)        → { results, total } or { results: [], error }
 *   await sweep(q, opts)                → { scans, errors, searches }: every scan of the last `days` days
 *   candidatesOf(scans)                 → [{ domain, how, scans, first_seen, last_seen }] the stores those pages belong to
 *   domainsIn(text)                     → the store domains in a list of addresses (a reverse-CNAME export, LASSO_EXTRA)
 *   await checkLassoStore(domain, opts) → the store as it is now (never throws); confidence '' = not a Lasso store
 *   marketsOf(row)                      → the markets outside the EU (lib/world.mjs MARKETS) to look for its ads in
 *   toCsv(rows)                         → the list as CSV
 */
import { hostOf, hostKey, SHOPIFY_HDR } from './score.mjs';
import { MARKETS } from './world.mjs';
import { API_VERSION } from './bestsellers.mjs';

const DAY = 864e5;
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// The urlscan.io searches. The script's file name finds every store page that loads it; api.lassocheckout.com also finds
// the customer portals (account.<store>, a CNAME to lasso-customer-portal.pages.dev); the fifth one finds checkout pages.
// Tested 2026-11-02 (docs/research/lasso-discovery.md): Whop's pixel and payment elements, which Lasso stores load even
// without Lasso's script on the page (6 and 1 stores the others missed, 12 % and 2 % of their pages are Lasso stores);
// Lasso's subscriptions script; and the favicon of Lasso's customer portals.
export const URLSCAN_QUERIES = [
  'filename:"lasso-script-v4.min.js"',
  'filename:"lasso-script-v2.min.js"',
  'filename:"lasso-script.min.js"',
  'domain:lassocheckout.com',
  'page.domain:checkout.* AND page.title:"Secure Checkout"',
  'domain:t.whop.tw',
  'domain:cdn.whop.com',
  'filename:"subscriptions-script.js"',
  'filename:"subscriptions-script.min.js"',
  'filename:"lasso-favicon.png"',
];
export const URLSCAN_MAX = 100; // results in one answer
export const URLSCAN_PAUSE_MS = 2100; // urlscan allows 30 searches a minute without a key (header x-rate-limit-limit)
export const CHECKOUT_MARKERS = /lasso_theme_hint|lasso-dark-boot/;
const PORTAL_PREFIX = /^(account|accounts|subscriptions|subscription|billing|portal|my|members)\./;
// Pages that are no store: a link shortener, Shopify's own addresses, preview sites, Lasso's and Whop's own sites.
const NOT_A_STORE = /(^|\.)(share\.google|myshopify\.com|shopify\.com|pages\.dev|vercel\.app|lassocheckout\.com|lassocommerce\.com|lassocart\.com|whop\.com|whop\.site|whop\.tw)$/;

const attr = (tag, name) => (new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag) || [])[1] || '';

/**
 * The Lasso script tags of a page: [{ src, version ('v4', 'v2', 'v1', 'subscriptions'), storeId, checkoutUrl, checkoutHost,
 * apiUrl }]. The subscriptions script has a name another app could use: it counts with Lasso's path and store id only.
 */
export function findLasso(html) {
  const out = [];
  for (const [tag] of String(html || '').matchAll(/<script\b[^>]*(?:lasso-script|shopify-scripts\/subscriptions-script)[^>]*>/gi)) {
    const src = attr(tag, 'src');
    const v = /lasso-script(?:-v(\d+))?(?:\.min)?\.js/i.exec(src);
    const storeId = attr(tag, 'data-store-id');
    const subs = !v && /\/shopify-scripts\/subscriptions-script(?:\.min)?\.js/i.test(src) && /^[0-9a-f]{24}$/i.test(storeId);
    if (!v && !subs) continue;
    const checkoutUrl = attr(tag, 'data-checkout-url');
    out.push({
      src,
      version: subs ? 'subscriptions' : v[1] ? 'v' + v[1] : 'v1',
      storeId,
      checkoutUrl,
      checkoutHost: hostOf(/^https?:\/\//i.test(checkoutUrl) ? checkoutUrl : 'https://' + checkoutUrl) || hostOf(src) || '',
      apiUrl: attr(tag, 'data-api-url'),
    });
  }
  return out;
}

/** The day a store joined Lasso, from its data-store-id (a MongoDB ObjectId starts with its creation time), or ''. */
export function lassoSince(storeId) {
  if (!/^[0-9a-f]{24}$/i.test(String(storeId || ''))) return '';
  const sec = parseInt(storeId.slice(0, 8), 16);
  return sec > 1.5e9 ? new Date(sec * 1000).toISOString().slice(0, 10) : ''; // before 2017: not a real id
}

export const isLassoCheckout = (html) => CHECKOUT_MARKERS.test(String(html || ''));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One urlscan.io search. key: an urlscan API key (optional: more searches a day, older scans). Never throws. */
export async function urlscanSearch(q, { doFetch = globalThis.fetch, key = '', size = URLSCAN_MAX, timeout = 60000, sleep = wait, tries = 3 } = {}) {
  const url = `https://urlscan.io/api/v1/search/?${new URLSearchParams({ q, size: String(size) })}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await doFetch(url, { headers: { Accept: 'application/json', ...(key ? { 'API-Key': key } : {}) }, signal: AbortSignal.timeout(timeout) });
      if (res.status === 429 && attempt + 1 < tries) {
        // Too many searches: urlscan says how long to wait.
        const after = Number(res.headers.get('x-rate-limit-reset-after')) || 30;
        await sleep(Math.min(after, 300) * 1000);
        continue;
      }
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || !Array.isArray(j.results)) return { results: [], total: 0, error: (j && (j.message || j.description)) || 'HTTP ' + res.status };
      return { results: j.results, total: Number(j.total) || j.results.length };
    } catch (e) {
      if (attempt + 1 >= tries) return { results: [], total: 0, error: e.name === 'TimeoutError' ? 'timeout' : 'network' };
      await sleep(5000);
    }
  }
}

/**
 * Every scan of the last `days` days for a search: urlscan gives at most 100 results an answer and no next page
 * without a key, so it asks per window of 2 days and splits a window that holds more, down to 2 hours.
 * → { scans: [raw results, one per scan], errors, searches }
 */
export async function sweep(q, { days = 30, now = Date.now(), pauseMs = URLSCAN_PAUSE_MS, sleep = wait, ...opts } = {}) {
  const scans = new Map();
  let errors = 0;
  let searches = 0;
  const minSpan = 2 * 3600e3;
  const window = async (from, to) => {
    if (searches) await sleep(pauseMs);
    searches++;
    const got = await urlscanSearch(`(${q}) AND date:[${new Date(from).toISOString()} TO ${new Date(to).toISOString()}]`, { sleep, ...opts });
    if (got.error) errors++;
    for (const r of got.results) if (r && r._id) scans.set(r._id, r);
    if (got.total > got.results.length && to - from > minSpan) {
      const mid = from + Math.floor((to - from) / 2);
      await window(from, mid);
      await window(mid, to);
    }
  };
  for (let from = now - days * DAY; from < now; from += 2 * DAY) await window(from, Math.min(from + 2 * DAY, now));
  return { scans: [...scans.values()], errors, searches };
}

/**
 * The stores behind urlscan's scans: the page's own domain (www. dropped), the store of a customer portal
 * (account.store.com → store.com) or of a checkout page (checkout.store.com → store.com), and an address that sent the
 * scan on to another one (sister stores often do). → [{ domain, how: [why], scans, first_seen, last_seen }]
 */
export function candidatesOf(scans) {
  const out = new Map();
  const add = (domain, how, time) => {
    domain = hostKey(String(domain || '').toLowerCase().replace(/\.$/, ''));
    if (!domain || !domain.includes('.') || NOT_A_STORE.test(domain)) return;
    const c = out.get(domain) || { domain, how: [], scans: 0, first_seen: time, last_seen: time };
    if (!c.how.includes(how)) c.how.push(how);
    c.scans++;
    if (time && (!c.first_seen || time < c.first_seen)) c.first_seen = time;
    if (time && (!c.last_seen || time > c.last_seen)) c.last_seen = time;
    out.set(domain, c);
  };
  for (const s of scans || []) {
    const page = hostKey(String((s.page && s.page.domain) || (s.task && s.task.domain) || '').toLowerCase());
    const sent = hostKey(String((s.task && s.task.domain) || '').toLowerCase());
    const time = (s.task && s.task.time) || '';
    if (!page) continue;
    if (PORTAL_PREFIX.test(page) && /customer portal/i.test((s.page && s.page.title) || '')) add(page.replace(PORTAL_PREFIX, ''), 'portal', time);
    else if (/^checkout\./.test(page)) add(page.slice('checkout.'.length), 'checkout page', time);
    else add(page, 'store page', time);
    if (sent && sent !== page) add(sent, 'sends on to ' + page, time);
  }
  return [...out.values()];
}

const cut = (t, n) => Array.from(String(t ?? '')).slice(0, n).join('');
const pick = (re, s) => (re.exec(s) || [])[1] || '';
const text = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&ndash;/g, '–').replace(/\s+/g, ' ').trim();
const money = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) === 0 ? null : Number(v));

async function get(doFetch, url, { timeout = 20000, accept = 'text/html,application/xhtml+xml', method = 'GET', body, headers = {}, coolMs = 20000 } = {}) {
  try {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await doFetch(url, { method, body, redirect: 'follow', signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.9', ...headers } });
      if (res.status !== 429 || attempt) break;
      await wait(coolMs); // Shopify asks every store's visitor to slow down at once: once more after a pause
    }
    const hdrs = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
    return { status: res.status, url: res.url || url, text: await res.text(), headers: hdrs };
  } catch (e) {
    // ENOTFOUND: that address does not exist (a checkout subdomain the store took away). Else it did not answer.
    const code = (e.cause && e.cause.code) || '';
    return { status: 0, url, text: '', headers: '', error: e.name === 'TimeoutError' ? 'timeout' : code === 'ENOTFOUND' ? 'no such host' : 'network' };
  }
}

const BEST = `query ($n: Int!) { products(first: $n, sortKey: BEST_SELLING) { nodes { title handle productType createdAt
  priceRange { minVariantPrice { amount currencyCode } } compareAtPriceRange { maxVariantPrice { amount } } } } }`;

/** A store's best sellers (Shopify's own sales order, Storefront API without a token), best first; [] when it gives none. */
export async function bestSellers(host, { doFetch = globalThis.fetch, n = 5, timeout = 20000, coolMs } = {}) {
  const r = await get(doFetch, `https://${host}/api/${API_VERSION}/graphql.json`, { method: 'POST', body: JSON.stringify({ query: BEST, variables: { n } }),
    headers: { 'Content-Type': 'application/json' }, accept: 'application/json', timeout, coolMs });
  let nodes = null;
  try {
    nodes = JSON.parse(r.text).data.products.nodes;
  } catch (e) {
    return [];
  }
  return (Array.isArray(nodes) ? nodes : []).map((p) => ({
    title: cut(p.title, 200), handle: cut(p.handle, 200), type: cut(p.productType, 80), created: String(p.createdAt || '').slice(0, 10),
    price: money(p.priceRange && p.priceRange.minVariantPrice && p.priceRange.minVariantPrice.amount),
    compare_at: money(p.compareAtPriceRange && p.compareAtPriceRange.maxVariantPrice && p.compareAtPriceRange.maxVariantPrice.amount),
    currency: cut(p.priceRange && p.priceRange.minVariantPrice && p.priceRange.minVariantPrice.currencyCode, 8),
  }));
}

/**
 * How sure: 'high' the store loads Lasso's script and its checkout address is Lasso's checkout app; 'medium' only one of
 * the two, or the checkout did not answer; 'low' the script is still there but its checkout address is gone or now
 * something else (the store left Lasso); '' no Lasso at all.
 */
export function confidenceOf({ script, checkout_lasso: co, checkout_error: err, checkout_status: st }) {
  if (script && co) return 'high';
  if (co) return 'medium';
  // A checkout that is slow or down for a moment says nothing; one that is gone or answers as something else does.
  if (script) return err === 'timeout' || st >= 500 ? 'medium' : 'low';
  return '';
}

/**
 * The store domains in any list of addresses (one a line, a CSV such as a reverse-CNAME export, LASSO_EXTRA):
 * checkout.store.com, account.store.com and www.store.com all give store.com.
 */
export function domainsIn(text) {
  const out = new Set();
  for (const [h] of String(text || '').toLowerCase().matchAll(/(?<![\w.@-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?![\w-])/g)) {
    const d = hostKey(h.replace(/^checkout\./, '').replace(PORTAL_PREFIX, ''));
    if (d.includes('.') && !NOT_A_STORE.test(d) && !/\.(csv|json|txt|html?|js|png|jpe?g)$/.test(d)) out.add(d);
  }
  return [...out];
}

/** The store as it is now. Never throws: a store that does not answer comes back with live 0 and its error. */
export async function checkLassoStore(domain, { doFetch = globalThis.fetch, timeout = 20000, best = 5, now = Date.now(), coolMs = 20000 } = {}) {
  const row = { store: hostKey(domain), host: domain, live: 0, status: 0, confidence: '', script: '', lasso_store_id: '', lasso_since: '', checkout_url: '', checkout_status: 0,
    checkout_lasso: 0, checkout_error: '', name: '', title: '', country: '', currency: '', lang: '', products: null, best_sellers: [], error: '', checked_at: new Date(now).toISOString() };
  let home = await get(doFetch, `https://${domain}/`, { timeout, coolMs });
  if (!home.status || home.status >= 500) home = await get(doFetch, `https://www.${hostKey(domain)}/`, { timeout, coolMs });
  const html = home.text || '';
  row.status = home.status;
  row.error = home.error || '';
  const host = hostOf(home.url) || domain;
  row.host = host;
  row.store = hostKey(host);
  // 402 / 423: Shopify's "this store is unavailable" (closed or frozen); a password page is a store that is not open.
  row.live = home.status === 200 && !/\/password(\?|$)/.test(home.url) && !/<form[^>]+action=["']\/password["']/i.test(html) ? 1 : 0;
  const tag = findLasso(html)[0];
  if (tag) Object.assign(row, { script: tag.version, lasso_store_id: tag.storeId, lasso_since: lassoSince(tag.storeId) });
  const coHost = (tag && tag.checkoutHost) || `checkout.${row.store}`;
  const co = await get(doFetch, `https://${coHost}/checkout`, { timeout, coolMs });
  Object.assign(row, { checkout_url: `https://${coHost}/checkout`, checkout_status: co.status, checkout_lasso: isLassoCheckout(co.text) ? 1 : 0, checkout_error: co.error || '' });
  row.confidence = confidenceOf({ script: row.script, ...row });
  row.title = cut(text(pick(/<title[^>]*>([\s\S]*?)<\/title>/i, html)), 160);
  row.lang = cut(pick(/<html[^>]*\blang=["']([^"']+)["']/i, html), 12);
  const shopify = /cdn\.shopify\.com|Shopify\.shop\s*=/.test(html) || SHOPIFY_HDR.test(home.headers || '');
  if (row.confidence && row.live && shopify) {
    const m = await get(doFetch, `https://${host}/meta.json`, { timeout, accept: 'application/json', coolMs });
    try {
      const j = JSON.parse(m.text);
      Object.assign(row, { name: cut(j.name, 120), country: cut(j.country, 4), currency: cut(j.currency, 8), products: typeof j.published_products_count === 'number' ? j.published_products_count : null });
    } catch (e) {
      // no meta.json: a headless shop
    }
    if (best) row.best_sellers = await bestSellers(host, { doFetch, n: best, timeout, coolMs });
  }
  if (!row.name) row.name = cut(text(pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i, html)) || row.title, 120);
  return row;
}

// A store's own currency → its market outside the EU (lib/world.mjs MARKETS).
const CURRENCY_MARKET = { USD: 'US', AUD: 'AU', NZD: 'NZ', CAD: 'CA', CHF: 'CH', NOK: 'NO', SGD: 'SG', AED: 'AE', HKD: 'HK', JPY: 'JP', KRW: 'KR', MYR: 'MY', TWD: 'TW', ILS: 'IL' };

/** The markets outside the EU to look for a store's ads in: its country and its currency's, at most 2. [] for an EU or UK store. */
export function marketsOf({ country = '', currency = '' } = {}) {
  const out = [];
  for (const cc of [String(country).toUpperCase(), CURRENCY_MARKET[String(currency).toUpperCase()]]) if (cc && MARKETS.includes(cc) && !out.includes(cc)) out.push(cc);
  return out.slice(0, 2);
}

// source and found_at: set for a store this run found new (lasso.mjs), '' for one saved before.
export const CSV_COLS = ['store', 'confidence', 'live', 'name', 'country', 'currency', 'lang', 'products', 'script', 'lasso_since', 'checkout_url', 'best_seller', 'best_seller_price', 'best_sellers', 'first_seen', 'last_seen', 'how', 'source', 'found_at', 'aliases'];

/** The list as CSV. A cell that starts like a formula (= + - @) gets a ' first, so a spreadsheet shows it as text. */
export function toCsv(rows) {
  const cell = (v) => {
    let s = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) {
    const b = (r.best_sellers || [])[0] || {};
    const v = { ...r, best_seller: b.title || '', best_seller_price: b.price != null ? `${b.price} ${b.currency || ''}`.trim() : '', best_sellers: (r.best_sellers || []).map((p) => p.title) };
    lines.push(CSV_COLS.map((c) => cell(v[c])).join(','));
  }
  return lines.join('\n') + '\n';
}
