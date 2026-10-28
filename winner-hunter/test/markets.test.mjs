// Untapped markets outside the EU: lib/markets.mjs (where an ad aims), markets.mjs (one Meta request per shop, saved
// in D1) and the board (cards, the Inbox and Browse focus, ?open=NZ, Market Radar). Plus the hunt that can no longer
// hang on a request that never answers (2026-10-27).
import test from 'node:test';
import assert from 'node:assert';
import { FOCUS, EU, aimedAt, coverOf, compactAims, untappedOf } from '../lib/markets.mjs';
import { refresh, REDO_DAYS, PER_PAGE, MAX_PAGES, usageOf } from '../markets.mjs';
import { markStalled, failRun } from '../run.mjs';
import { hunt } from '../lib/meta.mjs';
import { handle, makeToken, outsideOf } from '../worker/src/app.mjs';
import { d1Client } from '../lib/d1.mjs';
import { d1Rest } from './helpers/sqlite-d1.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { base, fakeFetch, NOW as META_NOW } from './helpers/fake-meta.mjs';

const DAY = 864e5;
const C = (name, extra = {}) => Object.assign({ name, num_obfuscated: 0, type: 'countries', excluded: false }, extra);
const G = (name, extra = {}) => Object.assign({ name, num_obfuscated: 0, type: 'country_groups', excluded: false }, extra);
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers) });
const hanging = (init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

test('aimedAt: the markets outside the EU an ad aims at, from its target_locations as Meta gives them', () => {
  const at = (l) => [...aimedAt(l)].sort().join(',');
  assert.strictEqual(aimedAt([G('Worldwide')]).size, FOCUS.length, 'worldwide: every market');
  assert.strictEqual(at([C('Netherlands'), C('Belgium'), C('Germany')]), '', 'EU countries only: none outside the EU');
  assert.strictEqual(at([C('Ireland'), C('United Kingdom')]), 'GB');
  assert.strictEqual(at([G('Europe')]), 'CH,GB,IS,NO', 'Europe reaches the UK, Switzerland, Norway and Iceland');
  assert.strictEqual(at([C('Florence, Italy', { type: 'CITY' }), C('Dublin, Ireland', { type: 'CITY' })]), '', 'cities in the EU');
  assert.strictEqual(at([C('Auckland, New Zealand', { type: 'CITY' }), C('Ontario, Canada', { type: 'REGION' })]), 'CA,NZ', 'a city or region counts for its country');
  assert.strictEqual(aimedAt([G('Worldwide'), C('New Zealand', { excluded: true })]).has('NZ'), false, 'an excluded country stays untapped');
  assert.strictEqual(aimedAt([G('Worldwide'), C('New Zealand', { excluded: true })]).size, FOCUS.length - 1);
  const odd = new Set();
  assert.strictEqual(aimedAt([G('Some New Group')], odd).size, 0, 'an unknown group adds no market…');
  assert.deepStrictEqual([...odd], ['Some New Group'], '…and is collected');
  assert.strictEqual(at([G('Latin America'), G('EMEA')]), 'AE,CH,GB,IL,IS,KW,NO,QA,SA', 'known groups by their real members (not "everywhere")');
  assert.strictEqual(at([G('Nordic countries')]), 'IS,NO');
  const seen = new Set();
  assert.strictEqual(at([G('Euro area'), G('European Economic Area (EEA)')]), 'IS,NO', 'names Meta used on the first real run (2026-10-28)');
  aimedAt([G('Euro area'), G('European Economic Area (EEA)')], seen);
  assert.strictEqual(seen.size, 0, 'both known');
  // left out: a whole region, a country (whatever Meta calls the type), but a city left out does not open its country
  assert.strictEqual(at([G('Worldwide'), G('Asia', { excluded: true })]), 'AU,CA,CH,GB,IS,NO,NZ,US', 'Worldwide without Asia leaves Asia open');
  assert.strictEqual(aimedAt([G('Worldwide'), C('New Zealand', { type: 'country', excluded: true })]).has('NZ'), false);
  assert.strictEqual(aimedAt([G('Worldwide'), C('Auckland, New Zealand', { type: 'CITY', excluded: true })]).has('NZ'), true);
  assert.strictEqual(at([C('United States'), C('Hong Kong'), C('South Korea'), C('United Arab Emirates')]), 'AE,HK,KR,US');
  assert.strictEqual(at([G('North America'), G('Oceania')]), 'AU,CA,NZ,US');
  assert.strictEqual(at([C('India'), C('Pakistan')]), '', 'markets outside the focus list are left out');
  assert.strictEqual(at(null), '');
  assert.strictEqual(at([{}, { name: '' }]), '');

  // a shop: the union of its ads' targetings, stored compactly ([name, type, excluded])
  const aims = (...ads) => ads.map((a) => compactAims(a));
  assert.deepStrictEqual(compactAims([C('United Kingdom'), C('Ireland'), { name: '' }]), [['Ireland', 'countries', 0], ['United Kingdom', 'countries', 0]]);
  assert.strictEqual(coverOf(aims([G('Worldwide')])), '*');
  assert.strictEqual(coverOf(aims([C('Switzerland')], [C('United Kingdom')])), 'GB,CH', 'FOCUS order, over all its ads');
  assert.strictEqual(coverOf(aims([C('France')])), '');
  assert.strictEqual(coverOf([]), '');
  assert.strictEqual(coverOf(aims([G('Some New Group')], [C('France')])), '?', 'an unknown group: can\'t tell');
  assert.strictEqual(coverOf(aims([G('Some New Group')], [G('Worldwide')])), '*', 'unless another ad aims worldwide anyway');
  assert.strictEqual(coverOf(aims([G('Worldwide'), C('New Zealand', { excluded: true })], [C('New Zealand')])), '*', 'excluded in one ad, aimed at by another');
  assert.strictEqual(coverOf(aims([G('Worldwide'), G('Weird Group', { excluded: true })])), '?', 'worldwide without an unknown region: not sure');
  assert.strictEqual(coverOf(aims([G('Worldwide'), G('Weird Group', { excluded: true })], [G('Worldwide')])), '*', 'unless another ad is plainly worldwide');
  assert.deepStrictEqual(untappedOf('*'), []);
  assert.strictEqual(untappedOf('?'), null, 'can\'t tell: shown as nothing, hidden from nothing');
  assert.deepStrictEqual(untappedOf(''), FOCUS);
  assert.deepStrictEqual(untappedOf('GB,CH,NO,IS'), ['US', 'CA', 'AU', 'NZ', 'SG', 'HK', 'JP', 'KR', 'IL', 'AE', 'SA', 'QA', 'KW']);
  assert.strictEqual(untappedOf(null), null, 'not checked yet');
  assert.strictEqual(untappedOf(undefined), null);
  assert.strictEqual(EU.length, 27);
  assert.ok(!FOCUS.some((cc) => EU.includes(cc)));
  assert.ok(!FOCUS.includes('IN') && !FOCUS.includes('PK'), 'no poorer markets (2026-10-25)');
});

test('usageOf: the highest of call count, CPU and time in Meta\'s usage header', () => {
  const h = (o) => ({ headers: new Headers({ 'x-business-use-case-usage': JSON.stringify(o) }) });
  assert.strictEqual(usageOf(h({ 1: [{ call_count: 12, total_cputime: 3, total_time: 81 }] })), 81);
  assert.strictEqual(usageOf({ headers: new Headers({ 'x-app-usage': '{"call_count":40,"total_time":2}' }) }), 40);
  assert.strictEqual(usageOf({ headers: new Headers({ 'x-app-usage': 'not json' }) }), 0);
  assert.strictEqual(usageOf({ headers: new Headers() }), 0);
});

// Meta for markets.mjs: per shop (page id) the target_locations of its active ads.
const AIMS = {
  500: [[G('Worldwide')]], // shop0: everywhere
  508: [[G('Some New Group')]], // a group lib/markets.mjs doesn't know: can't tell
  501: [[C('Netherlands'), C('Belgium')], [C('Germany')]], // EU only: all 17 untapped
  502: [[C('Ireland'), C('United Kingdom')]], // UK
  503: [[G('Europe')], [C('France')]], // UK, CH, NO, IS
  504: [], // no active ads: unknown
  505: [[G('Worldwide'), C('New Zealand', { excluded: true })]], // everywhere but New Zealand
};
// BIG: shops with more ads than one page: 506's worldwide ads only on page 2; 507 has 2,500 EU-only ads (more than read).
const BIG = { 506: (i) => (i < PER_PAGE ? [C('Netherlands')] : [G('Worldwide')]), 507: () => [C('France')] };
const BIG_N = { 506: PER_PAGE + 10, 507: 2500 };
function meta({ limitAfter = Infinity, usage = () => 10, expired = new Set(), hang = new Set(), slowAbove = 0, code10 = false, blind = new Set() } = {}) {
  const calls = [];
  const doFetch = async (url, init) => {
    const u = new URL(url);
    calls.push(u);
    assert.strictEqual(u.searchParams.get('fields'), 'id,target_locations');
    assert.strictEqual(u.searchParams.get('ad_active_status'), 'ACTIVE');
    assert.deepStrictEqual(JSON.parse(u.searchParams.get('ad_reached_countries')).sort(), [...EU, 'GB'].sort(), 'every EU country and the UK');
    const tok = u.searchParams.get('access_token');
    assert.ok(tok);
    const pid = JSON.parse(u.searchParams.get('search_page_ids'))[0];
    if (hang.has(pid) && Number(u.searchParams.get('limit')) > slowAbove) return hanging(init);
    if (expired.has(tok)) return json({ error: { code: 190, message: 'Error validating access token' } }, 400);
    if (code10) return json({ error: { code: 10, message: 'Application does not have permission for this action' } }, 400);
    if (blind.has(pid)) return json({ data: [{ id: pid + '-0' }, { id: pid + '-1', target_locations: [C('France')] }] });
    if (calls.length > limitAfter) return json({ error: { code: 613, message: 'Calls to this api have exceeded the rate limit.' } }, 400);
    const hdr = { 'x-business-use-case-usage': JSON.stringify({ 1: [{ call_count: 5, total_cputime: 1, total_time: usage(calls.length) }] }) };
    if (BIG[pid]) {
      const lim = Number(u.searchParams.get('limit'));
      const from = Number(u.searchParams.get('after') || 0);
      const to = Math.min(BIG_N[pid], from + lim);
      const data = Array.from({ length: to - from }, (_, k) => ({ id: `${pid}-${from + k}`, target_locations: BIG[pid](from + k) }));
      const next = new URL(url);
      next.searchParams.set('after', String(to));
      return json({ data, paging: to < BIG_N[pid] ? { next: next.toString() } : undefined }, 200, hdr);
    }
    const ads = (AIMS[pid] || [[C('France')]]).map((tl, i) => ({ id: `${pid}-${i}`, target_locations: tl }));
    return json({ data: ads }, 200, hdr);
  };
  return { calls, doFetch };
}
const coverIn = (env, pid) => {
  const r = env.db.prepare('SELECT aims, sampled, partial FROM market_cover WHERE page_id = ?').get(pid);
  return r && { covered: coverOf(JSON.parse(r.aims)), sampled: r.sampled, partial: r.partial };
};
const cookieAt = async (env, now) => `__Host-wh=${await makeToken(env.BOARD_PIN, now)}`;

test('markets.mjs: one Meta request per board shop; saved per shop; asked again only after a week', async () => {
  const env = await seededEnv();
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const logs = [];
  const m = meta();
  const t = await refresh({ db, tokens: ['tok'], doFetch: m.doFetch, now: () => NOW, log: (x) => logs.push(x), sleep: async () => {} });
  const row = (pid) => coverIn(env, pid);
  // the board shops (25 sample shops + the stale winner's); not the ones that fail the rules (60 ads, too old, uncounted)
  assert.ok(t.wanted >= 25 && t.checked === t.wanted, JSON.stringify(t));
  const per = (pid) => m.calls.filter((u) => u.searchParams.get('search_page_ids') === `["${pid}"]`).length;
  assert.strictEqual(per('501'), 1, 'one request for a shop with fewer ads than a page');
  assert.strictEqual(m.calls[0].searchParams.get('limit'), String(PER_PAGE));
  assert.strictEqual(per('506'), 2, 'a second page when the first has no worldwide ad');
  assert.strictEqual(per('507'), MAX_PAGES, 'at most MAX_PAGES pages');
  assert.deepStrictEqual(row('506'), { covered: '*', sampled: PER_PAGE + 10, partial: 0 }, 'its worldwide ads on page 2 are found');
  assert.deepStrictEqual(row('507'), { covered: '', sampled: MAX_PAGES * PER_PAGE, partial: 1 }, 'more ads than read: partial');
  const raw = env.db.prepare('SELECT aims, checked_at FROM market_cover WHERE page_id = ?').get('501');
  assert.deepStrictEqual(JSON.parse(raw.aims), [[['Germany', 'countries', 0]], [['Belgium', 'countries', 0], ['Netherlands', 'countries', 0]]].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)), 'the distinct targetings, as Meta gives them');
  assert.strictEqual(raw.checked_at, new Date(NOW).toISOString());
  assert.ok(!m.calls.some((u) => ['704', '705', '706'].includes(JSON.parse(u.searchParams.get('search_page_ids'))[0])), 'shops whose ads fail the rules: not asked');
  assert.strictEqual(JSON.parse(m.calls[0].searchParams.get('search_page_ids'))[0], '703', 'the most reach a day first (Stale Old Winner)');
  assert.deepStrictEqual(row('500'), { covered: '*', sampled: 1, partial: 0 });
  assert.strictEqual(row('501').covered, '');
  assert.strictEqual(row('501').sampled, 2);
  assert.strictEqual(row('502').covered, 'GB');
  assert.strictEqual(row('503').covered, 'GB,CH,NO,IS');
  assert.strictEqual(row('504').sampled, 0, 'no active ads: saved as unknown, not asked again for a week');
  assert.strictEqual(row('505').covered, FOCUS.filter((c) => c !== 'NZ').join(','));
  assert.strictEqual(t.worldwide, 2, 'shop0 and 506');
  assert.strictEqual(t.partial, 1);
  assert.match(logs.at(-1), new RegExp(`^Markets outside the EU: ${t.checked} of ${t.wanted} shops checked · 2 already aim worldwide · 1 with more ads than read · 0 with ads without targeting`));

  // within the week: nothing to ask; after it: every shop again
  const again = meta();
  const t2 = await refresh({ db, tokens: ['tok'], doFetch: again.doFetch, now: () => NOW + 3 * DAY, log: () => {}, sleep: async () => {} });
  assert.strictEqual(again.calls.length, 0);
  assert.strictEqual(t2.wanted, 0);
  const later = meta();
  await refresh({ db, tokens: ['tok'], doFetch: later.doFetch, now: () => NOW + (REDO_DAYS + 1) * DAY, log: () => {}, sleep: async () => {} });
  assert.ok(later.calls.length >= 1, 'a week later: asked again');
});

