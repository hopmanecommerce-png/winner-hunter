// The sample board (seed.mjs) plus what the unit economics tests need: two EU products on one product page (each its own
// advertiser and title, so the board keeps them apart while their supplier price is one), a product outside the EU (A$79,
// Jev: a battery) and one on the TikTok tab ($55.77, big or heavy).
import { d1Client } from '../../lib/d1.mjs';
import { slimRecord } from '../../lib/record.mjs';
import { UPSERT_SQL as TIKTOK_UPSERT } from '../../lib/tiktok.mjs';
import { d1Rest } from './sqlite-d1.mjs';
import { seededEnv, sampleRecords, NOW } from './seed.mjs';

export const TT_ID = '1700000000000000001';
export const TWIN = 'eu|twin.test/products/pod';
const iso = (ms) => new Date(ms).toISOString();

export async function econEnv() {
  const env = await seededEnv();
  const client = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const twin = (id, page, title) => slimRecord(Object.assign({}, sampleRecords()[1], {
    id, product_title: title, advertiser: title + ' Shop', advertiser_page_id: page, price: 49.95, compare_at_price: null, ad_age_days: 20, ad_start_date: '2026-09-27',
    reach_eu: 400000, store_products: 12, store_url: 'https://twin.test/', product_url: 'https://twin.test/products/pod', image_url: 'https://cdn.shopify.com/twin.jpg',
  }));
  await client.upsertWinners([twin('8001', '801', 'Twin Pod A'), twin('8002', '802', 'Twin Pod B')], new Date(NOW - 3600e3));
  env.db.prepare(`INSERT INTO world_products (product_key, ad_id, active, product_title, price, currency, image_url, store_url, product_url, ad_library_url, advertiser, page_id, keyword, markets, ads, creatives, days, new14, shop_ads, store_products, first_seen, last_seen)
    VALUES ('strong.test/products/pod', '1001', 1, 'Pillow Pod', 79, 'AUD', 'https://cdn.shopify.com/1001.jpg', 'https://strong.test/', 'https://strong.test/products/pod', 'https://www.facebook.com/ads/library/?id=1001', 'Strong', '77', 'pillow',
    '{"AU":{"ads":9,"days":210,"new14":2},"NZ":{"ads":3,"days":90,"new14":1}}', 12, 4, 210, 3, 89, 12, ?, ?)`).run(iso(NOW - 5 * 864e5), iso(NOW - 3600e3));
  env.db.prepare("INSERT INTO world_checks (product_key, model, input, people, animals, gymwear, physical, category, checked_at, version, main, sub, answers) VALUES ('strong.test/products/pod', 'jev', 'photo', 0.01, 0.01, 0.01, 0.98, 'Home', 'x', 2, 'Home', 'Bedding', ?)")
    .run(JSON.stringify({ p: { people: 0.01, animals: 0.01, gymwear: 0.01, physical: 0.98, electric: 0.9 }, choices: {} }));
  await env.DB.prepare(TIKTOK_UPSERT).bind(JSON.stringify([{ id: TT_ID, title: '【Black Friday】 Rhino Straps', shop: 'Rhino Shop', url: 'https://www.tiktok.com/shop/pdp/1', image_url: 'https://cdn.shopify.com/tt1.jpg', price_min: 55.77, price_max: 55.77, rating: 4.6,
    reviews: 120, sold_us: 152000, creators: 5, plays: 1000000, category: 'Car', blockers: 'bulky', meta_status: 'none', meta_url: null, meta_unsure: 0, meta_us: null, meta_au: null, meta_nz: null, updated_at: '2026-10-16T10:00:00Z' }])).run();
  return env;
}
