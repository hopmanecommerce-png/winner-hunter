// Collecting for the Problem Database: the Scrape Creators parsers (lib/problem-sources.mjs) on answers shaped like the
// vendor's docs (test/fixtures/problems/api-samples.json, made up), the client's hard credit cap and errors, and whole
// runs of problems-collect.mjs on a fake API and an in-memory D1: dry run, resume, dedupe, monthly cap, no names stored.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DEFAULT_MINUTES, collect, settingsOf } from '../problems-collect.mjs';
import { MAX_RUN_CREDITS, SOURCES, StopRun, isoOf, platformUrl, scrapeCreators } from '../lib/problem-sources.mjs';
import { loadBank, planFor } from '../lib/problem-bank.mjs';
import { memoryDb } from './helpers/sqlite-d1.mjs';
import { API_SAMPLES, restClient } from './helpers/problems.mjs';

const NOW = Date.UTC(2026, 9, 20, 8);
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const quiet = { log: () => {}, sleep: async () => {} };
const item = (over = {}) => ({ platform: 'reddit', mode: 'search', q: '"is there a way to" shower', sub: '', area: 'cleaning', lang: 'en', pattern: 'is there a way to', ...over });

test('Reddit: search posts, subreddit search (posts and matching comments), a post\'s comments with replies', () => {
  const s = SOURCES.reddit.parseSearch(API_SAMPLES['/v1/reddit/search'], item());
  assert.strictEqual(s.dropped, 1, 'the post without an id');
  assert.deepStrictEqual(s.items.map((x) => [x.id, x.kind, x.url, x.community, x.score, x.replies]), [
    ['reddit:t3_samps1', 'post', 'https://www.reddit.com/r/CleaningTips/comments/samps1/is_there_a_way/', 'CleaningTips', 120, 45],
    ['reddit:t3_samps2', 'post', 'https://www.reddit.com/r/pics/comments/samps2/', 'pics', 900, 12],
  ], 'an image post links to its Reddit page, not the image');
  assert.strictEqual(s.items[0].created_at, '2026-09-21T14:13:20.000Z');
  assert.strictEqual(s.items[0].body, 'I scrub every week and the limescale is back in two days. Nothing works.');
  const sub = SOURCES.reddit.parseSearch(API_SAMPLES['/v1/reddit/subreddit/search'], item({ mode: 'sub', sub: 'Dogs' }));
  assert.deepStrictEqual(sub.items.map((x) => [x.id, x.kind, x.parent_id, x.community]), [
    ['reddit:t3_sampt1', 'post', '', 'Dogs'], ['reddit:t1_sampt2', 'comment', 'reddit:t3_sampt9', 'Dogs']]);
  assert.strictEqual(sub.items[1].title, 'Dog hair on clothes', 'a comment carries its post\'s title');
  assert.strictEqual(sub.items[1].url, 'https://www.reddit.com/r/Dogs/comments/sampt9/other_post/sampt2/');
  const post = s.items[0];
  assert.deepStrictEqual(SOURCES.reddit.comments(post), { path: '/v1/reddit/post/comments', params: { url: post.url, trim: 'true' } });
  const c = SOURCES.reddit.parseComments(API_SAMPLES['/v1/reddit/post/comments'], post);
  assert.deepStrictEqual(c.items.map((x) => [x.id, x.parent_id, x.score]), [['reddit:t1_sampc1', 'reddit:t3_samps1', 30], ['reddit:t1_sampc2', 'reddit:t3_samps1', 9], ['reddit:t1_sampc3', 'reddit:t3_samps1', 2]]);
  assert.strictEqual(c.dropped, 1, '[deleted] is no text');
  assert.ok(c.items.every((x) => x.title === post.title));
  assert.deepStrictEqual(SOURCES.reddit.search(item({ mode: 'sub', sub: 'DIY', q: 'is there a way to' }), { timeframe: 'month' }),
    { path: '/v1/reddit/subreddit/search', params: { subreddit: 'DIY', query: 'is there a way to', sort: 'relevance', timeframe: 'month' } });
});

