// worker/src/app.mjs: PIN flow, /api/ads, /api/hide, CSV, security headers and injection attempts,
// on an in-memory D1 (node:sqlite) with the real migration and the real upsert.
import { TRAITS, AD_TRAITS, CHOICES, AD_CHOICES } from '../worker/src/jev-questions.mjs';
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { handle, makeToken, csvCell, toCsv, boardAlert, PREFETCH_SQL, tasteOf, fitOf, fitWhy, riskOf, ipKey, products } from '../worker/src/app.mjs';
import { landingUrl, cleanAd } from '../worker/src/adview.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const ORIGIN = 'https://winner-hunter.example.workers.dev';
const req = (path, init = {}) => new Request(ORIGIN + path, init);
const call = (env, path, init, now = NOW) => handle(req(path, init), env, { html: HTML, now });

async function loggedIn(env) {
  const cookie = `__Host-wh=${await makeToken(env.BOARD_PIN, NOW)}`;
  return {
    get: (path, now) => call(env, path, { headers: { cookie } }, now),
    post: (path, body, headers = {}) => call(env, path, { method: 'POST', headers: Object.assign({ cookie, 'content-type': 'application/json', origin: ORIGIN }, headers), body: typeof body === 'string' ? body : JSON.stringify(body) }),
    cookie,
  };
}
const login = (env, pin, ip = '1.2.3.4') => call(env, '/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip }, body: 'pin=' + encodeURIComponent(pin) });
// Jev's answer for every seeded EU product, under its advertiser + title as world-check.mjs saves it: Pets for the
// search word "hond", Clothing for "dress"; p: more answers (e.g. { sizing: 0.9 }) for the ads in `ids`.
function jevFor(env, p = {}, ids = []) {
  const key = "'eu|' || advertiser_page_id || '|' || lower(trim(COALESCE(NULLIF(product_title, ''), ad_id)))";
  env.db.prepare(`INSERT OR IGNORE INTO world_checks (product_key, people, animals, gymwear, physical, category, input, checked_at, version, main, sub, answers)
    SELECT ${key}, 0.01, 0.01, 0.01, 0.99, CASE keyword WHEN 'hond' THEN 'Pets' ELSE 'Clothing' END, 'photo', 'x', 2, CASE keyword WHEN 'hond' THEN 'Pets' ELSE 'Clothing' END, '', '{}' FROM winners`).run();
  for (const id of ids) {
    const answers = JSON.stringify({ p: { people: 0.01, animals: 0.01, gymwear: 0.01, physical: 0.99, ...p }, choices: {} });
    env.db.prepare(`UPDATE world_checks SET answers = ?, people = ?, animals = ? WHERE product_key = (SELECT ${key} FROM winners WHERE ad_id = ?)`).run(answers, p.people ?? 0.01, p.animals ?? 0.01, id);
  }
  env.db.prepare("UPDATE state SET updated_at = ? WHERE key = 'last_run'").run('jev ' + Math.random()); // the board reads its tables again
}

test('no BOARD_PIN secret: the board stays closed', async () => {
  const env = await seededEnv();
  const res = await call(Object.assign({}, env, { BOARD_PIN: '' }), '/');
  assert.strictEqual(res.status, 503);
  assert.match(await res.text(), /BOARD_PIN/);
});

test('PIN flow: PIN screen first, wrong PIN refused, right PIN sets a 90-day HttpOnly Secure SameSite=Lax cookie', async () => {
  const env = await seededEnv();
  const first = await call(env, '/');
  assert.strictEqual(first.status, 200);
  const page = await first.text();
  assert.match(page, /<form method="post" action="\/login">/);
  assert.doesNotMatch(page, /api\/ads/, 'no board before the PIN');
  const wrong = await login(env, '000000');
  assert.strictEqual(wrong.status, 401);
  assert.match(await wrong.text(), /Wrong PIN/);
  assert.strictEqual(wrong.headers.get('set-cookie'), null);
  const right = await login(env, '482913');
  assert.strictEqual(right.status, 303);
  assert.strictEqual(right.headers.get('location'), '/');
  const sc = right.headers.get('set-cookie');
  assert.match(sc, /^__Host-wh=\d+\.[A-Za-z0-9_-]+; Path=\/; Max-Age=7776000; HttpOnly; Secure; SameSite=Lax$/);
  const board = await call(env, '/', { headers: { cookie: sc.split(';')[0] } });
  const html = await board.text();
  assert.match(html, /<title>Winner Hunter<\/title>/);
  assert.doesNotMatch(html, /__NONCE__/);
  const nonce = board.headers.get('content-security-policy').match(/'nonce-([^']+)'/)[1];
  assert.ok(html.includes(`<script nonce="${nonce}">`) && html.includes(`<style nonce="${nonce}">`));
});

