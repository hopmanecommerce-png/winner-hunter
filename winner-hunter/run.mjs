#!/usr/bin/env node
/*
 * The nightly Winner Hunter run.
 *   META_TOKEN=… CF_API_TOKEN=… CF_ACCOUNT_ID=… [MINUTES=300] [KEYWORDS="dog | cat"] node winner-hunter/run.mjs
 *
 * Goes through keywords.txt in batches of 2, starting where the last run stopped (D1 state 'keyword_cursor').
 * After every batch the ads that pass every rule (lib/score.mjs: Shopify, 75+ active ads, 7–42 days live, 500+ EU
 * reach a day) are saved in D1 and the cursor moves on, so a run
 * that is stopped loses at most one batch. Stops at the time budget or when Meta blocks every token (613).
 * A D1 or store failure is a warning, never a crash. Typed-in KEYWORDS leave the cursor alone.
 *
 * Alerts: at the start every Meta token's expiry date is checked (debug_token). At the end a health check gives
 * the run a status (ok / warning / failed), saved in D1 (runs.status, last_run.health) for the board. A failed run
 * ends red (exit code 1), only after everything found has been saved, so GitHub sends its "run failed" notification.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hunt, pool, checkTokens } from './lib/meta.mjs';
import { d1Client, d1Settings } from './lib/d1.mjs';
import { slimRecord } from './lib/record.mjs';
import { parseKeywords, wrap } from './lib/keywords.mjs';
import { photoCache } from './lib/storephoto.mjs';
import { passesRules } from './lib/score.mjs';

const DAY = 864e5;
const WARN_DAYS = 7; // a Meta token that expires within this many days makes the run red
const n0 = (n) => Number(n || 0).toLocaleString('en-US');

/**
 * cfg:  { tokens, countries, minutes, keywords (all, in order), override (typed-in keywords or null), batchSize, minBatchMinutes, maxPerKeyword }
 * deps: { db, search, photo, now, log, summary, tokenCheck }   (db may be null: nothing is saved)
 * Returns the run's totals with health ('ok' | 'warning' | 'failed') and problems ([[nl, en], …]).
 */