test('TikTok, YouTube, Threads, X and Bluesky: their answers in one shape; nested or flat, with or without ids', () => {
  const tt = SOURCES.tiktok.parseSearch(API_SAMPLES['/v1/tiktok/search/keyword'], item({ platform: 'tiktok', mode: 'topic', q: 'dog hair everywhere' }));
  assert.deepStrictEqual(tt.items.map((x) => [x.id, x.url, x.score, x.replies, x.created_at]), [
    ['tiktok:v_7000000000000000111', 'https://www.tiktok.com/@sample.creator/video/7000000000000000111', 5000, 900, '2026-09-10T00:26:40.000Z'],
    ['tiktok:v_7000000000000000112', 'https://www.tiktok.com/@sample.other/video/7000000000000000112', 300, 20, '2026-09-07T08:53:20.000Z']], 'create_time_utc first, else create_time');
  assert.ok(tt.items[0].rank > tt.items[1].rank, 'most comments first, to open');
  const ttc = SOURCES.tiktok.parseComments(API_SAMPLES['/v1/tiktok/video/comments'], tt.items[0]);
  assert.strictEqual(ttc.items[0].id, 'tiktok:c_7000000000000000999');
  assert.match(ttc.items[1].id, /^tiktok:h_[0-9a-f]{20}$/, 'no comment id: one made from the text and time');
  assert.strictEqual(ttc.items[0].url, tt.items[0].url, 'a comment links to its video: the share link holds the commenter\'s id');
  const again = SOURCES.tiktok.parseComments(API_SAMPLES['/v1/tiktok/video/comments'], tt.items[0]);
  assert.strictEqual(again.items[1].id, ttc.items[1].id, 'the same comment gets the same id next time');
  const yt = SOURCES.youtube.parseSearch(API_SAMPLES['/v1/youtube/search'], item({ platform: 'youtube', mode: 'topic' }));
  assert.deepStrictEqual(yt.items.map((x) => x.id), ['youtube:v_SAMPLEvid01', 'youtube:v_SAMPLEsht01'], 'videos and shorts');
  const ytc = SOURCES.youtube.parseComments(API_SAMPLES['/v1/youtube/video/comments'], yt.items[0]);
  assert.strictEqual(ytc.items[0].url, 'https://www.youtube.com/watch?v=SAMPLEvid01&lc=UgSAMPLEc1', 'lc= opens the video at the comment');
  assert.deepStrictEqual([ytc.items[0].score, ytc.items[0].replies], [210, 12]);
  const th = SOURCES.threads.parseSearch(API_SAMPLES['/v1/threads/search'], item({ platform: 'threads' }));
  assert.deepStrictEqual([th.items[0].url, th.items[0].score, th.items[0].replies], ['https://www.threads.com/@sample.threads/post/SAMPLEcode1', 77, 9]);
  assert.deepStrictEqual(SOURCES.threads.search(item({ q: '"so annoying" shoes' })).params, { query: 'so annoying shoes' }, 'Threads gets no quotes');
  const x = SOURCES.twitter.parseSearch(API_SAMPLES['/v1/twitter/search/posts'], item({ platform: 'twitter' }));
  assert.deepStrictEqual([x.items[0].id, x.items[0].created_at, x.items[0].score], ['twitter:2000000000000000001', '2026-10-01T18:50:27.000Z', 11]);
  const bs = SOURCES.bluesky.parseSearch(API_SAMPLES['/xrpc/app.bsky.feed.searchPosts'], item({ platform: 'bluesky', lang: 'nl' }));
  assert.deepStrictEqual([bs.items[0].url, bs.items[0].lang_hint], ['https://bsky.app/profile/sample.bsky.social/post/3sample0000a', 'nl']);
  assert.deepStrictEqual(SOURCES.bluesky.search(item({ platform: 'bluesky', lang: 'de', q: '"nervt" Hund' })).params, { q: '"nervt" Hund', lang: 'de', limit: '50', sort: 'top' });
  // Nothing in an odd answer: no crash, no rows.
  for (const p of Object.keys(SOURCES)) {
    assert.deepStrictEqual(SOURCES[p].parseSearch({ success: true }, item({ platform: p })), { items: [], dropped: 0 }, p);
    assert.deepStrictEqual(SOURCES[p].parseSearch(null, item({ platform: p })), { items: [], dropped: 0 }, p);
  }
});