test('the cookie is required and checked: missing, forged, expired, other PIN', async () => {
  const env = await seededEnv();
  assert.strictEqual((await call(env, '/api/ads')).status, 401);
  assert.strictEqual((await call(env, '/export.csv')).status, 401);
  assert.strictEqual((await call(env, '/api/hide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ad_id":"9000","status":"seen"}' })).status, 401);
  const exp = Math.floor(NOW / 1000) + 1000;
  for (const cookie of [`__Host-wh=${exp}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, `__Host-wh=${await makeToken('111111', NOW)}`, 'wh=' + (await makeToken('482913', NOW))]) {
    assert.strictEqual((await call(env, '/api/ads', { headers: { cookie } })).status, 401, cookie);
  }
  const old = `__Host-wh=${await makeToken('482913', NOW - 91 * 864e5)}`;
  assert.strictEqual((await call(env, '/api/ads', { headers: { cookie: old } })).status, 401, 'expired after 90 days');
  const ok = `__Host-wh=${await makeToken('482913', NOW - 89 * 864e5)}`;
  assert.strictEqual((await call(env, '/api/ads', { headers: { cookie: ok } })).status, 200);
});

test('10 wrong PINs from one IP: locked for 15 minutes (other IPs not)', async () => {
  const env = await seededEnv();
  for (let i = 0; i < 10; i++) assert.strictEqual((await login(env, '1' + i)).status, 401);
  assert.strictEqual((await login(env, '482913')).status, 429, 'even the right PIN waits');
  assert.strictEqual((await login(env, '482913', '9.9.9.9')).status, 303);
  const later = await handle(req('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '1.2.3.4' }, body: 'pin=482913' }), env, { html: HTML, now: NOW + 16 * 60000 });
  assert.strictEqual(later.status, 303);
});

test('PIN tries sent at the same moment: each is counted before its PIN is compared, so no more than 10 are compared', async () => {
  const env = await seededEnv();
  env.DB = slowly(env.DB); // a few ms per query, as a round trip to D1 takes: the 30 tries overlap
  const got = (await Promise.all(Array.from({ length: 30 }, (_, i) => login(env, '7' + i)))).map((r) => r.status);
  assert.deepStrictEqual([got.filter((s) => s === 401).length, got.filter((s) => s === 429).length], [10, 20]);
  assert.strictEqual((await login(env, '482913')).status, 429);
});

test('PIN lockout: an IPv6 address counts by its /64, so a phone cannot hop to a new address for 10 more tries', async () => {
  assert.strictEqual(ipKey('2001:db8:1:2::1'), '2001:db8:1:2::/64');
  assert.strictEqual(ipKey('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.strictEqual(ipKey('2001:db8::7'), '2001:db8:0:0::/64');
  assert.strictEqual(ipKey('::ffff:1.2.3.4'), '1.2.3.4');
  assert.strictEqual(ipKey('1.2.3.4'), '1.2.3.4');
  assert.strictEqual(ipKey(''), 'unknown');
  const env = await seededEnv();
  for (let i = 0; i < 10; i++) assert.strictEqual((await login(env, '1' + i, `2001:db8:1:2:${i}::${i + 1}`)).status, 401);
  assert.strictEqual((await login(env, '482913', '2001:db8:1:2:ffff::1')).status, 429, 'another address in the same /64');
  assert.strictEqual((await login(env, '482913', '2001:db8:1:3::1')).status, 303, 'the next /64 is someone else');
});

test('PIN lockout fails closed: a try that cannot be counted is not compared, not even the right PIN', async () => {
  const env = await seededEnv();
  const prepare = env.DB.prepare;
  env.DB.prepare = (sql) => (/pin_tries/.test(sql) ? { bind: () => ({ first: async () => { throw new Error('D1 down'); }, run: async () => { throw new Error('D1 down'); } }) } : prepare(sql));
  for (const pin of ['000000', '482913']) {
    const res = await login(env, pin);
    assert.strictEqual(res.status, 503, pin);
    assert.match(await res.text(), /cannot check PINs right now/);
    assert.strictEqual(res.headers.get('set-cookie'), null);
  }
  const { DatabaseSync } = await import('node:sqlite');
  const { d1Binding } = await import('./helpers/sqlite-d1.mjs');
  assert.strictEqual((await login({ DB: d1Binding(new DatabaseSync(':memory:')), BOARD_PIN: '482913' }, '482913')).status, 503, 'no table yet: no login either');
  assert.strictEqual((await (await loggedIn(env)).get('/api/ads')).status, 200, 'a phone with its cookie still opens the board');
});

test('PIN lockout stays cheap: a wrong PIN reads no table, old windows are removed through the index', async () => {
  const env = await seededEnv();
  for (let i = 0; i < 300; i++) env.db.prepare('INSERT INTO pin_tries (ip, n, since) VALUES (?, 1, ?)').run('10.0.' + i, NOW - (i % 2 ? 20 : 5) * 60000);
  env.DB.log.length = 0;
  assert.strictEqual((await login(env, '000000')).status, 401);
  assert.ok(env.DB.log.every((l) => !/FROM state|LIKE/.test(l.sql)), 'nothing in state, no LIKE');
  for (const l of env.DB.log) {
    const plan = env.db.prepare('EXPLAIN QUERY PLAN ' + l.sql).all(...l.args).map((x) => x.detail).join('; ');
    assert.doesNotMatch(plan, /SCAN/, `${l.sql}: ${plan}`);
  }
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM pin_tries').get().n, 151, 'the 150 windows that are over are gone; the 150 open ones and this one stay');
  assert.strictEqual((await login(env, '482913')).status, 303);
  assert.strictEqual(env.db.prepare("SELECT COUNT(*) AS n FROM pin_tries WHERE ip = '1.2.3.4'").get().n, 0, 'the right PIN clears its own tries');
});

test('the cookie: BOARD_SECRET keys it next to the PIN; without it the PIN-only cookies keep working; no cookie lives longer than 90 days', async () => {
  const env = await seededEnv();
  const ads = (cookie, e = env) => call(e, '/api/ads', { headers: { cookie: '__Host-wh=' + cookie } });
  // No BOARD_SECRET (as deployed today): the cookies phones have still open the board.
  assert.strictEqual((await ads(await makeToken('482913', NOW))).status, 200);
  // A cookie made with the PIN alone can carry any expiry: one valid for longer than the board gives is refused.
  assert.strictEqual((await ads(await makeToken('482913', NOW + 365 * 864e5))).status, 401);
  // With BOARD_SECRET: the login gives a cookie keyed by it; a PIN-only cookie (or one under another secret) is refused.
  const sec = Object.assign({}, env, { BOARD_SECRET: 's3cret-' + 'x'.repeat(32) });
  const res = await login(sec, '482913', '5.5.5.5');
  assert.strictEqual(res.status, 303);
  const fromLogin = res.headers.get('set-cookie').match(/^__Host-wh=([^;]+)/)[1];
  assert.strictEqual(fromLogin, await makeToken('482913', NOW, sec.BOARD_SECRET));
  assert.strictEqual((await ads(fromLogin, sec)).status, 200);
  assert.strictEqual((await ads(await makeToken('482913', NOW), sec)).status, 401, 'PIN-only cookie: refused once the secret is set');
  assert.strictEqual((await ads(fromLogin, Object.assign({}, sec, { BOARD_SECRET: 'another-' + 'y'.repeat(32) }))).status, 401, 'a new secret takes every cookie back');
  assert.strictEqual((await ads(fromLogin, Object.assign({}, sec, { BOARD_PIN: '111111' }))).status, 401, 'so does a new PIN');
});

test('/api/ads: All is the default view (no Top 20): ads that pass the rules, one per product, by reach per day; no score', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const res = await s.get('/api/ads');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const j = await res.json();
  assert.strictEqual(j.view, 'all');
  assert.strictEqual(j.ads.length, 27);
  assert.strictEqual((await (await s.get('/api/ads?view=top')).json()).view, 'all', 'old Top links show All');
  assert.ok(j.ads.every((a) => a.ads >= 75 && a.age >= 7 && a.age <= 42 && a.rpd >= 500));
  assert.ok(j.ads.every((a) => !('score' in a) && !('win' in a) && !('checklist' in a)), 'no score on the board');
  for (let i = 1; i < j.ads.length; i++) assert.ok(j.ads[i - 1].rpd >= j.ads[i].rpd, 'sorted by reach per day');
  const ids = j.ads.map((a) => a.id);
  assert.ok(!ids.includes('9100'), 'second ad of the same product collapsed');
  assert.ok(!ids.includes('9300'), 'too young');
  assert.ok(!ids.includes('9200'), '272 reach a day');
  assert.deepStrictEqual(Object.keys(j.counts), ['all', 'inbox', 'fresh', 'starred', 'made', 'hidden', 'world', 'eu']);
  assert.strictEqual(j.counts.inbox, 27, 'nothing decided yet: everything is in the inbox');
  assert.strictEqual(j.counts.all, 27);
  assert.strictEqual(j.last_run.new_winners, 23);
  const a = j.ads.find((x) => x.id === '9002');
  assert.strictEqual(a.store_photo, true);
  assert.strictEqual(a.img, 'https://cdn.shopify.com/s/files/1/p2.jpg?width=400');
  assert.strictEqual(a.products, null, 'store size unknown in the sample');
  assert.strictEqual(a.zh, '连衣裙', 'search word dress → Chinese 1688 term');
});

test('alert banner: red for a failed run or a Meta token expiring within 7 days; yellow for warnings; an old EU run is fine', async () => {
  const H = 3600e3;
  const iso = (ms) => new Date(ms).toISOString();
  const env = await seededEnv();
  const s = await loggedIn(env);
  const setState = (key, v, at = NOW) => env.db.prepare('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(v), iso(at));
  const alertOf = async (now) => (await (await s.get('/api/ads', now)).json()).alert;
  assert.strictEqual(await alertOf(), null, 'healthy, 6 hours ago: just the last-run line');
  setState('last_run', { status: 'done', health: 'ok', finished_at: iso(NOW - 6 * H) });
  setState('token_expires_at', { at: iso(NOW + 30 * 864e5) });
  assert.strictEqual(await alertOf(), null, 'token fine for 30 more days');
  setState('last_run', { status: 'meta-block', health: 'warning', alert: '1 waarschuwing(en) / 1 warning(s): Meta hourly limit', finished_at: iso(NOW - 6 * H) });
  assert.deepStrictEqual(await alertOf(), { level: 'yellow', text: '1 waarschuwing(en) / 1 warning(s): Meta hourly limit' });
  setState('last_run', { status: 'done', health: 'failed', alert: 'Run mislukt: 0 ads gecheckt (Meta token?) / Run failed: 0 ads checked (Meta token?)', finished_at: iso(NOW - 6 * H) });
  assert.deepStrictEqual(await alertOf(), { level: 'red', text: 'Run mislukt: 0 ads gecheckt (Meta token?) / Run failed: 0 ads checked (Meta token?)' });
  setState('last_run', { status: 'done', health: 'ok', finished_at: iso(NOW - 37 * H) });
  assert.strictEqual(await alertOf(), null, 'the EU hunt only runs by hand: no recent run is no problem');
  setState('last_run', { status: 'done', health: 'failed', alert: 'old failure', finished_at: iso(NOW - 37 * H) });
  assert.strictEqual(await alertOf(), null, 'and an old failure no longer shows');
  setState('last_run', { status: 'running', started_at: iso(NOW - 40 * H) }, NOW - 39 * H);
  assert.deepStrictEqual(await alertOf(), { level: 'red', text: 'EU-run staat stil / The EU run has stopped moving' }, 'a run stuck on "running" for 40 hours');
  setState('last_run', { status: 'running', started_at: iso(NOW - 1 * H) });
  setState('token_expires_at', { at: iso(NOW + 3.5 * 864e5) });
  assert.deepStrictEqual(await alertOf(), { level: 'red', text: 'Meta token verloopt over 3 dagen / Meta token expires in 3 days' });
  setState('last_run', { status: 'done', health: 'warning', finished_at: iso(NOW - 40 * H) });
  setState('token_expires_at', { at: iso(NOW - 864e5) });
  assert.deepStrictEqual(await alertOf(), { level: 'red', text: 'Meta token verlopen / Meta token expired' }, 'red wins over yellow');
  // never-expiring token, no run yet, broken state
  assert.strictEqual(boardAlert(null, { at: null }, NOW), null);
  assert.strictEqual(boardAlert({ health: 'ok', finished_at: 'garbage' }, null, NOW), null);
  // two problems at once: both are in the text, each "Dutch / English" (the board shows the English of both)
  assert.deepStrictEqual(boardAlert({ status: 'running', started_at: iso(NOW - 40 * H), updated_at: iso(NOW - 39 * H) }, { at: iso(NOW + 2.5 * 864e5) }, NOW),
    { level: 'red', text: 'EU-run staat stil / The EU run has stopped moving · Meta token verloopt over 2 dagen / Meta token expires in 2 days' });
  const shown = new Function(`${HTML.match(/^const english = .*$/m)[0]}; return english;`)();
  assert.strictEqual(shown('EU-run staat stil / The EU run has stopped moving · Meta token verloopt over 2 dagen / Meta token expires in 2 days'), 'The EU run has stopped moving · Meta token expires in 2 days');
  assert.strictEqual(shown('Run failed: 0 ads checked'), 'Run failed: 0 ads checked', 'a text without a translation stays whole');
});

test('/api/ads?view=all: everything that passes the rules, filters, sort, paging and totals', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const all = await (await s.get('/api/ads?view=all&limit=100')).json();
  assert.strictEqual(all.total, 27, '25 products + nasty + stale (41 days today), duplicate collapsed');
  assert.ok(all.ads.some((a) => a.id === '9500') && all.ads.find((a) => a.id === '9500').age === 41, 'age today = age when seen + days since');
  for (let i = 1; i < all.ads.length; i++) assert.ok(all.ads[i - 1].rpd >= all.ads[i].rpd, 'sorted by reach per day');
  const page2 = await (await s.get('/api/ads?view=all&limit=10&offset=10')).json();
  assert.strictEqual(page2.ads.length, 10);
  assert.strictEqual(page2.ads[0].id, all.ads[10].id);
  const r2500 = await (await s.get('/api/ads?view=all&rpd=2500&limit=100')).json();
  assert.ok(r2500.ads.length > 0 && r2500.ads.every((a) => a.rpd >= 2500));
  const q = await (await s.get('/api/ads?view=all&q=pillow')).json();
  assert.deepStrictEqual(q.ads.map((a) => a.title).sort(), ['Bamboo Pillow', 'Ergonomic Knee Pillow', 'Heated Neck Pillow']);
  const r10k = await (await s.get('/api/ads?view=all&rpd=10000&limit=100')).json();
  assert.deepStrictEqual(r10k.ads.map((a) => a.id), ['9500', '9000']);
  const byAds = await (await s.get('/api/ads?view=all&sort=ads&limit=3')).json();
  assert.deepStrictEqual(byAds.ads.map((a) => a.ads), [104, 103, 102]);
  const byScore = await (await s.get('/api/ads?view=all&sort=score&limit=100')).json();
  assert.deepStrictEqual(byScore.ads.map((a) => a.id), all.ads.map((a) => a.id), 'no score sort: reach per day');
  const big = await (await s.get('/api/ads?view=all&limit=100000')).json();
  assert.ok(big.ads.length <= 100, 'limit capped');
});

test('/api/hide: seen and rejected leave All, Hidden shows them, none brings them back; star', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const top = async () => (await (await s.get('/api/ads')).json()).ads.map((a) => a.id);
  const first = (await top())[2];
  assert.notStrictEqual(first, '9000');
  assert.strictEqual((await s.post('/api/hide', { ad_id: first, status: 'seen' })).status, 200);
  const after = await top();
  assert.ok(!after.includes(first));
  assert.strictEqual(after.length, 26);
  // hiding the best ad of a product hides its duplicate too
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9000', status: 'rejected' })).status, 200);
  const all = await (await s.get('/api/ads?view=all&limit=100')).json();
  assert.ok(!all.ads.some((a) => a.id === '9000' || a.id === '9100'));
  const hidden = await (await s.get('/api/ads?view=all&hidden=1')).json();
  assert.deepStrictEqual(hidden.ads.map((a) => a.hidden).sort(), ['rejected', 'seen']);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9100', status: 'none' })).status, 200, 'unhide via any ad of the product');
  assert.ok((await top()).includes('9000'));
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'starred' })).status, 200);
  const starred = await (await s.get('/api/ads?view=starred')).json();
  assert.deepStrictEqual(starred.ads.map((a) => a.id), ['9003']);
  assert.strictEqual(starred.counts.starred, 1);
  assert.ok((await (await s.get('/api/ads')).json()).ads.find((a) => a.id === '9003').star, 'starred stays in All with its star');
  // seen, reject and undo leave the star alone; only unstarred takes it off
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'seen' })).status, 200);
  const kept = await (await s.get('/api/ads?view=starred')).json();
  assert.deepStrictEqual(kept.ads.map((a) => [a.id, a.star, a.hidden]), [['9003', true, 'seen']], 'seen keeps the star');
  assert.strictEqual(kept.counts.starred, 1);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'none' })).status, 200);
  assert.ok((await (await s.get('/api/ads')).json()).ads.find((a) => a.id === '9003').star, 'undo keeps the star');
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'unstarred' })).status, 200);
  const none = await (await s.get('/api/ads?view=starred')).json();
  assert.deepStrictEqual([none.ads.length, none.counts.starred], [0, 0]);
  // a starred product that ages out of the rules stays in ★ (marked as out), and only once
  env.db.prepare("INSERT INTO stars (ad_id, at) VALUES ('9900', 'x'), ('9000', 'x')").run();
  const out = await (await s.get('/api/ads?view=starred')).json();
  assert.deepStrictEqual(out.ads.map((a) => [a.id, a.pass]).sort(), [['9000', true], ['9900', false]]);
  assert.strictEqual(out.counts.starred, 2);
  assert.ok(!(await (await s.get('/api/ads?view=all&limit=100')).json()).ads.some((a) => a.id === '9900'), 'never in All');
});

test('/api/ads?view=made: every product marked ✓ Made ad, the last one first, out of the rules too', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const made = async (q = '') => (await s.get('/api/ads?view=made' + q)).json();
  const empty = await made();
  assert.deepStrictEqual([empty.view, empty.total, empty.counts.made], ['made', 0, 0]);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'seen' })).status, 200);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9004', status: 'rejected' })).status, 200);
  const ago = (days) => new Date(NOW - days * 864e5).toISOString();
  // made earlier: an aged-out product, and a product through its second ad (9100 → 9000)
  env.db.prepare("INSERT INTO hidden (ad_id, status, at) VALUES ('9900', 'seen', ?), ('9100', 'seen', ?)").run(ago(3), ago(2));
  const j = await made();
  assert.deepStrictEqual(j.ads.map((a) => [a.id, a.made_at, a.pass, a.hidden]), [
    ['9003', new Date(NOW).toISOString(), true, 'seen'],
    ['9000', ago(2), true, 'seen'],
    ['9900', ago(3), false, 'seen'],
  ], 'the last one first; once per product; out of the rules too; rejected not');
  assert.strictEqual(j.counts.made, 3);
  assert.ok(!(await (await s.get('/api/ads?view=all&limit=100')).json()).ads.some((a) => a.id === '9003'), 'not in Browse');
  assert.ok((await (await s.get('/api/ads?view=all&hidden=1')).json()).ads.some((a) => a.id === '9003'), 'in Approved & rejected');
  assert.strictEqual((await (await s.get('/api/ads?view=all&limit=100')).json()).ads.find((a) => a.id === '9005').made_at, '', 'no date before you make it');
  const csv = await s.get('/export.csv?view=made');
  assert.match(csv.headers.get('content-disposition'), /winners-made-/);
  const rows = (await csv.text()).trim().split('\r\n');
  assert.strictEqual(rows.length, 4, 'header + 3');
  assert.ok(rows[0].includes(',status,made_at,') && rows[1].includes(',seen,' + new Date(NOW).toISOString() + ','), 'with the day you made it');
  // Undo takes it off ✓
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'none' })).status, 200);
  const after = await made();
  assert.deepStrictEqual([after.ads.map((a) => a.id), after.counts.made], [['9000', '9900'], 2]);
});

test('/api/ads?view=inbox: not seen, rejected or kept (★), best first; Inbox zero when all are decided', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const inbox = async () => (await s.get('/api/ads?view=inbox&limit=100')).json();
  const j = await inbox();
  assert.strictEqual(j.view, 'inbox');
  assert.strictEqual(j.total, 27);
  assert.strictEqual((await (await s.get('/api/ads?view=inbox')).json()).ads.length, 20, '20 at a time');
  for (let i = 1; i < j.ads.length; i++) assert.ok(j.ads[i - 1].rpd >= j.ads[i].rpd, 'best first');
  const [a, b, c] = j.ads.map((x) => x.id);
  await s.post('/api/hide', { ad_id: a, status: 'seen' });
  await s.post('/api/hide', { ad_id: b, status: 'rejected' });
  await s.post('/api/hide', { ad_id: c, status: 'starred' });
  const after = await inbox();
  assert.strictEqual(after.total, 25, 'an old star no longer keeps a product out: the board has no ★ any more');
  assert.ok(!after.ads.some((x) => [a, b].includes(x.id)), 'decided products leave the inbox');
  assert.strictEqual(after.counts.inbox, 25);
  assert.ok((await (await s.get('/api/ads?view=all&limit=100')).json()).ads.some((x) => x.id === c), 'a kept product is still in Browse');
  await s.post('/api/hide', { ad_id: c, status: 'unstarred' });
  assert.strictEqual((await inbox()).total, 25, 'undo Keep: back in the inbox');
  for (const x of (await inbox()).ads) await s.post('/api/hide', { ad_id: x.id, status: 'seen' });
  const zero = await inbox();
  assert.deepStrictEqual([zero.total, zero.ads.length, zero.counts.inbox, zero.counts.fresh], [0, 0, 0, 0], 'Inbox zero');
});

test('/api/ads: counts.fresh = inbox products found in the last day', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const j = await (await s.get('/api/ads?view=inbox&limit=100')).json();
  const fresh = j.ads.filter((a) => NOW - Date.parse(a.first_seen) < 864e5);
  assert.strictEqual(j.counts.fresh, fresh.length);
  if (fresh.length) {
    await s.post('/api/hide', { ad_id: fresh[0].id, status: 'seen' });
    assert.strictEqual((await (await s.get('/api/ads?view=inbox')).json()).counts.fresh, fresh.length - 1);
  }
});

test('feedback: every decision is logged, reasons and a note added after, undo takes it out; /api/learned sums it up', async () => {
  const env = await seededEnv();
  jevFor(env);
  const s = await loggedIn(env);
  const inbox = async () => (await s.get('/api/ads?view=inbox&limit=100')).json();
  const fb = () => env.db.prepare("SELECT ad_id, action, reasons, note, keyword, title, currency FROM feedback WHERE action != 'general' ORDER BY id").all();
  const [a, b, c] = (await inbox()).ads;
  assert.strictEqual((await s.post('/api/feedback', { ad_id: a.id, reasons: ['price'] })).status, 404, 'decide first');
  await s.post('/api/hide', { ad_id: a.id, status: 'rejected' });
  await s.post('/api/hide', { ad_id: b.id, status: 'starred' });
  await s.post('/api/hide', { ad_id: c.id, status: 'seen' });
  assert.deepStrictEqual(fb().map((f) => [f.ad_id, f.action, f.reasons]), [[a.id, 'rejected', '[]'], [b.id, 'keep', '[]'], [c.id, 'seen', '[]']]);
  assert.strictEqual(fb()[0].keyword, a.kw, "the product's facts are copied in");
  assert.strictEqual((await s.post('/api/feedback', { ad_id: a.id, reasons: ['price', 'niche', 'wow', '<script>'] })).status, 200);
  assert.strictEqual((await s.post('/api/feedback', { ad_id: a.id, note: '  Te duur\u0000 voor NL  ' })).status, 200);
  assert.deepStrictEqual([fb()[0].reasons, fb()[0].note], ['["price","niche"]', 'Te duur  voor NL'], 'only reasons that fit a reject; note cleaned');
  await s.post('/api/feedback', { ad_id: b.id, reasons: ['wow', 'price'] });
  assert.strictEqual(fb()[1].reasons, '["wow"]');
  // a new decision replaces the old one; undo takes it out
  await s.post('/api/hide', { ad_id: c.id, status: 'rejected' });
  assert.deepStrictEqual(fb().filter((f) => f.ad_id === c.id).map((f) => f.action), ['rejected']);
  await s.post('/api/hide', { ad_id: c.id, status: 'none' });
  await s.post('/api/hide', { ad_id: b.id, status: 'unstarred' });
  assert.deepStrictEqual(fb().map((f) => f.ad_id), [a.id]);
  assert.strictEqual((await s.post('/api/feedback', { general: 'Meer dierenproducten graag' })).status, 200);
  assert.strictEqual((await s.post('/api/feedback', { general: '   ' })).status, 400);
  assert.strictEqual((await s.post('/api/feedback', { ad_id: '../x', reasons: [] })).status, 400);
  const l = await (await s.get('/api/learned')).json();
  assert.strictEqual(l.decisions, 1);
  assert.deepStrictEqual(l.by_action, { rejected: 1, keep: 0, seen: 0 });
  assert.deepStrictEqual(l.reasons.bad.map((x) => [x.key, x.label, x.n]), [['price', 'Too expensive', 1], ['niche', 'Not my niche', 1]]);
  // a: Stale Old Winner, found with "hond": Jev says Pets. One "Not my niche" and no yes: Pets goes down.
  assert.deepStrictEqual(l.niches, [{ niche: 'Pets', good: 0, bad: 1, weight: 0.67 }], 'the niche is Jev\'s category, not the search word');
  assert.strictEqual(l.approval_rate, 0.33);
  assert.deepStrictEqual(l.max_prices, [], 'one "too expensive" is not a limit yet');
  assert.strictEqual(fb()[0].currency, 'EUR', 'the price comes with its currency');
  assert.deepStrictEqual(l.notes.map((n) => n.note), ['Meer dierenproducten graag', 'Te duur  voor NL']);
  assert.strictEqual((await s.get('/api/learned')).status, 200);
  assert.strictEqual((await call(env, '/api/learned')).status, 401, 'PIN needed');
});

test('notes: one per product, before or after deciding; notes on the same store come back; a note is not a decision', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const notes = () => env.db.prepare("SELECT ad_id, note, store FROM feedback WHERE action = 'note' ORDER BY id").all();
  assert.deepStrictEqual(await (await s.get('/api/note?ad_id=9001')).json(), { note: '', others: [] });
  assert.strictEqual((await s.post('/api/note', { ad_id: '9001', note: '  Gratis\u0000 verzending  ' })).status, 200);
  assert.strictEqual((await s.post('/api/note', { ad_id: '9001', note: 'Competitor: 3 video ads, UGC' })).status, 200);
  assert.deepStrictEqual(notes().map((n) => [n.ad_id, n.note]), [['9001', 'Competitor: 3 video ads, UGC']], 'one note per product: a new one replaces it');
  assert.strictEqual(notes()[0].store, 'https://shop1.test/', "the product's facts are copied in");
  assert.strictEqual((await (await s.get('/api/note?ad_id=9001')).json()).note, 'Competitor: 3 video ads, UGC');
  // another product of the same store shows it
  const o = await (await s.get('/api/note?ad_id=9400')).json();
  assert.deepStrictEqual([o.note, o.others.map((n) => [n.title, n.note])], ['', [['Posture Corrector Pro', 'Competitor: 3 video ads, UGC']]]);
  // deciding and undo keep the note; it does not count as a decision or a niche; 🧠 lists it
  await s.post('/api/hide', { ad_id: '9001', status: 'rejected' });
  await s.post('/api/hide', { ad_id: '9001', status: 'none' });
  assert.strictEqual(notes().length, 1);
  const l = await (await s.get('/api/learned')).json();
  assert.deepStrictEqual([l.decisions, l.niches], [0, []]);
  assert.deepStrictEqual(l.notes.map((n) => [n.action, n.note]), [['note', 'Competitor: 3 video ads, UGC']]);
  // empty takes it out; bad input
  assert.strictEqual((await s.post('/api/note', { ad_id: '9001', note: '   ' })).status, 200);
  assert.deepStrictEqual(notes(), []);
  assert.strictEqual((await s.post('/api/note', { ad_id: '../x', note: 'x' })).status, 400);
  assert.strictEqual((await s.post('/api/note', { ad_id: '123456', note: 'x' })).status, 404);
  assert.strictEqual((await s.get('/api/note?ad_id=')).status, 400);
  assert.strictEqual((await call(env, '/api/note?ad_id=9001')).status, 401, 'PIN needed');
});

test('tasteOf / fitOf: niches are Jev categories, only "Not my niche" counts against one, against your usual rate; prices per currency', () => {
  const t = tasteOf([
    { action: 'seen', reasons: '[]', niche: 'Pets', keyword: 'dress', store: 'https://a.com', price: 20, currency: 'EUR' },
    { action: 'keep', reasons: '["niche"]', niche: 'Pets', store: 'https://a.com', price: 25, currency: 'EUR' },
    { action: 'rejected', reasons: '["niche"]', niche: 'Home', store: 'https://b.com', price: 30, currency: 'EUR' },
    { action: 'rejected', reasons: '["niche","ad"]', niche: 'Home', store: 'https://b.com', price: 31, currency: 'EUR' },
    { action: 'rejected', reasons: '["price","store"]', niche: 'Pets', store: 'https://www.Bad.com/x', price: 60, currency: 'EUR' },
    { action: 'rejected', reasons: '["price"]', niche: '', store: '', price: 45, currency: 'eur' },
    { action: 'rejected', reasons: '["price"]', niche: 'Tech', price: 3000, currency: 'JPY' },
    { action: 'rejected', reasons: '["price"]', niche: 'Tech', price: 99, currency: '' },
    { action: 'rejected', reasons: 'not json', niche: 'Fish', store: '', price: null },
    { action: 'note', reasons: '["niche"]', niche: 'Fish' },
  ]);
  // 2 yes (Pets) against 2 "Not my niche" (Home): a usual rate of 3 in 6. Price, store and weak-ad rejects say nothing about a niche.
  assert.strictEqual(t.rate, 0.5);
  assert.deepStrictEqual(Object.fromEntries(t.weights), { Pets: 1.5, Home: 0.5 });
  assert.deepStrictEqual([...t.blocked.keys()], ['bad.com']);
  assert.deepStrictEqual(Object.fromEntries(t.maxPrice), { EUR: 45 }, 'per currency; one JPY and one without a currency are no limit');
  const fit = (r) => fitOf(r, t);
  assert.strictEqual(fit({ jev: { main: 'Pets' }, price: 10, currency: 'EUR' }), 1.5);
  assert.strictEqual(fit({ jev: { main: 'Pets' }, keyword: 'cat', price: 50, currency: 'EUR' }), 0.75, 'too expensive: half; the search word plays no part');
  assert.strictEqual(fit({ jev: { main: 'Home' }, price: 10, currency: 'EUR' }), 0.5);
  assert.strictEqual(fit({ jev: { main: 'Garden' }, price: 10, currency: 'EUR' }), 1, 'no opinion yet');
  assert.strictEqual(fit({ price: 3000, currency: 'JPY' }), 1, 'yen are not compared with a limit in euros');
  assert.strictEqual(fit({ price: 90, currency: 'AUD' }), 1);
  assert.strictEqual(fit({ price: null, currency: 'EUR' }), 0.75, 'no price while there is a limit: not let through silently');
  assert.strictEqual(fit({ price: null, currency: '' }), 0.75);
  assert.strictEqual(fit({ price: null, currency: 'AUD' }), 1, 'no limit in its currency');
  assert.deepStrictEqual(fitWhy({ jev: { main: 'Home' }, price: 50, currency: 'EUR' }, t).why, [{ text: 'Not your niche: Home', x: 0.5 }, { text: 'Too expensive for you: EUR 45 and up', x: 0.5 }]);
  assert.deepStrictEqual(fitWhy({ price: 0, currency: 'EUR' }, t).why, [{ text: 'No price to check against your price limit', x: 0.75 }]);
  // Approving everything teaches no niche: each is near your usual rate (the old keyword weights went to × 3 for all).
  const all = tasteOf(['Pets', 'Home', 'Pets', 'Home', 'Pets', 'Home'].map((niche) => ({ action: 'seen', reasons: '[]', niche })));
  assert.ok([...all.weights.values()].every((w) => w > 0.9 && w < 1.1), JSON.stringify([...all.weights]));
  assert.deepStrictEqual([tasteOf([]).maxPrice.size, tasteOf([]).weights.size], [0, 0]);
});

test('inbox learns: a niche you approve goes up, one you call "Not my niche" goes down, a bad store leaves (and comes back with unblock)', async () => {
  const env = await seededEnv();
  jevFor(env);
  const s = await loggedIn(env);
  const inbox = async () => (await s.get('/api/ads?view=inbox&limit=100')).json();
  const before = await inbox();
  const last = [...before.ads].reverse().find((x) => x.jev.main === 'Clothing'); // the lowest Clothing product (search word "dress")
  assert.strictEqual(last.kw, 'dress');
  const at = (list, id) => list.ads.findIndex((x) => x.id === id);
  // Two Clothing products approved, two Pets products rejected as "Not my niche" (decided on another phone: not hidden here)
  const clothing = before.ads.filter((x) => x.jev.main === 'Clothing' && x.id !== last.id).slice(0, 2).map((x) => x.id);
  const pets = before.ads.filter((x) => x.jev.main === 'Pets').slice(1, 3).map((x) => x.id);
  for (const id of clothing) env.db.prepare("INSERT INTO feedback (ad_id, action, reasons, keyword, at) VALUES (?, 'seen', '[]', 'hond', 'x')").run(id);
  for (const id of pets) env.db.prepare("INSERT INTO feedback (ad_id, action, reasons, keyword, at) VALUES (?, 'rejected', '[\"niche\"]', 'dress', 'x')").run(id);
  const after = await inbox();
  const l = after.ads.find((x) => x.id === last.id);
  assert.ok(at(after, last.id) < at(before, last.id), 'a liked niche moves up');
  assert.deepStrictEqual([l.fit, l.niche], [1.5, { name: 'Clothing', w: 1.5 }]);
  assert.deepStrictEqual(l.ranked.why, [{ text: 'Your niche: Clothing', x: 1.5 }]);
  const stale = after.ads.find((x) => x.id === '9500');
  assert.deepStrictEqual([stale.fit, stale.ranked.why[0].text], [0.5, 'Not your niche: Pets'], 'the search word that found them plays no part');
  // A reject for another reason says nothing about the niche
  const other = before.ads.find((x) => x.kw !== last.kw && x.store && x.store !== last.store && !pets.includes(x.id));
  await s.post('/api/hide', { ad_id: other.id, status: 'rejected' });
  await s.post('/api/feedback', { ad_id: other.id, reasons: ['store'] });
  const host = new URL(other.store).hostname.replace(/^www\./, '');
  const blocked = await inbox();
  assert.ok(!blocked.ads.some((x) => x.store && new URL(x.store).hostname.replace(/^www\./, '') === host), 'nothing from a bad store');
  assert.strictEqual(blocked.counts.inbox, blocked.total);
  assert.deepStrictEqual((await (await s.get('/api/learned')).json()).blocked.map((x) => x.store), [host]);
  assert.strictEqual((await s.post('/api/feedback', { unblock: host })).status, 200);
  assert.deepStrictEqual((await (await s.get('/api/learned')).json()).blocked, []);
});

test('🧠 learns from every decision, not the newest 5000: a store blocked long ago is listed, so it can be brought back', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  await s.post('/api/hide', { ad_id: '9007', status: 'rejected' });
  await s.post('/api/feedback', { ad_id: '9007', reasons: ['store'] });
  env.db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5100) INSERT INTO feedback (ad_id, action, reasons, at) SELECT 'old' || i, 'seen', '[]', 'x' FROM n").run();
  const inShop7 = async () => (await (await s.get('/api/ads?view=inbox&limit=100')).json()).ads.filter((a) => a.store === 'https://shop7.test/').length;
  assert.strictEqual(await inShop7(), 0, 'the Inbox keeps it out');
  const l = await (await s.get('/api/learned')).json();
  assert.deepStrictEqual([l.decisions, l.blocked], [5101, [{ store: 'shop7.test', n: 1 }]], 'and 🧠 says so');
  assert.deepStrictEqual(await (await s.post('/api/feedback', { unblock: 'shop7.test' })).json(), { ok: true, unblocked: 1 });
  assert.deepStrictEqual((await (await s.get('/api/learned')).json()).blocked, []);
  await s.post('/api/hide', { ad_id: '9007', status: 'none' }); // its own product back from Rejected
  assert.strictEqual(await inShop7(), 1);
});

test("Jev's risks rank a product lower in the Inbox (never below × 0.2) and say why; an EU product people or pets take leaves the Inbox", async () => {
  assert.strictEqual(riskOf(null), null);
  assert.deepStrictEqual(riskOf({ p: { people: 0.6, animals: 0.7 } }).x, 0.2, '0.3 × 0.3 is below the floor');
  assert.deepStrictEqual(riskOf({ p: { kids: 0.5, bulky: 0.49 } }), { x: 0.8, why: [{ k: 'kids', label: 'For children', x: 0.8 }], red: [] }, '0.5 is a yes, 0.49 is not');
  const env = await seededEnv();
  jevFor(env);
  jevFor(env, { sizing: 0.9, medical: 0.7 }, ['9000']); // × 0.5 × 0.5
  jevFor(env, { people: 0.95 }, ['9002']); // a supplement
  jevFor(env, { sizing: 0.9, medical: 0.8, brand: 0.6, restricted: 0.7, kids: 0.9, skin: 0.9 }, ['9005']); // 0.04: × 0.2
  jevFor(env, { fragile: 0.6, electric: 0.4 }, ['9001']); // × 0.8
  const s = await loggedIn(env);
  const inbox = await (await s.get('/api/ads?view=inbox&limit=100')).json();
  const all = await (await s.get('/api/ads?view=all&limit=100')).json();
  const by = (list, id) => list.ads.find((a) => a.id === id);
  assert.ok(!inbox.ads.some((a) => a.id === '9002'), 'people take it: not in the EU Inbox');
  assert.deepStrictEqual([inbox.total, inbox.counts.inbox, all.total, all.counts.all], [26, 26, 27, 27], 'Browse still lists it');
  assert.deepStrictEqual(by(all, '9002').jev.flags, ['people'], 'with its tag');
  assert.deepStrictEqual(by(inbox, '9000').ranked, { x: 0.25, why: [{ text: 'Sizing returns', x: 0.5 }, { text: 'Medical claim', x: 0.5 }] });
  assert.deepStrictEqual(by(inbox, '9000').risk.red, ['medical'], 'a red tag on the card');
  assert.deepStrictEqual([by(inbox, '9005').ranked.x, by(inbox, '9005').risk.red], [0.2, ['restricted', 'medical', 'skin']]);
  assert.deepStrictEqual(by(inbox, '9001').ranked.why, [{ text: 'Fragile', x: 0.8 }]);
  assert.deepStrictEqual(by(all, '9000').risk.red, ['medical'], 'the red tag is on the Browse card too');
  const at = (list, id) => list.ads.findIndex((a) => a.id === id);
  assert.ok(at(inbox, '9000') > at(all, '9000') + 5, 'the riskiest products go down');
  for (let i = 1; i < inbox.ads.length; i++) {
    const [p, q] = [inbox.ads[i - 1], inbox.ads[i]];
    assert.ok(p.rpd * p.ranked.x >= q.rpd * q.ranked.x, `${p.id} before ${q.id}: reach a day × the factor`);
  }
});

test('Why? reasons always land on the decision, also when the note on the product is saved after it', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  await s.post('/api/hide', { ad_id: '9001', status: 'rejected' });
  await s.post('/api/note', { ad_id: '9001', note: 'too pricey here' }); // the board saves the note as you decide: it can land last
  assert.strictEqual((await s.post('/api/feedback', { ad_id: '9001', reasons: ['price', 'store'] })).status, 200);
  const rows = env.db.prepare("SELECT action, reasons, note FROM feedback WHERE ad_id = '9001' ORDER BY id").all().map((r) => [r.action, r.reasons, r.note]);
  assert.deepStrictEqual(rows, [['rejected', '["price","store"]', ''], ['note', '[]', 'too pricey here']]);
  assert.deepStrictEqual((await (await s.get('/api/learned')).json()).blocked.map((x) => x.store), ['shop1.test'], 'so "Bad store" works');
  await s.post('/api/note', { ad_id: '9002', note: 'x' });
  assert.strictEqual((await s.post('/api/feedback', { ad_id: '9002', reasons: ['wow'] })).status, 404, 'a note is no decision to give reasons to');
});

test('a brief D1 error on a table of store signals is not kept for 15 minutes: the next request reads it again', async () => {
  const env = await seededEnv();
  env.db.prepare("INSERT INTO bestseller (product_key, store, rank, ok, checked_at, history) VALUES ('shop1.test/products/item-1', 'shop1.test', 2, 1, 'x', '[]')").run();
  const s = await loggedIn(env);
  const prepare = env.DB.prepare;
  let fail = true;
  env.DB.prepare = (sql) => (fail && /FROM bestseller/.test(sql) ? { all: async () => { fail = false; throw new Error('D1 hiccup'); } } : prepare(sql));
  assert.strictEqual((await s.get('/api/ads')).status, 500, 'no board without its ranks');
  const j = await (await s.get('/api/ads', NOW + 60000)).json();
  assert.deepStrictEqual(j.ads.find((a) => a.id === '9001').best, { rank: 2, move: null }, 'a minute later: read again, the rank is there');
});

test('allow-lists take only their own keys: ?sort=__proto__ is no 500, reasons like "constructor" are not saved or counted', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const plain = (await (await s.get('/api/ads?view=all&limit=100')).json()).ads.map((a) => a.id);
  for (const sort of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    for (const q of ['view=all', 'view=all&cc=NL', 'view=all&hidden=1', 'scope=world&view=all', 'view=inbox']) assert.strictEqual((await s.get(`/api/ads?${q}&sort=${sort}`)).status, 200, `${q}&sort=${sort}`);
    assert.deepStrictEqual((await (await s.get(`/api/ads?view=all&limit=100&sort=${sort}`)).json()).ads.map((a) => a.id), plain, `${sort}: by reach a day`);
    assert.strictEqual((await s.get(`/export.csv?view=all&sort=${sort}`)).status, 200);
  }
  await s.post('/api/hide', { ad_id: '9002', status: 'rejected' });
  await s.post('/api/feedback', { ad_id: '9002', reasons: ['constructor', '__proto__', 'toString', 'price'] });
  assert.strictEqual(env.db.prepare("SELECT reasons FROM feedback WHERE ad_id = '9002'").get().reasons, '["price"]');
  env.db.prepare("UPDATE feedback SET reasons = '[\"constructor\",\"valueOf\",\"price\"]' WHERE ad_id = '9002'").run(); // saved before this fix
  assert.deepStrictEqual((await (await s.get('/api/learned')).json()).reasons.bad, [{ key: 'price', label: 'Too expensive', n: 1 }]);
});

test('weaker leads are flagged: a big catalogue that hardly copies the ad, and an ad whose product was never found', async () => {
  const env = await seededEnv();
  env.db.prepare("UPDATE winners SET data = json_set(data, '$.store_products', 1200) WHERE ad_id IN ('9005', '9006')").run();
  env.db.prepare("UPDATE winners SET scaled_count = 5 WHERE ad_id = '9006'").run(); // copied 5 times: it is the product that sells
  env.db.prepare("UPDATE winners SET data = json_set(data, '$.store_products', 249) WHERE ad_id = '9007'").run();
  // The ad's own headline, linking to the store's home page, no price: the product was never found
  copyOf(env, '9335', { product_title: 'LAST DAY: 70% OFF EVERYTHING', advertiser_page_id: '997', product_url: 'https://shop3.test/', price: null });
  const s = await loggedIn(env);
  const ads = (await (await s.get('/api/ads?view=all&limit=100')).json()).ads;
  const by = (id) => ads.find((a) => a.id === id);
  assert.deepStrictEqual(['9005', '9006', '9007', '9008'].map((id) => [by(id).products, by(id).catalogue]), [[1200, true], [1200, false], [249, false], [null, false]]);
  assert.strictEqual(by('9335').unidentified, true);
  assert.deepStrictEqual(['9000', '9001'].map((id) => by(id).unidentified), [false, false], 'a price (9000 links to the home page) or a product page is enough');
});

test('/api/ads: while a run hunts, the run before it comes along', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  assert.strictEqual((await (await s.get('/api/ads')).json()).prev_run, null, 'finished: nothing extra');
  env.db.prepare("UPDATE state SET value = ? WHERE key = 'last_run'").run(JSON.stringify({ status: 'running', started_at: '2026-10-17T07:00:00.000Z', ads_checked: 0, new_winners: 0 }));
  env.db.prepare("INSERT INTO runs (id, started_at, finished_at, ads_checked, winners) VALUES ('a', '2026-10-16T02:00:00Z', '2026-10-16T07:00:00Z', 9, 1), ('b', '2026-10-17T02:00:00Z', '2026-10-17T06:59:00Z', 64030, 351), ('c', '2026-10-17T07:00:00Z', NULL, 0, 0)").run();
  assert.deepStrictEqual((await (await s.get('/api/ads')).json()).prev_run, { started_at: '2026-10-17T02:00:00Z', finished_at: '2026-10-17T06:59:00Z', ads_checked: 64030, winners: 351 });
});

test('/api/hide refuses bad input, other sites and unknown ads', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9000', status: 'deleted' })).status, 400);
  assert.strictEqual((await s.post('/api/hide', { ad_id: "9000' OR '1'='1", status: 'seen' })).status, 400);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '123456', status: 'seen' })).status, 404);
  assert.strictEqual((await s.post('/api/hide', 'not json')).status, 400);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9000', status: 'seen' }, { 'content-type': 'text/plain' })).status, 415);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9000', status: 'seen' }, { origin: 'https://evil.test' })).status, 403);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9000', status: 'seen', pad: 'x'.repeat(2000) })).status, 413);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM hidden').get().n, 0);
});

const JEV_HEAD = ['jev_main', 'jev_sub', 'jev_product_score', 'jev_ad_score', ...Object.keys({ ...CHOICES, ...AD_CHOICES }).map((k) => 'jev_' + k), ...[...TRAITS, ...AD_TRAITS].map((x) => 'jev_' + x.k), 'jev_used'].join(',');
test('CSV export: header, quotes, commas, newlines and formulas made harmless', async () => {
  assert.strictEqual(csvCell('a,b'), '"a,b"');
  assert.strictEqual(csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(csvCell('a\nb'), '"a\nb"');
  assert.strictEqual(csvCell('=1+1'), "'=1+1");
  assert.strictEqual(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.strictEqual(csvCell(-5), '-5', 'numbers stay numbers');
  assert.strictEqual(csvCell(null), '');
  const env = await seededEnv();
  const s = await loggedIn(env);
  const res = await s.get('/export.csv?view=all');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="winners-all-2026-10-17\.csv"$/);
  const csv = await res.text();
  const [head] = csv.split('\r\n');
  assert.strictEqual(head, 'ad_id,product,price,compare_at,currency,discount_pct,reach_eu,reach_per_day,ad_age_days,active_ads,ads_for_product,store_products,advertiser,store_url,product_url,ad_library_url,image_url,keyword,first_seen,last_seen,status,made_at,proof_signals,markets_outside_eu,new_ads_14d,in_eu,eu_reach_per_day_product,eu_reach_per_day_shop_best_ad,' + JEV_HEAD);
  assert.strictEqual(csv.trim().split('\r\n').length, 28, 'header + the 27 that pass the rules');
  for (const out of ['9200', '9300', '9600', '9700', '9800', '9900']) assert.ok(!csv.includes(out + ','), out + ' fails a rule');
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.test"",""x"") <img src=x onerror=alert(1)>, ""quoted""\nline2"`));
  assert.strictEqual(await (await s.get('/export.csv')).text(), csv, 'no view: All');
  assert.strictEqual(toCsv([]), head + '\r\n');
});

