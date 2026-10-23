/*
 * The board's ad viewer: GET /api/ad/:id opens Meta's light ad page (render_ad) in Browser Run, reads the ad out
 * of it (page, text, video/images, carousel cards, link box + CTA) and keeps the result 24 hours in D1 (ad_views).
 * The browser is injected (`launch(env.BROWSER)` → a puppeteer Browser), so tests run without Cloudflare.
 */

const CACHE_HOURS = 24;
const TOTAL_MS = 15000; // whole render, launch included
const GOTO_MS = 8000;
const READY_MS = 6000;

/** Meta's light ad page for one ad. The token is in the URL: never log it. */
export const renderAdUrl = (id, token) => 'https://www.facebook.com/ads/archive/render_ad/?id=' + encodeURIComponent(id) + '&access_token=' + encodeURIComponent(token);

/**
 * True once the ad is on the page: its header (or text and a big image) is there, Facebook's cookie dialog is gone
 * and every image has loaded (the extractor sizes images). Runs inside the page. Waiting for a quiet network
 * instead never ends on video ads: that cost ~9 s.
 */
export function isReady() {
  const text = document.body ? document.body.innerText || '' : '';
  if (/allow the use of cookies|cookies (from|van) facebook|what are cookies|gebruik van cookies|verwendung von cookies/i.test(text)) return false;
  const imgs = [...document.images];
  const ad = /library id|bibliotheek-id|sponsored|gesponsord/i.test(text) || (text.length > 20 && imgs.some((i) => i.naturalWidth >= 200));
  return ad && imgs.every((i) => i.complete);
}

/**
 * Facebook shows a cookie dialog over the ad to browsers without its cookies (GitHub runners, Browser Run).
 * Clicks "Decline optional cookies" (or, failing that, "Allow all cookies"). Runs inside the page.
 */
export function dismissConsent() {
  if (!document.body || !/cookies/i.test(document.body.innerText || '')) return false;
  const btns = [...document.querySelectorAll('[role="button"], button')];
  const label = (b) => (b.getAttribute('aria-label') || b.innerText || '').trim();
  const pick = (re) => btns.find((b) => re.test(label(b)));
  const b = pick(/^(decline optional cookies|only allow essential cookies|optionele cookies weigeren|alleen essenti.le cookies toestaan|optionale cookies ablehnen|nur erforderliche cookies erlauben)$/i)
    || pick(/^(allow all cookies|alle cookies toestaan|alle cookies erlauben)$/i);
  if (!b) return false;
  b.click();
  return true;
}

/**
 * Polls isReady() for up to `ms`, closing the cookie dialog when it shows. Not waitForFunction: on Meta's page it
 * failed at once, so the empty page was read before the ad was drawn.
 */
export async function waitReady(page, ms, pause = 150) {
  const end = Date.now() + ms;
  for (;;) {
    await page.evaluate(dismissConsent).catch(() => false);
    if (await page.evaluate(isReady).catch(() => false)) return true;
    if (Date.now() + pause > end) return false;
    await new Promise((r) => setTimeout(r, pause));
  }
}

/** Requests the extractor never needs: the video itself (its URL is in the page) and fonts. */
export const SKIP_TYPES = new Set(['media', 'font']);
const LIMIT_MSG = "Dagelimiet van de ad-viewer bereikt (gratis Cloudflare: 10 min/dag). Gebruik 'Ad ↗'.";

export class AdError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Where a link really goes: l.facebook.com/l.php?u=… unwrapped; only http(s) URLs, else ''. */
export function landingUrl(href) {
  let u;
  try {
    u = new URL(String(href || ''));
    if (/^lm?\.facebook\.com$/i.test(u.hostname) && u.pathname === '/l.php') u = new URL(u.searchParams.get('u') || '');
  } catch (e) {
    return '';
  }
  return /^https?:$/.test(u.protocol) ? u.href.slice(0, 2000) : '';
}

/**
 * Runs inside the render_ad page (sent as source text: no outside names). Returns the raw ad; cleanAd() checks it.
 * The page has no stable class names, so this goes by layout: the header lines ("Sponsored", "Library ID"),
 * big images/videos in page order, and the box around the call-to-action button.
 */
