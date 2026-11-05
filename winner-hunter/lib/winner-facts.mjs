/*
 * The facts the Winner Score reads (lib/winner-score.mjs), built from the board's own tables: the EU board (winners, one card
 * per product page as the board groups them), outside the EU (world_products), the TikTok tab, the store signals (bestseller,
 * store_trust), Jev's answers (world_checks), momentum and Connor's decisions (hidden, feedback, decision_log).
 *
 * Pure: it takes rows (from D1 or a local copy, the same columns) and returns plain objects. tablesFrom(db) reads them with
 * any client that has query(sql, params) → rows: lib/d1.mjs on GitHub, localDb (below) on a copy.
 */
import { productKey, movement } from './bestsellers.mjs';
import { scoreOf as momentumScore } from '../worker/src/momentum.mjs';

const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const json = (s, d = null) => {
  if (s == null || s === '') return d;
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return d;
  }
};
const hostOf = (u) => {
  const m = /^https?:\/\/([^/?#:]+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase().replace(/^www\d?\./, '') : '';
};
/** The board's EU key parts: jk (advertiser page + title, Jev's key) and gk (product page, else jk), as app.mjs. */
export const jkOf = (w) => `${w.advertiser_page_id || ''}|${String(w.product_title || w.ad_id || '').trim().toLowerCase()}`;
export const gkOf = (w) => productKey(w.product_url) || jkOf(w);
/** Top countries "FR 91%, BE 9%" → ['FR', 'BE']. */
const countriesOf = (s) => [...String(s || '').matchAll(/\b([A-Z]{2}) \d{1,3}%/g)].map((m) => m[1]);

/** Jev's answers on one product (a world_checks row): { p, main, sub, product_score, ad_score, checked_at } or null. */
export function jevOf(c) {
  if (!c) return null;
  const a = json(c.answers, {});
  const p = a && a.p && typeof a.p === 'object' ? { ...a.p } : {};
  for (const k of ['people', 'animals', 'gymwear', 'physical']) if (p[k] == null && num(c[k]) != null) p[k] = num(c[k]);
  return { p, main: c.main || c.category || '', sub: c.sub || '', product_score: num(c.product_score), ad_score: num(c.ad_score), checked_at: c.checked_at || null,
    audience: a && a.choices ? a.choices.audience || null : null };
}

/** Best-seller facts for a product page key: rank, checked, ok, move (positions up in about a week). */
function bestOf(best, key) {
  const b = key ? best.get(key) : null;
  if (!b) return {};
  const h = json(b.history, []);
  const mv = movement(h);
  const move = mv && mv.from != null && mv.to != null ? mv.from - mv.to : mv && mv.from == null && mv.to != null ? 50 - mv.to : null;
  return { bs_rank: num(b.rank), bs_ok: b.ok === 1 || b.ok === true, bs_checked: String(b.checked_at || '').slice(0, 10) || null, bs_move: move };
}
function trustOf(trust, url) {
  const t = trust.get(hostOf(url));
  if (!t || t.status === 'nopage') return {};
  return { tp_reviews: num(t.reviews), tp_score: num(t.score), tp_checked: String(t.checked_at || '').slice(0, 10) || null };
}

/**
 * EU board products: the ads grouped by product page (else advertiser + title), as the board shows them. The best ad (most
 * EU reach a day) gives the title, price and links; counts are the most any ad of the product shows.
 */
export function euFacts(winners, { best = new Map(), trust = new Map(), checks = new Map(), momentum = new Map() } = {}) {
  const groups = new Map();
  for (const w of winners) {
    const gk = gkOf(w);
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = []));
    g.push(w);
  }
  const out = [];
  for (const [gk, ads] of groups) {
    const rpd = (w) => num(w.reach_eu) / Math.max(num(w.ad_age_days) || 0, 1);
    ads.sort((a, b) => rpd(b) - rpd(a) || (a.ad_id < b.ad_id ? -1 : 1));
    const top = ads[0];
    const d = json(top.data, {});
    const pk = productKey(top.product_url);
    const jev = ads.map((w) => checks.get('eu|' + jkOf(w))).find(Boolean);
    const key = 'eu|' + gk;
    const m = momentum.get(key) || momentum.get('eu|' + jkOf(top)) || null;
    const priced = ads.find((w) => num(w.price) > 0) || top;
    out.push({
      key, src: 'eu', ad_id: top.ad_id, ad_ids: ads.map((w) => w.ad_id), title: top.product_title || d.product_title || '', name: top.product_title || '',
      store: hostOf(top.store_url), store_url: top.store_url || '', product_url: top.product_url || '', image: top.image_url || '',
      price: num(priced.price), cur: priced.currency || 'EUR', compare_at: num(priced.compare_at_price),
      ad_days: Math.max(...ads.map((w) => num(w.ad_age_days) || 0)), copies: Math.max(...ads.map((w) => num(w.scaled_count) || 0)), ads_n: ads.length,
      shop_ads: Math.max(...ads.map((w) => num(w.active_ads) || 0)) || null, shop_ads_capped: ads.some((w) => num(w.active_ads) >= 500),
      reach_day: Math.max(...ads.map(rpd)), store_products: num(d.store_products), markets: countriesOf(d.top_countries), markets_n: null,
      ...bestOf(best, pk), ...trustOf(trust, top.store_url), jev: jevOf(jev), product_page: !!pk,
      momentum: m ? num(m.score) : null, momentum_day: m ? m.day || null : null, rivals: m ? num(m.rivals) : null, rivals_new: m ? num(m.rivals_new) : null,
      links: { ad_library: top.ad_library_url || '' }, keyword: top.keyword || '', as_of: String(top.last_seen || '').slice(0, 10),
    });
  }
  return out;
}

