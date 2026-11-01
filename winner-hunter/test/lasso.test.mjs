// Lasso stores: lib/lasso.mjs (the signs of Lasso on a store, the sources, the store checks) and lasso.mjs (a run on fake
// sources and fake stores, saved in the in-memory D1; counts only in the log), and lasso-stores.yml (off: by hand only).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  LASSO_CNAME, OLD_CNAME, URLSCAN_QUERIES, lassoTag, lassoMarks, isLassoCheckout, cleanHost, checkoutHostOf, storeOf, pageStore,
  otxHosts, urlscanHosts, ddgHosts, urlscanSearch, otxPassiveDns, checkStore, checkCheckout, shopMeta, bestSellers, catalogSize, isAddOn,
  topProducts, storeKind, adLibraryUrl,
} from '../lib/lasso.mjs';
import { run, candidatesOf, toCsv, SAVE_SQL } from '../lasso.mjs';
import { d1Client } from '../lib/d1.mjs';
import { d1Rest, memoryDb } from './helpers/sqlite-d1.mjs';

const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const html = (h, status = 200) => new Response(h, { status, headers: { 'content-type': 'text/html' } });
const ID = '6ac7f4c0e29cff51b574d558';
const TAG_V4 = `<script\n  src="https://checkout.shop-a.test/shopify-scripts/lasso-script-v4.min.js"\n  data-store-id="${ID}"\n  data-checkout-url="checkout.shop-a.test/checkout"\n  defer>\n</script>`;
const SKELETON = '<title>Secure Checkout</title><script>const hint = JSON.parse(localStorage.getItem(\'lasso_theme_hint\') || \'{}\'); if (isDark) document.body.classList.add(\'lasso-dark-boot\');</script>';
const storePage = (body, shop = 'a1b2c3-xy.myshopify.com', lang = 'en') =>
  `<html lang="${lang}"><head><title>Shop &amp; Co</title><meta property="og:site_name" content="Shop &amp; Co">`
  + `<script>Shopify.shop = "${shop}"; Shopify.currency = {"active":"EUR","rate":"1.0"}; Shopify.country = "NL";</script>`
  + `<link href="//shop.test/cdn/shop/t/2/assets/base.css"></head><body>${body}</body></html>`;

test('the Lasso tag: on the store\'s own checkout host, on Lasso\'s, and the other script names', () => {
  assert.deepStrictEqual(lassoTag(storePage(TAG_V4)), { script: 'lasso-script-v4.min.js', version: 'v4', scriptHost: 'checkout.shop-a.test', storeId: ID, apiUrl: '', checkoutUrl: 'checkout.shop-a.test/checkout' });
  const own = lassoTag(`<script src="https://checkout.lassocheckout.com/shopify-scripts/lasso-script-v4.min.js" data-store-id="69626FFF3BEB1FFFAA157D65" data-api-url="https://api.lassocheckout.com/api" data-checkout-url="checkout.lassocheckout.com/checkout" defer></script>`);
  assert.strictEqual(own.scriptHost, 'checkout.lassocheckout.com');
  assert.strictEqual(own.storeId, '69626fff3beb1fffaa157d65', 'store ids in lower case');
  assert.strictEqual(own.apiUrl, 'https://api.lassocheckout.com/api');
  assert.strictEqual(lassoTag("<script data-checkout-url='checkout.b.test/checkout' src='//checkout.b.test/shopify-scripts/lasso-script.min.js' data-store-id='68cb1c93e62c123ea93e6a72'></script>").version, '', 'the first script has no version');
  assert.strictEqual(lassoTag('<script src="https://checkout.c.test/shopify-scripts/subscriptions-script.js" data-store-id="69ec28cb672c7aa682206035" data-checkout-url="checkout.c.test/checkout" defer></script>').script, 'subscriptions-script.js');
  const old = lassoTag('<script src="https://dashboard.lassocheckout.com/shopify-scripts/lasso-cart.js" data-store-id="68cb1c93e62c123ea93e6a72" data-api-url="https://livebackend.lassocheckout.com:3000/api" data-checkout-url="shop.d.test/checkout" defer></script>');
  assert.deepStrictEqual([old.script, checkoutHostOf(old.checkoutUrl)], ['lasso-cart.js', 'shop.d.test']);
  assert.strictEqual(lassoTag('<script src="/shopify-scripts/other.js"></script><script src="https://cdn.shopify.com/x.js"></script>'), null, 'a script there without Lasso\'s data is no Lasso');
  assert.strictEqual(lassoTag(''), null);
});

