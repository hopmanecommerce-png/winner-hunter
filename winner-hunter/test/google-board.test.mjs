// The board's Google tab (worker/src/google.mjs, app.mjs): the API on an in-memory D1 whose Google products were written by the
// real Google hunt on SAMPLE DATA (helpers/google-seed.mjs). PIN, the four rules with their marks, who else shows a product,
// filters and sorts, decisions in the same tables as every product, the Inbox, age today, CSV, banner, 🚀.
import test from 'node:test';
import assert from 'node:assert';
import { handle, tokenFor, products, toCsv } from '../worker/src/app.mjs';
import { rulesOf, googleRow, crossLink, advertiserUrl, creativeUrl, googleAlert } from '../worker/src/google.mjs';
import { advertiserUrl as libAdvertiserUrl, creativeUrl as libCreativeUrl } from '../lib/google-ads.mjs';
import { googleEnv, GLOW, POSTURE, BRIGHT } from './helpers/google-seed.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { checkAll, GOOGLE_TODO_SQL } from '../world-check.mjs';
import { SEP, VERSION } from '../worker/src/jev-questions.mjs';
import { d1Client } from '../lib/d1.mjs';
import { d1Rest } from './helpers/sqlite-d1.mjs';
import { keyOfRow } from '../worker/src/ai.mjs';
import { keyOf } from '../worker/src/launch.mjs';

