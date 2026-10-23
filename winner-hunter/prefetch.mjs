#!/usr/bin/env node
/*
 * Opens every ad on the board ahead of time: Meta's render_ad page in Chrome on the GitHub runner, read out with the
 * board's own extractor, stored in D1 (ad_views). "▶ Bekijk ad" then shows it at once instead of after 8–16 seconds
 * in Browser Run. Only ads that pass the rules, are not hidden and have no ad view younger than 16 hours.
 *   META_TOKEN=… CF_API_TOKEN=… CF_ACCOUNT_ID=… [D1_DATABASE_ID=…] node winner-hunter/prefetch.mjs
 */
import { pathToFileURL } from 'node:url';
import { d1Client, d1Settings } from './lib/d1.mjs';
import { PREFETCH_SQL } from './worker/src/app.mjs';
import { renderAdUrl, waitReady, SKIP_TYPES, extractAd, cleanAd, scrub } from './worker/src/adview.mjs';

const STALE_HOURS = 16; // the board serves a stored ad for 24 hours; this runs every 8 hours
const UPSERT = 'INSERT INTO ad_views (ad_id, json, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(ad_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at';

/** Opens and stores the ads that need it. `open(url)` returns what extractAd() read from the page. */
export async function prefetch({ db, token, open, now = Date.now(), limit = 500, workers = 4, log = console.log }) {
  const rows = await db.query(PREFETCH_SQL, [new Date(now).toISOString(), new Date(now - STALE_HOURS * 3600e3).toISOString(), limit]);
  const ids = rows.map((r) => String(r.ad_id));
  let next = 0;
  let ok = 0;
  let failed = 0;
  let shown = false;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      let raw = null;
      try {
        raw = await open(renderAdUrl(id, token));
        const ad = cleanAd(raw, id, now);
        await db.query(UPSERT, [id, JSON.stringify(ad), ad.fetched_at]);
        ok++;
      } catch (e) {
        failed++;
        log(`  ${id}: ${scrub(e && e.message, token).slice(0, 160)}`);
        if (!shown && raw && raw.page) { // what the page showed instead of an ad (first failure only)
          shown = true;
          log('    page: ' + scrub(JSON.stringify(raw.page), token).slice(0, 600));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(workers, ids.length) }, worker));
  return { todo: ids.length, ok, failed };
}

async function main() {
  const token = String(process.env.META_TOKEN || '').replace(/\s+/g, '');
  const s = d1Settings();
  if (!token || !s) {
    console.log('::error::Missing META_TOKEN, CF_API_TOKEN or CF_ACCOUNT_ID');
    process.exit(1);
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome' });
  const ctx = await browser.newContext({ viewport: { width: 500, height: 1000 } });
  await ctx.route('**/*', (r) => (SKIP_TYPES.has(r.request().resourceType()) ? r.abort() : r.continue()));
  const open = async (url) => {
    const page = await ctx.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((e) => {
        if (!/timeout/i.test(String(e && e.message))) throw e;
      });
      await waitReady(page, 10000);
      const raw = await page.evaluate(extractAd);
      raw.page = await page.evaluate(() => ({ title: document.title, path: location.hostname + location.pathname, text: (document.body ? document.body.innerText : '').slice(0, 300) }));
      return raw;
    } finally {
      await page.close().catch(() => {});
    }
  };
  const t0 = Date.now();
  try {
    const r = await prefetch({ db: d1Client(s), token, open });
    console.log(`Ad views ready: ${r.ok} of ${r.todo} stored, ${r.failed} failed, ${Math.round((Date.now() - t0) / 1000)} s`);
    if (r.todo && !r.ok) {
      console.log('::error::No ad could be opened (Meta token? render_ad changed?)');
      process.exitCode = 1;
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log('::error::' + scrub(e && e.message, String(process.env.META_TOKEN || '').replace(/\s+/g, '')));
    process.exit(1);
  });
}