/** Products outside the EU (world_products): one row per product page already. */
export function worldFacts(rows, { best = new Map(), trust = new Map(), checks = new Map(), momentum = new Map() } = {}) {
  return rows.map((w) => {
    const mk = json(w.markets, {}) || {};
    const markets = Object.keys(mk);
    const key = 'world|' + w.product_key;
    const m = momentum.get(key) || null;
    return {
      key, src: 'world', ad_id: w.ad_id, ad_ids: [w.ad_id], title: w.product_title || '', name: w.product_title || '', store: hostOf(w.store_url),
      store_url: w.store_url || '', product_url: w.product_url || '', image: w.image_url || '', price: num(w.price), cur: w.currency || 'USD', compare_at: num(w.compare_at_price),
      ad_days: num(w.days), copies: num(w.ads), ads_n: num(w.ads), creatives: num(w.creatives), new14: num(w.new14), shop_ads: num(w.shop_ads),
      reach_day: num(w.eu_rpd) > 0 ? num(w.eu_rpd) : null, in_eu: w.in_eu === 1 || w.in_eu === true, store_products: num(w.store_products), markets, markets_n: markets.length || null,
      ...bestOf(best, w.product_key), ...trustOf(trust, w.store_url), jev: jevOf(checks.get(w.product_key) || checks.get(key)), active: w.active !== 0,
      momentum: m ? num(m.score) : null, momentum_day: m ? m.day || null : null, rivals: m ? num(m.rivals) : null, rivals_new: m ? num(m.rivals_new) : null,
      links: { ad_library: w.ad_library_url || '' }, keyword: w.keyword || '', as_of: String(w.last_seen || '').slice(0, 10),
    };
  });
}

/**
 * TikTok products, from the product-proof export (research 2026-11-01) or the TikTok tab: sold counts are TikTok's own
 * lifetime numbers. Meta numbers are per page, not per product (a judgement that the page is this shop).
 */
