// lib/google-ads.mjs and google.mjs: Google's ad library through the Scrape Creators API, on fixtures (test/fixtures/google:
// the vendor's documented example answers, and SAMPLE DATA made up for the hunt). No real request: the fetch is a fake.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { googleClient, googleRules, parseCompanyAds, parseAdDetails, parseAdvertiserSearch, euImpressions, boundsOf, destinationOf, domainOf, timeOf, int,
  advertiserUrl, creativeUrl, domainUrl, idsOfUrl, byProduct, bestOf, howMany, cursorOf, GoogleApiError, RUNNING_DAYS, COST } from '../lib/google-ads.mjs';
import { hunt, creditsOf, targetsOf, regionsOf, lines, mark, MAX_CREDITS } from '../google.mjs';
import { googleFetch, sampleData, SAMPLE_KEY, VENDOR } from './helpers/fake-google.mjs';
import { d1Client, migrate, statements } from '../lib/d1.mjs';
import { d1Rest, memoryDb } from './helpers/sqlite-d1.mjs';
import { productKey } from '../lib/bestsellers.mjs';
import { productKey as boardKey } from '../worker/src/app.mjs';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';

const NOW = Date.UTC(2026, 10, 1, 12);
const DAY = 864e5;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const noSleep = async () => {};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
test("the vendor's documented answers parse: company ads, ad details and advertiser search", () => {
  const list = parseCompanyAds(VENDOR.ads);
  assert.strictEqual(list.ads.length, 15);
  assert.strictEqual(list.estimate, 20000);
  assert.match(list.cursor, /^CgoAP7zm/);
  assert.deepStrictEqual(list.ads[0], { advertiserId: 'AR01614014350098432001', creativeId: 'CR08567627846124568577', advertiser: 'lululemon athletica canada inc.', format: 'image',
    image: '', firstShown: Date.parse('2026-03-11T17:08:22.000Z'), lastShown: Date.parse('2026-05-04T17:59:12.000Z') });
  assert.strictEqual(list.ads[1].image, 'https://tpc.googlesyndication.com/archive/simgad/7468813441689462696');

  const ad = parseAdDetails(VENDOR.ad);
  assert.strictEqual(ad.creativeId, 'CR17778900238552006657');
  assert.strictEqual(ad.format, 'image');
  assert.deepStrictEqual(ad.impressions, { lower: 500000, upper: 600000 }, 'overallImpressions: min and max as text');
  assert.deepStrictEqual(ad.regions, ['US']);
  assert.deepStrictEqual(ad.regionStats.map((r) => [r.cc, r.impressions]), [['US', { lower: 500000, upper: 600000 }]]);
  assert.deepStrictEqual(ad.variations[0].destination, { domain: 'shop.gop.com', url: 'https://shop.gop.com', key: '' }, 'a shown domain, no product page');
  assert.match(ad.variations[0].headline, /^Classic GOP Quarter/);
  assert.strictEqual(euImpressions(ad.regionStats), null, 'no EU country: no EU figure');
  assert.ok(!('spend' in ad) && !('targeting' in ad), 'political-only fields are not kept: no rule uses them');

  const s = parseAdvertiserSearch(VENDOR.search);
  assert.deepStrictEqual(s.advertisers.map((a) => [a.id, a.region, a.estimate]), [['AR01382517811867287553', 'HK', 5], ['AR01614014350098432001', 'CA', 7000],
    ['AR12317441102226391041', 'AU', 4], ['AR12957738211148300289', 'JP', 5]]);
  assert.deepStrictEqual(s.domains, ['lululemon.de', 'lululemon.com', 'lululemon.co.uk', 'lululemon.co.kr', 'lululemon.co.jp', 'lululemonss.com', 'lululemon.com.hk', 'lululemon.com.au']);
});

test('odd answers are read defensively: text numbers, nulls, missing lists, bad ids, odd dates; nothing throws, nothing passes by accident', () => {
  for (const bad of [null, undefined, 'x', 42, [], { ads: 'nope' }, { ads: [null, 7, 'x', {}] }]) assert.deepStrictEqual(parseCompanyAds(bad).ads, [], JSON.stringify(bad));
  assert.strictEqual(parseCompanyAds({ ads: [], number_of_ads_estimate: '1,200' }).estimate, 1200);
  assert.strictEqual(parseCompanyAds({ ads: [], number_of_ads_estimate: 'many' }).estimate, null);
  assert.strictEqual(parseCompanyAds({ ads: [], cursor: '' }).cursor, null, 'an empty cursor: the last page');
  // ids from the link when the fields are missing; a foreign id format is no ad
  const fromUrl = parseCompanyAds({ ads: [{ adUrl: 'https://adstransparency.google.com/advertiser/AR123456/creative/CR654321', format: 'VIDEO' }] }).ads[0];
  assert.deepStrictEqual([fromUrl.advertiserId, fromUrl.creativeId, fromUrl.format], ['AR123456', 'CR654321', 'video']);
  assert.deepStrictEqual(parseCompanyAds({ ads: [{ advertiserId: 'XX1', creativeId: 'CR1' }] }).ads, []);
  // the same ad twice on a page is one ad
  assert.strictEqual(parseCompanyAds({ ads: [VENDOR.ads.ads[0], VENDOR.ads.ads[0]] }).ads.length, 1);
  // an image link that is not https is left out
  assert.strictEqual(parseCompanyAds({ ads: [{ ...VENDOR.ads.ads[0], imageUrl: 'javascript:alert(1)' }] }).ads[0].image, '');
  assert.strictEqual(parseAdDetails(null), null);
  assert.strictEqual(parseAdDetails({ url: 'https://example.com' }), null, 'no ids: no ad');
  const sparse = parseAdDetails({ url: VENDOR.ad.url, firstShown: null, overallImpressions: { min: null, max: null }, regionStats: 'x', creativeRegions: [{ regionCode: 'nl' }, 'DE', null], variations: [null, {}] });
  assert.deepStrictEqual([sparse.firstShown, sparse.impressions, sparse.regions, sparse.variations.length], [null, null, ['NL', 'DE'], 1]);
  assert.strictEqual(sparse.variations[0].destination, null);
  assert.deepStrictEqual(boundsOf({ lower: '10', upper: '5' }), { lower: 10, upper: null }, 'an upper below the lower is no upper');
  assert.deepStrictEqual(boundsOf({ min: '7', max: null }), { lower: 7, upper: null }, 'open-ended');
  assert.strictEqual(int('-5'), null);
  assert.strictEqual(timeOf('1793500000'), 1793500000000, 'seconds');
  assert.strictEqual(timeOf('1793500000000'), 1793500000000, 'ms');
  assert.strictEqual(timeOf('yesterday'), null);
  assert.deepStrictEqual(parseAdvertiserSearch({ advertisers: [{ advertiser_id: 'AR1234567', number_of_ads_estimate: '80' }, { advertiser_id: 'AR1234567' }], websites: ['Shop.Example', { domain: 'https://www.Shop.example/x' }, { domain: 'not a domain' }] }),
    { advertisers: [{ id: 'AR1234567', name: '', region: '', estimate: 80 }], domains: ['shop.example'] });
  // EU impressions: the EU countries added up; one open-ended range makes the sum open-ended
  assert.deepStrictEqual(euImpressions([{ cc: 'NL', impressions: { lower: 10, upper: 20 } }, { cc: 'DE', impressions: { lower: 5, upper: 6 } }, { cc: 'US', impressions: { lower: 1000, upper: 2000 } }]),
    { lower: 15, upper: 26, regions: ['NL', 'DE'] });
  assert.strictEqual(euImpressions([{ cc: 'NL', impressions: { lower: 10, upper: null } }]).upper, null);
});