test('SQL injection attempts change nothing and leak nothing', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const tries = [
    "/api/ads?view=all&q=' OR 1=1 --", '/api/ads?view=all&q=%25', '/api/ads?view=all&q=_', "/api/ads?view=all&q=x'); DROP TABLE winners; --",
    '/api/ads?view=all&sort=score; DROP TABLE winners', '/api/ads?view=all&sort=(SELECT 1)', "/api/ads?view=top' OR '1'='1", '/api/ads?view=all&limit=1;DROP TABLE winners',
    '/api/ads?view=all&offset=-5', '/api/ads?view=all&rpd=0 OR 1=1', '/export.csv?view=all&q=%27%3B DELETE FROM winners; --',
  ];
  for (const t of tries) {
    const res = await s.get(t);
    assert.strictEqual(res.status, 200, t);
    const body = await res.text();
    assert.doesNotMatch(body, /SQLITE|syntax error/i, t);
  }
  assert.strictEqual((await (await s.get("/api/ads?view=all&q=' OR 1=1 --")).json()).total, 0);
  assert.strictEqual((await (await s.get('/api/ads?view=all&q=%25')).json()).total, 0, '% is a literal, not a wildcard');
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM winners').get().n, 34, 'nothing dropped or deleted');
  // every query went through bound parameters: the user text never appears in the SQL
  assert.ok(!env.DB.log.some((l) => /DROP|DELETE FROM winners|OR 1=1/.test(l.sql)));
});