export function tiktokFacts(rows) {
  // A brand's own catalogue (VEVOR, Bedsure): the shop's name in the title of many of its listings. Selling the product type is
  // still open; that listing's numbers are the brand's (estimate: a word match, as the product-proof run's own check).
  const perShop = new Map();
  for (const t of rows) perShop.set(t.shop || '', (perShop.get(t.shop || '') || 0) + 1);
  const STOP = new Set(['store', 'shop', 'official', 'home', 'the', 'and', 'life', 'living', 'direct', 'outlet', 'mall', 'brand', 'global', 'usa', 'us', 'llc', 'inc', 'co']);
  const shopWords = (shop) => String(shop || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
  // The TikTok tab's table (tiktok_products) names its columns differently from the research export: read either.
  const shape = (t0) => ('sold_us' in t0 || 'price_min' in t0 ? { ...t0, product_id: t0.id, sold: t0.sold_us, price_usd: t0.price_min, tiktok_url: t0.url, jev_blockers: t0.blockers,
    jev_category: t0.category, meta_ads_us: t0.meta_us, meta_ads_au: t0.meta_au, meta_ads_nz: t0.meta_nz, meta_ads_total: t0.meta_ads_total ?? (num(t0.meta_us) || 0) + (num(t0.meta_au) || 0) + (num(t0.meta_nz) || 0),
    ad_library_url: t0.meta_url, sold_may_include_non_us: t0.sold_mixed ? 'true' : 'false', price_suspect: t0.price_suspect ? 'true' : 'false', as_of: String(t0.updated_at || '').slice(0, 10) } : t0);
  // Brand shops and brand lines, per shop (estimates, word matches): a shop that puts its own name in any title is a brand
  // shop for all its listings (KastKingUSA's "50L BaitSpace …" names no brand); a brand-like word (CamelCase: MotorBox) that
  // starts 2+ titles of one shop is a brand line.
  const tokensOf = (title) => String(title || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const namedIn = (shop, title) => { const tk = tokensOf(title); return shopWords(shop).some((w) => tk.some((x) => x === w || (w.startsWith(x) && x.length >= 5) || (x.startsWith(w) && w.length >= 5))); };
  const CAMEL = /^\p{Lu}?\p{Ll}+\p{Lu}[\p{L}\p{N}]*$/u;
  const brandShops = new Set();
  const lines = new Map();
  for (const t0 of rows) {
    const t = shape(t0);
    const shop = t.shop || '';
    if (shop && namedIn(shop, t.title)) brandShops.add(shop);
    const first = String(t.title || '').replace(/【[^】]*】|\[[^\]]*\]/g, ' ').trim().split(/\s+/).slice(0, 2).find((w) => CAMEL.test(w.replace(/[^\p{L}\p{N}]/gu, '')));
    if (shop && first) {
      const k = shop + '\u0001' + first.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
      lines.set(k, (lines.get(k) || 0) + 1);
    }
  }
  return rows.map((t0) => {
    const t = shape(t0);
    const ads = { US: num(t.meta_ads_us), AU: num(t.meta_ads_au), NZ: num(t.meta_ads_nz), CA: num(t.meta_ads_ca) };
    const matched = t.meta_status === 'matched';
    const markets = matched ? Object.entries(ads).filter(([, n]) => n > 0).map(([c]) => c) : [];
    const blockers = String(t.jev_blockers || '').split(/[\s,]+/).filter(Boolean);
    const id = String(t.product_id || t.id || '');
    // A shop word in the title, also glued ("KastKingUSA" sells "KastKing …", "Ridge Shop" sells "Ridge …").
    const named = namedIn(t.shop, t.title);
    const first = String(t.title || '').replace(/【[^】]*】|\[[^\]]*\]/g, ' ').trim().split(/\s+/).slice(0, 2).find((w) => CAMEL.test(w.replace(/[^\p{L}\p{N}]/gu, '')));
    const line = first && (lines.get((t.shop || '') + '\u0001' + first.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()) || 0) >= 2 ? first.replace(/[^\p{L}\p{N}]/gu, '') : '';
    // On TikTok Shop the shop's own name in the title is how brands list (Ridge, KastKing, Bedsure): a brand listing.
    const brandOwned = !!t.brand_group || !!t.title_brand || named || brandShops.has(t.shop || '') || !!line;
    // Meta numbers belong to the shop's page; they say something about this product only when a sampled ad names it.
    const named_ads = num(t.ads_mention_n);
    return {
      brand_owned: brandOwned, brand_note: brandOwned ? (t.brand_group ? 'brand group ' + t.brand_group : t.title_brand ? 'brand ' + t.title_brand : named ? `the shop's name (${t.shop}) is in the title`
        : line ? `a brand line (${line}) of the shop ${t.shop}` : `a listing of the brand shop ${t.shop}`) : '',
      page_level: matched && !(named_ads > 0), ads_named: named_ads,
      key: 'tiktok|' + id, id, src: 'tiktok', title: t.title || '', name: t.title || '', shop: t.shop || '', store: hostOf(t.store_url) || (t.shop ? 'tiktok shop ' + String(t.shop).toLowerCase() : ''), store_url: t.store_url || '',
      product_url: t.tiktok_url || '', tiktok_url: t.tiktok_url || '', image: t.image_url || '', price: t.price_suspect === 'true' ? null : num(t.price_usd), cur: 'USD',
      sold: num(t.sold), sold_note: t.sold_may_include_non_us === 'true' || t.sold_may_include_non_us === true ? 'may include non-US sales' : '',
      reviews: num(t.reviews), rating: num(t.rating),
      shop_ads: matched ? num(t.meta_ads_total) : null, ad_days: matched ? num(t.meta_oldest_ad_days) : null, new14: matched ? num(t.meta_new_ads_14d) : null,
      ads_n: matched ? num(t.meta_ads_total) : null, markets, markets_n: markets.length || null,
      gap: matched ? !(ads.AU > 0 || ads.NZ > 0) : null, gap_markets: 'AU and NZ',
      jev: { p: Object.fromEntries(blockers.map((b) => [b, 1])), blockers: blockers.join(' '), main: t.jev_category || t.category || '', sub: t.jev_subcategory || '' },
      excluded: t.exclusion_reason || '', price_suspect: t.price_suspect === 'true', brand: t.title_brand || '',
      links: { ad_library: matched ? t.ad_library_url || '' : '' }, as_of: t.as_of || '',
    };
  });
}