test('where an ad sends people: the shown domain, or the product page in the board\'s own key', () => {
  assert.deepStrictEqual(destinationOf('shop.store.com'), { domain: 'shop.store.com', url: 'https://shop.store.com', key: '' });
  const d = destinationOf('https://www.Glow.example/nl/products/Sunset-Lamp?utm_source=google#x');
  assert.strictEqual(d.domain, 'glow.example');
  assert.strictEqual(d.key, 'glow.example/products/sunset-lamp');
  assert.strictEqual(d.key, productKey(d.url), 'the same key as the store signals');
  assert.strictEqual(d.key, boardKey(d.url), 'and as the board');
  assert.strictEqual(destinationOf('glow.example/products/lamp').key, 'glow.example/products/lamp', 'no scheme');
  assert.strictEqual(destinationOf(''), null);
  assert.strictEqual(destinationOf('not a shop'), null);
  assert.strictEqual(domainOf('WWW.Store.COM'), 'store.com');
  assert.strictEqual(domainOf('javascript:alert(1)'), '');
});

test('links on the board are made here from checked ids, never taken from an answer', () => {
  assert.strictEqual(advertiserUrl('AR10000000000000000001'), 'https://adstransparency.google.com/advertiser/AR10000000000000000001');
  assert.strictEqual(advertiserUrl('AR10000000000000000001', 'nl'), 'https://adstransparency.google.com/advertiser/AR10000000000000000001?region=NL');
  assert.strictEqual(creativeUrl('AR123456', 'CR654321'), 'https://adstransparency.google.com/advertiser/AR123456/creative/CR654321');
  assert.strictEqual(advertiserUrl('AR1"><script>'), '');
  assert.strictEqual(creativeUrl('AR123456', 'javascript:x'), '');
  assert.strictEqual(domainUrl('Shop.Example'), 'https://adstransparency.google.com/?domain=shop.example');
  assert.deepStrictEqual(idsOfUrl('https://evil.test/advertiser/AR123456/creative/CR654321'), { advertiserId: 'AR123456', creativeId: 'CR654321' }, 'only the ids are read; the link is made again');
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------
test('the client: x-api-key header, parameters as documented, credits counted from each answer, the vendor\'s cache asked for', async () => {
  const calls = [];
  const seen = [];
  const doFetch = googleFetch(calls, { now: NOW, answer: (u, init) => { seen.push(init.headers); return null; } });
  const api = googleClient({ key: SAMPLE_KEY, fetch: doFetch, cap: 10, sleep: noSleep });
  const s = await api.searchAdvertisers('posture', 'nl');
  assert.deepStrictEqual(s.advertisers.map((a) => a.id), ['AR10000000000000000001', 'AR10000000000000000002']);
  const page = await api.companyAds({ advertiserId: 'AR10000000000000000001', startDate: '2026-10-30', endDate: '2026-11-01' });
  assert.strictEqual(page.estimate, 180);
  const next = await api.companyAds({ advertiserId: 'AR10000000000000000001', cursor: page.cursor });
  assert.deepStrictEqual(next.ads.map((a) => a.creativeId), ['CR10000000000000000105']);
  const ad = await api.adDetails('https://adstransparency.google.com/advertiser/AR10000000000000000001/creative/CR10000000000000000101');
  assert.strictEqual(ad.variations[0].destination.key, 'posturepro-sample.example/products/posture-corrector-pro');
  assert.deepStrictEqual(calls.map((u) => u.pathname), ['/v1/google/adLibrary/advertisers/search', '/v1/google/company/ads', '/v1/google/company/ads', '/v1/google/ad']);
  assert.deepStrictEqual(Object.fromEntries(calls[0].searchParams), { query: 'posture', region: 'NL' });
  assert.deepStrictEqual(Object.fromEntries(calls[1].searchParams), { advertiser_id: 'AR10000000000000000001', topic: 'all', start_date: '2026-10-30', end_date: '2026-11-01' });
  assert.strictEqual(calls[2].searchParams.get('cursor'), 'sample-page-2');
  assert.strictEqual(calls[3].searchParams.get('cache_max_age'), '7d', 'a cached copy costs nothing');
  assert.strictEqual(calls[3].searchParams.get('url'), 'https://adstransparency.google.com/advertiser/AR10000000000000000001/creative/CR10000000000000000101');
  assert.ok(!calls.some((u) => u.searchParams.has('get_ad_details')), 'never the 25-credit detail list');
  assert.ok(seen.every((h) => h['x-api-key'] === SAMPLE_KEY), 'the key in the header, never in the URL');
  assert.ok(calls.every((u) => !u.toString().includes(SAMPLE_KEY)));
  const st = api.stats();
  assert.deepStrictEqual([st.spent, st.ok, st.failed, st.remaining, st.by.search, st.by.ads, st.by.ad], [4, 4, 0, 996, 1, 2, 1]);
  assert.deepStrictEqual(COST, { search: 1, ads: 1, ad: 1 });
  await assert.rejects(api.companyAds({}), (e) => e instanceof GoogleApiError && e.kind === 'bad');
  assert.throws(() => googleClient({ key: '  ' }), /No API key: add the GitHub secret SCRAPECREATORS_API_KEY/);
});

test('the credit cap is hard: a call that could pass it is never sent, also when calls run at the same moment; a cached answer is counted as charged', async () => {
  const calls = [];
  const doFetch = googleFetch(calls, { now: NOW });
  const api = googleClient({ key: SAMPLE_KEY, fetch: doFetch, cap: 3, sleep: noSleep });
  const tries = await Promise.allSettled(Array.from({ length: 6 }, () => api.searchAdvertisers('posture', 'NL')));
  assert.strictEqual(tries.filter((r) => r.status === 'fulfilled').length, 3);
  assert.ok(tries.filter((r) => r.status === 'rejected').every((r) => r.reason.kind === 'cap' && r.reason.stop));
  assert.strictEqual(calls.length, 3, 'the other three were never sent');
  assert.strictEqual(api.stats().spent, 3);
  // The vendor's cache: credits_charged 0 is believed; an answer without it counts its listed price.
  const free = googleClient({ key: 'k', fetch: async () => json({ success: true, cached: true, credits_charged: 0, advertiserId: 'AR123456', creativeId: 'CR654321' }), cap: 1, sleep: noSleep });
  for (let i = 0; i < 3; i++) await free.adDetails('https://adstransparency.google.com/advertiser/AR123456/creative/CR654321');
  assert.deepStrictEqual([free.stats().spent, free.stats().cached], [0, 3]);
  const silent = googleClient({ key: 'k', fetch: async () => json({ success: true, advertisers: [] }), cap: 2, sleep: noSleep });
  await silent.searchAdvertisers('a');
  await silent.searchAdvertisers('b');
  await assert.rejects(silent.searchAdvertisers('c'), /Credit cap reached: 2 of 2 credits spent/);
});

test('errors: 401 and 402 stop the run, 404 is nothing found, 429 and 5xx are asked again twice; the key never shows', async () => {
  const KEY = 'sk_live_secret_123';
  const answering = (...answers) => {
    let i = 0;
    return async () => answers[Math.min(i++, answers.length - 1)]();
  };
  const make = (f) => googleClient({ key: KEY, fetch: f, cap: 50, sleep: noSleep });
  const e401 = await make(answering(() => json({ success: false, message: `bad key ${KEY}` }, 401))).searchAdvertisers('x').catch((e) => e);
  assert.deepStrictEqual([e401.kind, e401.stop, e401.status], ['key', true, 401]);
  assert.doesNotMatch(e401.message, /sk_live/);
  const e402 = await make(answering(() => json({ success: false }, 402))).searchAdvertisers('x').catch((e) => e);
  assert.deepStrictEqual([e402.kind, e402.stop], ['credits', true]);
  assert.match(e402.message, /no credits left/);
  const api404 = make(answering(() => json({ success: false, error: 'not_found' }, 404)));
  assert.strictEqual(await api404.adDetails('https://adstransparency.google.com/advertiser/AR123456/creative/CR654321'), null);
  assert.strictEqual(api404.stats().spent, 0, 'a 404 is not charged');
  let n = 0;
  const flaky = make(async () => (++n < 3 ? json({ message: 'busy' }, 503) : json({ success: true, advertisers: [{ advertiser_id: 'AR1234567' }] })));
  assert.strictEqual((await flaky.searchAdvertisers('x')).advertisers.length, 1, 'the third try answers');
  const down = make(answering(() => json({ message: `boom ${KEY}` }, 500)));
  const e500 = await down.searchAdvertisers('x').catch((e) => e);
  assert.deepStrictEqual([e500.kind, e500.stop], ['server', false]);
  assert.doesNotMatch(e500.message, /sk_live/);
  const net = make(async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); });
  const eNet = await net.searchAdvertisers('x').catch((e) => e);
  assert.strictEqual(eNet.kind, 'network');
  assert.doesNotMatch(eNet.message, /sk_live/);
  const html = await make(async () => new Response('<html>', { status: 200 })).searchAdvertisers('x').catch((e) => e);
  assert.strictEqual(html.kind, 'format');
  assert.deepStrictEqual(await make(async () => json({ success: false, credits_charged: 1 })).searchAdvertisers('x'), { advertisers: [], domains: [] }, 'success false: nothing to read');
});