test('the signs of Lasso: tag, pasted code, theme name; the checkout page itself', () => {
  assert.deepStrictEqual(lassoMarks(storePage(TAG_V4)), ['tag']);
  assert.deepStrictEqual(lassoMarks('<script>!function(){if(!window.__LASSO_GUARD__){window.__LASSO_GUARD__=!0;}}()</script>'), ['inline']);
  assert.deepStrictEqual(lassoMarks("<script>function lassoArmed() { return !!document.querySelector('[data-lasso-patched]'); }</script>"), ['inline'], "a theme's own glue code for Lasso");
  assert.deepStrictEqual(lassoMarks('Shopify.theme = {"name":"Verlimo Lasso Whop ","id":1};'), ['theme']);
  assert.deepStrictEqual(lassoMarks(storePage('<a href="/cart">Cart</a>')), []);
  assert.ok(isLassoCheckout(SKELETON));
  assert.ok(!isLassoCheckout('<title>Secure Checkout</title><div id="root"></div>'), 'another checkout with the same title');
});

test('hosts: the store behind a checkout or portal host', () => {
  assert.strictEqual(cleanHost(' WWW.Shop.Test. '), 'shop.test');
  assert.strictEqual(cleanHost('not a host'), '');
  assert.strictEqual(storeOf('checkout.shop.test'), 'shop.test');
  assert.strictEqual(storeOf('secure.edj.co.uk'), 'edj.co.uk');
  assert.strictEqual(storeOf('checkout.co.uk'), 'checkout.co.uk', 'no store name left');
  assert.strictEqual(storeOf('shop.test'), 'shop.test');
  assert.strictEqual(checkoutHostOf('checkout.shop.test/checkout'), 'checkout.shop.test');
  assert.strictEqual(checkoutHostOf('https://pay.shop.test/x'), 'pay.shop.test');
  assert.strictEqual(checkoutHostOf(''), '');
  assert.strictEqual(pageStore('account.goda.test'), 'goda.test', 'a customer portal');
  assert.strictEqual(pageStore('checkout.shop.test'), 'shop.test');
  assert.strictEqual(pageStore('www.shop.test'), 'shop.test');
  assert.strictEqual(pageStore('au.lounelle.test'), 'au.lounelle.test', 'a store on a subdomain stays');
});

