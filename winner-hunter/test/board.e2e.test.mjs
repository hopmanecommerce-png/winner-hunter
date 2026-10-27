// The board in a real browser (Chromium via Playwright) at iPhone size, against the Worker handler served
// locally on an in-memory D1. Skipped when Playwright or Chromium is not available.
//   SHOTS=/some/dir node --test test/board.e2e.test.mjs    (screenshots saved there)
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { handle } from '../worker/src/app.mjs';
import { extractAd, isReady, waitReady } from '../worker/src/adview.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';

let chromium = null;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch (e) {
  // no Playwright: skipped
}
const HTML = fs.readFileSync(new URL('../worker/src/board.html', import.meta.url), 'utf8');
const SHOTS = process.env.SHOTS || '';
const COLORS = ['#e9b8a6', '#a6c8e9', '#b8e9a6', '#e9e0a6', '#d2a6e9', '#a6e9de'];

// Every photo on screen has loaded (lazy photos further down are not asked yet).
const imagesInView = () => [...document.images].filter((i) => i.getBoundingClientRect().top < innerHeight).every((i) => i.complete && i.naturalWidth > 0);

function serve(env, launch = null) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body });
    const out = await handle(request, env, { html: HTML, now: NOW, launch });
    const headers = {};
    out.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(out.status, headers);
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

// The ad viewer's browser, faked: a video ad for even ids, a carousel for odd ones (what extractAd returns).
const LONG = Array.from({ length: 12 }, (_, i) => `Regel ${i + 1} van de advertentietekst.`).join('\n');
function fakeViewer() {
  return async () => {
    let id = '';
    return {
      newPage: async () => ({
        goto: async (url) => { id = new URL(url).searchParams.get('id'); },
        waitForFunction: async () => {},
        evaluate: async () => (Number(id) % 2 === 0
          ? { name: 'Shop ' + id, avatar: 'https://scontent.xx.fbcdn.net/p5.jpg', library_id: id, body: LONG, cards: [], low_impressions: true,
            media: [{ type: 'video', src: 'https://video.xx.fbcdn.net/ad.mp4', poster: 'https://scontent.xx.fbcdn.net/p3.jpg' }],
            link: { caption: 'MARIJKEDENBOSCH.NL', title: 'Eindigt vanavond 23:59!', description: 'Gratis verzending', cta: 'Shop now', href: 'https://l.facebook.com/l.php?u=' + encodeURIComponent('https://marijkedenbosch.nl/products/jurk') } }
          : { name: 'Shop ' + id, library_id: id, body: 'Kies je kleur 👇', media: [], link: null,
            cards: [1, 2, 3].map((n) => ({ media: { type: 'image', src: `https://scontent.xx.fbcdn.net/p${n}.jpg` }, title: 'Kleur ' + n, cta: 'Shop now', href: 'https://shop.test/products/k' + n })) }),
      }),
      close: async () => {},
    };
  };
}

async function launch() {
  try {
    return await chromium.launch();
  } catch (e) {
    return chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => null);
  }
}