test('security headers on every answer; unknown paths 404; text comes back raw for the page to escape', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  for (const res of [await call(env, '/'), await s.get('/'), await s.get('/api/ads'), await call(env, '/nope')]) {
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.strictEqual(res.headers.get('referrer-policy'), 'no-referrer');
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  }
  const page = await s.get('/');
  assert.match(page.headers.get('content-security-policy'), /img-src https:;/);
  assert.strictEqual((await call(env, '/nope')).status, 404);
  assert.strictEqual((await s.get('/api/hide')).status, 405);
  const j = await (await s.get('/api/ads?view=all&q=onerror')).json();
  assert.strictEqual(j.ads[0].adv, '<script>alert(1)</script>');
  const lo = await call(env, '/logout');
  assert.strictEqual(lo.status, 303);
  assert.match(lo.headers.get('set-cookie'), /^__Host-wh=; Path=\/; Max-Age=0/);
});

test('a database without tables gives a clear 503', async () => {
  const { d1Binding } = await import('./helpers/sqlite-d1.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const env = { DB: d1Binding(new DatabaseSync(':memory:')), BOARD_PIN: '482913' };
  const s = await loggedIn(env);
  const res = await s.get('/api/ads');
  assert.strictEqual(res.status, 503);
  assert.match((await res.json()).error, /Database not ready/);
});

test('no ad text on the cards (the ad itself is one tap away); ▶ is a link to the Ad Library', async () => {
  const env = await seededEnv();
  const me = await loggedIn(env);
  assert.strictEqual((await me.get('/ad/1234567890')).status, 404);
  assert.doesNotMatch(HTML, /class="copy"|a\.copy/, 'no ad text on the cards');
  assert.strictEqual(HTML.match(/class="view"[^>]*aria-label="Open in Ad Library"/g).length, 2, 'one ▶ on each card, a link: EU card and outside-EU card');
  assert.doesNotMatch(HTML, /data-act="view"|id="sheet"/, 'no in-board ad viewer');
});

// ---- The ad viewer: GET /api/ad/:id

const RAW_AD = {
  name: 'Marijke den Bosch', avatar: 'https://scontent.xx.fbcdn.net/a.jpg', library_id: '1234567890', body: 'Eindigt vanavond!\n\nNu 50% korting.',
  media: [{ type: 'video', src: 'https://video.xx.fbcdn.net/v.mp4', poster: 'https://scontent.xx.fbcdn.net/p.jpg' }, { type: 'image', src: 'javascript:alert(1)' }, { type: 'image', src: 'http://plain.test/x.jpg' }],
  cards: [],
  link: { caption: 'MARIJKEDENBOSCH.NL', title: 'Eindigt vanavond 23:59!', description: 'Gratis verzending', cta: 'Shop now', href: 'https://l.facebook.com/l.php?u=' + encodeURIComponent('https://marijkedenbosch.nl/products/jurk?utm=fb') + '&h=AT0' },
  low_impressions: true, junk: 'x',
};

/** A fake Browser Run: launch(binding) → browser; records what happened. */
function fakeLaunch(result, log = []) {
  const launch = async (binding) => {
    log.push(['launch', binding]);
    if (result instanceof Error && result.atLaunch) throw result;
    return {
      newPage: async () => ({
        setViewport: async () => {},
        setRequestInterception: async (on) => log.push(['intercept', on]),
        on: (ev, fn) => {
          const seen = [];
          for (const type of ['document', 'script', 'image', 'media', 'font']) fn({ resourceType: () => type, abort: async () => seen.push('-' + type), continue: async () => seen.push(type) });
          log.push([ev, seen]);
        },
        goto: async (url, opts) => log.push(['goto', url, opts.waitUntil]),
        waitForFunction: async (fn) => log.push(['wait', fn]),
        evaluate: async (fn) => {
          log.push(['evaluate', typeof fn]);
          if (result instanceof Error) throw result;
          return result;
        },
      }),
      close: async () => log.push(['close']),
    };
  };
  return { launch, log };
}
const BROWSER = { fetch: () => { throw new Error('not in tests'); } };
async function viewerEnv() {
  const env = await seededEnv();
  return Object.assign(env, { META_TOKEN: '  EAAB tok\n', BROWSER });
}
const getAd = async (env, path, launch, cookie) => handle(req(path, { headers: cookie ? { cookie } : {} }), env, { html: HTML, now: NOW, launch });

test('/api/ad/:id needs the PIN cookie and a numeric id', async () => {
  const env = await viewerEnv();
  const { launch, log } = fakeLaunch(RAW_AD);
  const res = await getAd(env, '/api/ad/1234567890', launch);
  assert.strictEqual(res.status, 401);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.deepStrictEqual(await res.json(), { error: 'Log in first' });
  const { cookie } = await loggedIn(env);
  for (const bad of ['abc', '12a', '1'.repeat(26), '', '1%27%20OR%201=1', '123/456']) {
    assert.strictEqual((await getAd(env, '/api/ad/' + bad, launch, cookie)).status, 400, bad);
  }
  assert.strictEqual(log.length, 0, 'no browser for refused requests');
});

test('/api/ad/:id: cache miss opens render_ad in the browser, cleans the ad and stores it; then served from D1 for 24 hours', async () => {
  const env = await viewerEnv();
  const { cookie } = await loggedIn(env);
  const { launch, log } = fakeLaunch(RAW_AD);
  const res = await getAd(env, '/api/ad/1234567890', launch, cookie);
  assert.strictEqual(res.status, 200);
  const ad = await res.json();
  assert.strictEqual(log[0][1], BROWSER, 'launched with the BROWSER binding');
  assert.strictEqual(log[3][1], 'https://www.facebook.com/ads/archive/render_ad/?id=1234567890&access_token=EAABtok', 'token trimmed, URL-encoded');
  assert.deepStrictEqual(log.map((l) => l[0]), ['launch', 'intercept', 'request', 'goto', 'evaluate', 'evaluate', 'evaluate', 'close'], 'cookie dialog check, ready check (no waitForFunction), then read');
  assert.deepStrictEqual(log[2][1], ['document', 'script', 'image', '-media', '-font'], 'no video bytes, no fonts');
  assert.strictEqual(log[3][2], 'domcontentloaded', 'no wait for a quiet network (a video never goes quiet)');
  assert.strictEqual(ad.cached, false);
  assert.strictEqual(ad.name, 'Marijke den Bosch');
  assert.strictEqual(ad.body, 'Eindigt vanavond!\n\nNu 50% korting.');
  assert.deepStrictEqual(ad.media, [{ type: 'video', src: 'https://video.xx.fbcdn.net/v.mp4', poster: 'https://scontent.xx.fbcdn.net/p.jpg' }], 'only https media');
  assert.deepStrictEqual(ad.link, { caption: 'MARIJKEDENBOSCH.NL', title: 'Eindigt vanavond 23:59!', description: 'Gratis verzending', cta: 'Shop now', url: 'https://marijkedenbosch.nl/products/jurk?utm=fb' });
  assert.strictEqual(ad.low_impressions, true);
  assert.ok(!('junk' in ad));
  const row = env.db.prepare('SELECT json, fetched_at FROM ad_views WHERE ad_id = ?').get('1234567890');
  assert.strictEqual(row.fetched_at, new Date(NOW).toISOString());
  assert.doesNotMatch(row.json, /EAAB/, 'no token stored');
  // cache hit: no browser at all
  const none = fakeLaunch(new Error('must not launch'));
  const again = await handle(req('/api/ad/1234567890', { headers: { cookie } }), env, { html: HTML, now: NOW + 23 * 3600e3, launch: none.launch });
  assert.strictEqual(again.status, 200);
  assert.strictEqual((await again.json()).cached, true);
  assert.strictEqual(none.log.length, 0);
  // older than 24 hours: fetched again
  const fresh = fakeLaunch(RAW_AD);
  await handle(req('/api/ad/1234567890', { headers: { cookie } }), env, { html: HTML, now: NOW + 25 * 3600e3, launch: fresh.launch });
  assert.strictEqual(fresh.log[0][0], 'launch');
});

test('/api/ad/:id: a cached row is returned as stored, without touching BROWSER', async () => {
  const env = await viewerEnv();
  env.BROWSER = { get fetch() { throw new Error('BROWSER touched'); } };
  env.db.prepare('INSERT INTO ad_views (ad_id, json, fetched_at) VALUES (?, ?, ?)').run('555', JSON.stringify({ id: '555', name: 'Stored', media: [] }), new Date(NOW - 3600e3).toISOString());
  const { cookie } = await loggedIn(env);
  const res = await getAd(env, '/api/ad/555', async () => { throw new Error('launched'); }, cookie);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { id: '555', name: 'Stored', media: [], cached: true });
});

