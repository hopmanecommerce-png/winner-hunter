// lib/d1.mjs: the D1 REST client. Request shapes against a fake, and its SQL run for real on node:sqlite.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { d1Client, chunks, statements, migrate, UPSERT_SQL } from '../lib/d1.mjs';
import { d1Rest, memoryDb } from './helpers/sqlite-d1.mjs';
import { DatabaseSync } from 'node:sqlite';

const CFG = { accountId: 'acc1', databaseId: 'db1', token: 'tok-secret' };
const NOW = new Date(Date.UTC(2026, 9, 17, 1, 17));
const rec = (i, extra = {}) => ({ id: String(1000 + i), score: 80, verdict: 'winner', product_title: 'Dress ' + i, price: 49.95, keyword: 'dress', reach_eu: 20000, ad_age_days: 10, active_ads: 100, ...extra });
const ok = () => new Response(JSON.stringify({ success: true, errors: [], result: [{ success: true, results: [], meta: { changes: 1 } }] }), { status: 200 });
function fake(answers = []) {
  const calls = [];
  const doFetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return a ? a() : ok();
  };
  return { calls, doFetch };
}

test('request shape: URL, bearer token, upsert SQL with one JSON array parameter and the timestamp', async () => {
  const { calls, doFetch } = fake();
  const out = await d1Client(CFG, { doFetch }).upsertWinners([rec(1), rec(2)], NOW);
  assert.deepStrictEqual(out, { saved: 2 });
  const { url, init, body } = calls[0];
  assert.strictEqual(url, 'https://api.cloudflare.com/client/v4/accounts/acc1/d1/database/db1/query');
  assert.strictEqual(init.method, 'POST');
  assert.strictEqual(init.headers.Authorization, 'Bearer tok-secret');
  assert.strictEqual(body.sql, UPSERT_SQL);
  assert.match(body.sql, /json_each\(\?1\)/);
  assert.deepStrictEqual(JSON.parse(body.params[0]).map((r) => r.id), ['1001', '1002']);
  assert.strictEqual(body.params[1], NOW.toISOString());
});

test('chunks by count and by bytes; nothing to save sends nothing', async () => {
  const { calls, doFetch } = fake();
  assert.strictEqual((await d1Client(CFG, { doFetch, chunk: 200 }).upsertWinners(Array.from({ length: 450 }, (_, i) => rec(i)), NOW)).saved, 450);
  assert.deepStrictEqual(calls.map((c) => JSON.parse(c.body.params[0]).length), [200, 200, 50]);
  assert.deepStrictEqual(chunks([{ a: 'x'.repeat(100) }, { a: 'y'.repeat(100) }], 10, 150).map((c) => c.length), [1, 1]);
  calls.length = 0;
  assert.deepStrictEqual(await d1Client(CFG, { doFetch }).upsertWinners([], NOW), { saved: 0 });
  assert.strictEqual(calls.length, 0);
});

test('a failing chunk is retried once; then an error comes back, earlier chunks counted, never a throw', async () => {
  const bad = () => new Response(JSON.stringify({ success: false, errors: [{ code: 7500, message: 'no such table: winners' }] }), { status: 400 });
  const { calls, doFetch } = fake([ok, bad, bad]);
  const out = await d1Client(CFG, { doFetch, chunk: 2, retryMs: 0 }).upsertWinners(Array.from({ length: 5 }, (_, i) => rec(i)), NOW);
  assert.strictEqual(out.saved, 2);
  assert.match(out.error, /Cloudflare D1: no such table: winners/);
  assert.strictEqual(calls.length, 3);
  const net = fake([new Error('ECONNRESET'), new Error('ECONNRESET')]);
  assert.deepStrictEqual(await d1Client(CFG, { doFetch: net.doFetch, retryMs: 0 }).upsertWinners([rec(1)], NOW), { saved: 0, error: 'Cloudflare D1: ECONNRESET' });
});

test('a wrong token (401/403) is not retried; query() throws a clear error', async () => {
  const { calls, doFetch } = fake([() => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 403 })]);
  await assert.rejects(d1Client(CFG, { doFetch, retryMs: 0 }).query('SELECT 1'), /Cloudflare D1: Authentication error/);
  assert.strictEqual(calls.length, 1);
});

