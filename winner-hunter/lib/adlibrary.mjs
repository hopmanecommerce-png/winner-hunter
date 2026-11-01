/*
 * Opens the public Ad Library in a browser, logged out. Facebook answers a plain request with 403 and a bot check that
 * a real browser passes by itself, and only then renders the page with the first ~30 ads in it. Loading more needs a
 * second request that a logged-out visitor is refused ("Rate limit exceeded", tested 2026-10-31): so one search gives
 * the first page and many searches give the depth.
 *   const lib = await openLibrary({ launch });  await lib.search({ cc: 'AU', q: 'dog harness' });  await lib.close();
 *   → { ads: raw ads, count (null: not loaded), blocked }
 */
import { libraryUrl, readLibrary } from './world.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

// In the browser: the page's JSON blocks that hold search results (the others are big and useless here).
const blocksInPage = () => [...document.querySelectorAll('script[type="application/json"]')]
  .map((s) => s.textContent).filter((t) => t.includes('search_results_connection') || t.includes('ad_archive_id'));

export async function openLibrary({ launch, timeout = 45000, settle = 12000 }) {
  let browser = await launch();
  return {
    async search(what) {
      let ctx = null;
      try {
        // A browser can die during a long run: start a new one instead of losing the night.
        if (!browser.isConnected()) browser = await launch();
        ctx = await browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1280, height: 900 } }); // no cookies from the search before
        await ctx.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
        const page = await ctx.newPage();
        await page.goto(libraryUrl(what), { waitUntil: 'domcontentloaded', timeout });
        // The first answer is the bot check; the page then reloads itself and the results arrive with the new page.
        // A reload ends whatever runs in the page, so this asks again until the results are there.
        const end = Date.now() + settle;
        let got = { ads: [], count: null };
        for (;;) {
          got = readLibrary(await page.evaluate(blocksInPage).catch(() => []));
          if (got.count != null || Date.now() > end) break;
          await page.waitForTimeout(400);
        }
        // After a few hundred searches from one address Facebook still says how many ads match but sends none
        // (tested 2026-10-31: count 22,425, no ads). That is a refusal, not "nothing found". A shop's count stays usable.
        const thin = !what.pageId && got.count > 0 && !got.ads.length;
        return { ...got, blocked: got.count == null || thin };
      } catch (e) {
        return { ads: [], count: null, blocked: true, error: e.message };
      } finally {
        if (ctx) await ctx.close().catch(() => {});
      }
    },
    close: () => browser.close().catch(() => {}),
  };
}