test('the sources: OTX CNAMEs to Lasso, urlscan pages, DuckDuckGo CNAMEs', () => {
  const otx = { passive_dns: [
    { record_type: 'CNAME', hostname: 'checkout.a.test', address: LASSO_CNAME, first: '2026-06-01T00:00:00', last: '2026-06-02T00:00:00' },
    { record_type: 'CNAME', hostname: 'checkout.a.test', address: LASSO_CNAME + '.', first: '2026-05-01T00:00:00', last: '2026-10-02T00:00:00' },
    { record_type: 'CNAME', hostname: 'checkout.b.test', address: 'cname.vercel-dns.com' },
    { record_type: 'A', hostname: LASSO_CNAME, address: '216.150.1.129' },
    { record_type: 'CNAME', hostname: 'checkout.lassocheckout.com', address: LASSO_CNAME },
    { record_type: 'CNAME', hostname: 'checkout.old.test', address: OLD_CNAME },
  ] };
  assert.deepStrictEqual(otxHosts(otx), [{ host: 'checkout.a.test', first: '2026-05-01T00:00:00', last: '2026-10-02T00:00:00' }]);
  assert.deepStrictEqual(otxHosts(otx, OLD_CNAME).map((h) => h.host), ['checkout.old.test']);
  assert.deepStrictEqual(otxHosts({ detail: 'limited' }), []);
  const scans = [
    { page: { domain: 'www.shop.test' }, task: { time: '2026-10-01T10:00:00Z' } },
    { page: { domain: 'shop.test' }, task: { time: '2026-10-03T10:00:00Z' } },
    { page: { domain: 'p7f6rg-qy.myshopify.com' }, task: { time: '2026-10-03T10:00:00Z' } },
    { page: { domain: 'api.lassocheckout.com' }, task: { time: '2026-10-03T10:00:00Z' } },
  ];
  assert.deepStrictEqual(urlscanHosts(scans), [{ host: 'shop.test', seen: '2026-10-03' }]);
  assert.deepStrictEqual(ddgHosts({ cnames: [{ original: 'checkout.c.test', resolved: LASSO_CNAME }, { original: 'x.test', resolved: 'other.vercel-dns-016.com' }] }), ['checkout.c.test']);
  const c = candidatesOf({ otx: [{ target: LASSO_CNAME, json: otx }], urlscan: [[...scans, { page: { domain: 'checkout.a.test' }, task: { time: '2026-10-04T00:00:00Z' } }]], ddg: ['checkout.c.test'], known: [{ domain: 'old.test', checkout_host: 'checkout.old.test' }] });
  assert.deepStrictEqual([...c.keys()].sort(), ['a.test', 'c.test', 'old.test', 'shop.test']);
  assert.deepStrictEqual([...c.get('a.test').sources].sort(), ['otx', 'urlscan'], 'one store, two sources');
  assert.strictEqual(c.get('a.test').checkoutHost, 'checkout.a.test');
  assert.strictEqual(c.get('old.test').checkoutHost, 'checkout.old.test');
  assert.ok(URLSCAN_QUERIES.includes('domain:lassocheckout.com'));
});

test('urlscan.io search: every result page (search_after), the key only in its header; an error keeps what came before', async () => {
  const calls = [];
  const page = (n, from) => ({ results: Array.from({ length: n }, (_, i) => ({ page: { domain: `s${from + i}.test` }, sort: [from + i, 'x'] })) });
  const doFetch = async (url, init) => {
    calls.push({ url, init });
    const after = new URL(url).searchParams.get('search_after');
    if (!after) return json(page(100, 0));
    if (after === '99,x') return json(page(40, 100));
    return json({}, 500);
  };
  const r = await urlscanSearch('domain:lassocheckout.com', { doFetch, key: 'urlscan-secret-key', wait: async () => {} });
  assert.strictEqual(r.results.length, 140);
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].init.headers['api-key'], 'urlscan-secret-key');
  assert.ok(calls.every((c) => !c.url.includes('urlscan-secret-key')), 'the key never goes in a URL');
  const bad = await urlscanSearch('q', { doFetch: async (url) => (new URL(url).searchParams.get('search_after') ? json({}, 429) : json(page(100, 0))), wait: async () => {} });
  assert.deepStrictEqual([bad.error, bad.results.length], ['HTTP 429', 100]);
  assert.deepStrictEqual(await otxPassiveDns(LASSO_CNAME, { doFetch: async () => json({ detail: 'slow down' }, 429) }), { error: 'HTTP 429' });
});

