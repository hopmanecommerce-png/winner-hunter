// lib/meta.mjs (one batch of the hunt) against a fake Meta API and fake Shopify stores.
import test, { afterEach } from 'node:test';
import assert from 'node:assert';
import { hunt, marketsOf, cut, checkTokens, metaTokens, tokenState } from '../lib/meta.mjs';
import { resetCooling } from '../lib/world.mjs';

import { NOW, fakeFetch, fakeAd, usageHdr, blocked613, json, base, violations } from './helpers/fake-meta.mjs';

const quiet = { now: NOW, log: () => {} };
// The advertisers counted (a count of many ads takes more than one page: only the first page starts one).
const countedIn = (calls) => calls.filter((u) => u.searchParams.get('search_page_ids') && !u.searchParams.get('after')).map((u) => JSON.parse(u.searchParams.get('search_page_ids'))[0]).sort();
// Requests the hunt should never send (the fake writes them down instead of throwing into the hunt).
afterEach(() => assert.deepStrictEqual(violations.splice(0), []));

test('the rules on the API: only ads that pass all four come out, most reach a day first, one per product', async () => {
  const calls = [];
  const { results, stats } = await hunt(base, Object.assign({ fetch: fakeFetch(calls) }, quiet));
  assert.strictEqual(stats.ads, 7);
  const top = results[0];
  assert.strictEqual(top.id, '1');
  assert.strictEqual(top.verdict, 'winner');
  assert.strictEqual(top.score, 100);
  assert.strictEqual(top.active_ads, 134);
  assert.strictEqual(top.price, 49.95);
  assert.strictEqual(top.discount_pct, 58);
  assert.strictEqual(top.product_url, 'https://anna-boutique.shop/products/linen-dress');
  assert.strictEqual(top.image_url, 'https://cdn.shopify.com/s/files/1/l.png?v=2&width=400', 'photo URL only, Shopify CDN at 400 px');
  assert.strictEqual(top.image_source, 'product');
  assert.strictEqual(top.reach_eu, 154000);
  assert.strictEqual(top.ad_library_url, 'https://www.facebook.com/ads/library/?id=1');
  const ids = results.map((r) => r.id);
  assert.ok(!ids.includes('2'), 'duplicate of the same product dropped');
  for (const bad of ['3', '4', '5', '6']) assert.ok(!ids.includes(bad), 'ad ' + bad + ' filtered out');
  assert.deepStrictEqual(ids, ['1'], 'Old Glory: 75 days live; Tiny Shop: 66 reach a day; Real Brand: no Shopify; Amazon: marketplace; {{product.name}}: 50 a day');
  assert.deepStrictEqual(top.checklist.map((c) => [c.key, c.state, c.text]), [['shopify', 'ok', 'anna.myshopify.com'], ['ads', 'ok', '134 active ads · ad ages spread out (consistent testing)'], ['age', 'ok', 'Live 14 days'], ['reach', 'ok', '11K EU reach a day']]);
  assert.strictEqual(top.store_products, 420);
  assert.strictEqual(top.active_ads_capped, false, '134 ads: counted to the end');
  // only advertisers whose ad passes every other rule are counted (Meta requests): Anna Boutique only
  assert.deepStrictEqual(countedIn(calls), ['501']);
  assert.strictEqual(calls.filter((u) => u.searchParams.get('search_page_ids')).length, 2, '134 ads in pages of 100: every page read');
  assert.ok(!calls.some((u) => u.hostname === 'amazon.de'));
  // all three age windows asked, each in pages, every ad once
  const windows = new Set(calls.filter((u) => u.searchParams.get('search_terms')).map((u) => u.searchParams.get('ad_delivery_date_max')));
  assert.strictEqual(windows.size, 3);
  assert.ok(calls.some((u) => u.searchParams.get('search_terms') && u.searchParams.get('after')), 'a second page of results');
});

test('competitor counts are remembered for 24 hours (cache shared between batches)', async () => {
  const calls = [];
  const counted = () => countedIn(calls).length;
  const first = await hunt(base, Object.assign({ fetch: fakeFetch(calls) }, quiet));
  assert.strictEqual(counted(), 1);
  calls.length = 0;
  const second = await hunt(Object.assign({}, base, { cache: first.cache }), { fetch: fakeFetch(calls), now: NOW + 3600e3, log: () => {} });
  assert.strictEqual(counted(), 0);
  assert.strictEqual(second.results[0].active_ads, 134);
});

