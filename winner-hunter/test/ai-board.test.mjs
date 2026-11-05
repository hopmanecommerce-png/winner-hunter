// The AI read on the board (worker/src/ai.mjs, its block in app.mjs, one script tag in board.html) and its workflow
// (.github/workflows/ai-check.yml): /api/ai behind the PIN, reads by card, checked again before they are shown, the first
// time you open one, the board without the table, /ai.js, and the workflow's caps, secrets and pinned SDK.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { handle, tokenFor } from '../worker/src/app.mjs';
import { AI_JS, aiBoard, readOut, evalOut, keyOfRow } from '../worker/src/ai.mjs';
import { MAX_WAIT_MINUTES } from '../ai-check.mjs';
import { READ, readEnv } from './helpers/ai-reads.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

const ORIGIN = 'https://winner-hunter.example.workers.dev';
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const iso = (ms) => new Date(ms).toISOString();

async function session(env) {
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const call = (p, init = {}, now = NOW) => handle(new Request(ORIGIN + p, { ...init, headers: { cookie, ...init.headers } }), env, { html: HTML, now });
  return {
    get: async (p) => (await call(p)).json(),
    post: (p, body, { now = NOW, headers = {} } = {}) => call(p, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, now),
    call,
  };
}
test('GET /api/ai: behind the PIN; the reads of the cards asked for, by ad id, outside the EU too; checked again; bad and unknown ids skipped', async () => {
  const env = await readEnv();
  const anon = await handle(new Request(ORIGIN + '/api/ai?ids=9001'), env, { now: NOW });
  assert.strictEqual(anon.status, 401);
  const s = await session(env);
  const j = await s.get('/api/ai?ids=' + ['9000', '9100', '9001', '1001', '9002', '9003', '9004', '9005', 'nope', 'bad id!', '<x>', '9001'].join(','));
  assert.deepStrictEqual(Object.keys(j.reads).sort(), ['1001', '9000', '9001', '9002', '9100']);
  assert.deepStrictEqual(j.reads['9001'], { ...READ, flags: [], model: 'claude-haiku-5-5', at: iso(NOW - 3600e3), updating: false, key: 'eu|shop1.test/products/item-1' });
  assert.deepStrictEqual(j.reads['9000'], j.reads['9100'], 'two ads of one product: one read');
  assert.strictEqual(j.reads['9000'].product, 'Linen summer dress');
  assert.strictEqual(j.reads['1001'].key, 'world|pod.test/products/pillow');
  assert.strictEqual(j.reads['1001'].confidence, 'low', 'a flagged read always shows low confidence');
  assert.deepStrictEqual(j.reads['1001'].flags, ['injection']);
  assert.strictEqual(j.reads['9002'].updating, true, 'asked again: the last read shows meanwhile');
  assert.strictEqual(j.eval, null, 'not measured yet');
  assert.deepStrictEqual(await s.get('/api/ai'), { reads: {}, eval: null });
  assert.deepStrictEqual(await s.get('/api/ai?ids=,,,'), { reads: {}, eval: null });
  // 150 ids: at most 90 are looked up, within D1's 100 bound values.
  const many = await s.get('/api/ai?ids=' + Array.from({ length: 150 }, (_, i) => String(9000 + i)).join(','));
  assert.ok(many.reads['9001']);
  assert.ok(!env.DB.log.some((l) => l.args.length > 100));
  // The eval's last report: rates and counts only.
  env.db.prepare("INSERT INTO state (key, value, updated_at) VALUES ('ai_eval', ?, ?)").run(JSON.stringify({ n: 42, accuracy: 0.71, kappa: 0.33, auc: 0.74, threshold: 50, blind: { n: 30, accuracy: 0.7 }, at: iso(NOW), misses: { approved_low: [{ title: 'Secret' }] } }), iso(NOW));
  const e = (await s.get('/api/ai?ids=9001')).eval;
  assert.deepStrictEqual(e, { n: 42, accuracy: 0.71, kappa: 0.33, auc: 0.74, threshold: 50, blind: { n: 30, accuracy: 0.7 }, at: iso(NOW) });
  assert.strictEqual((await s.call('/api/ai', { method: 'PUT' })).status, 405);
});

