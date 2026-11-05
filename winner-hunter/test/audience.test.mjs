// Audience engine: lib/audience*.mjs and audience.mjs. Every fixture here is made up (no real person's words in this
// public repo); the shapes follow Scrape Creators' documented answers and TypeSafe's System One answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFbAd, readFbSearch, readRedditComments, readRedditPosts, readRedditThread, readTikTokVideos, readTikTokComments, readYouTubeVideos, readYouTubeComments,
  readShopProducts, readShopReviews, collect, memoryCache, ctxCache, usable, queryKey, KINDS } from '../lib/audience-collect.mjs';
import { tagStatement, themesOf, situationsOf, phrasesOf, claimsIn, angleOf, hookOf, isEnglish } from '../lib/audience-text.mjs';
import { candidates, phraseOf } from '../lib/audience-phrase.mjs';
import { demographics, baselineOf, ageSpan, sharesOf } from '../lib/audience-meta.mjs';
import { jevClient, labelStatements, rankHooks, choosePhrase, BATCH } from '../lib/audience-jev.mjs';
import { buildCard, cardMarkdown, hookProblem, shortLine, relevant, TEMPLATES } from '../lib/audience-card.mjs';
import { audienceCard, enrich, subOf, addToBaseline, BASELINE_KEY } from '../lib/audience.mjs';
import { parseArgs } from '../audience.mjs';

const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
const noSleep = async () => {};
const NOW = Date.parse('2026-11-05T06:00:00Z');

// ---------------------------------------------------------------------------
// Fixtures (invented)
// ---------------------------------------------------------------------------
const cellRow = (cc, rows) => ({ country: cc, age_gender_breakdowns: rows.map(([age_range, female, male, unknown]) => ({ age_range, female, male, unknown })) });
const FB_AD = {
  success: true, credits_charged: 1, adArchiveID: '111222333444', pageName: 'Example Pets', isActive: true, startDate: 1758500000, endDate: 1762300000, publisherPlatform: ['facebook', 'instagram'],
  snapshot: { body: { text: 'STOP scrubbing the bowl.\n\nOur story starts with a slimy bowl.' }, title: 'Fresh water', link_url: 'https://shop.example/products/fountain', cta_text: 'Shop now' },
  aaa_info: { gender_audience: 'All', age_audience: { min: 18, max: 65 }, eu_total_reach: 1000, location_audience: [{ name: 'Ireland', excluded: false }, { name: 'Spain', excluded: false }],
    age_country_gender_reach_breakdown: [cellRow('IE', [['25-34', 300, 100, 0], ['35-44', 200, 100, 0], ['55-64', 50, 50, 0]]), cellRow('ES', [['25-34', 100, 50, 0], ['18-24', 25, 25, 0]])] },
};
const FB_AD_MEN = { ...FB_AD, adArchiveID: '999888777666', aaa_info: { ...FB_AD.aaa_info, age_country_gender_reach_breakdown: [cellRow('DE', [['45-54', 50, 400, 10], ['55-64', 40, 300, 0]])] } };
const REDDIT_C = { success: true, credits_charged: 1, comments: [
  { body: 'The bowl gets slimy every single day and I hate scrubbing it', votes: 12, url: 'https://www.reddit.com/r/dogs/comments/a1/x/c1/', created_at_iso: '2026-10-01T00:00:00Z', author: 'someone', post: { title: 'Water bowl or fountain advice' } },
  { body: 'lol', votes: 50, url: 'https://www.reddit.com/r/dogs/comments/a1/x/c2/' },
  { body: 'Our aquarium pump hums all night, unrelated to dogs entirely', votes: 3, url: 'https://www.reddit.com/r/fish/comments/a2/y/c3/', post: { title: 'Aquarium noise' } },
] };
const TT_SEARCH = { success: true, credits_charged: 1, search_item_list: [
  { aweme_id: '7001', desc: 'water fountain for my dog', statistics: { comment_count: 400, play_count: 1e6 }, url: 'https://www.tiktok.com/@a/video/7001', create_time: 1750000000 },
  { aweme_id: '7002', desc: 'sponsored', is_ad: true, statistics: { comment_count: 9000 }, url: 'https://www.tiktok.com/@b/video/7002' },
  { aweme_id: '7003', desc: 'small', statistics: { comment_count: 3 }, url: 'https://www.tiktok.com/@c/video/7003' },
] };
const TT_COMMENTS = { success: true, credits_charged: 1, comments: [
  { text: 'My dog is scared of it and still prefers his old bowl', digg_count: 900, create_time: 1750001000, user: { unique_id: 'secret_handle', nickname: 'Secret Name' } },
  { text: 'I need this for my two dogs, where can I buy it?', digg_count: 40, create_time: 1750002000 },
  { text: 'so cute', digg_count: 30 },
  { text: 'Does it get loud at night? Our last one was so noisy', digg_count: 22 },
] };
const YT_SEARCH = { success: true, credits_charged: 1, videos: [{ id: 'yt1', url: 'https://www.youtube.com/watch?v=yt1', title: 'Fountain review', viewCountInt: 5000, commentCountInt: 40, publishedTime: '2026-06-01T00:00:00Z' }], shorts: [] };
const YT_COMMENTS = { success: true, credits_charged: 1, comments: [
  { content: 'Get it on my affiliate link here', author: { isCreator: true }, engagement: { likes: 5 } },
  { content: 'Mine stopped working after six months and support never answered', author: { isCreator: false }, engagement: { likes: 7 }, publishedTime: '2026-07-01T00:00:00Z' },
  { content: 'Finally my dog drinks more water, love it so much', author: {}, engagement: { likes: 3 } },
] };