// Fake stores: shop-a.test runs Lasso's script; shop-b.test only has Lasso's checkout; shop-c.test has neither;
// mirror.test is shop-a's Shopify store on another domain; closed.test is a closed Shopify store.
function fakeWeb({ aHasLasso = true } = {}) {
  const calls = [];
  const best = json({ data: { products: { nodes: [
    { title: 'Shipping Protection', handle: 'shipping-protection', priceRange: { minVariantPrice: { amount: '4.95', currencyCode: 'EUR' } }, compareAtPriceRange: { maxVariantPrice: { amount: '0.0' } }, featuredImage: null, productType: '' },
    { title: 'Glow Gummies', handle: 'glow-gummies', priceRange: { minVariantPrice: { amount: '39.95', currencyCode: 'EUR' } }, compareAtPriceRange: { maxVariantPrice: { amount: '79.9' } }, featuredImage: { url: 'https://cdn.shopify.com/g.jpg' }, productType: 'Gummies' },
    { title: 'Free Gift', handle: 'gift', priceRange: { minVariantPrice: { amount: '0.0', currencyCode: 'EUR' } }, compareAtPriceRange: { maxVariantPrice: { amount: '0.0' } }, featuredImage: null, productType: '' },
  ] } } });
  const hosts = new Set(['shop-a.test', 'mirror.test', 'shop-b.test', 'checkout.shop-b.test', 'shop-c.test', 'checkout.shop-c.test', 'closed.test']);
  const doFetch = async (url, init = {}) => {
    calls.push(url);
    const u = new URL(url);
    const host = u.hostname;
    if (!hosts.has(host)) throw new TypeError('fetch failed');
    if (u.pathname.endsWith('/graphql.json')) return /BEST_SELLING/.test(init.body || '') ? best.clone() : json({ data: { products: { nodes: [{ id: '1' }, { id: '2' }] } } });
    if (u.pathname === '/products.json') return host === 'shop-b.test' ? html('nope', 404) : json({ products: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    if (u.pathname === '/meta.json') {
      return ['shop-a.test', 'mirror.test'].includes(host)
        ? json({ name: 'Shop A', city: 'Utrecht', country: 'NL', currency: 'EUR', myshopify_domain: 'a1b2c3-xy.myshopify.com', published_products_count: 1290, ships_to_countries: ['AT', 'CH', 'DE'] })
        : html('', 404);
    }
    if (u.pathname !== '/') return html('', 404);
    if (host === 'shop-a.test') return html(storePage(aHasLasso ? TAG_V4 : ''));
    if (host === 'mirror.test') return html(storePage(TAG_V4));
    if (host === 'shop-b.test') return html(storePage('', 'bbb.myshopify.com', 'de'));
    if (host === 'checkout.shop-b.test') return html(SKELETON);
    if (host === 'shop-c.test') return html(storePage('', 'ccc.myshopify.com'));
    if (host === 'checkout.shop-c.test') return html('<title>Secure Checkout</title>');
    if (host === 'closed.test') return html('<title>Store unavailable</title>', 402);
    throw new TypeError('fetch failed');
  };
  return { doFetch, calls };
}

test('the store checks: live, Shopify, its Lasso tag, language and currency; the checkout host; best sellers; product count', async () => {
  const { doFetch } = fakeWeb();
  const s = await checkStore('shop-a.test', { doFetch });
  assert.deepStrictEqual([s.live, s.shopify, s.myshopify, s.lasso.storeId, s.marks, s.lang, s.currency, s.country, s.siteName, s.title],
    [true, true, 'a1b2c3-xy.myshopify.com', ID, ['tag'], 'en', 'EUR', 'NL', 'Shop & Co', 'Shop & Co']);
  const big = await checkStore('big.test', { doFetch: async () => html(storePage('x'.repeat(3e6) + TAG_V4)) });
  assert.strictEqual(big.lasso && big.lasso.storeId, ID, 'a 3 MB page with the tag near the end');
  const down = await checkStore('gone.test', { doFetch });
  assert.deepStrictEqual([down.live, down.status, down.error], [false, 0, 'network']);
  assert.strictEqual((await checkStore('closed.test', { doFetch })).live, false);
  assert.deepStrictEqual(await checkCheckout('checkout.shop-b.test', { doFetch }), { host: 'checkout.shop-b.test', lasso: true, status: 200 });
  assert.strictEqual((await checkCheckout('checkout.shop-c.test', { doFetch })).lasso, false);
  const b = await bestSellers('shop-a.test', { doFetch });
  assert.deepStrictEqual(b.products[1], { title: 'Glow Gummies', handle: 'glow-gummies', url: 'https://shop-a.test/products/glow-gummies', price: 39.95, compareAt: 79.9, currency: 'EUR', image: 'https://cdn.shopify.com/g.jpg', type: 'Gummies' });
  assert.strictEqual(b.products[0].compareAt, null, 'a compare-at price under the price is none');
  assert.deepStrictEqual(topProducts(b.products).map((p) => p.title), ['Glow Gummies'], 'shipping protection and the free gift are no products');
  assert.deepStrictEqual(await bestSellers('nowhere.test', { doFetch }), { error: 'network' });
  assert.strictEqual(await catalogSize('shop-a.test', { doFetch }), 3);
  assert.strictEqual(await catalogSize('shop-b.test', { doFetch }), 2, 'products.json off: the Storefront API counts');
  assert.strictEqual(await catalogSize('nowhere.test', { doFetch }), null);
  assert.deepStrictEqual(await shopMeta('shop-a.test', { doFetch }), { name: 'Shop A', city: 'Utrecht', country: 'NL', currency: 'EUR', products: 1290, shipsTo: ['AT', 'CH', 'DE'], myshopify: 'a1b2c3-xy.myshopify.com' });
  assert.strictEqual(await shopMeta('shop-b.test', { doFetch }), null);
});

test('add-ons, store kinds and the Ad Library link', () => {
  for (const t of ['Shipping Protection', 'Add Insurance to your order? Just $4.95 extra! 🔒', 'Versicherter Versand', 'Sicherheitspaket', 'Protection de votre colis - dommages', 'Forsendelsesbeskyttelse', 'On-Time Delivery Guarantee', 'Black Friday Mystery Gift – Free With Your Order']) assert.ok(isAddOn({ title: t }), t);
  for (const t of ['MP Style Carbon Fiber Dual Exhaust Tip', 'Glow Tanning Gummies', 'Orthopedic Comfort Slip-Ons']) assert.ok(!isAddOn({ title: t }), t);
  assert.deepStrictEqual([storeKind(1), storeKind(3), storeKind(4), storeKind(25), storeKind(26), storeKind(null)], ['one-product', 'one-product', 'niche', 'niche', 'general', '']);
  assert.strictEqual(adLibraryUrl('www.Shop.test'), 'https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=shop.test');
});

const sources = ({ otxFails = false, urlscanFails = false } = {}) => ({
  otx: async (target) => (otxFails ? { error: 'HTTP 429' } : target === LASSO_CNAME
    ? { passive_dns: [{ record_type: 'CNAME', hostname: 'checkout.shop-b.test', address: LASSO_CNAME }, { record_type: 'CNAME', hostname: 'checkout.closed.test', address: LASSO_CNAME }] }
    : { passive_dns: [] }),
  urlscan: async (q) => (urlscanFails ? { error: 'HTTP 503', results: [] } : q.startsWith('domain:')
    ? { results: ['shop-a.test', 'www.mirror.test', 'shop-c.test', 'gone.test'].map((d) => ({ page: { domain: d }, task: { time: '2026-10-30T00:00:00Z' } })) }
    : { results: [] }),
  ddg: async () => ({ cnames: [] }),
});

test('a run: verified stores saved once (one per Shopify store), first_seen kept, a store that left Lasso turns gone; the log names no store', async () => {
  const mem = memoryDb();
  const db = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(mem).doFetch, retryMs: 0 });
  const lines = [];
  let sum = '';
  const day1 = Date.parse('2026-11-01T06:00:00Z');
  const queries = [];
  const t = await run({ minutes: 5, days: 7 }, { db, doFetch: fakeWeb().doFetch, now: () => day1, log: (m) => lines.push(m), summary: (m) => (sum += m), ...sources(), urlscan: async (q) => (queries.push(q), sources().urlscan(q)) });
  assert.deepStrictEqual([t.health, t.verified, t.script, t.checkout, t.mirrors, t.new, t.gone], ['ok', 2, 1, 1, 1, 2, 0]);
  assert.ok(queries.every((q) => q.endsWith(' AND date:>now-7d')), 'urlscan: the last LASSO_DAYS days');
  const rows = mem.prepare('SELECT * FROM lasso_stores ORDER BY domain').all();
  assert.deepStrictEqual(rows.map((r) => [r.domain, r.verdict, r.checkout_host, r.script, r.store_id, r.title, r.lang, r.currency, r.business_country, r.ships_to, r.products, r.kind]), [
    ['mirror.test', 'script', 'checkout.shop-a.test', 'lasso-script-v4.min.js', ID, 'Shop A', 'en', 'EUR', 'NL', '["AT","CH","DE"]', 1290, 'general'],
    ['shop-b.test', 'checkout', 'checkout.shop-b.test', '', '', 'Shop & Co', 'de', 'EUR', '', '[]', 2, 'one-product'],
  ], 'shop-a.test and mirror.test are one Shopify store: saved once; shop-c (no Lasso), gone.test and closed.test are not; /meta.json gives the count, else products.json / the Storefront API');
  assert.deepStrictEqual(JSON.parse(rows[0].best).map((p) => p.title), ['Glow Gummies']);
  assert.deepStrictEqual(JSON.parse(rows[1].sources), ['otx']);
  assert.strictEqual(rows[0].first_seen, '2026-11-01T06:00:00.000Z');
  assert.ok(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'lasso_run'").get().value).verified === 2);
  // Public logs: no store name, no checkout host, no product.
  for (const text of [...lines, sum]) assert.doesNotMatch(text, /shop-[abc]\.test|mirror\.test|closed\.test|Glow Gummies|Shop A|Utrecht/, text);
  assert.match(sum, /2 verified \(1 script, 1 checkout only\) · 2 new/);

  // A week later: mirror.test has dropped Lasso (gone), shop-b is still there and keeps its first_seen.
  const day8 = day1 + 7 * 864e5;
  const web = fakeWeb();
  const noLasso = async (url, init) => (new URL(url).hostname === 'mirror.test' && new URL(url).pathname === '/' ? html(storePage('')) : web.doFetch(url, init));
  const t2 = await run({}, { db, doFetch: noLasso, now: () => day8, log: () => {}, ...sources() });
  assert.deepStrictEqual([t2.verified, t2.new, t2.gone], [2, 1, 1], 'shop-a is now its own row (mirror.test left), mirror.test is gone');
  const after = Object.fromEntries(mem.prepare('SELECT domain, verdict, first_seen, last_seen FROM lasso_stores').all().map((r) => [r.domain, r]));
  assert.strictEqual(after['mirror.test'].verdict, 'gone');
  assert.strictEqual(after['mirror.test'].last_seen, '2026-11-01T06:00:00.000Z', 'gone: last verified stays');
  assert.strictEqual(after['shop-b.test'].first_seen, '2026-11-01T06:00:00.000Z', 'first_seen kept');
  assert.strictEqual(after['shop-b.test'].last_seen, '2026-11-08T06:00:00.000Z');
  assert.strictEqual(after['shop-a.test'].verdict, 'script');
});

test('a run: one Shopify store on two domains keeps the domain D1 already has, also when the other one has more sources', async () => {
  const mem = memoryDb();
  const db = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(mem).doFetch, retryMs: 0 });
  const quiet = { db, log: () => {}, doFetch: fakeWeb().doFetch };
  await run({}, { ...quiet, now: () => Date.parse('2026-11-01T06:00:00Z'), ...sources() });
  // A week later shop-a.test is also in OTX (two sources), mirror.test only in urlscan.
  const more = sources();
  const otx = async (target) => (target === LASSO_CNAME ? { passive_dns: [{ record_type: 'CNAME', hostname: 'checkout.shop-a.test', address: LASSO_CNAME }, ...(await more.otx(target)).passive_dns] } : more.otx(target));
  const t = await run({}, { ...quiet, now: () => Date.parse('2026-11-08T06:00:00Z'), ...more, otx });
  assert.deepStrictEqual([t.mirrors, t.new], [1, 0]);
  assert.deepStrictEqual(mem.prepare('SELECT domain FROM lasso_stores ORDER BY domain').all().map((r) => r.domain), ['mirror.test', 'shop-b.test']);
});

