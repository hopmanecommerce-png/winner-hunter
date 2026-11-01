// The 36 approved products of test/fixtures/approved-36.json in a D1 from seededEnv(), stored as the hunts store them:
// EU products as winners that pass the board's rules (Jev's answers under 'eu|<page>|<title>'), the ones outside the EU in
// world_products (Jev's answers under their product key), the TikTok ones in tiktok_products.
import fs from 'node:fs';
import { UPSERT_SQL as TIKTOK_UPSERT } from '../../lib/tiktok.mjs';

export const APPROVED = JSON.parse(fs.readFileSync(new URL('../fixtures/approved-36.json', import.meta.url), 'utf8')).products;
const iso = (ms) => new Date(ms).toISOString();
const keyOfUrl = (u) => u.replace(/^https:\/\//, '');

/** The radar's input for a fixture product, as the board would build it (fromAd / fromTikTok in risk.mjs read these fields). */
export const cardOf = (p) => (p.source === 'tiktok'
  ? { id: p.id, title: p.title, url: 'https://www.tiktok.com/shop/pdp/' + p.id, blockers: p.blockers, cat: p.cat, p: p.price, shop: 'Shop ' + p.n }
  : { id: idOf(p), title: p.title, product: p.product, store: p.store, copy: p.copy || '', jev: p.jev ? { ...p.jev } : null, price: p.price, cur: p.cur, world: p.source === 'world' ? {} : null });
/** The ad id a fixture product gets on the board. */
export const idOf = (p) => (p.source === 'tiktok' ? p.id : String((p.source === 'eu' ? 8000 : 7000) + p.n));

/**
 * Loads them. approve: which ones are approved (✓, or Approved on the TikTok tab): 'all', 'board' (EU and outside the EU,
 * not TikTok) or 'none'. Call it before the first request: the board keeps what it read.
 */
export async function loadApproved(env, now, { approve = 'all' } = {}) {
  const db = env.db;
  const putEu = db.prepare(`INSERT INTO winners (ad_id, product_title, price, currency, advertiser, advertiser_page_id, active_ads, ad_age_days, ad_start_date, reach_eu,
    scaled_count, keyword, store_url, product_url, ad_library_url, image_url, first_seen, last_seen, data) VALUES (?, ?, ?, ?, ?, ?, 120, 20, '2026-09-27', 400000, 4, 'risk', ?, ?, ?, ?, ?, ?, ?)`);
  const jevEu = db.prepare(`INSERT INTO world_checks (product_key, model, input, people, animals, gymwear, physical, category, checked_at, version, main, sub, answers)
    SELECT 'eu|' || advertiser_page_id || '|' || lower(trim(product_title)), 'jev-1.14.0', 'photo', ?, ?, ?, ?, ?, 'x', 2, ?, ?, ? FROM winners WHERE ad_id = ?`);
  const putWorld = db.prepare(`INSERT INTO world_products (product_key, ad_id, active, product_title, price, currency, image_url, store_url, product_url, ad_library_url, advertiser,
    page_id, keyword, markets, ads, creatives, days, new14, shop_ads, store_products, first_seen, last_seen) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'risk', ?, 6, 2, 60, 1, 90, 25, ?, ?)`);
  const jevWorld = db.prepare(`INSERT INTO world_checks (product_key, model, input, people, animals, gymwear, physical, category, checked_at, version, main, sub, answers)
    VALUES (?, 'jev-1.14.0', 'photo', ?, ?, ?, ?, ?, 'x', 2, ?, ?, ?)`);
  const tiktok = [];
  for (const p of APPROVED) {
    const id = idOf(p);
    const jevArgs = p.jev ? [p.jev.p.people, p.jev.p.animals, p.jev.p.gymwear, p.jev.p.physical, p.jev.main, p.jev.main, p.jev.sub, JSON.stringify({ p: p.jev.p, choices: {} })] : null;
    if (p.source === 'eu') {
      putEu.run(id, p.title, p.price, p.cur, 'Advertiser ' + p.n, String(800 + p.n), p.store, p.product, 'https://www.facebook.com/ads/library/?id=' + id,
        `https://cdn.shopify.com/s/files/1/r${p.n}.jpg`, iso(now - 3 * 864e5), iso(now - 3600e3), JSON.stringify({ ad_copy: p.copy || '', top_countries: 'NL 60%, DE 40%' }));
      if (jevArgs) jevEu.run(...jevArgs, id);
    } else if (p.source === 'world') {
      const key = keyOfUrl(p.product);
      putWorld.run(key, id, p.title, p.price, p.cur, `https://cdn.shopify.com/s/files/1/r${p.n}.jpg`, p.store, p.product, 'https://www.facebook.com/ads/library/?id=' + id,
        'Shop ' + p.n, String(600 + p.n), JSON.stringify({ AU: { ads: 4, days: 60, new14: 1 }, US: { ads: 2, days: 45, new14: 0 } }), iso(now - 3 * 864e5), iso(now - 3600e3));
      if (jevArgs) jevWorld.run(key, ...jevArgs);
    } else {
      tiktok.push({ id, title: p.title, shop: 'Shop ' + p.n, url: 'https://www.tiktok.com/shop/pdp/' + id, image_url: `https://cdn.shopify.com/tt${p.n}.jpg`, price_min: p.price, price_max: p.price,
        rating: 4.7, reviews: 300, sold_us: 50000 + p.n, creators: 12, plays: 2000000, category: p.cat, blockers: p.blockers, meta_status: 'none', meta_url: null, meta_unsure: 0,
        meta_us: null, meta_au: null, meta_nz: null, updated_at: '2026-10-16T10:00:00Z', video_url: null, sold_mixed: 0, price_suspect: 0, ads_mention_n: null, ads_mention_of: null,
        ads_domain: null, meta_label: null });
    }
  }
  await env.DB.prepare(TIKTOK_UPSERT).bind(JSON.stringify(tiktok)).run();
  const seen = db.prepare("INSERT INTO hidden (ad_id, status, at) VALUES (?, 'seen', ?)");
  APPROVED.forEach((p, i) => {
    const at = iso(now - 3600e3 + i * 1000);
    if (p.source === 'tiktok') { if (approve === 'all') db.prepare("UPDATE tiktok_products SET decision = 'approved', decided_at = ? WHERE id = ?").run(at, p.id); }
    else if (approve === 'all' || approve === 'board') seen.run(idOf(p), at);
  });
}