function scFetch({ calls = [], fail = null } = {}) {
  return async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (fail) return fail(u);
    if (u.pathname === KINDS.fb_ad.path) return json(u.searchParams.get('id') === '999888777666' ? FB_AD_MEN : FB_AD);
    if (u.pathname === KINDS.fb_search.path) return json({ success: true, credits_charged: 1, searchResults: [{ ad_archive_id: '999888777666', page_name: 'Other shop', is_active: true, start_date: 1758000000, snapshot: { link_url: 'https://other.example/products/x' } }] });
    if (u.pathname === KINDS.reddit_search.path) return json(u.searchParams.get('filter') === 'comments' ? REDDIT_C : { success: true, credits_charged: 1, posts: [] });
    if (u.pathname === KINDS.tiktok_search.path) return json(TT_SEARCH);
    if (u.pathname === KINDS.tiktok_comments.path) return json(TT_COMMENTS);
    if (u.pathname === KINDS.youtube_search.path) return json(YT_SEARCH);
    if (u.pathname === KINDS.youtube_comments.path) return json(YT_COMMENTS);
    return json({ success: false }, 404);
  };
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------
test('readFbAd: reach split per cell and country, the targeting set, the ad text with its first line kept', () => {
  const a = readFbAd(FB_AD);
  assert.equal(a.id, '111222333444');
  assert.equal(a.reach.cells['F|25-34'], 400);
  assert.equal(a.reach.byCountry.IE, 800);
  assert.equal(a.reach.byCountry.ES, 200);
  assert.deepEqual(a.targeting.ages, { min: 18, max: 65 });
  assert.equal(a.targeting.gender, 'All');
  assert.deepEqual(a.targeting.locations, ['Ireland', 'Spain']);
  assert.equal(hookOf(a.body), 'STOP scrubbing the bowl.');
  assert.equal(readFbAd(null), null);
});

test('readers keep text, likes, date and the public link, never a name or handle', () => {
  const r = readRedditComments(REDDIT_C, 'dog water fountain');
  assert.equal(r.length, 2, 'the one-word comment is dropped');
  assert.equal(r[0].likes, 12);
  assert.equal(r[0].date, '2026-10-01');
  assert.equal(r[0].on, 'Water bowl or fountain advice');
  const v = readTikTokVideos(TT_SEARCH);
  assert.deepEqual(v.map((x) => x.id), ['7001', '7003'], 'ads dropped, most comments first');
  const t = readTikTokComments(TT_COMMENTS, 'q', v[0].url);
  assert.equal(t.length, 3);
  assert.ok(!JSON.stringify(t).includes('secret_handle') && !JSON.stringify(t).includes('Secret Name'));
  const y = readYouTubeComments(YT_COMMENTS, 'q', 'https://www.youtube.com/watch?v=yt1');
  assert.equal(y.length, 2, "the creator's own comment is dropped");
  assert.equal(readYouTubeVideos(YT_SEARCH)[0].comments, 40);
  const shop = readShopProducts({ products: [{ product_id: '1', title: 'A', sold_info: { sold_count: 10 }, seo_url: { canonical_url: 'https://www.tiktok.com/shop/pdp/a/1' } }, { product_id: '2', title: 'B', sold_info: { sold_count: 99 }, seo_url: { canonical_url: 'https://www.tiktok.com/shop/pdp/b/2' } }] });
  assert.deepEqual(shop.map((p) => p.id), ['2', '1']);
  const rv = readShopReviews({ product_info: { product_detail_review: { review_items: [{ review: { rating: 2, display_text: 'Broke after two weeks of normal use', review_timestamp: '1750007337100' }, review_user: { name: 'buyer_name' } }] } } }, 'q', 'u');
  assert.equal(rv[0].rating, 2);
  assert.ok(!JSON.stringify(rv).includes('buyer_name'));
  const th = readRedditThread({ comments: [{ body: 'Top level comment with enough words', ups: 4, replies: { items: [{ body: 'A reply that also has enough words', ups: 1 }] } }] }, 'q', 'Thread');
  assert.equal(th.length, 2);
  const posts = readRedditPosts({ posts: [{ title: 'Big thread', selftext: 'My dog bowl is always gross by noon', num_comments: 80, url: 'https://www.reddit.com/r/dogs/comments/b/', ups: 9 }] }, 'q');
  assert.equal(posts.threads[0].comments, 80);
  assert.equal(posts.items.length, 1);
  assert.equal(readFbSearch({ searchResults: [{ ad_archive_id: '123456789', is_active: true, snapshot: { link_url: 'https://facebook.com/x' } }] }).length, 0, 'an ad that links to Facebook is not a shop');
  assert.ok(usable('four words are here') && !usable('😀😀 #tag @me'));
  assert.equal(queryKey('  Dog-Water  Fountain! '), 'dog water fountain');
});

