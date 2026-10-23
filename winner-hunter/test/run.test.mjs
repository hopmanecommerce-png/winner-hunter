// run.mjs: batches, keyword cursor, time budget, Meta block, D1 failures — with a fake Meta search, a fake D1
// and a fake clock; plus one run end to end (real hunt on a fake Meta API, real D1 client on SQLite).
import test from 'node:test';
import assert from 'node:assert';
import { run } from '../run.mjs';
import { hunt, checkTokens } from '../lib/meta.mjs';
import { d1Client } from '../lib/d1.mjs';
import { d1Rest } from './helpers/sqlite-d1.mjs';
import { NOW, fakeFetch, json } from './helpers/fake-meta.mjs';

const KW = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
const MIN = 60000;

function fakeDb({ cursor = null, failAll = false, failSave = () => false } = {}) {
  const st = new Map(cursor == null ? [] : [['keyword_cursor', JSON.stringify({ next: cursor })]]);
  const db = {
    upserts: [], runs: [], st,
    async getState(k) {
      if (failAll) throw new Error('Cloudflare D1: down');
      return st.has(k) ? st.get(k) : null;
    },
    async setState(k, v) {
      if (failAll) throw new Error('Cloudflare D1: down');
      st.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    },
    async upsertWinners(recs) {
      if (failAll || failSave(recs)) return { saved: 0, error: 'Cloudflare D1: down' };
      db.upserts.push(recs);
      return { saved: recs.length };
    },
    async saveRun(r) {
      if (failAll) throw new Error('Cloudflare D1: down');
      db.runs.push(r);
    },
    async newWinnersSince() {
      if (failAll) throw new Error('Cloudflare D1: down');
      return db.upserts.flat().length;
    },
  };
  return db;
}

// A fake search: every batch takes `minutes` of the fake clock and finds one ad per keyword.
function fakeSearch(clock, { minutes = 30, block = () => false, fail = () => false, ads = 100 } = {}) {
  const asked = [];
  const search = async (o) => {
    asked.push({ queries: o.queries, tokenStart: o.tokenStart, cache: o.cache });
    clock.t += minutes * MIN;
    const err = fail(o.queries);
    if (err) throw err;
    const blocked = block(o.queries);
    return {
      results: o.queries.map((q) => ({ id: 'ad-' + q, score: 100, verdict: 'winner', active_ads: q === 'b' ? 40 : 120, product_title: 'P ' + q, store_url: 'https://shop-' + q + '.test/', product_url: 'https://shop-' + q + '.test/', reach_eu: 20000, ad_age_days: 10, image_url: q === 'a' ? 'https://cdn.shopify.com/s/files/1/a.jpg' : '' })),
      stats: { ads, usagePeak: 40, token: 1, blocked, stoppedEarly: false },
    };
  };
  return { search, asked };
}

function setup(opts = {}) {
  const clock = { t: Date.UTC(2026, 9, 17, 1, 17) };
  const logs = [];
  const sum = [];
  const db = opts.db || fakeDb(opts);
  const s = fakeSearch(clock, opts);
  // debug_token: by default every token is valid and never expires
  const tokenCheck = opts.tokenCheck || (async (tokens) => tokens.map((_, i) => ({ n: i + 1, valid: true, expiresAt: 0 })));
  const deps = { db, search: s.search, now: () => clock.t, log: (m) => logs.push(m), summary: (m) => sum.push(m), tokenCheck, photo: async (u) => (u.includes('shop-c') ? 'https://shop-c.test/cdn/shop/files/c.jpg?width=400' : '') };
  return { clock, logs, sum, db, s, deps };
}
const cfg = (o = {}) => Object.assign({ tokens: ['t1', 't2'], keywords: KW, minutes: 300, countries: ['NL'] }, o);