// ---------------------------------------------------------------------------
// The rules, one at a time: exact, approximated, unknown
// ---------------------------------------------------------------------------
const shop = { key: 'shop.example', shopify: 1, host: 'shop.example', myshopify: 'shop.myshopify.com' };
const many = { estimate: 180, windowDays: 3, listed: 40, complete: false };
const ad20 = { firstShown: NOW - 20 * DAY, lastShown: NOW - 0.3 * DAY };
const euOk = { eu: { lower: 700000, upper: 800000, regions: ['NL', 'DE'] }, all: null };
const rules = (o) => googleRules({ store: shop, ads: many, ad: ad20, impressions: euOk, ...o }, { now: NOW });
const item = (ev, key) => ev.items.find((i) => i.key === key);

test('rule 1, Shopify store: exact (the same store check as the Meta hunts); no answer is pending, never "not Shopify"', () => {
  assert.deepStrictEqual(item(rules({}), 'shopify'), { key: 'shopify', label: 'Shopify store', state: 'ok', how: 'exact', text: 'shop.myshopify.com' });
  assert.strictEqual(item(rules({ store: { key: 'shop.example', shopify: 0 } }), 'shopify').state, 'bad');
  assert.match(item(rules({ store: { key: 'amazon.de', shopify: 1 } }), 'shopify').text, /marketplace/);
  assert.strictEqual(item(rules({ store: null }), 'shopify').text, 'No shop website in this ad');
  const late = rules({ store: { key: 'shop.example', shopify: null } });
  assert.deepStrictEqual([item(late, 'shopify').state, late.verdict], ['pending', 'pending']);
});

test('rule 2, advertiser 75+ ads: approximated with Google\'s estimate of the ads shown in the last days; counted pages are a lower bound; no count is pending', () => {
  assert.deepStrictEqual(item(rules({}), 'ads'), { key: 'ads', label: 'Advertiser 75+ ads', state: 'ok', how: 'approx', text: '~180 ads shown in the last 3 days (Google\'s estimate, not a count of active ads)' });
  const few = item(rules({ ads: { estimate: 40, windowDays: 3, listed: 12 } }), 'ads');
  assert.deepStrictEqual([few.state, few.how], ['bad', 'approx']);
  assert.match(few.text, /needs 75\+/);
  assert.deepStrictEqual([item(rules({ ads: { estimate: null, listed: 80 } }), 'ads').state, item(rules({ ads: { estimate: null, listed: 80 } }), 'ads').text], ['ok', '80+ ads shown in the last 3 days (counted on the pages read)']);
  assert.strictEqual(item(rules({ ads: { estimate: null, listed: 30, complete: true } }), 'ads').state, 'bad');
  const none = rules({ ads: { estimate: null, listed: 30, complete: false } });
  assert.deepStrictEqual([item(none, 'ads').state, item(none, 'ads').how, none.verdict], ['unknown', 'none', 'pending'], 'not counted: not saved, asked again');
});

test('rule 3, ad live 7–42 days: exact from Google\'s first-shown date; an ad no longer shown fails; no date is pending', () => {
  assert.deepStrictEqual([item(rules({}), 'age').state, item(rules({}), 'age').how], ['ok', 'exact']);
  assert.match(item(rules({}), 'age').text, /^Live 20 days \(first shown 2026-10-12, last shown 2026-11-01\)$/);
  assert.strictEqual(rules({}).days, 20);
  for (const [first, ok] of [[6.9, false], [7, true], [42.9, true], [43, false]]) {
    assert.strictEqual(item(rules({ ad: { firstShown: NOW - first * DAY, lastShown: NOW } }), 'age').state, ok ? 'ok' : 'bad', `${first} days`);
  }
  const stopped = item(rules({ ad: { firstShown: NOW - 20 * DAY, lastShown: NOW - RUNNING_DAYS * DAY } }), 'age');
  assert.deepStrictEqual([stopped.state, stopped.how], ['bad', 'exact']);
  assert.match(stopped.text, /^Stopped: last shown 3 days ago/);
  assert.strictEqual(item(rules({ ad: { firstShown: NOW - 20 * DAY, lastShown: null } }), 'age').state, 'ok', 'no last date: the list asked for ads shown in the last days');
  const undated = rules({ ad: { firstShown: null, lastShown: NOW } });
  assert.deepStrictEqual([item(undated, 'age').state, item(undated, 'age').how, undated.verdict], ['unknown', 'none', 'pending']);
});