test('waits and retries once on a short rate limit', async () => {
  const msgs = [];
  const { results, stats } = await hunt(base, { fetch: fakeFetch([], { rateLimitOnce: true }), now: NOW, log: (m) => msgs.push(m), waitScale: 0 });
  assert.strictEqual(stats.waits, 1);
  assert.match(msgs.join('\n'), /limit \(613\)/);
  assert.strictEqual(results[0].id, '1');
});

test('an expired token throws a clear error marked as a token problem', async () => {
  await assert.rejects(hunt(base, Object.assign({ fetch: fakeFetch([], { expired: true }) }, quiet)), (e) => e.token && /expired/.test(e.message));
});

test('a long 613 block stops at once (no 17-hour wait); ads whose advertiser could not be counted stay out (pending)', async () => {
  const calls = [];
  const logs = [];
  const t0 = Date.now();
  const { results, stats } = await hunt(base, { fetch: fakeFetch(calls, { block: (u) => !!u.searchParams.get('search_page_ids') }), now: NOW, log: (m) => logs.push(m) });
  assert.ok(Date.now() - t0 < 5000);
  assert.strictEqual(stats.blocked, true);
  assert.strictEqual(stats.ads, 7);
  assert.deepStrictEqual(results, [], 'active-ad count unknown: not saved until known');
  assert.ok(logs.some((m) => /access back in ~1043 min/.test(m)));
});

test('a blocked or expired token hands over to the next one', async () => {
  const inner = fakeFetch([]);
  const seen = [];
  const f = async (url) => {
    const u = new URL(url);
    const t = u.searchParams.get('access_token');
    if (u.hostname === 'graph.test') seen.push(t);
    if (u.hostname === 'graph.test' && t === 'blocked-app') return blocked613();
    if (u.hostname === 'graph.test' && t === 'old') return json({ error: { code: 190, message: 'Error validating access token' } }, 400);
    return inner(url);
  };
  const logs = [];
  const { results, stats } = await hunt(Object.assign({}, base, { tokens: ['old', 'blocked-app', 'tok'] }), { fetch: f, now: NOW, log: (m) => logs.push(m) });
  assert.strictEqual(stats.token, 2);
  assert.ok(!stats.blocked);
  assert.strictEqual(results[0].id, '1');
  assert.ok(seen.filter((t) => t === 'blocked-app').length <= 2, 'the blocked app is not hammered');
  assert.ok(logs.some((m) => /switching to Meta token 3 of 3/.test(m)));
});

test('close to the hourly limit it slows down instead of getting blocked', async () => {
  const inner = fakeFetch([]);
  const metered = async (url) => {
    const res = await inner(url);
    if (new URL(url).hostname !== 'graph.test') return res;
    return new Response(await res.text(), { status: res.status, headers: Object.assign({ 'content-type': 'application/json' }, usageHdr(90)) });
  };
  const logs = [];
  const { results, stats } = await hunt(base, { fetch: metered, now: NOW, log: (m) => logs.push(m), waitScale: 0.0001 });
  assert.ok(stats.paced > 0 && stats.usagePeak === 90);
  assert.ok(logs.some((m) => /slowing down/.test(m)));
  assert.strictEqual(results[0].id, '1');
});

test("Meta's temporary errors are retried; a keyword that keeps failing is skipped", async () => {
  const flaky = (always) => {
    let once = true;
    const inner = fakeFetch([]);
    return async (url) => {
      const u = new URL(url);
      if (u.hostname === 'graph.test' && !u.searchParams.get('search_page_ids') && (always || once)) {
        once = false;
        return json({ error: { code: 1, message: 'An unknown error occurred' } }, 500);
      }
      return inner(url);
    };
  };
  const a = await hunt(base, { fetch: flaky(false), now: NOW, log: () => {}, waitScale: 0 });
  assert.strictEqual(a.stats.retries, 1);
  assert.strictEqual(a.results[0].id, '1');
  const b = await hunt(base, { fetch: flaky(true), now: NOW, log: () => {}, waitScale: 0 });
  assert.ok(b.stats.skipped >= 1);
});

