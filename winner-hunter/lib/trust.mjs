/*
 * Trust: a store's Trustpilot score and number of reviews.
 *
 * First from Trustpilot's own page for the store's domain (www.trustpilot.com/review/<domain>): every store with a
 * Trustpilot page, also without a widget on its site. A bot check (AWS WAF) stands in front of that page: a real
 * browser passes it once (trustCookie) and its token, a cookie good for days, then opens the pages with a plain fetch.
 *
 *   await trustCookie({ launch }) → 'aws-waf-token=…', or '' when no browser can pass
 *   await trustPage('store.com', { cookie }) → { status: 'page', score, reviews, profile }
 *                                            | { status: 'nopage' }   Trustpilot has no page for the domain
 *                                            | { error, blocked }     blocked: the token no longer passes
 *
 * Else from a real Trustpilot widget on the store (a TrustBox with its business unit id): Trustpilot's widget data
 * (widget.trustpilot.com) answers that id openly. That also finds a store whose Trustpilot page is on another domain.
 *
 *   await storeTrust('store.com', productUrl, { page }) → the page's answer when it has a score, else:
 *                                              { status: 'widget', score, reviews, profile }
 *                                            | { status: 'nopage' }  no Trustpilot page and no real widget
 *                                            | { status: 'badge' }   the store names Trustpilot but shows no real widget
 *                                            | { status: 'none' }    no Trustpilot on the store
 *                                            | { error }             store or widget not reachable: try again next run
 *   trustIdIn(html) → the business unit id of a TrustBox in the page, or ''
 */
export const TEMPLATE = '5419b6a8b0d04a076446a9ad'; // a TrustBox template whose data has the score and review counts

const ID_RE = /(?:data-businessunit-id|["']?business[-_]?unit[-_]?id["']?)\s*[=:]\s*["']([0-9a-f]{24})["']/i;

export const trustIdIn = (html) => (ID_RE.exec(String(html || '')) || [])[1] || '';

async function get(doFetch, url, timeout, accept, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await doFetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { Accept: accept, ...headers } });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(t);
  }
}

// The browser that passes the bot check and the fetches after it say the same: the token belongs to it.
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BOT_CHECK = /awswaf|Verifying Connection/i;

/** A token for Trustpilot's bot check: launch() gives a Playwright browser, which opens one Trustpilot page. Never throws. */
export async function trustCookie({ launch, timeout = 45000 } = {}) {
  let browser = null;
  try {
    browser = await launch();
    const ctx = await browser.newContext({ locale: 'en-US', userAgent: UA });
    const page = await ctx.newPage();
    await page.goto('https://www.trustpilot.com/review/trustpilot.com', { waitUntil: 'domcontentloaded', timeout });
    await page.waitForFunction(() => !/Verifying/i.test(document.title), null, { timeout });
    const c = (await ctx.cookies('https://www.trustpilot.com')).find((x) => x.name === 'aws-waf-token');
    return c ? `aws-waf-token=${c.value}` : '';
  } catch (e) {
    return '';
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** The business unit in a Trustpilot page (its Next.js data), or null. */
export function businessUnitIn(html) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
  try {
    return (m && JSON.parse(m[1]).props.pageProps.businessUnit) || null;
  } catch (e) {
    return null;
  }
}

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

/** The store's own Trustpilot page, with the token from trustCookie. Never throws. */
export async function trustPage(domain, { cookie = '', doFetch = globalThis.fetch, timeout = 15000 } = {}) {
  const r = await get(doFetch, `https://www.trustpilot.com/review/${encodeURIComponent(domain)}`, timeout, 'text/html', { Cookie: cookie, 'User-Agent': UA });
  if (r.status === 404) return { status: 'nopage' };
  if (BOT_CHECK.test(r.text) && !r.text.includes('__NEXT_DATA__')) return { error: 'Trustpilot bot check HTTP ' + r.status, blocked: true };
  if (!r.ok) return { error: 'Trustpilot HTTP ' + r.status };
  const bu = businessUnitIn(r.text);
  if (!bu) return { error: 'Trustpilot page without its data' };
  const reviews = num(bu.numberOfReviews);
  // A page without reviews has a TrustScore of 0: no score
  return { status: 'page', score: reviews ? num(bu.trustScore) : null, reviews, profile: String(bu.identifyingName || domain).slice(0, 100) };
}

/**
 * The store's Trustpilot facts. page(store): its Trustpilot page (trustPage), when there is a token. Then, without a
 * score there, its home page and one product page (where TrustBoxes often sit). Never throws.
 */
export async function storeTrust(store, productUrl = '', { doFetch = globalThis.fetch, timeout = 15000, page = null } = {}) {
  const tp = page ? await page(store) : null;
  if (tp && tp.status === 'page') return tp;
  const w = await widgetTrust(store, productUrl, doFetch, timeout);
  // No Trustpilot page: only a real widget (a page on another domain) says more than that.
  return tp && tp.status === 'nopage' && w.status !== 'widget' ? { status: 'nopage' } : w;
}

async function widgetTrust(store, productUrl, doFetch, timeout) {
  const pages = [`https://${store}/`];
  if (/\/products\//.test(productUrl || '')) pages.push(productUrl);
  let reached = false;
  let named = false;
  for (const url of pages) {
    const page = await get(doFetch, url, timeout, 'text/html');
    if (!page.ok) continue;
    reached = true;
    const id = trustIdIn(page.text);
    if (id) {
      const w = await get(doFetch, `https://widget.trustpilot.com/trustbox-data/${TEMPLATE}?businessUnitId=${id}&locale=en-US`, timeout, 'application/json');
      let bu = null;
      try {
        bu = JSON.parse(w.text).businessUnit;
      } catch (e) {
        bu = null;
      }
      if (!bu) return { error: 'Trustpilot widget data HTTP ' + w.status };
      const total = bu.numberOfReviews && bu.numberOfReviews.total;
      return {
        status: 'widget',
        score: Number.isFinite(Number(bu.trustScore)) ? Number(bu.trustScore) : null,
        reviews: Number.isFinite(Number(total)) ? Number(total) : null,
        profile: String(bu.identifyingName || '').slice(0, 100),
      };
    }
    named = named || /trustpilot/i.test(page.text);
  }
  if (!reached) return { error: 'store not reachable' };
  return { status: named ? 'badge' : 'none' };
}
