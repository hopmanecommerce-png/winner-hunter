#!/usr/bin/env node
/*
 * Collects public posts and comments where people complain or ask for a fix, for the Problem Database
 * (docs/problem-db/README.md). It searches with the query bank (problem-queries.json) through the Scrape Creators API,
 * opens the comments of the most-discussed results, keeps what states a problem and writes it to D1
 * (problem_mentions). problems-process.mjs groups them into problems afterwards.
 *   SCRAPECREATORS_API_KEY=… PROBLEM_MAX_CREDITS=100 CF_API_TOKEN=… CF_ACCOUNT_ID=… node winner-hunter/problems-collect.mjs
 * Spending is capped: PROBLEM_MAX_CREDITS is required, at most 5000. Every request counts against it, retries too, and
 * the request that would pass it is never sent (1 request costs at most 1 credit on the endpoints used).
 * PROBLEM_MONTHLY_CREDITS (optional) caps a calendar month as well. PROBLEM_DRY_RUN=1: no API call and nothing written,
 * it only shows what the next run would search and what it would cost.
 * Resumable: each platform has its own place in its plan (state 'problem_cursor'), saved after every search, so a stop
 * loses at most one search, and the next run goes on from there. Dedupe: a post or comment is one row (its platform id);
 * comments of a post are fetched again only after PROBLEM_COMMENT_DAYS (30).
 * Other settings: PROBLEM_PLATFORMS (reddit,youtube,tiktok; also threads, twitter, bluesky), PROBLEM_MINUTES (25),
 * PROBLEM_COMMENT_POSTS (2: results whose comments are read per search), PROBLEM_TIMEFRAME (year: Reddit),
 * PROBLEM_SKIP_AREAS (e.g. back_neck_pain,sleep: health complaints stay out), PROBLEM_MAX_FREE_CALLS (60: Bluesky).
 * The log holds counts only, never a quote or a name: this repository's Actions logs are public.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { d1Client, d1Settings } from './lib/d1.mjs';
import { interleave, loadBank, planFor } from './lib/problem-bank.mjs';
import { commentsFetchedSince, markComments, saveMentions } from './lib/problem-db.mjs';
import { DEFAULT_PLATFORMS, DEFAULT_WEIGHTS, MAX_RUN_CREDITS, PLATFORMS, SOURCES, StopRun, scrapeCreators } from './lib/problem-sources.mjs';
import { authorHash, makeMatcher, relevantOf } from './lib/problem-text.mjs';

const DAY = 864e5;
const COMMENTS_KEPT = 30; // per post: the comments that state a problem, most liked first
export const DEFAULT_MINUTES = 25;

const intOr = (x, or, min, max) => {
  const n = Math.floor(Number(x));
  return x == null || x === '' || !Number.isFinite(n) ? or : Math.min(max, Math.max(min, n));
};
const yes = (x) => /^(1|true|yes)$/i.test(String(x || '').trim());

/** The run's settings, checked. Throws (red run) on a missing or bad credit cap: a run never spends without one. */
export function settingsOf(env = process.env) {
  const dryRun = yes(env.PROBLEM_DRY_RUN);
  const raw = String(env.PROBLEM_MAX_CREDITS ?? '').trim();
  const cap = Number(raw);
  if (!dryRun && (!/^\d+$/.test(raw) || cap < 1)) throw Object.assign(new Error('PROBLEM_MAX_CREDITS must be a whole number of at least 1 (the most credits this run may spend)'), { settings: true });
  const platforms = String(env.PROBLEM_PLATFORMS || DEFAULT_PLATFORMS.join(',')).split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  const unknown = platforms.filter((p) => !PLATFORMS.includes(p));
  if (unknown.length) throw Object.assign(new Error(`PROBLEM_PLATFORMS: unknown ${unknown.join(', ')} (known: ${PLATFORMS.join(', ')})`), { settings: true });
  return {
    dryRun,
    maxCredits: Math.min(MAX_RUN_CREDITS, Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 100),
    capped: Number.isFinite(cap) && cap > MAX_RUN_CREDITS,
    monthly: intOr(env.PROBLEM_MONTHLY_CREDITS, 0, 0, 1e7),
    platforms: [...new Set(platforms)],
    minutes: intOr(env.PROBLEM_MINUTES, DEFAULT_MINUTES, 1, 120),
    commentPosts: intOr(env.PROBLEM_COMMENT_POSTS, 2, 0, 10),
    commentDays: intOr(env.PROBLEM_COMMENT_DAYS, 30, 1, 365),
    timeframe: ['all', 'year', 'month', 'week', 'day'].includes(env.PROBLEM_TIMEFRAME) ? env.PROBLEM_TIMEFRAME : 'year',
    skipAreas: String(env.PROBLEM_SKIP_AREAS || '').split(',').map((s) => s.trim()).filter(Boolean),
    maxFree: intOr(env.PROBLEM_MAX_FREE_CALLS, 60, 0, 1000),
    key: String(env.SCRAPECREATORS_API_KEY || '').trim(),
  };
}

