#!/usr/bin/env node
/*
 * The nightly Winner Hunter run.
 *   META_TOKEN=… CF_API_TOKEN=… CF_ACCOUNT_ID=… [MINUTES=300] [KEYWORDS="dog | cat"] node winner-hunter/run.mjs
 *
 * Goes through keywords.txt in batches of 2, starting where the last run stopped (D1 state 'keyword_cursor').
 * keywords-optin.txt (clothing, beauty, pain, sale angles) joins them only with KEYWORDS_OPTIN=1.
 * After every batch the ads that pass every rule (lib/score.mjs: Shopify, 75+ active ads, 7–42 days live, 500+ EU
 * reach a day) are saved in D1 and the cursor moves on, so a run
 * that is stopped loses at most one batch. Stops at the time budget or when Meta blocks every token (613).
 * A batch whose stores did not answer (possible winners left unknown) is searched again next run, once.
 * Saved winners seen again that now fail a rule get their new facts (update only), so the board drops them.
 * A D1 or store failure is a warning, never a crash. Typed-in KEYWORDS leave the cursor alone.
 *
 * Alerts: at the start every Meta token's expiry date is checked (debug_token). At the end a health check gives
 * the run a status (ok / warning / failed), saved in D1 (runs.status, last_run.health) for the board. A failed run
 * ends red (exit code 1), only after everything found has been saved, so GitHub sends its "run failed" notification.
 * Meta searches or counts that failed make it yellow; red when not one competitor could be counted.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hunt, pool, checkTokens, metaTokens, tokenState, TOKEN_SECRETS } from './lib/meta.mjs';
import { d1Client, d1Settings, chunks } from './lib/d1.mjs';
import { slimRecord } from './lib/record.mjs';
import { parseKeywords, wrap } from './lib/keywords.mjs';
import { photoCache } from './lib/storephoto.mjs';
import { passesRules } from './lib/score.mjs';

const DAY = 864e5;
const WARN_DAYS = 7; // a Meta token that expires within this many days makes the run red
const n0 = (n) => Number(n || 0).toLocaleString('en-US');

// A saved winner seen again that now fails a rule: what is true now replaces what was saved, so the board (which checks
// active ads, age and reach on the row) stops showing a pass. UPDATE only: an ad that fails is never added. A fact the
// re-check did not get (an advertiser not counted again) keeps its saved value, and without a new age last_seen stays,
// so the board's own ageing goes on. Older data never overwrites newer (as UPSERT_SQL in lib/d1.mjs).
export const RECHECK_SQL = `UPDATE winners SET verdict = json_extract(x.value, '$.verdict'), score = json_extract(x.value, '$.score'),
  active_ads = COALESCE(json_extract(x.value, '$.active_ads'), winners.active_ads),
  ad_age_days = COALESCE(json_extract(x.value, '$.ad_age_days'), winners.ad_age_days),
  reach_eu = COALESCE(json_extract(x.value, '$.reach_eu'), winners.reach_eu),
  last_seen = CASE WHEN json_extract(x.value, '$.ad_age_days') IS NULL THEN winners.last_seen ELSE ?2 END,
  data = CASE WHEN json_valid(winners.data) THEN json_patch(winners.data, x.value) ELSE winners.data END
FROM json_each(?1) AS x WHERE winners.ad_id = json_extract(x.value, '$.id') AND ?2 >= COALESCE(winners.last_seen, '')
RETURNING winners.ad_id`;

/** The facts of a re-check (slimRecord shape) that are known: { id, verdict, score, checklist, active_ads?, ad_age_days?, reach_eu? }. */
export function recheckFacts(r) {
  const f = { id: r.id, verdict: r.verdict, score: r.score, checklist: r.checklist };
  for (const k of ['ad_age_days', 'reach_eu']) if (r[k] != null) f[k] = r[k];
  if (r.active_ads != null) Object.assign(f, { active_ads: r.active_ads, active_ads_capped: r.active_ads_capped });
  return f;
}

/** The keywords of a run: keywords.txt, and keywords-optin.txt too when KEYWORDS_OPTIN is 1 (or yes / true / on). */
export function keywordsOf(env = process.env, read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')) {
  const optin = /^(1|yes|true|on)$/i.test(String(env.KEYWORDS_OPTIN || '').trim());
  return [...parseKeywords(read('./keywords.txt')), ...(optin ? parseKeywords(read('./keywords-optin.txt')) : [])];
}

