// A seeded board (helpers/seed.mjs) with Google products in it, written by the real Google hunt (google.mjs) on SAMPLE DATA
// (helpers/fake-google.mjs): no real advertiser. The glow lamp's product page is on the EU Meta board too, and the projection
// lamp's shop is on the TikTok tab, so the board has products that are also on Meta / TikTok and products that are not.
import { d1Client } from '../../lib/d1.mjs';
import { googleClient } from '../../lib/google-ads.mjs';
import { hunt } from '../../google.mjs';
import { d1Rest } from './sqlite-d1.mjs';
import { googleFetch, SAMPLE_KEY } from './fake-google.mjs';
import { seededEnv, NOW, startOf } from './seed.mjs';

export const GLOW = 'glowlamp-sample.example/products/sunset-lamp';
export const POSTURE = 'posturepro-sample.example/products/posture-corrector-pro';
export const BRIGHT = 'brightly-sample.example/products/sunset-projection-lamp';

export async function googleEnv({ now = NOW } = {}) {
  const env = await seededEnv();
  const seen = new Date(now - 3600e3).toISOString();
  env.db.prepare(`INSERT INTO winners (ad_id, score, verdict, product_title, price, currency, advertiser, advertiser_page_id, active_ads, ad_age_days, ad_start_date, reach_eu, scaled_count,
    keyword, store_url, product_url, ad_library_url, image_url, first_seen, last_seen, data) VALUES ('9950', 100, 'winner', 'Glow Sunset Lamp', 44.95, 'EUR', 'Glow Lamp Co', '880', 120, 12, ?, 240000, 2,
    'lamp', 'https://glowlamp-sample.example/', 'https://glowlamp-sample.example/products/sunset-lamp', 'https://www.facebook.com/ads/library/?id=9950', '', ?, ?, '{}')`).run(startOf(12, now - 3600e3), seen, seen);
  env.db.prepare(`INSERT INTO tiktok_products (id, title, shop, url, sold_us, meta_status, ads_domain, updated_at) VALUES ('1729000000000000001', 'Sunset Projection Lamp 3 modes', 'Brightly',
    'https://www.tiktok.com/view/product/1729000000000000001', 52000, 'matched', 'brightly-sample.example', ?)`).run(seen);
  const db = d1Client({ accountId: 'a', databaseId: 'b', token: 't' }, { doFetch: d1Rest(env.db).doFetch, retryMs: 0 });
  const doFetch = googleFetch([], { now });
  const api = googleClient({ key: SAMPLE_KEY, fetch: doFetch, cap: 300, sleep: async () => {} });
  const run = await hunt({ api, db, doFetch, now: () => now, keywords: ['posture', 'lamp'], regions: ['NL', 'DE'], targets: [{ kind: 'domain', value: 'glowlamp-sample.example' }],
    boardDomains: 0, log: () => {}, shopOpts: { tries: 1 } });
  return Object.assign(env, { run });
}
