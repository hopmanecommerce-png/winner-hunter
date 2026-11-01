// AI reads on the seeded board (seed.mjs), for the board's AI read tests: two answered, one flagged, one being asked
// again, one tampered with (not the schema) and one never answered, plus one product outside the EU.
import { seededEnv, NOW } from './seed.mjs';

const iso = (ms) => new Date(ms).toISOString();
export const READ = { injection_suspected: false, product: 'Posture corrector back brace', niche: 'Health and pain relief', customer: 'Office workers', angle: 'Stand straight again in two weeks', wow: 'medium',
  saturation: 'high', saturation_hint: 'Sold by many stores since 2021', claims_risk: 'medium', claims: ['relieves back pain'], pros: ['Easy to demo'], cons: ['Health claims'], fit: 58, confidence: 'high' };

/** Adds one AI read (a verdict object) for a product key. */
export function addRead(db, key, status, verdict, flags = '[]') {
  db.prepare("INSERT INTO ai_checks (product_key, status, model, answer_model, fit, confidence, verdict, flags, checked_at) VALUES (?, ?, 'claude-haiku-5-5', 'claude-haiku-5-5', ?, ?, ?, ?, ?)")
    .run(key, status, verdict.fit ?? null, verdict.confidence ?? null, JSON.stringify(verdict), flags, iso(NOW - 3600e3));
}

export async function readEnv() {
  const env = await seededEnv();
  env.db.prepare(`INSERT INTO world_products (product_key, ad_id, active, product_title, price, currency, image_url, store_url, product_url, ad_library_url, advertiser, page_id, keyword, markets, ads, creatives, days, new14, shop_ads, store_products, first_seen, last_seen)
    VALUES ('pod.test/products/pillow', '1001', 1, 'Pod Pillow', 49, 'AUD', 'https://cdn.shopify.com/pod.jpg', 'https://pod.test/', 'https://pod.test/products/pillow', 'https://www.facebook.com/ads/library/?id=1001', 'Pod', '77', 'pillow',
    '{"AU":{"ads":3,"days":40,"new14":1}}', 4, 2, 40, 1, 80, 12, ?, ?)`).run(iso(NOW - 2 * 864e5), iso(NOW - 3600e3));
  addRead(env.db, 'eu|500|linen summer dress', 'ok', { ...READ, product: 'Linen summer dress', niche: 'Clothing', fit: 34 });
  addRead(env.db, 'eu|shop1.test/products/item-1', 'ok', READ);
  addRead(env.db, 'world|pod.test/products/pillow', 'ok', { ...READ, product: 'Memory foam pod pillow', niche: 'Sleep and comfort', fit: 77, confidence: 'high' }, '["injection"]');
  addRead(env.db, 'eu|shop2.test/products/item-2', 'pending', { ...READ, product: 'Heated neck pillow', fit: 61 });
  addRead(env.db, 'eu|shop3.test/products/item-3', 'ok', { ...READ, approve: true, fit: 99 }); // not the schema: never shown
  env.db.prepare("INSERT INTO ai_checks (product_key, status, tries) VALUES ('eu|504|led sunset lamp', 'error', 3)").run(); // never answered
  return env;
}