test('rule 4, 500+ EU reach a day: only Google\'s EU impression ranges can pass it (approximately); its total can only fail it; never a pass without an EU figure', () => {
  const eu = item(rules({}), 'reach');
  assert.deepStrictEqual([eu.state, eu.how], ['ok', 'approx']);
  assert.match(eu.text, /^35K\+ EU impressions a day \(Google's range 700K–800K over 20 days; impressions, not people\)$/);
  // A big total is no EU figure: not checked, also when the ad ran in the EU (the total is not split by country).
  const total = item(rules({ impressions: { eu: null, all: { lower: 50000, upper: 60000 } } }), 'reach');
  assert.deepStrictEqual([total.state, total.how], ['unknown', 'none']);
  assert.match(total.text, /^Google publishes no EU reach or impressions for this ad: not checked \(in total Google's range 50K–60K over 20 days, not split by country\)$/);
  // Shown in the US only (the vendor's documented ad): no EU reach to check, never a pass.
  const us = rules({ ad: { ...ad20, regions: ['US'] }, impressions: { eu: null, all: { lower: 500000, upper: 600000 } } });
  assert.deepStrictEqual([item(us, 'reach').state, item(us, 'reach').how, us.verdict], ['unknown', 'none', 'partial']);
  assert.match(item(us, 'reach').text, /^Shown outside the EU only \(US\): no EU reach to check/);
  const vendor = parseAdDetails(VENDOR.ad);
  const doc = googleRules({ store: shop, ads: many, ad: { firstShown: Date.parse('2026-06-10'), lastShown: Date.parse('2026-06-24'), regions: vendor.regions },
    impressions: { eu: euImpressions(vendor.regionStats), all: vendor.impressions } }, { now: Date.parse('2026-06-25') });
  assert.strictEqual(item(doc, 'reach').state, 'unknown', "the vendor's US-only ad with 500K–600K impressions does not pass an EU rule");
  // The total can fail it soundly: under 500 impressions a day in total is under 500 in the EU, and fewer people still.
  const tiny = item(rules({ impressions: { eu: null, all: { lower: 100, upper: 2000 } } }), 'reach');
  assert.deepStrictEqual([tiny.state, tiny.how], ['bad', 'approx']);
  assert.match(tiny.text, /^At most 100 impressions a day in total, so fewer in the EU \(needs 500\+/);
  const low = item(rules({ impressions: { eu: { lower: 100, upper: 900 }, all: { lower: 900000, upper: 1e6 } } }), 'reach');
  assert.deepStrictEqual([low.state, low.how], ['bad', 'approx'], 'the EU range comes first, also when the total is big');
  assert.match(low.text, /^At most 45 EU impressions a day \(needs 500\+/);
  const wide = rules({ impressions: { eu: { lower: 1000, upper: 100000 }, all: null } });
  assert.deepStrictEqual([item(wide, 'reach').state, item(wide, 'reach').how, wide.verdict], ['unknown', 'approx', 'partial'], 'a range too wide to tell is unknown, not a pass');
  const open = item(rules({ impressions: { eu: { lower: 100, upper: null }, all: null } }), 'reach');
  assert.strictEqual(open.state, 'unknown', 'an open-ended range below 500 a day cannot fail it either');
  const none = rules({ impressions: { eu: null, all: null } });
  assert.deepStrictEqual(item(none, 'reach'), { key: 'reach', label: '500+ EU reach a day', state: 'unknown', how: 'none', text: 'Google publishes no EU reach or impressions for this ad: not checked' });
  assert.strictEqual(none.verdict, 'partial', 'saved, marked as not checked');
});

test('the verdict and the marks: winner (4 of 4), partial (reach not checked), pending, skip; howMany counts exact / approx / unknown', () => {
  const all = rules({});
  assert.strictEqual(all.verdict, 'winner');
  assert.deepStrictEqual(all.items.map(mark).join(''), '✓≈✓≈');
  assert.deepStrictEqual(howMany(all.items), { exact: 2, approx: 2, unknown: 0 });
  const part = rules({ impressions: null });
  assert.deepStrictEqual([part.verdict, part.items.map(mark).join(''), howMany(part.items)], ['partial', '✓≈✓?', { exact: 2, approx: 1, unknown: 1 }]);
  const fail = rules({ ad: { firstShown: NOW - 50 * DAY, lastShown: NOW }, impressions: null });
  assert.deepStrictEqual([fail.verdict, fail.items.map(mark).join('')], ['skip', '✓≈✗?']);
  assert.match(fail.skip, /max 6 weeks/);
  assert.strictEqual(rules({ store: { key: 'x.example', shopify: null } }).items.map(mark).join(''), '…≈✓≈');
});

// ---------------------------------------------------------------------------
// One card per product page
// ---------------------------------------------------------------------------
test('one card per product page: ads with a locale, www, a query or another advertiser are one product; its best ad leads', () => {
  const urls = ['https://www.glow.example/nl/products/Sunset-Lamp?utm=1', 'glow.example/products/sunset-lamp', 'https://glow.example/products/sunset-lamp.json'];
  const ads = urls.map((u, i) => ({ productKey: destinationOf(u).key, ad: { creativeId: 'CR10' + i, firstShown: NOW - (10 + i) * DAY }, ev: rules({ impressions: i === 1 ? euOk : null }) }));
  ads.push({ productKey: '', ad: { creativeId: 'CR999' }, ev: rules({}) });
  const groups = byProduct(ads);
  assert.deepStrictEqual([...groups.keys()], ['glow.example/products/sunset-lamp'], 'no product page: left out');
  const best = bestOf(groups.get('glow.example/products/sunset-lamp'));
  assert.strictEqual(best.ad.creativeId, 'CR101', 'the one that passes all four');
  assert.strictEqual(bestOf([{ ad: { creativeId: 'a', firstShown: 2 }, ev: { verdict: 'partial' } }, { ad: { creativeId: 'b', firstShown: 1 }, ev: { verdict: 'partial' } }]).ad.creativeId, 'b', 'then the oldest');
  assert.strictEqual(bestOf([]), null);
});

// ---------------------------------------------------------------------------
// The hunt, on SAMPLE DATA and an in-memory D1
// ---------------------------------------------------------------------------
function setup() {
  const mem = memoryDb();
  const db = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(mem).doFetch, retryMs: 0 });
  // Shops already on the other tabs: one on the EU Meta board, one outside the EU.
  mem.prepare("INSERT INTO winners (ad_id, product_title, store_url, product_url, last_seen) VALUES ('7001', 'Glow Sunset Lamp', 'https://glowlamp-sample.example/', 'https://glowlamp-sample.example/products/sunset-lamp', ?)").run(new Date(NOW - DAY).toISOString());
  mem.prepare("INSERT INTO world_products (product_key, ad_id, active, store_url) VALUES ('quietshop-sample.example/products/quiet-fan', 'w7002', 1, 'https://quietshop-sample.example/')").run();
  return { mem, db };
}
function run({ db, calls = [], cap = 300, now = NOW, data, key = SAMPLE_KEY, ...o } = {}) {
  const doFetch = googleFetch(calls, { now, data });
  const api = googleClient({ key, fetch: doFetch, cap, sleep: noSleep });
  return hunt({ api, db, doFetch, now: () => now, keywords: ['posture', 'lamp'], regions: ['NL', 'DE'], log: () => {}, shopOpts: { tries: 1 }, ...o });
}
const products = (mem) => mem.prepare('SELECT * FROM google_products ORDER BY product_key').all().map((r) => ({ ...r }));

test('the hunt on SAMPLE DATA: the board\'s shops first, then the keywords; one row per product page; what fails a rule or is off the EU board is never saved', async () => {
  const { mem, db } = setup();
  const calls = [];
  const t = await run({ db, calls });
  assert.deepStrictEqual([t.health, t.stopped, t.dry_run], ['ok', 'done', false]);
  const rows = products(mem);
  assert.deepStrictEqual(rows.map((r) => [r.product_key, r.verdict, r.active]), [
    ['brightly-sample.example/products/sunset-projection-lamp', 'partial', 1],
    ['glowlamp-sample.example/products/sunset-lamp', 'partial', 1],
    ['posturepro-sample.example/products/posture-corrector-pro', 'winner', 1],
  ], 'the desk lamp (too few EU impressions), the gummies (a supplement), the tiny shop and the shop that is not Shopify are not there; the projection lamp ran in the US only: its EU reach is not checked');
  const posture = rows.find((r) => r.product_key.startsWith('posturepro'));
  assert.strictEqual(posture.ad_id, 'gCR10000000000000000101');
  assert.deepStrictEqual([posture.product_title, posture.price, posture.compare_at_price, posture.currency], ['Posture Corrector Pro', 39.95, 79.95, 'EUR']);
  assert.deepStrictEqual([posture.copies, posture.regions, posture.formats], [2, '["DE","NL"]', '["image","text"]'], 'a text ad that links to the home page found the same product through the store\'s search');
  assert.deepStrictEqual([posture.impr_scope, posture.impr_lower, posture.impr_upper, posture.ads_estimate, posture.ads_window, posture.days], ['eu', 700000, 800000, 180, 3, 20]);
  assert.deepStrictEqual([posture.advertiser_id, posture.creative_id, posture.keyword, posture.via, posture.store_products], ['AR10000000000000000001', 'CR10000000000000000101', 'posture', 'keyword', 38]);
  assert.strictEqual(posture.product_url, 'https://posturepro-sample.example/products/posture-corrector-pro');
  assert.deepStrictEqual(JSON.parse(posture.rules).map((i) => [i.key, i.state, i.how]), [['shopify', 'ok', 'exact'], ['ads', 'ok', 'approx'], ['age', 'ok', 'exact'], ['reach', 'ok', 'approx']]);
  const glow = rows.find((r) => r.product_key.startsWith('glowlamp'));
  assert.deepStrictEqual([glow.via, glow.impr_scope, glow.regions, glow.store_url], ['board', '', '["BE","NL"]', 'https://glowlamp-sample.example/']);
  assert.deepStrictEqual(JSON.parse(glow.rules).find((i) => i.key === 'reach'), { key: 'reach', label: '500+ EU reach a day', state: 'unknown', how: 'none', text: 'Google publishes no EU reach or impressions for this ad: not checked' });
  const lamp = rows.find((r) => r.product_key.startsWith('brightly'));
  assert.strictEqual(lamp.impr_scope, 'all');
  // What it spent: 4 searches, 6 lists of ads (one advertiser had two pages), 6 ads' details. Never the same ad twice.
  assert.deepStrictEqual([t.credits.spent, t.searches, t.pages, t.details, t.restricted, t.not_shopify, t.few_ads, t.gated], [17, 4, 7, 6, 1, 1, 1, 1]);
  const detailed = calls.filter((u) => u.pathname === '/v1/google/ad').map((u) => /CR\d+/.exec(u.searchParams.get('url'))[0]);
  assert.strictEqual(new Set(detailed).size, detailed.length, 'one ad, one payment');
  assert.ok(!detailed.includes('CR10000000000000000103') && !detailed.includes('CR10000000000000000104'), 'too young and too old: never paid for');
  assert.ok(!detailed.includes('CR10000000000000000302'), 'stopped 4 days ago: never paid for');
  assert.ok(!calls.some((u) => /amazon\.de|bigbrand-sample\.example/.test(u.toString()) && u.hostname === 'api.scrapecreators.com'), 'a marketplace and a shop that is not Shopify cost no credits');
  // The run's status for the board, the cursor, what was looked at.
  const state = (k) => JSON.parse(mem.prepare('SELECT value FROM state WHERE key = ?').get(k).value);
  assert.deepStrictEqual([state('google_run').status, state('google_run').health, state('google_run').products, state('google_cursor').next], ['done', 'ok', 3, 0], 'both keywords done: the cursor wrapped to the start');
  assert.ok(!('rows' in state('google_run')), 'the run\'s totals only');
  assert.ok(mem.prepare("SELECT 1 FROM state WHERE key = 'google_data'").get(), 'the board reads its tables again');
  assert.deepStrictEqual(mem.prepare('SELECT target, result FROM google_targets ORDER BY target').all().map((r) => [r.target, r.result]), [
    ['adv:AR10000000000000000001', 'products'], ['adv:AR10000000000000000003', 'products'], ['domain:bigbrand-sample.example', 'not shopify'], ['domain:brightly-sample.example', 'products'],
    ['domain:glowlamp-sample.example', 'products'], ['domain:posturepro-sample.example', 'products'], ['domain:quietshop-sample.example', 'fewer than 75 ads']]);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM google_ads').get().n, 6);
  assert.strictEqual(mem.prepare("SELECT shopify FROM google_stores WHERE store = 'bigbrand-sample.example'").get().shopify, 0);
  assert.match(lines(t.rows).join('\n'), /ALL 4 ✓≈✓≈ \(2 exact, 2 approx, 0 unknown\) · Posture Corrector Pro/);
  assert.match(lines(t.rows).join('\n'), /3 of 4 ✓≈✓\? \(2 exact, 1 approx, 1 unknown\) · Glow Sunset Lamp/);
});

test('the next run: advertisers and domains looked at in the last 3 days cost nothing; after that, ads already read come from D1, not paid again', async () => {
  const { mem, db } = setup();
  await run({ db });
  const again = await run({ db, now: NOW + 3600e3 });
  assert.deepStrictEqual([again.credits.spent, again.searches, again.targets, again.skipped_recent], [4, 4, 0, 7], 'only the searches');
  const later = await run({ db, now: NOW + 3.5 * DAY });
  assert.strictEqual(later.details, 0, 'every ad read within the week: from D1');
  assert.ok(later.cached >= 5);
  assert.strictEqual(later.credits.spent, 4 + 7, 'the searches and the lists of ads, no details');
  assert.strictEqual(products(mem).length, 3, 'the same three products, updated');
  assert.strictEqual(products(mem).find((r) => r.product_key.startsWith('posturepro')).first_seen, new Date(NOW).toISOString(), 'first seen stays');
});

test('the credit cap stops a run cleanly: what it found is saved, the keyword cursor stays, and the next run goes on without paying twice', async () => {
  const { mem, db } = setup();
  const first = await run({ db, cap: 8 });
  assert.strictEqual(first.stopped, 'cap');
  assert.strictEqual(first.health, 'ok', 'the cap is a plan, not a failure');
  assert.ok(first.credits.spent <= 8, `spent ${first.credits.spent}`);
  const state = (k) => JSON.parse(mem.prepare('SELECT value FROM state WHERE key = ?').get(k).value);
  assert.deepStrictEqual([state('google_run').stopped, state('google_run').credits.cap], ['cap', 8]);
  assert.strictEqual(mem.prepare("SELECT value FROM state WHERE key = 'google_cursor'").get(), undefined, '"posture" was not finished: no cursor yet');
  assert.ok(products(mem).some((r) => r.product_key.startsWith('glowlamp')), 'the board\'s shop was looked at first and saved');
  const second = await run({ db, now: NOW + 600e3 });
  assert.strictEqual(second.stopped, 'done');
  assert.deepStrictEqual(products(mem).map((r) => r.product_key), ['brightly-sample.example/products/sunset-projection-lamp', 'glowlamp-sample.example/products/sunset-lamp',
    'posturepro-sample.example/products/posture-corrector-pro']);
  assert.ok(second.skipped_recent >= 2, 'the shops done before the cap are not looked at again');
  // At most: one run's 17, "posture" searched again (2), and the lists of the advertisers that were on their way (3 at once, 2 pages).
  assert.ok(first.credits.spent + second.credits.spent <= 17 + 2 + 3 * 2, `two runs: ${first.credits.spent} + ${second.credits.spent}`);
});

test('dry run: everything but the D1 writes; the products come back to print. Without D1 at all (SAMPLE mode) it runs too', async () => {
  const { mem, db } = setup();
  const before = mem.prepare('SELECT COUNT(*) AS n FROM state').get().n;
  const t = await run({ db, dryRun: true });
  assert.strictEqual(t.dry_run, true);
  assert.strictEqual(t.rows.length, 3);
  assert.strictEqual(products(mem).length, 0);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM state').get().n, before, 'not even the run\'s status');
  for (const table of ['google_ads', 'google_targets', 'google_stores']) assert.strictEqual(mem.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
  const sample = await run({ db: null, sample: true });
  assert.deepStrictEqual([sample.sample, sample.dry_run, sample.rows.length], [true, true, 2], 'no D1: no shops from the other tabs, the two keyword products');
});

test('a saved product checked again that now fails a rule leaves the board; your decision on it stays', async () => {
  const { mem, db } = setup();
  await run({ db });
  const glow = () => products(mem).find((r) => r.product_key.startsWith('glowlamp'));
  mem.prepare("INSERT INTO hidden (ad_id, status, at) VALUES (?, 'seen', 'x')").run(glow().ad_id);
  const later = NOW + 8 * DAY; // its details are older than a week: read again
  const data = sampleData(later);
  data.ads.CR10000000000000000201.regionStats = [{ regionCode: 'NL', impressions: { lower: '10', upper: '20' } }];
  const t = await run({ db, now: later, data });
  assert.strictEqual(t.rechecked, 1);
  assert.deepStrictEqual([glow().active, glow().verdict], [0, 'skip']);
  assert.match(JSON.parse(glow().rules).find((i) => i.key === 'reach').text, /^At most/);
  assert.ok(mem.prepare("SELECT 1 FROM hidden WHERE ad_id = 'gCR10000000000000000201'").get(), 'the ✓ stays');
});

test('the API key refused: the run ends failed and says so, nothing saved', async () => {
  const { mem, db } = setup();
  const t = await run({ db, key: 'wrong-key' });
  assert.deepStrictEqual([t.health, t.stopped], ['failed', 'key']);
  assert.match(t.alert, /the API key was refused/);
  assert.strictEqual(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'google_run'").get().value).health, 'failed');
  assert.strictEqual(products(mem).length, 0);
  assert.strictEqual(t.searches, 0, 'no keyword searched after the refusal');
});

test('a store that does not answer is unknown, not "not Shopify": no credits spent on it, not saved as looked at, asked again next run', async () => {
  const { mem, db } = setup();
  const target = [{ kind: 'domain', value: 'glowlamp-sample.example' }];
  const doFetch = googleFetch([], { now: NOW, answer: (u) => (u.hostname === 'glowlamp-sample.example' ? new Response('', { status: 429 }) : null) });
  const api = googleClient({ key: SAMPLE_KEY, fetch: doFetch, cap: 50, sleep: noSleep });
  const t = await hunt({ api, db, doFetch, now: () => NOW, keywords: [], targets: target, boardDomains: 0, log: () => {}, shopOpts: { tries: 1 } });
  assert.strictEqual(t.health, 'warning');
  assert.match(t.alert, /did not answer: asked again next run/);
  assert.strictEqual(t.credits.spent, 0, 'its ads are not asked for before the store answers');
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM google_targets').get().n, 0);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM google_stores').get().n, 0);
  const next = await run({ db, now: NOW + 3600e3, keywords: [], targets: target, boardDomains: 0 });
  assert.strictEqual(next.health, 'ok');
  assert.ok(products(mem).some((r) => r.product_key.startsWith('glowlamp')));
});

test('the page cursor goes back as the vendor sent it: encoded once, never twice', async () => {
  const urls = [];
  const api = googleClient({ key: 'k', fetch: async (u) => { urls.push(String(u)); return json({ success: true, ads: [], cursor: null }); }, cap: 5, sleep: noSleep });
  await api.companyAds({ advertiserId: 'AR123456', cursor: VENDOR.ads.cursor });
  assert.match(VENDOR.ads.cursor, /%2F/, 'the vendor sends it percent-encoded');
  assert.ok(urls[0].includes('cursor=' + VENDOR.ads.cursor), urls[0]);
  assert.doesNotMatch(urls[0], /%25/, 'not encoded twice');
  await api.companyAds({ advertiserId: 'AR123456', cursor: 'ab/c+d=' });
  assert.strictEqual(new URL(urls[1]).searchParams.get('cursor'), 'ab/c+d=', 'a raw cursor arrives as it is');
  assert.strictEqual(cursorOf('%E0%A4%A'), '%E0%A4%A', 'one that does not decode: as it came');
});

test('the vendor down: 3 calls in a row fail, the run stops red and says why; the keyword cursor never moves past a failed search', async () => {
  const down = (u) => (u.hostname === 'api.scrapecreators.com' ? new Response('{"message":"down"}', { status: 500 }) : null);
  const shops = ['posturepro-sample.example', 'brightly-sample.example', 'glowlamp-sample.example'].map((value) => ({ kind: 'domain', value }));
  const { mem, db } = setup();
  const doFetch = googleFetch([], { now: NOW, answer: down });
  const t = await hunt({ api: googleClient({ key: SAMPLE_KEY, fetch: doFetch, cap: 300, sleep: noSleep }), db, doFetch, now: () => NOW, keywords: ['posture'], targets: shops, boardDomains: 0, log: () => {}, shopOpts: { tries: 1 } });
  assert.deepStrictEqual([t.health, t.stopped, t.searches, t.credits.ok, t.credits.failed], ['failed', 'outage', 0, 0, 3]);
  assert.match(t.alert, /every request failed .*3 calls in a row failed/);
  assert.strictEqual(mem.prepare("SELECT value FROM state WHERE key = 'google_cursor'").get(), undefined);
  // A search that fails while others answer: what the others found is looked at, the cursor stays at that keyword.
  const two = setup();
  const flaky = googleFetch([], { now: NOW, answer: (u) => (u.pathname.endsWith('/advertisers/search') && u.searchParams.get('region') === 'DE' ? new Response('{}', { status: 503 }) : null) });
  const t2 = await hunt({ api: googleClient({ key: SAMPLE_KEY, fetch: flaky, cap: 300, sleep: noSleep }), db: two.db, doFetch: flaky, now: () => NOW, keywords: ['posture', 'lamp'], regions: ['NL', 'DE'],
    boardDomains: 0, log: () => {}, shopOpts: { tries: 1 } });
  assert.deepStrictEqual([t2.health, t2.stopped, t2.keywords], ['warning', 'search', 0]);
  assert.match(t2.alert, /"posture" in DE: search failed .*searched again next run/);
  assert.ok(products(two.mem).some((r) => r.product_key.startsWith('posturepro')), 'the NL search found it');
  assert.strictEqual(two.mem.prepare("SELECT value FROM state WHERE key = 'google_cursor'").get(), undefined, '"posture" is searched again next run, "lamp" is not skipped');
});

test('an answer lost on the way (a timeout, a cut connection) counts as spent: the cap holds against what the vendor bills', async () => {
  let sent = 0;
  const api = googleClient({ key: 'k', fetch: async () => { sent++; throw new Error('socket hang up'); }, cap: 3, sleep: noSleep });
  for (let i = 0; i < 5; i++) await api.searchAdvertisers('x' + i).catch(() => {});
  assert.strictEqual(sent, 3, 'never more tries than the cap');
  assert.deepStrictEqual([api.stats().spent, api.stats().lost, api.stats().ok], [3, 3, 0]);
});

test('a list of ads with no answer (success false, 404) is not "fewer than 75 ads"; one ad that fails does not cost the others their product', async () => {
  const { mem, db } = setup();
  const empty = googleFetch([], { now: NOW, answer: (u) => (u.pathname === '/v1/google/company/ads' ? json({ success: false, credits_charged: 1 }) : null) });
  const target = [{ kind: 'domain', value: 'posturepro-sample.example' }];
  const t = await hunt({ api: googleClient({ key: SAMPLE_KEY, fetch: empty, cap: 50, sleep: noSleep }), db, doFetch: empty, now: () => NOW, keywords: [], targets: target, boardDomains: 0, log: () => {}, shopOpts: { tries: 1 } });
  assert.deepStrictEqual([t.few_ads, t.health], [0, 'ok']);
  assert.deepStrictEqual(mem.prepare('SELECT target, result FROM google_targets').all().map((r) => [r.target, r.result]), [['domain:posturepro-sample.example', 'no answer']]);
  // The text ad's details are blocked (403): the image ad's product is saved all the same; the shop is asked again next run.
  const two = setup();
  const blocked = googleFetch([], { now: NOW, answer: (u) => (u.pathname === '/v1/google/ad' && /CR10000000000000000102/.test(u.searchParams.get('url')) ? json({ success: false, message: 'blocked' }, 403) : null) });
  const t2 = await hunt({ api: googleClient({ key: SAMPLE_KEY, fetch: blocked, cap: 50, sleep: noSleep }), db: two.db, doFetch: blocked, now: () => NOW, keywords: [], targets: target, boardDomains: 0, log: () => {}, shopOpts: { tries: 1 } });
  assert.strictEqual(t2.health, 'warning');
  assert.deepStrictEqual(products(two.mem).map((r) => [r.product_key, r.copies]), [['posturepro-sample.example/products/posture-corrector-pro', 1]]);
  assert.strictEqual(two.mem.prepare('SELECT COUNT(*) AS n FROM google_targets').get().n, 0, 'asked again next run');
});

test('no credits left (402): the run ends red with that reason, not as "cap reached"', async () => {
  const { mem, db } = setup();
  const broke = googleFetch([], { now: NOW, answer: (u) => (u.hostname === 'api.scrapecreators.com' ? json({ success: false, message: 'buy credits' }, 402) : null) });
  const t = await hunt({ api: googleClient({ key: SAMPLE_KEY, fetch: broke, cap: 300, sleep: noSleep }), db, doFetch: broke, now: () => NOW, keywords: ['posture'], boardDomains: 0, log: () => {}, shopOpts: { tries: 1 } });
  assert.deepStrictEqual([t.health, t.stopped], ['failed', 'no-credits']);
  assert.match(t.alert, /no credits left at Scrape Creators/);
  assert.strictEqual(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'google_run'").get().value).stopped, 'no-credits');
});

test('a product whose ad is older than 42 days today, or not checked for a month, goes off (active 0): out of the store signals too; a decided one is kept', async () => {
  const { mem, db } = setup();
  const put = mem.prepare("INSERT INTO google_products (product_key, ad_id, active, first_shown, last_seen, run_id) VALUES (?, ?, 1, ?, ?, 'old')");
  put.run('old.example/products/a', 'gCR1', new Date(NOW - 50 * DAY).toISOString(), new Date(NOW - DAY).toISOString());
  put.run('stale.example/products/b', 'gCR2', new Date(NOW - 20 * DAY).toISOString(), new Date(NOW - 31 * DAY).toISOString());
  put.run('fine.example/products/c', 'gCR3', new Date(NOW - 20 * DAY).toISOString(), new Date(NOW - DAY).toISOString());
  const t = await run({ db, keywords: [], boardDomains: 0 });
  assert.strictEqual(t.retired, 2);
  assert.deepStrictEqual(mem.prepare('SELECT product_key, active FROM google_products ORDER BY product_key').all().map((r) => [r.product_key, r.active]),
    [['fine.example/products/c', 1], ['old.example/products/a', 0], ['stale.example/products/b', 0]]);
  const wanted = mem.prepare((await import('../bestsellers.mjs')).WANTED_SQL).all(new Date(NOW - 45 * DAY).toISOString());
  assert.ok(!wanted.some((w) => /old\.example|stale\.example/.test(w.product_url || '')), 'not asked for store signals any more');
});

test('a dry run reads only: on a database without the Google tables (before the first migration) it runs and creates nothing', async () => {
  const mem = new DatabaseSync(':memory:');
  const db = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(mem).doFetch, retryMs: 0 });
  const t = await run({ db, dryRun: true });
  assert.deepStrictEqual([t.health, t.dry_run, t.rows.length], ['ok', true, 2], 'the two products of the keywords (no tables: no shops from the other tabs)');
  assert.deepStrictEqual(mem.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), [], 'not one table made');
});

test('settings: GOOGLE_CREDITS is a hard cap with a default and a ceiling; regions; typed domains and advertiser ids', () => {
  assert.deepStrictEqual([creditsOf(undefined), creditsOf(''), creditsOf('50'), creditsOf('0'), creditsOf('-3'), creditsOf('99999'), creditsOf('abc')], [300, 300, 50, 1, 1, MAX_CREDITS, 1]);
  assert.deepStrictEqual(regionsOf('nl, de|FR x1 nl'), ['NL', 'DE', 'FR']);
  assert.deepStrictEqual(regionsOf(''), ['NL', 'DE', 'FR']);
  assert.deepStrictEqual(targetsOf('https://www.Shop.example/x | AR10000000000000000001, amazon.de not-a-domain'), [{ kind: 'domain', value: 'shop.example' }, { kind: 'adv', value: 'AR10000000000000000001' }]);
});

// ---------------------------------------------------------------------------
// The workflow: off by default, no secret in the code
// ---------------------------------------------------------------------------
const WF = fs.readFileSync(new URL('../../.github/workflows/google-hunter.yml', import.meta.url), 'utf8');

test('google-hunter.yml: by hand any time; its schedule runs only with the repository variable GOOGLE_HUNT = on; secrets from GitHub only', () => {
  assert.match(WF, /^on:\n  workflow_dispatch:\n/m);
  assert.match(WF, /^  schedule:\n    #.*\n    - cron: '41 4 \* \* \*'$/m, 'a daily schedule, off the hour');
  assert.match(WF, /^    if: \$\{\{ github\.event_name != 'schedule' \|\| vars\.GOOGLE_HUNT == 'on' \}\}$/m, 'the schedule is off until switched on');
  assert.match(WF, /^      SCRAPECREATORS_API_KEY: \$\{\{ secrets\.SCRAPECREATORS_API_KEY \}\}$/m);
  assert.match(WF, /^      CF_API_TOKEN: \$\{\{ secrets\.CF_D1_TOKEN \|\| secrets\.CF_API_TOKEN \}\}$/m, 'the D1-only token when there is one, as the other hunts');
  assert.match(WF, /^      GOOGLE_CREDITS: \$\{\{ inputs\.credits \|\| vars\.GOOGLE_CREDITS \|\| '300' \}\}$/m);
  assert.match(WF, /dry_run:\n\s+description: .*\n\s+type: boolean\n\s+required: false\n\s+default: false/);
  assert.match(WF, /^permissions:\n  contents: read$/m);
  assert.match(WF, /^concurrency:\n  group: google-hunter\n  cancel-in-progress: false$/m, 'one run at a time, never cut off');
  for (const [, ref] of WF.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, ref);
  const steps = WF.indexOf('node winner-hunter/migrate.mjs') < WF.indexOf('node winner-hunter/google.mjs') && WF.indexOf('node winner-hunter/google.mjs') < WF.indexOf('node winner-hunter/world-check.mjs');
  assert.ok(steps, 'tables first, then the hunt, then Jev');
  assert.match(WF, /- name: Jev check\n\s+if: \$\{\{ !cancelled\(\) && !inputs\.dry_run \}\}/, 'a dry run saves nothing, so nothing to check after it');
  const timeout = Number(/^    timeout-minutes: (\d+)$/m.exec(WF)[1]);
  const minutes = Number(/^      GOOGLE_MINUTES: '(\d+)'$/m.exec(WF)[1]);
  assert.ok(timeout >= minutes + 45, `the hunt (${minutes} min), Jev (15) and the store signals (15) fit in ${timeout} minutes`);
  assert.doesNotMatch(WF, /x-api-key|sk_|api\.scrapecreators\.com/i, 'no key or endpoint in the workflow');
  // No secret anywhere in the code: the key only comes from the environment.
  for (const f of ['../google.mjs', '../lib/google-ads.mjs', '../worker/src/google.mjs']) assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), 'utf8'), /x-api-key['"]?\s*:\s*['"][^'"]{8,}/, f);
});

