// A fake Scrape Creators API (Google's ad library) and fake Shopify stores, from test/fixtures/google/sample.json: SAMPLE
// DATA, no real advertiser. For the tests, and for `node winner-hunter/google.mjs --fixtures` (no key, no credits).
// Like the real API: the key in x-api-key (else 401), one credit per call (credits_charged, credits_remaining), 404 for an
// ad it does not know, pages with a cursor. Like a Shopify store: meta.json, its search (always answers something: the
// product with a word in common, else its first one) and /products/<handle>.json.
import fs from 'node:fs';

export const SAMPLE_KEY = 'sample-key-not-real';
const DAY = 864e5;
const SAMPLE = JSON.parse(fs.readFileSync(new URL('../fixtures/google/sample.json', import.meta.url), 'utf8'));
const vendor = (name) => JSON.parse(fs.readFileSync(new URL(`../fixtures/google/vendor-${name}.json`, import.meta.url), 'utf8'));
export const VENDOR = { search: vendor('advertisers-search'), ads: vendor('company-ads'), ad: vendor('ad') };

/** The sample with its "@-20d" dates as real dates before `now`. */
export function sampleData(now) {
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = /^@-(\d+(?:\.\d+)?)d$/.exec(v);
      return m ? new Date(now - Number(m[1]) * DAY).toISOString() : v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(SAMPLE);
}

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);

/**
 * fetch() for api.scrapecreators.com and the sample's shops. calls: every URL asked (URL objects). opts: { now, key (the one
 * the API takes), data (instead of the sample), answer(u) (a Response or null: overrides, for errors), credits (start) }.
 */
export function googleFetch(calls = [], opts = {}) {
  const now = opts.now ?? Date.now();
  const data = opts.data || sampleData(now);
  const key = opts.key ?? SAMPLE_KEY;
  let credits = opts.credits ?? 1000;
  const paid = (o) => {
    credits -= 1;
    return json({ success: true, credits_remaining: credits, credits_charged: 1, ...o });
  };
  return async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u);
    const forced = opts.answer && (await opts.answer(u, init));
    if (forced) return forced;
    if (u.hostname === 'api.scrapecreators.com') {
      const headers = init.headers || {};
      if ((headers['x-api-key'] ?? headers['X-Api-Key']) !== key) return json({ success: false, error: 'unauthorized', message: 'Invalid API key' }, 401);
      const p = u.searchParams;
      if (u.pathname === '/v1/google/adLibrary/advertisers/search') {
        const hit = data.search[`${p.get('query')}|${p.get('region') || 'US'}`] || { advertisers: [], websites: [] };
        return paid(hit);
      }
      if (u.pathname === '/v1/google/company/ads') {
        const id = p.get('advertiser_id') ? 'adv:' + p.get('advertiser_id') : 'domain:' + p.get('domain');
        const list = data.companies[id] || [{ ads: [], cursor: null, number_of_ads_estimate: 0 }];
        const i = p.get('cursor') ? Math.max(1, list.findIndex((pg) => pg.cursor === p.get('cursor')) + 1) : 0;
        return paid(list[i] || { ads: [], cursor: null });
      }
      if (u.pathname === '/v1/google/ad') {
        const m = /creative\/(CR\d+)/.exec(p.get('url') || '');
        const ad = m && data.ads[m[1]];
        return ad ? paid(ad) : json({ success: false, error: 'not_found', message: 'Ad not found' }, 404);
      }
      return json({ success: false, error: 'not_found' }, 404);
    }
    const store = data.stores[u.hostname.replace(/^www\./, '')];
    if (!store || store.notShopify) return new Response('<html>not a shop</html>', { status: u.pathname === '/meta.json' ? 404 : 200, headers: { 'content-type': 'text/html' } });
    if (u.pathname === '/meta.json') return json(store.meta);
    if (u.pathname === '/search/suggest.json') {
      const q = words(u.searchParams.get('q'));
      const list = Object.entries(store.products);
      const hit = list.find(([h, x]) => words(`${x.title} ${h}`).some((w) => q.includes(w))) || list[0];
      const [handle, x] = hit || [];
      return json({ resources: { results: { products: hit ? [{ title: x.title, url: `/products/${handle}?_pos=1`, price: (x.variants || [{}])[0].price }] : [] } } });
    }
    const m = /^\/products\/([^/]+)\.json$/.exec(u.pathname);
    if (m && store.products[m[1]]) return json({ product: store.products[m[1]] });
    return new Response('not found', { status: 404 });
  };
}