test('/api/ad/:id errors: daily limit (429), empty page, browser failure without the token, viewer off', async () => {
  const env = await viewerEnv();
  const { cookie } = await loggedIn(env);
  const limit = Object.assign(new Error('Unable to create new browser: code: 429: message: Browser time limit exceeded for today'), { atLaunch: true });
  const r429 = await getAd(env, '/api/ad/1', fakeLaunch(limit).launch, cookie);
  assert.strictEqual(r429.status, 429);
  assert.deepStrictEqual(await r429.json(), { error: "Dagelimiet van de ad-viewer bereikt (gratis Cloudflare: 10 min/dag). Gebruik 'Ad ↗'." });
  const empty = fakeLaunch({ name: 'x', body: '', media: [], cards: [], link: null });
  const r404 = await getAd(env, '/api/ad/2', empty.launch, cookie);
  assert.strictEqual(r404.status, 404);
  assert.match((await r404.json()).error, /Ad niet gevonden/);
  assert.strictEqual(empty.log.at(-1)[0], 'close', 'browser closed after a failure too');
  const leak = fakeLaunch(new Error('net::ERR_FAILED at https://www.facebook.com/ads/archive/render_ad/?id=3&access_token=EAABtok'));
  const r502 = await getAd(env, '/api/ad/3', leak.launch, cookie);
  assert.strictEqual(r502.status, 502);
  const j = await r502.json();
  assert.match(j.error, /Ad laden mislukt/);
  assert.doesNotMatch(j.error, /EAAB/, 'token never in the answer');
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM ad_views').get().n, 0, 'errors are not cached');
  for (const off of [{ META_TOKEN: '' }, { BROWSER: undefined }]) {
    const res = await getAd(Object.assign({}, env, off), '/api/ad/4', fakeLaunch(RAW_AD).launch, cookie);
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await res.json()).fallback, true);
  }
  const noLaunch = await getAd(env, '/api/ad/4', null, cookie);
  assert.strictEqual(noLaunch.status, 503);
  // /api/ads tells the board whether the viewer is on
  const s = await loggedIn(env);
  assert.strictEqual((await (await s.get('/api/ads')).json()).viewer, false, 'no launcher in plain calls');
  const on = await handle(req('/api/ads', { headers: { cookie } }), env, { html: HTML, now: NOW, launch: fakeLaunch(RAW_AD).launch });
  assert.strictEqual((await on.json()).viewer, true);
});

