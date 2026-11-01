// The Problem Database on the board's side: the migration (0040_problems.sql: new tables only, safe to run again),
// the PIN-gated API (/api/problems, /api/problems/<id>, decisions, /problems.csv, /problems.json), and the workflow
// (problem-hunter.yml: off by default, a credit cap on every run, nothing that spends by itself).
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { migrate, statements } from '../lib/d1.mjs';
import { handle, tokenFor, csvCell as boardCsvCell } from '../worker/src/app.mjs';
import { CSV_COLS, csvCell, filterProblems, filtersOf, foldText, problemOut } from '../worker/src/problems.mjs';
import { d1Rest } from './helpers/sqlite-d1.mjs';
import { problemEnv } from './helpers/problems.mjs';

const MIGRATIONS = new URL('../worker/migrations/', import.meta.url);
const MIGRATION = fs.readFileSync(new URL('0040_problems.sql', MIGRATIONS), 'utf8');
const ORIGIN = 'https://board.test';

test('the migration: only new tables and indexes, nothing dropped or rewritten, and safe to run twice', async () => {
  const sql = statements(MIGRATION);
  assert.ok(sql.length >= 5);
  for (const s of sql) assert.match(s, /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS /, s.slice(0, 60));
  assert.doesNotMatch(MIGRATION.replace(/--.*$/gm, ''), /\b(DROP|DELETE|UPDATE|ALTER|INSERT|REPLACE)\b/i, 'no statement that changes what is there');
  // On a database with every other migration (as the live one), through migrate() as migrate.mjs runs it, twice.
  const db = new DatabaseSync(':memory:');
  const rest = d1Rest(db);
  const client = { query: async (s, p) => { const r = await rest.doFetch('https://api.cloudflare.com/x/query', { body: JSON.stringify({ sql: s, params: p }) }); const j = await r.json(); if (!j.success) throw new Error('Cloudflare D1: ' + j.errors[0].message); return j.result[0].results; } };
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.indexOf('0040_problems.sql') > files.indexOf('0015_launch.sql'), 'after every migration on main');
  const texts = files.map((f) => fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  await migrate(client, texts);
  db.prepare("INSERT INTO problems (id, title, matched_products) VALUES ('p_000000000001', 'kept', '[1]')").run();
  db.prepare("INSERT INTO problem_decisions (problem_id, decision, at) VALUES ('p_000000000001', 'starred', 'x')").run();
  await migrate(client, texts);
  assert.deepStrictEqual({ ...db.prepare('SELECT title, matched_products, active, sample FROM problems').get() }, { title: 'kept', matched_products: '[1]', active: 1, sample: 0 }, 'a second run keeps every row');
  assert.strictEqual(db.prepare('SELECT decision FROM problem_decisions').get().decision, 'starred');
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  for (const c of ['id', 'title', 'statement', 'area', 'lang', 'country', 'platforms', 'mentions', 'engagement', 'first_seen', 'last_seen', 'trend', 'intensity', 'wtp', 'quotes', 'matched_products']) assert.ok(cols('problems').includes(c), c);
  assert.ok(!cols('problem_mentions').some((c) => /author$|username|handle/.test(c)), 'no column for a name');
  assert.throws(() => db.prepare("INSERT INTO problem_decisions (problem_id, decision) VALUES ('p_1', 'approved')").run(), /CHECK/);
  assert.strictEqual(db.prepare("SELECT dflt_value FROM pragma_table_info('problems') WHERE name = 'matched_products'").get().dflt_value, "'[]'");
});

const get = async (env, path, cookie, now) => handle(new Request(ORIGIN + path, { headers: cookie ? { cookie } : {} }), env, { html: '', now });
const post = (env, cookie, body, now, headers = { 'content-type': 'application/json' }) => handle(new Request(ORIGIN + '/api/problems', { method: 'POST', headers: { ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) }), env, { html: '', now });

