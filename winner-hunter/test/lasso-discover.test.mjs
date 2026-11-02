// The weekly Lasso discovery (lasso.mjs, lib/lasso-sources.mjs; docs/research/lasso-discovery.md): its sources (passive
// DNS, urlscan, the board's shops, Scrape Creators' ad search under a credit cap, lasso-extra.txt), the same store under
// several domains counted once (a redirect, an alias, the same Lasso store id), the memory of checked domains, what a new
// store is saved with (source, found_at), a dry run, the run's health; the migration (0081) and the board's "+N new".
// Everything on fake answers and the in-memory D1: nothing is sent anywhere.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { findLasso } from '../lib/lasso.mjs';
import { DNS_TARGETS, OTX, MNEMONIC, META_SEARCH, reverseDns, boardStores, parseKeywords, adsClient, landingDomains } from '../lib/lasso-sources.mjs';
import { discover, sourcesOf, summaryOf, SOURCES, BOARD_SQL, STORES_SQL, ALIASES_SQL, CANDIDATES_SQL, DEFAULT_CREDITS, RECHECK_DAYS, RETRY_DAYS, CURSOR_KEY, RUN_KEY } from '../lasso.mjs';
import { readLassoNew, NEW_DAYS } from '../worker/src/lasso.mjs';
import { API_VERSION } from '../lib/bestsellers.mjs';
import { statements, migrate, d1Client } from '../lib/d1.mjs';
import { d1Rest, d1Binding, memoryDb } from './helpers/sqlite-d1.mjs';

const NOW = Date.UTC(2026, 10, 9, 4, 41); // a Monday run
const DAY = 864e5;
const noSleep = async () => {};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const html = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html' } });
const [CHECKOUT_CNAME, PORTAL_CNAME] = DNS_TARGETS;
const SC_KEY = 'sc-test-key';

// ---------------------------------------------------------------------------
// Fake stores
// ---------------------------------------------------------------------------
const LASSO_CHECKOUT = '<!doctype html><html><head><title>Secure Checkout</title><style>body.lasso-dark-boot{}</style></head><body><div id="root"></div></body></html>';
const idOf = (host) => '6a3c9a6d' + createHash('sha1').update(host).digest('hex').slice(0, 16); // joined Lasso 2026-06-25
const page = (host, checkout, id, script) => `<!doctype html><html lang="en"><head><title>${host}</title><script>Shopify.shop = "x.myshopify.com";</script></head><body>
${script ? `<script src="https://${checkout}/shopify-scripts/${script}" data-store-id="${id}" data-checkout-url="${checkout}/checkout" defer></script>` : ''}</body></html>`;
/**
 * The routes of one shop. lasso: its checkout is Lasso's; script: the Lasso script on its page ('' for one without);
 * finalHost: where its address ends (a redirect); status: its page's status (402: closed by Shopify).
 */
function shop(host, { lasso = true, script = 'lasso-script-v4.min.js', finalHost = host, checkout = `checkout.${finalHost}`, id = idOf(finalHost), status = 200,
  best = 'Best of ' + finalHost, type = '' } = {}) {
  return {
    [`https://${host}/`]: () => [html(page(finalHost, checkout, id, lasso ? script : ''), status), `https://${finalHost}/`],
    [`https://${checkout}/checkout`]: () => (lasso ? html(LASSO_CHECKOUT) : html('<title>Not found</title>', 404)),
    [`https://${finalHost}/meta.json`]: () => json({ name: finalHost, country: 'US', currency: 'USD', published_products_count: 4 }),
    [`https://${finalHost}/api/${API_VERSION}/graphql.json`]: () => json({ data: { products: { nodes: [{ title: best, handle: 'best', productType: type, createdAt: '2026-10-01T00:00:00Z',
      priceRange: { minVariantPrice: { amount: '19.95', currencyCode: 'USD' } }, compareAtPriceRange: { maxVariantPrice: { amount: '0' } } }] } } }),
  };
}
const cname = (host, target, first = '2026-10-20T10:00:00') => ({ hostname: host, address: target, record_type: 'CNAME', first, last: '2026-11-08T00:00:00' });
const adOf = (link, caption = '') => ({ ad_archive_id: String(Math.random()).slice(2, 12), is_active: true, snapshot: { link_url: link, caption, cards: [] } });

