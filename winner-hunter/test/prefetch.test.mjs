// prefetch.mjs: the board's ads are opened ahead of time, so "▶ Bekijk ad" is served from D1 at once.
import test from 'node:test';
import assert from 'node:assert';
import { prefetch } from '../prefetch.mjs';
import { handle } from '../worker/src/app.mjs';
import { d1Client } from '../lib/d1.mjs';
import { d1Rest } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

const RAW = { name: 'Shop', body: 'Nu 50% korting.', media: [{ type: 'image', src: 'https://scontent.xx.fbcdn.net/p.jpg' }], cards: [], link: null };

async function setup() {
  const env = await seededEnv();
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const opened = [];
  const open = async (url) => {
    const id = new URL(url).searchParams.get('id');
    opened.push(id);
    if (id === '9003') throw new Error('page crashed at ' + url);
    return Object.assign({}, RAW, { library_id: id });
  };
  return { env, db, opened, open };
}

test('prefetch opens every ad on the board (not hidden, not fresh), best first, and stores it; errors are logged without the token', async () => {
  const { env, db, opened, open } = await setup();
  env.db.prepare("INSERT INTO hidden (ad_id, status, at) VALUES ('9001', 'seen', ?)").run(new Date(NOW).toISOString());
  env.db.prepare('INSERT INTO ad_views (ad_id, json, fetched_at) VALUES (?, ?, ?)').run('9002', '{}', new Date(NOW - 3600e3).toISOString());
  env.db.prepare('INSERT INTO ad_views (ad_id, json, fetched_at) VALUES (?, ?, ?)').run('9004', '{}', new Date(NOW - 20 * 3600e3).toISOString());
  const logs = [];
  const r = await prefetch({ db, token: 'SECRET', open, now: NOW, log: (l) => logs.push(l) });
  const board = (await (await handle(new Request('https://wh.test/api/ads?limit=100', { headers: { cookie: await cookieOf(env) } }), env, { now: NOW })).json()).ads.map((a) => a.id);
  assert.strictEqual(r.todo, board.length - 1, 'every ad on the board but the fresh one');
  assert.ok(!opened.includes('9001'), 'hidden: skipped');
  assert.ok(!opened.includes('9002'), 'stored 1 hour ago: skipped');
  assert.ok(opened.includes('9004'), 'stored 20 hours ago: refreshed');
  assert.ok(!opened.includes('9300') && !opened.includes('9100'), 'fails a rule / second ad of a product: not on the board');
  assert.deepStrictEqual([r.ok, r.failed], [r.todo - 1, 1]);
  assert.deepStrictEqual(logs, ['  9003: page crashed at https://www.facebook.com/ads/archive/render_ad/?id=9003&access_token=***']);
  const row = env.db.prepare('SELECT json, fetched_at FROM ad_views WHERE ad_id = ?').get('9000');
  assert.strictEqual(row.fetched_at, new Date(NOW).toISOString());
  assert.strictEqual(JSON.parse(row.json).body, 'Nu 50% korting.');
  // the board now serves it straight from D1: no browser
  const res = await handle(new Request('https://wh.test/api/ad/9000', { headers: { cookie: await cookieOf(env) } }), Object.assign(env, { META_TOKEN: 'x', BROWSER: {} }), {
    now: NOW + 3600e3, launch: async () => { throw new Error('launched'); },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).cached, true);
  // a second run right after has nothing left but the failed one
  assert.strictEqual((await prefetch({ db, token: 'SECRET', open, now: NOW, log: () => {} })).todo, 1);
});

async function cookieOf(env) {
  const res = await handle(new Request('https://wh.test/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '1.1.1.1' }, body: 'pin=' + env.BOARD_PIN }), env, { now: NOW });
  return res.headers.get('set-cookie').split(';')[0];
}