test('markets.mjs: stops at Meta\'s limit and keeps what it checked; a stalled answer skips one shop; a bad token is red', async () => {
  const fresh = async () => {
    const env = await seededEnv();
    return { env, db: d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 }) };
  };
  const count = (env) => env.db.prepare('SELECT COUNT(*) AS n FROM market_cover').get().n;

  // Meta's hourly limit after 5 shops: 5 saved, no throw, the rest next run
  let { env, db } = await fresh();
  const limited = meta({ limitAfter: 5 });
  const t1 = await refresh({ db, tokens: ['tok'], doFetch: limited.doFetch, now: () => NOW, log: () => {}, sleep: async () => {} });
  assert.strictEqual(t1.stopped, 'meta-limit');
  assert.strictEqual(count(env), t1.checked);
  assert.ok(t1.checked >= 4 && t1.checked <= 6, `about 5 checked (2 at a time): ${t1.checked}`);

  // usage past 80%: stops after that answer
  ({ env, db } = await fresh());
  const busy = meta({ usage: (n) => (n >= 3 ? 85 : 20) });
  const t2 = await refresh({ db, tokens: ['tok'], doFetch: busy.doFetch, now: () => NOW, log: () => {}, sleep: async () => {} });
  assert.strictEqual(t2.stopped, 'meta-limit');
  assert.ok(busy.calls.length <= 4, `stopped soon after 85%: ${busy.calls.length} calls`);
  assert.strictEqual(t2.usagePeak, 85);

  // an answer that never comes: aborted, retried, then that one shop is skipped; the others are checked
  ({ env, db } = await fresh());
  const stuck = meta({ hang: new Set(['501']) });
  const logs = [];
  const t3 = await refresh({ db, tokens: ['tok'], doFetch: stuck.doFetch, now: () => NOW, log: (x) => logs.push(x), sleep: async () => {}, timeoutMs: 20 });
  assert.strictEqual(t3.checked, t3.wanted - 1);
  assert.ok(logs.some((x) => /^shop 501: skipped \(Meta API unreachable: no answer in time\)/.test(x)), logs.join('\n'));
  const asked = (m, pid) => m.calls.filter((u) => u.searchParams.get('search_page_ids') === `["${pid}"]`).map((u) => Number(u.searchParams.get('limit')));
  assert.deepStrictEqual(asked(stuck, '501'), [500, 250, 125], 'three tries, each page half as big');

  // too slow for 500 ads, fine for 250: asked again smaller, and saved
  ({ env, db } = await fresh());
  const slow = meta({ hang: new Set(['501']), slowAbove: 250 });
  const t5 = await refresh({ db, tokens: ['tok'], doFetch: slow.doFetch, now: () => NOW, log: () => {}, sleep: async () => {}, timeoutMs: 20 });
  assert.deepStrictEqual(asked(slow, '501'), [500, 250]);
  assert.strictEqual(t5.checked, t5.wanted);
  assert.strictEqual(coverIn(env, '501').covered, '');

  // a problem with the account (code 10): stop at once, red, not one skipped shop after another
  ({ env, db } = await fresh());
  const denied = meta({ code10: true });
  await assert.rejects(refresh({ db, tokens: ['tok'], doFetch: denied.doFetch, now: () => NOW, log: () => {}, sleep: async () => {} }), /confirm your identity/);
  assert.ok(denied.calls.length <= 2, `stopped at once: ${denied.calls.length} calls`);

  // ads without target_locations: where those aim is unknown, so the shop is partial (the board: can't tell)
  ({ env, db } = await fresh());
  const blindLogs = [];
  const t6 = await refresh({ db, tokens: ['tok'], doFetch: meta({ blind: new Set(['501']) }).doFetch, now: () => NOW, log: (x) => blindLogs.push(x), sleep: async () => {} });
  assert.deepStrictEqual(coverIn(env, '501'), { covered: '', sampled: 2, partial: 1 });
  assert.deepStrictEqual([t6.partial, t6.blind], [1, 1], '507 has more ads than read; 501 is counted as "without targeting", not as that');
  assert.match(blindLogs.at(-1), / · 1 with more ads than read · 1 with ads without targeting/);

  // an expired token: red (throws)
  ({ env, db } = await fresh());
  await assert.rejects(refresh({ db, tokens: ['tok'], doFetch: meta({ expired: new Set(['tok']) }).doFetch, now: () => NOW, log: () => {}, sleep: async () => {} }), /token invalid or expired/);
  await assert.rejects(refresh({ db, tokens: [''], doFetch: meta().doFetch, now: () => NOW, log: () => {} }), /No META_TOKEN/);

  // token 1 expired, token 2 fine: both workers move to token 2 (the first one to notice switches, the other follows)
  ({ env, db } = await fresh());
  const two = meta({ expired: new Set(['t1']) });
  const t4 = await refresh({ db, tokens: ['t1', 't2'], doFetch: two.doFetch, now: () => NOW, log: () => {}, sleep: async () => {} });
  assert.strictEqual(t4.stopped, '');
  assert.strictEqual(t4.checked, t4.wanted, 'every shop checked on token 2');
  assert.strictEqual(two.calls.filter((u) => u.searchParams.get('access_token') === 't1').length, 2, 'token 1 tried once by each worker, then never again');
});

