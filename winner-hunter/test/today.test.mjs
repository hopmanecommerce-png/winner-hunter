// The Today tab's API (worker/src/today.mjs) through the board's own handler (app.mjs), on an in-memory D1.
import test from 'node:test';
import assert from 'node:assert';
import { handle } from '../worker/src/app.mjs';
import { bannerOf, todayPost } from '../worker/src/today.mjs';
import { d1Binding, memoryDb } from './helpers/sqlite-d1.mjs';

const PIN = '482913';
const NOW = Date.parse('2026-11-06T02:00:00Z'); // 09:00 in Bangkok
const BASE = 'https://board.test';

async function env() {
  const db = memoryDb();
  db.prepare("INSERT INTO daily_runs (day, status, started_at, finished_at, picks, pool, summary, digest_md, digest_csv) VALUES ('2026-11-05', 'ok', 'a', 'b', 1, 100, '{}', 'old', 'old')").run();
  db.prepare(`INSERT INTO daily_runs (day, status, started_at, finished_at, picks, pool, summary, digest_md, digest_csv) VALUES ('2026-11-06', 'short', '2026-11-05T23:01:00Z', '2026-11-05T23:09:00Z', 2, 24000,
    '{"stages":[{"stage":"collect","ok":true,"ms":4000}],"passed_over":{"score":20000},"backtest":{"n":109,"auc":0.66}}', 'Winners for Fri 6 Nov 2026: 2 picks\\n1. A: … {{BOARD}}/#today/a-1\\n', 'day,pick\\n2026-11-06,1,{{BOARD}}/#today/a-1\\n')`).run();
  const ins = db.prepare('INSERT INTO daily_picks (day, product_key, rank, id, score, level, title, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run('2026-11-06', 'world|a.test/products/a', 1, 'a-1', 71, 3, 'Cooling pillow', JSON.stringify({ name: 'Cooling pillow', category: 'Sleep and comfort', pillars: { proof: 0.9 }, why: '#1 in its store', ad_ids: ['w1'] }));
  ins.run('2026-11-06', 'tiktok|9', 2, 't-9', 60, 2, 'Muslin blanket', JSON.stringify({ name: 'Muslin blanket', category: 'Home' }));
  const e = { DB: d1Binding(db), BOARD_PIN: PIN, db };
  const login = await handle(new Request(BASE + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE }, body: 'pin=' + PIN }), e, { now: NOW });
  e.cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  return e;
}
const get = (e, p, auth = true) => handle(new Request(BASE + p, { headers: auth ? { cookie: e.cookie } : {} }), e, { now: NOW });
const post = (e, body, auth = true) => handle(new Request(BASE + '/api/today', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, ...(auth ? { cookie: e.cookie } : {}) }, body: JSON.stringify(body) }), e, { now: NOW });

test('GET /api/today: the newest day with its picks in order, the run, 14 days and a banner for a short day', async () => {
  const e = await env();
  const r = await get(e, '/api/today');
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.ready, true);
  assert.strictEqual(j.day, '2026-11-06');
  assert.deepStrictEqual(j.picks.map((p) => [p.rank, p.key, p.name]), [[1, 'world|a.test/products/a', 'Cooling pillow'], [2, 'tiktok|9', 'Muslin blanket']]);
  assert.strictEqual(j.picks[0].pillars.proof, 0.9);
  assert.strictEqual(j.run.status, 'short');
  assert.deepStrictEqual(j.run.passed_over, { score: 20000 });
  assert.deepStrictEqual(j.days.map((d) => d.day), ['2026-11-06', '2026-11-05']);
  assert.strictEqual(j.banner.level, 'amber');
  const old = await (await get(e, '/api/today?day=2026-11-05')).json();
  assert.strictEqual(old.day, '2026-11-05');
  assert.strictEqual((await get(e, '/api/today', false)).status, 401);
});

