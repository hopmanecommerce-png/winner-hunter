// Fake Meta Graph API (graph.test) and fake Shopify stores, for the hunt and run tests.
import assert from 'node:assert';

export const NOW = Date.UTC(2026, 9, 14);
const day = (d) => new Date(NOW - d * 864e5).toISOString().slice(0, 10);
const ad = (id, page, name, caption, title, days, reach, body = 'Nu 60% korting') => ({
  id, page_id: page, page_name: name, ad_creative_link_captions: [caption], ad_creative_link_titles: [title], ad_creative_bodies: [body],
  ad_delivery_start_time: day(days), eu_total_reach: reach, publisher_platforms: ['facebook', 'instagram'], ad_snapshot_url: 'https://x/' + id,
});

const SEARCH = [
  ad('1', '501', 'Anna Boutique', 'ANNA-BOUTIQUE.SHOP', 'Linen Summer Dress', 14, 154000),
  ad('2', '501', 'Anna Boutique', 'anna-boutique.shop', 'Linen Summer Dress', 9, 31000),
  ad('3', '502', 'Old Glory', 'oldglory.store', 'Wool Coat', 75, 9000, 'New in'),
  ad('4', '503', 'Amazon', 'amazon.de', 'Deals', 10, 900000),
  ad('5', '504', 'Real Brand', 'realbrand.test', 'Shirt', 10, 5000),
  ad('6', '505', 'Tiny Shop', 'tinyshop.store', 'Mug', 12, 800, 'New in'),
  ad('7', '501', 'Anna Boutique', 'anna-boutique.shop', '{{product.name}}', 20, 1000),
];
const COUNTS = { 501: 134, 502: 96, 505: 12 };
const STORES = {
  'anna-boutique.shop': { meta: { myshopify_domain: 'anna.myshopify.com', currency: 'EUR', published_products_count: 420 },
    products: { 'linen summer dress': { title: 'Linen Summer Dress', price: '49.95', compare_at_price_max: '119.95', url: '/products/linen-dress?_pos=1', image: '//cdn.shopify.com/s/files/1/l.png?v=2' } } },
  'oldglory.store': { meta: { myshopify_domain: 'og.myshopify.com', currency: 'EUR', published_products_count: 150 }, products: {} },
  'tinyshop.store': { meta: { myshopify_domain: 't.myshopify.com', currency: 'EUR', published_products_count: 20 }, products: {} },
};
export const usageHdr = (pct, regain = 0) => ({ 'x-business-use-case-usage': JSON.stringify({ 123: [{ type: 'ads_archive', call_count: 10, total_cputime: 1, total_time: pct, estimated_time_to_regain_access: regain }] }) });
export const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
export const blocked613 = () => json({ error: { code: 613, message: '(#613) Calls to this api have exceeded the rate limit.' } }, 400, usageHdr(104, 1043));

/** Fake Meta Graph API (graph.test) + fake Shopify stores. */
export function fakeFetch(calls = [], opts = {}) {
  let limited = opts.rateLimitOnce ? 1 : 0;
  return async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.hostname === 'graph.test') {
      if (opts.expired) return json({ error: { code: 190, message: 'Error validating access token' } }, 400);
      // debug_token: opts.debug(token) → the answer; default a valid token that never expires
      if (u.pathname.endsWith('/debug_token')) {
        assert.strictEqual(u.searchParams.get('input_token'), u.searchParams.get('access_token'));
        return opts.debug ? opts.debug(u.searchParams.get('input_token')) : json({ data: { is_valid: true, expires_at: 0 } });
      }
      if (opts.block && opts.block(u)) return blocked613();
      if (limited) {
        limited--;
        return json({ error: { code: 613, message: 'Calls to this api have exceeded the rate limit.' } }, 400);
      }
      assert.ok(u.searchParams.get('access_token'));
      assert.strictEqual(u.searchParams.get('ad_active_status'), 'ACTIVE');
      const pids = u.searchParams.get('search_page_ids');
      if (pids) {
        const pid = JSON.parse(pids)[0];
        return json({ data: Array.from({ length: COUNTS[pid] || 0 }, (_, i) => ({ id: pid + '-' + i, ad_creative_link_titles: [i < 3 ? 'Linen Summer Dress' : 'Other ' + i], ad_delivery_start_time: day(i % 60) })) });
      }
      assert.ok(u.searchParams.get('ad_delivery_date_min') && u.searchParams.get('ad_delivery_date_max'));
      if (u.searchParams.get('ad_delivery_date_max') !== day(7)) return json({ data: [] }); // the youngest age window (7+ days)
      const q = u.searchParams.get('search_terms');
      const list = opts.byKeyword ? opts.byKeyword(q) : SEARCH;
      const after = u.searchParams.get('after');
      return after ? json({ data: list.slice(4) }) : json({ data: list.slice(0, 4), paging: list.length > 4 ? { next: url + '&after=p2' } : undefined });
    }
    const store = STORES[u.hostname.replace(/^www\./, '')];
    if (u.pathname === '/meta.json') return store ? json(store.meta, 200, { 'powered-by': 'Shopify' }) : new Response('<h1>nope</h1>', { status: 404 });
    if (u.pathname === '/search/suggest.json') {
      const p = store && store.products[u.searchParams.get('q').toLowerCase()];
      return json({ resources: { results: { products: p ? [p] : [] } } });
    }
    return new Response('', { status: 404 });
  };
}

export const base = { tokens: ['tok'], queries: ['dress'], countries: ['NL', 'BE'], base: 'https://graph.test', api: 'v24.0' };