test('every Problems route needs the PIN cookie', async () => {
  const { env, now } = await problemEnv();
  for (const path of ['/api/problems', '/api/problems/p_000000000001', '/problems.json']) {
    const res = await get(env, path, '', now);
    assert.strictEqual(res.status, 401, path);
    assert.deepStrictEqual(await res.json(), { error: 'Log in first' });
  }
  assert.strictEqual((await get(env, '/problems.csv', '', now)).status, 401);
  assert.strictEqual((await post(env, '', { id: 'p_000000000001', decision: 'saved' }, now)).status, 401);
  assert.strictEqual((await get(env, '/api/problems', '__Host-wh=123.forgedforgedforgedforged', now)).status, 401);
});

test('/api/problems: every problem with its quotes, filters, sorts, pages, facets and run status', async () => {
  const { env, now } = await problemEnv();
  const cookie = `__Host-wh=${await tokenFor(env, now)}`;
  const list = async (q = '') => (await get(env, '/api/problems' + q, cookie, now)).json();
  const all = await list();
  assert.strictEqual(all.total, 8);
  assert.strictEqual(all.sample, true);
  assert.deepStrictEqual(all.views, { open: 8, saved: 0, starred: 0, ignored: 0, all: 8 });
  const first = all.problems[0];
  for (const k of ['id', 'title', 'statement', 'area', 'lang', 'langs', 'country', 'countries', 'platforms', 'mentions', 'authors', 'engagement', 'first_seen', 'last_seen', 'trend', 'growth', 'monthly', 'intensity', 'wtp', 'wtp_signals', 'keywords', 'quotes', 'matched_products', 'decision']) assert.ok(k in first, k);
  assert.deepStrictEqual(first.matched_products, [], 'empty, for the later product matching');
  assert.ok(!('find' in first), 'no internal fields');
  assert.ok(all.problems.every((p, i, a) => i === 0 || a[i - 1].intensity >= p.intensity), 'by intensity');
  assert.ok(all.problems.every((p) => p.quotes.length && p.quotes.every((q) => q.url.startsWith('https://'))));
  assert.strictEqual(all.areas.pets, 'Pets');
  assert.deepStrictEqual(all.facets.langs, { en: 4, nl: 2, de: 2 });
  assert.strictEqual(all.runs.process.problems, 8);
  const ids = (j) => j.problems.map((p) => p.title);
  assert.deepStrictEqual(ids(await list('?area=pets&sort=volume')), ['Dog hair · Couch · Vacuum', 'Kattenbak · Stinkt · Stank']);
  assert.deepStrictEqual((await list('?lang=de')).problems.map((p) => p.lang), ['de', 'de']);
  assert.strictEqual((await list('?country=NL')).total, 2);
  assert.ok((await list('?platform=tiktok')).problems.every((p) => p.platforms.tiktok > 0));
  assert.ok((await list('?min=5')).problems.every((p) => p.mentions >= 5));
  assert.strictEqual((await list('?min=5')).total, 5);
  assert.ok((await list('?trend=rising')).problems.every((p) => p.trend === 'rising'));
  assert.deepStrictEqual((await list('?pay=1')).problems.map((p) => p.wtp_signals.pay > 0), [true, true]);
  assert.strictEqual((await list('?q=Lösung')).total, 1, 'the search reads the quotes too, accents folded');
  assert.strictEqual((await list('?q=kattenbak%20stinkt')).total, 1, 'every word must be in it');
  assert.strictEqual((await list('?q=nothing-like-this')).total, 0);
  const growth = await list('?sort=growth');
  assert.ok(growth.problems.every((p, i, a) => i === 0 || a[i - 1].growth >= p.growth));
  const page = await list('?sort=volume&limit=3&offset=3');
  assert.deepStrictEqual([page.problems.length, page.offset, page.limit, page.total], [3, 3, 3, 8]);
  assert.strictEqual((await list('?limit=99999')).limit, 200, 'at most 200 a page');
  // Unknown filter values are ignored, never an error.
  const odd = await list("?sort=';DROP TABLE problems;--&view=everything&lang=english&country=nl&min=-4");
  assert.deepStrictEqual([odd.total, odd.filters.sort, odd.filters.view, odd.filters.lang, odd.filters.country, odd.filters.min], [8, 'intensity', 'open', '', '', 1]);
});