const monthOf = (now) => new Date(now).toISOString().slice(0, 7);

/**
 * One run. db: lib/d1.mjs client (getState, setState, query), or null in a dry run without D1. paid / free: clients
 * from scrapeCreators() (the run makes them from the settings when not given). Returns the summary, also saved in
 * state 'problem_run' (not in a dry run).
 */
export async function collect({ db = null, bank = loadBank(), settings, paid = null, free = null, now = () => Date.now(), log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), doFetch } = {}) {
  const s = settings;
  const t0 = now();
  const runId = new Date(t0).toISOString();
  const deadline = t0 + s.minutes * 60000;
  const match = makeMatcher(bank);
  const skip = new Set(s.skipAreas);
  const plans = {};
  for (const p of s.platforms) plans[p] = planFor(bank, p, SOURCES[p].modes).filter((it) => !skip.has(it.area));
  const cursor = (db && (await readJson(db, 'problem_cursor'))) || {};
  const ledger = (db && (await readJson(db, 'problem_credits'))) || {};
  const month = monthOf(t0);
  const usedThisMonth = ledger.month === month ? Number(ledger.used) || 0 : 0;
  let cap = s.maxCredits;
  if (s.monthly) cap = Math.max(0, Math.min(cap, s.monthly - usedThisMonth));
  const summary = {
    status: 'running', health: 'ok', alert: '', started_at: runId, finished_at: '', dry_run: s.dryRun, platforms: s.platforms, cap, cap_setting: s.maxCredits,
    monthly_cap: s.monthly || null, used_this_month: usedThisMonth, searches: 0, comment_pages: 0, credits_sent: 0, credits_charged: 0, credits_left: null, free_calls: 0,
    found: 0, kept: 0, saved: 0, dropped: 0, by_platform: {}, errors: {}, stopped: '', cursor: { ...cursor },
  };
  const per = (p) => (summary.by_platform[p] = summary.by_platform[p] || { searches: 0, found: 0, kept: 0 });
  const lengths = Object.fromEntries(Object.entries(plans).map(([p, l]) => [p, l.length]));
  const queue = interleave(lengths, DEFAULT_WEIGHTS, { ...cursor }); // a copy: the run moves `cursor` on as it goes

  if (s.dryRun) {
    // What the next run would search: per search 1 credit, plus the comment pages it would open.
    const perSearch = (p) => (SOURCES[p].free ? 0 : 1 + (SOURCES[p].comments({ url: 'https://x' }) ? s.commentPosts : 0));
    const next = [];
    let credits = 0;
    let freeCalls = 0;
    for (const { platform, index } of queue) {
      const c = perSearch(platform);
      if (SOURCES[platform].free ? freeCalls + 1 > s.maxFree : credits + c > cap) {
        if (Object.keys(plans).every((p) => SOURCES[p].free || credits + perSearch(p) > cap)) break;
        continue;
      }
      credits += c;
      if (SOURCES[platform].free) freeCalls++;
      next.push(plans[platform][index]);
      if (next.length > 5000) break;
    }
    const by = (k) => next.reduce((m, it) => ((m[it[k] || 'general'] = (m[it[k] || 'general'] || 0) + 1), m), {});
    Object.assign(summary, { status: 'dry run', planned: next.length, planned_credits: credits, planned_free_calls: freeCalls, plan_sizes: lengths,
      by_platform: by('platform'), by_area: by('area'), by_lang: by('lang'), first: next.slice(0, 15).map((it) => `${it.platform}: ${it.sub ? `r/${it.sub} ` : ''}${it.q}`) });
    log(`Dry run: the next run would make ${next.length} searches for at most ${credits} credits (+${freeCalls} free Bluesky calls). Plan sizes: ${JSON.stringify(lengths)}`);
    for (const line of summary.first) log(`  ${line}`);
    summary.finished_at = new Date(now()).toISOString();
    return summary;
  }

  if (!s.key && s.platforms.some((p) => !SOURCES[p].free)) throw Object.assign(new Error('No SCRAPECREATORS_API_KEY: add it as a GitHub secret (docs/problem-db/README.md), or run with dry_run'), { settings: true });
  paid = paid || scrapeCreators({ key: s.key, maxCredits: cap, doFetch, sleep, log: (m) => log(`  ${m}`) });
  free = free || scrapeCreators({ key: '', base: SOURCES.bluesky.base, maxCredits: s.maxFree, doFetch, sleep, log: (m) => log(`  ${m}`) });
  await db.setState('problem_run', summary, t0);
  const stopFree = new Set();
  let parsedNothing = 0;

  const call = async (platform, req) => {
    const c = SOURCES[platform].free ? free : paid;
    return c.get(req.path, req.params);
  };
  // The author's name is hashed here and goes no further: no row, log or summary holds it.
  const keep = ({ author, ...m }, item) => ({
    ...m, area: item.area || '', query: item.q.slice(0, 200), lang: item.lang || m.lang_hint || '', author_hash: authorHash(m.platform, author),
  });
  let answered = 0;

  try {
    for (const { platform, index } of queue) {
      if (now() > deadline) { summary.stopped = `time (${s.minutes} min)`; break; }
      const src = SOURCES[platform];
      if (stopFree.has(platform)) continue;
      const item = plans[platform][index];
      let j;
      try {
        j = await call(platform, src.search(item, { timeframe: s.timeframe }));
      } catch (e) {
        if (e instanceof StopRun && src.free) { stopFree.add(platform); continue; } // free calls used up: the paid platforms go on
        throw e;
      }
      summary.searches++;
      per(platform).searches++;
      cursor[platform] = (index + 1) % plans[platform].length;
      if (!j) { await saveCursor(db, cursor, now()); continue; }
      answered++;
      const { items, dropped } = src.parseSearch(j, item);
      summary.dropped += dropped;
      summary.found += items.length;
      per(platform).found += items.length;
      if (!items.length) parsedNothing++;
      const kept = [];
      const relevant = (m) => relevantOf(match(m.kind === 'comment' ? m.body : `${m.title}\n${m.body}`), m.kind);
      for (const m of items) if (relevant(m)) kept.push(keep(m, item));
      // The comments of the most-discussed results, unless read in the last PROBLEM_COMMENT_DAYS days.
      const posts = items.filter((m) => m.kind === 'post' && src.comments(m)).sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1)).slice(0, s.commentPosts);
      const fresh = posts.length ? await commentsFetchedSince(db, posts.map((p) => p.id), new Date(now() - s.commentDays * DAY).toISOString()) : new Set();
      const opened = [];
      let stop = null; // the cap reached while reading comments: what this search found is saved first
      for (const post of posts.filter((p) => !fresh.has(p.id))) {
        if (now() > deadline) break;
        let cj;
        try {
          cj = await call(platform, src.comments(post));
        } catch (e) {
          if (!(e instanceof StopRun)) throw e;
          stop = e;
          break;
        }
        summary.comment_pages++;
        if (!cj) continue;
        opened.push(post);
        const got = src.parseComments(cj, post);
        summary.dropped += got.dropped;
        summary.found += got.items.length;
        per(platform).found += got.items.length;
        const good = got.items.filter(relevant).sort((a, b) => (b.score || 0) - (a.score || 0) || (a.id < b.id ? -1 : 1)).slice(0, COMMENTS_KEPT);
        for (const c of good) kept.push(keep(c, item));
        if (!kept.some((k) => k.id === post.id)) kept.push(keep(post, item)); // its row holds when its comments were read
      }
      const unique = [...new Map(kept.map((k) => [k.id, k])).values()];
      if (unique.length) summary.saved += await saveMentions(db, unique, { now: now(), runId });
      if (opened.length) await markComments(db, opened.map((p) => p.id), now());
      summary.kept += unique.length;
      per(platform).kept += unique.length;
      await saveCursor(db, cursor, now());
      if (stop) throw stop;
      await sleep(250);
    }
    if (!summary.stopped) summary.stopped = 'plan done';
  } catch (e) {
    if (!(e instanceof StopRun)) {
      summary.health = 'failed';
      summary.alert = /Cloudflare D1/.test(e.message) ? `Could not save to D1: ${e.message.slice(0, 160)}` : `Problem collection crashed: ${e.message.slice(0, 160)}`;
    } else {
      summary.stopped = e.reason === 'cap' ? `credit cap (${cap})` : e.message;
      if (e.reason === 'bad_key' || e.reason === 'no_credits') { summary.health = 'failed'; summary.alert = e.message; }
    }
  }
  const p = paid.stats();
  const f = free.stats();
  Object.assign(summary, { credits_sent: p.sent, credits_charged: p.charged, credits_left: p.remaining, free_calls: f.sent, errors: { ...p.errors, ...Object.fromEntries(Object.entries(f.errors).map(([k, v]) => [`bluesky ${k}`, v])) }, cursor });
  if (summary.health === 'ok') {
    if (answered >= 5 && parsedNothing === answered) {
      summary.health = 'failed';
      summary.alert = `${answered} searches answered, not one item read: the API's answers may have changed (lib/problem-sources.mjs)`;
    } else if (Object.keys(summary.errors).length || summary.dropped > Math.max(10, summary.found * 0.3)) {
      summary.health = 'warning';
      summary.alert = `Errors: ${JSON.stringify(summary.errors)}; ${summary.dropped} items dropped (no id, text or link)`;
    }
  }
  summary.status = 'done';
  summary.finished_at = new Date(now()).toISOString();
  // The month's spending: what was sent counts (an upper bound on credits).
  const used = usedThisMonth + p.sent;
  try {
    await db.setState('problem_credits', { month, used }, now());
    await db.setState('problem_run', summary, now());
  } catch (e) {
    summary.health = 'failed';
    summary.alert = `Could not save the run to D1: ${e.message.slice(0, 160)}`;
  }
  log(`Problem collection: ${summary.searches} searches, ${summary.comment_pages} comment pages, ${p.sent} of ${cap} credits sent (${p.charged} charged${p.remaining != null ? `, ${p.remaining} left` : ''}), ${f.sent} free calls; `
    + `${summary.found} found, ${summary.kept} kept, ${summary.dropped} dropped. Stopped: ${summary.stopped}. ${JSON.stringify(summary.by_platform)}`);
  return summary;
}

