// A board with momentum: the seeded EU board (seed.mjs) plus products outside the EU and on the TikTok tab whose numbers
// move over 8 days, and the real momentum job (momentum.mjs) run on four of those days against the same in-memory D1.
import { d1Client } from '../../lib/d1.mjs';
import { UPSERT_SQL as TIKTOK_UPSERT } from '../../lib/tiktok.mjs';
import { run } from '../../momentum.mjs';
import { d1Rest } from './sqlite-d1.mjs';
import { seededEnv, NOW } from './seed.mjs';

export const DAY = 864e5;
const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => iso(ms).slice(0, 10);
// An AliExpress photo id, as stores that import the same listing keep it in the file name.
export const SUPPLIER = 'S4f2a7c3b1d9e4f0a8b6c5d4e3f2a1b0cQ';
export const RISER = 'world|riser.test/products/neck-fan';
export const FALLER = 'world|faller.test/products/sunset-lamp';
export const STEADY = 'world|steady.test/products/dog-mat';
export const GONE = 'world|gone.test/products/old-gadget';
export const TT_UP = '1700000000000000101';
export const TT_DOWN = '1700000000000000102';

const product = (key, id, o) => ({ product_key: key, ad_id: id, active: 1, product_title: 'Product ' + id, price: 49, compare_at_price: 89, currency: 'AUD', image_url: `https://cdn.shopify.com/s/files/1/${id}.jpg`,
  store_url: `https://${key.split('/')[0]}/`, product_url: `https://${key}`, ad_library_url: `https://www.facebook.com/ads/library/?id=${id}`, advertiser: 'Shop ' + id, page_id: '7' + id, likes: 900, keyword: 'fan',
  markets: '{"AU":{"ads":3,"days":40,"new14":1}}', ads: 3, creatives: 2, days: 40, new14: 1, shop_ads: 80, in_eu: null, store_products: 12,
  first_seen: iso(NOW - 30 * DAY), last_seen: iso(NOW - 3600e3), ...o });

/** The numbers of the moving products on day `ago` (8 … 0 days before NOW). */
function day(env, ago) {
  const set = (key, o) => env.db.prepare(`UPDATE world_products SET ${Object.keys(o).map((k) => `${k} = ?`).join(', ')} WHERE product_key = ?`).run(...Object.values(o), key);
  const k = 8 - ago; // 0 … 8
  set('riser.test/products/neck-fan', { ads: 3 + k, new14: Math.min(6, 1 + k), shop_ads: 80 + 5 * k, markets: JSON.stringify(k > 4 ? { AU: { ads: 2 + k, days: 70, new14: 3 }, NZ: { ads: 1, days: 9, new14: 1 } } : { AU: { ads: 3 + k, days: 70, new14: 2 } }) });
  set('faller.test/products/sunset-lamp', { ads: Math.max(2, 14 - k), new14: 0, shop_ads: 140 - 6 * k });
  set('gone.test/products/old-gadget', { active: ago <= 1 ? 0 : 1 });
}

/**
 * The env (Worker binding DB, PIN, the sqlite db) after the job ran on 8, 5, 2 and 0 days before NOW, and each run's record.
 * opts.hasher: photo fingerprints (default: none, as a runner without Chrome).
 */