// ---------------------------------------------------------------------------
// collect(): cache, caps, stops
// ---------------------------------------------------------------------------
const apiWith = async (fetch, cap = 50) => (await import('../lib/audience-collect.mjs')).audienceClient({ key: 'k', cap, fetch, sleep: noSleep });

test('collect: pulls each source once, then the cache serves it for free', async () => {
  const calls = [];
  const cache = memoryCache();
  const pick = { id: 'p', phrase: 'dog water fountain', ad_ids: ['111222333444'] };
  const first = await collect(pick, { api: await apiWith(scFetch({ calls })), cache, now: NOW, perPick: 20 });
  assert.ok(first.ads.length === 1 && first.voice.length >= 5, 'ads and statements');
  assert.ok(first.credits >= 7);
  const n = calls.length;
  const second = await collect(pick, { api: await apiWith(scFetch({ calls })), cache, now: NOW + 3600e3, perPick: 20 });
  assert.equal(calls.length, n, 'no call the second time');
  assert.equal(second.credits, 0);
  assert.ok(second.pulls.every((p) => p.cached));
  assert.equal(second.voice.length, first.voice.length);
  const later = await collect(pick, { api: await apiWith(scFetch({ calls })), cache, now: NOW + 40 * 864e5, perPick: 20 });
  assert.ok(calls.length > n && later.credits > 0, 'old entries are pulled again');
});

test('collect: the product credit cap, a 402 and no key stop it with what it has; the abort signal too', async () => {
  const capped = await collect({ id: 'p', phrase: 'dog water fountain', ad_ids: ['111222333444'] }, { api: await apiWith(scFetch()), cache: memoryCache(), now: NOW, perPick: 2 });
  assert.equal(capped.credits, 2);
  assert.equal(capped.stopped, 'product credit cap');
  const broke = await collect({ id: 'p', phrase: 'x y', ad_ids: ['1234567'] }, { api: await apiWith(scFetch({ fail: () => json({ success: false, message: 'no credits' }, 402) })), cache: memoryCache(), now: NOW, perPick: 10 });
  assert.equal(broke.stopped, 'credits');
  assert.equal(broke.pulls.length, 0);
  const cache = memoryCache({ 'reddit:c:dog water fountain': { at: new Date(NOW).toISOString(), data: readRedditComments(REDDIT_C, 'q') } });
  const nokey = await collect({ id: 'p', phrase: 'dog water fountain' }, { api: null, cache, now: NOW, perPick: 10 });
  assert.equal(nokey.voice.length, 2, 'the cache still serves');
  assert.match(nokey.stopped, /no API key/);
  const ac = new AbortController();
  ac.abort();
  const aborted = await collect({ id: 'p', phrase: 'dog water fountain', ad_ids: ['111222333444'] }, { api: await apiWith(scFetch()), cache: memoryCache(), now: NOW, perPick: 10, signal: ac.signal });
  assert.equal(aborted.stopped, 'deadline');
  assert.equal(aborted.credits, 0);
});

test('collect: no ad with EU reach numbers: the Ad Library in Ireland finds the competitors', async () => {
  const calls = [];
  const r = await collect({ id: 'p', phrase: 'dog water fountain', ad_ids: [] }, { api: await apiWith(scFetch({ calls })), cache: memoryCache(), now: NOW, perPick: 20 });
  const s = calls.find((u) => u.pathname === KINDS.fb_search.path);
  assert.ok(s && s.searchParams.get('country') === 'IE' && s.searchParams.get('query') === 'dog water fountain');
  assert.equal(r.ads.length, 1);
  assert.match(r.ads[0].found, /Ireland|IE/);
});

test('collect: an empty Ireland search for three or more words is tried once more with the last two', async () => {
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    if (u.pathname === KINDS.fb_search.path) return json(u.searchParams.get('query') === 'muscle scraper' ? { success: true, credits_charged: 1, searchResults: [{ ad_archive_id: '999888777666', is_active: true, snapshot: { link_url: 'https://other.example/p' } }] } : { success: true, credits_charged: 1, searchResults: [] });
    if (u.pathname === KINDS.fb_ad.path) return json(FB_AD_MEN);
    return json({ success: true, credits_charged: 1, comments: [], search_item_list: [], videos: [], posts: [] });
  };
  const r = await collect({ id: 'p', phrase: 'eclipse muscle scraper' }, { api: await apiWith(fetch), cache: memoryCache(), now: NOW, perPick: 14, threads: 0 });
  assert.deepEqual(calls.filter((u) => u.pathname === KINDS.fb_search.path).map((u) => u.searchParams.get('query')), ['eclipse muscle scraper', 'muscle scraper']);
  assert.equal(r.ads.length, 1);
  assert.match(r.ads[0].found, /"muscle scraper"/);
});