test('board on an iPhone: PIN, All, open a card, mark seen, filters; no sideways scroll, no console errors', { skip: !chromium && 'Playwright not installed', timeout: 60000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const env = Object.assign(await seededEnv(), { META_TOKEN: 'tok', BROWSER: {} });
  const server = await serve(env, fakeViewer());
  const base = `http://localhost:${server.address().port}`;
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => (errors.push('dialog: ' + d.message()), d.dismiss()));
  // Store photos come from the stores' CDNs: answer them with a colored square here.
  await ctx.route(/^https:\/\//, (route) => {
    const n = Number((route.request().url().match(/p(\d+)\.jpg/) || [0, 0])[1]);
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="${COLORS[n % COLORS.length]}"/><circle cx="200" cy="200" r="${90 + (n % 4) * 15}" fill="#fff" fill-opacity=".55"/></svg>` });
  });
  const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
  const noSideScroll = async (where) => {
    const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(sw <= cw, `${where}: page is ${sw}px wide in a ${cw}px screen`);
  };
  try {
    await page.goto(base + '/');
    await noSideScroll('PIN screen');
    await shot('1-pin');
    await page.fill('input[name=pin]', '000000');
    await page.click('button[type=submit]');
    assert.match(await page.textContent('.err'), /Wrong PIN/);
    // the wrong PIN answer is a 401 on purpose (Chromium logs that as a console error)
    assert.deepStrictEqual(errors.splice(0), ['Failed to load resource: the server responded with a status of 401 (Unauthorized)']);
    await page.fill('input[name=pin]', '482913');
    await Promise.all([page.waitForURL(base + '/'), page.click('button[type=submit]')]);
    await page.waitForSelector('.card');
    assert.strictEqual(await page.locator('[data-view]').count(), 5, 'Inbox, Browse, ★, ✓ Made ad and 🧠 (no Top 20)');
    assert.strictEqual(await page.getAttribute('[data-view=inbox]', 'aria-pressed'), 'true', 'Inbox is the start view');
    assert.strictEqual(await page.locator('.card').count(), 1, 'one product at a time');
    assert.strictEqual(await page.locator('.card.open').count(), 1, 'with its details open');
    // the Inbox card: only the data (no photo) and one link, the ad in the Facebook Ad Library
    const ic = page.locator('.card');
    assert.strictEqual(await ic.locator('.ph, img, .acts, .star').count(), 0, 'no photo, star or buttons on the card');
    assert.match(await ic.locator('.meta').innerText(), /reach \/ day[\s\S]*shop ads[\s\S]*live[\s\S]*copies/i);
    assert.deepStrictEqual(await ic.locator('.links a').allInnerTexts(), ['Open in Facebook Ad Library ↗']);
    assert.match(await ic.locator('.links a').getAttribute('href'), /^https:\/\/www\.facebook\.com\/ads\/library\/\?id=/);
    assert.strictEqual(await page.textContent('#ileft'), '27 left');
    assert.strictEqual(await page.textContent('#nin'), '27');
    assert.ok(await page.locator('#tri').isVisible() && (await page.locator('#q').isHidden()) && (await page.locator('#radar').isHidden()));
    await page.waitForFunction(imagesInView);
    await noSideScroll('Inbox');
    await shot('2a-inbox');
    await page.click('[data-view=all]');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 27);
    assert.ok(await page.locator('#q').isVisible(), 'search right away in Browse');
    assert.strictEqual(await page.locator('.card').count(), 27);
    assert.strictEqual(await page.locator('.score').count(), 0, 'no score on the cards');
    assert.match(await page.locator('.card').first().locator('.meta').innerText(), /81[\s\S]*shop ads[\s\S]*41d[\s\S]*live[\s\S]*3[\s\S]*copies/i);
    assert.match(await page.locator('.card').first().locator('.hero').innerText(), /90K[\s\S]*reach \/ day/i);
    assert.match(await page.textContent('#run'), /Last run 6 h ago · 48K ads · 23 new winners/);
    // Market Radar: every seed product reaches NL 70% / BE 30%
    await page.waitForSelector('#radar:not([hidden]) .mk');
    await page.waitForFunction(() => document.querySelector('#topShare').textContent === '70%', null, { timeout: 5000 }); // counts up
    assert.match(await page.textContent('#rtop'), /#1 market\s*Netherlands\s*70% of all reach/);
    assert.strictEqual(await page.locator('#hexmap .hx[data-cc]').count(), 2, 'NL and BE light up on the map');
    assert.deepStrictEqual(await page.locator('.mk').evaluateAll((els) => els.map((e) => e.dataset.cc)), ['NL', 'BE']);
    assert.ok(await page.locator('#alert').isHidden(), 'healthy run: no banner');
    await page.waitForFunction(imagesInView);
    await noSideScroll('All');
    await shot('2-all');
    // no in-between: a tap on the card or on ▶ opens the ad in the Facebook Ad Library (even with the viewer on)
    assert.strictEqual(await page.locator('#sheet').count(), 0, 'no ad viewer sheet');
    const lib = (x) => `https://www.facebook.com/ads/library/?id=${x}`;
    const cid = await page.locator('.card').nth(1).getAttribute('data-id');
    let [tab] = await Promise.all([ctx.waitForEvent('page'), page.locator('.card .t').nth(1).click()]);
    await tab.waitForURL(lib(cid)); // card tap: the Ad Library
    await tab.close();
    assert.strictEqual(await page.locator('.card.open').count(), 0, 'the card does not open in the board');
    assert.strictEqual(page.url(), base + '/', 'the board stays');
    assert.strictEqual(await page.locator('.card .view').count(), 27, '▶ on every card');
    assert.strictEqual(await page.locator('.card button.view').count(), 0, '▶ is a plain link');
    const v = page.locator('.card[data-id="9000"] .view');
    assert.strictEqual(await v.getAttribute('href'), lib('9000'));
    assert.strictEqual(await v.getAttribute('target'), '_blank');
    [tab] = await Promise.all([ctx.waitForEvent('page'), v.click()]);
    await tab.waitForURL(lib('9000'));
    await tab.close();
    // the shop name links to the product (or the store), with a 1688 search next to it; no "Ad ↗" (the card is the ad)
    const c1 = page.locator('.card').nth(1);
    const sh = c1.locator('.who a.shop');
    assert.ok(await sh.isVisible() && (await c1.locator('.who a.src', { hasText: '1688 ↗' }).isVisible()));
    assert.match(await sh.getAttribute('href'), /^https:\/\/shop\d\.test/);
    assert.ok(await page.locator('.card .who a.shop[href*="/products/"]').count() > 0, 'a product page when there is one');
    assert.strictEqual(await page.locator('.card .links, .card .more').count(), 0, 'no link row or hidden details on the compact cards');
    assert.strictEqual(await page.locator('.card a', { hasText: 'Ad ↗' }).count(), 0);
    assert.strictEqual(await page.locator('.card .copy').count(), 0, 'no ad text on any card');
    await c1.scrollIntoViewIfNeeded();
    await noSideScroll('cards with links');
    await shot('3-card-links');
    await page.evaluate(() => scrollTo(0, 0));
    // ✓ Made ad: gone from the board to the ✓ tab, with an Undo
    const id = await page.locator('.card').first().getAttribute('data-id');
    assert.strictEqual(await page.locator('.card').first().locator('[data-act=seen]').innerText(), 'Made ad');
    await page.locator('.card').first().locator('[data-act=seen]').click();
    await page.waitForSelector('#toast:not([hidden])');
    assert.strictEqual(await page.textContent('#toastMsg'), 'Moved to ✓ Made ad');
    assert.strictEqual(await page.textContent('#nmade'), '1', 'the ✓ count follows');
    assert.strictEqual(env.db.prepare('SELECT status FROM hidden WHERE ad_id = ?').get(id).status, 'seen');
    const gone = (x) => { const c = document.querySelector(`.card[data-id="${x}"]`); return !c || c.classList.contains('gone'); };
    assert.ok(await page.evaluate(gone, id), 'gone from the board at once');
    // Undo before the toast's 5 s are up (on a busy machine the reload alone can take longer)
    await page.click('#undo');
    await page.waitForFunction((x) => { const c = document.querySelector(`.card[data-id="${x}"]`); return !!c && !c.classList.contains('gone'); }, id);
    await page.waitForFunction(() => document.querySelector('#nmade').textContent === '', null, { timeout: 3000 });
    // ★ star
    await page.locator('.card').nth(2).locator('[data-act=star]').click();
    await page.waitForFunction(() => document.querySelectorAll('.star[aria-pressed="true"]').length === 1);
    assert.strictEqual(await page.textContent('#nstar'), '1', 'the ★ count follows');
    // All, search and filters (always in view); the nasty title stays text
    await page.click('[data-f=r2500]');
    await page.waitForFunction(() => document.querySelector('[data-f=r2500]').getAttribute('aria-pressed') === 'true');
    await page.waitForTimeout(200);
    await noSideScroll('All + filters');
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('4-all-filters');
    await page.click('[data-f=r2500]');
    await page.fill('#q', 'onerror');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
    assert.match(await page.textContent('.card .t'), /<img src=x onerror=alert\(1\)>/);
    assert.strictEqual(await page.locator('.card .t img').count(), 0, 'no HTML from the data');
    assert.ok((await page.getAttribute('#csv', 'href')).startsWith('/export.csv?view=all&q=onerror'));
    await page.click('[data-view=starred]');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 1);
    assert.ok(await page.locator('#radar').isHidden(), 'no radar in ★');
    // one market: tap Belgium on the radar, the big number becomes the reach a day there; tap again for all
    await page.click('[data-view=all]');
    await page.fill('#q', '');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 27);
    await page.click('.mk[data-cc=BE]');
    await page.waitForFunction(() => !document.querySelector('#ccChip').hidden && document.querySelector('.hero span').textContent === 'BE reach / day');
    assert.strictEqual(await page.getAttribute('.mk[data-cc=BE]', 'aria-pressed'), 'true');
    assert.ok((await page.getAttribute('#csv', 'href')).includes('cc=BE'));
    assert.match(await page.textContent('#count'), /27 matches · by BE reach per day/);
    await noSideScroll('one market');
    await shot('4b-market');
    await page.click('#ccChip');
    await page.waitForFunction(() => document.querySelector('#ccChip').hidden && document.querySelector('.hero span').textContent === 'reach / day');
    // dark mode, desktop width
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.click('[data-view=all]');
    await page.fill('#q', '');
    await page.waitForFunction(() => document.querySelectorAll('.card').length === 27);
    await page.waitForFunction(imagesInView);
    await shot('5-all-dark');
    await page.setViewportSize({ width: 1280, height: 900 });
    await noSideScroll('desktop');
    await shot('6-desktop-dark');
    // Inbox: Made ad / Reject / Keep by button, key and swipe; Undo; Inbox zero at the end
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('[data-view=inbox]');
    await page.waitForSelector('#tri:not([hidden])');
    const left = async () => Number((await page.textContent('#ileft')).replace(/\D/g, ''));
    const n0 = await left();
    const first = await page.locator('.card').getAttribute('data-id');
    const made0 = Number(await page.textContent('#nmade')) || 0;
    await page.click('[data-tri=seen]');
    await page.waitForFunction((x) => document.querySelector('.card') && document.querySelector('.card').dataset.id !== x, first);
    assert.strictEqual(await left(), n0 - 1);
    assert.strictEqual(Number(await page.textContent('#nmade')), made0 + 1, 'Made ad: the ✓ count goes up');
    assert.ok(await page.$eval('#nmade', (el) => el.classList.contains('bump')), 'and jumps, so you see where it went');
    // Why? strip: the reasons for a yes; one tap saves it
    await page.waitForSelector('#why:not([hidden])');
    assert.match(await page.textContent('#why .wh'), /✓ Made ad/);
    assert.deepStrictEqual(await page.locator('#why [data-r]').allInnerTexts(), ['Wow product', 'Good margin', 'Strong ad', 'My niche', 'Easy to ship']);
    await page.click('#why [data-r=wow]');
    await page.waitForFunction(() => document.querySelector('#why [data-r=wow]').getAttribute('aria-pressed') === 'true');
    await page.waitForTimeout(200);
    assert.strictEqual(env.db.prepare('SELECT status FROM hidden WHERE ad_id = ?').get(first).status, 'seen');
    assert.strictEqual(env.db.prepare('SELECT reasons FROM feedback WHERE ad_id = ?').get(first).reasons, '["wow"]');
    await noSideScroll('Why strip');
    await shot('8a-why');
    const second = await page.locator('.card').getAttribute('data-id');
    // a note on the product, below the card (key N): saved as you type, it stays with the product
    assert.ok(await page.locator('#pnote').isVisible(), 'note box under the Inbox card');
    await page.keyboard.press('n');
    assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'pn');
    await page.keyboard.type('Te duur <b>voor</b> NL');
    await page.keyboard.press('r'); // typing, not a decision
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter'); // done: saves
    await page.waitForFunction(() => document.querySelector('#pns').textContent === 'Saved ✓');
    assert.strictEqual(env.db.prepare("SELECT note FROM feedback WHERE ad_id = ? AND action = 'note'").get(second).note, 'Te duur <b>voor</b> NL');
    await noSideScroll('Note');
    await shot('8b-note');
    await page.keyboard.press('r');
    await page.waitForFunction((x) => document.querySelector('.card').dataset.id !== x, second);
    assert.strictEqual(await page.inputValue('#pn'), '', 'the next product starts with an empty note');
    // a reject asks why not: key 1 = Too expensive
    assert.match(await page.textContent('#why .wq'), /Why not\?/);
    await page.keyboard.press('1');
    await page.waitForFunction(() => document.querySelector('#why [data-r=price]').getAttribute('aria-pressed') === 'true');
    await page.waitForTimeout(200);
    assert.strictEqual(env.db.prepare("SELECT reasons FROM feedback WHERE ad_id = ? AND action = 'rejected'").get(second).reasons, '["price"]');
    const third = await page.locator('.card').getAttribute('data-id');
    const stars0 = Number(await page.textContent('#nstar')) || 0;
    await page.keyboard.press('k');
    await page.waitForFunction((x) => document.querySelector('.card').dataset.id !== x, third);
    await page.waitForTimeout(150);
    assert.strictEqual(env.db.prepare('SELECT status FROM hidden WHERE ad_id = ?').get(second).status, 'rejected');
    assert.ok(env.db.prepare('SELECT 1 FROM stars WHERE ad_id = ?').get(third), 'Keep = ★');
    assert.strictEqual(Number(await page.textContent('#nstar')), stars0 + 1);
    assert.strictEqual(await left(), n0 - 3);
    await page.click('#why [data-w=undo]');
    await page.waitForFunction((x) => document.querySelector('.card') && document.querySelector('.card').dataset.id === x, third);
    assert.ok(!env.db.prepare('SELECT 1 FROM stars WHERE ad_id = ?').get(third), 'Undo Keep takes the star off');
    assert.strictEqual(await left(), n0 - 2);
    // swipe right = made ad
    const box0 = await page.locator('.card .bd').boundingBox();
    await page.mouse.move(box0.x + 60, box0.y + 20);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(box0.x + 60 + i * 25, box0.y + 22);
    await page.mouse.up();
    await page.waitForFunction((x) => !document.querySelector('.card') || document.querySelector('.card').dataset.id !== x, third);
    await page.waitForTimeout(150);
    assert.strictEqual(env.db.prepare('SELECT status FROM hidden WHERE ad_id = ?').get(third).status, 'seen');
    await noSideScroll('Inbox after decisions');
    await shot('8-inbox');
    // a slow save (roaming): Made ad, then ✓ at once; the count holds and the product is in ✓ once it is saved
    await page.route('**/api/hide', async (route) => { await new Promise((r) => setTimeout(r, 800)); await route.continue(); });
    const slow = await page.locator('.card').getAttribute('data-id');
    const madeBefore = Number(await page.textContent('#nmade')) || 0;
    await page.keyboard.press('d');
    await page.waitForFunction((x) => document.querySelector('.card') && document.querySelector('.card').dataset.id !== x, slow);
    await page.click('[data-view=made]');
    await page.waitForResponse((r) => r.url().includes('/api/ads?view=made'));
    await page.waitForTimeout(50);
    assert.strictEqual(Number(await page.textContent('#nmade')), madeBefore + 1, 'the count holds while the save is on its way');
    await page.waitForFunction((x) => !!document.querySelector(`.card[data-id="${x}"]`), slow, { timeout: 5000 });
    assert.strictEqual(Number(await page.textContent('#nmade')), madeBefore + 1);
    await page.unroute('**/api/hide');
    await page.click('[data-view=inbox]');
    await page.waitForSelector('#tri:not([hidden])');
    // clear the rest: Inbox zero
    for (let k = await left(); k > 0; k--) {
      const cur = await page.locator('.card').getAttribute('data-id');
      await page.keyboard.press('d');
      await page.waitForFunction((x) => !document.querySelector('.card') || document.querySelector('.card').dataset.id !== x, cur);
    }
    await page.waitForSelector('#zero:not([hidden])');
    assert.match(await page.textContent('#zero'), /Inbox zero[\s\S]*cleared today[\s\S]*Next hunt/);
    assert.ok(await page.locator('#tri').isHidden());
    await noSideScroll('Inbox zero');
    await shot('9-inbox-zero');
    // ✓ Made ad: every product you made an ad for, with the day
    const nMade = env.db.prepare("SELECT COUNT(*) AS n FROM hidden WHERE status = 'seen'").get().n;
    assert.ok(nMade > 20);
    await page.click('[data-view=made]');
    await page.waitForFunction((n) => document.querySelectorAll('.card').length === n, nMade);
    assert.strictEqual(await page.textContent('#nmade'), String(nMade));
    assert.strictEqual(await page.getAttribute('[data-view=made]', 'aria-pressed'), 'true');
    assert.ok(await page.locator('#q').isHidden() && await page.locator('#radar').isHidden());
    assert.strictEqual(await page.locator('.card .tag.made').count(), nMade);
    assert.match(await page.locator('.card .tag.made').first().innerText(), /✓ Made 17 Oct/i);
    assert.ok((await page.getAttribute('#csv', 'href')).startsWith('/export.csv?view=made'));
    assert.strictEqual(await page.evaluate(() => day('2025-03-02T12:00:00Z')), 'Mar 2025', 'another year: month and year');
    await page.waitForFunction(imagesInView);
    await noSideScroll('Made ad');
    await shot('9a-made');
    // small phones, 4-digit counts: the five views never push the page sideways
    const bigCounts = () => page.evaluate(() => { for (const [id, n] of [['nin', '1234'], ['nall', '4321'], ['nstar', '123'], ['nmade', '456']]) document.getElementById(id).textContent = n; });
    for (const w of [360, 320]) {
      await page.setViewportSize({ width: w, height: 740 });
      await bigCounts();
      await noSideScroll(`✓ at ${w}px with 4-digit counts`);
    }
    await page.click('[data-view=all]');
    await page.waitForFunction(() => document.querySelector('[data-view=all]').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.card').length > 0);
    await bigCounts();
    await noSideScroll('Browse at 320px with 4-digit counts');
    await page.setViewportSize({ width: 360, height: 740 });
    await noSideScroll('Browse at 360px with 4-digit counts');
    await shot('9c-browse-360');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('[data-view=made]');
    await page.waitForFunction((n) => document.querySelectorAll('.card').length === n, nMade);
    // remove from ✓ takes two taps (it wipes the day and the reasons); no Undo, so a slip does nothing
    const rmId = await page.evaluate(() => LAST && LAST.kind === 'seen' && LAST.a.id); // the last Inbox decision: its Why? strip must go
    assert.ok(rmId, 'the last Inbox decision was a Made ad');
    const rm = page.locator(`.card[data-id="${rmId}"]`);
    assert.deepStrictEqual(await rm.locator('.acts button').allInnerTexts(), ['Remove from ✓']);
    await rm.locator('[data-act=none]').click();
    assert.strictEqual(await rm.locator('[data-act=none]').innerText(), 'Tap again to remove');
    assert.strictEqual(env.db.prepare('SELECT status FROM hidden WHERE ad_id = ?').get(rmId).status, 'seen', 'one tap: nothing removed');
    await page.evaluate(() => { PENDING_MADE++; }); // another Made ad save still on its way: the server count is not taken
    await rm.locator('[data-act=none]').click();
    await page.waitForFunction((x) => !document.querySelector(`.card[data-id="${x}"]`), rmId);
    assert.strictEqual(await page.textContent('#nmade'), String(nMade - 1), 'the count goes down at once');
    await page.evaluate(() => { PENDING_MADE--; });
    assert.strictEqual(await page.textContent('#toastMsg'), 'Removed from ✓ Made ad');
    assert.strictEqual(env.db.prepare('SELECT 1 FROM hidden WHERE ad_id = ?').get(rmId), undefined);
    await page.waitForFunction((n) => document.querySelector('#nmade').textContent === String(n - 1), nMade);
    // it was decided in the Inbox on this phone: it is back there without a reload
    await page.click('[data-view=inbox]');
    await page.waitForFunction((x) => document.querySelector('.card') && document.querySelector('.card').dataset.id === x, rmId);
    assert.strictEqual(await page.textContent('#ileft'), '1 left');
    assert.ok(await page.locator('#why').isHidden(), 'no Why? strip for the removed decision');
    // keep it, then unstar it in ★: back in the Inbox too
    await page.keyboard.press('k');
    await page.waitForSelector('#zero:not([hidden])');
    await page.click('[data-view=starred]');
    await page.waitForSelector(`.card[data-id="${rmId}"]`);
    await page.locator(`.card[data-id="${rmId}"] [data-act=star]`).click();
    await page.waitForFunction((x) => !document.querySelector(`.card[data-id="${x}"]`) || document.querySelector(`.card[data-id="${x}"] .star`).getAttribute('aria-pressed') === 'false', rmId);
    await page.click('[data-view=inbox]');
    await page.waitForFunction((x) => document.querySelector('.card') && document.querySelector('.card').dataset.id === x, rmId);
    assert.strictEqual(await page.textContent('#ileft'), '1 left', 'unstarred: back in the Inbox without a reload');
    // tablets: the five views, the search and the sort menu do not cover each other
    for (const w of [768, 820, 1024, 1280]) {
      await page.setViewportSize({ width: w, height: 1000 });
      await page.click('[data-view=all]');
      await page.waitForFunction(() => document.querySelector('[data-view=all]').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.card').length > 0);
      await bigCounts();
      for (const v of ['inbox', 'all', 'starred', 'made', 'learned']) {
        const hit = await page.evaluate((x) => { const r = document.querySelector(`[data-view=${x}]`).getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!(e && e.closest(`[data-view=${x}]`)); }, v);
        assert.ok(hit, `${w}px: the ${v} view can be tapped`);
      }
      assert.ok((await page.locator('#q').boundingBox()).width > 200, `${w}px: the search has room`);
      await noSideScroll(`Browse at ${w}px`);
      if (w === 820) await shot('9d-browse-ipad');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // 🧠 what the board learned: reasons, the note (as text), and a note about the board
    await page.click('[data-view=learned]');
    await page.waitForSelector('#learn:not([hidden]) h2');
    assert.match(await page.textContent('#learn'), /From \d+ decisions/);
    assert.match(await page.textContent('#learn'), /Why you say no\s*Too expensive\s*1/);
    assert.match(await page.textContent('#learn'), /Why you say yes\s*Wow product\s*1/);
    assert.match(await page.textContent('#learn .lnotes'), /Te duur <b>voor<\/b> NL/);
    assert.strictEqual(await page.locator('#learn .lnotes b').count(), 0, 'notes stay text');
    await page.fill('#lgen', 'More pet products please');
    await page.click('#lnote button');
    await page.waitForFunction(() => /More pet products please/.test(document.querySelector('#learn .lnotes').textContent));
    assert.ok(await page.locator('#grid .card').count() === 0 && await page.locator('#dock').isHidden());
    await noSideScroll('Learned');
    await shot('9b-learned');
    await page.waitForTimeout(300);
    assert.strictEqual((await (await fetch(base + '/api/ads?view=inbox', { headers: { cookie: (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ') } })).json()).total, 1, 'saved: nothing left on the server but the product removed from ✓ and unstarred (back in the Inbox)');
    // a failed run: red banner on top, on a phone
    env.db.prepare("UPDATE state SET value = ? WHERE key = 'last_run'").run(JSON.stringify({ status: 'done', health: 'failed', finished_at: new Date(NOW - 3600e3).toISOString(), ads_checked: 0, new_winners: 0,
      alert: 'Run mislukt: 0 ads gecheckt (Meta token?) / Run failed: 0 ads checked (Meta token?) <b>x</b>' }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.reload();
    await page.waitForSelector('#alert:not([hidden])');
    assert.strictEqual(await page.textContent('#alert'), 'Run mislukt: 0 ads gecheckt (Meta token?) / Run failed: 0 ads checked (Meta token?) <b>x</b>', 'shown as text');
    assert.strictEqual(await page.getAttribute('#alert', 'class'), 'alert');
    const box = await page.locator('#alert').boundingBox();
    assert.ok(box.y < 40, 'at the top');
    await noSideScroll('alert banner');
    await shot('7-alert');
    assert.deepStrictEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test('extractAd reads a render_ad-like page: header, text, media, link box; and a carousel', { skip: !chromium && 'Playwright not installed', timeout: 30000 }, async (t) => {
  const browser = await launch();
  if (!browser) return t.skip('Chromium not available');
  const page = await browser.newPage({ viewport: { width: 500, height: 1000 } });
  await page.route(/^https:\/\//, (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="${/emoji/.test(route.request().url()) ? 16 : /av/.test(route.request().url()) ? 60 : 600}" height="60"/>` }));
  const L = 'https://l.facebook.com/l.php?u=' + encodeURIComponent('https://marijkedenbosch.nl/products/jurk') + '&amp;h=AT0';
  const head = `<div><img src="https://scontent.test/av.jpg" width="60" height="60" alt="Marijke"><div><a href="https://www.facebook.com/marijke">Marijke den Bosch</a></div><div>Sponsored</div><div>Library ID: 1234567890</div><div role="button">Menu</div><div>\u200b</div></div>`;
  try {
    await page.setContent(`<body>${head}
      <div><div>Eindigt vanavond! <img src="https://scontent.test/emoji.png" width="16" height="16" alt="🔥"></div><div><br></div><div>Nu 50% korting.</div></div>
      <a href="${L}"><img src="https://scontent.test/creative.jpg" width="400"></a>
      <div><a href="${L}"><div>MARIJKEDENBOSCH.NL</div><div>Eindigt vanavond 23:59!</div><div>Gratis verzending</div></a><div role="button">Shop now</div></div>
      <div>Low impression count</div></body>`, { waitUntil: 'load' });
    const one = await page.evaluate(extractAd);
    assert.strictEqual(one.name, 'Marijke den Bosch');
    assert.strictEqual(one.avatar, 'https://scontent.test/av.jpg');
    assert.strictEqual(one.library_id, '1234567890');
    assert.strictEqual(one.body, 'Eindigt vanavond! 🔥\n\nNu 50% korting.');
    assert.deepStrictEqual(one.media, [{ type: 'image', src: 'https://scontent.test/creative.jpg', poster: '' }]);
    assert.deepStrictEqual(Object.assign({}, one.link, { href: undefined }), { caption: 'MARIJKEDENBOSCH.NL', title: 'Eindigt vanavond 23:59!', description: 'Gratis verzending', cta: 'Shop now', href: undefined });
    assert.match(one.link.href, /^https:\/\/l\.facebook\.com\/l\.php\?u=/);
    assert.strictEqual(one.low_impressions, true);
    assert.deepStrictEqual(one.cards, []);
    // video + carousel
    await page.setContent(`<body>${head}<div>Kies je kleur</div>
      <div style="display:flex">${[1, 2].map((n) => `<div><a href="https://shop.test/k${n}"><img src="https://scontent.test/c${n}.jpg" width="300"></a><div>Kleur ${n}</div><div><span>Shop now</span></div></div>`).join('')}</div></body>`, { waitUntil: 'load' });
    const car = await page.evaluate(extractAd);
    assert.strictEqual(car.body, 'Kies je kleur');
    assert.deepStrictEqual(car.media, []);
    assert.deepStrictEqual(car.cards.map((c) => [c.media.src, c.title, c.cta, c.href]), [1, 2].map((n) => [`https://scontent.test/c${n}.jpg`, 'Kleur ' + n, 'Shop now', `https://shop.test/k${n}`]));
    await page.setContent(`<body>${head}<div>Kijk!</div><div><div><video src="https://video.test/v.mp4" poster="https://scontent.test/poster.jpg" width="400"></video></div></div>
      <div><div>SHOP.NL</div><div>Titel</div><div>Learn more</div></div></body>`, { waitUntil: 'domcontentloaded' });
    const vid = await page.evaluate(extractAd);
    assert.deepStrictEqual(vid.media, [{ type: 'video', src: 'https://video.test/v.mp4', poster: 'https://scontent.test/poster.jpg' }]);
    assert.deepStrictEqual([vid.body, vid.link.caption, vid.link.title, vid.link.cta], ['Kijk!', 'SHOP.NL', 'Titel', 'Learn more']);
    // Facebook's cookie dialog over the ad: waitReady clicks "Decline optional cookies"; the ad is read, not the dialog
    const consent = (btn) => `<div role="dialog"><div>Allow the use of cookies from Facebook on this browser?</div><div>We use cookies and similar technologies.</div>
      <div><img src="https://static.test/cookies1.png" width="300"><div>What are cookies?</div><div role="button">Learn more</div></div>
      <div><img src="https://static.test/cookies2.png" width="300"><div>Why do we use cookies?</div><div role="button">Learn more</div></div>
      ${btn ? '<div role="button" aria-label="Decline optional cookies" onclick="this.closest(\'[role=dialog]\').remove()"><span>Decline optional cookies</span></div>' : ''}</div>`;
    const ad = `${head}<div>Kijk!</div><div><video src="https://video.test/v.mp4" poster="https://scontent.test/poster.jpg" width="400"></video></div>`;
    await page.setContent(`<body>${ad}${consent(true)}</body>`, { waitUntil: 'load' });
    assert.strictEqual(await page.evaluate(isReady), false, 'not ready while the cookie dialog shows');
    assert.strictEqual(await waitReady(page, 3000), true);
    assert.strictEqual(await page.locator('[role=dialog]').count(), 0, 'dialog declined');
    const after = await page.evaluate(extractAd);
    assert.strictEqual(after.name, 'Marijke den Bosch');
    assert.deepStrictEqual([after.body, after.cards, after.media.map((m) => m.type)], ['Kijk!', [], ['video']]);
    // a dialog without a button to click: the extractor leaves it out
    await page.setContent(`<body>${ad}${consent(false)}</body>`, { waitUntil: 'load' });
    assert.strictEqual(await waitReady(page, 400), false);
    const stuck = await page.evaluate(extractAd);
    assert.deepStrictEqual([stuck.body, stuck.cards, stuck.media.map((m) => m.src)], ['Kijk!', [], ['https://video.test/v.mp4']]);
  } finally {
    await browser.close();
  }
});