test('google-hunter.yml: a missing secret ends red and names it; credits must be a number', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 && 'no bash' }, () => {
  const lines = WF.split('\n');
  const at = lines.findIndex((l) => /- name: Check secrets/.test(l));
  const body = [];
  for (const l of lines.slice(at + 2)) {
    if (!/^ {10}/.test(l) && l.trim()) break;
    body.push(l.slice(10));
  }
  const run = (env) => spawnSync('bash', ['-e', '-c', body.join('\n')], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const none = run({ GOOGLE_CREDITS: '300' });
  assert.notStrictEqual(none.status, 0);
  assert.match(none.stdout, /::error::Missing GitHub secret\(s\): SCRAPECREATORS_API_KEY CF_API_TOKEN CF_ACCOUNT_ID/);
  const all = { SCRAPECREATORS_API_KEY: 'k', CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a' };
  assert.strictEqual(run({ ...all, GOOGLE_CREDITS: '300' }).status, 0);
  const bad = run({ ...all, GOOGLE_CREDITS: '3e9' });
  assert.notStrictEqual(bad.status, 0);
  assert.match(bad.stdout, /credits must be a number/);
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------
const MIGRATION = fs.readFileSync(new URL('../worker/migrations/0021_google_ads.sql', import.meta.url), 'utf8');

test('migration 0021: only new tables and indexes (nothing dropped, deleted or altered), safe to apply twice, the full set too', async () => {
  const st = statements(MIGRATION);
  assert.ok(st.length >= 6);
  assert.ok(st.every((s) => /^CREATE (TABLE|INDEX) IF NOT EXISTS google_/.test(s)), 'additive only');
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /\b(DROP|DELETE|ALTER|UPDATE|INSERT|REPLACE)\b/i);
  const db = new DatabaseSync(':memory:');
  for (let i = 0; i < 2; i++) for (const s of st) db.exec(s);
  assert.deepStrictEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name), ['google_ads', 'google_products', 'google_stores', 'google_targets']);
  // Every migration, twice, over the REST client (as migrate.mjs runs them on every workflow run): a product survives.
  const mem = new DatabaseSync(':memory:');
  const c = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(mem).doFetch, retryMs: 0 });
  const dir = new URL('../worker/migrations/', import.meta.url);
  const texts = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(new URL(f, dir), 'utf8'));
  await migrate(c, texts);
  mem.prepare("INSERT INTO google_products (product_key, ad_id) VALUES ('a.example/products/x', 'gCR1')").run();
  await migrate(c, texts);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM google_products').get().n, 1);
  const cols = mem.prepare('PRAGMA table_info(google_products)').all().map((r) => r.name);
  for (const col of ['product_key', 'ad_id', 'active', 'verdict', 'rules', 'regions', 'formats', 'first_shown', 'last_shown', 'impr_scope', 'run_id']) assert.ok(cols.includes(col), col);
});