test('near the deadline it stops searching and counting and returns what it found (on its own clock, not the real one)', async () => {
  const calls = [];
  const inner = fakeFetch(calls);
  let t = 5e12; // far from the real time: only the clock given to the hunt counts
  const slow = async (url) => {
    if (new URL(url).hostname === 'graph.test') t += 30; // every Meta request takes 30 ms of that clock
    return inner(url);
  };
  const { stats } = await hunt(Object.assign({}, base, { deadline: t + 40 }), { fetch: slow, now: NOW, clock: () => t, log: () => {} });
  assert.strictEqual(stats.stoppedEarly, true);
  assert.strictEqual(calls.filter((u) => u.searchParams.get('search_terms')).length, 2, 'two pages, then half the time is gone');
  assert.ok(!calls.some((u) => u.searchParams.get('search_page_ids')), 'and no time left to count');
  assert.ok(!calls.some((u) => u.pathname === '/meta.json'), 'or to wait for stores (a 429 can mean minutes): they stay unknown');
  // the same batch with time enough
  t = 5e12;
  const all = await hunt(Object.assign({}, base, { deadline: t + 60000 }), { fetch: slow, now: NOW, clock: () => t, log: () => {} });
  assert.strictEqual(all.stats.stoppedEarly, false);
  assert.strictEqual(all.results[0].id, '1');
});

test('markets and emoji-safe cutting', () => {
  assert.deepStrictEqual(marketsOf({ age_country_gender_reach_breakdown: [
    { country: 'BE', age_gender_breakdowns: [{ male: 100, female: 200 }] },
    { country: 'NL', age_gender_breakdowns: [{ male: 300, female: 350, unknown: 50 }] },
  ] }), [['NL', 70], ['BE', 30]]);
  assert.strictEqual(cut('x'.repeat(59) + '👗 dress', 60), 'x'.repeat(59) + '👗');
});

test('checkTokens: debug_token expiry, never-expiring, invalid (190), and a failed check; no token in the answer', async () => {
  const exp = Math.floor(NOW / 1000) + 3 * 86400;
  const calls = [];
  const meta = fakeFetch(calls, { debug: (tok) => ({
    'tok-soon': () => json({ data: { is_valid: true, expires_at: exp } }),
    'tok-never': () => json({ data: { is_valid: true, expires_at: 0 } }),
    'tok-dead': () => json({ error: { code: 190, message: 'Error validating access token: Session has expired' } }, 400),
    'tok-flaky': () => json({ error: { code: 2, message: 'Service unavailable for tok-flaky' } }, 500),
  })[tok]() });
  const out = await checkTokens(['tok-soon', 'tok-never', 'tok-dead', 'tok-flaky'], { fetch: meta, base: 'https://graph.test' });
  assert.deepStrictEqual(out.slice(0, 3), [{ n: 1, valid: true, expiresAt: exp * 1000 }, { n: 2, valid: true, expiresAt: 0 }, { n: 3, valid: false, expiresAt: null }]);
  assert.strictEqual(out[3].n, 4);
  assert.match(out[3].error, /Meta API error 2/);
  assert.ok(!JSON.stringify(out).includes('tok-'), 'no token in the result');
  assert.ok(calls.every((u) => u.pathname === '/v21.0/debug_token'));
  const down = await checkTokens(['x'], { fetch: async () => { throw new Error('network down'); } });
  assert.deepStrictEqual(down, [{ n: 1, error: 'network down' }]);
});