test('ctxCache: the daily job cache (get, put with days) keeps the shape and the TTL in days', async () => {
  const store = new Map();
  const puts = [];
  const c = ctxCache({ get: async (k) => store.get(k) ?? null, put: async (k, v, days) => (puts.push([k, days]), store.set(k, v)) });
  await c.put('fbad:1', { at: 'x', data: 1 });
  await c.put('reddit:c:q', { at: 'x', data: [] });
  assert.deepEqual(puts, [['fbad:1', 30], ['reddit:c:q', 21]]);
  assert.deepEqual(await c.get('fbad:1'), { at: 'x', data: 1 });
  store.set('junk', 'not ours');
  assert.equal(await c.get('junk'), null);
});

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------
test('tagStatement: kinds and themes, "a pain to clean" is effort, a doubt about the product is not a pain', () => {
  assert.equal(tagStatement('The bowl is slimy and gross by noon').pain, 'dirty');
  assert.equal(tagStatement('These are a pain to clean every day').pain, 'time');
  const scared = tagStatement('My dog is scared of it and prefers his nasty bowl');
  assert.equal(scared.objection, 'wontuse');
  assert.equal(scared.pain, undefined);
  assert.equal(tagStatement('Way too expensive for what it is').objection, 'price');
  assert.equal(tagStatement('Finally no more scrubbing, game changer').outcome, 'finally');
  assert.equal(tagStatement('I need this, where can I buy it?').intent, 'want');
  assert.equal(tagStatement('Does it work for big dogs?').question, 'ask');
  assert.equal(tagStatement('What an awesome review').question, undefined);
  assert.equal(tagStatement('Got it for my new puppy last week').trigger, 'newpet');
  assert.ok(isEnglish('my dog loves the water and the bowl') && !isEnglish('mein Hund liebt das Wasser sehr'));
});

test('themesOf, situationsOf, phrasesOf: counted once per statement, phrases never span punctuation', () => {
  const items = [
    'My two dogs leave a slimy bowl every day', 'Slimy bowl again, my dogs are messy', 'stainless steel, plastic, ceramic: which one?', 'As a mom of three I have no time', 'Slimy bowl in summer is the worst',
  ].map((text, i) => ({ text, likes: i, src: 'reddit', url: `https://www.reddit.com/r/x/comments/${i}/` }));
  for (const it of items) it.tags = tagStatement(it.text);
  const th = themesOf(items);
  assert.equal(th.pain[0].key, 'dirty');
  assert.equal(th.pain[0].n, 3);
  const sit = situationsOf(items, { min: 1 });
  assert.ok(sit.some((s) => s.key === 'multipet') && sit.some((s) => s.key === 'parent'));
  const ph = phrasesOf(items, { min: 2 });
  assert.equal(ph[0].phrase, 'slimy bowl');
  assert.equal(ph[0].n, 3);
  assert.ok(!ph.some((p) => p.phrase === 'steel plastic'));
});

test('claimsIn and angleOf: claims and hook kinds in several languages', () => {
  assert.equal(claimsIn('Relieves back pain in days')[0].key, 'medical');
  assert.equal(claimsIn('Lindert Schmerzen sofort')[0].key, 'medical');
  assert.equal(claimsIn('Only 3 left in stock')[0].key, 'scarcity');
  assert.equal(claimsIn('A dupe of the famous one')[0].key, 'brand');
  assert.deepEqual(claimsIn('A soft cotton pillowcase'), []);
  assert.equal(angleOf('STOP scrubbing your dog\'s bowl.\nMore text'), 'stop');
  assert.equal(angleOf('Arrêtez de laver la gamelle'), 'stop');
  assert.equal(angleOf('Is your dog drinking enough?\nRead on'), 'question');
  assert.equal(angleOf('-50% nur heute\nJetzt kaufen'), 'offer');
  assert.equal(angleOf('Über 10.000 zufriedene Kunden\nDanke'), 'proof');
  assert.equal(angleOf('Das perfekte Geschenk für Mama'), 'gift');
  assert.equal(angleOf('A water fountain with three filters'), 'demo');
});

test('candidates: English search words from German, French and Dutch handles, the category, or a given phrase', () => {
  assert.equal(phraseOf({ url: 'https://pelsbarn.de/products/pelsbarn-hundegeschirr' }).phrase, 'dog harness');
  assert.equal(phraseOf({ url: 'https://x.fr/products/harnais-anti-traction-personnalise' }).phrase, 'no pull dog harness');
  assert.equal(phraseOf({ title: 'Katzengeschirr für Freigänger' }).phrase, 'cat harness');
  assert.equal(phraseOf({ title: 'PLEASE do not use a water bowl!', sub: 'Pets > Fountains and feeders' }).phrase, 'pet water fountain');
  assert.equal(phraseOf({ phrase: 'Dog Water Fountain', title: 'Hundegeschirr' }).phrase, 'dog water fountain');
  assert.equal(phraseOf({ title: 'zijden kussensloop' }).phrase, 'silk pillowcase');
  const c = candidates({ title: 'Cooling dog mat for summer', sub: 'Pets > Beds and blankets' });
  assert.ok(c.length >= 2 && c.some((x) => x.how === 'category'));
  assert.equal(phraseOf({ title: '' }).phrase, '');
});

