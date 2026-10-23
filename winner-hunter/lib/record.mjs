/*
 * One winner as it is stored in D1 (table `winners`, the full record also in its `data` column).
 * slimRecord() turns a hunter result (v2) or an old v1 result file record into exactly this shape.
 */
import fs from 'node:fs';
import { sized } from './storephoto.mjs';
import { noTemplate } from './score.mjs';

const ZH = JSON.parse(fs.readFileSync(new URL('./1688-terms.json', import.meta.url), 'utf8'));
const cut = (t, n) => Array.from(String(t ?? '')).slice(0, n).join('');
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v) => (num(v) == null ? null : Math.round(Number(v)));
const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? cut(u, 1000) : '');

/** Chinese search words for the "Search 1688" button: per product title, else per search word, else the title. */
export function zhTerm(r) {
  const title = String(r.product_title || r.headline || '').trim();
  return ZH[title] || (ZH._keywords || {})[String(r.keyword || '').toLowerCase()] || cut(noTemplate(title || r.keyword || ''), 80);
}

/** The stored shape. seenAt: when the ad was seen (default: now, set by the D1 upsert). */
export function slimRecord(r, { seenAt } = {}) {
  const img = typeof r.image_url === 'string' && !r.image_url.startsWith('data:') ? cut(sized(r.image_url), 1000) : '';
  const price = num(r.price);
  const was = num(r.compare_at_price);
  const out = {
    id: String(r.id ?? r.ad_id ?? ''),
    score: int(r.score) ?? 0,
    verdict: String(r.verdict || ''),
    product_title: cut(noTemplate(r.product_title || r.headline || ''), 200),
    price,
    compare_at_price: was,
    currency: cut(r.currency || '', 8),
    discount_pct: int(r.discount_pct) ?? (price != null && was > price ? Math.round((1 - price / was) * 100) : null),
    advertiser: cut(r.advertiser || '', 200),
    advertiser_page_id: String(r.advertiser_page_id || ''),
    active_ads: int(r.active_ads),
    ad_age_days: int(r.ad_age_days),
    ad_start_date: cut(r.ad_start_date || '', 10),
    reach_eu: int(r.reach_eu),
    scaled_count: int(r.scaled_count),
    keyword: cut(r.keyword || '', 100),
    market: cut(r.market || '', 100),
    store_url: https(r.store_url),
    product_url: https(r.product_url),
    ad_library_url: https(r.ad_library_url),
    image_url: img,
    image_source: img ? (r.image_source === 'store' ? 'store' : 'product') : '',
    zh: r.zh || '',
    store_products: int(r.store_products),
    top_countries: cut(r.top_countries || '', 80),
    ad_copy: cut(r.ad_copy || '', 600),
    checklist: (Array.isArray(r.checklist) ? r.checklist : []).slice(0, 7).map((c) => ({
      key: String(c.key || ''), label: cut(c.label || '', 40), state: String(c.state || ''), text: cut(c.text || '', 160),
    })),
  };
  if (!out.zh) out.zh = zhTerm(out);
  if (seenAt) out.seen_at = new Date(seenAt).toISOString();
  return out;
}
