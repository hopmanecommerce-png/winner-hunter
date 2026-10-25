/*
 * Trust: a store's Trustpilot score and number of reviews, read only where the store itself shows a real Trustpilot
 * widget (a TrustBox with its business unit id). Trustpilot's widget data (widget.trustpilot.com) answers that id
 * openly. Its website (bot check) and its API (business key) do not, so a store without a widget gets no score.
 *
 *   await storeTrust('store.com', productUrl) → { status: 'widget', score, reviews, profile }
 *                                              | { status: 'badge' }  the store names Trustpilot but shows no real widget
 *                                              | { status: 'none' }   no Trustpilot on the store
 *                                              | { error }            store or widget not reachable: try again next run
 *   trustIdIn(html) → the business unit id of a TrustBox in the page, or ''
 */
export const TEMPLATE = '5419b6a8b0d04a076446a9ad'; // a TrustBox template whose data has the score and review counts

const ID_RE = /(?:data-businessunit-id|["']?business[-_]?unit[-_]?id["']?)\s*[=:]\s*["']([0-9a-f]{24})["']/i;

export const trustIdIn = (html) => (ID_RE.exec(String(html || '')) || [])[1] || '';

async function get(doFetch, url, timeout, accept) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await doFetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { Accept: accept } });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(t);
  }
}

/** The store's Trustpilot facts from its home page and one product page (where TrustBoxes often sit). Never throws. */
export async function storeTrust(store, productUrl = '', { doFetch = globalThis.fetch, timeout = 15000 } = {}) {
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