export function extractAd() {
  const CTA = /^(shop now|learn more|sign up|order now|buy now|get offer|book now|download|contact us|subscribe|apply now|get quote|see menu|watch more|send message|send whatsapp message|install now|play game|listen now|donate now|get directions|call now|see more|view more|shop nu|nu kopen|koop nu|bestel nu|nu bestellen|meer informatie|meer weten|bekijk aanbieding|aanbieding bekijken|aanmelden|winkelen|nu winkelen)$/i;
  const LOW = /low impression count/i;
  const abs = (u) => {
    try {
      const x = new URL(u, location.href);
      return /^https?:$/.test(x.protocol) ? x.href : '';
    } catch (e) {
      return '';
    }
  };
  const linesOf = (el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s && !LOW.test(s));
  const width = (el) => el.getBoundingClientRect().width;

  // Facebook's cookie dialog (if still there) is never part of the ad.
  for (const d of [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]) if (/cookie/i.test(d.innerText || '')) d.remove();

  // Emoji are small images with the emoji as alt text: put the text back.
  for (const i of [...document.images]) if (i.alt && width(i) > 0 && width(i) < 40) i.replaceWith(document.createTextNode(i.alt));

  const avatarEl = [...document.images].find((i) => width(i) >= 24 && width(i) <= 100);

  // Media in page order; a video without poster takes the big image next to it as poster.
  const all = [...document.querySelectorAll('img, video')];
  const used = new Set();
  for (const v of all) {
    if (v.tagName !== 'VIDEO' || v.poster) continue;
    let p = v.parentElement;
    for (let k = 0; k < 3 && p; k++, p = p.parentElement) {
      const im = [...p.querySelectorAll('img')].find((i) => i.naturalWidth >= 200);
      if (im) {
        v.dataset.whPoster = abs(im.currentSrc || im.src);
        used.add(im);
        break;
      }
    }
  }
  const media = [];
  for (const el of all) {
    if (used.has(el) || el === avatarEl) continue;
    if (el.tagName === 'IMG') {
      const src = el.naturalWidth >= 200 ? abs(el.currentSrc || el.src) : '';
      if (src) media.push({ el, type: 'image', src });
    } else {
      const s = el.querySelector('source');
      const src = abs(el.currentSrc || el.src || (s && s.src) || '');
      const poster = abs(el.poster || el.dataset.whPoster || '');
      if (src || poster) media.push({ el, type: 'video', src, poster });
    }
  }

  // A box of text lines: caption (a domain), title, description, CTA.
  const boxOf = (el) => {
    const ls = linesOf(el);
    let cta = ls.find((s) => CTA.test(s)) || '';
    if (!cta) {
      const b = el.querySelector('[role="button"], button');
      cta = b ? (b.innerText || '').trim().split('\n')[0] : '';
    }
    const rest = ls.filter((s) => s !== cta);
    const ci = rest.findIndex((s) => /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s));
    const caption = ci >= 0 ? rest.splice(ci, 1)[0] : '';
    const a = el.closest('a[href]') || el.querySelector('a[href]');
    return { caption, title: rest[0] || '', description: rest.slice(1).join(' '), cta, href: a ? a.href : '', first: ls[0] || '' };
  };
  const hasMedia = (el) => media.some((m) => el.contains(m.el));

  // Carousel: 2+ media, each in its own card (climb until the parent holds another medium).
  let cards = [];
  if (media.length >= 2) {
    cards = media.map((m) => {
      let c = m.el;
      while (c.parentElement && c.parentElement !== document.body && !media.some((o) => o !== m && c.parentElement.contains(o.el))) c = c.parentElement;
      const b = boxOf(c);
      return Object.assign(b, { media: { type: m.type, src: m.src, poster: m.poster || '' } });
    });
    if (cards.filter((c) => c.title || c.cta).length < 2) cards = [];
  }

  // Link box: climb from the CTA button while the box stays small and holds no media.
  let box = null;
  if (!cards.length) {
    const ctaEl = [...document.querySelectorAll('body *')].find((e) => CTA.test((e.innerText || '').trim()));
    let el = ctaEl || null;
    if (!el) {
      const ext = [...document.querySelectorAll('a[href]')].filter((a) => {
        try {
          const h = new URL(a.href).hostname;
          return /^lm?\.facebook\.com$/.test(h) || !/(^|\.)facebook\.com$/.test(h);
        } catch (e) {
          return false;
        }
      }).filter((a) => linesOf(a).length && linesOf(a).length <= 6);
      el = ext.sort((x, y) => linesOf(y).length - linesOf(x).length)[0] || null;
    }
    if (el) {
      while (el.parentElement && el.parentElement !== document.body && linesOf(el.parentElement).length <= 5 && !hasMedia(el.parentElement)) el = el.parentElement;
      box = boxOf(el);
    }
  }

  // Header and body text from the page's lines.
  // Zero-width characters and the header's menu button ("Menu", "Open Dropdown") are not ad text.
  const raw = (document.body.innerText || '').split('\n').map((s) => s.replace(/[\u200b-\u200d\ufeff]/g, '').trim()).map((s) => (/^(menu|open dropdown)$/i.test(s) ? '' : s));
  const iSp = raw.findIndex((s) => /^(sponsored|gesponsord)\b/i.test(s));
  const iLib = raw.findIndex((s) => /library id|bibliotheek-id/i.test(s));
  const libLine = iLib >= 0 ? raw[iLib] : '';
  let name = '';
  for (let k = iSp - 1; k >= 0; k--) {
    if (raw[k] && !/library id/i.test(raw[k])) {
      name = raw[k];
      break;
    }
  }
  if (!name && avatarEl) name = avatarEl.alt || '';
  const start = Math.max(iSp, iLib) + 1;
  const marks = (cards.length ? cards.map((c) => c.first) : [box && box.first]).filter(Boolean);
  let end = raw.length;
  for (const m of marks) {
    const i = raw.lastIndexOf(m);
    if (i >= start && i < end) end = i;
  }
  const low = raw.findIndex((s, i) => i >= start && LOW.test(s));
  if (low >= 0 && low < end) end = low;
  const body = raw.slice(start, end).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    name,
    avatar: avatarEl ? abs(avatarEl.currentSrc || avatarEl.src) : '',
    library_id: (libLine.match(/\d{5,}/) || [''])[0],
    body,
    media: cards.length ? [] : media.map((m) => ({ type: m.type, src: m.src, poster: m.poster || '' })),
    cards: cards.map((c) => ({ media: c.media, caption: c.caption, title: c.title, description: c.description, cta: c.cta, href: c.href })),
    link: box ? { caption: box.caption, title: box.title, description: box.description, cta: box.cta, href: box.href } : null,
    low_impressions: raw.some((s) => LOW.test(s)),
  };
}