// ---------------------------------------------------------------------------
// Reach split
// ---------------------------------------------------------------------------
test('demographics: shares, skew, the age span, top countries and an index against the baseline', () => {
  const a = readFbAd(FB_AD);
  const m = readFbAd(FB_AD_MEN);
  const base = baselineOf([a, m]);
  assert.equal(base.n, 2);
  const d = demographics([a], base);
  assert.equal(d.women, 67.5);
  assert.equal(d.skew, 'women');
  assert.equal(d.span.label, '25-44');
  assert.equal(d.countries[0].cc, 'IE');
  assert.ok(d.sexIndex.F > 100 && d.sexIndex.M < 100);
  assert.ok(d.targeting.broadAge && d.targeting.broadSex);
  assert.equal(demographics([{ reach: { cells: {} } }], base), null);
  assert.deepEqual(ageSpan({ '18-24': 0.1, '25-34': 0.5, '35-44': 0.2, '45-54': 0.1, '55-64': 0.05, '65+': 0.05 }).label, '25-44');
  assert.equal(sharesOf({ reach: { cells: {} } }), null);
});

// ---------------------------------------------------------------------------
// Jev
// ---------------------------------------------------------------------------
function jevFetch({ seen = [], status = 200, pick = () => 'A doubt, worry or reason not to buy this kind of product' } = {}) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body);
    if (status !== 200) return json({ detail: { error_type: 'billing_error' } }, status);
    const answers = {};
    for (const [k, q] of Object.entries(body.questions)) {
      if (q.type === 'choice') {
        const opts = Object.keys(q.criteria);
        const choice = k === 'best' ? opts[opts.length - 1] : k === 'phrase' ? opts[1] : pick(q, opts);
        answers[k] = { choice, confidence: 0.9, probabilities: Object.fromEntries(opts.map((o) => [o, o === choice ? 0.7 : 0.3 / Math.max(1, opts.length - 1)])) };
      } else if (q.type === 'noul') answers[k] = { noul: /Line: "Finally/.test(q.instructions) ? 0.9 : 0.05 };
    }
    return json({ model: 'jev-1.14.0', answers, usage: { input_tokens: 1000 } });
  };
}

test('Jev: statements in batches of 20, each its own question; a stop keeps what was labelled', async () => {
  const seen = [];
  const client = jevClient({ key: 'k', fetch: jevFetch({ seen }), pause: noSleep, cap: 10 });
  const items = Array.from({ length: 45 }, (_, i) => ({ text: `statement number ${i} with enough words`, likes: i, src: 'reddit' }));
  const r = await labelStatements(items, { client, product: { name: 'Fountain', phrase: 'dog water fountain' }, max: 45, concurrency: 1 });
  assert.equal(r.labelled, 45);
  assert.equal(seen.length, Math.ceil(45 / BATCH));
  assert.equal(Object.keys(seen[0].questions).length, BATCH);
  assert.ok(items.every((it) => it.jev === 'objection'));
  assert.equal(client.stats().tokens, 3000);
  const broke = jevClient({ key: 'k', fetch: jevFetch({ status: 402 }), pause: noSleep });
  const r2 = await labelStatements(items.map((x) => ({ ...x, jev: undefined })), { client: broke, product: {}, max: 45 });
  assert.equal(r2.labelled, 0);
  assert.match(r2.error, /402/);
  assert.throws(() => jevClient({ key: ' ' }), /TYPESAFE_API_KEY/);
  const capped = jevClient({ key: 'k', fetch: jevFetch(), pause: noSleep, cap: 1 });
  await capped.ask({}, {});
  await assert.rejects(() => capped.ask({}, {}), /cap/);
});