test('batches of 2 from the cursor; cursor saved after every batch; wraps around the list', async () => {
  const { db, s, deps, sum, logs } = setup({ cursor: 5, minutes: 10 });
  const out = await run(cfg(), deps);
  assert.deepStrictEqual(s.asked.map((a) => a.queries), [['f', 'g'], ['a', 'b'], ['c', 'd'], ['e']], 'one full pass, starting at #5');
  assert.strictEqual(out.stopped, 'done');
  assert.strictEqual(JSON.parse(db.st.get('keyword_cursor')).next, 5, 'a full pass ends where it started');
  assert.strictEqual(out.batches, 4);
  // only ads that pass the rules (b's advertiser has 40 active ads), each batch saved on its own
  assert.deepStrictEqual(db.upserts.map((u) => u.map((r) => r.id)), [['ad-f', 'ad-g'], ['ad-a'], ['ad-c', 'ad-d'], ['ad-e']]);
  // the token that worked last carries over; competitor counts are shared between batches
  assert.deepStrictEqual(s.asked.map((a) => a.tokenStart), [0, 1, 1, 1]);
  assert.ok(s.asked.every((a) => a.cache === s.asked[0].cache));
  // one summary line per batch and one at the end; runs row + last_run state
  assert.strictEqual(sum.filter((l) => l.startsWith('- Batch')).length, 4);
  assert.match(sum.at(-1), /Done \(done\) · 4 batches · 400 ads checked · 6 saved/);
  assert.ok(logs.some((l) => /^Batch 1 · f, g · 100 ads · 2 saved · Meta 40% · next #0\/7$/.test(l)), logs.join('\n'));
  assert.ok(db.runs.at(-1).finished_at && db.runs.at(-1).ads_checked === 400);
  assert.strictEqual(JSON.parse(db.st.get('last_run')).status, 'done');
  // healthy: status ok everywhere, nothing red
  assert.strictEqual(out.health, 'ok');
  assert.strictEqual(db.runs.at(-1).status, 'ok');
  assert.strictEqual(JSON.parse(db.st.get('last_run')).health, 'ok');
  assert.ok(!logs.some((l) => l.startsWith('::error::') || l.startsWith('::warning::')), logs.join('\n'));
  assert.deepStrictEqual(JSON.parse(db.st.get('token_expires_at')).tokens, [{ n: 1, valid: true, expires_at: 'never' }, { n: 2, valid: true, expires_at: 'never' }]);
});

test('product photo kept; a missing one becomes a store photo; none found stays empty', async () => {
  const { db, deps } = setup({ minutes: 10 });
  await run(cfg({ keywords: ['a', 'c', 'd'], batchSize: 3 }), deps);
  const byId = Object.fromEntries(db.upserts.flat().map((r) => [r.id, r]));
  assert.strictEqual(byId['ad-a'].image_url, 'https://cdn.shopify.com/s/files/1/a.jpg?width=400');
  assert.strictEqual(byId['ad-a'].image_source, 'product');
  assert.strictEqual(byId['ad-c'].image_url, 'https://shop-c.test/cdn/shop/files/c.jpg?width=400');
  assert.strictEqual(byId['ad-c'].image_source, 'store');
  assert.strictEqual(byId['ad-d'].image_url, '');
});

test('time budget: no batch starts with less than 10 minutes left', async () => {
  const { db, s, deps } = setup({ cursor: 0, minutes: 50 });
  const out = await run(cfg({ minutes: 120 }), deps);
  // starts at 0, 50 and 100 min (20 left: ok); at 150 only -30 are left, so no 4th batch
  assert.deepStrictEqual(s.asked.map((a) => a.queries), [['a', 'b'], ['c', 'd'], ['e', 'f']]);
  assert.strictEqual(out.stopped, 'time');
  assert.strictEqual(JSON.parse(db.st.get('keyword_cursor')).next, 6);
  assert.strictEqual(JSON.parse(db.st.get('last_run')).status, 'time');
});

test('Meta 613 on every token: the batch is saved, the cursor stays on it, the run ends cleanly', async () => {
  const { db, s, deps, logs } = setup({ cursor: 2, minutes: 10, block: (q) => q.includes('e') });
  const out = await run(cfg(), deps);
  assert.deepStrictEqual(s.asked.map((a) => a.queries), [['c', 'd'], ['e', 'f']]);
  assert.strictEqual(out.stopped, 'meta-block');
  assert.strictEqual(JSON.parse(db.st.get('keyword_cursor')).next, 4, 'next run starts again at e');
  assert.deepStrictEqual(db.upserts.at(-1).map((r) => r.id), ['ad-e', 'ad-f'], 'what the blocked batch found is saved');
  assert.ok(logs.some((l) => /::warning::Meta hourly limit/.test(l)));
  // a block after some batches is a warning (yellow), not a failure
  assert.strictEqual(out.health, 'warning');
  assert.ok(!logs.some((l) => l.startsWith('::error::')));
  assert.strictEqual(db.runs.at(-1).status, 'warning');
  assert.match(JSON.parse(db.st.get('last_run')).alert, /1 warning\(s\): Meta hourly limit/);
});

test('Meta 613 on every token in the first batch: what it found is saved, then the run fails', async () => {
  const { db, deps, logs } = setup({ cursor: 0, minutes: 10, block: () => true });
  const out = await run(cfg(), deps);
  assert.strictEqual(out.batches, 1);
  assert.deepStrictEqual(db.upserts.flat().map((r) => r.id), ['ad-a'], 'saved before the run is marked failed');
  assert.strictEqual(out.health, 'failed');
  assert.ok(logs.some((l) => /^::error::Run mislukt: Meta blokkeerde alle tokens \(613\) vóór de eerste batch klaar was \/ Run failed: Meta blocked every token/.test(l)), logs.join('\n'));
  assert.strictEqual(db.runs.at(-1).status, 'failed');
  assert.ok(db.runs.at(-1).finished_at);
});

test('an expired token stops the run with a clear error; other batch errors are skipped', async () => {
  const tokenErr = Object.assign(new Error('Meta access token invalid or expired'), { token: true });
  const a = setup({ cursor: 0, minutes: 10, fail: (q) => (q.includes('c') ? tokenErr : null) });
  const out = await run(cfg(), a.deps);
  assert.strictEqual(out.stopped, 'token');
  assert.ok(a.logs.some((l) => /^::error::Meta access token invalid/.test(l)));
  assert.strictEqual(JSON.parse(a.db.st.get('last_run')).status, 'token');
  assert.strictEqual(out.health, 'failed', 'an expired token makes the run red');
  assert.strictEqual(JSON.parse(a.db.st.get('last_run')).health, 'failed');
  assert.ok(a.logs.some((l) => /^::error::Run mislukt: Meta token verlopen of ongeldig .*\/ Run failed: Meta token expired or invalid/.test(l)));
  assert.strictEqual(a.db.upserts.length, 1, 'the batch before it is saved');
  const b = setup({ cursor: 0, minutes: 10, fail: (q) => (q.includes('c') ? new Error('weird') : null) });
  const out2 = await run(cfg(), b.deps);
  assert.strictEqual(out2.stopped, 'done');
  assert.strictEqual(out2.batches, 4);
  assert.ok(b.logs.some((l) => /::warning::Batch "c, d" failed: weird/.test(l)));
  assert.strictEqual(out2.health, 'warning');
});

test('D1 down: every D1 problem is a warning, the hunt still runs; the start slice changes per day', async () => {
  const { s, deps, logs } = setup({ failAll: true, minutes: 10 });
  const out = await run(cfg(), deps);
  assert.strictEqual(out.batches, 4);
  assert.ok(logs.filter((l) => l.startsWith('::warning::')).length >= 5);
  assert.ok(logs.some((l) => /Could not read the keyword cursor/.test(l)));
  assert.strictEqual(out.health, 'failed', 'winners found but none saved');
  assert.ok(logs.some((l) => /^::error::Run mislukt: 6 gevonden maar 0 opgeslagen in D1 \/ Run failed: 6 found but 0 saved to D1$/.test(l)), logs.join('\n'));
  const day = Math.floor(Date.UTC(2026, 9, 17, 1, 17) / 864e5);
  assert.strictEqual(s.asked[0].queries[0], KW[(day * 20) % KW.length]);
});

test('one batch that could not be saved at all fails the run; the others are still saved', async () => {
  const { db, deps, logs } = setup({ cursor: 0, minutes: 10, failSave: (recs) => recs.some((r) => r.id === 'ad-c') });
  const out = await run(cfg(), deps);
  assert.strictEqual(out.batches, 4);
  assert.strictEqual(out.saved, 4);
  assert.strictEqual(out.health, 'failed');
  assert.ok(logs.some((l) => /^::error::Run mislukt: opslaan in D1 mislukt voor 1 batch\(es\) \/ Run failed: D1 save failed for 1 batch\(es\)$/.test(l)), logs.join('\n'));
});

test('0 ads checked fails the run; nothing found to save is not a D1 problem', async () => {
  const { db, deps, logs } = setup({ cursor: 0, minutes: 10, ads: 0 });
  const out = await run(cfg({ override: ['zzz'] }), Object.assign(deps, { search: async () => ({ results: [], stats: { ads: 0 } }) }));
  assert.strictEqual(out.health, 'failed');
  assert.ok(logs.some((l) => l === '::error::Run mislukt: 0 ads gecheckt (Meta token?) / Run failed: 0 ads checked (Meta token?)'), logs.join('\n'));
  assert.strictEqual(db.runs.at(-1).status, 'failed');
  assert.match(db.runs.at(-1).note, /Run failed: 0 ads checked/);
  await assert.rejects(run(cfg({ keywords: [] }), setup().deps), /No keywords/, 'no keywords: its own clear error');
});

test('Meta token expiry: within 7 days → red but the hunt runs; invalid → red; check failing → only a warning; tokens never printed', async () => {
  const start = Date.UTC(2026, 9, 17, 1, 17);
  const soon = setup({ cursor: 0, minutes: 10, tokenCheck: async (tk) => [{ n: 1, valid: true, expiresAt: start + 3.5 * 864e5 }, { n: 2, valid: true, expiresAt: start + 50 * 864e5 }] });
  const out = await run(cfg({ tokens: ['secret-aaa', 'secret-bbb'] }), soon.deps);
  assert.strictEqual(out.batches, 4, 'the hunt still runs');
  assert.strictEqual(soon.db.upserts.flat().length, 6);
  assert.strictEqual(out.health, 'failed');
  assert.ok(soon.logs.some((l) => /^::error::Meta token META_TOKEN verloopt over 3 dagen \(2026-10-20\).* \/ Meta token META_TOKEN expires in 3 days/.test(l)), soon.logs.join('\n'));
  assert.ok(soon.logs.some((l) => /^::error::Run mislukt: Meta token META_TOKEN verloopt over 3 dagen \/ Run failed: Meta token META_TOKEN expires in 3 days$/.test(l)));
  const st = JSON.parse(soon.db.st.get('token_expires_at'));
  assert.strictEqual(st.at, new Date(start + 3.5 * 864e5).toISOString(), 'the soonest expiry');
  assert.strictEqual(st.tokens.length, 2);
  assert.ok(!JSON.stringify([...soon.db.st.values(), soon.db.runs, soon.logs]).includes('secret-'), 'no token in D1 or the log');

  const dead = setup({ cursor: 0, minutes: 10, tokenCheck: async () => [{ n: 1, valid: true, expiresAt: 0 }, { n: 2, valid: false, expiresAt: null }] });
  const out2 = await run(cfg(), dead.deps);
  assert.strictEqual(out2.health, 'failed');
  assert.ok(dead.logs.some((l) => /^::error::Meta token META_TOKEN_2 is ongeldig of verlopen/.test(l)));

  const flaky = setup({ cursor: 0, minutes: 10, tokenCheck: async () => { throw new Error('graph down'); } });
  const out3 = await run(cfg(), flaky.deps);
  assert.strictEqual(out3.health, 'warning');
  assert.ok(flaky.logs.some((l) => /^::warning::Could not check when Meta token/.test(l)));
  assert.ok(!flaky.db.st.has('token_expires_at'), 'nothing known: the old value stays');

  // a token in an error message is masked
  const leak = setup({ cursor: 0, minutes: 10, fail: (q) => (q.includes('c') ? new Error('bad url ?access_token=secret-aaa') : null) });
  await run(cfg({ tokens: ['secret-aaa'] }), leak.deps);
  assert.ok(leak.logs.some((l) => l.includes('access_token=***')) && !leak.logs.some((l) => l.includes('secret-aaa')));
});

test('typed-in keywords: searched as given, cursor untouched', async () => {
  const { db, s, deps } = setup({ cursor: 3, minutes: 10 });
  await run(cfg({ override: ['dog', 'cat', 'lamp'] }), deps);
  assert.deepStrictEqual(s.asked.map((a) => a.queries), [['dog', 'cat'], ['lamp']]);
  assert.strictEqual(JSON.parse(db.st.get('keyword_cursor')).next, 3);
});

test('end to end: real hunt on a fake Meta API, real D1 client on SQLite', async () => {
  const { db, doFetch: d1Fetch } = d1Rest();
  db.prepare("INSERT INTO state (key, value) VALUES ('keyword_cursor', '{\"next\": 1}')").run();
  const meta = fakeFetch([]);
  const search = (o, d) => hunt(Object.assign({}, o, { base: 'https://graph.test' }), Object.assign({}, d, { fetch: meta, now: NOW }));
  const logs = [];
  const out = await run({ tokens: ['tok'], keywords: ['dress', 'jurk', 'kleid'], minutes: 60, countries: ['NL', 'BE'] }, {
    db: d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Fetch, retryMs: 0 }), search, photo: async () => '', log: (m) => logs.push(m),
    tokenCheck: (tk) => checkTokens(tk, { fetch: meta, base: 'https://graph.test' }),
  });
  assert.strictEqual(out.stopped, 'done', logs.join('\n'));
  assert.strictEqual(out.batches, 2);
  assert.ok(logs[0].includes('keywords from #1 of 3'));
  const rows = db.prepare('SELECT ad_id, score, active_ads, image_url, data FROM winners ORDER BY score DESC').all();
  assert.strictEqual(rows[0].ad_id, '1');
  assert.strictEqual(rows[0].score, 100);
  assert.strictEqual(JSON.parse(rows[0].data).zh, '连衣裙');
  assert.ok(rows.every((r) => r.score === 100 && r.active_ads >= 75), 'only ads that pass every rule');
  assert.strictEqual(JSON.parse(db.prepare("SELECT value FROM state WHERE key = 'keyword_cursor'").get().value).next, 1, 'a full pass ends where it started');
  const last = JSON.parse(db.prepare("SELECT value FROM state WHERE key = 'last_run'").get().value);
  assert.strictEqual(last.status, 'done');
  assert.strictEqual(last.ads_checked, 14);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 1);
  assert.strictEqual(out.health, 'ok', logs.join('\n'));
  assert.strictEqual(db.prepare('SELECT status FROM runs').get().status, 'ok');
  assert.strictEqual(last.health, 'ok');
});

