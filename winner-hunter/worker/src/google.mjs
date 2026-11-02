/*
 * The board's Google tab: products Shopify stores advertise on Google (google.mjs, the Google hunt), with our four rules as
 * the hunt checked them, each marked exact, approximated or not checked (lib/google-ads.mjs googleRules), and what speaks
 * for them instead of reach. They are board products like the others: Approved and Reject, notes, 🧠 and 🚀 work the same,
 * in the same tables (hidden, stars, feedback, launches). They stay off the EU and outside-EU tabs.
 * Pure: app.mjs reads the tables and calls these.
 */

export const GOOGLE_SQL = 'SELECT g.* FROM google_products g';
// The TikTok tab's shops (the domain the shop's Meta ads go to), for "also on TikTok". Read only when there are Google products.
export const TIKTOK_SHOPS_SQL = "SELECT title, ads_domain FROM tiktok_products WHERE COALESCE(ads_domain, '') != ''";
const TRANSPARENCY = 'https://adstransparency.google.com';
// The same links as lib/google-ads.mjs advertiserUrl and creativeUrl, made from checked ids only: keep them the same.
const ADV = /^AR\d{5,30}$/;
const CRE = /^CR\d{5,30}$/;
export const advertiserUrl = (id) => (ADV.test(String(id || '')) ? `${TRANSPARENCY}/advertiser/${id}` : '');
export const creativeUrl = (adv, cre) => (ADV.test(String(adv || '')) && CRE.test(String(cre || '')) ? `${TRANSPARENCY}/advertiser/${adv}/creative/${cre}` : '');
const jsonOf = (s, or) => { try { return JSON.parse(s || '') ?? or; } catch (e) { return or; } };
const n = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\d?\./, ''); } catch (e) { return ''; } };
const RULE_KEYS = ['shopify', 'ads', 'age', 'reach'];
const STATES = new Set(['ok', 'bad', 'unknown', 'pending']);
const HOWS = new Set(['exact', 'approx', 'none']);

/** The rules as the hunt saved them: [{ key, label, state, how, text }], only the four known ones, only known states. */
export function rulesOf(s) {
  const list = jsonOf(s, []);
  return RULE_KEYS.map((k) => (Array.isArray(list) ? list.find((i) => i && i.key === k) : null)).filter(Boolean)
    .map((i) => ({ key: i.key, label: String(i.label || ''), state: STATES.has(i.state) ? i.state : 'unknown', how: HOWS.has(i.how) ? i.how : 'none', text: String(i.text || '').slice(0, 300) }));
}

/**
 * A google_products row in the shape of a winners row: its age today counts from Google's first-shown time (ad_start_date),
 * reach_eu empty (Google publishes none), scaled_count its ads, active_ads Google's estimate of the advertiser's ads.
 * check: Jev's answer (app.mjs checkOf).
 */
export function googleRow(g, jev = null) {
  return { ...g, jev, gk: 'google|' + g.product_key, ad_age_days: n(g.days), ad_start_date: g.first_shown || '', reach_eu: null, scaled_count: n(g.copies) ?? 1,
    active_ads: n(g.ads_estimate), ad_library_url: creativeUrl(g.advertiser_id, g.creative_id), data: '{}',
    google: { active: Number(g.active) !== 0, verdict: g.verdict === 'winner' ? 'winner' : 'partial', rules: rulesOf(g.rules), regions: jsonOf(g.regions, []).filter((c) => /^[A-Z]{2}$/.test(c)),
      formats: jsonOf(g.formats, []).filter((f) => ['text', 'image', 'video'].includes(f)), first_shown: g.first_shown || '', last_shown: g.last_shown || '', advertiser_id: g.advertiser_id || '',
      creative_id: g.creative_id || '', window: n(g.ads_window), impr: g.impr_lower == null ? null : { lower: n(g.impr_lower), upper: n(g.impr_upper), scope: g.impr_scope === 'eu' ? 'eu' : 'all' },
      store_products: n(g.store_products), via: g.via || '', region: g.region || '', cross: { meta: null, tiktok: null } } };
}

const WORD = /[\p{L}\p{N}]{4,}/gu;
const SMALL = new Set(['with', 'from', 'your', 'this', 'that', 'free', 'shipping', 'sale', 'only', 'today', 'pack', 'size', 'color', 'colour', 'original', 'official']);
const words = (t) => new Set((String(t || '').toLowerCase().match(WORD) || []).filter((w) => !SMALL.has(w)));
/** Two titles name the same product: two real words in common. */
const sameTitle = (a, b) => { const x = words(a); let k = 0; for (const w of words(b)) if (x.has(w) && ++k >= 2) return true; return false; };