const ORIGIN = 'https://winner-hunter.example.workers.dev';
async function session(env) {
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const call = (path, init = {}, now = NOW) => handle(new Request(ORIGIN + path, init), env, { html: '<html>__NONCE__</html>', now });
  return {
    get: async (path, now) => (await call(path, { headers: { cookie } }, now)).json(),
    raw: (path, now) => call(path, { headers: { cookie } }, now),
    post: async (path, body) => (await call(path, { method: 'POST', headers: { cookie, 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify(body) })).json(),
    anon: (path) => call(path),
  };
}
const byTitle = (j) => j.ads.map((a) => a.title);
/** CSV text → rows of cells (quotes, commas and newlines inside quotes). */
function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

test('/api/ads?scope=google: the Google products, their four rules each marked exact, approximated or not checked, the Transparency Center links', async () => {
  const env = await googleEnv();
  assert.deepStrictEqual([env.run.health, env.run.products], ['ok', 3]);
  const s = await session(env);
  const j = await s.get('/api/ads?scope=google&view=all');
  assert.deepStrictEqual(byTitle(j), ['Posture Corrector Pro', 'Sunset Projection Lamp', 'Glow Sunset Lamp'], 'all four rules checked first, then the most proof');
  assert.strictEqual(j.counts.google, 3);
  assert.strictEqual(j.counts.all, 3, 'the counts of this tab');
  const [posture, lamp, glow] = j.ads;
  assert.deepStrictEqual(posture.google.rules.map((i) => [i.key, i.state, i.how]), [['shopify', 'ok', 'exact'], ['ads', 'ok', 'approx'], ['age', 'ok', 'exact'], ['reach', 'ok', 'approx']]);
  assert.deepStrictEqual(posture.google.checked, { exact: 2, approx: 2, unknown: 0 });
  assert.match(posture.google.rules[3].text, /EU impressions a day .*impressions, not people/);
  assert.deepStrictEqual(glow.google.rules[3], { key: 'reach', label: '500+ EU reach a day', state: 'unknown', how: 'none', text: 'Google publishes no reach or impressions for this ad: not checked' });
  assert.deepStrictEqual([glow.google.verdict, glow.google.checked], ['partial', { exact: 2, approx: 1, unknown: 1 }], 'never shown as passed');
  assert.match(lamp.google.rules[3].text, /total \(not only EU\)/);
  assert.deepStrictEqual([posture.age, posture.ads, posture.scaled, posture.price, posture.cur, posture.google.regions, posture.google.formats], [20, 180, 2, 39.95, 'EUR', ['DE', 'NL'], ['image', 'text']]);
  assert.strictEqual(posture.ad, 'https://adstransparency.google.com/advertiser/AR10000000000000000001/creative/CR10000000000000000101', '▶ and a tap: the ad in the Transparency Center');
  assert.strictEqual(posture.google.advertiser, 'https://adstransparency.google.com/advertiser/AR10000000000000000001');
  assert.strictEqual(posture.product, 'https://posturepro-sample.example/products/posture-corrector-pro');
  assert.deepStrictEqual(posture.google.impr, { lower: 700000, upper: 800000, scope: 'eu' });
  assert.ok(j.ads.every((a) => a.world === null && a.unidentified === false && a.pass === true));
  assert.strictEqual(j.google_run.status, 'done');
  assert.strictEqual(j.alert, null);
  const anon = await s.anon('/api/ads?scope=google&view=all');
  assert.strictEqual(anon.status, 401, 'PIN-gated like everything else');
  assert.strictEqual((await s.anon('/export.csv?scope=google&view=all')).status, 401);
  assert.strictEqual((await s.anon('/api/markets?scope=google')).status, 401);
});

test('also on Meta / TikTok, both ways: the same product page or shop; a Google product that is on neither says so', async () => {
  const env = await googleEnv();
  const s = await session(env);
  const j = await s.get('/api/ads?scope=google&view=all');
  const of = (t) => j.ads.find((a) => a.title === t).google;
  assert.deepStrictEqual(of('Glow Sunset Lamp').cross, { meta: 'product', where: 'eu', tiktok: null }, 'its product page is on the EU Meta board');
  assert.deepStrictEqual(of('Sunset Projection Lamp').cross, { meta: null, where: null, tiktok: 'product' }, 'its shop and its title are on the TikTok tab');
  assert.deepStrictEqual(of('Posture Corrector Pro').cross, { meta: null, where: null, tiktok: null }, 'Google only: "Not on Meta"');
  assert.deepStrictEqual(of('Glow Sunset Lamp').proof.items.find((i) => i.k === 'meta'), { k: 'meta', ok: true, text: 'The same product page is on the Meta board (EU)' });
  assert.deepStrictEqual(of('Posture Corrector Pro').proof.items.find((i) => i.k === 'meta'), { k: 'meta', ok: false, text: 'Not on the Meta board' });
  // And the other way: the EU card of the glow lamp says it is on Google too.
  const eu = await s.get('/api/ads?view=all');
  assert.deepStrictEqual(eu.ads.filter((a) => a.on_google).map((a) => [a.id, a.on_google]), [['9950', 'product']]);
  // Store level: another product of the same shop.
  const rows = [googleRow({ product_key: 'shop.example/products/a', ad_id: 'g1', rules: '[]', regions: '[]', formats: '[]', product_title: 'Red Lamp' })];
  const meta = [{ product_url: 'https://www.shop.example/products/b', store_url: 'https://shop.example/' }, { world: {}, product_url: '', store_url: 'https://other.example/' }];
  crossLink(rows, meta, [{ ads_domain: 'https://www.shop.example', title: 'Blue Chair' }], { key: (u) => (/products\/(\w+)/.exec(u) ? 'shop.example/products/' + /products\/(\w+)/.exec(u)[1] : ''), store: (u) => new URL(u).hostname.replace(/^www\./, '') });
  assert.deepStrictEqual(rows[0].google.cross, { meta: 'store', where: 'eu', tiktok: 'store' });
  assert.deepStrictEqual(meta.map((m) => m.on_google), ['store', null]);
});

test('the Google tab stays apart: its products are not on the EU or outside-EU tabs, those tabs keep their counts', async () => {
  const env = await googleEnv();
  const s = await session(env);
  const eu = await s.get('/api/ads?view=all');
  assert.strictEqual(eu.total, 28, 'the 27 of the sample and the glow lamp\'s Meta ad');
  assert.ok(!eu.ads.some((a) => a.google), 'no Google product on the EU tab');
  const world = await s.get('/api/ads?scope=world&view=all');
  assert.strictEqual(world.total, 0);
  assert.deepStrictEqual([eu.counts.eu, eu.counts.world, eu.counts.google], [28, 0, 3]);
  const inbox = await s.get('/api/ads?view=inbox');
  assert.ok(!inbox.ads.some((a) => a.google), 'nor in the EU inbox');
});

test('filters and sorts on the Google tab: all four rules, also / not on Meta, also on TikTok, a country, search; every order is a plain fact', async () => {
  const env = await googleEnv();
  const s = await session(env);
  const q = async (p) => byTitle(await s.get('/api/ads?scope=google&view=all&' + p));
  assert.deepStrictEqual(await q('full=1'), ['Posture Corrector Pro', 'Sunset Projection Lamp']);
  assert.deepStrictEqual(await q('meta=1'), ['Glow Sunset Lamp']);
  assert.deepStrictEqual(await q('meta=0'), ['Posture Corrector Pro', 'Sunset Projection Lamp']);
  assert.deepStrictEqual(await q('tiktok=1'), ['Sunset Projection Lamp']);
  assert.deepStrictEqual(await q('cc=DE'), ['Posture Corrector Pro']);
  assert.deepStrictEqual(await q('cc=nl'), ['Posture Corrector Pro', 'Glow Sunset Lamp']);
  assert.deepStrictEqual(await q('q=lamp'), ['Sunset Projection Lamp', 'Glow Sunset Lamp']);
  assert.deepStrictEqual(await q('sort=impr'), ['Posture Corrector Pro', 'Sunset Projection Lamp', 'Glow Sunset Lamp'], 'impressions a day; none published last');
  assert.deepStrictEqual(await q('sort=days'), ['Posture Corrector Pro', 'Sunset Projection Lamp', 'Glow Sunset Lamp']);
  assert.deepStrictEqual(await q('sort=regions'), ['Posture Corrector Pro', 'Glow Sunset Lamp', 'Sunset Projection Lamp']);
  assert.deepStrictEqual(await q('sort=ads'), ['Posture Corrector Pro', 'Sunset Projection Lamp', 'Glow Sunset Lamp']);
  for (const sort of ['__proto__', 'constructor', 'x']) assert.strictEqual((await s.get(`/api/ads?scope=google&view=all&sort=${sort}`)).total, 3, sort);
});

test('Approve and Reject on a Google product: the same decision log as every product (hidden, feedback with its facts), ✓ keeps it, undo brings it back', async () => {
  const env = await googleEnv();
  const s = await session(env);
  const id = 'gCR10000000000000000101';
  assert.deepStrictEqual(await s.post('/api/hide', { ad_id: id, status: 'seen' }), { ok: true, ad_id: id, status: 'seen' });
  assert.strictEqual(env.db.prepare('SELECT status FROM hidden WHERE ad_id = ?').get(id).status, 'seen');
  const f = env.db.prepare("SELECT action, store, advertiser, title, price, currency, keyword FROM feedback WHERE ad_id = ?").get(id);
  assert.deepStrictEqual({ ...f }, { action: 'seen', store: 'https://posturepro-sample.example/', advertiser: 'SAMPLE Posture Pro', title: 'Posture Corrector Pro', price: 39.95, currency: 'EUR', keyword: 'posture' });
  assert.deepStrictEqual(await s.post('/api/feedback', { ad_id: id, reasons: ['wow', 'margin'] }), { ok: true });
  assert.deepStrictEqual((await s.get('/api/learned')).reasons.good.map((r) => r.key).sort(), ['margin', 'wow'], '🧠 learns from it');
  const tab = await s.get('/api/ads?scope=google&view=all');
  assert.ok(!byTitle(tab).includes('Posture Corrector Pro'), 'decided: off Browse');
  assert.strictEqual(tab.counts.made, 1);
  const made = await s.get('/api/ads?view=made');
  assert.deepStrictEqual(made.ads.map((a) => [a.id, !!a.google, a.hidden]), [[id, true, 'seen']], '✓ lists it with its Google facts');
  assert.deepStrictEqual(byTitle(await s.get('/api/ads?scope=google&view=all&hidden=1')), ['Posture Corrector Pro']);
  await s.post('/api/hide', { ad_id: id, status: 'none' });
  assert.ok(byTitle(await s.get('/api/ads?scope=google&view=all')).includes('Posture Corrector Pro'), 'undo: back');
  assert.strictEqual(env.db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE ad_id = ? AND action IN ('seen', 'rejected')").get(id).n, 0);
  await s.post('/api/hide', { ad_id: 'gCR10000000000000000201', status: 'rejected' });
  await s.post('/api/feedback', { ad_id: 'gCR10000000000000000201', reasons: ['store'] });
  const inbox = await s.get('/api/ads?scope=google&view=inbox');
  assert.ok(!byTitle(inbox).includes('Glow Sunset Lamp'));
  assert.deepStrictEqual((await s.get('/api/learned')).blocked, [{ store: 'glowlamp-sample.example', n: 1 }], '"Bad store" from the Google tab blocks the shop everywhere');
  // A note on a Google product, as on every product.
  assert.deepStrictEqual(await s.post('/api/note', { ad_id: id, note: 'Strong Shopping ad' }), { ok: true });
  assert.strictEqual((await s.get('/api/note?ad_id=' + id)).note, 'Strong Shopping ad');
});

test('the Google Inbox: all four rules and proof first, × what you taught the board × Jev\'s risks; what people or pets take stays out, as on the EU board', async () => {
  const env = await googleEnv();
  const s = await session(env);
  const first = await s.get('/api/ads?scope=google&view=inbox');
  assert.deepStrictEqual(byTitle(first), ['Posture Corrector Pro', 'Sunset Projection Lamp', 'Glow Sunset Lamp']);
  assert.ok(first.ads.every((a) => a.ranked && a.google.proof));
  // Jev's answers, saved by world-check.mjs under 'google|' + the product page: a risk ranks it lower and says why.
  const put = env.db.prepare("INSERT INTO world_checks (product_key, people, animals, gymwear, physical, category, input, checked_at, version, main, sub, answers) VALUES (?, ?, 0.01, 0.01, 0.99, 'Home', 'photo', 'x', 2, 'Home', '', ?)");
  put.run('google|' + POSTURE, 0.01, JSON.stringify({ p: { people: 0.01, animals: 0.01, gymwear: 0.01, physical: 0.99, medical: 0.9 }, choices: {} }));
  put.run('google|' + BRIGHT, 0.97, JSON.stringify({ p: { people: 0.97, animals: 0.01, gymwear: 0.01, physical: 0.99 }, choices: {} }));
  env.db.prepare("INSERT INTO state (key, value, updated_at) VALUES ('google_data', '{}', 'jev') ON CONFLICT(key) DO UPDATE SET updated_at = 'jev2'").run(); // the board reads its tables again
  const next = await s.get('/api/ads?scope=google&view=inbox');
  assert.deepStrictEqual(byTitle(next), ['Glow Sunset Lamp', 'Posture Corrector Pro'], 'people take the projection lamp: out of the Inbox; a medical claim ranks lower');
  const posture = next.ads.find((a) => a.title === 'Posture Corrector Pro');
  assert.deepStrictEqual(posture.risk.red, ['medical']);
  assert.ok(posture.ranked.why.some((w) => /Medical/.test(w.text)));
  assert.ok(byTitle(await s.get('/api/ads?scope=google&view=all')).includes('Sunset Projection Lamp'), 'Browse still lists it');
  assert.deepStrictEqual(byTitle(await s.get('/api/ads?scope=google&view=all&jev=yes:medical')), ['Posture Corrector Pro'], "Jev's filter works here too");
});

test('age today: a Google product whose ad is older than 42 days today leaves the tab (from Google\'s first-shown time), ✓ keeps it', async () => {
  const env = await googleEnv();
  const s = await session(env);
  await s.post('/api/hide', { ad_id: 'gCR10000000000000000101', status: 'seen' });
  const later = NOW + 25 * 864e5; // posture 45 days, the projection lamp 37, the glow lamp 35
  const j = await s.get('/api/ads?scope=google&view=all', later);
  assert.deepStrictEqual(byTitle(j), ['Sunset Projection Lamp', 'Glow Sunset Lamp']);
  const made = await s.get('/api/ads?view=made', later);
  assert.deepStrictEqual(made.ads.map((a) => [a.title, a.pass, a.age]), [['Posture Corrector Pro', false, 45]], 'out of the rules, still in ✓');
  // A product the hunt took off (it failed a rule when checked again) is not on the tab either.
  env.db.prepare("UPDATE google_products SET active = 0 WHERE product_key = ?").run(GLOW);
  env.db.prepare("UPDATE state SET updated_at = 'x2' WHERE key = 'google_data'").run();
  assert.deepStrictEqual(byTitle(await s.get('/api/ads?scope=google&view=all')), ['Sunset Projection Lamp']);
});

test('/api/markets?scope=google: the countries its products\' ads were shown in; Jev\'s breakdown of the tab', async () => {
  const env = await googleEnv();
  const s = await session(env);
  const m = await s.get('/api/markets?scope=google');
  assert.strictEqual(m.scope, 'google');
  assert.deepStrictEqual(m.markets.map((x) => [x.cc, x.products, x.shops, x.full]), [['NL', 2, 2, 1], ['BE', 1, 1, 0], ['DE', 1, 1, 1], ['US', 1, 1, 1]]);
  assert.strictEqual(m.products, 3);
  assert.strictEqual(m.jev.total, 3);
});

test('CSV of the Google tab: the rule marks (exact / approx / unknown), countries, formats, who else shows it; an EU export keeps its columns', async () => {
  const env = await googleEnv();
  const s = await session(env);
  const res = await s.raw('/export.csv?scope=google&view=all');
  assert.strictEqual(res.status, 200);
  const lines = csvRows(await res.text());
  const head = lines[0];
  for (const c of ['google_rules', 'google_rules_text', 'google_all_four_checked', 'google_regions', 'google_formats', 'also_on_meta', 'also_on_tiktok', 'google_advertiser_url']) assert.ok(head.includes(c), c);
  assert.strictEqual(lines.length, 4);
  assert.ok(lines.slice(1).every((l) => l.length === head.length), 'every row has every column');
  const glow = lines.find((l) => l.includes('Glow Sunset Lamp'));
  assert.match(glow[head.indexOf('google_rules_text')], /^Shopify store: glowlamp-sample\.myshopify\.com \| Advertiser 75\+ ads: ~95 ads shown/);
  assert.strictEqual(glow[head.indexOf('google_rules')], 'shopify:exact ads:approx age:exact reach:unknown');
  assert.strictEqual(glow[head.indexOf('also_on_meta')], 'product');
  assert.strictEqual(glow[head.indexOf('google_all_four_checked')], '0');
  const eu = (await (await s.raw('/export.csv?view=all')).text()).split('\r\n')[0];
  assert.ok(!eu.includes('google_'), 'no Google columns in an export without Google products');
  assert.strictEqual(toCsv([]).split(',').includes('google_rules'), false);
});

test('the banner on the Google tab: red for a failed Google hunt, yellow for warnings, nothing on the other tabs or for a run long ago', async () => {
  const env = await googleEnv();
  const s = await session(env);
  const run = JSON.parse(env.db.prepare("SELECT value FROM state WHERE key = 'google_run'").get().value);
  env.db.prepare("UPDATE state SET value = ? WHERE key = 'google_run'").run(JSON.stringify({ ...run, health: 'failed', alert: 'Google-hunt mislukt / Google hunt failed: the API key was refused' }));
  assert.deepStrictEqual((await s.get('/api/ads?scope=google&view=all')).alert, { level: 'red', text: 'Google-hunt mislukt / Google hunt failed: the API key was refused' });
  assert.strictEqual((await s.get('/api/ads?view=all')).alert, null, 'the EU tab has its own banner');
  assert.deepStrictEqual(googleAlert({ health: 'warning', finished_at: new Date(NOW).toISOString(), alert: 'w' }, NOW), { level: 'yellow', text: 'w' });
  assert.strictEqual(googleAlert({ health: 'failed', finished_at: new Date(NOW - 8 * 864e5).toISOString() }, NOW), null, 'by hand: an old run is no alarm');
  assert.strictEqual(googleAlert({ status: 'running', health: null, started_at: new Date(NOW - 4 * 3600e3).toISOString(), updated_at: new Date(NOW - 4 * 3600e3).toISOString() }, NOW).level, 'red');
  assert.strictEqual(googleAlert(null, NOW), null);
});

test('🚀 Launch from an approved Google product: its own key (google|…), source Google, its proof', async () => {
  const env = await googleEnv();
  const s = await session(env);
  await s.post('/api/hide', { ad_id: 'gCR10000000000000000201', status: 'seen' });
  const pick = await s.get('/api/launch?pick=1');
  const c = pick.candidates.find((x) => x.key === 'google|' + GLOW);
  assert.ok(c, JSON.stringify(pick.candidates.map((x) => x.key)));
  assert.deepStrictEqual([c.facts.source, c.facts.title, c.facts.proof, c.facts.rpd], ['google', 'Glow Sunset Lamp', { n: 2, of: 6 }, null]);
  const started = await s.post('/api/launch', { start: 'google|' + GLOW });
  assert.strictEqual(started.launch.key, 'google|' + GLOW);
  assert.strictEqual(started.launch.facts.ad, 'https://adstransparency.google.com/advertiser/AR10000000000000000004/creative/CR10000000000000000201');
});

test("Jev's check (world-check.mjs) asks about the Google products too, after the others, with their Google headlines; a page it answered for outside the EU is not asked again", async () => {
  const env = await googleEnv();
  env.db.exec('DELETE FROM winners'); // only the Google tab's products here
  env.db.prepare("INSERT INTO world_checks (product_key, people, animals, gymwear, physical, category, input, checked_at, version, main) VALUES (?, 0.01, 0.01, 0.01, 0.99, 'Home', 'photo', 'x', ?, 'Home')").run(BRIGHT, VERSION);
  const left = env.db.prepare(GOOGLE_TODO_SQL).all(100).map((r) => r.product_key);
  assert.deepStrictEqual(left.sort(), [GLOW, POSTURE].sort(), 'the projection lamp\'s page has an answer from outside the EU: the board uses it');
  const asked = [];
  const answer = (body) => {
    const out = {};
    for (const [k, q] of Object.entries(body.questions)) {
      if (q.type === 'noul') out[k] = { type: 'noul', noul: k === 'physical' ? 0.98 : 0.01 };
      else if (q.type === 'score') out[k] = { type: 'score', score: 2.5, confidence: 0.5 };
      else if (k === 'category') out[k] = { type: 'choice', choice: 'x', confidence: 0.9, probabilities: { [`Home${SEP}Lighting`]: 0.9 } };
      else out[k] = { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 0.8 };
    }
    return out;
  };
  const doFetch = async (url, init = {}) => {
    if (String(url).startsWith('https://api.typesafe.ai/')) {
      const body = JSON.parse(init.body);
      asked.push(body.state);
      return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: answer(body), usage: { input_tokens: 1000 } }), { status: 200 });
    }
    return new Response('not here', { status: 404 }); // no photo, no product page: the words only
  };
  const client = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const t = await checkAll({ db: client, key: 'k', doFetch, pause: async () => {}, atOnce: 1, log: () => {}, now: () => NOW });
  assert.deepStrictEqual([t.checked, t.left], [2, 0]);
  assert.deepStrictEqual(env.db.prepare("SELECT product_key FROM world_checks WHERE product_key LIKE 'google|%' ORDER BY product_key").all().map((r) => r.product_key), ['google|' + GLOW, 'google|' + POSTURE]);
  const posture = asked.find((s) => s.product.name === 'Posture Corrector Pro');
  assert.deepStrictEqual(posture.ads.titles.sort(), ['Posture Corrector Pro', 'Posture Corrector Pro | Free shipping'], "the ads' own words, as Google shows them");
  assert.deepStrictEqual(posture.ads.countries, ['DE', 'NL']);
  assert.strictEqual(posture.shop.domain, 'https://posturepro-sample.example/');
  // The board shows the answers: its category on the card.
  const s = await session(env);
  env.db.prepare("UPDATE state SET updated_at = 'jev' WHERE key = 'world_check'").run();
  const j = await s.get('/api/ads?scope=google&view=all');
  assert.deepStrictEqual(j.ads.map((a) => [a.title, a.jev && a.jev.main]), [['Posture Corrector Pro', 'Home'], ['Sunset Projection Lamp', 'Home'], ['Glow Sunset Lamp', 'Home']]);
});