test('board: each card shows the markets its shop leaves untapped; the Inbox and Browse leave out shops that are everywhere', async () => {
  const env = await seededEnv();
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  let now = NOW + 3600e3;
  const cookie = await cookieAt(env, now);
  const get = async (path) => {
    const res = await handle(new Request('https://wh.example.workers.dev' + path, { headers: { cookie } }), env, { html: '', now });
    return path.endsWith('.csv') || path.includes('.csv?') ? res.text() : res.json();
  };
  // before the check: every product shows, none with markets
  const before = await get('/api/ads?view=all');
  assert.ok(before.ads.some((a) => a.id === '9000'));
  assert.ok(before.ads.every((a) => a.open === null), 'not checked yet');
  const n0 = before.counts.all;

  await refresh({ db, tokens: ['tok'], doFetch: meta().doFetch, now: () => NOW, log: () => {}, sleep: async () => {} });
  assert.ok((await get('/api/ads?view=all')).ads.every((a) => a.open === null), 'the board reads its data again after 15 minutes (as for best sellers)');
  now += 16 * 60000;
  const all = await get('/api/ads?view=all');
  const ad = (list, id) => list.ads.find((a) => a.id === id);
  assert.strictEqual(ad(all, '9000'), undefined, 'shop0 aims worldwide: left out of Browse');
  assert.strictEqual(all.counts.all, n0 - 2, 'shop0 and 506');
  assert.deepStrictEqual(ad(all, '9001').open, FOCUS, 'EU-only shop: all 17 untapped');
  assert.deepStrictEqual(ad(all, '9002').open, FOCUS.filter((c) => c !== 'GB'));
  assert.deepStrictEqual(ad(all, '9005').open, ['NZ']);
  assert.strictEqual(ad(all, '9004').open, null, 'shop with no active ads: unknown, still shown');
  assert.strictEqual(ad(all, '9008').open, null, 'an unknown country group: can\'t tell, still shown');
  assert.strictEqual(ad(all, '9007').open, null, 'more ads than read and none worldwide: can\'t tell');
  assert.strictEqual(ad(all, '9006'), undefined, 'worldwide ads on page 2: left out like shop0');
  assert.strictEqual(ad(all, '9001').page, '501', 'the shop\'s page id, for its Ad Library check');
  env.db.prepare("UPDATE market_cover SET aims = '[]' WHERE page_id = '502'").run();
  env.db.prepare("UPDATE market_cover SET aims = 'not json' WHERE page_id = '503'").run();

  now += 16 * 60000; // the board reads the change
  const after = await get('/api/ads?view=all');
  assert.strictEqual(ad(after, '9002').open, null, 'no targetings saved: can\'t tell (never "open everywhere")');
  assert.strictEqual(ad(after, '9003').open, null, 'unreadable: can\'t tell');
  env.db.prepare("UPDATE market_cover SET aims = ? WHERE page_id = '502'").run(JSON.stringify([[['Ireland', 'countries', 0], ['United Kingdom', 'countries', 0]]]));
  env.db.prepare("UPDATE market_cover SET aims = ? WHERE page_id = '503'").run(JSON.stringify([[['Europe', 'country_groups', 0]], [['France', 'countries', 0]]]));
  now += 16 * 60000;
  const every = await get('/api/ads?view=all&world=0');
  assert.deepStrictEqual(ad(every, '9000').open, [], '?world=0: shown again, with nothing untapped');
  assert.strictEqual(every.counts.all, n0);

  const nz = await get('/api/ads?view=all&open=NZ');
  assert.ok(nz.ads.length && nz.ads.every((a) => a.open.includes('NZ')));
  assert.ok(ad(nz, '9005') && !ad(nz, '9004') && !ad(nz, '9008'), 'only checked shops that leave New Zealand open');
  const gb = await get('/api/ads?view=all&open=gb');
  assert.ok(!ad(gb, '9002') && !ad(gb, '9003') && ad(gb, '9001'), 'shops that aim at the UK are not untapped there');
  assert.strictEqual((await get('/api/ads?view=all&open=FR')).total, all.total, 'not a market outside the EU: no filter');

  const inbox = await get('/api/ads?view=inbox&limit=100&world=0');
  assert.ok(!inbox.ads.some((a) => a.id === '9000'), 'the Inbox always leaves out shops that are everywhere');
  assert.strictEqual(inbox.counts.inbox, inbox.total);

  const csv = await get('/export.csv?view=all&world=0');
  assert.match(csv.split('\r\n')[0], /,untapped_outside_eu$/);
  assert.match(csv, /\r\n9000,[^\r\n]*,none \(worldwide\)\r\n/);
  assert.match(csv, /\r\n9005,[^\r\n]*,NZ\r\n/);

  // Market Radar outside the EU: per market the proven products whose shop doesn't advertise there
  const mk = await get('/api/markets');
  const mkAll = await get('/api/markets?world=0');
  const o = mk.outside;
  assert.deepStrictEqual(mkAll.outside, o, 'the Outside EU counts never depend on the chip');
  assert.strictEqual(o.checked + o.unchecked, mkAll.products);
  assert.strictEqual(mk.products, mkAll.products - 2, 'the EU radar counts what Browse shows (worldwide shops left out)');
  assert.strictEqual(o.worldwide, 2);
  const by = Object.fromEntries(o.markets.map((x) => [x.cc, x]));
  assert.strictEqual(by.NZ.products, o.checked - 2, 'every checked product but the worldwide ones');
  assert.strictEqual(by.GB.products, o.checked - 2 - 3, 'and not the shops aiming at the UK (502, 503, 505)');
  assert.ok(o.markets[0].products >= o.markets.at(-1).products, 'most untapped first');
  assert.strictEqual(by.NZ.top.id, '9500', 'the strongest product there');
  assert.ok(by.NZ.rpd > 0 && by.NZ.share > 90);
});

