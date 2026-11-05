/*
 * Today's winners: the daily 5 to 10 products, picked from the Winner Score (lib/winner-score.mjs) by fixed rules, so the
 * same data always gives the same picks.
 *
 *   1. The bar. Every pick must pass all of it; when fewer than 5 pass, the day shows fewer and says so (never padded):
 *      not excluded or blocked, a score of 50+, two rungs of the evidence ladder, a known price with a break-even CPA of
 *      €15+ (a guessed supplier price counts, marked est.), a risk multiplier of 0.6+, and a category from Jev (so its
 *      blockers were checked). A brand's own listing (Ridge, KastKing) is never a pick: its numbers are the brand's.
 *   2. Dedupe. Never a product Connor decided on (approved, rejected, kept, a launch card, the pipeline), never one shown in
 *      the last 14 days, one product per store a day, and one of near-identical titles (the same item from two stores).
 *   3. Rotation. At most 2 of one category a day; each further pick of a category already picked counts at × 0.85, and a
 *      category picked yesterday at × 0.92, so ten days are not ten copies of one niche.
 *   4. At most 10.
 *
 * Pure: the scored products, the decisions and the history come in; the picks and every reason a product was passed over
 * come out.
 */

export const RULES = {
  min: 5, max: 10, minScore: 50, minLevel: 2, minCpa: 15, minRisk: 0.6, cooldownDays: 14, perCategory: 2, perStore: 1, perBrandListing: 0,
  sameCategory: 0.85, yesterday: 0.92, sameTitle: 0.6,
};

const DAY = 864e5;
const STOP = new Set('the and for with a an of to in on by new set pack pcs piece pieces 1 2 3 4 5 x de het een en met voor van der die das und mit für fur le la les et pour avec du des un une'.split(' '));
/** The words of a title that say what it is (lower case, no stop words, no numbers alone). */
export function titleWords(t) {
  return new Set(String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/【[^】]*】|\[[^\]]*\]/g, ' ').split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w)));
}
/** Jaccard overlap of two word sets. */
export function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

/** Why a scored product does not pass the bar ('' when it does). */
export function belowBar(s, rules = RULES) {
  if (s.risk && s.risk.gate) return s.risk.gate;
  if (!(s.score >= rules.minScore)) return 'score';
  if (!(s.level >= rules.minLevel)) return 'evidence';
  if (s.ladder && s.ladder.paid === false) return 'evidence';
  if (!s.econ || s.econ.breakeven_cpa_eur == null) return 'price';
  if (!(s.econ.breakeven_cpa_eur >= rules.minCpa)) return 'margin';
  if (!(s.risk && s.risk.mult >= rules.minRisk)) return 'risk';
  // Its blockers must be checkable: Jev (or the TikTok tab) gave it a category. Unread products wait for Jev.
  if (!s.category) return 'not read by Jev';
  return '';
}

const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);
const brandListing = (s) => (s.risk && Array.isArray(s.risk.flags) ? s.risk.flags.some((f) => /brand's own listing/i.test(f)) : false);

/**
 * The day's picks. scored: the Winner Score's ranked list (ungated first is fine, any order works). opts:
 *   day         'YYYY-MM-DD' (Asia/Bangkok)
 *   decided     Set of product keys Connor decided on
 *   shown       Map product key → the last day it was a pick
 *   yesterday   Set of categories picked the day before
 * Returns { day, picks, shortfall, message, passed, pool, skipped: { reason: count }, near: [the next 5 below the bar] }.
 */
export function selectDaily(scored, { day, decided = new Set(), shown = new Map(), yesterday = new Set(), rules = RULES } = {}) {
  const skipped = {};
  const skip = (k) => { skipped[k] = (skipped[k] || 0) + 1; };
  const pool = [];
  const near = [];
  for (const s of scored) {
    if (decided.has(s.key)) { skip('decided'); continue; }
    const last = shown.get(s.key);
    if (last && day && daysBetween(last, day) < rules.cooldownDays && daysBetween(last, day) >= 1) { skip('shown lately'); continue; }
    const why = belowBar(s, rules);
    if (why) {
      skip(why);
      if (!s.risk.gate && near.length < 5 && s.score >= rules.minScore - 10) near.push({ key: s.key, name: s.name, score: s.score, why });
      continue;
    }
    pool.push(s);
  }
  pool.sort((a, b) => b.score - a.score || b.level - a.level || b.coverage - a.coverage || (a.key < b.key ? -1 : 1));
  const picks = [];
  const cats = new Map();
  const stores = new Map();
  let brands = 0;
  const words = [];
  // Greedy with rotation: the best effective score next, recomputed as the day fills.
  const left = pool.slice();
  while (picks.length < rules.max && left.length) {
    let best = -1;
    let bestV = -Infinity;
    for (let i = 0; i < left.length; i++) {
      const s = left[i];
      const cat = s.category || 'Other';
      if ((cats.get(cat) || 0) >= rules.perCategory) continue;
      const store = (s.stores && s.stores[0]) || s.key;
      if ((stores.get(store) || 0) >= rules.perStore) continue;
      if (brandListing(s) && brands >= rules.perBrandListing) continue;
      const w = titleWords(s.name);
      if (words.some((x) => overlap(x, w) >= rules.sameTitle)) continue;
      const v = s.score * rules.sameCategory ** (cats.get(cat) || 0) * (yesterday.has(cat) ? rules.yesterday : 1);
      if (v > bestV) { bestV = v; best = i; }
    }
    if (best < 0) break;
    const s = left.splice(best, 1)[0];
    const cat = s.category || 'Other';
    cats.set(cat, (cats.get(cat) || 0) + 1);
    const store = (s.stores && s.stores[0]) || s.key;
    stores.set(store, (stores.get(store) || 0) + 1);
    if (brandListing(s)) brands++;
    words.push(titleWords(s.name));
    picks.push({ ...s, pick: picks.length + 1, effective: Math.round(bestV * 10) / 10 });
  }
  // Shown by score: the rotation decides which products make the day, not their order.
  picks.sort((a, b) => b.score - a.score || b.level - a.level || (a.key < b.key ? -1 : 1));
  picks.forEach((p, i) => { p.pick = i + 1; });
  const notPicked = pool.length - picks.length;
  if (notPicked > 0) skipped['rotation or duplicate'] = notPicked;
  const shortfall = picks.length < rules.min;
  const message = picks.length === 0 ? 'No product passed the quality bar today.'
    : shortfall ? `Only ${picks.length} product${picks.length === 1 ? '' : 's'} passed the quality bar today (the bar is never lowered to fill the list).` : '';
  return { day, picks, shortfall, message, passed: pool.length, pool: scored.length, skipped, near };
}
