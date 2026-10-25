// worker/src/app.mjs: PIN flow, /api/ads, /api/hide, CSV, security headers and injection attempts,
// on an in-memory D1 (node:sqlite) with the real migration and the real upsert.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { handle, makeToken, csvCell, toCsv, boardAlert, PREFETCH_SQL, tasteOf, fitOf } from '../worker/src/app.mjs';
import { landingUrl, cleanAd } from '../worker/src/adview.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { STRICT } from '../lib/d1.mjs';

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
  assert.deepStrictEqual(Object.keys(j.counts), ['all', 'inbox', 'fresh', 'starred', 'made', 'hidden', 'by']);
  assert.strictEqual(j.scope, 'eu', 'no products from outside the EU yet: the EU');
  assert.strictEqual(j.counts.inbox, 27, 'nothing decided yet: everything is in the inbox');
  assert.strictEqual(j.counts.all, 27);
  assert.strictEqual(j.last_run.new_winners, 23);
  const a = j.ads.find((x) => x.id === '9002');
  assert.strictEqual(a.store_photo, true);
  assert.strictEqual(a.img, 'https://cdn.shopify.com/s/files/1/p2.jpg?width=400');
  assert.strictEqual(a.products, null, 'store size unknown in the sample');
  assert.strictEqual(a.zh, '连衣裙', 'search word dress → Chinese 1688 term');
});

test('alert banner: red for a failed run, no run in 36 hours or a Meta token expiring within 7 days; yellow for warnings', async () => {
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
  assert.deepStrictEqual(await alertOf(), { level: 'red', text: 'Geen run in 36 uur / No run in 36 hours' });
  assert.strictEqual(await alertOf(NOW - 2 * H), null, '35 hours: still fine');
  setState('last_run', { status: 'running', started_at: iso(NOW - 40 * H) }, NOW - 39 * H);
  assert.strictEqual((await alertOf()).level, 'red', 'a run stuck on "running" for 40 hours');
  setState('last_run', { status: 'running', started_at: iso(NOW - 1 * H) });
  setState('token_expires_at', { at: iso(NOW + 3.5 * 864e5) });
  assert.deepStrictEqual(await alertOf(), { level: 'red', text: 'Meta token verloopt over 3 dagen / Meta token expires in 3 days' });
  setState('last_run', { status: 'done', health: 'warning', finished_at: iso(NOW - 40 * H) });
  setState('token_expires_at', { at: iso(NOW - 864e5) });
  assert.deepStrictEqual(await alertOf(), { level: 'red', text: 'Geen run in 36 uur / No run in 36 hours · Meta token verlopen / Meta token expired' }, 'red wins over yellow');
  // never-expiring token, no run yet, broken state
  assert.strictEqual(boardAlert(null, { at: null }, NOW), null);
  assert.strictEqual(boardAlert({ health: 'ok', finished_at: 'garbage' }, null, NOW), null);
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

test('/api/ads?view=made: every product marked ✓ Made ad, the last one first, in every scope and out of the rules too', async () => {
  const env = await seededEnv({ world: true });
  const s = await loggedIn(env);
  const made = async (q = '') => (await s.get('/api/ads?view=made' + q)).json();
  const empty = await made();
  assert.deepStrictEqual([empty.view, empty.total, empty.counts.made], ['made', 0, 0]);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'seen' })).status, 200);
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9004', status: 'rejected' })).status, 200);
  const ago = (days) => new Date(NOW - days * 864e5).toISOString();
  // made earlier: an aged-out product, one from outside the EU, and a product through its second ad (9100 → 9000)
  env.db.prepare("INSERT INTO hidden (ad_id, status, at) VALUES ('9900', 'seen', ?), ('8001', 'seen', ?), ('9100', 'seen', ?)").run(ago(3), ago(1), ago(2));
  const j = await made('&scope=eu');
  assert.deepStrictEqual(j.ads.map((a) => [a.id, a.made_at, a.pass, a.hidden]), [
    ['9003', new Date(NOW).toISOString(), true, 'seen'],
    ['8001', ago(1), true, 'seen'],
    ['9000', ago(2), true, 'seen'],
    ['9900', ago(3), false, 'seen'],
  ], 'the last one first; every scope; once per product; out of the rules too; rejected not');
  assert.strictEqual(j.counts.made, 4);
  assert.ok(!(await (await s.get('/api/ads?view=all&scope=eu&limit=100')).json()).ads.some((a) => a.id === '9003'), 'not in Browse');
  assert.ok((await (await s.get('/api/ads?view=all&hidden=1&scope=eu')).json()).ads.some((a) => a.id === '9003'), 'in Made ad & rejected');
  assert.strictEqual((await (await s.get('/api/ads?view=all&scope=eu&limit=100')).json()).ads.find((a) => a.id === '9005').made_at, '', 'no date before you make it');
  const csv = await s.get('/export.csv?view=made');
  assert.match(csv.headers.get('content-disposition'), /winners-made-/);
  assert.strictEqual((await csv.text()).trim().split('\r\n').length, 5, 'header + 4');
  // Undo takes it off ✓
  assert.strictEqual((await s.post('/api/hide', { ad_id: '9003', status: 'none' })).status, 200);
  const after = await made();
  assert.deepStrictEqual([after.ads.map((a) => a.id), after.counts.made], [['8001', '9000', '9900'], 3]);
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
  assert.strictEqual(after.total, 24);
  assert.ok(!after.ads.some((x) => [a, b, c].includes(x.id)), 'decided products leave the inbox');
  assert.strictEqual(after.counts.inbox, 24);
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
  const s = await loggedIn(env);
  const inbox = async () => (await s.get('/api/ads?view=inbox&limit=100')).json();
  const fb = () => env.db.prepare("SELECT ad_id, action, reasons, note, keyword, title FROM feedback WHERE action != 'general' ORDER BY id").all();
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
  assert.deepStrictEqual(l.niches, [{ kw: String(a.kw).toLowerCase(), good: 0, bad: 2, weight: 0.33 }], '"not my niche" counts double');
  assert.deepStrictEqual(l.notes.map((n) => n.note), ['Meer dierenproducten graag', 'Te duur  voor NL']);
  assert.strictEqual((await s.get('/api/learned')).status, 200);
  assert.strictEqual((await call(env, '/api/learned')).status, 401, 'PIN needed');
});