test('the board without the Google tables (a database not migrated yet) works as before; odd rows are read safely', async () => {
  const env = await seededEnv();
  env.db.exec('DROP TABLE google_products');
  const s = await session(env);
  const j = await s.get('/api/ads?scope=google&view=all');
  assert.deepStrictEqual([j.total, j.counts.google], [0, 0]);
  assert.strictEqual((await s.get('/api/ads?view=all')).total, 27);
  // Rules and links only from what the board knows: an unknown state is "unknown", a link only from checked ids.
  assert.deepStrictEqual(rulesOf('[{"key":"shopify","state":"ok","how":"exact","text":"x"},{"key":"reach","state":"passed!","how":"magic"},{"key":"evil"}]').map((i) => [i.key, i.state, i.how]),
    [['shopify', 'ok', 'exact'], ['reach', 'unknown', 'none']]);
  assert.deepStrictEqual(rulesOf('not json'), []);
  const r = googleRow({ product_key: 'a.example/products/x', ad_id: 'g1', advertiser_id: 'javascript:alert(1)', creative_id: 'CR123456', regions: '["NL","<b>"]', formats: '["image","flash"]', rules: '[]' });
  assert.deepStrictEqual([r.ad_library_url, r.google.regions, r.google.formats], ['', ['NL'], ['image']]);
  assert.strictEqual(advertiserUrl('AR123456'), libAdvertiserUrl('AR123456'), 'the same links as the hunt\'s');
  assert.strictEqual(creativeUrl('AR123456', 'CR654321'), libCreativeUrl('AR123456', 'CR654321'));
  const list = products([r], [], [], NOW);
  assert.strictEqual(list.v.length, 0, 'never on the EU tab');
  assert.strictEqual(keyOfRow(r), 'google|a.example/products/x', "the AI read's key is the launch card's key (launch.mjs keyOf)");
  assert.strictEqual(keyOfRow(r), keyOf(r));
});
