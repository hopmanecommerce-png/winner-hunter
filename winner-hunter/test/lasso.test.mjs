// Lasso stores: the fingerprints (lib/lasso.mjs) on pages as live Lasso stores serve them (2026-11-01), urlscan's search
// and its 100-result answers, the stores behind the scans, the live check of a store, and a run of lasso.mjs on fake
// urlscan answers, fake stores, a fake Ad Library and the in-memory D1. Also: its workflow stays off unless asked for.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { findLasso, lassoSince, isLassoCheckout, urlscanSearch, sweep, candidatesOf, checkLassoStore, confidenceOf, marketsOf, toCsv, domainsIn, URLSCAN_QUERIES, CSV_COLS } from '../lib/lasso.mjs';
import { discover, writeOut, STORES_SQL, MAX_AD_SEARCHES } from '../lasso.mjs';
import { d1Client } from '../lib/d1.mjs';
import { libraryUrl } from '../lib/world.mjs';
import { d1Rest } from './helpers/sqlite-d1.mjs';

const NOW = Date.UTC(2026, 10, 1, 12);
const DAY = 864e5;
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...headers } });
const html = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html' } });
const noSleep = async () => {};

// A store page as Lasso stores serve it (the tag is copied from tryglowgummies.com, outdoorhaven.dk and cocosydney.co).
const STORE_V4 = `<!doctype html><html lang="en"><head><title>Glow Gummies</title><meta property="og:site_name" content="Glow Gummies">
<script>var Shopify = Shopify || {};Shopify.shop = "zucwqx-1m.myshopify.com";Shopify.locale = "en";Shopify.currency = {"active":"USD","rate":"1.0"};</script>
<link href="//cdn.shopify.com/s/files/1/x.css" rel="stylesheet"></head><body>
<script
  src="https://checkout.tryglowgummies.com/shopify-scripts/lasso-script-v4.min.js"
  data-store-id="6a3c9a6d78c8ee551d08f2f2"
  data-checkout-url="checkout.tryglowgummies.com/checkout"
  defer>
</script></body></html>`;
const TAG_V1 = `<script
  src="https://checkout.outdoorhaven.dk/shopify-scripts/lasso-script.min.js"
  data-store-id="694313d63335b94071f4b57f"
  data-api-url="https://livebackend.lassocheckout.com:3000/api"
  data-checkout-url="checkout.outdoorhaven.dk/checkout"
  defer>
</script>`;
const TAG_V2 = `<script src='https://checkout.cocosydney.co/shopify-scripts/lasso-script-v2.min.js' data-store-id='692c0aacf505e77e9f9cccb2' data-checkout-url='checkout.cocosydney.co/checkout' defer></script>`;
const PLAIN_STORE = '<html lang="de"><head><title>Feldmann München</title><script src="//cdn.shopify.com/a.js"></script></head><body>Shopify.shop = "x.myshopify.com"</body></html>';
// checkout.<store>/checkout: Lasso's app, Lasso's page for a domain without an active store, another app on the same Vercel address.
const LASSO_CHECKOUT = `<!doctype html><html lang="en" class="notranslate"><head><title>Secure Checkout</title><style>body.lasso-dark-boot { background: #1f1f1f; }</style>
<script type="module" crossorigin src="/assets/main-cRDZ_vbe.js"></script></head><body><div id="initial-skeleton"></div><div id="root"></div>
<script>const hint = JSON.parse(localStorage.getItem('lasso_theme_hint') || '{}');</script></body></html>`;
const NOT_FOUND_CHECKOUT = '<!doctype html><html lang="en"><head><meta name="robots" content="noindex"><title>Store not found</title></head><body><h1>Store not found</h1><p>This domain is not connected to an active store.</p></body></html>';
const OTHER_APP = '<!DOCTYPE html><html><head><title>Revio</title></head><body>404: This page could not be found.</body></html>';

test('the script tag: version, store id, checkout address, older tags too; nothing on a store without Lasso', () => {
  assert.deepStrictEqual(findLasso(STORE_V4), [{ src: 'https://checkout.tryglowgummies.com/shopify-scripts/lasso-script-v4.min.js', version: 'v4', storeId: '6a3c9a6d78c8ee551d08f2f2',
    checkoutUrl: 'checkout.tryglowgummies.com/checkout', checkoutHost: 'checkout.tryglowgummies.com', apiUrl: '' }]);
  const [v1] = findLasso(TAG_V1);
  assert.strictEqual(v1.version, 'v1');
  assert.strictEqual(v1.apiUrl, 'https://livebackend.lassocheckout.com:3000/api');
  assert.strictEqual(v1.checkoutHost, 'checkout.outdoorhaven.dk');
  const [v2] = findLasso(TAG_V2);
  assert.deepStrictEqual([v2.version, v2.storeId, v2.checkoutHost], ['v2', '692c0aacf505e77e9f9cccb2', 'checkout.cocosydney.co'], 'single quotes, one line');
  assert.strictEqual(findLasso(STORE_V4 + TAG_V2).length, 2);
  // Without a checkout address the script's own host is the checkout.
  assert.strictEqual(findLasso('<script src="https://checkout.shop.test/shopify-scripts/lasso-script-v4.min.js" data-store-id="x"></script>')[0].checkoutHost, 'checkout.shop.test');
  assert.deepStrictEqual(findLasso(PLAIN_STORE), []);
  assert.deepStrictEqual(findLasso('<script data-x="lasso-script">var a = 1;</script>'), [], 'no script file: not a tag');
  assert.deepStrictEqual(findLasso(null), []);
});