test('outside the EU: no reach rule, the active ads lead; Inbox and Browse show one scope', async () => {
  const env = await seededEnv({ world: true });
  const s = await loggedIn(env);
  const get = async (q) => (await s.get('/api/ads?' + q)).json();
  const w = await get('view=inbox');
  assert.strictEqual(w.scope, 'world', 'outside the EU first once the board has products from there');
  assert.deepStrictEqual(w.ads.map((a) => [a.id, a.ads, a.world, a.targets]), [['8001', 300, true, 'Worldwide'], ['8002', 120, true, 'United States, Canada']],
    'no reach needed, most active ads first; 60 active ads and 50 days live are still out');
  assert.deepStrictEqual([w.counts.inbox, w.counts.all, w.counts.by], [2, 2, { world: { inbox: 2, all: 2 }, eu: { inbox: 27, all: 27 } }]);
  const eu = await get('view=inbox&scope=eu');
  assert.deepStrictEqual([eu.scope, eu.total, eu.counts.inbox, eu.ads.some((a) => a.world)], ['eu', 27, 27, false]);
  assert.ok(eu.ads.every((a) => a.rpd >= 500), 'EU products still need their reach');
  assert.deepStrictEqual((await get('view=all&scope=world')).ads.map((a) => a.id), ['8001', '8002'], 'Browse: most active ads first');
  assert.strictEqual((await get('view=all&scope=eu')).ads.length, 27);
  assert.strictEqual((await get('view=all&scope=nonsense')).scope, 'world');
  // a decision works the same; the database rule (lib/d1.mjs STRICT) agrees
  await s.post('/api/hide', { ad_id: '8001', status: 'rejected' });
  assert.deepStrictEqual((await get('view=inbox&scope=world')).ads.map((a) => a.id), ['8002']);
  assert.deepStrictEqual(env.db.prepare(`SELECT ad_id FROM winners WHERE ad_id LIKE '80%' AND ${STRICT} ORDER BY ad_id`).all().map((r) => r.ad_id), ['8001', '8002']);
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

test('tasteOf / fitOf: niches you like go up, rejected niches and too-expensive prices go down, bad stores leave', () => {
  const t = tasteOf([
    { action: 'seen', reasons: '[]', keyword: 'Dog', store: 'https://a.com', price: 20 },
    { action: 'keep', reasons: '["niche"]', keyword: 'dog', store: 'https://a.com', price: 25 },
    { action: 'rejected', reasons: '["niche"]', keyword: 'cat', store: 'https://b.com', price: 30 },
    { action: 'rejected', reasons: '["price","store"]', keyword: 'cat', store: 'https://www.Bad.com/x', price: 60 },
    { action: 'rejected', reasons: '["price"]', keyword: '', store: '', price: 45 },
    { action: 'rejected', reasons: 'not json', keyword: 'fish', store: '', price: null },
  ]);
  assert.deepStrictEqual(Object.fromEntries(t.weights), { dog: 3, cat: 0.3, fish: 0.5 });
  assert.deepStrictEqual([...t.blocked.keys()], ['bad.com']);
  assert.strictEqual(t.maxPrice, 45, 'the cheapest product you still found too expensive');
  assert.strictEqual(fitOf({ keyword: 'DOG ', price: 10 }, t), 3);
  assert.strictEqual(fitOf({ keyword: 'dog', price: 50 }, t), 1.5, 'too expensive: half');
  assert.strictEqual(fitOf({ keyword: 'new', price: 10 }, t), 1, 'no opinion yet');
  assert.strictEqual(tasteOf([]).maxPrice, null);
});

test('inbox learns: a liked niche comes first, a bad store leaves (and comes back with unblock)', async () => {
  const env = await seededEnv();
  const s = await loggedIn(env);
  const inbox = async () => (await s.get('/api/ads?view=inbox&limit=100')).json();
  const before = await inbox();
  const last = before.ads[before.ads.length - 1];
  const other = before.ads.find((x) => x.kw !== last.kw && x.store && x.store !== last.store);
  // like the niche of the last product twice, through products of the same keyword
  env.db.prepare("INSERT INTO feedback (action, reasons, keyword, at) VALUES ('seen', '[\"niche\"]', ?, 'x'), ('keep', '[]', ?, 'x')").run(last.kw, last.kw);
  const after = await inbox();
  assert.strictEqual(after.ads[0].kw, last.kw, 'a liked niche jumps up');
  assert.ok(after.ads[0].fit > 1);
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
  assert.strictEqual(head, 'ad_id,product,price,compare_at,currency,discount_pct,reach_eu,reach_per_day,ad_age_days,active_ads,ads_for_product,store_products,advertiser,store_url,product_url,ad_library_url,image_url,keyword,first_seen,last_seen,status');
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

test('the ad text is only in the opened card (not on the compact card); every card has a ▶ View ad button', async () => {
  const env = await seededEnv();
  const me = await loggedIn(env);
  assert.strictEqual((await me.get('/ad/1234567890')).status, 404);
  assert.match(HTML, /<div class="more">\s*\$\{a\.copy \? `<p class="copy">/, 'ad text inside the details');
  assert.strictEqual(HTML.match(/class="copy"/g).length, 1);
  assert.strictEqual(HTML.match(/class="view"[^>]*aria-label="View ad"/g).length, 2, 'button (viewer on) and link (viewer off)');
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