test('landingUrl: l.facebook.com/l.php unwrapped, only http(s) kept; carousel cards cleaned', () => {
  assert.strictEqual(landingUrl('https://l.facebook.com/l.php?u=' + encodeURIComponent('https://shop.nl/products/a?x=1') + '&h=AT'), 'https://shop.nl/products/a?x=1');
  assert.strictEqual(landingUrl('https://lm.facebook.com/l.php?u=http%3A%2F%2Fshop.nl%2F'), 'http://shop.nl/');
  assert.strictEqual(landingUrl('https://l.facebook.com/l.php?u=javascript%3Aalert(1)'), '');
  assert.strictEqual(landingUrl('https://shop.nl/x'), 'https://shop.nl/x');
  assert.strictEqual(landingUrl('javascript:alert(1)'), '');
  assert.strictEqual(landingUrl('not a url'), '');
  assert.strictEqual(landingUrl(undefined), '');
  const ad = cleanAd({ body: '', cards: [{ media: { type: 'image', src: 'https://scontent.test/1.jpg' }, title: 'One', cta: 'Shop now', href: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fshop.nl%2F1' }, 'junk'] }, '77', NOW);
  assert.deepStrictEqual(ad.cards, [{ media: { type: 'image', src: 'https://scontent.test/1.jpg' }, caption: '', title: 'One', description: '', cta: 'Shop now', url: 'https://shop.nl/1' }]);
  assert.strictEqual(ad.library_id, '77');
});

test('CSP of the board page allows https images and media (Meta CDN), nothing else loosened', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const csp = (await s.get('/')).headers.get('content-security-policy');
  assert.match(csp, /img-src https:; media-src https:; connect-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-|frame-src|\*/);
});

test("cleanAd: Facebook's cookie dialog is never taken for the ad", () => {
  const dialog = {
    body: 'Allow the use of cookies from Facebook on this browser?\nWe use cookies and similar technologies to help provide and improve content on Meta Products.',
    cards: [{ media: { type: 'image', src: 'https://static.xx.fbcdn.net/c1.png' }, title: 'What are cookies?', cta: 'Learn more', href: 'https://www.facebook.com/privacy/policies/cookies' }],
  };
  assert.throws(() => cleanAd(dialog, '3872187146265442', NOW), (e) => e.status === 502 && /cookie-melding/.test(e.message));
  assert.throws(() => cleanAd({ body: '', cards: [], link: { title: 'Cookies van Facebook toestaan in deze browser?' } }, '1', NOW), /cookie-melding/);
  assert.strictEqual(cleanAd({ body: 'Cookie jar sale: 50% off' }, '2', NOW).body, 'Cookie jar sale: 50% off', 'an ad about cookies is fine');
});

test('Market Radar: reach a day per country, #1 countries, best product; ?cc= shows one market, best there first', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  env.db.prepare(`UPDATE winners SET data = json_set(data, '$.top_countries', 'FR 90%, BE 10%') WHERE ad_id IN ('9000', '9100')`).run();
  env.db.prepare(`UPDATE winners SET data = json_set(data, '$.top_countries', 'DE 60%, FR 40%') WHERE ad_id = '9001'`).run();
  const all = await (await s.get('/api/ads?view=all&limit=100')).json();
  const rpd = Object.fromEntries(all.ads.map((a) => [a.id, a.rpd]));
  const m = await (await s.get('/api/markets')).json();
  assert.strictEqual(m.products, all.total, 'every product on the board');
  assert.deepStrictEqual(m.markets.map((x) => x.cc).slice(0, 2), ['NL', 'BE']);
  const fr = m.markets.find((x) => x.cc === 'FR');
  assert.deepStrictEqual([fr.products, fr.leads, fr.top.id], [2, 1, '9000']);
  assert.ok(Math.abs(fr.rpd - (rpd['9000'] * 0.9 + rpd['9001'] * 0.4)) <= 1);
  assert.ok(Math.abs(m.markets.reduce((t, x) => t + x.share, 0) - 100) < 0.5, 'shares add up to 100%');
  const one = await (await s.get('/api/ads?view=all&cc=fr')).json();
  assert.deepStrictEqual(one.ads.map((a) => a.id), ['9000', '9001'], 'only FR, by FR reach a day');
  assert.strictEqual(one.ads[0].crpd, Math.round(rpd['9000'] * 0.9));
  assert.deepStrictEqual(one.ads[1].mk, [['DE', 60], ['FR', 40]]);
  for (const bad of ['X', 'FRA', "FR' OR 1=1", '']) {
    assert.strictEqual((await (await s.get('/api/ads?view=all&cc=' + encodeURIComponent(bad))).json()).total, all.total, `cc=${bad}: no filter`);
  }
  // seen products leave the radar too
  await s.post('/api/hide', { ad_id: '9000', status: 'seen' });
  assert.strictEqual((await (await s.get('/api/markets')).json()).markets.find((x) => x.cc === 'FR').products, 1);
  assert.strictEqual((await call(env, '/api/markets')).status, 401, 'logged out');
});

test('the board in memory gives what the SQL rules give: same products, same order, with seen / rejected / stars', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  await s.post('/api/hide', { ad_id: '9003', status: 'seen' });
  await s.post('/api/hide', { ad_id: '9100', status: 'rejected' }); // the duplicate: hides product #0
  await s.post('/api/hide', { ad_id: '9005', status: 'starred' });
  const sql = env.db.prepare(PREFETCH_SQL).all(new Date(NOW).toISOString(), new Date(NOW + 864e5).toISOString(), 1000).map((r) => r.ad_id);
  const js = (await (await s.get('/api/ads?view=all&limit=100')).json()).ads.map((a) => a.id);
  assert.deepStrictEqual(js, sql, 'board = the SQL view (not hidden, by reach a day)');
  assert.ok(!js.includes('9000') && !js.includes('9003') && js.includes('9005'));
  for (const id of ['9300', '9600', '9700', '9800', '9900']) assert.ok(!js.includes(id), `${id} fails a rule`);
  assert.ok(js.includes('9500'), 'seen 30 days ago at 11 days: 41 days today, still in');
});

// A winners row like 9003 (shop3.test/products/item-3), with changes.
const copyOf = (env, id, o) => {
  const cols = ['product_title', 'advertiser_page_id', 'advertiser', 'active_ads', 'ad_age_days', 'ad_start_date', 'reach_eu', 'product_url', 'store_url', 'ad_library_url', 'image_url', 'keyword', 'currency', 'price', 'scaled_count', 'first_seen', 'last_seen', 'data'];
  env.db.prepare(`INSERT INTO winners (ad_id, ${cols.join(', ')}) SELECT ?, ${cols.map((c) => (c in o ? '?' : c)).join(', ')} FROM winners WHERE ad_id = '9003'`).run(id, ...cols.filter((c) => c in o).map((c) => o[c]));
};

test('age today comes from the day the ad started: a 43-day ad is off the board, also when "age when seen + days since" says 42', async () => {
  const row = { ad_id: 'x', gk: 'x', active_ads: 100, ad_age_days: 10, reach_eu: 100000, ad_start_date: '2026-09-04', last_seen: '2026-09-14T20:00:00Z', data: '{}' };
  const now = Date.parse('2026-10-17T10:00:00Z'); // 43 days and 10 hours after 4 Sep; 32 days and 14 hours after it was seen at 10
  assert.strictEqual(products([row], [], [], now).v.length, 0);
  assert.strictEqual(products([row], [], [], now).k[0].age_now, 43);
  assert.strictEqual(products([{ ...row, ad_start_date: '' }], [], [], now).k[0].age_now, 42, 'a row without a start date: as before');
  assert.strictEqual(products([row], [], [], Date.parse('2026-10-15T23:00:00Z')).v.length, 1, '41 days: still on');
  const env = await seededEnv();
  copyOf(env, '9334', { product_title: 'Forty Three Days', advertiser_page_id: '998', product_url: 'https://shop3.test/products/forty-three', ad_age_days: 10, ad_start_date: '2026-09-04', last_seen: '2026-09-14T20:00:00.000Z' });
  const s = await loggedIn(env);
  const at = Date.parse('2026-10-17T10:00:00Z');
  assert.ok(!(await (await s.get('/api/ads?view=all&limit=100', at)).json()).ads.some((a) => a.id === '9334'));
  assert.ok(!env.db.prepare(PREFETCH_SQL).all(new Date(at).toISOString(), new Date(at + 864e5).toISOString(), 1000).some((r) => r.ad_id === '9334'), 'the SQL rule agrees');
});

test('an ad measured at 5 days stays off the board, also days later when it is old enough: its reach a day is a 5-day figure', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const later = NOW + 3 * 864e5; // 9300 started 12 Oct: 8 days old by then, still measured at 5
  const all = await (await s.get('/api/ads?view=all&limit=100', later)).json();
  assert.ok(!all.ads.some((a) => a.id === '9300'));
  assert.ok(!env.db.prepare(PREFETCH_SQL).all(new Date(later).toISOString(), new Date(later + 864e5).toISOString(), 1000).some((r) => r.ad_id === '9300'), 'the SQL rule agrees');
  assert.ok(!all.ads.some((a) => a.id === '9500'), '9500 started 6 Sep: 44 days old by then');
  // Today the card gets both ages: the one it had when measured (with that day) and today's, if it still runs.
  const stale = (await (await s.get('/api/ads?view=all&limit=100')).json()).ads.find((a) => a.id === '9500');
  assert.deepStrictEqual([stale.age, stale.age_seen, stale.last_seen.slice(0, 10)], [41, 11, '2026-09-17']);
});