test('Jev: hook ranking by text with a claim check per hook; phrase choice', async () => {
  const client = jevClient({ key: 'k', fetch: jevFetch(), pause: noSleep });
  const r = await rankHooks(['Slimy water bowl again?', 'Finally, a fountain that does the job.'], { client, product: { name: 'F' }, persona: 'Dog owners' });
  assert.equal(r.probs['Finally, a fountain that does the job.'], 0.7);
  assert.equal(r.claims['Finally, a fountain that does the job.'], 0.9);
  assert.equal(r.claims['Slimy water bowl again?'], 0.05);
  assert.equal(await choosePhrase([{ phrase: 'a' }, { phrase: 'b' }], { client, product: {} }), 'b');
  assert.equal(await choosePhrase([{ phrase: 'a' }], { client, product: {} }), null);
});

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------
function cardInput(extra = {}) {
  const voice = [
    ...readRedditComments(REDDIT_C, 'dog water fountain'),
    ...readTikTokComments(TT_COMMENTS, 'dog water fountain', 'https://www.tiktok.com/@a/video/7001'),
    ...readYouTubeComments(YT_COMMENTS, 'dog water fountain', 'https://www.youtube.com/watch?v=yt1'),
    { src: 'tiktok', kind: 'comment', text: 'Bought one for my new puppy and the bowl is never slimy now', likes: 5, url: 'https://www.tiktok.com/@a/video/7001' },
    { src: 'tiktok', kind: 'comment', text: 'Got this as a gift for my sister and her dogs', likes: 2, url: 'https://www.tiktok.com/@a/video/7001' },
    { src: 'youtube', kind: 'comment', text: 'The water in a plain bowl gets slimy and gross after two days', likes: 1, url: 'https://www.youtube.com/watch?v=yt1' },
  ];
  const ads = [readFbAd(FB_AD)];
  return { pick: { id: 'p1', key: 'research|p1', name: 'Dog water fountain', main: 'Pets', markets: ['NZ', 'AU'], jev: { audience: 'Dog owners' } }, phrase: { phrase: 'dog water fountain', how: 'given' },
    collected: { ads, voice, pulls: [{ key: 'reddit:c:dog water fountain', kind: 'reddit_search', at: '2026-11-05T06:00:00.000Z', n: 3, credits: 1 }], credits: 7, errors: [] },
    baseline: baselineOf([readFbAd(FB_AD), readFbAd(FB_AD_MEN)]), now: NOW, ...extra };
}

test('buildCard: problem, reach, personas, 5 safe angles one per kind, broad targeting control, facts apart from assumptions', () => {
  const c = buildCard(cardInput());
  assert.equal(c.problem.themes[0].key, 'dirty');
  assert.ok(c.reach && c.reach.skew === 'women');
  assert.match(c.personas[0].label, /^Dog owners/);
  assert.ok(c.personas[0].evidence.some((e) => e.tag === 'fact') && c.personas[0].evidence.some((e) => e.tag === 'estimate'));
  assert.equal(c.angles.length, 5);
  assert.deepEqual([...new Set(c.angles.map((a) => a.slot))].sort(), ['objection', 'open', 'outcome', 'pain', 'trigger']);
  for (const a of c.angles) assert.equal(hookProblem(a.hook), '', `hook "${a.hook}" is safe`);
  assert.equal(c.angles.filter((a) => a.first_test).length, 3);
  assert.equal(c.targeting.control.age, '25-65+');
  assert.match(c.targeting.control.audience, /no interests/);
  assert.match(c.targeting.interests.status, /unverified/);
  assert.deepEqual(c.targeting.countries.map((x) => x.cc), ['NZ', 'AU']);
  assert.ok(c.objections.some((o) => o.key === 'wontuse' && /first try/.test(o.answer)));
  assert.ok(c.facts.length >= 3 && c.assumptions.some((a) => /Reach is not purchases/.test(a)));
  assert.ok(Array.from(c.one_line).length <= 110, c.one_line);
  assert.ok(Array.from(c.one_line_long).length <= 160);
  assert.ok(!JSON.stringify(c).includes('secret_handle'), 'no handles anywhere on the card');
  assert.ok(!c.voice, 'the raw statements are not stored on the card');
});

test('buildCard: off-topic site-wide comments are dropped; the season follows the first market\'s hemisphere', () => {
  const c = buildCard(cardInput());
  assert.equal(relevant({ src: 'reddit', kind: 'comment', text: 'Our aquarium pump hums all night', on: 'Aquarium noise' }, 'dog water fountain'), false);
  assert.equal(relevant({ src: 'reddit', kind: 'comment', text: 'any comment', on: 'Which fountain for a husky?' }, 'dog water fountain'), true);
  assert.equal(relevant({ src: 'tiktok', kind: 'comment', text: 'so cute and lovely and small' }, 'dog water fountain'), true);
  assert.ok(!JSON.stringify(c.problem).includes('aquarium'));
  const north = buildCard(cardInput({ pick: { ...cardInput().pick, markets: ['NL'] } }));
  const south = buildCard(cardInput());
  assert.ok(south.drafts.some((d) => /summer/.test(d.hook)) && north.drafts.some((d) => /cold nights/.test(d.hook)));
});

test('buildCard: Jev ranking orders the angles and drops a hook it reads as a claim', () => {
  const first = buildCard(cardInput());
  const probs = Object.fromEntries(first.drafts.map((d, i) => [d.hook, i === first.drafts.length - 1 ? 0.9 : 0.01]));
  const claimHook = first.angles[0].hook;
  const c = buildCard(cardInput({ jev: { used: true, labelled: 3, ranking: { probs, claims: { [claimHook]: 0.95 } } } }));
  assert.ok(!c.angles.some((a) => a.hook === claimHook), 'the claim hook is gone');
  assert.equal(c.angles[0].jev_p, Math.max(...c.angles.map((a) => a.jev_p)));
});

