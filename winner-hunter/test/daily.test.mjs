// The daily job (daily.mjs) end to end on an in-memory D1 with every migration, through the real REST client; and the VPS
// fetch (scripts/fetch-daily-digest.mjs) that turns its digest into ~/winner-daily/latest.md.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { d1Client } from '../lib/d1.mjs';
import { memoryDb, d1Rest } from './helpers/sqlite-d1.mjs';
import { runDaily, LIMITS, writeDigest } from '../daily.mjs';
import { digestFor, writeFiles } from '../scripts/fetch-daily-digest.mjs';

const NOW = Date.parse('2026-11-05T23:00:00Z'); // 06:00 on 6 Nov in Bangkok
const DAY = '2026-11-06';
const P = (o = {}) => JSON.stringify({ p: { people: 0.01, animals: 0.01, gymwear: 0.01, physical: 0.99, face: 0.01, skin: 0.01, medical: 0.02, brand: 0.05, sizing: 0.03, fragile: 0.05, bulky: 0.1,
  restricted: 0.02, kids: 0.02, hardsource: 0.1, problem: 0.8, wow: 0.6, clear3s: 0.8, impulse: 0.5, gift: 0.4, generic: 0.2, ...o } });
const CATS = ['Home', 'Pets', 'Car', 'Kitchen', 'Garden', 'Sleep and comfort', 'Outdoor and travel', 'Tools and DIY', 'Gifts and hobbies', 'Tech'];
const NAMES = ['lamp', 'pillow', 'towel', 'kettle', 'mirror', 'clock', 'brush', 'mat', 'scarf', 'wallet', 'cushion', 'bowl', 'tent', 'chair', 'bottle', 'fan'];

/** A board with n world products that pass the bar, a supplement with strong proof, and one product Connor rejected. */
function seed(db, n = 8) {
  const ins = db.prepare(`INSERT INTO world_products (product_key, ad_id, active, product_title, price, currency, store_url, product_url, ad_library_url, advertiser, markets, ads, creatives, days, new14,
    shop_ads, store_products, first_seen, last_seen) VALUES (?, ?, 1, ?, ?, 'EUR', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const chk = db.prepare(`INSERT INTO world_checks (product_key, model, input, people, animals, gymwear, physical, category, main, sub, product_score, answers, checked_at, version) VALUES (?, 'jev-1.14.0', 'photo', ?, 0.01, 0.01, 0.99, ?, ?, '', 3, ?, ?, 2)`);
  const best = db.prepare('INSERT INTO bestseller (product_key, store, product_id, rank, ok, checked_at, history) VALUES (?, ?, ?, ?, 1, ?, ?)');
  const add = (i, title, cat, o = {}) => {
    const key = `s${i}.test/products/p${i}`;
    ins.run(key, 'w' + (1000 + i), title, o.price ?? 69.95, `https://s${i}.test/`, `https://${key}`, `https://www.facebook.com/ads/library/?id=${1000 + i}`, `Shop ${i}`,
      '{"AU":{"ads":3,"days":60},"NZ":{"ads":2,"days":40}}', 8, 4, o.days ?? 90, 2, 120, 25, '2026-10-20T00:00:00Z', '2026-11-05T20:00:00Z');
    chk.run(key, o.people ?? 0.01, cat, cat, o.people ? P({ people: o.people }) : P(), '2026-11-02T00:00:00Z');
    best.run(key, `s${i}.test`, String(i), 2, '2026-11-05T21:00:00Z', '[["2026-10-29",5],["2026-11-05",2]]');
  };
  for (let i = 0; i < n; i++) add(i, `${NAMES[i % NAMES.length]} ${NAMES[(i * 5 + 3) % NAMES.length]} deluxe ${i}`, CATS[i % CATS.length]);
  add(90, 'Sleep gummies', 'Food and supplements', { people: 0.98 });
  add(91, 'Rejected lamp thing', 'Home');
  db.prepare("INSERT INTO hidden (ad_id, status, at) VALUES ('w1091', 'rejected', '2026-11-01T07:00:00Z')").run();
}