test('one product page is one product: two titles or two advertisers, one card, one decision, one note', async () => {
  const env = await seededEnv();
  // The same roller (shop3.test/products/item-3) under a sale title from another advertiser, with more reach a day.
  copyOf(env, '9333', { product_title: 'Pet Hair Remover Roller - 50% OFF TODAY', advertiser_page_id: '999', advertiser: 'Roller Deals', reach_eu: 200000 });
  const s = await loggedIn(env);
  const all = await (await s.get('/api/ads?view=all&limit=100')).json();
  assert.strictEqual(all.total, 27, 'still 27 products');
  assert.deepStrictEqual(all.ads.filter((a) => a.product === 'https://shop3.test/products/item-3').map((a) => a.id), ['9333'], 'one card: its best ad');
  // Jev answered under the advertiser + title of the other ad: the product still shows it.
  env.db.prepare("INSERT INTO world_checks (product_key, people, animals, gymwear, physical, category, input, checked_at, version, main, sub) VALUES ('eu|503|pet hair remover roller', 0.01, 0.01, 0.01, 0.99, 'Home', 'photo', 'x', 2, 'Home', 'Lighting')").run();
  env.db.prepare("UPDATE state SET updated_at = 'jev' WHERE key = 'last_run'").run(); // the board reads its tables again
  const roller = (await (await s.get('/api/ads?view=all&limit=100')).json()).ads.find((a) => a.id === '9333');
  assert.strictEqual(roller.jev.main, 'Home');
  // Approved through the first ad: the product leaves the Inbox, ✓ holds it once, and it cannot be approved again.
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'seen' })).status, 200);
  const inbox = await (await s.get('/api/ads?view=inbox&limit=100')).json();
  assert.ok(!inbox.ads.some((a) => ['9003', '9333'].includes(a.id)));
  assert.deepStrictEqual((await (await s.get('/api/ads?view=made')).json()).ads.map((a) => a.id), ['9333']);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9333', status: 'seen' })).status, 200);
  assert.deepStrictEqual(env.db.prepare("SELECT ad_id FROM hidden WHERE status = 'seen'").all().map((r) => r.ad_id), ['9333'], 'one decision for the product');
  assert.strictEqual(env.db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE action = 'seen'").get().n, 1);
  // One note: written through one ad, read through the other.
  await s.post('/api/note', { ad_id: '9003', note: 'Same roller as the sale ad' });
  assert.strictEqual((await (await s.get('/api/note?ad_id=9333')).json()).note, 'Same roller as the sale ad');
  // Ads without a product page still group by advertiser + title (9000 and 9100: the store's home page).
  assert.ok(all.ads.some((a) => a.id === '9000') && !all.ads.some((a) => a.id === '9100'));
});