test('buildCard: no data at all still gives a card that says so', () => {
  const c = buildCard({ pick: { id: 'x', name: 'Mystery item' }, phrase: { phrase: '', how: 'none' }, collected: {}, now: NOW });
  assert.equal(c.reach, null);
  assert.ok(c.gaps.some((g) => /No EU reach data/.test(g)) && c.gaps.some((g) => /No English search phrase/.test(g)));
  assert.ok(c.angles.length >= 2, 'calendar and open angles still apply');
  assert.match(c.targeting.control.why, /launch kit/);
  const md = cardMarkdown(c);
  for (const h of ['## 1. Core problem', '## 2. Who the ads reach', '## 3. Personas', '## 4. Buying triggers', '## 5. Objections', '## 6. Customer words', '## 7. What competitors', '## 8. Meta targeting', '## 9. Five ad angles', '## 10. Facts and assumptions', '## 11. Evidence log']) assert.ok(md.includes(h), h);
});

test('hookProblem: em dashes, placeholders, length, claim words and "you" with health or age are refused', () => {
  assert.equal(hookProblem('Slimy water bowl again?'), '');
  assert.equal(hookProblem('Slimy bowl — again?'), 'em dash');
  assert.equal(hookProblem('Slimy {object} again?'), 'placeholder');
  assert.match(hookProblem('Relieves pain fast'), /claim/);
  assert.equal(hookProblem('Your sleep, finally fixed tonight'), 'personal attribute');
  assert.equal(hookProblem('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'), 'too long');
  for (const [slot, byKey] of Object.entries(TEMPLATES)) for (const [k, list] of Object.entries(byKey)) for (const t of list) assert.ok(!/[—–]/.test(t), `${slot}.${k} has no em dash`);
});

test('shortLine fits the digest: at most 110 characters, starts with the persona', () => {
  const c = buildCard(cardInput());
  const l = shortLine(c);
  assert.ok(l.startsWith('dog owners') && Array.from(l).length <= 110, l);
});

// ---------------------------------------------------------------------------
// The batch step
// ---------------------------------------------------------------------------
test('audienceCard: end to end on fake vendors, under the day\'s budget, with the job\'s cache and the baseline kept', async () => {
  const store = new Map();
  const cache = { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) };
  const scCalls = [];
  const sc = scFetch({ calls: scCalls });
  const jv = jevFetch({ pick: (q, opts) => (/slimy|gross|scrubbing/i.test(q.instructions) ? opts[0] : /scared|stopped working|loud/.test(q.instructions) ? opts[2] : opts[4]) });
  const fetch = (url, init) => (String(url).startsWith('https://api.typesafe.ai') ? jv(url, init) : sc(url, init));
  const pick = { id: 'p1', key: 'research|p1', name: 'Dog water fountain', phrase: 'dog water fountain', markets: ['AU'], category: { main: 'Pets', sub: 'Fountains and feeders' }, ad_ids: ['111222333444'] };
  const r = await audienceCard(pick, { now: '2026-11-05T06:00:00Z', cache, env: { SCRAPECREATORS_API_KEY: 'k', TYPESAFE_API_KEY: 't' }, budget: { credits: 9, jevUsd: 1 }, fetch, sleep: noSleep, seedBaseline: null });
  assert.ok(r.card, r.missing.join('; '));
  assert.ok(r.credits_used > 0 && r.credits_used <= 9);
  assert.match(r.card.data.labelled_by, /^Jev/);
  assert.ok(r.card.drafts.some((d) => d.jev_p != null), 'Jev ranked the drafts');
  assert.ok(store.has(BASELINE_KEY) && store.get(BASELINE_KEY).data.n === 1);
  assert.ok(r.one_line && Array.from(r.one_line).length <= 110);
  assert.ok(r.markdown.includes('# Audience card: Dog water fountain'));
  const again = await audienceCard(pick, { now: '2026-11-05T07:00:00Z', cache, env: { SCRAPECREATORS_API_KEY: 'k' }, budget: { credits: 9 }, fetch: sc, sleep: noSleep, seedBaseline: null });
  assert.equal(again.credits_used, 0, 'the next day reads the cache');
  assert.equal(store.get(BASELINE_KEY).data.n, 1, 'an ad counts once in the baseline');
  assert.ok(again.missing.some((m) => /Jev off/.test(m)));
});