test('lassoSince: the store id is a MongoDB ObjectId, its first 8 hex digits are the day the store joined', () => {
  assert.strictEqual(lassoSince('6a3c9a6d78c8ee551d08f2f2'), '2026-06-25');
  assert.strictEqual(lassoSince('6ac7f4c0e29cff51b574d558'), '2026-10-08');
  assert.strictEqual(lassoSince('692c0aacf505e77e9f9cccb2'), '2025-11-30');
  for (const bad of ['', null, '6a3c9a6d', 'zzzc9a6d78c8ee551d08f2f2', '000000000000000000000000']) assert.strictEqual(lassoSince(bad), '', String(bad));
});

test('the checkout page: Lasso\'s app is known by its own markers, not by its Vercel address', () => {
  assert.strictEqual(isLassoCheckout(LASSO_CHECKOUT), true);
  assert.strictEqual(isLassoCheckout(NOT_FOUND_CHECKOUT), false);
  assert.strictEqual(isLassoCheckout(OTHER_APP), false);
  assert.strictEqual(isLassoCheckout(''), false);
});

test('the store as it is now: sure, likely, left Lasso, no Lasso; a closed store is not live; never throws', async () => {
  const best = json({ data: { products: { nodes: [
    { title: 'Glow Tanning Gummies', handle: 'glow-gummies', productType: '', createdAt: '2026-06-27T01:02:03Z', priceRange: { minVariantPrice: { amount: '48.87', currencyCode: 'NZD' } }, compareAtPriceRange: { maxVariantPrice: { amount: '75.0' } } },
    { title: 'Glow Sleep Gummies', handle: 'sleep', productType: 'Gummies', createdAt: '2026-07-01T00:00:00Z', priceRange: { minVariantPrice: { amount: '39.0', currencyCode: 'NZD' } }, compareAtPriceRange: { maxVariantPrice: { amount: '0.0' } } },
  ] } } });
  const notFound = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const sites = {
    'https://tryglowgummies.com/': () => html(STORE_V4),
    'https://checkout.tryglowgummies.com/checkout': () => html(LASSO_CHECKOUT),
    'https://tryglowgummies.com/meta.json': () => json({ name: 'Glow Gummies', country: 'NZ', currency: 'NZD', published_products_count: 7 }),
    'https://tryglowgummies.com/api/2026-10/graphql.json': () => best,
    'https://goda.test/': () => html(PLAIN_STORE),
    'https://checkout.goda.test/checkout': () => html(LASSO_CHECKOUT),
    'https://gone.test/': () => html(STORE_V4.replace(/tryglowgummies\.com/g, 'gone.test')),
    'https://checkout.gone.test/checkout': () => { throw notFound; },
    'https://moved.test/': () => html(STORE_V4.replace(/tryglowgummies\.com/g, 'moved.test')),
    'https://checkout.moved.test/checkout': () => html(NOT_FOUND_CHECKOUT, 404),
    'https://slow.test/': () => html(STORE_V4.replace(/tryglowgummies\.com/g, 'slow.test')),
    'https://checkout.slow.test/checkout': () => { throw new DOMException('The operation timed out.', 'TimeoutError'); },
    'https://plain.test/': () => html(PLAIN_STORE),
    'https://checkout.plain.test/checkout': () => html(OTHER_APP, 404),
    'https://closed.test/': () => html('<html><title>Store unavailable</title></html>', 402),
    'https://checkout.closed.test/checkout': () => html(LASSO_CHECKOUT),
    'https://www.wwwonly.test/': () => html(STORE_V4.replace(/tryglowgummies\.com/g, 'wwwonly.test')),
    'https://checkout.wwwonly.test/checkout': () => html(LASSO_CHECKOUT),
  };
  const calls = [];
  const doFetch = async (url, init = {}) => {
    calls.push({ url, init });
    const f = sites[url];
    if (!f) throw new TypeError('fetch failed');
    const res = f();
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  const r = await checkLassoStore('tryglowgummies.com', { doFetch, now: NOW });
  assert.deepStrictEqual(
    { ...r, best_sellers: r.best_sellers.length },
    { store: 'tryglowgummies.com', host: 'tryglowgummies.com', live: 1, status: 200, confidence: 'high', script: 'v4', lasso_store_id: '6a3c9a6d78c8ee551d08f2f2', lasso_since: '2026-06-25',
      checkout_url: 'https://checkout.tryglowgummies.com/checkout', checkout_status: 200, checkout_lasso: 1, checkout_error: '', name: 'Glow Gummies', title: 'Glow Gummies', country: 'NZ',
      currency: 'NZD', lang: 'en', products: 7, best_sellers: 2, error: '', checked_at: new Date(NOW).toISOString() });
  assert.deepStrictEqual(r.best_sellers[0], { title: 'Glow Tanning Gummies', handle: 'glow-gummies', type: '', created: '2026-06-27', price: 48.87, compare_at: 75, currency: 'NZD' });
  assert.strictEqual(r.best_sellers[1].compare_at, null, 'no compare-at price');
  const gql = calls.find((c) => c.url.endsWith('/graphql.json'));
  assert.strictEqual(gql.init.method, 'POST');
  assert.match(JSON.parse(gql.init.body).query, /sortKey: BEST_SELLING/);
  assert.match(calls[0].init.headers['User-Agent'], /Chrome/);

  const goda = await checkLassoStore('goda.test', { doFetch, now: NOW });
  assert.deepStrictEqual([goda.confidence, goda.script, goda.checkout_lasso, goda.lang, goda.title], ['medium', '', 1, 'de', 'Feldmann München'], 'Lasso\'s checkout, no script on the page');
  assert.strictEqual((await checkLassoStore('gone.test', { doFetch })).confidence, 'low', 'the script is left, its checkout address is gone');
  assert.strictEqual((await checkLassoStore('gone.test', { doFetch })).checkout_error, 'no such host');
  assert.strictEqual((await checkLassoStore('moved.test', { doFetch })).confidence, 'low', 'its checkout address is not connected to a store');
  assert.strictEqual((await checkLassoStore('slow.test', { doFetch })).confidence, 'medium', 'a slow checkout says nothing');
  const plain = await checkLassoStore('plain.test', { doFetch });
  assert.strictEqual(plain.confidence, '', 'another app on the same Vercel address is no Lasso');
  assert.deepStrictEqual(plain.best_sellers, [], 'no Lasso: its products are not asked for');
  const closed = await checkLassoStore('closed.test', { doFetch });
  assert.deepStrictEqual([closed.live, closed.status, closed.confidence], [0, 402, 'medium'], 'Shopify\'s "store unavailable": not live');
  const www = await checkLassoStore('wwwonly.test', { doFetch });
  assert.deepStrictEqual([www.host, www.store, www.confidence], ['www.wwwonly.test', 'wwwonly.test', 'high'], 'only answers on www.');
  const down = await checkLassoStore('down.test', { doFetch });
  assert.deepStrictEqual([down.live, down.status, down.error, down.confidence], [0, 0, 'network', '']);
});

test('a store that says "too many requests" is asked once more after a pause', async () => {
  let metaCalls = 0;
  const doFetch = async (url) => {
    let res;
    if (url === 'https://busy.test/') res = html(STORE_V4.replace(/tryglowgummies\.com/g, 'busy.test'));
    else if (url === 'https://checkout.busy.test/checkout') res = html(LASSO_CHECKOUT);
    else if (url === 'https://busy.test/meta.json') res = ++metaCalls === 1 ? html('slow down', 429) : json({ name: 'Busy', country: 'AU', currency: 'AUD', published_products_count: 9 });
    else res = json({ errors: [{ message: 'no' }] }, 403);
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  const r = await checkLassoStore('busy.test', { doFetch, coolMs: 1 });
  assert.deepStrictEqual([metaCalls, r.country, r.products, r.best_sellers], [2, 'AU', 9, []]);
});

test('confidenceOf: both signs high, one medium, a script whose checkout is gone low', () => {
  const c = (o) => confidenceOf({ script: '', checkout_lasso: 0, checkout_error: '', checkout_status: 0, ...o });
  assert.strictEqual(c({ script: 'v4', checkout_lasso: 1 }), 'high');
  assert.strictEqual(c({ checkout_lasso: 1 }), 'medium');
  assert.strictEqual(c({ script: 'v4', checkout_error: 'timeout' }), 'medium');
  assert.strictEqual(c({ script: 'v4', checkout_status: 503 }), 'medium');
  assert.strictEqual(c({ script: 'v2', checkout_error: 'no such host' }), 'low');
  assert.strictEqual(c({ script: 'v2', checkout_error: 'network' }), 'low');
  assert.strictEqual(c({ script: 'v4', checkout_status: 404 }), 'low');
  assert.strictEqual(c({ script: 'v4', checkout_status: 200 }), 'low', 'its checkout is something else now');
  assert.strictEqual(c({}), '');
});

test('urlscan: one search, with a key when there is one; a 429 waits as long as urlscan says; never throws', async () => {
  const seen = [];
  let n = 0;
  const waits = [];
  const doFetch = async (url, init) => {
    seen.push({ url, init });
    if (++n === 1) return json({ message: 'slow down' }, 429, { 'x-rate-limit-reset-after': '7' });
    return json({ results: [{ _id: 'a' }], total: 1 });
  };
  const got = await urlscanSearch('filename:"lasso-script-v4.min.js"', { doFetch, key: 'k-123', sleep: async (ms) => waits.push(ms) });
  assert.deepStrictEqual(got, { results: [{ _id: 'a' }], total: 1 });
  assert.deepStrictEqual(waits, [7000]);
  const u = new URL(seen[0].url);
  assert.strictEqual(u.origin + u.pathname, 'https://urlscan.io/api/v1/search/');
  assert.strictEqual(u.searchParams.get('q'), 'filename:"lasso-script-v4.min.js"');
  assert.strictEqual(u.searchParams.get('size'), '100');
  assert.strictEqual(seen[0].init.headers['API-Key'], 'k-123');
  const noKey = [];
  await urlscanSearch('x', { doFetch: async (url, init) => (noKey.push(init.headers), json({ results: [], total: 0 })), sleep: noSleep });
  assert.ok(!('API-Key' in noKey[0]), 'no key: no header');
  assert.deepStrictEqual(await urlscanSearch('x', { doFetch: async () => { throw new TypeError('fetch failed'); }, sleep: noSleep }), { results: [], total: 0, error: 'network' });
  assert.deepStrictEqual(await urlscanSearch('x', { doFetch: async () => json({ message: 'Search is limited' }, 400), sleep: noSleep }), { results: [], total: 0, error: 'Search is limited' });
  assert.deepStrictEqual(await urlscanSearch('x', { doFetch: async () => html('<html>oops</html>', 502), sleep: noSleep }), { results: [], total: 0, error: 'HTTP 502' });
});

test('sweep: windows of 2 days; one with more than 100 scans is split until each fits; every scan once', async () => {
  const qs = [];
  const all = Array.from({ length: 150 }, (_, i) => ({ _id: 's' + i, t: NOW - 3 * DAY + i * 60000 })); // 150 scans in 2.5 hours, 3 days ago
  const doFetch = async (url) => {
    const q = new URL(url).searchParams.get('q');
    qs.push(q);
    const [, from, to] = /date:\[(\S+) TO (\S+)\]/.exec(q);
    const inside = all.filter((s) => s.t >= Date.parse(from) && s.t <= Date.parse(to));
    return json({ results: inside.slice(0, 100).map((s) => ({ _id: s._id })), total: inside.length });
  };
  const got = await sweep('filename:"lasso-script-v4.min.js"', { days: 6, now: NOW, doFetch, sleep: noSleep });
  assert.strictEqual(got.scans.length, 150, 'all of them, though one answer holds 100');
  assert.strictEqual(got.errors, 0);
  assert.ok(qs.every((q) => q.startsWith('(filename:"lasso-script-v4.min.js") AND date:[')), qs[0]);
  assert.ok(got.searches > 3 && got.searches === qs.length, 'the full window was split');
  const failing = await sweep('x', { days: 4, now: NOW, doFetch: async () => json({ message: 'no' }, 500), sleep: noSleep });
  assert.deepStrictEqual([failing.scans.length, failing.errors, failing.searches], [0, 2, 2]);
});

test('the stores behind the scans: a page, a customer portal, a checkout page, an address that sends on; no Shopify or Google addresses', () => {
  const scan = (page, task = page, title = '', time = '2026-10-20T10:00:00Z') => ({ _id: page + task + time, page: { domain: page, title }, task: { domain: task, time } });
  const c = candidatesOf([
    scan('www.tryglowgummies.com', 'tryglowgummies.com', '8 Reasons', '2026-10-02T00:00:00Z'),
    scan('tryglowgummies.com', 'tryglowgummies.com', 'Glow', '2026-10-31T00:00:00Z'),
    scan('subscriptions.arcticorgans.com', 'subscriptions.arcticorgans.com', 'Customer Portal'),
    scan('account.notaportal.com', 'account.notaportal.com', 'My account – Shop'),
    scan('checkout.velunira.nl', 'checkout.velunira.nl', 'Secure Checkout'),
    scan('hattieandrosebags.com', 'sylvienathalie.fr', 'Hattie & Rose'),
    scan('foxleyofficial.com', 'mdubxr-3g.myshopify.com', 'Foxley'),
    scan('backroad-goods.com', 'share.google', 'BACKR'),
    scan('lasso-customer-portal.pages.dev'),
  ]);
  const by = Object.fromEntries(c.map((x) => [x.domain, x]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['account.notaportal.com', 'arcticorgans.com', 'backroad-goods.com', 'foxleyofficial.com', 'hattieandrosebags.com', 'sylvienathalie.fr', 'tryglowgummies.com', 'velunira.nl']);
  assert.deepStrictEqual({ ...by['tryglowgummies.com'] }, { domain: 'tryglowgummies.com', how: ['store page'], scans: 2, first_seen: '2026-10-02T00:00:00Z', last_seen: '2026-10-31T00:00:00Z' });
  assert.deepStrictEqual(by['arcticorgans.com'].how, ['portal']);
  assert.deepStrictEqual(by['velunira.nl'].how, ['checkout page']);
  assert.deepStrictEqual(by['sylvienathalie.fr'].how, ['sends on to hattieandrosebags.com']);
  assert.deepStrictEqual(candidatesOf([{ page: {}, task: {} }, null].filter(Boolean)), []);
});

test('domainsIn: a reverse-CNAME export or a typed list gives store domains', () => {
  const csv = 'Domain,First Seen,Last Seen\ncheckout.junejoanjenny.com,2026-03-12,2026-07-14\nCHECKOUT.Belcien.com,2026-07-01,2026-09-18\nsubscriptions.tryvenalia.com,,\nportal.tryglowgummies.com,,\nwww.shop.test,,\n'
    + 'lasso-customer-portal.pages.dev\nreport.csv\nfoo.myshopify.com\nmail me@ignore.this';
  assert.deepStrictEqual(domainsIn(csv), ['junejoanjenny.com', 'belcien.com', 'tryvenalia.com', 'tryglowgummies.com', 'shop.test']);
  assert.deepStrictEqual(domainsIn('a.com, https://b.de/path | c.nl'), ['a.com', 'b.de', 'c.nl']);
  assert.deepStrictEqual(domainsIn(''), []);
});

test('marketsOf: the markets outside the EU its ads are looked for in; none for an EU or UK store', () => {
  assert.deepStrictEqual(marketsOf({ country: 'NZ', currency: 'NZD' }), ['NZ']);
  assert.deepStrictEqual(marketsOf({ country: 'AU', currency: 'USD' }), ['AU', 'US']);
  assert.deepStrictEqual(marketsOf({ country: 'GB', currency: 'USD' }), ['US']);
  assert.deepStrictEqual(marketsOf({ country: 'NL', currency: 'CAD' }), ['CA']);
  assert.deepStrictEqual(marketsOf({ country: 'DE', currency: 'EUR' }), []);
  assert.deepStrictEqual(marketsOf({ country: 'GB', currency: 'GBP' }), []);
  assert.deepStrictEqual(marketsOf({}), []);
});

test('the CSV: one row a store, its best seller first, text a spreadsheet cannot run', () => {
  const csv = toCsv([{ store: 'a.test', confidence: 'high', live: 1, name: '=HYPERLINK("x")', country: 'NZ', currency: 'NZD', lang: 'en', products: 7, script: 'v4', lasso_since: '2026-06-25',
    checkout_url: 'https://checkout.a.test/checkout', best_sellers: [{ title: 'Lamp, "big"\nnew', price: 49, currency: 'USD' }, { title: 'B' }], first_seen: '2026-10-02', last_seen: '2026-11-01', how: 'store page' }]);
  const [head, row] = csv.trimEnd().split(/\n(?=a\.test)/);
  assert.strictEqual(head, CSV_COLS.join(','));
  assert.match(row, /^a\.test,high,1,"'=HYPERLINK\(""x""\)",NZ,NZD,en,7,v4,2026-06-25,https:\/\/checkout\.a\.test\/checkout,"Lamp, ""big""\nnew",49 USD,"Lamp, ""big""\nnew; B",2026-10-02,2026-11-01,store page$/);
  assert.strictEqual(toCsv([]), CSV_COLS.join(',') + '\n');
});

// ---------------------------------------------------------------------------
// A run: fake urlscan, fake stores, a fake Ad Library, the in-memory D1
// ---------------------------------------------------------------------------
function world({ stores, scans = [] }) {
  const calls = [];
  const doFetch = async (url, init = {}) => {
    calls.push(url);
    const u = new URL(url);
    if (u.host === 'urlscan.io') {
      const q = u.searchParams.get('q');
      const hits = scans.filter((s) => q.includes(s.q) && (() => {
        const [, from, to] = /date:\[(\S+) TO (\S+)\]/.exec(q);
        return s.t >= Date.parse(from) && s.t < Date.parse(to);
      })());
      return json({ results: hits.map((s) => ({ _id: s.id, page: { domain: s.page, title: s.title || '' }, task: { domain: s.page, time: new Date(s.t).toISOString() } })), total: hits.length });
    }
    const f = stores[url];
    if (!f) throw new TypeError('fetch failed');
    const got = f();
    const [res, finalUrl] = Array.isArray(got) ? got : [got, url]; // [response, where a redirect ended]
    Object.defineProperty(res, 'url', { value: finalUrl });
    return res;
  };
  return { calls, doFetch };
}
const lassoStore = (host, { country = 'US', currency = 'USD', products = 3 } = {}) => ({
  [`https://${host}/`]: () => html(STORE_V4.replace(/tryglowgummies\.com/g, host)),
  [`https://checkout.${host}/checkout`]: () => html(LASSO_CHECKOUT),
  [`https://${host}/meta.json`]: () => json({ name: host, country, currency, published_products_count: products }),
  [`https://${host}/api/2026-10/graphql.json`]: () => json({ data: { products: { nodes: [{ title: 'Best ' + host, handle: 'best', productType: '', createdAt: '', priceRange: { minVariantPrice: { amount: '29.95', currencyCode: currency } }, compareAtPriceRange: { maxVariantPrice: { amount: '0' } } }] } } }),
});
const sec = (daysAgo) => Math.floor((NOW - daysAgo * DAY) / 1000);
const rawAd = (id, link, { page = '77', days = 20 } = {}) => ({ ad_archive_id: id, page_id: page, collation_id: 'c' + id, collation_count: 1, is_active: true, start_date: sec(days),
  snapshot: { page_name: 'Shop', page_id: page, page_like_count: 10, link_url: link, caption: new URL(link).host, title: 'Lamp', images: [{ resized_image_url: 'https://cdn.test/a.jpg' }], cards: [] } });

test('a run: found on urlscan, checked live, saved in D1 with the day it was first found; the next run keeps that day', async () => {
  const scans = [
    { id: '1', q: 'lasso-script-v4.min.js', page: 'us-lamps.test', t: NOW - 5 * DAY },
    { id: '2', q: 'lasso-script-v4.min.js', page: 'www.us-lamps.test', t: NOW - 2 * DAY },
    { id: '3', q: 'lasso-script-v2.min.js', page: 'eu-dress.test', t: NOW - 9 * DAY },
    { id: '4', q: 'Secure Checkout', page: 'checkout.no-lasso.test', t: NOW - 1 * DAY },
  ];
  const stores = { ...lassoStore('us-lamps.test'), ...lassoStore('eu-dress.test', { country: 'DE', currency: 'EUR' }),
    'https://no-lasso.test/': () => html(PLAIN_STORE), 'https://checkout.no-lasso.test/checkout': () => html(OTHER_APP, 404) };
  const rest = d1Rest();
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: rest.doFetch, retryMs: 0 });
  const { doFetch } = world({ stores, scans });
  const t = await discover({ doFetch, db, now: () => NOW, sleep: noSleep, log: () => {} });
  assert.strictEqual(t.health, 'ok', t.alert);
  assert.strictEqual(t.candidates, 3);
  assert.strictEqual(t.searches, URLSCAN_QUERIES.length * 15, '30 days in windows of 2 days, per search');
  assert.deepStrictEqual(t.stores.map((r) => [r.store, r.confidence, r.how]), [['eu-dress.test', 'high', 'store page'], ['us-lamps.test', 'high', 'store page']]);
  assert.deepStrictEqual([t.stores[1].first_seen, t.stores[1].last_seen], [new Date(NOW - 5 * DAY).toISOString(), new Date(NOW - 2 * DAY).toISOString()], 'its first and last scan, www. or not');
  assert.strictEqual(t.saved, 2);
  const saved = rest.db.prepare('SELECT * FROM lasso_stores ORDER BY store').all();
  assert.deepStrictEqual(saved.map((r) => [r.store, r.confidence, r.live, r.script, r.country, r.currency, r.first_seen, r.last_seen]), [
    ['eu-dress.test', 'high', 1, 'v4', 'DE', 'EUR', new Date(NOW - 9 * DAY).toISOString(), new Date(NOW).toISOString()],
    ['us-lamps.test', 'high', 1, 'v4', 'US', 'USD', new Date(NOW - 5 * DAY).toISOString(), new Date(NOW).toISOString()],
  ]);
  assert.deepStrictEqual(JSON.parse(saved[1].best_sellers)[0], { title: 'Best us-lamps.test', handle: 'best', type: '', created: '', price: 29.95, compare_at: null, currency: 'USD' });

  // A week later: urlscan has nothing new, one store left Lasso, one does not answer. Both were saved: both are asked again.
  const later = NOW + 7 * DAY;
  const left = { ...stores, 'https://us-lamps.test/': () => html(PLAIN_STORE), 'https://checkout.us-lamps.test/checkout': () => html(OTHER_APP, 404) };
  delete left['https://eu-dress.test/'];
  delete left['https://checkout.eu-dress.test/checkout'];
  const t2 = await discover({ doFetch: world({ stores: left }).doFetch, db, now: () => later, sleep: noSleep, log: () => {} });
  assert.strictEqual(t2.candidates, 2, 'the saved stores');
  assert.deepStrictEqual(t2.stores, []);
  const again = rest.db.prepare('SELECT store, confidence, first_seen, last_seen, checked_at FROM lasso_stores ORDER BY store').all();
  assert.deepStrictEqual(again.map((r) => ({ ...r })), [
    { store: 'eu-dress.test', confidence: 'high', first_seen: new Date(NOW - 9 * DAY).toISOString(), last_seen: new Date(NOW).toISOString(), checked_at: new Date(NOW).toISOString() },
    { store: 'us-lamps.test', confidence: '', first_seen: new Date(NOW - 5 * DAY).toISOString(), last_seen: new Date(NOW).toISOString(), checked_at: new Date(later).toISOString() },
  ], 'left Lasso: marked, its last Lasso day kept; did not answer: as it was');
});

test('a run also checks the domain a store\'s checkout sits on: the same store under a second name is counted once, a sister store is added', async () => {
  const page = (host, checkout) => html(STORE_V4.replace(/checkout\.tryglowgummies\.com/g, checkout).replace(/tryglowgummies\.com/g, host));
  const stores = {
    ...lassoStore('bella.test'),
    'https://bella.test/': () => page('bella.test', 'checkout.bella-nashville.test'),
    'https://checkout.bella-nashville.test/checkout': () => html(LASSO_CHECKOUT),
    'https://bella-nashville.test/': () => [page('bella.test', 'checkout.bella-nashville.test'), 'https://bella.test/'], // redirects to the store
    ...lassoStore('ruby.test'),
    'https://ruby.test/': () => page('ruby.test', 'checkout.july.test'),
    'https://checkout.july.test/checkout': () => html(LASSO_CHECKOUT),
    ...lassoStore('july.test'), // a store of its own
  };
  const scans = [{ id: '1', q: 'lasso-script-v4.min.js', page: 'bella.test', t: NOW - DAY }, { id: '2', q: 'lasso-script-v4.min.js', page: 'ruby.test', t: NOW - DAY }];
  const t = await discover({ doFetch: world({ stores, scans }).doFetch, now: () => NOW, sleep: noSleep, log: () => {} });
  assert.strictEqual(t.candidates, 4, '2 from urlscan, 2 checkout domains');
  assert.deepStrictEqual(t.stores.map((r) => [r.store, r.confidence, r.how]).sort(), [
    ['bella.test', 'high', 'store page; checkout of bella.test'],
    ['july.test', 'high', 'checkout of ruby.test'],
    ['ruby.test', 'high', 'store page'],
  ]);
});

test('a run with LASSO_ADS: the stores\' own ads outside the EU go into world_ads for the hunt; refusals in a row stop it', async () => {
  const scans = [
    { id: '1', q: 'lasso-script-v4.min.js', page: 'us-lamps.test', t: NOW - 5 * DAY },
    { id: '2', q: 'lasso-script-v4.min.js', page: 'nz-gummy.test', t: NOW - 5 * DAY },
    { id: '3', q: 'lasso-script-v4.min.js', page: 'eu-dress.test', t: NOW - 5 * DAY },
  ];
  const stores = { ...lassoStore('us-lamps.test'), ...lassoStore('nz-gummy.test', { country: 'NZ', currency: 'NZD' }), ...lassoStore('eu-dress.test', { country: 'DE', currency: 'EUR' }) };
  const rest = d1Rest();
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: rest.doFetch, retryMs: 0 });
  const searched = [];
  const lib = {
    async search(what) {
      searched.push(what);
      if (what.q === 'us-lamps.test') return { ads: [rawAd('101', 'https://us-lamps.test/products/lamp?utm=1'), rawAd('102', 'https://other-shop.test/products/x')], count: 2, blocked: false };
      return { ads: [rawAd('201', 'https://nz-gummy.test/pages/advertorial')], count: 1, blocked: false };
    },
  };
  const t = await discover({ doFetch: world({ stores, scans }).doFetch, db, lib, now: () => NOW, sleep: noSleep, log: () => {} });
  assert.strictEqual(t.health, 'ok', t.alert);
  assert.deepStrictEqual(searched, [{ cc: 'NZ', q: 'nz-gummy.test', exact: true }, { cc: 'US', q: 'us-lamps.test', exact: true }], 'no search for the EU store; the domain as one phrase');
  assert.strictEqual(t.ads, 2, 'an ad for another shop is left out');
  const ads = rest.db.prepare('SELECT ad_id, cc, store, product_key, keyword FROM world_ads ORDER BY ad_id').all().map((r) => ({ ...r }));
  assert.deepStrictEqual(ads, [
    { ad_id: '101', cc: 'US', store: 'us-lamps.test', product_key: 'us-lamps.test/products/lamp', keyword: 'lasso: us-lamps.test' },
    { ad_id: '201', cc: 'NZ', store: 'nz-gummy.test', product_key: '', keyword: 'lasso: nz-gummy.test' },
  ]);

  // The Ad Library refuses: after 6 in a row the rest waits for the next run.
  const many = Array.from({ length: 9 }, (_, i) => ({ id: 'm' + i, q: 'lasso-script-v4.min.js', page: `shop${i}.test`, t: NOW - DAY }));
  let asked = 0;
  const refusing = { search: async () => (asked++, { ads: [], count: null, blocked: true }) };
  const allStores = Object.assign({}, ...many.map((s) => lassoStore(s.page)));
  const t2 = await discover({ doFetch: world({ stores: allStores, scans: many }).doFetch, db, lib: refusing, now: () => NOW, sleep: noSleep, log: () => {} });
  assert.strictEqual(asked, 6);
  assert.strictEqual(t2.ad_searches, 6);
  assert.ok(MAX_AD_SEARCHES >= 100);
});