test('links and times: only https links on the platform\'s own site; times from seconds, milliseconds or text', () => {
  assert.strictEqual(platformUrl('reddit', 'https://old.reddit.com/r/x/comments/1/'), 'https://old.reddit.com/r/x/comments/1/');
  for (const bad of ['http://www.reddit.com/r/x/', 'javascript:alert(1)', 'https://reddit.com.evil.test/r/x', 'https://evilreddit.com/x', 'not a url']) assert.strictEqual(platformUrl('reddit', bad), '', bad);
  assert.strictEqual(platformUrl('youtube', 'https://youtu.be/abc'), 'https://youtu.be/abc');
  const raw = { id: 'samp', author: 'x', title: '<script>alert(1)</script> Is there a way to', name: 't3_samp', url: 'javascript:alert(1)', subreddit: 'x', created_utc: 1790000000 };
  const r = SOURCES.reddit.parseSearch({ posts: [raw] }, item());
  assert.strictEqual(r.items[0].url, 'https://www.reddit.com/r/x/comments/samp/', 'a bad link: the post\'s own page');
  assert.strictEqual(isoOf(1790000000), '2026-09-21T14:13:20.000Z');
  assert.strictEqual(isoOf(1790000000000), '2026-09-21T14:13:20.000Z');
  assert.strictEqual(isoOf('Thu Oct 01 18:50:27 +0000 2026'), '2026-10-01T18:50:27.000Z');
  assert.strictEqual(isoOf(''), '');
  assert.strictEqual(isoOf('9 days ago'), '');
  assert.strictEqual(isoOf(4102444800), '', 'a date in the future is no date');
});