test('audienceCard never throws: a vendor that is down, no keys, no budget, a bad pick', async () => {
  const down = async () => { throw new Error('network down'); };
  const r = await audienceCard({ id: 'x', name: 'Thing', phrase: 'dog harness' }, { env: { SCRAPECREATORS_API_KEY: 'k' }, budget: { credits: 5 }, fetch: down, sleep: noSleep });
  assert.ok(r.card, 'a card from nothing');
  assert.ok(r.missing.some((m) => /stopped|failed|unreachable|outage/i.test(m)));
  const none = await audienceCard({ id: 'y', name: 'Other' }, {});
  assert.ok(none.card && none.missing.some((m) => /SCRAPECREATORS_API_KEY/.test(m)));
  const zero = await audienceCard({ id: 'z', name: 'Z', phrase: 'z z' }, { env: { SCRAPECREATORS_API_KEY: 'k' }, budget: { credits: 0 }, fetch: down });
  assert.ok(zero.missing.some((m) => /no credits left today/.test(m)));
  const bad = await audienceCard(null, {});
  assert.equal(bad.card, null);
  assert.ok(bad.missing.some((m) => /^error/.test(m)));
});

test('audienceCard keeps inside the daily job\'s 90 s: no paid call after the soft deadline, a short timeout per call', async () => {
  const calls = [];
  const slow = async (url, init) => {
    calls.push(String(url));
    await new Promise((r, j) => {
      const t = setTimeout(r, 400);
      if (init && init.signal) init.signal.addEventListener('abort', () => { clearTimeout(t); j(Object.assign(new Error('aborted'), { name: 'TimeoutError' })); });
    });
    return json({ success: true, credits_charged: 1, comments: [] });
  };
  const t0 = Date.now();
  const r = await audienceCard({ id: 'p', name: 'P', phrase: 'dog water fountain', ad_ids: ['111222333444'] }, { env: { SCRAPECREATORS_API_KEY: 'k' }, budget: { credits: 14 }, fetch: slow, sleep: noSleep,
    cache: memoryCache(), softMs: 300, callMs: 150, seedBaseline: null });
  const took = Date.now() - t0;
  assert.ok(r.card, 'a card all the same');
  assert.ok(took < 1500, `took ${took} ms`);
  assert.ok(calls.length <= 3, `${calls.length} calls before the deadline`);
  assert.ok(r.missing.some((m) => /stopped|failed|unreachable/.test(m)));
});

test('enrich: the board\'s own facts by primary key; subOf matches shortened subcategories', async () => {
  const seen = [];
  const db = async (sql, params) => {
    seen.push(sql);
    if (/FROM winners/.test(sql)) return [{ product_title: 'Hundegeschirr', product_url: 'https://pelsbarn.de/products/pelsbarn-hundegeschirr', store_url: 'https://pelsbarn.de/', data: JSON.stringify({ ad_copy: 'Kein Ziehen mehr' }) }];
    if (/FROM world_checks/.test(sql)) return [{ main: 'Pets', sub: 'Harnesses, leashes and collars', answers: JSON.stringify({ choices: { audience: { c: 'Dog owners' }, problemtype: { c: 'Pet behaviour' } } }) }];
    return [];
  };
  const p = await enrich({ key: 'eu|pelsbarn.de/products/pelsbarn-hundegeschirr', ad_ids: ['1457474386227844'] }, db);
  assert.equal(p.title, 'Hundegeschirr');
  assert.equal(p.ad, 'Kein Ziehen mehr');
  assert.equal(p.jev.audience, 'Dog owners');
  assert.equal(p.sub, 'Pets > Harnesses, leashes and collars');
  assert.ok(seen.every((s) => /WHERE \w+ = \?/.test(s)), 'primary-key lookups only');
  assert.equal(subOf('Pets', 'Beds'), 'Pets > Beds and blankets');
  assert.equal(subOf('', ''), '');
  const broken = await enrich({ key: 'k', ad_ids: ['1'] }, async () => { throw new Error('no such table'); });
  assert.equal(broken.title, '');
});

test('the day-1 seed: used when the cache has no baseline, ignored when it has one', async () => {
  const seed = addToBaseline(null, [readFbAd(FB_AD_MEN)]).state;
  const store = new Map();
  const cache = { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) };
  await audienceCard({ id: 'p', name: 'P', phrase: 'dog water fountain', ad_ids: ['111222333444'] }, { cache, env: { SCRAPECREATORS_API_KEY: 'k' }, budget: { credits: 5 }, fetch: scFetch(), sleep: noSleep, seedBaseline: seed });
  assert.equal(store.get(BASELINE_KEY).data.n, 2, 'seed ad + the new one');
});

test('addToBaseline counts each ad once and averages per ad', () => {
  const a = readFbAd(FB_AD);
  const m = readFbAd(FB_AD_MEN);
  const one = addToBaseline(null, [a]);
  const two = addToBaseline(one.state, [a, m]);
  assert.equal(two.state.n, 2);
  assert.ok(Math.abs(two.baseline.sexes.F + two.baseline.sexes.M + two.baseline.sexes.U - 1) < 1e-9);
});

test('audience.mjs arguments', () => {
  const o = parseArgs(['--picks', 'p.json', '--out', 'o', '--credits', '50', '--markets', 'nz,au', '--no-jev']);
  assert.deepEqual([o.picks, o.out, o.credits, o.markets, o.jev], ['p.json', 'o', 50, ['NZ', 'AU'], false]);
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['--picks', 'p', '--out', 'o', '--bogus']), /unknown/);
});