test('end to end: a token that expires in 2 days (debug_token) makes the run red after saving everything', async () => {
  const { db, doFetch: d1Fetch } = d1Rest();
  const exp = Math.floor((Date.now() + 2.5 * 864e5) / 1000);
  const meta = fakeFetch([], { debug: () => json({ data: { app_id: '1', is_valid: true, expires_at: exp } }) });
  const search = (o, d) => hunt(Object.assign({}, o, { base: 'https://graph.test' }), Object.assign({}, d, { fetch: meta, now: NOW }));
  const logs = [];
  const out = await run({ tokens: ['tok'], keywords: ['dress'], minutes: 60, countries: ['NL', 'BE'] }, {
    db: d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Fetch, retryMs: 0 }), search, photo: async () => '', log: (m) => logs.push(m),
    tokenCheck: (tk) => checkTokens(tk, { fetch: meta, base: 'https://graph.test' }),
  });
  assert.strictEqual(out.health, 'failed');
  assert.ok(logs.some((l) => /^::error::Meta token META_TOKEN verloopt over 2 dagen/.test(l)), logs.join('\n'));
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM winners').get().n > 0, 'winners saved');
  assert.strictEqual(db.prepare('SELECT status FROM runs').get().status, 'failed');
  assert.strictEqual(JSON.parse(db.prepare("SELECT value FROM state WHERE key = 'token_expires_at'").get().value).at, new Date(exp * 1000).toISOString());
});