test('a run: one source failing is yellow, every source failing is red; a D1 failure is red; time up is yellow', async () => {
  const quiet = { log: () => {}, doFetch: fakeWeb().doFetch, now: () => Date.parse('2026-11-01T06:00:00Z') };
  assert.strictEqual((await run({}, { ...quiet, ...sources({ otxFails: true }) })).health, 'warning');
  const red = await run({}, { ...quiet, ...sources({ otxFails: true, urlscanFails: true }) });
  assert.deepStrictEqual([red.health, red.problems[0][1]], ['failed', 'no source answered (OTX, urlscan.io)']);
  const broken = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(memoryDb(), { fail: (b) => b.sql === SAVE_SQL }).doFetch, retryMs: 0 });
  const failed = await run({}, { ...quiet, db: broken, ...sources() });
  assert.deepStrictEqual([failed.health, failed.saved], ['failed', 0]);
  let clock = Date.parse('2026-11-01T06:00:00Z');
  const late = await run({ minutes: 1 }, { ...quiet, now: () => (clock += 20000), ...sources() });
  assert.strictEqual(late.health, 'warning');
  assert.ok(late.checked < late.candidates);
  // Without D1 nothing is saved and the run still says what it found.
  const none = await run({}, { ...quiet, ...sources() });
  assert.deepStrictEqual([none.health, none.verified, none.saved], ['ok', 2, 0]);
});