/**
 * cfg:  { tokens, secrets (their GitHub secret names, default META_TOKEN, _2, _3), countries, minutes, keywords (all, in order),
 *         override (typed-in keywords or null), batchSize, minBatchMinutes, maxPerKeyword }
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
  // held: the last run kept the cursor here because stores did not answer (it is held once, then the hunt moves on).
  let start = 0;
  let held = 0;
  if (!typed) {
    const raw = await safe('Could not read the keyword cursor from D1', () => db.getState('keyword_cursor'));
    let next = null;
    try {
      const j = raw == null ? null : JSON.parse(raw);
      next = j == null ? null : Number(j.next);
      held = Number(j && j.held) || 0;
    } catch (e) {
      next = null;
    }
    start = wrap(Number.isFinite(next) ? next : Math.floor(started / DAY) * 20, n);
  }
  const list = typed || Array.from({ length: n }, (_, i) => all[(start + i) % n]);
  if (!list.length) throw new Error('No keywords');

  const t = { id: startIso, batches: 0, ads: 0, found: 0, saved: 0, saveFailed: 0, newWinners: 0, rechecked: 0, usagePeak: 0, cursor: typed ? null : start, stopped: 'done', error: '',
    blockedFirst: false, searchFails: 0, countFails: 0, counted: 0, unsure: 0, restricted: 0, health: null, problems, alert: '' };
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
  const secrets = c.secrets || TOKEN_SECRETS;
  const secret = (k) => secrets[k - 1] || `META_TOKEN_${k}`;
  const checked = await Promise.resolve().then(() => tokenCheck(c.tokens)).catch((e) => [{ n: 0, error: e.message }]);
  for (const k of checked || []) {
    if (k.error) {
      warn(`Could not check when Meta token ${k.n || ''} expires (${k.error})`);
    } else if (!k.valid) {
      problems.push([`Meta token ${secret(k.n)} ongeldig of verlopen`, `Meta token ${secret(k.n)} invalid or expired`]);
      log(`::error::Meta token ${secret(k.n)} is ongeldig of verlopen: maak een nieuwe en zet hem in het GitHub secret / Meta token ${secret(k.n)} is invalid or expired: make a new one and update the GitHub secret`);
    } else if (k.expiresAt) {
      const days = Math.max(0, Math.floor((k.expiresAt - started) / DAY));
      if (k.expiresAt - started < WARN_DAYS * DAY) {
        const on = new Date(k.expiresAt).toISOString().slice(0, 10);
        problems.push([`Meta token ${secret(k.n)} verloopt over ${days} dagen`, `Meta token ${secret(k.n)} expires in ${days} days`]);
        log(`::error::Meta token ${secret(k.n)} verloopt over ${days} dagen (${on}): maak nu een nieuwe en zet hem in het GitHub secret / Meta token ${secret(k.n)} expires in ${days} days (${on}): make a new one now and update the GitHub secret`);
      }
    }
  }
  // Per token, merged with what is saved (lib/meta.mjs tokenState): the world run checks META_TOKEN too, and a token
  // whose check failed keeps its last answer. This run knows every token that is set: answers for others go.
  if ((checked || []).some((k) => !k.error)) {
    const mine = c.tokens.map((_, i) => secret(i + 1));
    await safe('Could not save token_expires_at in D1', async () => db.setState('token_expires_at', tokenState(await db.getState('token_expires_at').catch(() => null),
      checked.filter((k) => !k.error).map((k) => ({ ...k, secret: secret(k.n) })), { now: started, drop: (s) => !mine.includes(s) }), new Date(now())));
  }

  log(`Winner Hunter: ${typed ? `typed keywords (${typed.length})` : `keywords from #${start} of ${n}`}, ${c.countries.join(',')}, ${Math.round((end - started) / 60000)} min`);
  summary(`## Winner Hunter ${startIso.slice(0, 16).replace('T', ' ')} UTC\n`);
  await progress(false);

  let tokenStart = 0;
  let hold = false; // the cursor stays at a batch whose stores did not answer (the batches after it are searched again too)
  const cache = {}; // competitor counts, shared by the batches of this run
  for (let i = 0; i < list.length; i += c.batchSize) {
    if (end - now() < c.minBatchMinutes * 60000) {
      t.stopped = 'time';
      break;
    }
    const q = list.slice(i, i + c.batchSize);
    let res;
    try {
      // clock: the deadline is on this run's clock, so the hunt measures it on the same one
      res = await search({ tokens: c.tokens, tokenStart, queries: q, countries: c.countries, max: c.maxPerKeyword, deadline: end, cache }, { log, clock: now });
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
    t.searchFails += s.searchFails || 0;
    t.countFails += s.countFails || 0;
    t.counted += s.counted || 0;
    t.restricted += s.restricted || 0;

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
    // Saved winners seen again that now fail a rule: their new facts, update only (RECHECK_SQL).
    const fails = (res.rechecks || []).map((r) => recheckFacts(slimRecord(r))).filter((r) => r.id);
    if (fails.length && db) {
      const when = new Date(now()).toISOString();
      t.rechecked += await safe('Could not update re-checked winners in D1', async () => {
        let k = 0;
        for (const part of chunks(fails, 1000)) k += (await db.query(RECHECK_SQL, [JSON.stringify(part), when])).length;
        return k;
      }, 0);
    }
    // Failed Meta searches and counts: winners may be missing, so the run says so (yellow; red at the end when no count worked).
    if (s.searchFails || s.countFails) warn(`Batch "${q.join(', ')}": ${s.searchFails || 0} Meta search(es) and ${s.countFails || 0} competitor count(s) failed (skipped)`);

    // A finished batch moves the cursor; one cut short (Meta block, time) is searched again next run. So is one whose
    // stores did not answer (possible winners left unknown), but only once: a store that never answers must not hold the hunt.
    const cutShort = s.blocked || s.stoppedEarly;
    if (s.unsure) {
      t.unsure += s.unsure;
      if (typed || cutShort || hold) {
        // typed-in keywords keep no cursor; cut short or already held: searched again next run anyway
      } else if (i === 0 && held) {
        warn(`Batch "${q.join(', ')}": ${s.unsure} possible winner(s) at stores that still did not answer: moving on`);
      } else {
        hold = true;
        t.cursor = wrap(start + i, n);
        await safe('Could not save the keyword cursor in D1', () => db.setState('keyword_cursor', { next: t.cursor, held: 1 }, new Date(now())));
        warn(`Batch "${q.join(', ')}": ${s.storesUnknown || 0} store(s) did not answer (${s.unsure} possible winner(s)): searched again next run`);
      }
    }
    if (!typed && !cutShort && !hold) {
      t.cursor = wrap(start + i + q.length, n);
      await safe('Could not save the keyword cursor in D1', () => db.setState('keyword_cursor', { next: t.cursor }, new Date(now())));
    }
    t.newWinners = await safe('Could not count new winners', () => db.newWinnersSince(startIso), t.newWinners);
    await progress(false);

    const line = `Batch ${t.batches} · ${q.join(', ')} · ${n0(s.ads)} ads · ${recs.length} saved · Meta ${s.usagePeak ?? 0}%${t.cursor != null ? ` · next #${t.cursor}/${n}` : ''}${s.blocked ? ' · Meta blocked' : ''}`
      + `${s.skipped ? ` · ${s.skipped} skipped (Meta errors)` : ''}${s.storesUnknown ? ` · ${s.storesUnknown} stores did not answer` : ''}`;
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
  // Without a count no ad can pass the 75+ rule: 0 winners would look like a quiet night.
  if (t.countFails && !t.counted) problems.push([`geen enkele concurrent geteld (${t.countFails} Meta-fouten)`, `no competitor could be counted (${t.countFails} Meta errors)`]);
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
  const final = `Done (${t.stopped}) · ${t.batches} batches · ${n0(t.ads)} ads checked · ${t.saved} saved · ${t.newWinners} new winners · Meta peak ${t.usagePeak}%`
    + `${t.rechecked ? ` · ${t.rechecked} saved winner(s) fail now (updated)` : ''}${t.restricted ? ` · ${t.restricted} ads off the EU board (category)` : ''} · ${t.health}`;
  log(final);
  summary(`\n**${final}**\n${t.health === 'ok' ? '' : `\n${t.alert}\n`}`);
  return t;
}

async function main() {
  const env = process.env;
  const set = metaTokens(env); // whitespace already out; each keeps its secret's name (META_TOKEN_3 without _2 is still _3)
  if (!set.length) throw new Error('No META_TOKEN: add it as a GitHub secret (see winner-hunter/README.md)');
  const s = d1Settings(env);
  if (!s) throw new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)');
  const keywords = keywordsOf(env);
  const override = String(env.KEYWORDS || '').split('|').map((k) => k.trim()).filter(Boolean);
  const out = await run({
    tokens: set.map((k) => k.token),
    secrets: set.map((k) => k.secret),
    keywords,
    override,
    minutes: Number(env.MINUTES || 300),
    countries: String(env.COUNTRIES || 'NL,BE,DE,FR,AT,ES,IT,IE,DK,SE,PL').toUpperCase().split(',').map((x) => x.trim()).filter(Boolean),
  }, {
    db: d1Client(s),
    photo: photoCache(),
    summary: (m) => env.GITHUB_STEP_SUMMARY && fs.appendFileSync(env.GITHUB_STEP_SUMMARY, m),
  });
  // Red only now, after everything found was saved: GitHub then notifies "workflow run failed".
  if (out.health === 'failed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  });
}
