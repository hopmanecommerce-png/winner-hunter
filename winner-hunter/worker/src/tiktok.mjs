/*
 * The board's TikTok tab. GET sends every row once and the browser filters and sorts them, so that costs no further D1 reads.
 *   GET  /api/tiktok                                  { products }
 *   POST /api/tiktok {id, decision}                   approved, rejected or '' to take it back
 */
export const LIST_SQL = `SELECT id, title, shop, url, image_url AS img, price_min AS p, price_max AS pm, rating, reviews, sold_us AS sold, creators, plays,
  category AS cat, blockers, meta_status AS ms, meta_url AS mu, meta_unsure AS mn, meta_us AS us, meta_au AS au, meta_nz AS nz, updated_at AS at, decision AS d
  FROM tiktok_products ORDER BY sold_us DESC LIMIT 5000`;

export async function tiktokList(env) {
  const { results } = await env.DB.prepare(LIST_SQL).all();
  return { products: results || [] };
}

export async function tiktokDecide(env, j, now) {
  const id = String((j && j.id) || '');
  const decision = String((j && j.decision) ?? '');
  if (!/^\d{1,25}$/.test(id)) return { status: 400, body: { error: 'Bad id' } };
  if (!['approved', 'rejected', ''].includes(decision)) return { status: 400, body: { error: 'Bad decision' } };
  const out = await env.DB.prepare('UPDATE tiktok_products SET decision = ?, decided_at = ? WHERE id = ?')
    .bind(decision || null, decision ? new Date(now).toISOString() : null, id).run();
  if (!out.meta || !out.meta.changes) return { status: 404, body: { error: 'Unknown product' } };
  return { status: 200, body: { ok: true, id, decision } };
}