test('CSV: one line per store, its top 3 products and the Ad Library link; commas and quotes escaped', () => {
  const csv = toCsv([{ domain: 'shop.test', verdict: 'script', checkout_host: 'checkout.shop.test', title: 'Shop, "Co"', lang: 'en', currency: 'EUR', business_country: 'NL', ships_to: '["DE","AT"]', products: 3, kind: 'one-product', best: JSON.stringify([{ title: 'Glow', price: 39.95, url: 'https://shop.test/products/glow' }]) }]);
  const [head, line] = csv.trim().split('\n');
  assert.strictEqual(head, 'domain,verdict,checkout_host,title,lang,currency,business_country,ships_to,products,kind,best_1,price_1,url_1,best_2,price_2,best_3,price_3,ad_library');
  assert.ok(line.startsWith('shop.test,script,checkout.shop.test,"Shop, ""Co""",en,EUR,NL,DE AT,3,one-product,Glow,39.95,https://shop.test/products/glow,,,,,https://www.facebook.com/ads/library/'), line);
});

test('lasso-stores.yml: off (only by hand), the D1-only token, and no store list in public logs or files', () => {
  const flow = fs.readFileSync(new URL('../../.github/workflows/lasso-stores.yml', import.meta.url), 'utf8');
  assert.match(flow, /workflow_dispatch:/);
  assert.doesNotMatch(flow, /^\s*(schedule|workflow_run|push|pull_request):/m, 'off by default: no trigger runs it by itself');
  assert.match(flow, /^permissions:\n  contents: read$/m);
  assert.match(flow, /^      CF_API_TOKEN: \$\{\{ secrets\.CF_D1_TOKEN \|\| secrets\.CF_API_TOKEN \}\}$/m);
  assert.match(flow, /run: node winner-hunter\/migrate\.mjs/);
  assert.match(flow, /run: node winner-hunter\/lasso\.mjs/);
  assert.doesNotMatch(flow, /LASSO_CSV|upload-artifact|META_TOKEN/, 'the repository is public: no list in a file or artifact');
});
