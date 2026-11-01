/*
 * Lasso stores: Shopify stores whose checkout runs on Lasso (lassocommerce.com, "Checkout as a Service", payments
 * through Whop, Stripe, Adyen or NMI, with upsells and order bumps). Such a store is a product-research lead: Lasso is
 * used by direct-response stores that spend on ads (see docs/research/lasso-stores.md).
 *
 * How a Lasso store shows itself (checked 2026-11-01):
 *   - its pages load <script src="https://checkout.<store>/shopify-scripts/lasso-script-v4.min.js" data-store-id="<24 hex>"
 *     data-checkout-url="checkout.<store>/checkout"> (also -v2, the first one, subscriptions-script.js, elevate-script.js,
 *     language-script.js; on Lasso's own host checkout.lassocheckout.com when the store has no checkout host of its own)
 *   - its checkout host (checkout.<store>) is a CNAME to Lasso's Vercel project, LASSO_CNAME, and serves Lasso's
 *     checkout page (body class "lasso-dark-boot", localStorage key "lasso_theme_hint")
 *
 * Where candidates come from (free, no key):
 *   - AlienVault OTX passive DNS for LASSO_CNAME: every host seen with a CNAME to it        otxHosts(json)
 *   - DuckDuckGo Tracker Radar: the CNAMEs its crawler saw                                  ddgHosts(json)
 *   - urlscan.io search: scans of pages that called lassocheckout.com or loaded the script   urlscanHosts(results)
 * Every candidate is then checked on the store itself (checkStore, checkCheckout); nothing is listed unverified.
 *
 *   lassoTag(html)            → { script, version, scriptHost, storeId, apiUrl, checkoutUrl } of the Lasso tag, or null
 *   lassoMarks(html)          → ['tag', 'inline', 'theme']: the signs of Lasso in a page
 *   isLassoCheckout(html)     → true for Lasso's checkout page
 *   storeOf('checkout.x.com') → 'x.com' (the store behind a checkout host); pageStore(host) the same for a scanned page
 *   isAddOn(product), topProducts(best) → shipping protection, insurance and free gifts are no products
 *   await checkStore('x.com')        → { domain, live, status, url, shopify, lasso, title, lang, currency, country, error? }
 *   await checkCheckout('checkout.x.com') → { host, lasso, status }
 *   await bestSellers('x.com')       → { products: [{ title, handle, url, price, compareAt, currency, image, type }] } | { error }
 *   await shopMeta('x.com')          → { name, city, country, currency, products, shipsTo } (Shopify's /meta.json), or null
 *   await catalogSize('x.com')       → number of products (250 = 250 or more), or null
 *   adLibraryUrl('x.com')            → the Meta Ad Library search for the domain (all countries, active ads)
 * Fetchers never throw; doFetch is injectable (tests).
 */
import { API_VERSION } from './bestsellers.mjs';

export const LASSO_CNAME = '1a28dfb57b1e1efc.vercel-dns-016.com'; // what Lasso's dashboard tells a store to CNAME checkout.<store> to
export const OLD_CNAME = 'a94813196ce765c4.vercel-dns-016.com'; // the same before March 2026 (most of those stores are gone)
export const SCRIPT_HOST = 'checkout.lassocheckout.com';
// urlscan.io searches: pages that called Lasso's API, pages that loaded Lasso's script (from the store's own checkout
// host, so the API call is not always in the scan), and Lasso checkout pages on a store's own host (Vercel, title
// "Secure Checkout": checkCheckout tells them from other checkouts).
export const URLSCAN_QUERIES = [
  'domain:lassocheckout.com',
  'filename:"lasso-script-v4.min.js"',
  'filename:"lasso-script-v2.min.js"',
  'filename:"lasso-script.min.js"',
  'page.title:"Secure Checkout" AND page.server:Vercel',
];
// DuckDuckGo Tracker Radar (its crawler's CNAME list, public on GitHub, updated about monthly).
export const DDG_URL = 'https://raw.githubusercontent.com/duckduckgo/tracker-radar/main/domains/US/vercel-dns-016.com.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HTML_MAX = 2e6;