test('decisions: save, star, ignore and take back; one per problem; they survive a new processing run', async () => {
  const { env, client, now } = await problemEnv();
  const cookie = `__Host-wh=${await tokenFor(env, now)}`;
  const list = async (q = '') => (await get(env, '/api/problems' + q, cookie, now)).json();
  const [a, b, c] = (await list('?sort=volume')).problems;
  for (const [p, d] of [[a, 'starred'], [b, 'saved'], [c, 'ignored']]) {
    const res = await post(env, cookie, { id: p.id, decision: d }, now);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, id: p.id, decision: d });
  }
  assert.deepStrictEqual((await list()).views, { open: 5, saved: 1, starred: 1, ignored: 1, all: 8 });
  assert.deepStrictEqual((await list('?view=starred')).problems.map((p) => [p.id, p.decision]), [[a.id, 'starred']]);
  assert.ok(!(await list()).problems.some((p) => [a.id, b.id, c.id].includes(p.id)), 'decided problems leave Open');
  assert.strictEqual((await list('?view=all')).total, 8);
  // Changing your mind replaces the decision; '' takes it back.
  await post(env, cookie, { id: a.id, decision: 'ignored' }, now);
  assert.strictEqual(env.db.prepare('SELECT COUNT(*) AS n FROM problem_decisions WHERE problem_id = ?').get(a.id).n, 1);
  assert.strictEqual((await list('?view=ignored')).total, 2);
  await post(env, cookie, { id: a.id, decision: '' }, now);
  assert.strictEqual((await list('?view=ignored')).total, 1);
  // A new processing run: the decisions stay with their problems.
  const { processRun, settingsOf } = await import('../problems-process.mjs');
  await processRun({ db: client, settings: { ...settingsOf({}), sample: true }, now: now + 3600e3, log: () => {} });
  assert.deepStrictEqual((await list('?view=saved')).problems.map((p) => p.id), [b.id]);
  // The detail: the problem and the quotes behind it.
  const d = await (await get(env, `/api/problems/${b.id}`, cookie, now)).json();
  assert.strictEqual(d.problem.decision, 'saved');
  assert.ok(d.quotes.length >= d.problem.quotes.length && d.quotes.every((q) => q.url.startsWith('https://')));
  assert.ok(d.quotes.every((q, i, x) => i === 0 || x[i - 1].score >= q.score), 'most liked first');
});

test('the Problems API refuses bad input, other origins, other methods and unknown problems', async () => {
  const { env, now } = await problemEnv();
  const cookie = `__Host-wh=${await tokenFor(env, now)}`;
  const { problems: [p] } = await (await get(env, '/api/problems', cookie, now)).json();
  for (const [body, status] of [[{ id: "p_1' OR 1=1", decision: 'saved' }, 400], [{ id: p.id, decision: 'approved' }, 400], [{ id: 'p_0123456789ab', decision: 'saved' }, 404], [{}, 400], [[], 400]]) {
    assert.strictEqual((await post(env, cookie, body, now)).status, status, JSON.stringify(body));
  }
  assert.strictEqual((await post(env, cookie, { id: p.id, decision: 'saved' }, now, { 'content-type': 'text/plain' })).status, 415);
  assert.strictEqual((await post(env, cookie, { id: p.id, decision: 'saved' }, now, { 'content-type': 'application/json', origin: 'https://evil.test' })).status, 403);
  const big = await handle(new Request(ORIGIN + '/api/problems', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: p.id, decision: 'saved', pad: 'x'.repeat(5000) }) }), env, { html: '', now });
  assert.strictEqual(big.status, 413);
  assert.strictEqual((await handle(new Request(ORIGIN + '/api/problems', { method: 'DELETE', headers: { cookie } }), env, { html: '', now })).status, 405);
  assert.strictEqual((await handle(new Request(ORIGIN + '/problems.csv', { method: 'POST', headers: { cookie } }), env, { html: '', now })).status, 405);
  assert.strictEqual((await get(env, '/api/problems/not-an-id', cookie, now)).status, 400);
  assert.strictEqual((await get(env, '/api/problems/%E0%A4%A', cookie, now)).status, 400, 'a broken escape is a bad id, not a crash');
  assert.strictEqual((await get(env, '/api/problems/p_0123456789ab', cookie, now)).status, 404);
  // Before the migration (an older database): an empty tab, not an error.
  const { DatabaseSync: D } = await import('node:sqlite');
  const bare = new D(':memory:');
  bare.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT); CREATE TABLE pin_tries (ip TEXT PRIMARY KEY, n INTEGER, since INTEGER)");
  const { d1Binding } = await import('./helpers/sqlite-d1.mjs');
  const old = { DB: d1Binding(bare), BOARD_PIN: env.BOARD_PIN };
  const oc = `__Host-wh=${await tokenFor(old, now)}`;
  const empty = await get(old, '/api/problems', oc, now);
  assert.strictEqual(empty.status, 200);
  assert.deepStrictEqual((await empty.json()).total, 0);
});