test("a store's search always answers: a product about something else is not the ad's product, and two products never merge", async () => {
  // Anna Boutique sells the dress only; its search answers the dress for the coat too, as a real store does.
  const ads = [fakeAd('1', '501', 'Anna Boutique', 'anna-boutique.shop', 'Linen Summer Dress', 14, 154000), fakeAd('8', '501', 'Anna Boutique', 'anna-boutique.shop', 'Wool Winter Coat', 10, 90000)];
  const calls = [];
  const { results, stats } = await hunt(base, Object.assign({ fetch: fakeFetch(calls, { byKeyword: () => ads }) }, quiet));
  const coatSearch = calls.find((u) => u.pathname === '/search/suggest.json' && /coat/i.test(u.searchParams.get('q')));
  assert.ok(coatSearch, 'the store was asked about the coat');
  assert.deepStrictEqual(results.map((r) => [r.id, r.product_title, r.product_url]), [
    ['1', 'Linen Summer Dress', 'https://anna-boutique.shop/products/linen-dress'],
    ['8', 'Wool Winter Coat', 'https://anna-boutique.shop/'],
  ], 'the coat keeps its own name and no price or photo of the dress; both products stay');
  assert.strictEqual(results[1].price, null);
  assert.strictEqual(results[1].image_url, '');
  assert.strictEqual(stats.products, 1, 'only the dress was a real find');
});

test('a store that does not answer (429, 403, 5xx, timeout) is unknown, never "not Shopify": www. is tried, its ads wait', async () => {
  const down = (answer) => {
    const asked = [];
    const inner = fakeFetch([]);
    const f = async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/meta.json' && u.hostname.endsWith('anna-boutique.shop')) {
        asked.push(u.hostname);
        return answer(init);
      }
      return inner(url, init);
    };
    return { asked, f };
  };
  const hang = (init) => new Promise((ok, no) => init.signal.addEventListener('abort', () => no(init.signal.reason)));
  for (const [what, answer, both] of [['503', () => new Response('busy', { status: 503 }), true], ['403', () => new Response('bot wall', { status: 403 }), true],
    ['timeout', hang, true], ['429', () => new Response('slow down', { status: 429 }), false]]) {
    resetCooling();
    const { asked, f } = down(answer);
    const { results, rechecks, stats } = await hunt(base, { fetch: f, now: NOW, log: () => {}, storeOpts: { timeout: 5, coolMs: 1 } });
    assert.deepStrictEqual(results, [], `${what}: nothing saved while unknown`);
    assert.ok(!rechecks.some((r) => r.advertiser_page_id === '501'), `${what}: nothing written down as failing either`);
    assert.strictEqual(stats.storesUnknown, 1, what);
    assert.strictEqual(stats.unsure, 2, `${what}: ads 1 and 2 pass every other rule`);
    assert.strictEqual(stats.shopify, 2, `${what}: the other stores are still checked`);
    if (both) assert.deepStrictEqual([...new Set(asked)], ['anna-boutique.shop', 'www.anna-boutique.shop'], `${what}: www. tried too`);
    else assert.ok(asked.length >= 2 && asked.every((h) => h === 'anna-boutique.shop'), '429: waited and asked again, then left for next run');
  }
  resetCooling();
  // A store that only answers on www.: found, and its products are looked up there.
  const calls = [];
  const inner = fakeFetch(calls);
  const wwwOnly = async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'anna-boutique.shop') throw new TypeError('fetch failed');
    return inner(url, init);
  };
  const { results } = await hunt(base, { fetch: wwwOnly, now: NOW, log: () => {} });
  assert.strictEqual(results[0].id, '1');
  assert.strictEqual(results[0].product_url, 'https://www.anna-boutique.shop/products/linen-dress');
  assert.strictEqual(results[0].store_url, 'https://www.anna-boutique.shop/');
});

test('Meta searches and counts that fail are counted for run.mjs, not only logged', async () => {
  const inner = fakeFetch([]);
  const f = async (url, init) => {
    const u = new URL(url);
    if (u.searchParams.get('search_page_ids')) return json({ error: { code: 100, message: 'Invalid parameter' } }, 400);
    if (u.searchParams.get('search_terms') && u.searchParams.get('ad_delivery_date_max') !== new Date(NOW - 7 * 864e5).toISOString().slice(0, 10)) return json({ error: { code: 100, message: 'Invalid parameter' } }, 400);
    return inner(url, init);
  };
  const { results, stats } = await hunt(base, { fetch: f, now: NOW, log: () => {} });
  assert.deepStrictEqual(results, [], 'no count: nothing can pass 75+ active ads');
  assert.deepStrictEqual([stats.searchFails, stats.countFails, stats.counted, stats.toCount, stats.skipped], [2, 1, 0, 1, 3]);
});