/**
 * Who else shows the same product or shop, both ways: a Google product gets cross { meta: 'product' | 'store' | null, where:
 * 'eu' | 'world', tiktok: 'product' | 'store' | null }; a Meta product (EU or outside the EU) gets on_google: 'product' | 'store'.
 * product: the same product page (the board's key); store: the same shop. key(u): the board's productKey; store(u): storeOf.
 */
export function crossLink(google, meta, tiktok, { key, store }) {
  const pages = new Map();
  const shops = new Map();
  for (const w of meta) {
    const where = w.world ? 'world' : 'eu';
    const k = key(w.product_url);
    if (k && !pages.has(k)) pages.set(k, where);
    const s = (k && k.split('/')[0]) || store(w.store_url);
    if (s && !shops.has(s)) shops.set(s, where);
  }
  const tt = new Map();
  for (const t of tiktok || []) {
    const s = host('https://' + String(t.ads_domain || '').replace(/^https?:\/\//, ''));
    if (s) tt.set(s, (tt.get(s) || []).concat(String(t.title || '')));
  }
  const gPages = new Set();
  const gShops = new Set();
  for (const g of google) {
    const k = g.product_key;
    const s = k.split('/')[0];
    gPages.add(k);
    gShops.add(s);
    const titles = tt.get(s);
    g.google.cross = {
      meta: pages.has(k) ? 'product' : shops.has(s) ? 'store' : null,
      where: pages.get(k) || shops.get(s) || null,
      tiktok: titles ? (titles.some((t) => sameTitle(t, g.product_title)) ? 'product' : 'store') : null,
    };
  }
  for (const w of meta) {
    const k = key(w.product_url);
    const s = (k && k.split('/')[0]) || store(w.store_url);
    w.on_google = k && gPages.has(k) ? 'product' : s && gShops.has(s) ? 'store' : null;
  }
}

// What speaks for a Google product besides the rules: Google gives no reach, so the closest facts to "people see it a lot",
// each a plain fact on the card (as outside the EU). ok null: not known (yet).
export const GPROOF = { copies: 3, regions: 2, reviews: 100 };
export function googleProof(r, rank) {
  const g = r.google;
  const c = g.cross || {};
  const known = r.bs && Number(r.bs.ok);
  const tp = r.tp && (r.tp.status === 'page' || r.tp.status === 'widget') ? n(r.tp.reviews) : null;
  const tpKnown = !!r.tp && ['page', 'widget', 'nopage'].includes(r.tp.status);
  const copies = n(r.scaled_count) || 1;
  const items = [
    { k: 'meta', ok: !!c.meta, text: c.meta === 'product' ? `The same product page is on the Meta board (${c.where === 'world' ? 'outside the EU' : 'EU'})` : c.meta === 'store' ? `Its shop is on the Meta board too (${c.where === 'world' ? 'outside the EU' : 'EU'})` : 'Not on the Meta board' },
    { k: 'tiktok', ok: !!c.tiktok, text: c.tiktok === 'product' ? 'The same product is on the TikTok tab' : c.tiktok === 'store' ? 'Its shop is on the TikTok tab' : 'Not on the TikTok tab' },
    { k: 'copies', ok: copies >= GPROOF.copies, text: `${copies} Google ad${copies === 1 ? '' : 's'} for this product (${GPROOF.copies}+)` },
    { k: 'regions', ok: g.regions.length >= GPROOF.regions, text: `Shown in ${g.regions.length} countr${g.regions.length === 1 ? 'y' : 'ies'} (${GPROOF.regions}+)` },
    { k: 'best', ok: known ? rank != null : null, text: !known ? 'Store best-seller list not read yet' : rank != null ? `#${rank} best seller in its store` : 'Not in its store\'s top 50' },
    { k: 'trust', ok: !tpKnown ? null : (tp ?? 0) >= GPROOF.reviews, text: !tpKnown ? 'Trustpilot not checked yet' : `${tp ?? 0} Trustpilot reviews (${GPROOF.reviews}+)` },
  ];
  return { n: items.filter((i) => i.ok).length, of: items.length, items };
}

/** The card's Google facts (toAd in app.mjs). */
export function googleFacts(r) {
  const g = r.google;
  const marks = g.rules.map((i) => ({ key: i.key, label: i.label, state: i.state, how: i.how, text: i.text }));
  return {
    verdict: g.verdict, rules: marks, checked: { exact: marks.filter((i) => i.how === 'exact' && i.state === 'ok').length, approx: marks.filter((i) => i.how === 'approx' && i.state === 'ok').length,
      unknown: marks.filter((i) => i.state === 'unknown').length },
    regions: g.regions, formats: g.formats, first_shown: g.first_shown, last_shown: g.last_shown, window: g.window, impr: g.impr, proof: r.proof || null, cross: g.cross,
    advertiser: advertiserUrl(g.advertiser_id), creative: creativeUrl(g.advertiser_id, g.creative_id), via: g.via, active: g.active,
  };
}

/** The Google products' countries, every one with products: products, shops, products that pass all four rules, the top one. */
export function googleMarketsOf(rows) {
  const m = new Map();
  for (const r of rows) {
    for (const cc of r.google.regions) {
      const k = m.get(cc) || { cc, products: 0, shops: new Set(), full: 0, top: null };
      k.products++;
      k.shops.add(String(r.product_key || '').split('/')[0]);
      if (r.google.verdict === 'winner') k.full++;
      if (!k.top || (r.proof ? r.proof.n : 0) > (k.top.proof ? k.top.proof.n : 0)) k.top = r;
      m.set(cc, k);
    }
  }
  const total = [...m.values()].reduce((a, x) => a + x.products, 0);
  const markets = [...m.values()].map((x) => ({ cc: x.cc, products: x.products, shops: x.shops.size, full: x.full, share: total ? Math.round((x.products / total) * 1000) / 10 : 0,
    top: x.top && { id: x.top.ad_id, title: String(x.top.product_title || '').slice(0, 120) } })).sort((a, b) => b.products - a.products || a.cc.localeCompare(b.cc));
  return { scope: 'google', markets, products: rows.length };
}

/** The Google hunt's banner on its tab: red when its last run failed, yellow for warnings; nothing for a run long ago (it runs by hand). */
export function googleAlert(run, now = Date.now()) {
  if (!run) return null;
  const at = Date.parse(run.finished_at || run.updated_at || run.started_at || '');
  if (Number.isFinite(at) && now - at > 7 * 864e5) return null;
  if (run.health === 'failed') return { level: 'red', text: run.alert || 'Laatste Google-hunt mislukt / Last Google hunt failed' };
  if (run.status === 'running' && Number.isFinite(at) && now - at > 3 * 3600e3) return { level: 'red', text: 'Google-hunt staat stil / The Google hunt has stopped moving' };
  if (run.health === 'warning') return { level: 'yellow', text: run.alert || 'Laatste Google-hunt had waarschuwingen / Last Google hunt had warnings' };
  return null;
}

// The CSV's Google columns: only in an export that holds Google products.
const MARK = (i) => (i.state === 'bad' ? 'fail' : i.state === 'unknown' ? 'unknown' : i.state === 'pending' ? 'pending' : i.how);
export const GOOGLE_CSV_COLS = [
  ['google_rules', (a) => (a.google ? a.google.rules.map((i) => `${i.key}:${MARK(i)}`).join(' ') : null)],
  ['google_rules_text', (a) => (a.google ? a.google.rules.map((i) => `${i.label}: ${i.text}`).join(' | ') : null)],
  ['google_all_four_checked', (a) => (a.google ? (a.google.verdict === 'winner' ? 1 : 0) : null)],
  ['google_first_shown', (a) => (a.google ? a.google.first_shown : null)],
  ['google_last_shown', (a) => (a.google ? a.google.last_shown : null)],
  ['google_regions', (a) => (a.google ? a.google.regions.join(' ') : null)],
  ['google_formats', (a) => (a.google ? a.google.formats.join(' ') : null)],
  ['google_impressions', (a) => (a.google && a.google.impr ? `${a.google.impr.lower}-${a.google.impr.upper ?? ''} ${a.google.impr.scope}` : null)],
  ['google_proof', (a) => (a.google && a.google.proof ? a.google.proof.n : null)],
  ['also_on_meta', (a) => (a.google ? a.google.cross.meta || 'no' : null)],
  ['also_on_tiktok', (a) => (a.google ? a.google.cross.tiktok || 'no' : null)],
  ['google_advertiser_url', (a) => (a.google ? a.google.advertiser : null)],
];