test('the client: never one request past the cap (retries count), 401 and 402 stop, the key goes to Scrape Creators only', async () => {
  const sent = [];
  let answer = () => json({ success: true, credits_charged: 1, credits_remaining: 41 });
  const doFetch = async (url, init) => { sent.push({ url, key: init.headers['x-api-key'] }); return answer(url); };
  const c = scrapeCreators({ key: 'sk-sample', maxCredits: 3, doFetch, sleep: async () => {} });
  for (let i = 0; i < 3; i++) assert.ok(await c.get('/v1/reddit/search', { query: 'q' }));
  await assert.rejects(c.get('/v1/reddit/search', { query: 'q' }), (e) => e instanceof StopRun && e.reason === 'cap');
  assert.strictEqual(sent.length, 3, 'the fourth request is never sent');
  assert.deepStrictEqual(c.stats(), { sent: 3, charged: 3, remaining: 41, errors: {}, cap: 3 });
  assert.strictEqual(sent[0].key, 'sk-sample');
  assert.match(sent[0].url, /^https:\/\/api\.scrapecreators\.com\/v1\/reddit\/search\?query=q$/);
  // 429 and 500 are retried, and each try counts.
  sent.length = 0;
  let n = 0;
  answer = () => (++n < 3 ? json({ error: 'busy' }, n === 1 ? 429 : 500) : json({ success: true, credits_charged: 1 }));
  const r = scrapeCreators({ key: 'k', maxCredits: 10, doFetch, sleep: async () => {} });
  assert.ok(await r.get('/v1/tiktok/search/keyword', { query: 'x' }));
  assert.strictEqual(r.stats().sent, 3);
  assert.deepStrictEqual(r.stats().errors, { 429: 1, 500: 1 });
  // A retry that would pass the cap is not sent either.
  n = 0;
  answer = () => json({ error: 'busy' }, 500);
  const tight = scrapeCreators({ key: 'k', maxCredits: 2, doFetch, sleep: async () => {} });
  await assert.rejects(tight.get('/v1/x', {}), (e) => e.reason === 'cap');
  assert.strictEqual(tight.stats().sent, 2);
  // 403 (the platform blocked it), 404 and a body that says it failed: null for that item, the run goes on.
  for (const [res, key] of [[json({ error: 'blocked' }, 403), '403'], [json({ error: 'gone' }, 404), '404'], [json({ success: false, credits_charged: 1 }), 'bad_json'], [json({ errorStatus: 404, message: 'not found', credits_charged: 1 }), '404']]) {
    const x = scrapeCreators({ key: 'k', maxCredits: 5, doFetch: async () => res.clone(), sleep: async () => {} });
    assert.strictEqual(await x.get('/v1/x', {}), null);
    assert.deepStrictEqual(x.stats().errors, { [key]: 1 });
  }
  for (const [status, reason] of [[401, 'bad_key'], [402, 'no_credits']]) {
    const x = scrapeCreators({ key: 'k', maxCredits: 5, doFetch: async () => json({ error: 'x' }, status), sleep: async () => {} });
    await assert.rejects(x.get('/v1/x', {}), (e) => e instanceof StopRun && e.reason === reason);
  }
  // Bluesky: no key in the request, whatever the client was given.
  const free = scrapeCreators({ key: 'sk-sample', base: SOURCES.bluesky.base, maxCredits: 1, doFetch, sleep: async () => {} });
  sent.length = 0;
  answer = () => json({ posts: [] });
  await free.get('/xrpc/app.bsky.feed.searchPosts', { q: 'x' });
  assert.deepStrictEqual([sent[0].key, new URL(sent[0].url).origin], [undefined, 'https://api.bsky.app']);
  assert.strictEqual(scrapeCreators({ maxCredits: 1e9 }).stats().cap, MAX_RUN_CREDITS);
});

test('settings: no run without a credit cap; the cap is at most 5000; a dry run needs no key and no cap', () => {
  assert.throws(() => settingsOf({}), /PROBLEM_MAX_CREDITS must be a whole number/);
  for (const bad of ['0', '-5', '1.5', 'lots', '']) assert.throws(() => settingsOf({ PROBLEM_MAX_CREDITS: bad }), /PROBLEM_MAX_CREDITS/, bad);
  assert.strictEqual(settingsOf({ PROBLEM_MAX_CREDITS: '9999' }).maxCredits, MAX_RUN_CREDITS);
  assert.strictEqual(settingsOf({ PROBLEM_MAX_CREDITS: '9999' }).capped, true);
  const d = settingsOf({ PROBLEM_DRY_RUN: '1' });
  assert.strictEqual(d.dryRun, true);
  const s = settingsOf({ PROBLEM_MAX_CREDITS: '100' });
  assert.deepStrictEqual([s.platforms, s.minutes, s.commentPosts, s.commentDays, s.timeframe, s.maxFree], [['reddit', 'youtube', 'tiktok'], DEFAULT_MINUTES, 2, 30, 'year', 60]);
  assert.throws(() => settingsOf({ PROBLEM_MAX_CREDITS: '5', PROBLEM_PLATFORMS: 'reddit,facebook' }), /unknown facebook/);
  assert.deepStrictEqual(settingsOf({ PROBLEM_MAX_CREDITS: '5', PROBLEM_SKIP_AREAS: 'back_neck_pain, sleep' }).skipAreas, ['back_neck_pain', 'sleep']);
});