test('a rate limit Meta also marks is_transient is waited out, not hammered with smaller pages', async () => {
  const inner = fakeFetch([]);
  const limits = [];
  let first = true;
  const f = async (url, init) => {
    const u = new URL(url);
    if (u.searchParams.get('search_terms')) limits.push(u.searchParams.get('limit'));
    if (u.hostname === 'graph.test' && first) {
      first = false;
      return json({ error: { code: 613, is_transient: true, message: 'Calls to this api have exceeded the rate limit.' } }, 400);
    }
    return inner(url, init);
  };
  const msgs = [];
  const { results, stats } = await hunt(base, { fetch: f, now: NOW, log: (m) => msgs.push(m), waitScale: 0 });
  assert.strictEqual(stats.waits, 1);
  assert.strictEqual(stats.retries, 0, 'not the quick retry for temporary errors');
  assert.deepStrictEqual([...new Set(limits.slice(0, 2))], ['250'], 'the same page size after the wait');
  assert.match(msgs.join('\n'), /Meta API limit \(613\): waiting/);
  assert.strictEqual(results[0].id, '1');
});

test('off the EU board: cosmetics, perfume, medical claims, pet health, supplements are never counted or saved', async () => {
  const stores = { 'glow.shop': { meta: { myshopify_domain: 'glow.myshopify.com', currency: 'EUR', published_products_count: 40 },
    products: { 'vitamin c face serum': { title: 'Vitamin C Face Serum', price: '29.95', url: '/products/serum' }, 'oud intense': { title: 'Oud Intense', type: 'Perfume', price: '59', url: '/products/oud' }, 'cosy throw': { title: 'Cosy Throw', price: '39', url: '/products/throw' } } } };
  const ads = [fakeAd('20', '601', 'Glow', 'glow.shop', 'Vitamin C Face Serum', 12, 90000), fakeAd('21', '601', 'Glow', 'glow.shop', 'Oud Intense', 12, 90000),
    fakeAd('22', '602', 'Pain Away', 'glow.shop', 'Back Pain Relief Belt', 12, 90000), fakeAd('23', '603', 'Glow Home', 'glow.shop', 'Cosy Throw', 12, 90000)];
  const calls = [];
  const { results, stats } = await hunt(base, Object.assign({ fetch: fakeFetch(calls, { byKeyword: () => ads, stores, counts: { 601: 200, 602: 200, 603: 200 } }) }, quiet));
  assert.deepStrictEqual(results.map((r) => r.id), ['23'], 'only the throw');
  assert.strictEqual(stats.restricted, 3);
  assert.deepStrictEqual(countedIn(calls), ['603'], 'no Meta requests for products that can never be on the board');
});

test('an advertiser with more ads than the count reads is "500+", and the record says so', async () => {
  const { results } = await hunt(base, Object.assign({ fetch: fakeFetch([], { counts: { 501: 900 } }) }, quiet));
  assert.strictEqual(results[0].active_ads, 500);
  assert.strictEqual(results[0].active_ads_capped, true);
  assert.match(results[0].checklist.find((c) => c.key === 'ads').text, /^500 active ads \(500\+ counted\)/);
});