test('outsideOf: unchecked products are counted apart, markets with none are left out', () => {
  const o = outsideOf([{ ad_id: 'a', rpd: 100, open: ['NZ', 'AU'] }, { ad_id: 'b', rpd: 300, open: ['NZ'] }, { ad_id: 'c', page_id: '9', rpd: 50, open: [] },
    { ad_id: 'e', page_id: '9', rpd: 40, open: [] }, { ad_id: 'd', rpd: 999, open: null }]);
  assert.deepStrictEqual(o.markets.map((x) => [x.cc, x.products, x.rpd, x.top.id]), [['NZ', 2, 400, 'b'], ['AU', 1, 100, 'a']]);
  assert.deepStrictEqual([o.checked, o.worldwide, o.unchecked], [4, 1, 1], 'worldwide counts shops: two products of one shop are one');
  assert.deepStrictEqual(outsideOf([]), { markets: [], checked: 0, worldwide: 0, unchecked: 0 });
});

test('the hunt no longer hangs on a Meta answer that never comes: the request is aborted, retried, then that search is skipped', async () => {
  const logs = [];
  const shops = fakeFetch([]);
  const doFetch = (url, init) => (new URL(url).hostname === 'graph.test' && !/debug_token/.test(url) ? hanging(init) : shops(url, init));
  const res = await hunt(Object.assign({}, base, { requestMs: 20 }), { fetch: doFetch, now: META_NOW, waitScale: 0, log: (m) => logs.push(m) });
  assert.ok(res.stats.skipped >= 1, JSON.stringify(res.stats));
  assert.ok(logs.some((m) => /skipped \(Meta API unreachable: no answer in time\)/.test(m)), logs.join('\n'));
  assert.deepStrictEqual(res.results, []);
});

