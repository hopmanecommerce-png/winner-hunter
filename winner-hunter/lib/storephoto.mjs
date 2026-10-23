/*
 * Photo URLs for the board (only URLs: the board loads them straight from the store's CDN).
 *   sized(url, 400)     Shopify CDN photos at 400 px wide (smaller and faster on a phone).
 *   storePhoto(landing) when the ad has no product photo: a photo from its landing page — a collection's first
 *                       product, else the page's og:image / twitter:image (logos, icons and svg skipped), else the
 *                       store's newest product. Returns '' when nothing is found; never throws.
 */

export const WIDTH = 400;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HTML_MAX = 1.5e6;

// Logos, favicons, icons and "no image" placeholders (Shopify's own sit under /shopifycloud/) are no product photos.
export function looksLikeLogo(url) {
  let p;
  try {
    p = decodeURIComponent(new URL(url).pathname).toLowerCase();
  } catch (e) {
    return true;
  }
  return /logo|favicon|(^|[^a-z])icons?([^a-z]|$)|apple-touch|placeholder|no[-_]?image|\/shopifycloud\//.test(p) || /\.svg$/.test(p);
}

// An absolute https URL from what a page wrote: relative, protocol-relative or http (stores serve https too).
export function absolute(src, base) {
  if (!src) return '';
  try {
    const u = new URL(String(src).trim().replace(/&amp;/g, '&'), base);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' ? u.href : '';
  } catch (e) {
    return '';
  }
}

const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')) || []).slice(2).find((x) => x != null) || '';

// The page's share photo: <meta property="og:image"> (or og:image:secure_url, twitter:image); '' when none or a logo.
export function photoFromHtml(html, base) {
  const found = {};
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const key = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
    if (!/^(og:image(:secure_url|:url)?|twitter:image(:src)?)$/.test(key) || found[key]) continue;
    found[key] = attr(tag, 'content');
  }
  for (const key of ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']) {
    const u = absolute(found[key], base);
    if (u && !looksLikeLogo(u)) return u;
  }
  return '';
}

// /collections/<handle> landing pages: the collection's products.json (first product only).
export function collectionJsonUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/collections\/([^/?#]+)\/?$/i);
    return m ? `https://${u.host}/collections/${m[1]}/products.json?limit=1` : '';
  } catch (e) {
    return '';
  }
}

// First image of the first product in a Shopify products.json answer.
export function photoFromProducts(json, base) {
  const p = (json && (json.product || (json.products && json.products[0]))) || null;
  const img = p && ((p.images && p.images[0] && p.images[0].src) || (p.image && p.image.src));
  const u = absolute(img, base);
  return u && !looksLikeLogo(u) ? u : '';
}

// The store's newest product (products.json), as a last resort.
export function storeProductsUrl(landing) {
  try {
    const u = new URL(landing);
    return /^https?:$/.test(u.protocol) ? `https://${u.host}/products.json?limit=1` : '';
  } catch (e) {
    return '';
  }
}

// Shopify CDN photos resize with ?width= (cdn.shopify.com, or the store's own /cdn/shop/ path).
export function sized(url, width = WIDTH) {
  let u;
  try {
    u = new URL(String(url || '').startsWith('//') ? 'https:' + url : url);
  } catch (e) {
    return '';
  }
  if (u.protocol === 'http:') u.protocol = 'https:';
  if (u.protocol !== 'https:') return '';
  if (u.hostname !== 'cdn.shopify.com' && !/^\/(cdn\/shop|s\/files)\//.test(u.pathname)) return u.href;
  u.searchParams.delete('height');
  u.searchParams.delete('crop');
  u.searchParams.set('width', String(width));
  return u.href;
}

// Shopify answers 429/503 when a store is asked too often: wait a moment and ask once more.
export const RETRY_MS = { wait: 3000 };
async function get(url, accept, doFetch, timeout = 15000, retry = true) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await doFetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': UA, accept } });
    if (retry && (res.status === 429 || res.status === 503)) {
      clearTimeout(t);
      res.body?.cancel?.().catch(() => {});
      const after = Math.min(Number(res.headers.get('retry-after')) * 1000 || RETRY_MS.wait, 10000);
      await new Promise((ok) => setTimeout(ok, after));
      return get(url, accept, doFetch, timeout, false);
    }
    return { res, t };
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

// The landing page's HTML up to </head> (enough for og:image).
async function pageHtml(url, doFetch) {
  const r = await get(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', doFetch);
  if (!r) return null;
  try {
    if (!r.res.ok || !/html/i.test(r.res.headers.get('content-type') || 'text/html')) return null;
    const base = r.res.url || url;
    if (!r.res.body || !r.res.body.getReader) return { html: (await r.res.text()).slice(0, HTML_MAX), base };
    const reader = r.res.body.getReader();
    const dec = new TextDecoder();
    let html = '';
    while (html.length < HTML_MAX) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});
    return { html, base };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(r.t);
  }
}

async function productsJson(url, base, doFetch) {
  const r = await get(url, 'application/json', doFetch);
  if (!r) return '';
  try {
    return r.res.ok ? photoFromProducts(await r.res.json(), base) : '';
  } catch (e) {
    return ''; // not a Shopify store
  } finally {
    clearTimeout(r.t);
  }
}

/** A photo URL for a landing page: collection's first product, else og:image, else the store's newest product. */
export async function storePhotoUrl(landing, doFetch = globalThis.fetch) {
  if (!/^https?:\/\//.test(landing || '')) return '';
  const cj = collectionJsonUrl(landing);
  let u = cj ? await productsJson(cj, landing, doFetch) : '';
  if (!u) {
    const page = await pageHtml(landing, doFetch);
    u = page ? photoFromHtml(page.html, page.base) : '';
  }
  if (!u) {
    const sp = storeProductsUrl(landing);
    u = sp ? await productsJson(sp, landing, doFetch) : '';
  }
  return u ? sized(u) : '';
}

/** Same, looked up once per landing page per process. Never throws. */
export function photoCache(doFetch = globalThis.fetch) {
  const cache = new Map();
  return (landing) => {
    const key = String(landing || '');
    if (!cache.has(key)) cache.set(key, storePhotoUrl(key, doFetch).catch(() => ''));
    return cache.get(key);
  };
}