test('ads at Shopify stores that fail a rule come back as rechecks, with what is true now', async () => {
  const ads = [fakeAd('1', '501', 'Anna Boutique', 'anna-boutique.shop', 'Linen Summer Dress', 14, 154000), fakeAd('9', '501', 'Anna Boutique', 'anna-boutique.shop', 'Linen Summer Dress', 30, 9000),
    fakeAd('6', '505', 'Tiny Shop', 'tinyshop.store', 'Mug', 12, 800), fakeAd('5', '504', 'Real Brand', 'realbrand.test', 'Shirt', 10, 900000)];
  const { results, rechecks } = await hunt(base, Object.assign({ fetch: fakeFetch([], { byKeyword: () => ads }) }, quiet));
  assert.deepStrictEqual(results.map((r) => r.id), ['1']);
  const by = Object.fromEntries(rechecks.map((r) => [r.id, r]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['6', '9'], 'not Real Brand: not a Shopify store, so it was never a winner');
  assert.strictEqual(by['9'].verdict, 'skip');
  assert.deepStrictEqual([by['9'].active_ads, by['9'].ad_age_days, by['9'].reach_eu], [134, 30, 9000], '300 a day: below 500 now');
  assert.strictEqual(by['6'].active_ads, null, 'Tiny Shop fails on reach, so it was never counted');
});

test('metaTokens: whitespace out once, each with its own secret; tokenState: one token per secret, merged', () => {
  assert.deepStrictEqual(metaTokens({ META_TOKEN: '  EAAB tok\n', META_TOKEN_3: 'three\r\n', META_TOKEN_2: ' ' }), [{ secret: 'META_TOKEN', token: 'EAABtok' }, { secret: 'META_TOKEN_3', token: 'three' }]);
  const day = 864e5;
  const iso = (ms) => new Date(ms).toISOString();
  // the EU run: two tokens, the second expires soon
  const eu = tokenState(null, [{ secret: 'META_TOKEN', valid: true, expiresAt: 0 }, { secret: 'META_TOKEN_2', valid: true, expiresAt: NOW + 3 * day }], { now: NOW });
  assert.deepStrictEqual(eu, { at: iso(NOW + 3 * day), valid: true, checked_at: iso(NOW), tokens: [
    { n: 1, secret: 'META_TOKEN', valid: true, expires_at: 'never', checked_at: iso(NOW) }, { n: 2, secret: 'META_TOKEN_2', valid: true, expires_at: iso(NOW + 3 * day), checked_at: iso(NOW) }] });
  // the world run after it: only META_TOKEN, the answer for _2 stays
  const world = tokenState(JSON.stringify(eu), [{ secret: 'META_TOKEN', valid: true, expiresAt: NOW + 50 * day }], { now: NOW + day });
  assert.strictEqual(world.at, iso(NOW + 3 * day), 'the soonest is still META_TOKEN_2');
  assert.deepStrictEqual(world.tokens.map((k) => [k.secret, k.expires_at, k.checked_at]), [['META_TOKEN', iso(NOW + 50 * day), iso(NOW + day)], ['META_TOKEN_2', iso(NOW + 3 * day), iso(NOW)]]);
  // an invalid one makes the whole state invalid; dropped secrets go; a state from before (only numbers) is read by number
  assert.strictEqual(tokenState(eu, [{ secret: 'META_TOKEN_2', valid: false }], { now: NOW }).valid, false);
  assert.deepStrictEqual(tokenState(eu, [], { now: NOW, drop: (s) => s !== 'META_TOKEN' }).tokens.map((k) => k.secret), ['META_TOKEN']);
  const old = { at: null, valid: true, tokens: [{ n: 1, valid: true, expires_at: 'never' }, { n: 3, valid: false, expires_at: null }] };
  assert.deepStrictEqual(tokenState(old, [{ secret: 'META_TOKEN', valid: true, expiresAt: 0 }], { now: NOW }).tokens.map((k) => [k.secret, k.valid]), [['META_TOKEN', true], ['META_TOKEN_3', false]]);
  assert.deepStrictEqual(tokenState('not json', [{ secret: 'META_TOKEN', error: 'down' }], { now: NOW }), { at: null, valid: true, checked_at: iso(NOW), tokens: [] }, 'a failed check is no answer');
});

test('the fake Meta API writes down a request the hunt should never send (an assert thrown inside fetch would be swallowed)', async () => {
  const f = fakeFetch([]);
  const res = await f('https://graph.test/v24.0/ads_archive?search_terms=dress&limit=10&access_token=t'); // no ACTIVE filter, no age window
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(violations.splice(0).map((v) => v.split(':')[0]), ['not only active ads', 'no age window']);
  // and it pages like Meta: at most limit, an after cursor to go on
  const page = await (await f('https://graph.test/v24.0/ads_archive?search_page_ids=%5B%22501%22%5D&ad_active_status=ACTIVE&limit=50&access_token=t')).json();
  assert.strictEqual(page.data.length, 50);
  const next = await (await f(page.paging.next)).json();
  assert.deepStrictEqual([next.data[0].id, next.data.length], ['501-50', 50]);
  const last = await (await f(next.paging.next)).json();
  assert.deepStrictEqual([last.data.length, last.paging], [34, undefined], '134 in all');
});
