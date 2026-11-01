// CI/CD and operations: the workflows (.github/workflows), what the hunt outside the EU does to the live board's tables
// when runs overlap, when the board reads its tables again, the hunt's time budget and health, the ad viewer switch, and
// the D1 restore point before migrating. The workflow steps run here in bash as GitHub runs them, with a fake npx.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { d1Client } from '../lib/d1.mjs';
import { resetCooling } from '../lib/world.mjs';
import { hunt, MAX_MINUTES, minutesOf } from '../world.mjs';
import { main as migrateMain, bookmark } from '../migrate.mjs';
import { handle, makeToken } from '../worker/src/app.mjs';
import { d1Binding, d1Rest, memoryDb } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW as SEED_NOW } from './helpers/seed.mjs';

const NOW = Date.UTC(2026, 9, 31, 12);
const DAY = 864e5;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------
// The workflows
// ---------------------------------------------------------------------------
const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url);
const wf = (name) => fs.readFileSync(new URL(name, WORKFLOWS), 'utf8');
const ALL = fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));
/** One job's lines (a 2-space key under jobs:). */
const job = (text, name) => (new RegExp(`^  ${name}:\\n((?:(?:    .*)?\\n)*)`, 'm').exec(text) || [])[1] || '';
/** The step (a "      - " item) whose text matches re. */
const step = (text, re) => text.split(/^(?=      - )/m).find((s) => re.test(s)) || '';
/** A step's `run: |` script, as bash gets it. */
function script(stepText) {
  const lines = stepText.split('\n');
  const i = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(i >= 0, 'a run: | script');
  const indent = lines[i].search(/\S/) + 2;
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && l.search(/\S/) < indent) break;
    out.push(l.slice(indent));
  }
  return out.join('\n');
}
const BASH = spawnSync('bash', ['-c', 'true']).status === 0;
/** Runs a step's script as GitHub does (bash -e, no pipefail unless the script sets it), with an npx that prints `out` and exits `code`. */
function runStep(text, { out = '', code = 0, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-step-'));
  try {
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'npx'), '#!/bin/bash\nprintf "%s\\n" "$FAKE_OUT"\nexit "$FAKE_CODE"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'step.sh'), text);
    for (const f of ['summary.md', 'output']) fs.writeFileSync(path.join(dir, f), '');
    const r = spawnSync('bash', ['-e', path.join(dir, 'step.sh')], { encoding: 'utf8', env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, RUNNER_TEMP: dir,
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary.md'), GITHUB_OUTPUT: path.join(dir, 'output'), FAKE_OUT: out, FAKE_CODE: String(code), ...env } });
    return { status: r.status, log: r.stdout + r.stderr, summary: fs.readFileSync(path.join(dir, 'summary.md'), 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('every action in the workflows is pinned to a commit, not a tag that can move', () => {
  let n = 0;
  for (const f of ALL) {
    for (const [, ref] of wf(f).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) {
      if (ref.startsWith('./')) continue; // a workflow of this repository
      n++;
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f}: ${ref}`);
    }
  }
  assert.ok(n >= 12);
});

test('a test link from a branch never runs the hunt, the store signals or migrations on the live database', () => {
  const preview = wf('preview-board.yml');
  assert.doesNotMatch(preview, /node winner-hunter\//, 'no hunt, no store signals, no migrations');
  assert.doesNotMatch(preview, /\bD1_DATABASE_ID\b|\bCF_API_TOKEN:|CF_D1_TOKEN/, 'no database settings for scripts');
  assert.match(preview, /wrangler@4 versions upload --preview-alias/, 'it still uploads a test version');
  assert.doesNotMatch(preview, /wrangler@4 deploy\b/, 'and never deploys');
  assert.doesNotMatch(preview, /'winner-hunter\/(?:world|bestsellers)\.mjs'|'winner-hunter\/lib\/\*\*'/, 'only the board\'s own files start it');
});

test('the deploy waits for the tests, and the tests run on every pull request', () => {
  const deploy = wf('deploy-board.yml');
  assert.match(job(deploy, 'test'), /^    uses: \.\/\.github\/workflows\/tests\.yml$/m);
  assert.match(job(deploy, 'deploy'), /^    needs: test$/m);
  const tests = wf('tests.yml');
  assert.match(tests, /^on:\n(?:  .*\n)*  pull_request:/m);
  assert.match(tests, /^on:\n(?:  .*\n)*  workflow_call:/m);
  assert.match(step(job(tests, 'test'), /name: Tests\n/), /run: npm test$/m);
  assert.match(step(job(tests, 'test'), /name: Tests\n/), /CHROME_PATH: \/usr\/bin\/google-chrome/, 'the browser tests run, in the runner\'s Chrome');
  assert.doesNotMatch(tests, /secrets\./, 'no secrets in the tests');
});

test('a failed wrangler deploy ends red; a deploy without a board address too; the address stays out of a public log', { skip: !BASH && 'no bash' }, () => {
  const run = script(step(job(wf('deploy-board.yml'), 'deploy'), /name: Deploy\n/));
  const ok = '⛅️ wrangler 4\nUploaded winner-hunter-clean (3.1 sec)\nDeployed winner-hunter-clean triggers (0.4 sec)\n  https://winner-hunter-clean.secretsub.workers.dev\nCurrent Version ID: 1234';
  const failed = runStep(run, { out: '✘ [ERROR] A request to the Cloudflare API failed.', code: 1, env: { HIDE: 'true' } });
  assert.notStrictEqual(failed.status, 0, 'wrangler failed: the step fails (it used to end green behind tee)');
  const noAddress = runStep(run, { out: 'Uploaded winner-hunter-clean', env: { HIDE: 'true' } });
  assert.notStrictEqual(noAddress.status, 0);
  assert.match(noAddress.log, /::error::The deploy printed no board address/);
  const hidden = runStep(run, { out: ok, env: { HIDE: 'true' } });
  assert.strictEqual(hidden.status, 0, hidden.log);
  assert.doesNotMatch(hidden.log + hidden.summary, /secretsub/, 'public repository: no subdomain in the log or the summary');
  assert.match(hidden.summary, /## Board: https:\/\/winner-hunter-clean\.\*\*\*\.workers\.dev/);
  const shown = runStep(run, { out: ok, env: { HIDE: 'false' } });
  assert.match(shown.summary, /## Board: https:\/\/winner-hunter-clean\.secretsub\.workers\.dev/, 'private repository: the link as before');
});

test('a test link: its upload fails red, and a public log only shows the address with its subdomain hidden', { skip: !BASH && 'no bash' }, () => {
  const run = script(step(job(wf('preview-board.yml'), 'preview'), /name: Upload a test version/));
  const out = 'Worker Version ID: 9f8e\nVersion Preview URL: https://9f8e-winner-hunter-clean.secretsub.workers.dev\nVersion Preview Alias URL: https://feature-fast-lane-winner-hunter-clean.secretsub.workers.dev';
  const env = { GITHUB_REF_NAME: 'Feature/Fast-Lane', HIDE: 'true' };
  const up = runStep(run, { out, env });
  assert.strictEqual(up.status, 0, up.log);
  assert.doesNotMatch(up.log + up.summary, /secretsub/);
  assert.match(up.summary, /"feature-fast-lane-" in front/);
  assert.match(runStep(run, { out, env: { ...env, HIDE: 'false' } }).summary, /## Test link: https:\/\/feature-fast-lane-winner-hunter-clean\.secretsub\.workers\.dev/);
  assert.notStrictEqual(runStep(run, { out: '✘ [ERROR] Authentication error', code: 1, env }).status, 0);
});

test('the Worker gets no Meta token from the deploy, and no board address goes through a step\'s env (GitHub prints it)', () => {
  const deploy = wf('deploy-board.yml');
  assert.doesNotMatch(deploy, /secret put META_TOKEN|^\s+META_TOKEN:/m);
  for (const f of ALL) assert.doesNotMatch(wf(f), /outputs\.url/, f);
});

test('the hunts use a D1-only token when there is one, else the old token', () => {
  for (const f of ['world-hunter.yml', 'winner-hunter.yml', 'world-check.yml', 'ad-prefetch.yml']) {
    assert.match(wf(f), /^      CF_API_TOKEN: \$\{\{ secrets\.CF_D1_TOKEN \|\| secrets\.CF_API_TOKEN \}\}$/m, f);
  }
  assert.match(wf('deploy-board.yml'), /^      CF_API_TOKEN: \$\{\{ secrets\.CF_API_TOKEN \}\}$/m, 'the deploy changes the Worker: the full token');
});

test('the hunt outside the EU fits in its job: at most 135 minutes, and the job\'s timeout leaves room for the board, Jev and the store signals', () => {
  assert.strictEqual(MAX_MINUTES, 135);
  assert.strictEqual(minutesOf(undefined), 120);
  assert.strictEqual(minutesOf(''), 120);
  assert.strictEqual(minutesOf('45'), 45);
  assert.strictEqual(minutesOf('300'), MAX_MINUTES, 'it used to allow 300 against a 180-minute job');
  assert.strictEqual(minutesOf('-5'), 1);
  const timeout = Number(/^    timeout-minutes: (\d+)$/m.exec(job(wf('world-hunter.yml'), 'hunt'))[1]);
  assert.ok(timeout >= MAX_MINUTES + 45, `timeout ${timeout} minutes: the board table (~5), Jev (15) and the store signals (15) after the search`);
  assert.match(wf('world-hunter.yml'), /max 135/);
});

// ---------------------------------------------------------------------------
// The hunt outside the EU on a fake Ad Library and fake shops
// ---------------------------------------------------------------------------
const sec = (daysAgo) => Math.floor((NOW - daysAgo * DAY) / 1000);
const ad = (id, store = 'pod.test') => ({ ad_archive_id: id, page_id: '11', collation_id: 'c' + id, collation_count: 1, is_active: true, start_date: sec(40),
  snapshot: { page_name: 'Pod Shop', page_id: '11', page_like_count: 10, link_url: `https://${store}/products/pillow`, caption: store, title: 'Pillow', images: [], cards: [] } });
/** Every keyword search finds `ads` (AU only, or everywhere with all: true); shop pages find nothing. */
const library = (ads, { all = false } = {}) => ({ search: async (w) => ({ ads: w.pageId || (!all && w.cc !== 'AU') ? [] : ads, count: 0, blocked: false }) });
/** Shopify stores: meta.json and the product; `limited(url)` answers 429. */
const shops = (limited = () => false) => async (url) => {
  if (limited(url)) return new Response('', { status: 429 });
  const u = new URL(url);
  if (u.pathname === '/meta.json') return json({ myshopify_domain: 'x.myshopify.com', currency: 'AUD', published_products_count: 5 });
  if (u.pathname === '/products/pillow.json') return json({ product: { title: 'Pod Pillow', variants: [{ price: '49' }] } });
  return new Response('', { status: 404 });
};
const KEYWORDS = [{ en: 'pillow' }];
const quiet = { log: () => {}, sleep: async () => {}, maxPages: 0, tokens: [], shopOpts: { tries: 1 } };
const setup = (mem = memoryDb()) => ({ mem, client: d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(mem).doFetch, retryMs: 0 }) });
const activeRows = (mem) => mem.prepare('SELECT product_key, run_id FROM world_products WHERE active = 1').all().map((r) => ({ ...r }));

for (const [name, pausedAt, otherAt] of [['the older run takes products off last', NOW, NOW + 3600e3], ['an older run writes while the newer one waits', NOW + 3600e3, NOW]]) {
  test(`two hunts at once never take each other's products off the board (${name})`, async () => {
    const { mem, client } = setup();
    let release;
    const gate = new Promise((r) => (release = r));
    let reached;
    const atDeactivate = new Promise((r) => (reached = r));
    // The first run stops right before it takes products off; the other run does all of its work in between.
    const paused = { ...client, query: async (sql, a) => { if (/^UPDATE world_products SET active = 0/.test(sql)) { reached(); await gate; } return client.query(sql, a); } };
    const first = hunt({ db: paused, lib: library([ad('1')]), keywords: KEYWORDS, doFetch: shops(), now: () => pausedAt, ...quiet });
    await atDeactivate;
    await hunt({ db: client, lib: library([ad('1')]), keywords: KEYWORDS, doFetch: shops(), now: () => otherAt, ...quiet });
    release();
    await first;
    const newer = new Date(Math.max(pausedAt, otherAt)).toISOString();
    assert.deepStrictEqual(activeRows(mem), [{ product_key: 'pod.test/products/pillow', run_id: newer }], 'on the board, as the newer run wrote it (it used to end with none)');
  });
}

test('a hunt only takes products off that are still on: rows already off are not written again', async () => {
  const { mem, client } = setup();
  const put = mem.prepare("INSERT INTO world_products (product_key, ad_id, active, run_id, last_seen) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')");
  put.run('off.test/products/x', 'w8', 0);
  put.run('gone.test/products/y', 'w9', 1);
  mem.exec('CREATE TABLE writes (k TEXT); CREATE TRIGGER count_writes AFTER UPDATE OF active ON world_products BEGIN INSERT INTO writes VALUES (old.product_key); END;');
  await hunt({ db: client, lib: library([ad('1')]), keywords: KEYWORDS, doFetch: shops(), now: () => NOW, ...quiet });
  const writes = mem.prepare('SELECT k FROM writes').all().map((r) => r.k);
  assert.ok(!writes.includes('off.test/products/x'), 'already off: not written again (D1 counts every row written)');
  assert.ok(writes.includes('gone.test/products/y'), 'no longer seen: taken off');
  assert.deepStrictEqual(activeRows(mem).map((r) => r.product_key), ['pod.test/products/pillow']);
});

test('the board reads its tables again when a hunt wrote the board\'s table, not on every progress save of the hunt', async () => {
  const mem = memoryDb();
  const { client } = setup(mem);
  const env = { DB: d1Binding(mem), BOARD_PIN: '1234' };
  const cookie = `__Host-wh=${await makeToken('1234', NOW)}`;
  const reads = () => env.DB.log.filter((l) => /FROM winners w$/.test(l.sql.trim())).length;
  const seen = [];
  let last = null;
  // After every state save of the hunt, the board is opened (as a phone would, any time during a run).
  const db = { ...client, setState: async (k, v, at) => {
    await client.setState(k, v, at);
    if (k !== 'world_run' && k !== 'world_data') return;
    const before = reads();
    last = await (await handle(new Request('https://board.test/api/ads?scope=world&view=all', { headers: { cookie } }), env, { html: '', now: NOW })).json();
    seen.push([k, reads() - before]);
  } };
  let t0 = NOW;
  const many = Array.from({ length: 3 }, (_, i) => ad(String(10 + i)));
  await hunt({ db, lib: library(many, { all: true }), keywords: [{ en: 'pillow' }, { en: 'dog' }], doFetch: shops(), now: () => (t0 += 1000), ...quiet });
  const progress = seen.filter(([k]) => k === 'world_run');
  assert.ok(progress.length >= 6, `${progress.length} progress saves`);
  assert.deepStrictEqual(progress.slice(1).map(([, n]) => n), progress.slice(1).map(() => 0), 'no new read for a progress save (it used to read all five tables each time)');
  assert.deepStrictEqual(seen.filter(([k]) => k === 'world_data'), [['world_data', 1], ['world_data', 1]], 'read again once the board\'s table was written, and once at the end');
  assert.strictEqual(last.world_run.status, 'done', 'the run\'s own status is always fresh');
  assert.deepStrictEqual(last.ads.map((a) => a.title), ['Pod Pillow']);
});

test('a Shopify rate-limit storm makes the run yellow and says so; a few 429s do not', async () => {
  resetCooling();
  const stores = Array.from({ length: 30 }, (_, i) => ad(String(100 + i), `s${i}.test`));
  const storm = await hunt({ db: setup().client, lib: library(stores), keywords: KEYWORDS, doFetch: shops(() => true), now: () => NOW, ...quiet });
  assert.strictEqual(storm.health, 'warning', 'it used to pass as a healthy run');
  assert.strictEqual(storm.shop_limited, 30);
  assert.strictEqual(storm.shop_asked, 30);
  assert.match(storm.alert, /Shopify rate-limited 30 of 30 store requests \(429\)/);
  const few = await hunt({ db: setup().client, lib: library(stores), keywords: KEYWORDS, doFetch: shops((u) => /\/\/s[01]\.test\//.test(u)), now: () => NOW, ...quiet });
  assert.strictEqual(few.health, 'ok');
  assert.strictEqual(few.alert, '');
  assert.strictEqual(few.shop_limited, 2);
  assert.ok(few.shop_asked >= 30);
  const small = await hunt({ db: setup().client, lib: library(stores.slice(0, 5)), keywords: KEYWORDS, doFetch: shops(() => true), now: () => NOW, ...quiet });
  assert.strictEqual(small.health, 'ok', 'five stores say little: no warning for a handful');
  resetCooling();
});

// ---------------------------------------------------------------------------
// The ad viewer switch and the D1 restore point
// ---------------------------------------------------------------------------
test('/api/ad is off unless the Worker has AD_VIEWER = "on", even with a Meta token and a browser', async () => {
  const env = await seededEnv();
  Object.assign(env, { META_TOKEN: 'EAAB tok', BROWSER: { fetch: () => { throw new Error('not in tests'); } } });
  const cookie = `__Host-wh=${await makeToken(env.BOARD_PIN, SEED_NOW)}`;
  let launched = 0;
  const launch = async () => { launched++; throw new Error('no browser in tests'); };
  const get = (p, e = env) => handle(new Request('https://board.test' + p, { headers: { cookie } }), e, { html: '', now: SEED_NOW, launch });
  const off = await get('/api/ad/1234567890');
  assert.strictEqual(off.status, 404);
  assert.strictEqual(launched, 0, 'no browser opened, the token never used');
  assert.strictEqual((await (await get('/api/ads')).json()).viewer, false);
  const on = { ...env, AD_VIEWER: 'on' };
  assert.notStrictEqual((await get('/api/ad/1234567890', on)).status, 404);
  assert.strictEqual(launched, 1, 'turned on: the viewer works as before');
  assert.strictEqual((await (await get('/api/ads', on)).json()).viewer, true);
});

test('migrating: D1\'s Time Travel bookmark is noted first, then the tables are made; without a bookmark it still migrates', async () => {
  const run = async (answer) => {
    const db = new DatabaseSync(':memory:');
    const rest = d1Rest(db);
    const calls = [];
    const doFetch = async (url, init = {}) => {
      calls.push({ url, auth: init.headers && init.headers.Authorization });
      return /\/time_travel\/bookmark$/.test(url) ? answer() : rest.doFetch(url, init);
    };
    const logs = [];
    const out = await migrateMain({ env: { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acc', D1_DATABASE_ID: 'db1' }, doFetch, log: (m) => logs.push(m) });
    return { out, calls, logs, db };
  };
  const mark = '0000002a-00000001-00004f1b-c0ffee';
  const ok = await run(async () => json({ success: true, errors: [], messages: [], result: { bookmark: mark } }));
  assert.strictEqual(ok.out.bookmark, mark);
  assert.deepStrictEqual(ok.calls[0], { url: 'https://api.cloudflare.com/client/v4/accounts/acc/d1/database/db1/time_travel/bookmark', auth: 'Bearer tok' });
  assert.ok(ok.calls.length > 10 && ok.calls.slice(1).every((c) => c.url.endsWith('/query')), 'the bookmark before the first statement');
  assert.match(ok.logs[0], new RegExp(`^::notice title=D1 restore point::.*time-travel restore winner-hunter-clean --bookmark=${mark}$`));
  assert.ok(ok.db.prepare("SELECT name FROM sqlite_master WHERE name = 'world_products'").get(), 'the tables are made');
  for (const answer of [async () => json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403), async () => { throw new Error('network'); }]) {
    const no = await run(answer);
    assert.strictEqual(no.out.bookmark, '');
    assert.match(no.logs[0], /^::warning::No D1 Time Travel bookmark/);
    assert.ok(no.db.prepare("SELECT name FROM sqlite_master WHERE name = 'world_products'").get(), 'migrated all the same');
  }
  assert.strictEqual(await bookmark({ accountId: 'a', databaseId: 'b', token: 't' }, async () => json({ success: true, result: {} })), '');
  await assert.rejects(migrateMain({ env: {}, doFetch: async () => { throw new Error('asked'); }, log: () => {} }), /No CF_API_TOKEN/);
});