/**
 * Connor's decisions, one per product (the newest wins): y 1 = approved, kept or made an ad, 0 = rejected. From the board's
 * hidden table (seen = ✓, rejected = ✗), stars (★) and the decision log when it is there. byAd: ad id → product key.
 */
export function decisionsOf({ hidden = [], stars = [], log = [], tiktok = [] }, byAd = new Map()) {
  const out = new Map();
  const put = (key, y, at, from) => {
    if (!key) return;
    const o = out.get(key);
    if (!o || String(at) >= String(o.at)) out.set(key, { key, y, at: String(at || ''), from });
  };
  for (const h of hidden) put(byAd.get(h.ad_id), h.status === 'rejected' ? 0 : 1, h.at, 'hidden:' + h.status);
  for (const s of stars) put(byAd.get(s.ad_id), 1, s.at, 'star');
  for (const d of log) {
    const what = d.decision || d.action || '';
    const y = /approve|made|keep|launch/i.test(what) ? 1 : /reject/i.test(what) ? 0 : null;
    if (y == null || d.undone_at) continue;
    put(d.product_key || byAd.get(d.ad_id), y, d.at, 'log:' + what);
  }
  for (const t of tiktok) {
    const y = t.decision === 'approved' ? 1 : t.decision === 'rejected' ? 0 : null;
    if (y != null) put('tiktok|' + t.id, y, t.decided_at || t.updated_at, 'tiktok:' + t.decision);
  }
  return [...out.values()];
}

/** Ad id → product key for every EU ad and outside-EU product (the keys decisions are made on). */
export function adIndex(winners, world) {
  const m = new Map();
  for (const w of winners) m.set(w.ad_id, 'eu|' + gkOf(w));
  for (const w of world) m.set(w.ad_id, 'world|' + w.product_key);
  return m;
}

/** Every row of a query, a slice at a time by rowid (one big D1 answer can fail; as momentum.mjs). sql: SELECT rowid AS rid, … FROM t. */
export async function allRows(db, sql, size = 2000) {
  const out = [];
  for (let last = 0; ;) {
    const part = await db.query(`${sql} WHERE rowid > ?1 ORDER BY rowid LIMIT ${size}`, [last]);
    out.push(...part);
    if (part.length < size) return out;
    last = part[part.length - 1].rid;
  }
}

// The EU ads with the two fields of their JSON the score reads (not the ad text: a fraction of the bytes).
export const WINNERS_SQL = `SELECT rowid AS rid, ad_id, product_title, price, compare_at_price, currency, advertiser, advertiser_page_id, active_ads, ad_age_days, ad_start_date,
  reach_eu, scaled_count, keyword, store_url, product_url, ad_library_url, image_url, first_seen, last_seen,
  CASE WHEN json_valid(data) THEN json_object('store_products', json_extract(data, '$.store_products'), 'top_countries', json_extract(data, '$.top_countries')) END AS data FROM winners`;

/** Read the tables the facts need, with any client that has query(sql, params). A missing table is an empty list. */
export async function tablesFrom(db, { tiktok = true } = {}) {
  const q = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (/no such table|no such column/i.test(String(e && e.message))) return [];
      throw e;
    }
  };
  const slices = (sql) => q(() => allRows(db, sql));
  const one = (sql) => q(() => db.query(sql));
  const winners = await slices(WINNERS_SQL);
  const bestseller = await slices('SELECT rowid AS rid, product_key, rank, ok, checked_at, history FROM bestseller');
  const trust = await slices('SELECT rowid AS rid, store, status, score, reviews, checked_at FROM store_trust');
  const world = await slices('SELECT rowid AS rid, * FROM world_products');
  const checks = await slices('SELECT rowid AS rid, product_key, people, animals, gymwear, physical, category, main, sub, product_score, ad_score, answers, checked_at FROM world_checks');
  const tk = tiktok ? await slices('SELECT rowid AS rid, * FROM tiktok_products') : [];
  const [hidden, stars, log, mom, inputs, sourcing, launches, pipeline, settings] = await Promise.all([
    one('SELECT ad_id, status, at FROM hidden'), one('SELECT ad_id, at FROM stars'), one('SELECT product_key, ad_id, decision, at, undone_at FROM decision_log'),
    one("SELECT key, body FROM momentum WHERE (key >= 'board:' AND key < 'board;') OR (key >= 'tiktok:' AND key < 'tiktok;')"),
    one('SELECT product_key, cost, cost_text, weight_g, price FROM econ_inputs'), one('SELECT product_key, supplier_cost, weight_g, ship_cost FROM product_sourcing'),
    one('SELECT product_key, decision, updated_at FROM launches'), one('SELECT product_key, stage, outcome, updated_at FROM pipeline_items'),
    one("SELECT value FROM econ_settings WHERE key = 'settings'"),
  ]);
  return { winners, bestseller, trust, world, checks, hidden, stars, log, momentum: mom, tiktok: tk, inputs, sourcing, launches, pipeline, econSettings: settings.length ? json(settings[0].value, null) : null };
}