test('a Meta page that times out is asked again smaller', async () => {
  const limits = [];
  const shops = fakeFetch([]);
  let n = 0;
  const doFetch = (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'graph.test' || /debug_token/.test(url) || u.searchParams.get('search_page_ids')) return shops(url, init);
    if (u.searchParams.get('ad_delivery_date_max') !== new Date(META_NOW - 7 * DAY).toISOString().slice(0, 10)) return shops(url, init);
    limits.push(Number(u.searchParams.get('limit')));
    return n++ < 2 ? hanging(init) : shops(url, init); // the first two tries never answer
  };
  await hunt(Object.assign({}, base, { requestMs: 20 }), { fetch: doFetch, now: META_NOW, waitScale: 0, log: () => {} });
  assert.deepStrictEqual(limits.slice(0, 3), [limits[0], Math.floor(limits[0] / 2), Math.floor(limits[0] / 4)], `halved after each timeout: ${limits}`);
});

test('D1 requests time out too (a stalled one fails with a clear error instead of hanging the run)', async () => {
  const db = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: (url, init) => hanging(init), retryMs: 0, timeoutMs: 20 });
  await assert.rejects(db.query('SELECT 1'), /^Error: Cloudflare D1: no answer in 0 s$/);
});

test('markStalled: a run that ended without finishing is marked failed (red), once', async () => {
  const state = { last_run: JSON.stringify({ id: 'r1', status: 'running', started_at: '2026-10-27T06:15:31.747Z', ads_checked: 0, batches: 0, saved: 0 }) };
  const runs = [];
  const db = { getState: async (k) => state[k] ?? null, setState: async (k, v) => { state[k] = JSON.stringify(v); }, saveRun: async (r) => runs.push(r) };
  assert.strictEqual(await markStalled(db, Date.parse('2026-10-27T06:17:19Z')), true);
  const last = JSON.parse(state.last_run);
  assert.strictEqual(last.status, 'stalled');
  assert.strictEqual(last.health, 'failed');
  assert.strictEqual(last.finished_at, '2026-10-27T06:17:19.000Z');
  assert.strictEqual(last.alert, 'Run gestopt voordat hij klaar was (vastgelopen terwijl hij wachtte) / Run stopped before it finished (stuck while waiting)');
  assert.deepStrictEqual([runs[0].id, runs[0].status], ['r1', 'failed']);
  assert.strictEqual(await markStalled(db), false, 'not running any more: left alone');
  state.last_run = JSON.stringify({ id: 'r2', status: 'running' });
  await markStalled(db, Date.now(), 'fout: boom / error: boom');
  assert.match(JSON.parse(state.last_run).alert, /\(fout: boom\) \/ Run stopped before it finished \(error: boom\)$/);
  await assert.rejects(markStalled({ getState: async () => { throw new Error('Cloudflare D1: no answer in 60 s'); } }), /no answer/, 'a D1 error is not "nothing to mark"');

  // after run() threw: marked, nothing to mark, or D1 down: each said in the log
  const said = [];
  state.last_run = JSON.stringify({ id: 'r3', status: 'running' });
  assert.strictEqual(await failRun(db, new Error('boom'), (m) => said.push(m)), true);
  assert.deepStrictEqual(said, []);
  assert.strictEqual(await failRun(db, new Error('boom'), (m) => said.push(m)), false);
  assert.match(said.at(-1), /^::warning::Nothing marked in D1/);
  assert.strictEqual(await failRun({ getState: async () => { throw new Error('Cloudflare D1: no answer in 60 s'); } }, new Error('boom'), (m) => said.push(m)), false);
  assert.strictEqual(said.at(-1), '::warning::Could not mark the run failed in D1: Cloudflare D1: no answer in 60 s');
});