test('two old decisions on what is now one product: the latest one counts', async () => {
  const env = await seededEnv();
  copyOf(env, '9333', { product_title: 'Pet Hair Remover Roller - 50% OFF TODAY', advertiser_page_id: '999' });
  env.db.prepare("INSERT INTO hidden (ad_id, status, at) VALUES ('9333', 'rejected', '2026-10-10T00:00:00.000Z'), ('9003', 'seen', '2026-10-12T00:00:00.000Z')").run();
  const s = await loggedIn(env);
  const made = await (await s.get('/api/ads?view=made')).json();
  assert.deepStrictEqual(made.ads.map((a) => [a.id, a.hidden, a.made_at]), [['9003', 'seen', '2026-10-12T00:00:00.000Z']]);
  const decided = await (await s.get('/api/ads?view=all&hidden=1')).json();
  assert.deepStrictEqual(decided.ads.map((a) => [a.id, a.hidden]), [['9003', 'seen']], 'one product, not a rejected twin next to it');
  // the other way round: approved first, rejected later
  env.db.prepare("UPDATE hidden SET at = '2026-10-14T00:00:00.000Z' WHERE ad_id = '9333'").run();
  assert.deepStrictEqual((await (await s.get('/api/ads?view=all&hidden=1')).json()).ads.map((a) => [a.id, a.hidden]), [['9003', 'rejected']]);
  assert.deepStrictEqual((await (await s.get('/api/ads?view=made')).json()).ads, []);
});

test('D1 reads: the winners are read once, again only after a run saved (or a new ad came in)', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const scans = () => env.DB.log.filter((l) => /FROM winners w$/.test(l.sql.trim())).length;
  await s.get('/api/ads');
  assert.strictEqual(scans(), 1);
  await s.get('/api/ads?view=all&offset=40');
  await s.get('/api/markets');
  await s.get('/api/ads?view=all&cc=NL&q=pillow');
  await s.post('/api/hide', { ad_id: '9003', status: 'starred' });
  await s.get('/api/ads?view=starred');
  await s.get('/export.csv?view=all');
  assert.strictEqual(scans(), 1, 'pages, filters, markets, stars and CSV: no new scan');
  assert.ok((await (await s.get('/api/ads?view=starred')).json()).ads.some((a) => a.id === '9003'), 'the star shows at once');
  env.db.prepare("UPDATE state SET updated_at = '2026-10-17T09:00:00.000Z' WHERE key = 'last_run'").run(); // a run saved a batch
  const before = (await (await s.get('/api/ads')).json()).total;
  assert.strictEqual(scans(), 2, 'new batch: read again');
  assert.strictEqual(before, 27);
  assert.ok(env.DB.log.every((l) => !/OVER \(/.test(l.sql)), 'no window-function scans on the board');
});

// The D1 binding with a few ms per query, as a round trip to D1 takes: requests that come in together overlap.
function slowly(DB, ms = 5) {
  const wait = () => new Promise((ok) => setTimeout(ok, ms));
  const wrap = (st) => ({ _run: () => st._run(), bind: (...a) => wrap(st.bind(...a)), all: async () => (await wait(), st.all()), first: async (c) => (await wait(), st.first(c)), run: async () => (await wait(), st.run()) });
  return { db: DB.db, log: DB.log, prepare: (sql) => wrap(DB.prepare(sql)), batch: async (stmts) => (await wait(), DB.batch(stmts)) };
}

test('D1 reads: the board opens with /api/ads and /api/markets at once: one read of the tables, the run states in one query', async () => {
  const env = await seededEnv();
  env.DB = slowly(env.DB);
  const s = await loggedIn(env);
  const scans = () => env.DB.log.filter((l) => /FROM winners w$/.test(l.sql.trim())).length;
  const [ads, markets] = await Promise.all([s.get('/api/ads?view=all&scope=world'), s.get('/api/markets?scope=world')]);
  assert.deepStrictEqual([ads.status, markets.status], [200, 200]);
  assert.strictEqual(scans(), 1, 'one read of the tables serves both');
  assert.strictEqual(env.DB.log.filter((l) => /FROM state WHERE key IN/.test(l.sql)).length, 1, 'the run states in one query');
  assert.strictEqual(env.DB.log.filter((l) => /FROM state WHERE key = \?/.test(l.sql)).length, 0, 'not one query per state');
  const got = await ads.json();
  assert.strictEqual(got.last_run.status, 'done');
  assert.strictEqual(got.world_run, null);
  assert.deepStrictEqual(got, await (await s.get('/api/ads?view=all&scope=world')).json(), 'the same answer as a request on its own');
  // A failed read is not kept: the next request reads the tables again.
  const env2 = await seededEnv();
  const s2 = await loggedIn(env2);
  const prepare = env2.DB.prepare;
  let fail = true;
  env2.DB.prepare = (sql) => (fail && /FROM winners w$/.test(sql.trim()) ? { all: async () => { fail = false; throw new Error('D1 hiccup'); } } : prepare(sql));
  assert.strictEqual((await s2.get('/api/ads')).status, 500);
  assert.strictEqual((await s2.get('/api/ads')).status, 200, 'read again after a failure');
});
