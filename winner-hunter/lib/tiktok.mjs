/*
 * The rows behind the board's TikTok tab. tiktok-import.mjs validates them and writes them to D1.
 * A bad row stops the whole import: nothing is guessed or quietly dropped.
 */
export const COLS = ['id', 'title', 'shop', 'url', 'image_url', 'price_min', 'price_max', 'rating', 'reviews', 'sold_us', 'creators', 'plays',
  'category', 'blockers', 'meta_status', 'meta_url', 'meta_unsure', 'meta_us', 'meta_au', 'meta_nz', 'updated_at',
  'video_url', 'sold_mixed', 'price_suspect', 'ads_mention_n', 'ads_mention_of', 'ads_domain', 'meta_label'];

// One bound JSON array per query (D1 allows at most 100 bound parameters). decision and decided_at stay out: they are Connor's.
export const UPSERT_SQL = `INSERT INTO tiktok_products (${COLS.join(', ')})
SELECT ${COLS.map((c) => `json_extract(value, '$.${c}')`).join(', ')} FROM json_each(?1) WHERE true
ON CONFLICT(id) DO UPDATE SET ${COLS.slice(1).map((c) => `${c} = excluded.${c}`).join(', ')}`;

// A product that left the list goes, unless you decided on it.
export const PRUNE_SQL = 'DELETE FROM tiktok_products WHERE decision IS NULL AND id NOT IN (SELECT value FROM json_each(?1))';

const https = (u) => typeof u === 'string' && /^https:\/\//.test(u);
const count = (n) => n == null || (Number.isFinite(n) && n >= 0);

/** Throws on the first row the board can't show safely. Returns the rows. */
export function validateRows(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('No rows to import');
  rows.forEach((r, i) => {
    const bad = (why) => { throw new Error(`Row ${i} (${r && r.id}): ${why}`); };
    if (!r || !/^\d{1,25}$/.test(String(r.id))) bad('bad id');
    if (typeof r.title !== 'string' || !r.title.trim()) bad('no title');
    if (!/^https:\/\/www\.tiktok\.com\//.test(r.url)) bad('url is not a TikTok page');
    if (r.image_url != null && !https(r.image_url)) bad('image_url is not https');
    if (r.meta_url != null && !https(r.meta_url)) bad('meta_url is not https');
    if (r.video_url != null && !https(r.video_url)) bad('video_url is not https');
    if (r.blockers != null && typeof r.blockers !== 'string') bad('blockers must be text, or null when never judged');
    if (!Number.isFinite(r.sold_us) || r.sold_us < 0) bad('no sold count');
    for (const k of ['price_min', 'price_max', 'rating', 'reviews', 'creators', 'plays', 'meta_us', 'meta_au', 'meta_nz', 'ads_mention_n', 'ads_mention_of']) if (!count(r[k])) bad(`bad ${k}`);
    if (!['matched', 'none'].includes(r.meta_status)) bad('meta_status must be matched or none');
  });
  return rows;
}