/** A fake Scrape Creators + Bluesky: the sample answer of each path, and every request noted. */
function fakeApi({ fail = () => null } = {}) {
  const calls = [];
  const doFetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), key: init.headers['x-api-key'] });
    const f = fail(u.pathname, calls.length);
    if (f) return f;
    const j = API_SAMPLES[u.pathname];
    return j ? json(j) : json({ error: 'unknown path' }, 404);
  };
  return { calls, doFetch };
}
const setup = () => {
  const mem = memoryDb();
  return { mem, db: restClient(mem) };
};
const run = (db, env, api, now = NOW) => {
  let t = now;
  return collect({ db, settings: settingsOf({ SCRAPECREATORS_API_KEY: 'sk-sample', ...env }), doFetch: api.doFetch, now: () => (t += 1000), ...quiet });
};

test('a run spends at most its cap, keeps only what states a problem, stores no names, and says what it did', async () => {
  const { mem, db } = setup();
  const api = fakeApi();
  const s = await run(db, { PROBLEM_MAX_CREDITS: '12' }, api);
  const paid = api.calls.filter((c) => c.key);
  assert.strictEqual(paid.length, 12, 'exactly the cap');
  assert.ok(api.calls.every((c) => c.key === 'sk-sample'), 'reddit, youtube and tiktok: all Scrape Creators');
  assert.deepStrictEqual([s.status, s.health, s.credits_sent, s.cap, s.stopped], ['done', 'ok', 12, 12, 'credit cap (12)']);
  assert.ok(s.searches >= 4 && s.comment_pages >= 4);
  const rows = mem.prepare('SELECT * FROM problem_mentions ORDER BY id').all();
  assert.ok(rows.length >= 8);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes('reddit:t1_sampc1') && ids.includes('reddit:t1_sampc2'), 'comments that state a problem');
  assert.ok(!ids.includes('reddit:t1_sampc3'), '"nice bathroom" is no problem');
  assert.ok(!ids.includes('tiktok:c_7000000000000000998'), '"cute dog" either');
  assert.ok(ids.includes('reddit:t3_sampt1'), 'a post whose comments were read stays, with the time they were read');
  assert.ok(rows.find((r) => r.id === 'reddit:t3_sampt1').comments_at);
  const text = JSON.stringify(rows) + JSON.stringify(s) + JSON.stringify(mem.prepare('SELECT * FROM state').all());
  for (const name of ['sample_user_3', 'sample_user_4', 'sample.viewer', 'Sample Viewer', 'comment_author_id']) assert.ok(!text.includes(name), `no ${name} anywhere`);
  assert.ok(rows.every((r) => !r.author_hash || /^[0-9a-f]{16}$/.test(r.author_hash)));
  assert.ok(rows.every((r) => /^https:\/\//.test(r.url) && r.sample === 0 && r.run_id === s.started_at));
  const state = JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'problem_run'").get().value);
  assert.strictEqual(state.credits_sent, 12);
  assert.deepStrictEqual(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'problem_credits'").get().value), { month: '2026-10', used: 12 });
});

test('resumable: the next run goes on where the last stopped, and a post\'s comments are not paid for twice', async () => {
  const { mem, db } = setup();
  const plan = planFor(loadBank(), 'reddit', SOURCES.reddit.modes);
  const searched = (api) => api.calls.filter((c) => c.path.endsWith('/search')).map((c) => `${c.params.subreddit || ''}|${c.params.query}`);
  const expect = (from, n) => plan.slice(from, from + n).map((x) => `${x.mode === 'sub' ? x.sub : ''}|${x.q}`);
  const one = fakeApi();
  const first = await run(db, { PROBLEM_MAX_CREDITS: '6', PROBLEM_PLATFORMS: 'reddit' }, one);
  const cursor = JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'problem_cursor'").get().value);
  assert.deepStrictEqual(cursor, first.cursor);
  assert.deepStrictEqual(searched(one), expect(0, first.searches), 'the plan in order, nothing skipped');
  assert.strictEqual(cursor.reddit, first.searches);
  const two = fakeApi();
  const second = await run(db, { PROBLEM_MAX_CREDITS: '6', PROBLEM_PLATFORMS: 'reddit' }, two, NOW + 3600e3);
  assert.deepStrictEqual(searched(two), expect(first.searches, second.searches), 'it goes on where the first run stopped');
  const opened = (api) => api.calls.filter((c) => c.path === '/v1/reddit/post/comments').map((c) => c.params.url);
  assert.deepStrictEqual(opened(one), ['https://www.reddit.com/r/Dogs/comments/sampt1/anyone_else_struggle/']);
  assert.ok(!opened(two).includes(opened(one)[0]), 'found again an hour later: its comments were just read');
  // A month later they are read again.
  const three = fakeApi();
  await run(db, { PROBLEM_MAX_CREDITS: '6', PROBLEM_PLATFORMS: 'reddit' }, three, NOW + 31 * 864e5);
  assert.ok(three.calls.some((c) => c.path === '/v1/reddit/post/comments'));
  // Seen again: one row each, newer counts, the first area and query kept.
  const rows = mem.prepare("SELECT id, COUNT(*) AS n FROM problem_mentions GROUP BY id HAVING n > 1").all();
  assert.deepStrictEqual(rows, []);
});

test('a dry run calls nothing and writes nothing, and says what the next run would search and cost', async () => {
  const { mem, db } = setup();
  const api = fakeApi();
  const before = mem.prepare('SELECT COUNT(*) AS n FROM state').get().n;
  const s = await collect({ db, settings: settingsOf({ PROBLEM_DRY_RUN: '1', PROBLEM_MAX_CREDITS: '30' }), doFetch: api.doFetch, now: () => NOW, ...quiet });
  assert.strictEqual(api.calls.length, 0);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM problem_mentions').get().n, 0);
  assert.strictEqual(mem.prepare('SELECT COUNT(*) AS n FROM state').get().n, before);
  assert.strictEqual(s.status, 'dry run');
  assert.strictEqual(s.planned, 10, 'three credits a search (the search and two comment pages): ten searches in 30');
  assert.ok(s.planned_credits <= 30);
  assert.strictEqual(s.first.length, 10);
  assert.ok(s.first[0].startsWith('reddit: r/HomeImprovement '));
  // Without D1 at all (no Cloudflare secrets), a dry run still plans.
  const alone = await collect({ db: null, settings: settingsOf({ PROBLEM_DRY_RUN: '1' }), now: () => NOW, ...quiet });
  assert.strictEqual(alone.planned_credits, 99, 'the default cap of 100, three credits a search');
});

test('the monthly cap, a wrong key, used-up credits and a changed API end the run in time, and red when they should', async () => {
  const { mem, db } = setup();
  await db.setState('problem_credits', { month: '2026-10', used: 95 }, NOW);
  const api = fakeApi();
  const s = await run(db, { PROBLEM_MAX_CREDITS: '50', PROBLEM_MONTHLY_CREDITS: '100' }, api);
  assert.strictEqual(s.cap, 5, 'only 5 left this month');
  assert.strictEqual(api.calls.length, 5);
  assert.deepStrictEqual(JSON.parse(mem.prepare("SELECT value FROM state WHERE key = 'problem_credits'").get().value), { month: '2026-10', used: 100 });
  const next = await run(db, { PROBLEM_MAX_CREDITS: '50', PROBLEM_MONTHLY_CREDITS: '100' }, fakeApi(), Date.UTC(2026, 10, 2));
  assert.strictEqual(next.cap, 50, 'a new month');
  for (const [status, alert] of [[401, /API key is wrong/], [402, /credits are used up/]]) {
    const x = await run(setup().db, { PROBLEM_MAX_CREDITS: '10' }, fakeApi({ fail: () => json({ error: 'x' }, status) }));
    assert.strictEqual(x.health, 'failed');
    assert.match(x.alert, alert);
    assert.strictEqual(x.credits_sent, 1, 'stopped at the first answer');
  }
  // Answers in a shape the parsers do not know: red, so it is fixed before credits go to waste.
  const odd = await run(setup().db, { PROBLEM_MAX_CREDITS: '10' }, fakeApi({ fail: () => json({ success: true, data: { things: [] } }) }));
  assert.strictEqual(odd.health, 'failed');
  assert.match(odd.alert, /not one item read/);
  // A platform blocking some requests: yellow, the run goes on.
  const some = await run(setup().db, { PROBLEM_MAX_CREDITS: '10' }, fakeApi({ fail: (p, n) => (n % 4 === 0 ? json({ error: 'blocked' }, 403) : null) }));
  assert.strictEqual(some.health, 'warning');
  assert.strictEqual(some.credits_sent, 10);
  await assert.rejects(collect({ db, settings: settingsOf({ PROBLEM_MAX_CREDITS: '5' }), doFetch: api.doFetch, now: () => NOW, ...quiet }), /No SCRAPECREATORS_API_KEY/);
});

test('time and areas: a run stops in time; skipped areas (health complaints) are never searched', async () => {
  const { db } = setup();
  let t = NOW;
  const api = fakeApi();
  const s = await collect({ db, settings: settingsOf({ SCRAPECREATORS_API_KEY: 'k', PROBLEM_MAX_CREDITS: '500', PROBLEM_MINUTES: '1' }), doFetch: api.doFetch, now: () => (t += 20000), ...quiet });
  assert.match(s.stopped, /^time \(1 min\)/);
  assert.ok(s.credits_sent < 20);
  const skip = fakeApi();
  const plan = await collect({ db: null, settings: settingsOf({ PROBLEM_DRY_RUN: '1', PROBLEM_MAX_CREDITS: '3000', PROBLEM_SKIP_AREAS: 'back_neck_pain,sleep' }), doFetch: skip.doFetch, now: () => NOW, ...quiet });
  assert.ok(!('back_neck_pain' in plan.by_area) && !('sleep' in plan.by_area));
  assert.ok('pets' in plan.by_area);
});

test('Bluesky is free: its calls never count as credits, and run out on their own cap', async () => {
  const { mem, db } = setup();
  const api = fakeApi();
  const s = await run(db, { PROBLEM_MAX_CREDITS: '4', PROBLEM_PLATFORMS: 'bluesky,reddit', PROBLEM_MAX_FREE_CALLS: '2' }, api);
  assert.strictEqual(api.calls.filter((c) => c.path.startsWith('/xrpc/')).length, 2);
  assert.ok(api.calls.filter((c) => c.path.startsWith('/xrpc/')).every((c) => c.key === undefined));
  assert.strictEqual(s.credits_sent, 4);
  assert.strictEqual(s.free_calls, 2);
  assert.ok(mem.prepare("SELECT id FROM problem_mentions WHERE platform = 'bluesky'").get());
});

test('the collector and its workflow never print a quote: the log is counts only', async () => {
  const { db } = setup();
  const lines = [];
  await collect({ db, settings: settingsOf({ SCRAPECREATORS_API_KEY: 'k', PROBLEM_MAX_CREDITS: '8' }), doFetch: fakeApi().doFetch, now: () => NOW, log: (m) => lines.push(m), sleep: async () => {} });
  const log = lines.join('\n');
  for (const t of ['limescale', 'dog hair', 'sample_user', 'Sample Viewer']) assert.ok(!log.includes(t), t);
  assert.match(log, /searches, \d+ comment pages, 8 of 8 credits sent/);
  const src = fs.readFileSync(new URL('../problems-collect.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /log\([^)]*\b(body|title|text)\b/, 'no text of a post goes to the log');
});