async function readJson(db, key) {
  const v = await db.getState(key);
  try {
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}
const saveCursor = (db, cursor, at) => db.setState('problem_cursor', cursor, at);

export async function main({ env = process.env, log = console.log } = {}) {
  const settings = settingsOf(env);
  if (settings.capped) log(`::warning::PROBLEM_MAX_CREDITS is above ${MAX_RUN_CREDITS}: this run spends at most ${MAX_RUN_CREDITS}`);
  const d1 = d1Settings(env);
  if (!d1 && !settings.dryRun) throw Object.assign(new Error('No CF_API_TOKEN / CF_ACCOUNT_ID: add them as GitHub secrets (see winner-hunter/README.md)'), { settings: true });
  const summary = await collect({ db: d1 ? d1Client(d1) : null, settings, log });
  if (summary.health === 'failed') log(`::error::${summary.alert}`);
  else if (summary.health === 'warning') log(`::warning::${summary.alert}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = summary.dry_run
      ? [`## Problem Hunter (dry run)`, `Next run: ${summary.planned} searches, at most ${summary.planned_credits} credits.`, '', ...summary.first.map((x) => `- ${x}`)]
      : [`## Problem Hunter`, `${summary.searches} searches, ${summary.credits_sent} of ${summary.cap} credits sent, ${summary.kept} posts and comments kept. Stopped: ${summary.stopped}.`];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  if (summary.health === 'failed') process.exitCode = 1;
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  });
}