const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')) || []).slice(2).find((x) => x != null) || '';
const HEX24 = /^[0-9a-f]{24}$/i;

/**
 * The Lasso script tag in a page, or null: { script, version, scriptHost, storeId, apiUrl, checkoutUrl }.
 * The script is served by the store's own checkout host (checkout.<store>/shopify-scripts/lasso-script-v4.min.js) or
 * by Lasso's; other names under /shopify-scripts/ (subscriptions-script.js, elevate-script.js, language-script.js,
 * lasso-cart.js) carry the same data-store-id / data-checkout-url. version: 'v4', 'v2', … ('' for the first one).
 */
export function lassoTag(html) {
  for (const tag of String(html || '').match(/<script\b[^>]*>/gi) || []) {
    const src = attr(tag, 'src');
    const id = attr(tag, 'data-store-id');
    const checkoutUrl = attr(tag, 'data-checkout-url');
    if (!/\/shopify-scripts\/[\w.-]+\.js/i.test(src) && !(checkoutUrl && HEX24.test(id))) continue;
    if (!/\/shopify-scripts\/lasso-/i.test(src) && !checkoutUrl && !HEX24.test(id)) continue;
    const v = /lasso-script(?:-(v\d+))?(?:\.min)?\.js/i.exec(src);
    return {
      script: (/\/shopify-scripts\/([\w.-]+\.js)/i.exec(src) || [])[1] || '',
      version: (v && v[1]) || '',
      scriptHost: src ? checkoutHostOf(src.replace(/^\/\//, 'https://')) : '',
      storeId: HEX24.test(id) ? id.toLowerCase() : '',
      apiUrl: attr(tag, 'data-api-url'),
      checkoutUrl,
    };
  }
  return null;
}

/**
 * Every sign of Lasso in a store page: 'tag' (lassoTag), 'inline' (Lasso's own code pasted into the theme:
 * __LASSO_GUARD__, lasso_sid, proceedToCheckout…), 'theme' (the theme's name says Lasso; a theme can be a copy, so
 * this one alone proves nothing).
 */
export function lassoMarks(html) {
  const s = String(html || '');
  const marks = [];
  if (lassoTag(s)) marks.push('tag');
  if (/__LASSO_GUARD__|__lasso_token__|initLassoCartIntegration|["']lasso_sid["']/.test(s)) marks.push('inline');
  if (/Shopify\.theme\s*=\s*\{"name":"[^"]*lasso/i.test(s)) marks.push('theme');
  return marks;
}

/** Lasso's checkout page (the boot skeleton every Lasso checkout serves, on checkout.lassocheckout.com or a store's own host). */
export const isLassoCheckout = (html) => /lasso-dark-boot|lasso_theme_hint/.test(String(html || ''));

/** A host name, lower case, without "www." and a trailing dot; '' when it is no host name. */
export function cleanHost(h) {
  const s = String(h || '').trim().toLowerCase().replace(/\.$/, '').replace(/^\*\./, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s.replace(/^www\./, '') : '';
}

/** The host a checkout URL points at (data-checkout-url has no https:// as a rule), or ''. */
export function checkoutHostOf(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try {
    return cleanHost(new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname);
  } catch (e) {
    return '';
  }
}

/** The store behind a checkout host: the first label goes (checkout.x.com, secure.x.co.uk → x.com, x.co.uk). */
export function storeOf(host) {
  const h = cleanHost(host);
  const parts = h.split('.');
  if (parts.length < 3) return h;
  const rest = parts.slice(1);
  // checkout.co.uk-style hosts have no store name left: keep them as they are
  if (rest.length === 2 && /^(co|com|net|org|gov|ac)$/.test(rest[0]) && rest[1].length === 2) return h;
  return rest.join('.');
}

/** Hosts that are Lasso's own (not a store). */
export const ownHost = (h) => /(^|\.)(lassocheckout\.com|lassocommerce\.com|lassocart\.com|vercel-dns-016\.com)$/.test(cleanHost(h));

// Hosts of a store that are no store page: its checkout and its customer portal (account.<store>, Lasso's subscriptions).
const SIDE = /^(checkout|secure|pay|payments?|account|accounts|portal|subscriptions?|billing)\./;

/** The store behind a page that called Lasso: checkout.x.com, account.x.com → x.com; any other page host is the store. */
export const pageStore = (host) => (SIDE.test(cleanHost(host)) ? storeOf(host) : cleanHost(host));

/** OTX passive DNS answer → [{ host, first, last }] of hosts with a CNAME to `target` (newest first). */
export function otxHosts(json, target = LASSO_CNAME) {
  const rows = (json && Array.isArray(json.passive_dns) && json.passive_dns) || [];
  const out = new Map();
  for (const r of rows) {
    if (String(r.record_type).toUpperCase() !== 'CNAME' || cleanHost(r.address) !== target) continue;
    const host = cleanHost(r.hostname);
    if (!host || ownHost(host)) continue;
    const o = out.get(host) || { host, first: r.first || '', last: r.last || '' };
    if (r.first && (!o.first || r.first < o.first)) o.first = r.first;
    if (r.last && r.last > o.last) o.last = r.last;
    out.set(host, o);
  }
  return [...out.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
}

/** DuckDuckGo Tracker Radar's file for vercel-dns-016.com → the hosts it saw with a CNAME to `target`. */
export function ddgHosts(json, target = LASSO_CNAME) {
  const rows = (json && Array.isArray(json.cnames) && json.cnames) || [];
  return [...new Set(rows.filter((c) => c && cleanHost(c.resolved) === target).map((c) => cleanHost(c.original)).filter((h) => h && !ownHost(h)))];
}

/** DuckDuckGo Tracker Radar's file (no key): the answer, or { error }. */
export async function ddgRadar({ doFetch = globalThis.fetch, timeout = 30000 } = {}) {
  const r = await get(doFetch, DDG_URL, { timeout, accept: 'application/json' });
  if (!r.ok) return { error: r.error || 'HTTP ' + r.status };
  try {
    return JSON.parse(r.text);
  } catch (e) {
    return { error: 'not json' };
  }
}

/** urlscan.io search results → [{ host, seen }] of the scanned pages (one per host, newest scan). */
export function urlscanHosts(results) {
  const out = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    const host = cleanHost(r && r.page && r.page.domain);
    if (!host || ownHost(host) || /(^|\.)myshopify\.com$/.test(host)) continue;
    const seen = String((r.task && r.task.time) || '').slice(0, 10);
    const o = out.get(host);
    if (!o || seen > o.seen) out.set(host, { host, seen });
  }
  return [...out.values()];
}

async function get(doFetch, url, { timeout = 20000, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', method = 'GET', body, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await doFetch(url, { method, body, signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept, ...headers } });
    const text = (await res.text()).slice(0, HTML_MAX);
    return { ok: res.ok, status: res.status, url: res.url || url, text };
  } catch (e) {
    return { ok: false, status: 0, url, text: '', error: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(t);
  }
}

/** OTX passive DNS for a host (no key needed): the answer, or { error }. */
export async function otxPassiveDns(host = LASSO_CNAME, { doFetch = globalThis.fetch, timeout = 60000 } = {}) {
  const r = await get(doFetch, `https://otx.alienvault.com/api/v1/indicators/hostname/${encodeURIComponent(host)}/passive_dns`, { timeout, accept: 'application/json' });
  if (!r.ok) return { error: r.error || 'HTTP ' + r.status };
  try {
    return JSON.parse(r.text);
  } catch (e) {
    return { error: 'not json' };
  }
}

/**
 * urlscan.io search (public scans; a key is optional and only raises the limits): every result page, up to `max`
 * results. → { results } or { error, results } (what came before the error).
 */
export async function urlscanSearch(q, { doFetch = globalThis.fetch, key = '', max = 1000, timeout = 60000, wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), pause = 2000 } = {}) {
  const results = [];
  let after = '';
  while (results.length < max) {
    const u = new URL('https://urlscan.io/api/v1/search/');
    u.searchParams.set('q', q);
    u.searchParams.set('size', String(Math.min(100, max - results.length)));
    if (after) u.searchParams.set('search_after', after);
    const r = await get(doFetch, u.href, { timeout, accept: 'application/json', headers: key ? { 'api-key': key } : {} });
    if (!r.ok) return { error: r.error || 'HTTP ' + r.status, results };
    let page;
    try {
      page = JSON.parse(r.text).results || [];
    } catch (e) {
      return { error: 'not json', results };
    }
    results.push(...page);
    const last = page[page.length - 1];
    if (page.length < 100 || !last || !Array.isArray(last.sort)) break;
    after = last.sort.join(',');
    await wait(pause);
  }
  return { results };
}

const SHOP_RE = /Shopify\.shop\s*=\s*["']([a-z0-9-]+\.myshopify\.com)["']/i;
const text1 = (re, s) => ((re.exec(s) || [])[1] || '').trim();
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

/** What a store's home page says: live, Shopify, its Lasso tag, name, language, currency, country. Never throws. */
export async function checkStore(domain, { doFetch = globalThis.fetch, timeout = 20000 } = {}) {
  const d = cleanHost(domain);
  const r = await get(doFetch, `https://${d}/`, { timeout });
  const html = r.text || '';
  const out = { domain: d, live: r.ok && html.length > 200, status: r.status, url: r.url };
  if (r.error) out.error = r.error;
  out.shopify = SHOP_RE.test(html) || /cdn\.shopify\.com|\/cdn\/shop\/|ShopifyAnalytics/.test(html);
  out.myshopify = text1(SHOP_RE, html).toLowerCase();
  out.lasso = lassoTag(html);
  out.marks = lassoMarks(html);
  out.title = decode(text1(/<title[^>]*>([\s\S]*?)<\/title>/i, html)).slice(0, 140);
  out.siteName = decode(text1(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i, html)).slice(0, 80);
  out.lang = text1(/<html[^>]*\blang=["']?([a-zA-Z-]+)/i, html).toLowerCase();
  out.currency = text1(/Shopify\.currency\s*=\s*\{"active":"([A-Z]{3})"/, html);
  out.country = text1(/Shopify\.country\s*=\s*["']([A-Z]{2})["']/, html);
  return out;
}

/** Does this host serve Lasso's checkout page? { host, lasso, status }. Never throws. */
export async function checkCheckout(host, { doFetch = globalThis.fetch, timeout = 20000 } = {}) {
  const h = cleanHost(host);
  const r = await get(doFetch, `https://${h}/`, { timeout });
  return { host: h, lasso: r.ok && isLassoCheckout(r.text), status: r.status };
}

const BEST = `query ($n: Int!) { products(first: $n, sortKey: BEST_SELLING) { nodes { title handle productType
  priceRange { minVariantPrice { amount currencyCode } } compareAtPriceRange { maxVariantPrice { amount } } featuredImage { url } } } }`;

/** The store's best sellers, best first, from its Storefront API (no token, Shopify's own sales order). Never throws. */
export async function bestSellers(domain, { n = 5, doFetch = globalThis.fetch, timeout = 20000 } = {}) {
  const d = cleanHost(domain);
  const r = await get(doFetch, `https://${d}/api/${API_VERSION}/graphql.json`, {
    timeout, method: 'POST', accept: 'application/json', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: BEST, variables: { n } }),
  });
  if (!r.ok) return { error: r.error || 'HTTP ' + r.status };
  let nodes;
  try {
    nodes = JSON.parse(r.text).data.products.nodes;
  } catch (e) {
    return { error: 'api error' };
  }
  const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  return {
    products: (Array.isArray(nodes) ? nodes : []).map((p) => {
      const min = (p.priceRange && p.priceRange.minVariantPrice) || {};
      const cmp = num(p.compareAtPriceRange && p.compareAtPriceRange.maxVariantPrice && p.compareAtPriceRange.maxVariantPrice.amount);
      return {
        title: decode(p.title).slice(0, 160),
        handle: String(p.handle || ''),
        url: p.handle ? `https://${d}/products/${p.handle}` : '',
        price: num(min.amount),
        compareAt: cmp && cmp > num(min.amount) ? cmp : null,
        currency: String(min.currencyCode || ''),
        image: (p.featuredImage && p.featuredImage.url) || '',
        type: decode(p.productType).slice(0, 60),
      };
    }),
  };
}

/**
 * The shop's own facts from Shopify's public /meta.json: { name, city, country (where the business is registered),
 * currency, products (exact count), shipsTo: ['DE', …] }, or null when the store does not answer it. Never throws.
 */
export async function shopMeta(domain, { doFetch = globalThis.fetch, timeout = 20000 } = {}) {
  const r = await get(doFetch, `https://${cleanHost(domain)}/meta.json`, { timeout, accept: 'application/json' });
  try {
    const j = r.ok && JSON.parse(r.text);
    if (!j || !j.myshopify_domain) return null;
    const n = Number(j.published_products_count);
    return {
      name: decode(j.name).slice(0, 120),
      city: decode(j.city).slice(0, 60),
      country: /^[A-Z]{2}$/.test(j.country || '') ? j.country : '',
      currency: /^[A-Z]{3}$/.test(j.currency || '') ? j.currency : '',
      products: Number.isFinite(n) && n >= 0 ? n : null,
      shipsTo: (Array.isArray(j.ships_to_countries) ? j.ships_to_countries : []).filter((c) => /^[A-Z]{2}$/.test(c)),
      myshopify: String(j.myshopify_domain || '').toLowerCase(),
    };
  } catch (e) {
    return null;
  }
}

/**
 * How many products the store lists, at most 250 counted (250 = 250 or more): products.json, else the Storefront API
 * (stores that switch products.json off). null when neither says.
 */
export async function catalogSize(domain, { doFetch = globalThis.fetch, timeout = 20000 } = {}) {
  const d = cleanHost(domain);
  const r = await get(doFetch, `https://${d}/products.json?limit=250`, { timeout, accept: 'application/json' });
  try {
    const p = r.ok && JSON.parse(r.text).products;
    if (Array.isArray(p)) return p.length;
  } catch (e) {
    // not JSON: ask the Storefront API
  }
  const g = await get(doFetch, `https://${d}/api/${API_VERSION}/graphql.json`, {
    timeout, method: 'POST', accept: 'application/json', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ products(first: 250) { nodes { id } } }' }),
  });
  try {
    const nodes = g.ok && JSON.parse(g.text).data.products.nodes;
    return Array.isArray(nodes) ? nodes.length : null;
  } catch (e) {
    return null;
  }
}

/** The Meta Ad Library search for a domain: active ads, all countries (open it in a browser). */
export const adLibraryUrl = (domain) =>
  `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=${encodeURIComponent(cleanHost(domain))}`;

// Lines a Lasso store sells next to its products (shipping protection, insurance, a free gift): no product to copy.
const ADD_ON = /shipping (protection|insurance)|insurance|protection (de votre colis|du colis)|package protection|security package|versicher|sicherheitspaket|versandschutz|forsendelsesbeskyttelse|verzendbescherming|delivery guarantee|priority (handling|processing)|mystery gift|free (gift|piece)|gratis cadeau|gift card|geschenkkarte|cadeaukaart/i;

/** True for an add-on line (shipping protection, insurance, a free gift…), not a product. */
export const isAddOn = (p) => ADD_ON.test(String((p && p.title) || ''));

/** The store's real best sellers: add-ons and free lines out, at most n. */
export const topProducts = (best, n = 3) => (Array.isArray(best) ? best : []).filter((p) => p && p.title && !isAddOn(p) && Number(p.price) > 0).slice(0, n);

/** One-product store, a small niche store or a general store, from the number of products. */
export function storeKind(count) {
  if (count == null) return '';
  if (count <= 3) return 'one-product';
  if (count <= 25) return 'niche';
  return 'general';
}