/** A whole world: stores, passive DNS, urlscan, Scrape Creators. Every URL it is asked for is in calls. */
function world({ shops = {}, otx = {}, mnemonic = {}, scans = [], ads = {} } = {}) {
  const calls = [];
  const doFetch = async (url, init = {}) => {
    calls.push(String(url));
    const u = new URL(url);
    if (u.host === 'otx.alienvault.com') {
      const f = otx[u.pathname.split('/')[5]];
      return typeof f === 'function' ? f() : json(f || { passive_dns: [], count: 0 });
    }
    if (u.host === 'api.mnemonic.no') {
      const rows = mnemonic[u.pathname.split('/').pop()] || [];
      return json({ responseCode: 200, count: rows.length, data: rows });
    }
    if (u.host === 'urlscan.io') {
      const q = u.searchParams.get('q');
      const [, from, to] = /date:\[(\S+) TO (\S+)\]/.exec(q);
      const hits = scans.filter((s) => q.includes(s.q) && s.t >= Date.parse(from) && s.t < Date.parse(to));
      return json({ results: hits.map((s, i) => ({ _id: s.page + i + s.t, page: { domain: s.page, title: '' }, task: { domain: s.page, time: new Date(s.t).toISOString() } })), total: hits.length });
    }
    if (u.host === 'api.scrapecreators.com') {
      if (init.headers['x-api-key'] !== SC_KEY) return json({ success: false, message: 'Invalid API key' }, 401);
      return json({ success: true, credits_charged: 1, credits_remaining: 900, searchResults: ads[u.searchParams.get('query')] || [] });
    }
    const f = shops[String(url)];
    if (!f) throw new TypeError('fetch failed');
    const [res, finalUrl] = [].concat(f());
    Object.defineProperty(res, 'url', { value: finalUrl || String(url) });
    return res;
  };
  return { calls, doFetch };
}