const client = (db) => d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(db).doFetch, retryMs: 0 });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wh-daily-'));
const steps = {
  audience: async (p) => ({ one_line: `Buyers of ${p.name}`, credits_used: 2 }),
  sheet: async (p) => ({ one_line: 'Margin €30 in NZ', margin_eur: 30, breakeven_cpa_eur: 30, main_blocker: 'none' }),
};

test('a daily run: picks, run record, digest, score history and backtest in D1, files on disk', async () => {
  const db = memoryDb();
  seed(db);
  const out = tmp();
  const rec = await runDaily({ db: client(db), now: NOW, steps, out, board: 'https://board.test' });
  assert.strictEqual(rec.day, DAY);
  assert.strictEqual(rec.status, 'ok');
  assert.ok(rec.picks >= 5 && rec.picks <= 10, String(rec.picks));
  const picks = db.prepare('SELECT * FROM daily_picks WHERE day = ? ORDER BY rank').all(DAY);
  assert.strictEqual(picks.length, rec.picks);
  const keys = picks.map((p) => p.product_key);
  assert.ok(!keys.includes('world|s90.test/products/p90'), 'the supplement is excluded');
  assert.ok(!keys.includes('world|s91.test/products/p91'), 'the rejected product never comes back');
  const first = JSON.parse(picks[0].data);
  assert.strictEqual(first.audience.one_line, `Buyers of ${first.name}`);
  assert.strictEqual(first.sheet.main_blocker, 'none');
  const run = db.prepare('SELECT * FROM daily_runs WHERE day = ?').get(DAY);
  assert.strictEqual(run.status, 'ok');
  assert.match(run.digest_md, /^Winners for Fri 6 Nov 2026: \d+ picks/);
  assert.match(run.digest_md, /\{\{BOARD\}\}\/#today\//, 'the board address is never stored');
  const summary = JSON.parse(run.summary);
  assert.deepStrictEqual(summary.stages.map((s) => s.stage), ['collect', 'score', 'select', 'prepare', 'publish', 'learn']);
  assert.ok(summary.budget.credits >= rec.picks * 2);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM winner_scores WHERE day = ?').get(DAY).n >= 1);
  assert.ok(db.prepare('SELECT n FROM score_backtests WHERE day = ?').get(DAY));
  const latest = fs.readFileSync(path.join(out, 'latest.md'), 'utf8');
  assert.strictEqual(latest, fs.readFileSync(path.join(out, `${DAY}.md`), 'utf8'));
  assert.match(latest, /https:\/\/board\.test\/#today\//);
  assert.ok(latest.trim().split('\n').length <= 25);
  assert.ok(fs.existsSync(path.join(out, `${DAY}.csv`)));
});

test('a day that is done is left alone; a forced re-run keeps the picks Connor decided on', async () => {
  const db = memoryDb();
  seed(db);
  const c = client(db);
  const first = await runDaily({ db: c, now: NOW, steps });
  const again = await runDaily({ db: c, now: NOW + 3600e3, steps });
  assert.strictEqual(again.skipped, true);
  const kept = db.prepare('SELECT product_key FROM daily_picks WHERE day = ? ORDER BY rank DESC LIMIT 1').get(DAY).product_key;
  db.prepare("UPDATE daily_picks SET decision = 'keep', decided_at = '2026-11-06T01:00:00Z' WHERE day = ? AND product_key = ?").run(DAY, kept);
  const forced = await runDaily({ db: c, now: NOW + 7200e3, steps, force: true });
  assert.strictEqual(forced.status, 'ok');
  assert.ok(db.prepare('SELECT 1 FROM daily_picks WHERE day = ? AND product_key = ? AND decision = ?').get(DAY, kept, 'keep'), 'a decided pick stays');
  assert.ok(first.picks >= 5);
});

test('the next day: picks are not shown again within 14 days, and a kept pick counts as a decision', async () => {
  const db = memoryDb();
  seed(db, 16);
  const c = client(db);
  await runDaily({ db: c, now: NOW, steps });
  const day1 = db.prepare('SELECT product_key FROM daily_picks WHERE day = ?').all(DAY).map((r) => r.product_key);
  await runDaily({ db: c, now: NOW + 864e5, steps });
  const day2 = db.prepare("SELECT product_key FROM daily_picks WHERE day = '2026-11-07'").all().map((r) => r.product_key);
  assert.ok(day2.length > 0);
  assert.deepStrictEqual(day2.filter((k) => day1.includes(k)), []);
});

test('fewer than 5 passing: a short day, said plainly, never padded', async () => {
  const db = memoryDb();
  seed(db, 3);
  const rec = await runDaily({ db: client(db), now: NOW, steps });
  assert.strictEqual(rec.status, 'short');
  assert.strictEqual(rec.picks, 3);
  assert.match(db.prepare('SELECT digest_md FROM daily_runs WHERE day = ?').get(DAY).digest_md, /Only 3 products passed the quality bar today/);
});

test('a step that throws or hangs leaves that part "not prepared"; the run still publishes', async () => {
  const db = memoryDb();
  seed(db, 5);
  const was = LIMITS.step;
  LIMITS.step = 50;
  try {
    const rec = await runDaily({ db: client(db), now: NOW, steps: { audience: async () => { throw new Error('no credits'); }, sheet: () => new Promise(() => {}) } });
    assert.strictEqual(rec.status, 'ok');
    assert.strictEqual(rec.prepare.audience, 0);
    assert.strictEqual(rec.prepare.failed, rec.picks * 2);
    assert.match(db.prepare('SELECT digest_md FROM daily_runs WHERE day = ?').get(DAY).digest_md, /Audience: not prepared yet/);
  } finally {
    LIMITS.step = was;
  }
});

test('the database failing during collect: a failed run that says where', async () => {
  const db = memoryDb();
  seed(db, 5);
  const rest = d1Rest(db, { fail: (b) => /FROM winners/.test(b.sql) });
  const c = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: rest.doFetch, retryMs: 0 });
  const rec = await runDaily({ db: c, now: NOW, steps });
  assert.strictEqual(rec.status, 'failed');
  const run = db.prepare('SELECT status, error, digest_md FROM daily_runs WHERE day = ?').get(DAY);
  assert.strictEqual(run.status, 'failed');
  assert.match(run.error, /^collect: /);
  assert.match(run.digest_md, /The run failed at collect/);
});