const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u.slice(0, 2000) : '');
function mediaOf(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'video') {
    const v = { type: 'video', src: https(m.src), poster: https(m.poster) };
    return v.src || v.poster ? v : null;
  }
  const src = https(m.src);
  return src ? { type: 'image', src } : null;
}
const boxOf = (b) => ({ caption: str(b.caption, 120), title: str(b.title, 300), description: str(b.description, 500), cta: str(b.cta, 40), url: landingUrl(b.href) });

/** The extracted ad, checked: only known fields, plain strings, https media, http(s) landing URLs. */
export function cleanAd(raw, id, now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ad = {
    id,
    name: str(r.name, 120),
    avatar: https(r.avatar),
    library_id: /^\d{1,25}$/.test(String(r.library_id || '')) ? String(r.library_id) : id,
    body: str(r.body, 5000),
    media: (Array.isArray(r.media) ? r.media : []).map(mediaOf).filter(Boolean).slice(0, 12),
    cards: (Array.isArray(r.cards) ? r.cards : []).filter((c) => c && typeof c === 'object').slice(0, 10).map((c) => Object.assign({ media: mediaOf(c.media) }, boxOf(c))),
    link: r.link && typeof r.link === 'object' ? boxOf(r.link) : null,
    low_impressions: r.low_impressions === true,
    fetched_at: new Date(now).toISOString(),
  };
  const words = [ad.body, ad.link && ad.link.title, ...ad.cards.map((c) => c.title)].join('\n');
  if (/allow the use of cookies|cookies (from|van) facebook|what are cookies|why do we use cookies|gebruik van cookies|verwendung von cookies/i.test(words)) {
    throw new AdError("Facebook liet een cookie-melding zien i.p.v. de ad. Probeer opnieuw of gebruik 'Ad ↗'.", 502);
  }
  if (!ad.body && !ad.media.length && !ad.cards.length && !(ad.link && (ad.link.title || ad.link.cta))) {
    throw new AdError("Ad niet gevonden (gestopt, verwijderd of Meta-token ongeldig). Gebruik 'Ad ↗'.", 404);
  }
  return ad;
}

