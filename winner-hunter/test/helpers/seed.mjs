// Sample board data in a fresh in-memory D1, written through the real upsert SQL.
import { d1Client } from '../../lib/d1.mjs';
import { slimRecord } from '../../lib/record.mjs';
import { d1Rest, d1Binding, memoryDb } from './sqlite-d1.mjs';

export const NOW = Date.UTC(2026, 9, 17, 8, 0);
const iso = (daysAgo) => new Date(NOW - daysAgo * 864e5).toISOString();

const TITLES = ['Linen Summer Dress', 'Posture Corrector Pro', 'Heated Neck Pillow', 'Pet Hair Remover Roller', 'LED Sunset Lamp', 'Cooling Dog Mat',
  'Silk Sleep Mask', 'Ergonomic Knee Pillow', 'Self-Cleaning Cat Brush', 'Magnetic Phone Holder', 'Shiatsu Foot Massager', 'Anti-Snoring Mouthpiece',
  'Waterproof Car Seat Cover', 'Orthopedic Dog Bed', 'Bamboo Pillow', 'Weighted Blanket 7kg', 'Electric Lint Remover', 'Smart Water Bottle',
  'Facial Ice Roller', 'Portable Blender', 'Back Stretcher', 'Wrinkle Release Spray', 'Cordless Hair Straightener', 'Mini Projector', 'Baby Sleep Sack'];

export function sampleRecords() {
  const recs = TITLES.map((t, i) => ({
    id: String(9000 + i), score: 99 - Math.floor(i / 2), verdict: 'winner', product_title: t, price: 29.95 + i, compare_at_price: i % 3 ? 79.95 + i : null, currency: 'EUR',
    advertiser: 'Shop ' + i, advertiser_page_id: String(500 + i), active_ads: 80 + i, ad_age_days: 10 + (i % 5), ad_start_date: '2026-10-01',
    reach_eu: 100000 - i * 3000, scaled_count: 3, keyword: i % 2 ? 'hond' : 'dress', market: 'NL,BE',
    store_url: `https://shop${i}.test/`, product_url: i % 4 ? `https://shop${i}.test/products/item-${i}` : `https://shop${i}.test/`,
    ad_library_url: `https://www.facebook.com/ads/library/?id=${9000 + i}`, image_url: `https://cdn.shopify.com/s/files/1/p${i}.jpg`,
    image_source: i === 2 ? 'store' : 'product', ad_copy: 'Nu 50% korting! Gratis verzending.', top_countries: 'NL 70%, BE 30%',
    checklist: [{ key: 'shopify', label: 'Shopify store', pts: 15, max: 15, state: 'ok', text: 'shop.myshopify.com' }, { key: 'ads', label: 'Advertiser active ads', pts: 30, max: 30, state: 'ok', text: '99 active ads' }],
  }));
  // a second ad of product #0 (same advertiser + title): collapses into the best one
  recs.push(Object.assign({}, recs[0], { id: '9100', score: 80, reach_eu: 50000 }));
  // promising (not a strict winner): score 60
  recs.push(Object.assign({}, recs[1], { id: '9200', score: 60, product_title: 'Tiny Promising Lamp', advertiser_page_id: '700', advertiser: 'Promo Shop', reach_eu: 3000 }));
  // a strict winner by score, but too young (5 days)
  recs.push(Object.assign({}, recs[1], { id: '9300', score: 90, product_title: 'Young Ad Gadget', advertiser_page_id: '701', ad_age_days: 5, reach_eu: 900000 }));
  // nasty text: HTML, quotes, commas, newlines and a spreadsheet formula
  recs.push(Object.assign({}, recs[1], { id: '9400', score: 58, product_title: '=HYPERLINK("http://evil.test","x") <img src=x onerror=alert(1)>, "quoted"\nline2', advertiser_page_id: '702', advertiser: '<script>alert(1)</script>', reach_eu: 6000 }));
  // fail the hard rules (never shown): 60 active ads; 50 days live; active ads unknown
  recs.push(Object.assign({}, recs[1], { id: '9600', product_title: 'Few Ads Gadget', advertiser_page_id: '704', active_ads: 60, reach_eu: 900000 }));
  recs.push(Object.assign({}, recs[1], { id: '9700', product_title: 'Old Ad Gadget', advertiser_page_id: '705', ad_age_days: 50, reach_eu: 900000 }));
  recs.push(Object.assign({}, recs[1], { id: '9800', product_title: 'Uncounted Gadget', advertiser_page_id: '706', active_ads: null, reach_eu: 900000 }));
  return recs;
}

/** A Worker env (DB binding + PIN) with the sample data; `stale` was last seen 30 days ago (11 + 30 = 41 days live
 * today); `aged` was 40 days old when seen 5 days ago (45 today: out). */
export async function seededEnv({ pin = '482913' } = {}) {
  const db = memoryDb();
  const rest = d1Rest(db);
  const client = d1Client({ accountId: 'a', databaseId: 'd', token: 't' }, { doFetch: rest.doFetch, retryMs: 0 });
  await client.upsertWinners(sampleRecords().map((r) => slimRecord(r)), new Date(NOW - 3600e3));
  const stale = slimRecord(Object.assign({}, sampleRecords()[1], { id: '9500', score: 99, product_title: 'Stale Old Winner', advertiser_page_id: '703', reach_eu: 990000 }), { seenAt: iso(30) });
  const aged = slimRecord(Object.assign({}, sampleRecords()[1], { id: '9900', product_title: 'Aged Out Gadget', advertiser_page_id: '707', ad_age_days: 40, reach_eu: 900000 }), { seenAt: iso(5) });
  await client.upsertWinners([stale, aged], new Date(NOW));
  await client.setState('last_run', { status: 'done', finished_at: iso(0.25), ads_checked: 48210, saved: 412, new_winners: 23, batches: 31 }, new Date(NOW));
  return { DB: d1Binding(db), BOARD_PIN: pin, db };
}