test('an Ad Library search for a shop\'s domain is one exact phrase; keyword searches stay as they were', () => {
  const exact = new URL(libraryUrl({ cc: 'US', q: 'aussie-flair.com', exact: true }));
  assert.strictEqual(exact.searchParams.get('q'), '"aussie-flair.com"');
  assert.strictEqual(exact.searchParams.get('search_type'), 'keyword_exact_phrase');
  assert.strictEqual(exact.searchParams.get('country'), 'US');
  const words = new URL(libraryUrl({ cc: 'AU', q: 'dog harness' }));
  assert.strictEqual(words.searchParams.get('q'), 'dog harness');
  assert.strictEqual(words.searchParams.get('search_type'), 'keyword_unordered');
});

test('a run is red when urlscan answers nothing or D1 cannot save; yellow when some searches failed', async () => {
  const silent = async (url) => (new URL(url).host === 'urlscan.io' ? json({ message: 'down' }, 503) : (() => { throw new TypeError('fetch failed'); })());
  const t = await discover({ doFetch: silent, now: () => NOW, sleep: noSleep, log: () => {} });
  assert.strictEqual(t.health, 'failed');
  assert.match(t.alert, /urlscan\.io answered none of 75 searches/);
  let n = 0;
  const flaky = async (url) => (new URL(url).host === 'urlscan.io' ? (++n % 10 === 0 ? json({ message: 'busy' }, 503) : json({ results: [], total: 0 })) : (() => { throw new TypeError('fetch failed'); })());
  const y = await discover({ doFetch: flaky, now: () => NOW, sleep: noSleep, log: () => {} });
  assert.strictEqual(y.health, 'warning');
  const scans = [{ id: '1', q: 'lasso-script-v4.min.js', page: 'us-lamps.test', t: NOW - DAY }];
  const broken = d1Rest(undefined, { fail: (b) => /INSERT INTO lasso_stores/.test(b.sql) });
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: broken.doFetch, retryMs: 0 });
  const r = await discover({ doFetch: world({ stores: lassoStore('us-lamps.test'), scans }).doFetch, db, now: () => NOW, sleep: noSleep, log: () => {} });
  assert.strictEqual(r.health, 'failed');
  assert.match(r.alert, /not saved in D1/);
  assert.strictEqual(r.stores.length, 1, 'the list is still written to the files');
});