export async function momentumEnv({ hasher = null } = {}) {
  const env = await seededEnv();
  const put = (p) => env.db.prepare(`INSERT INTO world_products (${Object.keys(p).join(',')}) VALUES (${Object.keys(p).map(() => '?').join(',')})`).run(...Object.values(p));
  put(product('riser.test/products/neck-fan', '2001', { product_title: 'Bladeless Neck Fan', image_url: `https://cdn.shopify.com/s/files/1/0001/files/${SUPPLIER}.jpg?v=1`, days: 70 }));
  put(product('faller.test/products/sunset-lamp', '2002', { product_title: 'Sunset Projection Lamp', days: 50 }));
  put(product('steady.test/products/dog-mat', '2003', { product_title: 'Cooling Dog Mat', ads: 6, new14: 0, days: 33 }));
  put(product('gone.test/products/old-gadget', '2004', { product_title: 'Old Gadget Holder', days: 20 }));
  // Rivals of the riser: the same words (one new this week), and one with the supplier's photo under another name.
  put(product('rival-one.test/products/fan', '2005', { product_title: 'Portable Neck Fan Bladeless USB', first_seen: iso(NOW - 3 * DAY) }));
  put(product('rival-two.test/products/neck-fan-2', '2006', { product_title: 'Neck Fan Bladeless Hanging' }));
  put(product('rival-three.test/products/cooler', '2007', { product_title: 'Personal Cooler', image_url: `https://cdn.shopify.com/s/files/1/0099/products/${SUPPLIER}_1a2b3c4d-1111-2222-3333-444455556666.jpg?v=9` }));
  // How long their ads ran (world_ads: Meta's start date and the last time the hunt saw it).
  const ad = env.db.prepare('INSERT INTO world_ads (ad_id, cc, product_key, start_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)');
  ad.run('a1', 'AU', 'riser.test/products/neck-fan', Math.floor((NOW - 70 * DAY) / 1000), iso(NOW - 40 * DAY), iso(NOW - DAY));
  ad.run('a2', 'AU', 'riser.test/products/neck-fan', Math.floor((NOW - 35 * DAY) / 1000), iso(NOW - 20 * DAY), iso(NOW - DAY));
  ad.run('a3', 'AU', 'faller.test/products/sunset-lamp', Math.floor((NOW - 50 * DAY) / 1000), iso(NOW - 30 * DAY), iso(NOW - 12 * DAY));
  // Store best sellers: the riser climbs, the faller leaves the top 50 (the store signals' own 15-day history).
  const bs = env.db.prepare('INSERT INTO bestseller (product_key, store, rank, ok, checked_at, history) VALUES (?, ?, ?, 1, ?, ?)');
  bs.run('riser.test/products/neck-fan', 'riser.test', 6, iso(NOW - 3600e3), JSON.stringify([[dayOf(NOW - 9 * DAY), 20], [dayOf(NOW - 7 * DAY), 15], [dayOf(NOW - 3 * DAY), 9], [dayOf(NOW), 6]]));
  bs.run('faller.test/products/sunset-lamp', 'faller.test', null, iso(NOW - 3600e3), JSON.stringify([[dayOf(NOW - 9 * DAY), 8], [dayOf(NOW - 7 * DAY), 12], [dayOf(NOW), null]]));
  // The gone product was approved (✓): it stays tracked after its ads stop.
  env.db.prepare("INSERT INTO hidden (ad_id, status, at) VALUES ('2004', 'seen', ?)").run(iso(NOW - 2 * DAY));
  const client = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const tiktok = (soldUp, soldDown, at) => env.DB.prepare(TIKTOK_UPSERT).bind(JSON.stringify([
    { id: TT_UP, title: '【Hot】 Magnetic Phone Holder Car Mount', shop: 'Mount Co', url: 'https://www.tiktok.com/shop/pdp/101', image_url: 'https://cdn.shopify.com/tt101.jpg', price_min: 19.99, price_max: 19.99, rating: 4.7,
      reviews: 900, sold_us: soldUp, creators: 40, plays: 9000000, category: 'Car', blockers: '', meta_status: 'none', meta_url: null, meta_unsure: 0, meta_us: null, meta_au: null, meta_nz: null, updated_at: at },
    { id: TT_DOWN, title: 'Wrinkle Release Spray Travel Size', shop: 'Fresh Co', url: 'https://www.tiktok.com/shop/pdp/102', image_url: 'https://cdn.shopify.com/tt102.jpg', price_min: 12.5, price_max: 12.5, rating: 4.1,
      reviews: 300, sold_us: soldDown, creators: 4, plays: 100000, category: 'Home', blockers: '', meta_status: 'none', meta_url: null, meta_unsure: 0, meta_us: null, meta_au: null, meta_nz: null, updated_at: at },
  ])).run();
  const records = [];
  for (const ago of [8, 5, 2, 0]) {
    day(env, ago);
    // TikTok imports on three of those days: the first product sells faster and faster, the second hardly at all.
    if (ago === 8) await tiktok(50000, 400000, iso(NOW - 8 * DAY));
    if (ago === 5) await tiktok(56000, 400300, iso(NOW - 5 * DAY));
    if (ago === 0) await tiktok(80000, 400400, iso(NOW - 2 * 3600e3));
    records.push(await run({ db: client, now: () => NOW - ago * DAY, log: () => {}, hasher }));
  }
  return Object.assign(env, { client, records });
}