test('exports: CSV and JSON of exactly what the filters show, formulas never run in a spreadsheet', async () => {
  const { env, now } = await problemEnv();
  const cookie = `__Host-wh=${await tokenFor(env, now)}`;
  env.db.prepare('UPDATE problems SET title = ? WHERE id = (SELECT id FROM problems ORDER BY mentions DESC LIMIT 1)').run('=HYPERLINK("http://evil.test","x"), "quoted"');
  const csvRes = await get(env, '/problems.csv?area=pets&sort=volume', cookie, now);
  assert.strictEqual(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type'), /^text\/csv/);
  assert.match(csvRes.headers.get('content-disposition'), /^attachment; filename="problems-open-\d{4}-\d{2}-\d{2}\.csv"$/);
  const csv = await csvRes.text();
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines[0], CSV_COLS.map((c) => c[0]).join(','));
  assert.strictEqual(lines.length, 3, 'the header and the two pets problems');
  assert.ok(lines[1].startsWith('p_'));
  assert.match(csv, /,"'=HYPERLINK\(""http:\/\/evil\.test"",""x""\), ""quoted""",/, 'a formula is quoted and starts with \'');
  assert.match(lines[1], /,\[\],rules,/, 'matched_products: an empty list');
  for (const v of ['=1+1', '+1', '-1', '@x', 'plain', 'a,b', 'a\nb', 'x"y', 7, null]) assert.strictEqual(csvCell(v), boardCsvCell(v), String(v));
  const jsonRes = await get(env, '/problems.json?view=all&lang=nl', cookie, now);
  assert.match(jsonRes.headers.get('content-disposition'), /problems-all-.*\.json"$/);
  const j = await jsonRes.json();
  assert.deepStrictEqual([j.count, j.filters.view, j.filters.lang], [2, 'all', 'nl']);
  assert.ok(j.problems.every((p) => Array.isArray(p.matched_products) && p.quotes.length && p.langs.nl));
});

test('the filters and the record, on their own', () => {
  const f = filtersOf(new URLSearchParams('q=Hond&area=pets&lang=nl&country=NL&platform=reddit&min=3&trend=new&pay=1&view=saved&sort=wtp'));
  assert.deepStrictEqual(f, { q: 'Hond', area: 'pets', lang: 'nl', country: 'NL', platform: 'reddit', min: 3, trend: 'new', pay: true, view: 'saved', sort: 'wtp' });
  const p = problemOut({ id: 'p_000000000001', title: 'T', quotes: JSON.stringify([{ text: 'x', url: 'javascript:alert(1)' }, { text: 'y', url: 'https://www.reddit.com/r/x/' }]), langs: 'not json', trend: 'sideways', matched_products: '[]' });
  assert.deepStrictEqual([p.quotes.length, p.langs, p.trend, p.matched_products, p.decision], [1, {}, 'steady', [], null], 'a link that is not https never reaches the board');
  assert.strictEqual(foldText('Lösung Straße'), 'losung strasse');
  const rows = [{ ...p, find: 'dog hair', mentions: 2, langs: { en: 2 }, countries: {}, platforms: { reddit: 2 }, wtp_signals: { pay: 0 } }];
  assert.strictEqual(filterProblems(rows, filtersOf(new URLSearchParams('q=hair'))).length, 1);
  assert.strictEqual(filterProblems(rows, filtersOf(new URLSearchParams('q=hair')), new Map([['p_000000000001', { decision: 'ignored' }]])).length, 0, 'decided: out of Open');
});

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------
const WF = fs.readFileSync(new URL('../../.github/workflows/problem-hunter.yml', import.meta.url), 'utf8');
const TESTS_WF = fs.readFileSync(new URL('../../.github/workflows/tests.yml', import.meta.url), 'utf8');

test('Problem Hunter is off by default: by hand, or on the schedule only when the variable says so', () => {
  assert.match(WF, /^on:\n  workflow_dispatch:\n/m);
  assert.match(WF, /^  schedule:\n    # Starts nothing unless the repository variable PROBLEMS_SCHEDULE is "on"\.\n    - cron: /m);
  assert.match(WF, /^    if: github\.event_name == 'workflow_dispatch' \|\| vars\.PROBLEMS_SCHEDULE == 'on'$/m, 'the job: by hand, or the switch');
  assert.doesNotMatch(WF, /\bpush:|\bpull_request:|workflow_run:/, 'nothing else starts it');
  assert.match(WF, /^permissions:\n  contents: read$/m);
  assert.match(WF, /^concurrency:\n  group: problem-hunter\n  cancel-in-progress: false$/m);
});

test('Problem Hunter: a credit cap on every run, a dry run that writes nothing, the D1-only token, pinned actions', () => {
  assert.match(WF, /^      max_credits:\n        description: .*\n        required: true\n        default: '100'$/m);
  assert.match(WF, /^      PROBLEM_MAX_CREDITS: \$\{\{ inputs\.max_credits \|\| vars\.PROBLEMS_MAX_CREDITS \|\| '100' \}\}$/m, 'a cap by hand, from the variable, or 100');
  assert.match(WF, /^      dry_run:\n        description: .*\n        type: boolean\n        default: false$/m);
  assert.match(WF, /^      PROBLEM_DRY_RUN: \$\{\{ inputs\.dry_run && '1' \|\| '' \}\}$/m);
  // A dry run: no tables made, no grouping written, no SDK installed.
  for (const name of ['Database tables', 'Install the Anthropic SDK', 'Group into problems']) {
    const step = WF.split(/^      - /m).find((s) => s.startsWith(`name: ${name}\n`));
    assert.ok(step, name);
    assert.match(step, /if: \$\{\{ .*!inputs\.dry_run/, `${name}: not in a dry run`);
  }
  assert.match(WF, /^      CF_API_TOKEN: \$\{\{ secrets\.CF_D1_TOKEN \|\| secrets\.CF_API_TOKEN \}\}$/m);
  for (const [, ref] of WF.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, ref);
  assert.match(WF, /npm install --no-save --no-package-lock @anthropic-ai\/sdk@\d+\.\d+\.\d+$/m, 'the SDK pinned, never saved');
  assert.match(WF, /^      CLAUDE_ON: \$\{\{ \(inputs\.claude \|\| vars\.PROBLEMS_CLAUDE == 'on'\) && secrets\.ANTHROPIC_API_KEY != '' \}\}$/m, 'Claude: asked for, and a key');
  assert.match(WF, /ANTHROPIC_API_KEY: \$\{\{ env\.CLAUDE_ON == 'true' && secrets\.ANTHROPIC_API_KEY \|\| '' \}\}/, 'the key only reaches the step when Claude is on');
  assert.match(WF, /PROBLEM_LLM_MAX_USD: \$\{\{ inputs\.claude_max_usd \|\| vars\.PROBLEMS_CLAUDE_MAX_USD \|\| '0\.50' \}\}/);
  assert.doesNotMatch(WF, /echo .*secrets\.|::add-mask::|set -x/, 'no secret near a log line');
  // The test gate installs the SDK, so the wire test runs instead of skipping (a skipped test fails the gate).
  assert.match(TESTS_WF, /npm install --no-save --no-package-lock playwright@[\d.]+ @anthropic-ai\/sdk@1\.3\.0$/m);
  assert.strictEqual(/@anthropic-ai\/sdk@([\d.]+)/.exec(WF)[1], /@anthropic-ai\/sdk@([\d.]+)/.exec(TESTS_WF)[1], 'the same SDK in the run and in the tests');
});