test('the files of a run: CSV and JSON', () => {
  const dir = fs.mkdtempSync('/tmp/wh-lasso-');
  try {
    writeOut(dir + '/out', [{ store: 'a.test', confidence: 'high', best_sellers: [] }]);
    assert.match(fs.readFileSync(dir + '/out/lasso-stores.csv', 'utf8'), /^store,confidence,/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(dir + '/out/lasso-stores.json', 'utf8')), [{ store: 'a.test', confidence: 'high', best_sellers: [] }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the D1 upsert keeps the first day a store was found and the last day it still had Lasso', () => {
  assert.match(STORES_SQL, /first_seen = MIN\(COALESCE\(lasso_stores\.first_seen, excluded\.first_seen\), excluded\.first_seen\)/);
  assert.match(STORES_SQL, /last_seen = CASE WHEN excluded\.confidence != '' THEN excluded\.checked_at ELSE lasso_stores\.last_seen END/);
});

test('its workflow is off unless asked for: by hand, or weekly with LASSO_STORES = on; a D1-only token; no secret in the code', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/lasso-stores.yml', import.meta.url), 'utf8');
  assert.match(wf, /^on:\n  workflow_dispatch:/m);
  assert.match(wf, /^  schedule:\n    - cron: '[^']+'$/m);
  assert.match(wf, /^    if: \$\{\{ github\.event_name == 'workflow_dispatch' \|\| vars\.LASSO_STORES == 'on' \}\}$/m, 'the weekly run only with the variable');
  assert.match(wf, /^      CF_API_TOKEN: \$\{\{ secrets\.CF_D1_TOKEN \|\| secrets\.CF_API_TOKEN \}\}$/m);
  assert.match(wf, /^      URLSCAN_API_KEY: \$\{\{ secrets\.URLSCAN_API_KEY \}\}$/m);
  assert.match(wf, /^permissions:\n  contents: read$/m);
  assert.match(wf, /node winner-hunter\/lasso\.mjs/);
  assert.match(wf, /actions\/upload-artifact@[0-9a-f]{40}/);
  const code = fs.readFileSync(new URL('../lasso.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('../lib/lasso.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /API-Key['"]?\s*:\s*['"][0-9a-f-]{20,}/i, 'no key in the code');
});