export const scrub = (msg, token) => {
  let m = String(msg || '');
  if (token) m = m.split(token).join('***');
  return m.replace(/access_token=[^&\s"']+/gi, 'access_token=***');
};

async function render(id, token, env, launch, box) {
  const url = renderAdUrl(id, token);
  const browser = await launch(env.BROWSER);
  box.browser = browser;
  try {
    const page = await browser.newPage();
    if (page.setViewport) await page.setViewport({ width: 500, height: 1000 });
    if (page.setRequestInterception) {
      await page.setRequestInterception(true);
      page.on('request', (r) => Promise.resolve(SKIP_TYPES.has(r.resourceType()) ? r.abort() : r.continue()).catch(() => {}));
    }
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
    } catch (e) {
      if (!/timeout/i.test(String(e && e.message))) throw e; // slow network: read what is there
    }
    await waitReady(page, READY_MS);
    return await page.evaluate(extractAd);
  } finally {
    box.browser = null;
    await browser.close().catch(() => {});
  }
}

/** GET /api/ad/:id → { status, body } (body is the ad, or { error }). */
export async function adView(id, env, { now = Date.now(), launch } = {}) {
  const token = String(env.META_TOKEN || '').replace(/\s+/g, '');
  if (!token || !env.BROWSER || !launch) {
    return { status: 503, body: { error: "Ad-viewer staat uit (geen META_TOKEN of Browser Run). Gebruik 'Ad ↗'.", fallback: true } };
  }
  const row = await env.DB.prepare('SELECT json, fetched_at FROM ad_views WHERE ad_id = ?').bind(id).first();
  if (row && Date.parse(row.fetched_at) > now - CACHE_HOURS * 3600e3) {
    try {
      return { status: 200, body: Object.assign(JSON.parse(row.json), { cached: true }) };
    } catch (e) {
      // broken row: fetch again
    }
  }
  const box = { browser: null };
  let timer = 0;
  try {
    const raw = await Promise.race([
      render(id, token, env, launch, box),
      new Promise((_, no) => {
        timer = setTimeout(() => no(new AdError("Ad laden duurde te lang. Probeer opnieuw of gebruik 'Ad ↗'.", 504)), TOTAL_MS);
      }),
    ]);
    const ad = cleanAd(raw, id, now);
    const iso = new Date(now).toISOString();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO ad_views (ad_id, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(ad_id) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at').bind(id, JSON.stringify(ad), iso),
      env.DB.prepare('DELETE FROM ad_views WHERE fetched_at < ?').bind(new Date(now - 7 * 864e5).toISOString()),
    ]);
    return { status: 200, body: Object.assign(ad, { cached: false }) };
  } catch (e) {
    if (box.browser) box.browser.close().catch(() => {});
    if (e instanceof AdError) return { status: e.status, body: { error: e.message } };
    const msg = scrub(e && e.message, token);
    if (/no such table/i.test(msg)) throw e;
    if (/\b429\b|rate.?limit|too many requests|time limit/i.test(msg)) return { status: 429, body: { error: LIMIT_MSG } };
    console.error('ad viewer:', msg);
    return { status: 502, body: { error: "Ad laden mislukt. Probeer opnieuw of gebruik 'Ad ↗'. (" + msg.slice(0, 120) + ')' } };
  } finally {
    clearTimeout(timer);
  }
}