test('readOut and evalOut: a row that does not pass the schema, or broken JSON, is not shown', () => {
  assert.strictEqual(readOut({ verdict: '{"fit": 50}' }), null);
  assert.strictEqual(readOut({ verdict: 'not json' }), null);
  assert.strictEqual(readOut({ verdict: null }), null);
  assert.strictEqual(readOut(null), null);
  const r = readOut({ verdict: JSON.stringify({ ...READ, product: '<img src=x onerror=alert(1)> brace‮', cons: ['see https://evil.test'] }), flags: '["injection","x"]', status: 'ok' });
  assert.strictEqual(r.product, '<img src=x onerror=alert(1)> brace', 'kept as text (the board escapes it), hidden characters out');
  assert.deepStrictEqual(r.cons, ['see [link]']);
  assert.deepStrictEqual(r.flags, ['injection']);
  assert.strictEqual(evalOut(null), null);
  assert.strictEqual(evalOut({ value: 'oops' }), null);
  assert.strictEqual(evalOut({ value: '{"n":"x"}' }), null);
  assert.strictEqual(keyOfRow({ gk: 'shop1.test/products/item-1' }), 'eu|shop1.test/products/item-1', 'a product page');
  assert.strictEqual(keyOfRow({ gk: '504|led sunset lamp' }), 'eu|504|led sunset lamp', 'no product page: advertiser + title');
  assert.strictEqual(keyOfRow({ gk: 'world|pod.test/products/pillow', world: {} }), 'world|pod.test/products/pillow');
});

