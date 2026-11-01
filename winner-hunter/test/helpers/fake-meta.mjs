// Fake Meta Graph API (graph.test) and fake Shopify stores, for the hunt and run tests.
export const NOW = Date.UTC(2026, 9, 14);
const day = (d) => new Date(NOW - d * 864e5).toISOString().slice(0, 10);
const ad = (id, page, name, caption, title, days, reach, body = 'Nu 60% korting') => ({
  id, page_id: page, page_name: name, ad_creative_link_captions: [caption], ad_creative_link_titles: [title], ad_creative_bodies: [body],
  ad_delivery_start_time: day(days), eu_total_reach: reach, publisher_platforms: ['facebook', 'instagram'], ad_snapshot_url: 'https://x/' + id,
});
export { ad as fakeAd };

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

// A request the hunt should never send. Thrown inside fetch it would be caught by the hunt as a network error and the
// test could still pass, so it is written down here instead: the test files that use this fake check it stays empty.
export const violations = [];
const expect = (ok, what, u) => {
  if (!ok) violations.push(`${what}: ${u}`);
};

/**
 * Fake Meta Graph API (graph.test) + fake Shopify stores. Like the real ones: answers in pages (at most `limit`, and at most
 * pageSize, with paging.next carrying an after cursor), a search only lists ads delivered in the asked dates (started on or
 * before the window's last day: they all still run), and a store's search always answers something (the product with that
 * name, else its first one).
 * opts: { expired, debug(token), block(u), rateLimitOnce, byKeyword(q) (ads instead of SEARCH), counts: { page id: active ads },
 * stores: { domain: { meta, products } } (more stores), pageSize }.
 */
export function fakeFetch(calls = [], opts = {}) {
  let limited = opts.rateLimitOnce ? 1 : 0;
  const counts = Object.assign({}, COUNTS, opts.counts);
  const stores = Object.assign({}, STORES, opts.stores);
  const pageOf = (url, u, list, size) => {
    const limit = Number(u.searchParams.get('limit'));
    expect(Number.isInteger(limit) && limit >= 1, 'no limit', u);
    const n = Math.max(1, Math.min(limit || 25, size));
    const from = Number(u.searchParams.get('after') || 0);
    const next = new URL(url);
    next.searchParams.set('after', String(from + n));
    return json({ data: list.slice(from, from + n), ...(from + n < list.length ? { paging: { next: next.toString() } } : {}) });
  };
  return async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.hostname === 'graph.test') {
      if (opts.expired) return json({ error: { code: 190, message: 'Error validating access token' } }, 400);
      // debug_token: opts.debug(token) → the answer; default a valid token that never expires
      if (u.pathname.endsWith('/debug_token')) {
        expect(u.searchParams.get('input_token') === u.searchParams.get('access_token'), 'debug_token not asked by the token itself', u);
        return opts.debug ? opts.debug(u.searchParams.get('input_token')) : json({ data: { is_valid: true, expires_at: 0 } });
      }
      if (opts.block && opts.block(u)) return blocked613();
      if (limited) {
        limited--;
        return json({ error: { code: 613, message: 'Calls to this api have exceeded the rate limit.' } }, 400);
      }
      expect(u.searchParams.get('access_token'), 'no access_token', u);
      expect(u.searchParams.get('ad_active_status') === 'ACTIVE', 'not only active ads', u);
      const pids = u.searchParams.get('search_page_ids');
      if (pids) {
        const pid = JSON.parse(pids)[0];
        const list = Array.from({ length: counts[pid] || 0 }, (_, i) => ({ id: pid + '-' + i, ad_creative_link_titles: [i < 3 ? 'Linen Summer Dress' : 'Other ' + i], ad_delivery_start_time: day(i % 60) }));
        return pageOf(url, u, list, opts.pageSize || 100);
      }
      const min = u.searchParams.get('ad_delivery_date_min');
      const max = u.searchParams.get('ad_delivery_date_max');
      expect(min && max && min <= max, 'no age window', u);
      const q = u.searchParams.get('search_terms');
      const list = (opts.byKeyword ? opts.byKeyword(q) : SEARCH).filter((a) => String(a.ad_delivery_start_time).slice(0, 10) <= max);
      return pageOf(url, u, list, opts.pageSize || 4);
    }
    const store = stores[u.hostname.replace(/^www\./, '')];
    if (u.pathname === '/meta.json') return store ? json(store.meta, 200, { 'powered-by': 'Shopify' }) : new Response('<h1>nope</h1>', { status: 404 });
    if (u.pathname === '/search/suggest.json') {
      const all = store ? Object.values(store.products) : [];
      const p = store && (store.products[u.searchParams.get('q').toLowerCase()] || all[0]);
      return json({ resources: { results: { products: p ? [p] : [] } } });
    }
    return new Response('', { status: 404 });
  };
}

export const base = { tokens: ['tok'], queries: ['dress'], countries: ['NL', 'BE'], base: 'https://graph.test', api: 'v24.0' };