test('the VPS fetch: today\'s digest with the board address; a plain line when there is none, never yesterday\'s picks', async () => {
  const db = memoryDb();
  seed(db);
  const c = client(db);
  await runDaily({ db: c, now: NOW, steps });
  const dir = tmp();
  const r = await digestFor(c, DAY);
  assert.strictEqual(r.kind, 'digest');
  const files = writeFiles(dir, DAY, r, 'https://board.test/');
  assert.deepStrictEqual(files.map((f) => path.basename(f)), [`${DAY}.md`, `${DAY}.csv`, 'latest.md']);
  assert.match(fs.readFileSync(path.join(dir, 'latest.md'), 'utf8'), /https:\/\/board\.test\/#today\//);
  const next = await digestFor(c, '2026-11-07');
  assert.strictEqual(next.kind, 'note');
  assert.match(next.md, /^Winners for Sat 7 Nov 2026: no daily run yet today\. The last run was Fri 6 Nov 2026 \(ok\)\./);
  writeFiles(dir, '2026-11-07', next, 'https://board.test/');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'latest.md'), 'utf8'), /#today\//, 'latest.md no longer shows the old picks');
  db.prepare("INSERT INTO daily_runs (day, status, started_at) VALUES ('2026-11-08', 'running', '2026-11-07T23:01:00Z')").run();
  assert.match((await digestFor(c, '2026-11-08')).md, /started at 06:01 ICT and is not finished yet/);
  const down = await digestFor({ query: async () => { throw new Error('Cloudflare D1: HTTP 503'); } }, DAY);
  assert.match(down.md, /could not be read \(Cloudflare D1: HTTP 503\)/);
});

test('writeDigest replaces files through a temporary file and keeps latest.md equal to the day', () => {
  const dir = tmp();
  writeDigest(dir, DAY, 'Winners for Fri 6 Nov 2026: 0 picks\n', null, '');
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), [`${DAY}.md`, 'latest.md']);
});