test('POST /api/ai {id, opened}: the first time you open a read is kept; origin, JSON and id are checked', async () => {
  const env = await readEnv();
  const s = await session(env);
  const opened = () => env.db.prepare("SELECT opened_at FROM ai_checks WHERE product_key = 'eu|shop1.test/products/item-1'").get().opened_at;
  assert.strictEqual((await s.post('/api/ai', { id: '9001', opened: true }, { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.strictEqual((await s.post('/api/ai', 'id=9001', { headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.strictEqual((await s.post('/api/ai', '{bad')).status, 400);
  assert.strictEqual((await s.post('/api/ai', { id: '../x', opened: true })).status, 400);
  assert.strictEqual((await s.post('/api/ai', { id: '9001' })).status, 400, 'nothing to save');
  assert.strictEqual((await s.post('/api/ai', { id: '424242', opened: true })).status, 404);
  assert.strictEqual((await s.post('/api/ai', { id: '9007', opened: true })).status, 404, 'no AI read for that product');
  assert.strictEqual(opened(), null);
  const res = await s.post('/api/ai', { id: '9001', opened: true });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { ok: true, key: 'eu|shop1.test/products/item-1' });
  assert.strictEqual(opened(), iso(NOW));
  assert.strictEqual((await s.post('/api/ai', { id: '9001', opened: true }, { now: NOW + 864e5 })).status, 200);
  assert.strictEqual(opened(), iso(NOW), 'the first time stays: ai-eval.mjs counts decisions after it as not blind');
  const anon = await handle(new Request(ORIGIN + '/api/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"9001","opened":true}' }), env, { now: NOW });
  assert.strictEqual(anon.status, 401);
});

test('without the ai_checks table (not migrated yet) /api/ai answers empty and the board works as before', async () => {
  const env = await seededEnv();
  env.db.exec('DROP TABLE ai_checks');
  const s = await session(env);
  const res = await s.call('/api/ai?ids=9001,9002');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { reads: {}, eval: null });
  assert.strictEqual((await s.call('/api/ads?view=all')).status, 200);
});

test('/ai.js is the board\'s AI read code (logged in only); the board page loads it with its nonce; the rest of the board is untouched', async () => {
  const env = await readEnv();
  const s = await session(env);
  const res = await s.call('/ai.js');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/javascript/);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  const js = await res.text();
  assert.strictEqual(js, AI_JS);
  assert.doesNotThrow(() => new Function(js), 'it parses');
  assert.match(js, /AI read/);
  assert.match(js, /experimental/);
  assert.ok(js.includes(String(aiBoard)), 'the same code as the tested function');
  assert.strictEqual((await handle(new Request(ORIGIN + '/ai.js'), env, { now: NOW })).status, 401);
  assert.strictEqual((await s.call('/ai.js', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: '{}' })).status, 405);
  assert.strictEqual((HTML.match(/<script nonce="__NONCE__" src="\/ai\.js" id="aikit" defer><\/script>/g) || []).length, 1, 'one script tag, deferred, with the page nonce');
  const page = await s.call('/');
  const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers.get('content-security-policy'))[1];
  assert.match(await page.text(), new RegExp(`<script nonce="${nonce}" src="/ai.js" id="aikit" defer></script>`));
  assert.doesNotMatch(js, /fetch\(['"]https?:/, 'it only talks to the board itself');
});

// ---------------------------------------------------------------------------
// The workflow
// ---------------------------------------------------------------------------
const WF = (name) => fs.readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');

test('ai-check.yml: by hand only (the Anthropic API is not for automated steps), a spend cap per run and per month, the D1-only token, the SDK pinned to one version in both workflows', () => {
  const wf = WF('ai-check.yml');
  assert.match(wf, /^on:\n {2}workflow_dispatch:\n/m);
  assert.match(wf, /^ {6}max_usd:\n(?: {8}.*\n)* {8}default: '0\.50'$/m, 'a spend cap you can set by hand');
  assert.doesNotMatch(wf, /^ {2}(?:schedule|workflow_run|push|pull_request):/m, 'nothing starts it on its own: no schedule, no other workflow, no push');
  for (const f of fs.readdirSync(new URL('../../.github/workflows/', import.meta.url)).filter((x) => /\.ya?ml$/.test(x) && x !== 'ai-check.yml')) {
    assert.doesNotMatch(WF(f), /ai-check\.mjs|ANTHROPIC_API_KEY|workflows: \[AI check\]/, `${f} never runs the AI check`);
  }
  assert.match(wf, /^permissions:\n {2}contents: read$/m);
  assert.match(wf, /^concurrency:\n {2}group: ai-check\n {2}cancel-in-progress: false$/m, 'one run at a time: a batch is never sent twice');
  assert.match(wf, /^ {6}CF_API_TOKEN: \$\{\{ secrets\.CF_D1_TOKEN \|\| secrets\.CF_API_TOKEN \}\}$/m, 'the D1-only token when there is one');
  assert.match(wf, /^ {6}ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}$/m);
  assert.match(wf, /^ {6}AI_MAX_USD: \$\{\{ inputs\.max_usd \|\| vars\.AI_MAX_USD \|\| '0\.50' \}\}$/m);
  assert.match(wf, /^ {6}AI_MONTH_USD: \$\{\{ vars\.AI_MONTH_USD \|\| '5' \}\}$/m);
  assert.match(wf, /^ {6}AI_MODEL: \$\{\{ vars\.AI_MODEL \|\| 'claude-haiku-5-5' \}\}$/m, 'the cheap model unless you pick another');
  assert.doesNotMatch(wf, /META_TOKEN|BOARD_PIN|TYPESAFE/, 'no other secrets in this job');
  const sdk = /@anthropic-ai\/sdk@(\d+\.\d+\.\d+)\b/.exec(wf);
  assert.ok(sdk, 'the SDK pinned to an exact version');
  assert.ok(WF('tests.yml').includes(`playwright@1.56.1 @anthropic-ai/sdk@${sdk[1]}`), 'the tests install the same version, in the same command (a second --no-save install removes the first)');
  const steps = wf.split(/^(?= {6}- )/m).slice(1);
  assert.deepStrictEqual(steps.map((x) => (/run: (.*)$/m.exec(x) || ['', ''])[1]), ['', '', 'node winner-hunter/migrate.mjs', 'npm install --no-save --no-package-lock --no-audit --no-fund @anthropic-ai/sdk@' + sdk[1], 'node winner-hunter/ai-check.mjs', 'node winner-hunter/ai-eval.mjs']);
  assert.match(steps[5], /if: \$\{\{ !cancelled\(\) \}\}/, 'the eval also after a failed check');
  assert.doesNotMatch(wf, /--details/, 'no product names in a public log');
  const timeout = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(wf)[1]);
  assert.ok(timeout >= MAX_WAIT_MINUTES + 10, `the job (${timeout} min) outlasts the longest wait for a batch (${MAX_WAIT_MINUTES} min)`);
});