/** Lookup maps for the facts builders. */
export function mapsOf(t) {
  // Momentum summaries (momentum.mjs, D1 table momentum, parts board:NN and tiktok:NN): the board's own score of each.
  const momentum = new Map();
  for (const r of t.momentum || []) {
    const body = json(r.body, null);
    const items = body && body.p && typeof body.p === 'object' ? body.p : {};
    for (const [k, mo] of Object.entries(items)) {
      if (!mo || typeof mo !== 'object') continue;
      const s = momentumScore(mo);
      momentum.set(k, { score: s && s.label !== 'new' ? s.m : null, label: s ? s.label : null, rivals: num(mo.r), rivals_new: num(mo.rn), day: body.day || mo.d || null });
    }
  }
  return {
    best: new Map((t.bestseller || []).map((b) => [b.product_key, b])),
    trust: new Map((t.trust || []).map((s) => [s.store, s])),
    checks: new Map((t.checks || []).map((c) => [c.product_key, c])),
    momentum,
  };
}

/**
 * Connor's own numbers on a product, as the board's € view uses them: a supplier price, weight or selling price he typed
 * (econ_inputs), else the supplier he chose in Sourcing (product_sourcing). They replace the guesses in the margin.
 */
export function withInputs(facts, { inputs = [], sourcing = [] } = {}) {
  const typed = new Map(inputs.map((r) => [r.product_key, r]));
  const chosen = new Map(sourcing.map((r) => [r.product_key, r]));
  for (const f of facts) {
    const i = typed.get(f.key);
    const c = chosen.get(f.key);
    if (i && (i.cost_text || num(i.cost) != null)) f.supplier_cost_text = i.cost_text || String(i.cost);
    else if (c && num(c.supplier_cost) != null) {
      f.supplier_cost_text = '€' + num(c.supplier_cost);
      f.supplier_from = 'sourcing';
    }
    if (i && num(i.weight_g) != null) f.weight_g = num(i.weight_g);
    else if (c && num(c.weight_g) != null) f.weight_g = num(c.weight_g);
    if (c && num(c.ship_cost) != null) f.ship_eur = num(c.ship_cost);
    if (i && num(i.price) != null) f.my_price = num(i.price);
  }
  return facts;
}

/** Every product the score can read, from the tables: { facts, decisions, byAd, decided }. */
export function factsFrom(t, { tiktokRows = null } = {}) {
  const maps = mapsOf(t);
  const eu = euFacts(t.winners || [], maps);
  const world = worldFacts(t.world || [], maps);
  const tk = tiktokFacts(tiktokRows || t.tiktok || []);
  withInputs([...eu, ...world, ...tk], t);
  const byAd = adIndex(t.winners || [], t.world || []);
  const decisions = decisionsOf({ hidden: t.hidden, stars: t.stars, log: t.log, tiktok: t.tiktok }, byAd);
  // Decided in any way: approved, rejected, kept, a launch card, a pipeline item (never a daily pick again).
  const decided = new Set([...decisions.map((d) => d.key), ...(t.launches || []).map((l) => l.product_key), ...(t.pipeline || []).map((p) => p.product_key)]);
  return { facts: [...eu, ...world, ...tk], eu, world, tiktok: tk, decisions, byAd, decided };
}

/** A read-only client on a local SQLite copy with the same query(sql, params) → rows as lib/d1.mjs (Node 22.5+). */
export async function localDb(path) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { readOnly: true });
  return { query: async (sql, params = []) => db.prepare(sql).all(...params).map((r) => ({ ...r })), close: () => db.close() };
}