function freshDb() {
  const rest = d1Rest();
  rest.db.exec('DELETE FROM lasso_stores'); // without the research list (migration 0080; with it: lasso-filter.test.mjs)
  return { rest, db: d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: rest.doFetch, retryMs: 0 }) };
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------
test('Lasso\'s subscriptions script is a Lasso sign too, with Lasso\'s path and store id; the name alone is not', () => {
  const tag = '<script src="https://checkout.kittysupps.test/shopify-scripts/subscriptions-script.js" data-store-id="6a1c30f6d059f308eecf4bf4" data-checkout-url="checkout.kittysupps.test/checkout" defer></script>';
  assert.deepStrictEqual(findLasso(tag), [{ src: 'https://checkout.kittysupps.test/shopify-scripts/subscriptions-script.js', version: 'subscriptions', storeId: '6a1c30f6d059f308eecf4bf4',
    checkoutUrl: 'checkout.kittysupps.test/checkout', checkoutHost: 'checkout.kittysupps.test', apiUrl: '' }]);
  assert.strictEqual(findLasso(tag.replace('subscriptions-script.js', 'subscriptions-script.min.js'))[0].version, 'subscriptions');
  assert.deepStrictEqual(findLasso(tag.replace(/data-store-id="[^"]+"/, '')), [], 'no Lasso store id: another app\'s script of the same name');
  assert.deepStrictEqual(findLasso('<script src="https://cdn.other.test/subscriptions-script.js" data-store-id="6a1c30f6d059f308eecf4bf4"></script>'), [], 'not under shopify-scripts/');
});

test('reverse DNS: the CNAME records that point at the target, from OTX and Mnemonic; OTX is asked again after a 504', async () => {
  let otxCalls = 0;
  const waits = [];
  const { doFetch, calls } = world({
    otx: { [CHECKOUT_CNAME]: () => (++otxCalls === 1 ? html('Gateway Time-out', 504) : json({ count: 4, passive_dns: [
      cname('checkout.dns-a.test', CHECKOUT_CNAME, '2026-10-20T10:00:00'),
      cname('CHECKOUT.Dns-B.test.', CHECKOUT_CNAME + '.'),
      cname('checkout.elsewhere.test', 'e4e52b5c1254e1d1.vercel-dns-016.com'),
      { hostname: CHECKOUT_CNAME, address: '216.150.1.193', record_type: 'A', first: '2026-02-13T15:07:36' },
    ] })) },
    mnemonic: { [CHECKOUT_CNAME]: [
      { query: 'checkout.dns-a.test', answer: CHECKOUT_CNAME, rrtype: 'cname', firstSeenTimestamp: Date.parse('2026-10-18T00:00:00Z') },
      { query: 'checkout.mn-c.test', answer: CHECKOUT_CNAME, rrtype: 'cname', firstSeenTimestamp: Date.parse('2026-11-01T00:00:00Z') },
      { query: CHECKOUT_CNAME, answer: '216.150.1.193', rrtype: 'a', firstSeenTimestamp: 1 },
    ] },
  });
  const got = await reverseDns(CHECKOUT_CNAME, { doFetch, sleep: async (ms) => waits.push(ms) });
  assert.deepStrictEqual(got.failed, []);
  assert.deepStrictEqual(got.hosts, [
    { host: 'checkout.dns-a.test', via: ['otx', 'mnemonic'], first: '2026-10-18T00:00:00.000Z' },
    { host: 'checkout.dns-b.test', via: ['otx'], first: '2026-10-20T10:00:00.000Z' },
    { host: 'checkout.mn-c.test', via: ['mnemonic'], first: '2026-11-01T00:00:00.000Z' },
  ], 'only CNAMEs to the target, lowercase, the earliest first-seen of both');
  assert.deepStrictEqual(waits, [15000], 'one 504, then a pause before the second try');
  assert.ok(calls.includes(`${OTX}${CHECKOUT_CNAME}/passive_dns`));
  assert.ok(calls.includes(`${MNEMONIC}${CHECKOUT_CNAME}?limit=1000&offset=0`));

  const down = await reverseDns(PORTAL_CNAME, { doFetch: async () => html('busy', 503), sleep: noSleep });
  assert.deepStrictEqual([down.hosts, down.failed, down.errors], [[], ['otx', 'mnemonic'], { otx: 'HTTP 503', mnemonic: 'HTTP 503' }]);
  let tries = 0;
  const refused = await reverseDns(PORTAL_CNAME, { doFetch: async () => (tries++, html('no', 403)), sleep: noSleep });
  assert.deepStrictEqual([refused.failed, tries], [['otx', 'mnemonic'], 2], 'a 403 is not asked again');
  const odd = await reverseDns(PORTAL_CNAME, { doFetch: async () => json({ passive_dns: 'x', data: null }), sleep: noSleep });
  assert.deepStrictEqual([odd.hosts, odd.failed], [[], []], 'an odd answer: nothing, no throw');
});

test('the board\'s shops: every table the board shows, the EU winners of the last 60 days; a missing table gives none', async () => {
  const { rest, db } = freshDb();
  const winner = rest.db.prepare('INSERT INTO winners (ad_id, store_url, last_seen) VALUES (?, ?, ?)');
  winner.run('w1', 'https://www.recent-shop.test/', new Date(NOW - 5 * DAY).toISOString());
  winner.run('w2', 'https://old-shop.test/', new Date(NOW - 90 * DAY).toISOString());
  rest.db.prepare("INSERT INTO google_products (product_key, ad_id, active, store_url) VALUES ('g.test/products/x', 'g1', 1, 'https://google-shop.test/'), ('h.test/products/y', 'g2', 0, 'https://inactive.test/')").run();
  assert.deepStrictEqual((await boardStores(db, BOARD_SQL, { now: NOW })).sort(), ['google-shop.test', 'recent-shop.test']);
  rest.db.exec('DROP TABLE google_products');
  assert.deepStrictEqual(await boardStores(db, BOARD_SQL, { now: NOW }), ['recent-shop.test'], 'an older database without the Google table');
  const broken = { query: async () => { throw new Error('Cloudflare D1: network'); } };
  await assert.rejects(boardStores(broken, BOARD_SQL, { now: NOW }), /network/);
});

test('the ad search: Scrape Creators\' Meta search, the shops its ads link to, never past the credit cap', async () => {
  const sent = [];
  const answer = { success: true, credits_charged: 1, searchResults: [
    adOf('https://www.ads-h.test/products/basket?utm_source=fb', 'ADS-H.TEST'),
    adOf('https://www.facebook.com/somepage'),
    adOf('https://www.amazon.com/dp/B0X'),
    { snapshot: { link_url: null, caption: 'caption-only.test', cards: [{ link_url: 'https://card-shop.test/products/a' }, null] } },
    null,
  ] };
  assert.deepStrictEqual(landingDomains(answer), { domains: ['ads-h.test', 'caption-only.test', 'card-shop.test'], ads: 5 }, 'not Facebook, not a marketplace');
  assert.deepStrictEqual(landingDomains(null), { domains: [], ads: 0 });
  const api = adsClient({ key: SC_KEY, cap: 2, fetch: async (url, init) => (sent.push({ url: String(url), key: init.headers['x-api-key'] }), json(answer)), sleep: noSleep });
  assert.deepStrictEqual((await api.search('quilted basket')).domains, ['ads-h.test', 'caption-only.test', 'card-shop.test']);
  await api.search('copper bracelet', { country: 'AU' });
  await assert.rejects(api.search('bird bath'), (e) => e.kind === 'cap' && e.stop === true);
  assert.strictEqual(sent.length, 2, 'the third search is never sent');
  const u = new URL(sent[1].url);
  assert.deepStrictEqual([u.origin + u.pathname, u.searchParams.get('query'), u.searchParams.get('country'), u.searchParams.get('status'), sent[1].key],
    ['https://api.scrapecreators.com' + META_SEARCH, 'copper bracelet', 'AU', 'ACTIVE', SC_KEY]);
  assert.deepStrictEqual([api.stats().spent, api.stats().cap, api.stats().by], [2, 2, { meta: 2 }]);
  const refused = adsClient({ key: 'wrong', cap: 5, fetch: async () => json({ message: 'Invalid API key' }, 401), sleep: noSleep });
  await assert.rejects(refused.search('x'), (e) => e.kind === 'key' && e.stop && !/wrong/.test(e.message));
  assert.throws(() => adsClient({ key: ' ', cap: 5 }), /No API key: add the GitHub secret SCRAPECREATORS_API_KEY/);
});

test('lasso-keywords.txt and lasso-extra.txt: what the job reads; the comments are no keywords or domains', () => {
  assert.deepStrictEqual(parseKeywords('# a comment\nQuilted  Basket\n\nquilted basket # again\ncopper bracelet\n'), ['quilted basket', 'copper bracelet']);
  const kw = parseKeywords(fs.readFileSync(new URL('../lasso-keywords.txt', import.meta.url), 'utf8'));
  assert.ok(kw.length >= DEFAULT_CREDITS, 'one run of the default cap takes a keyword once');
  assert.ok(kw.every((k) => k.length >= 3 && k.length <= 100 && !k.includes('#')));
  const extra = fs.readFileSync(new URL('../lasso-extra.txt', import.meta.url), 'utf8');
  const listed = extra.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  assert.strictEqual(listed.length, 115, 'the 115 live stores only the WhoisFreaks sample showed (docs/research/lasso-discovery.md)');
  assert.ok(listed.every((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)), 'one domain a line');
  assert.match(extra, /vercel-dns-016\.com/, 'the comments do name addresses …');
  const csv = fs.readFileSync(new URL('../../docs/research/lasso-discovery-2026-11-02.csv', import.meta.url), 'utf8');
  assert.ok(listed.every((d) => csv.includes(`\n${d},`)), '… and every listed store is in the research list');
});

test('LASSO_SOURCES: all by default, or some of them; a typo stops the run', () => {
  assert.deepStrictEqual(sourcesOf(''), SOURCES);
  assert.deepStrictEqual(sourcesOf('all'), SOURCES);
  assert.deepStrictEqual(sourcesOf('urlscan, DNS'), ['dns', 'urlscan'], 'in the order they run');
  assert.throws(() => sourcesOf('dns crt'), /LASSO_SOURCES: unknown crt/);
});

// ---------------------------------------------------------------------------
// A run with every source
// ---------------------------------------------------------------------------
function bigWorld() {
  const shops = {
    ...shop('dns-a.test'), ...shop('dns-b.test'), ...shop('portal-c.test'), ...shop('url-d.test'),
    ...shop('whop-e.test', { lasso: false }), // Whop's pixel, no Lasso
    ...shop('board-f.test'), ...shop('board-g.test', { lasso: false }),
    ...shop('ads-h.test'), ...shop('ads-i.test', { lasso: false }),
    ...shop('extra-j.test', { finalHost: 'extra-j-shop.test' }), // redirects to its store
    ...shop('extra-k.test', { status: 402, script: '' }), // Lasso, closed by Shopify
    ...shop('twin-a.test'), ...shop('twin-b.test', { checkout: 'checkout.twin-a.test', id: idOf('twin-a.test') }), // one store, two domains
    ...shop('ebook-l.test', { best: 'Truths and Lies About Stomach Problems (e-book)', type: 'Digital' }), // a digital product
    ...shop('left-m.test'), // left Lasso before, back now
    ...shop('saved.test'), // saved before, still on Lasso
  };
  return world({
    shops,
    otx: { [CHECKOUT_CNAME]: { passive_dns: [cname('checkout.dns-a.test', CHECKOUT_CNAME), cname('secure.dns-b.test', CHECKOUT_CNAME), cname('checkout.left-m.test', CHECKOUT_CNAME)] } },
    mnemonic: { [PORTAL_CNAME]: [{ query: 'account.portal-c.test', answer: PORTAL_CNAME, rrtype: 'cname', firstSeenTimestamp: Date.parse('2026-11-02T00:00:00Z') }] },
    scans: [
      { q: 'lasso-script-v4.min.js', page: 'url-d.test', t: NOW - 3 * DAY },
      { q: 'lasso-script-v4.min.js', page: 'ebook-l.test', t: NOW - 2 * DAY },
      { q: 'lasso-script-v4.min.js', page: 'twin-a.test', t: NOW - 2 * DAY },
      { q: 'lasso-script-v4.min.js', page: 'twin-b.test', t: NOW - 1 * DAY },
      { q: 'domain:t.whop.tw', page: 'whop-e.test', t: NOW - DAY },
    ],
    ads: {
      'quilted basket': [adOf('https://ads-h.test/products/basket'), adOf('https://www.facebook.com/x')],
      'copper bracelet': [adOf('https://ads-i.test/'), adOf('https://saved-old.test/products/y', 'SAVED-OLD.TEST')], // an alias of a saved store
      'bird bath': [adOf('https://bird.test/')],
    },
  });
}

function seedBig(rest) {
  const store = rest.db.prepare('INSERT INTO lasso_stores (store, host, confidence, live, lasso_store_id, aliases, how, first_seen, last_seen, checked_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)');
  store.run('saved.test', 'saved.test', 'high', idOf('saved.test'), 'saved-old.test', 'research 2026-11-01: urlscan', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  store.run('left-m.test', 'left-m.test', '', idOf('left-m.test'), null, 'store page', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
  rest.db.prepare('INSERT INTO winners (ad_id, store_url, last_seen) VALUES (?, ?, ?)').run('w1', 'https://board-f.test/', new Date(NOW - DAY).toISOString());
  rest.db.prepare('INSERT INTO winners (ad_id, store_url, last_seen) VALUES (?, ?, ?)').run('w2', 'https://www.board-g.test/', new Date(NOW - DAY).toISOString());
}

const RUN = { sleep: noSleep, log: () => {}, scKey: SC_KEY, credits: 2, keywords: ['quilted basket', 'copper bracelet', 'bird bath'], concurrency: 6 };

test('a run with every source: new stores saved with their source and the day found; one store under two domains is one row', async () => {
  const { rest, db } = freshDb();
  seedBig(rest);
  const w = bigWorld();
  const t = await discover({ ...RUN, doFetch: w.doFetch, db, now: () => NOW, extra: ['extra-j.test', 'checkout.extra-k.test'] });
  assert.strictEqual(t.health, 'ok', t.alert);
  const rows = new Map(rest.db.prepare('SELECT * FROM lasso_stores').all().map((r) => [r.store, r]));
  const fresh = [...rows.values()].filter((r) => r.found_at).map((r) => [r.store, r.source, r.confidence, r.live]).sort();
  assert.deepStrictEqual(fresh, [
    ['ads-h.test', 'ads', 'high', 1],
    ['board-f.test', 'board', 'high', 1],
    ['dns-a.test', 'dns', 'high', 1],
    ['dns-b.test', 'dns', 'high', 1], // its secure.* record: the store is the domain it sits under
    ['ebook-l.test', 'urlscan', 'high', 1], // sells a digital product: saved like any other
    ['extra-j-shop.test', 'extra', 'high', 1], // under the address it ends at
    ['extra-k.test', 'extra', 'medium', 0], // closed: saved, not counted as new
    ['portal-c.test', 'dns', 'high', 1],
    ['twin-a.test', 'urlscan', 'high', 1],
    ['url-d.test', 'urlscan', 'high', 1],
  ]);
  assert.ok([...rows.values()].filter((r) => r.found_at).every((r) => r.found_at === new Date(NOW).toISOString()));
  assert.deepStrictEqual(t.found.map((r) => r.store).sort(), ['ads-h.test', 'board-f.test', 'dns-a.test', 'dns-b.test', 'ebook-l.test', 'extra-j-shop.test', 'portal-c.test', 'twin-a.test', 'url-d.test'],
    'new: live and on Lasso now');
  assert.deepStrictEqual(Object.fromEntries(Object.entries(t.by).map(([k, x]) => [k, x.new])), { dns: 3, urlscan: 3, board: 1, ads: 1, extra: 1, sister: 0, saved: 0 });
  // One store, several names: its other domains are aliases, never rows of their own.
  assert.ok(!rows.has('twin-b.test') && !rows.has('extra-j.test') && !rows.has('saved-old.test'));
  assert.strictEqual(rows.get('twin-a.test').aliases, 'twin-b.test', 'the same Lasso store id');
  assert.strictEqual(rows.get('extra-j-shop.test').aliases, 'extra-j.test', 'a redirect');
  assert.strictEqual(rows.get('saved.test').aliases, 'saved-old.test', 'an ad for its alias: no new store, no new alias');
  // Saved before: checked again, not new.
  assert.deepStrictEqual([rows.get('saved.test').found_at, rows.get('saved.test').source, rows.get('saved.test').first_seen], [null, null, '2026-10-01T00:00:00.000Z']);
  assert.deepStrictEqual([rows.get('left-m.test').confidence, rows.get('left-m.test').found_at], ['high', null], 'back on Lasso: in the filter again, not new');
  assert.deepStrictEqual(JSON.parse(rows.get('ebook-l.test').best_sellers)[0].type, 'Digital');
  // What was checked, so the next runs leave it alone; the ad searches stop at the cap and go on there next run.
  const memo = Object.fromEntries(rest.db.prepare('SELECT domain, result, store FROM lasso_candidates').all().map((r) => [r.domain, [r.result, r.store]]));
  assert.deepStrictEqual(memo['whop-e.test'], ['no', '']);
  assert.deepStrictEqual(memo['twin-b.test'], ['lasso', 'twin-a.test']);
  assert.deepStrictEqual(memo['extra-k.test'], ['closed', 'extra-k.test']);
  assert.ok(!('saved.test' in memo), 'the stores themselves are not candidates');
  assert.deepStrictEqual([t.keywords, t.credits.spent, t.credits.cap], [2, 2, 2]);
  assert.ok(!w.calls.some((u) => u.includes('bird+bath') || u.includes('bird%20bath')), 'the third keyword waits for the next run');
  assert.strictEqual(rest.db.prepare('SELECT value FROM state WHERE key = ?').get(CURSOR_KEY).value, '2');
  const run = JSON.parse(rest.db.prepare('SELECT value FROM state WHERE key = ?').get(RUN_KEY).value);
  assert.deepStrictEqual([run.new, run.health, run.credits, run.at], [9, 'ok', { spent: 2, cap: 2 }, new Date(NOW).toISOString()]);
  assert.match(summaryOf(t), /^Lasso stores: 9 new; .* dns 3 new of 4 Lasso in 4 checked, .* 2 of 2 credits, 2 keywords; 150 urlscan searches \(ok\)$/);
  assert.doesNotMatch(summaryOf(t), /\.test/, 'the public summary has counts, no store names');

  // The board: the live new stores of the last 7 days, by source.
  const fresh7 = await readLassoNew(d1Binding(rest.db), NOW + DAY);
  assert.deepStrictEqual([fresh7.n, fresh7.by, fresh7.days], [9, { dns: 3, urlscan: 3, board: 1, ads: 1, extra: 1 }, NEW_DAYS]);
  assert.strictEqual(fresh7.stores.length, 8, 'the newest 8 by name');
  assert.strictEqual((await readLassoNew(d1Binding(rest.db), NOW + 8 * DAY)).n, 0, 'a week later: none new');

  // A week later: everything checked lately is left alone, the saved stores are checked again, the keywords go on.
  const later = NOW + 7 * DAY;
  const t2 = await discover({ ...RUN, doFetch: w.doFetch, db, now: () => later, extra: ['extra-j.test', 'checkout.extra-k.test'] });
  assert.strictEqual(t2.health, 'ok', t2.alert);
  assert.deepStrictEqual(t2.found, [], 'nothing new');
  assert.strictEqual(t2.skipped, 2, 'whop-e.test and board-g.test: checked lately (ads-i.test\'s keyword is not searched this week)');
  assert.deepStrictEqual(['https://whop-e.test/', 'https://board-g.test/'].map((u) => w.calls.filter((x) => x === u).length), [1, 1], 'checked once, in the first run');
  assert.ok(w.calls.filter((x) => x === 'https://saved.test/').length === 2, 'a saved store: every run');
  assert.strictEqual(rest.db.prepare("SELECT found_at FROM lasso_stores WHERE store = 'dns-a.test'").get().found_at, new Date(NOW).toISOString(), 'found_at stays the first day');
  assert.strictEqual(rest.db.prepare('SELECT value FROM state WHERE key = ?').get(CURSOR_KEY).value, '1', 'bird bath, then quilted basket again');
});

test('a saved store that moved to another domain stays one store: the new domain becomes its alias, or its own row says it left', async () => {
  const { rest, db } = freshDb();
  // Saved without a Lasso store id, as the research list is.
  const put = rest.db.prepare("INSERT INTO lasso_stores (store, host, confidence, live, how, first_seen, last_seen, checked_at) VALUES (?, ?, 'high', 1, 'research 2026-11-01', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z')");
  put.run('moved.test', 'moved.test');
  put.run('quit.test', 'quit.test');
  const shops = { ...shop('moved.test', { finalHost: 'moved-new.test' }), // still on Lasso, under a new name
    ...shop('quit.test', { finalHost: 'quit-new.test', lasso: false }) }; // a new name without Lasso
  const t = await discover({ doFetch: world({ shops }).doFetch, db, now: () => NOW, sleep: noSleep, log: () => {}, sources: [] });
  assert.strictEqual(t.health, 'ok', t.alert);
  assert.deepStrictEqual(t.found, [], 'not new');
  const rows = rest.db.prepare('SELECT store, confidence, aliases, found_at FROM lasso_stores ORDER BY store').all().map((r) => ({ ...r }));
  assert.deepStrictEqual(rows, [
    { store: 'moved.test', confidence: 'high', aliases: 'moved-new.test', found_at: null },
    { store: 'quit.test', confidence: '', aliases: null, found_at: null },
  ], 'no row for the new domains');
});

test('a dry run finds and checks, and writes nothing in D1', async () => {
  const { rest, db } = freshDb();
  seedBig(rest);
  const table = () => JSON.stringify([rest.db.prepare('SELECT * FROM lasso_stores ORDER BY store').all(), rest.db.prepare('SELECT * FROM lasso_candidates').all(), rest.db.prepare('SELECT * FROM state').all()]);
  const before = table();
  const t = await discover({ ...RUN, doFetch: bigWorld().doFetch, db, now: () => NOW, dryRun: true });
  assert.strictEqual(t.health, 'ok', t.alert);
  assert.strictEqual(t.found.length, 8, 'it still finds them (the extra list was not given)');
  assert.strictEqual(t.saved, 0);
  assert.strictEqual(table(), before);
  assert.match(summaryOf(t), /^Lasso stores: 8 new \(dry run: nothing saved\)/);
});

test('a domain that did not answer is asked again after a week; one that answered, after 30 days', async () => {
  const { rest, db } = freshDb();
  // Scanned the day before the first run and again before the last one (urlscan only looks back 30 days).
  const scans = ['slow.test', 'plain.test'].flatMap((page) => [NOW - DAY, NOW + RECHECK_DAYS * DAY].map((t) => ({ q: 'domain:t.whop.tw', page, t })));
  const w = world({ scans, shops: shop('plain.test', { lasso: false }) });
  const run = async (at) => discover({ doFetch: w.doFetch, db, now: () => at, sleep: noSleep, log: () => {}, sources: ['urlscan'], days: 30 });
  await run(NOW);
  const memo = () => Object.fromEntries(rest.db.prepare('SELECT domain, result FROM lasso_candidates').all().map((r) => [r.domain, r.result]));
  assert.deepStrictEqual(memo(), { 'plain.test': 'no', 'slow.test': 'down' });
  const asked = (from) => new Set(w.calls.slice(from).filter((u) => !u.includes('urlscan.io')).map((u) => new URL(u).host));
  let from = w.calls.length;
  const t2 = await run(NOW + 2 * DAY);
  assert.deepStrictEqual([t2.skipped, asked(from).size], [2, 0], 'both left alone for now');
  from = w.calls.length;
  await run(NOW + (RETRY_DAYS + 1) * DAY);
  assert.deepStrictEqual([...asked(from)].sort(), ['checkout.slow.test', 'slow.test', 'www.slow.test'], 'no answer: asked again after a week');
  from = w.calls.length;
  await run(NOW + (RECHECK_DAYS + 1) * DAY);
  assert.ok(asked(from).has('plain.test'), 'after 30 days: asked again');
});

test('the run\'s health: a source that fails is a warning, no source answering is red; a refused key never stops the free sources', async () => {
  const { db } = freshDb();
  const urlscanOnly = { shops: shop('url-d.test'), scans: [{ q: 'lasso-script-v4.min.js', page: 'url-d.test', t: NOW - DAY }] };
  // Passive DNS down: the others still run.
  const quiet = world(urlscanOnly);
  const noDns = async (url, init) => (/otx|mnemonic/.test(url) ? html('Gateway Time-out', 504) : quiet.doFetch(url, init));
  const t = await discover({ doFetch: noDns, db, now: () => NOW, sleep: noSleep, log: () => {}, sources: ['dns', 'urlscan'] });
  assert.deepStrictEqual([t.health, t.found.map((r) => r.store)], ['warning', ['url-d.test']]);
  assert.match(t.alert, /passive DNS answered 0 of 4 lookups/);
  // Every source down: red.
  const dead = async () => html('down', 503);
  const r = await discover({ doFetch: dead, db, now: () => NOW, sleep: noSleep, log: () => {}, sources: ['dns', 'urlscan'] });
  assert.strictEqual(r.health, 'failed');
  assert.match(r.alert, /passive DNS answered 0 of 4 lookups; urlscan\.io answered none of 150 searches/);
  // Scrape Creators refuses the key: a warning, and the free sources found their stores.
  const k = await discover({ doFetch: world(urlscanOnly).doFetch, db: freshDb().db, now: () => NOW, sleep: noSleep, log: () => {}, sources: ['urlscan', 'ads'], scKey: 'wrong', credits: 5, keywords: ['x'] });
  assert.deepStrictEqual([k.health, k.found.length, k.credits.spent], ['warning', 1, 0]);
  assert.match(k.alert, /Scrape Creators refused the API key \(401\)/);
  // No key or 0 credits: the ad searches are off, nothing is sent.
  const off = world(urlscanOnly);
  const o = await discover({ doFetch: off.doFetch, now: () => NOW, sleep: noSleep, log: () => {}, sources: ['urlscan', 'ads'], scKey: SC_KEY, credits: 0, keywords: ['x'] });
  assert.deepStrictEqual([o.health, o.credits], ['ok', null]);
  assert.ok(!off.calls.some((u) => u.includes('scrapecreators')));
  // D1 does not give the saved stores: red before anything is checked.
  const broken = { query: async () => { throw new Error('Cloudflare D1: network'); } };
  const b = await discover({ doFetch: off.doFetch, db: broken, now: () => NOW, sleep: noSleep, log: () => {}, sources: ['urlscan'] });
  assert.deepStrictEqual([b.health, b.candidates], ['failed', 0]);
  assert.match(b.alert, /D1 did not give the saved Lasso stores/);
});

// ---------------------------------------------------------------------------
// The migration and the board
// ---------------------------------------------------------------------------
const MIGRATION = fs.readFileSync(new URL('../worker/migrations/0081_lasso_discovery.sql', import.meta.url), 'utf8');

test('migration 0081 is additive: two new columns, an index, the candidates table; every run after the first changes nothing', async () => {
  const st = statements(MIGRATION);
  assert.deepStrictEqual(st.map((s) => s.split(/\s+/).slice(0, 3).join(' ')), ['ALTER TABLE lasso_stores', 'ALTER TABLE lasso_stores', 'CREATE INDEX IF', 'CREATE TABLE IF', 'CREATE INDEX IF']);
  assert.ok(st.every((s) => !/\b(DROP|DELETE|UPDATE|RENAME)\b/i.test(s)), 'nothing dropped, deleted or changed');
  const files = fs.readdirSync(new URL('../worker/migrations/', import.meta.url)).filter((x) => x.endsWith('.sql')).sort();
  assert.strictEqual(files[files.length - 1], '0081_lasso_discovery.sql', 'the next number after 0080');
  const db = new DatabaseSync(':memory:');
  const client = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(db).doFetch, retryMs: 0 });
  const texts = files.map((f) => fs.readFileSync(new URL(f, new URL('../worker/migrations/', import.meta.url)), 'utf8'));
  await migrate(client, texts);
  db.prepare("UPDATE lasso_stores SET source = 'dns', found_at = '2026-11-09T04:41:00.000Z' WHERE store = 'tryglowgummies.com'").run();
  const snap = () => JSON.stringify([db.prepare('SELECT * FROM lasso_stores ORDER BY store').all(), db.prepare('SELECT * FROM lasso_candidates').all()]);
  const first = snap();
  await migrate(client, texts);
  assert.strictEqual(snap(), first);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM lasso_stores WHERE found_at IS NOT NULL').get().n, 1, 'the research list is not new');
});

test('the board\'s "+N new": live Lasso stores found in the last 7 days; none without the column; a D1 error is never the board\'s', async () => {
  const db = memoryDb();
  const put = db.prepare('INSERT INTO lasso_stores (store, confidence, live, source, found_at) VALUES (?, ?, ?, ?, ?)');
  const at = (days) => new Date(NOW - days * DAY).toISOString();
  put.run('new-a.test', 'high', 1, 'dns', at(1));
  put.run('new-b.test', 'medium', 1, 'urlscan', at(6));
  put.run('closed.test', 'medium', 0, 'dns', at(1)); // not open
  put.run('left.test', 'low', 1, 'dns', at(1)); // left Lasso
  put.run('old.test', 'high', 1, 'board', at(8)); // last week
  assert.deepStrictEqual(await readLassoNew(d1Binding(db), NOW), { n: 2, by: { dns: 1, urlscan: 1 }, stores: ['new-a.test', 'new-b.test'], days: 7 });
  const older = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(new URL('../worker/migrations/', import.meta.url)).filter((x) => x.endsWith('.sql') && x < '0081').sort()) older.exec(fs.readFileSync(new URL(f, new URL('../worker/migrations/', import.meta.url)), 'utf8'));
  assert.strictEqual(await readLassoNew(d1Binding(older), NOW), null, 'before 0081: no "new"');
  const errors = [];
  const was = console.error;
  console.error = (e) => errors.push(e);
  try {
    assert.strictEqual(await readLassoNew({ prepare: () => ({ bind: () => ({ all: async () => { throw new Error('D1_ERROR: network'); } }) }) }, NOW), null);
  } finally {
    console.error = was;
  }
  assert.strictEqual(errors.length, 1, 'logged, not thrown');
});

test('the workflow: weekly only with LASSO_STORES = on; a credit cap of 50 (the box, or LASSO_CREDITS); existing secrets only; a dry run writes nothing', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/lasso-stores.yml', import.meta.url), 'utf8');
  assert.match(wf, /^      credits:\n        description: '[^']*hard cap[^']*'\n        required: false\n        default: '50'$/m);
  assert.match(wf, /^      dry_run:\n        description: '[^']*'\n        type: boolean$/m);
  assert.match(wf, /^      LASSO_CREDITS: \$\{\{ inputs\.credits \|\| vars\.LASSO_CREDITS \|\| '50' \}\}$/m);
  assert.match(wf, /^      LASSO_SOURCES: \$\{\{ inputs\.sources \|\| vars\.LASSO_SOURCES \|\| 'all' \}\}$/m);
  assert.match(wf, /^      LASSO_DRY_RUN: \$\{\{ inputs\.dry_run && '1' \|\| '' \}\}$/m);
  assert.match(wf, /^      SCRAPECREATORS_API_KEY: \$\{\{ secrets\.SCRAPECREATORS_API_KEY \}\}$/m);
  const secrets = [...wf.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(secrets)].sort(), ['CF_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_D1_TOKEN', 'SCRAPECREATORS_API_KEY', 'URLSCAN_API_KEY'], 'only secrets the repository has');
  assert.doesNotMatch(wf, /ANTHROPIC|anthropic/, 'no Anthropic API');
  assert.match(wf, /case "\$LASSO_CREDITS" in ''\|\*\[!0-9\]\*\)/, 'credits must be a number');
  assert.match(wf, /if: \$\{\{ env\.CF_API_TOKEN != '' && env\.CF_ACCOUNT_ID != '' && !inputs\.dry_run \}\}\n        run: node winner-hunter\/migrate\.mjs/, 'a dry run makes no tables');
  assert.match(wf, /^    timeout-minutes: 120$/m);
  const code = ['../lasso.mjs', '../lib/lasso-sources.mjs', '../lib/lasso.mjs'].map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(code, /anthropic|claude-/i, 'no Anthropic API or SDK in the discovery');
  assert.match(fs.readFileSync(new URL('../lasso.mjs', import.meta.url), 'utf8'), /DEFAULT_CREDITS = 50;/);
});

test('the SQL the job writes with: a new row gets its source and found_at once; aliases and candidates are batched', () => {
  assert.match(STORES_SQL, /INSERT INTO lasso_stores \([^)]*, source, found_at\)/);
  assert.doesNotMatch(STORES_SQL.split('ON CONFLICT')[1], /source|found_at/, 'a store saved before keeps them');
  assert.match(ALIASES_SQL, /^UPDATE lasso_stores SET aliases = json_extract\(x\.value, '\$\.aliases'\) FROM json_each\(\?1\) AS x/);
  assert.match(CANDIDATES_SQL, /ON CONFLICT\(domain\) DO UPDATE SET checked_at = excluded\.checked_at, result = excluded\.result, store = excluded\.store$/);
});
