// lib/meta.mjs (one batch of the hunt) against a fake Meta API and fake Shopify stores.
import test from 'node:test';
import assert from 'node:assert';
import { hunt, marketsOf, cut, checkTokens } from '../lib/meta.mjs';

import { NOW, fakeFetch, usageHdr, blocked613, json, base } from './helpers/fake-meta.mjs';

const quiet = { now: NOW, log: () => {} };

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
  // only advertisers whose ad passes every other rule are counted (Meta requests): Anna Boutique only
  const counted = calls.filter((u) => u.searchParams.get('search_page_ids')).map((u) => JSON.parse(u.searchParams.get('search_page_ids'))[0]).sort();
  assert.deepStrictEqual(counted, ['501']);
  assert.ok(!calls.some((u) => u.hostname === 'amazon.de'));
});

test('competitor counts are remembered for 24 hours (cache shared between batches)', async () => {
  const calls = [];
  const counted = () => calls.filter((u) => u.searchParams.get('search_page_ids')).length;
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

test('near the deadline it stops searching and counting and returns what it found', async () => {
  const calls = [];
  const inner = fakeFetch(calls);
  const slow = async (url) => (new URL(url).hostname === 'graph.test' ? new Promise((r) => setTimeout(r, 30)).then(() => inner(url)) : inner(url));
  const { stats } = await hunt(Object.assign({}, base, { deadline: Date.now() + 40 }), { fetch: slow, now: NOW, log: () => {} });
  assert.strictEqual(stats.stoppedEarly, true);
  assert.ok(!calls.some((u) => u.searchParams.get('search_page_ids')));
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

test('outside the EU: no reach rule, where the ad aims is kept, records are marked world', async () => {
  const calls = [];
  const d = (n) => new Date(NOW - n * 864e5).toISOString().slice(0, 10);
  const list = [
    // Anna Boutique (134 active ads) without any EU reach: passes outside the EU
    { id: '11', page_id: '501', page_name: 'Anna Boutique', ad_creative_link_captions: ['anna-boutique.shop'], ad_creative_link_titles: ['Linen Summer Dress'], ad_creative_bodies: ['x'],
      ad_delivery_start_time: d(14), publisher_platforms: ['facebook'],
      target_locations: [{ name: 'Worldwide', type: 'country_groups', excluded: false }, { name: 'France', type: 'countries', excluded: true }] },
    // Tiny Shop: 12 active ads, still out
    { id: '12', page_id: '505', page_name: 'Tiny Shop', ad_creative_link_captions: ['tinyshop.store'], ad_creative_link_titles: ['Mug'], ad_creative_bodies: ['x'],
      ad_delivery_start_time: d(12), target_locations: [{ name: 'New Zealand', type: 'countries', excluded: false }] },
  ];
  const { results } = await hunt(Object.assign({}, base, { countries: ['US', 'NZ'] }), Object.assign({ fetch: fakeFetch(calls, { byKeyword: () => list }) }, quiet));
  assert.deepStrictEqual(results.map((r) => [r.id, r.world, r.targets, r.active_ads, r.reach_eu, r.market]), [['11', 1, 'Worldwide', 134, null, 'US,NZ']]);
  assert.deepStrictEqual(results[0].checklist.map((c) => c.key), ['shopify', 'ads', 'age'], 'no reach rule');
  const search = calls.find((u) => u.searchParams.get('search_terms'));
  assert.match(search.searchParams.get('fields'), /,target_locations$/);
  assert.strictEqual(search.searchParams.get('ad_reached_countries'), '["US","NZ"]');
  // an EU hunt still needs reach and does not mark its records
  const eu = await hunt(base, Object.assign({ fetch: fakeFetch([]) }, quiet));
  assert.deepStrictEqual([eu.results[0].world, eu.results[0].targets, eu.results[0].checklist.length], [0, '', 4]);
});