test('POST /api/today: keep, reject or launch with a reason; null takes it back; only a pick of that day', async () => {
  const e = await env();
  const r = await post(e, { day: '2026-11-06', key: 'world|a.test/products/a', decision: 'keep', reason: 'my niche' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual({ ...e.db.prepare("SELECT decision, reason FROM daily_picks WHERE product_key = 'world|a.test/products/a'").get() }, { decision: 'keep', reason: 'my niche' });
  assert.strictEqual((await post(e, { day: '2026-11-06', key: 'world|a.test/products/a', decision: null })).status, 200);
  assert.deepStrictEqual({ ...e.db.prepare("SELECT decision, reason FROM daily_picks WHERE product_key = 'world|a.test/products/a'").get() }, { decision: null, reason: null });
  assert.strictEqual((await post(e, { day: '2026-11-06', key: 'world|nope', decision: 'keep' })).status, 404);
  assert.strictEqual((await post(e, { day: '6 Nov', key: 'world|a.test/products/a', decision: 'keep' })).status, 400);
  assert.strictEqual((await post(e, { day: '2026-11-06', key: 'world|a.test/products/a', decision: 'buy' })).status, 400);
  assert.strictEqual((await post(e, { day: '2026-11-06', key: 'evil|x', decision: 'keep' })).status, 400);
  assert.strictEqual((await post(e, { day: '2026-11-06', key: 'world|a.test/products/a', decision: 'keep' }, false)).status, 401);
  const wrongOrigin = await handle(new Request(BASE + '/api/today', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.test', cookie: e.cookie }, body: '{}' }), e, { now: NOW });
  assert.strictEqual(wrongOrigin.status, 403);
});

test('GET /api/today/digest: Markdown or CSV as a file, with this board\'s own address in the links', async () => {
  const e = await env();
  const md = await get(e, '/api/today/digest?day=2026-11-06');
  assert.strictEqual(md.status, 200);
  assert.match(md.headers.get('content-type'), /text\/markdown/);
  assert.match(md.headers.get('content-disposition'), /winners-2026-11-06\.md/);
  assert.match(await md.text(), /https:\/\/board\.test\/#today\/a-1/);
  const csv = await get(e, '/api/today/digest?day=2026-11-06&format=csv');
  assert.match(await csv.text(), /https:\/\/board\.test\/#today\/a-1/);
  assert.strictEqual((await get(e, '/api/today/digest?day=2026-01-01')).status, 404);
});

test('before the migration: the tab says it is not ready instead of failing', async () => {
  const db = memoryDb();
  db.exec('DROP TABLE daily_picks; DROP TABLE daily_runs;');
  const e = { DB: d1Binding(db), BOARD_PIN: PIN };
  const login = await handle(new Request(BASE + '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE }, body: 'pin=' + PIN }), e, { now: NOW });
  e.cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const j = await (await get(e, '/api/today')).json();
  assert.deepStrictEqual([j.ready, j.picks.length], [false, 0]);
  assert.strictEqual((await get(e, '/api/today/digest')).status, 404);
  assert.strictEqual((await todayPost(e, { day: '2026-11-06', key: 'world|x', decision: 'keep' }, NOW).catch(() => ({ status: 503 }))).status, 503);
});

test('the banner: red when today failed or has not run by 07:00 in Bangkok, amber when short, none when all is well', () => {
  const at = (h) => Date.parse(`2026-11-06T${String(h - 7).padStart(2, '0')}:30:00Z`); // h o'clock in Bangkok
  assert.strictEqual(bannerOf([{ day: '2026-11-05', status: 'ok', picks: 8 }], at(8)).level, 'red');
  assert.strictEqual(bannerOf([{ day: '2026-11-05', status: 'ok', picks: 8 }], at(7) - 3600e3), null, 'before 07:00 it is not late yet');
  assert.match(bannerOf([{ day: '2026-11-06', status: 'failed', error: 'collect: D1 500' }], at(8)).text, /failed: collect: D1 500/);
  assert.strictEqual(bannerOf([{ day: '2026-11-06', status: 'ok', picks: 7 }], at(8)), null);
  assert.strictEqual(bannerOf([], at(8)), null);
});