export async function run(cfg, deps) {
  const c = Object.assign({ batchSize: 2, minBatchMinutes: 10, minutes: 300, countries: ['NL'], maxPerKeyword: 1500, override: null }, cfg);
  const { db, search = hunt, photo = async () => '', now = Date.now, log: out = console.log, summary = () => {}, tokenCheck = checkTokens } = deps;
  // No Meta token ever reaches the log.
  const log = (m) => out((c.tokens || []).reduce((x, tk) => (tk && tk.length >= 8 ? x.split(tk).join('***') : x), String(m)));
  let warnings = 0;
  let firstWarning = '';
  const warn = (m) => {
    warnings++;
    firstWarning = firstWarning || String(m).slice(0, 200);
    log(`::warning::${m}`);
  };
  const problems = []; // [nl, en]: each one makes the run fail (red)
  const safe = async (what, fn, fallback = null) => {
    if (!db) return fallback;
    try {
      return await fn();
    } catch (e) {
      warn(`${what}: ${e.message}`);
      return fallback;
    }
  };

  const started = now();
  const startIso = new Date(started).toISOString();
  const end = started + Math.min(Math.max(Number(c.minutes) || 300, 1), 345) * 60000;
  const all = c.keywords || [];
  const typed = Array.isArray(c.override) && c.override.length ? c.override : null;
  const n = all.length;

  // Where to start: the cursor in D1; without it (first run, D1 down) a slice that changes every day.
  let start = 0;
  if (!typed) {
    const raw = await safe('Could not read the keyword cursor from D1', () => db.getState('keyword_cursor'));
    let next = null;
    try {
      next = raw == null ? null : Number(JSON.parse(raw).next);
    } catch (e) {
      next = null;
    }
    start = wrap(Number.isFinite(next) ? next : Math.floor(started / DAY) * 20, n);
  }
  const list = typed || Array.from({ length: n }, (_, i) => all[(start + i) % n]);
  if (!list.length) throw new Error('No keywords');

  const t = { id: startIso, batches: 0, ads: 0, found: 0, saved: 0, saveFailed: 0, newWinners: 0, usagePeak: 0, cursor: typed ? null : start, stopped: 'done', error: '',
    blockedFirst: false, health: null, problems, alert: '' };
  const progress = async (finished) => {
    const note = `${t.stopped}${t.error ? ': ' + t.error : ''} · ${t.batches} batches · ${t.saved} saved${t.alert ? ' · ' + t.alert : ''}`.slice(0, 500);
    await safe('Could not save the run in D1', () => db.saveRun({ id: t.id, started_at: startIso, finished_at: finished ? new Date(now()).toISOString() : null,
      ads_checked: t.ads, winners: t.newWinners, meta_usage_peak: t.usagePeak, note, status: t.health }));
    await safe('Could not save last_run in D1', () => db.setState('last_run', {
      id: t.id, status: finished ? t.stopped : 'running', started_at: startIso, finished_at: finished ? new Date(now()).toISOString() : null,
      ads_checked: t.ads, saved: t.saved, new_winners: t.newWinners, batches: t.batches, meta_usage_peak: t.usagePeak,
      cursor: t.cursor, keywords_total: n, error: t.error || undefined, health: t.health || undefined, alert: t.alert || undefined,
    }, new Date(now())));
  };

  // Meta token expiry dates (debug_token). Invalid or expiring within 7 days: red, but the hunt still runs.
  const secret = (k) => (k === 1 ? 'META_TOKEN' : `META_TOKEN_${k}`);
  const checked = await Promise.resolve().then(() => tokenCheck(c.tokens)).catch((e) => [{ n: 0, error: e.message }]);
  let soonest = null;
  for (const k of checked || []) {
    if (k.error) {
      warn(`Could not check when Meta token ${k.n || ''} expires (${k.error})`);
    } else if (!k.valid) {
      problems.push([`Meta token ${secret(k.n)} ongeldig of verlopen`, `Meta token ${secret(k.n)} invalid or expired`]);
      log(`::error::Meta token ${secret(k.n)} is ongeldig of verlopen: maak een nieuwe en zet hem in het GitHub secret / Meta token ${secret(k.n)} is invalid or expired: make a new one and update the GitHub secret`);
    } else if (k.expiresAt) {
      soonest = soonest == null ? k.expiresAt : Math.min(soonest, k.expiresAt);
      const days = Math.max(0, Math.floor((k.expiresAt - started) / DAY));
      if (k.expiresAt - started < WARN_DAYS * DAY) {
        const on = new Date(k.expiresAt).toISOString().slice(0, 10);
        problems.push([`Meta token ${secret(k.n)} verloopt over ${days} dagen`, `Meta token ${secret(k.n)} expires in ${days} days`]);
        log(`::error::Meta token ${secret(k.n)} verloopt over ${days} dagen (${on}): maak nu een nieuwe en zet hem in het GitHub secret / Meta token ${secret(k.n)} expires in ${days} days (${on}): make a new one now and update the GitHub secret`);
      }
    }
  }
  if ((checked || []).some((k) => !k.error)) {
    await safe('Could not save token_expires_at in D1', () => db.setState('token_expires_at', {
      at: soonest ? new Date(soonest).toISOString() : null, checked_at: startIso,
      tokens: checked.filter((k) => !k.error).map((k) => ({ n: k.n, valid: !!k.valid, expires_at: k.expiresAt ? new Date(k.expiresAt).toISOString() : k.valid ? 'never' : null })),
    }, new Date(now())));
  }

  log(`Winner Hunter: ${typed ? `typed keywords (${typed.length})` : `keywords from #${start} of ${n}`}, ${c.countries.join(',')}, ${Math.round((end - started) / 60000)} min`);
  summary(`## Winner Hunter ${startIso.slice(0, 16).replace('T', ' ')} UTC\n`);
  await progress(false);

  let tokenStart = 0;
  const cache = {}; // competitor counts, shared by the batches of this run
  for (let i = 0; i < list.length; i += c.batchSize) {
    if (end - now() < c.minBatchMinutes * 60000) {
      t.stopped = 'time';
      break;
    }
    const q = list.slice(i, i + c.batchSize);
    let res;
    try {
      res = await search({ tokens: c.tokens, tokenStart, queries: q, countries: c.countries, max: c.maxPerKeyword, deadline: end, cache }, { log });
    } catch (e) {
      if (e.token || /token/i.test(e.message)) {
        t.stopped = 'token';
        t.error = e.message;
        log(`::error::${e.message}`);
        break;
      }
      warn(`Batch "${q.join(', ')}" failed: ${e.message} (skipped)`);
      res = { results: [], stats: { ads: 0 } };
    }
    const s = res.stats || {};
    tokenStart = s.token || 0;
    t.batches++;
    t.ads += s.ads || 0;
    t.usagePeak = Math.max(t.usagePeak, s.usagePeak || 0);

    // Only ads that pass every rule (anything else never reaches D1), with a store photo when the product has none.
    const recs = (res.results || []).filter(passesRules).map((r) => slimRecord(r));
    await pool(recs.filter((r) => !r.image_url), 6, async (r) => {
      const u = await photo(r.product_url || r.store_url).catch(() => '');
      if (u) Object.assign(r, { image_url: u, image_source: 'store' });
    });
    t.found += recs.length;
    if (recs.length && db) {
      const res = await Promise.resolve().then(() => db.upsertWinners(recs, new Date(now()))).catch((e) => ({ saved: 0, error: e.message }));
      t.saved += res.saved || 0;
      if (!res.saved) t.saveFailed++;
      if (res.error) warn(`${res.error} (${res.saved || 0} of ${recs.length} saved)`);
    }

    // A finished batch moves the cursor; one cut short (Meta block, time) is searched again next run.
    const cutShort = s.blocked || s.stoppedEarly;
    if (!typed && !cutShort) {
      t.cursor = wrap(start + i + q.length, n);
      await safe('Could not save the keyword cursor in D1', () => db.setState('keyword_cursor', { next: t.cursor }, new Date(now())));
    }
    t.newWinners = await safe('Could not count new winners', () => db.newWinnersSince(startIso), t.newWinners);
    await progress(false);

    const line = `Batch ${t.batches} · ${q.join(', ')} · ${n0(s.ads)} ads · ${recs.length} saved · Meta ${s.usagePeak ?? 0}%${t.cursor != null ? ` · next #${t.cursor}/${n}` : ''}${s.blocked ? ' · Meta blocked' : ''}`;
    log(line);
    summary(`- ${line}\n`);
    if (s.blocked) {
      t.stopped = 'meta-block';
      t.blockedFirst = t.batches === 1;
      if (!t.blockedFirst) warn('Meta hourly limit on every token: run stopped cleanly (everything found is saved)');
      break;
    }
    if (s.stoppedEarly) {
      t.stopped = 'time';
      break;
    }
  }

  // Health check: what makes the run red. A Meta block after some batches is only a warning.
  if (t.stopped === 'token') problems.push(['Meta token verlopen of ongeldig', 'Meta token expired or invalid']);
  if (t.blockedFirst) problems.push(['Meta blokkeerde alle tokens (613) vóór de eerste batch klaar was', 'Meta blocked every token (613) before the first batch finished']);
  if (t.ads === 0) problems.push(['0 ads gecheckt (Meta token?)', '0 ads checked (Meta token?)']);
  if (db && t.found && !t.saved) problems.push([`${t.found} gevonden maar 0 opgeslagen in D1`, `${t.found} found but 0 saved to D1`]);
  else if (db && t.saveFailed) problems.push([`opslaan in D1 mislukt voor ${t.saveFailed} batch(es)`, `D1 save failed for ${t.saveFailed} batch(es)`]);
  if (problems.length) {
    t.health = 'failed';
    t.alert = `Run mislukt: ${problems.map((p) => p[0]).join('; ')} / Run failed: ${problems.map((p) => p[1]).join('; ')}`;
    log(`::error::${t.alert}`);
  } else if (warnings) {
    t.health = 'warning';
    t.alert = `${warnings} waarschuwing(en) / ${warnings} warning(s): ${firstWarning}`;
  } else {
    t.health = 'ok';
  }

  await progress(true);
  const final = `Done (${t.stopped}) · ${t.batches} batches · ${n0(t.ads)} ads checked · ${t.saved} saved · ${t.newWinners} new winners · Meta peak ${t.usagePeak}% · ${t.health}`;
  log(final);
  summary(`\n**${final}**\n${t.health === 'ok' ? '' : `\n${t.alert}\n`}`);
  return t;
}

/**
 * A run that ended without finishing (last_run still "running"): marked failed, so the board shows it red instead of
 * "running" for ever. Returns true when it marked one.
 */
export async function markStalled(db, now = Date.now(), why = 'vastgelopen terwijl hij wachtte / stuck while waiting') {
  const raw = await db.getState('last_run'); // a D1 error throws: the caller says it could not mark the run
  let last = null;
  try {
    last = JSON.parse(raw || 'null');
  } catch (e) {
    last = null;
  }
  if (!last || last.status !== 'running') return false;
  const iso = new Date(now).toISOString();
  const [nl, en] = String(why).split(' / ');
  const alert = `Run gestopt voordat hij klaar was (${nl}) / Run stopped before it finished (${en || nl})`.slice(0, 300);
  await db.setState('last_run', Object.assign({}, last, { status: 'stalled', finished_at: iso, health: 'failed', alert }), new Date(now));
  await db.saveRun({ id: last.id, started_at: last.started_at, finished_at: iso, ads_checked: last.ads_checked || 0, winners: last.new_winners || 0,
    meta_usage_peak: last.meta_usage_peak || 0, note: `stalled · ${last.batches || 0} batches · ${last.saved || 0} saved`, status: 'failed' });
  return true;
}

/** After run() threw: mark the run failed and say whether that worked (never swallowed). */
export async function failRun(db, err, log = console.log, now = Date.now()) {
  try {
    const marked = await markStalled(db, now, `fout: ${err.message} / error: ${err.message}`);
    if (!marked) log('::warning::Nothing marked in D1 (this run had not saved a "running" status yet)');
    return marked;
  } catch (e) {
    log(`::warning::Could not mark the run failed in D1: ${e.message}`);
    return false;
  }
}

async function main() {
  const env = process.env;
  const tokens = [env.META_TOKEN, env.META_TOKEN_2, env.META_TOKEN_3].filter(Boolean);
  if (!tokens.length) throw new Error('No META_TOKEN: add it as a GitHub secret (see winner-hunter/README.md)');
  const s = d1Settings(env);
  if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)');
  const keywords = parseKeywords(fs.readFileSync(new URL('./keywords.txt', import.meta.url), 'utf8'));
  const override = String(env.KEYWORDS || '').split('|').map((k) => k.trim()).filter(Boolean);
  // 2026-10-27 the hunt ended 2 minutes in with exit code 0 and the run "running" for ever: something it waited for
  // (most likely a Meta request whose connection Node no longer watched) never settled, and with nothing else left to
  // wait for, Node simply stopped. Meta and D1 requests time out now; should a run still end without finishing, it
  // is marked failed (red) here.
  const db = d1Client(s);
  let finished = false;
  process.once('beforeExit', () => {
    if (finished) return;
    process.exitCode = 1;
    console.log('::error::The hunt stopped before it finished (stuck while waiting, nothing left to wait for)');
    markStalled(db).then((marked) => console.log(marked ? 'Run marked failed in D1' : '::warning::Nothing marked in D1 (this run had not saved a "running" status yet)'),
      (e) => console.log(`::warning::Could not mark the run failed in D1: ${e.message}`));
  });
  let out;
  try {
    out = await run({
      tokens,
      keywords,
      override,
      minutes: Number(env.MINUTES || 300),
      countries: String(env.COUNTRIES || 'NL,BE,DE,FR,AT,ES,IT,IE,DK,SE,PL').toUpperCase().split(',').map((x) => x.trim()).filter(Boolean),
    }, {
      db,
      photo: photoCache(),
      summary: (m) => env.GITHUB_STEP_SUMMARY && fs.appendFileSync(env.GITHUB_STEP_SUMMARY, m),
    });
  } catch (e) {
    finished = true;
    await failRun(db, e);
    throw e;
  }
  finished = true;
  // Red only now, after everything found was saved: GitHub then notifies "workflow run failed".
  if (out.health === 'failed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  });
}