test('the real SQL on SQLite: insert, update, first_seen kept, older data never overwrites newer', async () => {
  const { db, doFetch } = d1Rest();
  const c = d1Client(CFG, { doFetch, retryMs: 0 });
  await c.upsertWinners([rec(1, { image_url: 'https://cdn.shopify.com/a.jpg' })], new Date('2026-10-16T01:00:00Z'));
  await c.upsertWinners([rec(1, { score: 90 })], new Date('2026-10-17T01:00:00Z'));
  let row = db.prepare('SELECT * FROM winners WHERE ad_id = ?').get('1001');
  assert.strictEqual(row.score, 90);
  assert.strictEqual(row.first_seen, '2026-10-16T01:00:00.000Z');
  assert.strictEqual(row.last_seen, '2026-10-17T01:00:00.000Z');
  assert.strictEqual(JSON.parse(row.data).score, 90);
  // an old import of the same ad (seen_at in the past): first_seen moves back, the newer data stays
  await c.upsertWinners([rec(1, { score: 60, seen_at: '2026-10-10T00:00:00.000Z' })], NOW);
  row = db.prepare('SELECT * FROM winners WHERE ad_id = ?').get('1001');
  assert.strictEqual(row.score, 90);
  assert.strictEqual(row.first_seen, '2026-10-10T00:00:00.000Z');
  assert.strictEqual(row.last_seen, '2026-10-17T01:00:00.000Z');
});

test('state, runs and new-winner count on SQLite', async () => {
  const { doFetch } = d1Rest();
  const c = d1Client(CFG, { doFetch, retryMs: 0 });
  assert.strictEqual(await c.getState('keyword_cursor'), null);
  await c.setState('keyword_cursor', { next: 42 }, NOW);
  await c.setState('keyword_cursor', { next: 44 }, NOW);
  assert.deepStrictEqual(JSON.parse(await c.getState('keyword_cursor')), { next: 44 });
  await c.saveRun({ id: 'r1', started_at: 'a', ads_checked: 10 });
  await c.saveRun({ id: 'r1', started_at: 'a', finished_at: 'b', ads_checked: 20, winners: 3, note: 'done' });
  assert.deepStrictEqual((await c.query('SELECT ads_checked, winners, finished_at FROM runs')).map((r) => ({ ...r })), [{ ads_checked: 20, winners: 3, finished_at: 'b' }]);
  await c.upsertWinners([rec(1, { reach_eu: 5000 }), rec(2, { reach_eu: 4999 }), rec(3, { active_ads: 74, reach_eu: 90000 }), rec(4, { ad_age_days: 6, reach_eu: 90000 }),
    rec(5, { ad_age_days: 43, reach_eu: 900000 }), rec(6, { active_ads: null, reach_eu: 90000 }), rec(7, { ad_age_days: 42, reach_eu: 21000 })], NOW);
  assert.strictEqual(await c.newWinnersSince(NOW.toISOString()), 2, 'only rows that pass the rules (75+ active ads, 7–42 days, 500+/day)');
  assert.strictEqual(await c.newWinnersSince('2027-01-01'), 0);
});

test('migration: split into statements, safe to apply twice', () => {
  const sql = fs.readFileSync(new URL('../worker/migrations/0001_init.sql', import.meta.url), 'utf8');
  const st = statements(sql);
  assert.ok(st.length >= 8 && st.every((s) => /^CREATE (TABLE|INDEX) IF NOT EXISTS/.test(s)));
  const db = memoryDb();
  for (const s of st) db.exec(s);
  assert.deepStrictEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name), ['ad_views', 'feedback', 'hidden', 'runs', 'sqlite_sequence', 'stars', 'state', 'winners'], 'all migrations, ad viewer cache, stars and feedback included');
});

test('migrate(): all files over the REST client, twice; the ADD COLUMN already there is skipped, other errors throw', async () => {
  const dir = new URL('../worker/migrations/', import.meta.url);
  const texts = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => fs.readFileSync(new URL(f, dir), 'utf8'));
  assert.ok(texts.length >= 2);
  const rest = d1Rest(new DatabaseSync(':memory:'));
  const c = d1Client(CFG, { doFetch: rest.doFetch, retryMs: 0 });
  const first = await migrate(c, texts);
  const calls = rest.calls.length;
  const second = await migrate(c, texts);
  assert.strictEqual(second, first - 1, 'second time: the ALTER TABLE is skipped');
  assert.strictEqual(rest.calls.length, calls * 2, 'a duplicate column is not retried');
  assert.ok(rest.db.prepare('PRAGMA table_info(runs)').all().some((r) => r.name === 'status'));
  await assert.rejects(migrate(c, ['CREATE TABLE nope (;']), /Cloudflare D1/);
  // saveRun writes the status
  await c.saveRun({ id: 'r1', started_at: 'a', finished_at: 'b', note: 'x', status: 'failed' });
  assert.strictEqual(rest.db.prepare('SELECT status FROM runs').get().status, 'failed');
});
