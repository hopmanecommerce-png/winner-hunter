/*
 * The Winner Score: one number from 0 to 100 per product, with the evidence behind it, for every source the board has (the EU
 * board, outside the EU, the TikTok tab, a research candidate). It is a ladder of evidence, not a guess at revenue:
 *
 *   paid        it runs paid ads now (someone pays to push it)
 *   sustained   the ads keep running or are copied: an ad 30+ days old, or 5+ copies from a shop with 75+ active ads
 *   selling     independent proof of sales: 10,000+ sold on TikTok Shop, its store's top 10 best sellers, 500+ product reviews
 *   profitable  on paper: its price leaves a break-even CPA of €20+ after VAT, fees, refunds, product, shipping and customs
 *
 * and five pillars, each 0 to 1, weighted into the score: proof (the ladder's facts), demand (rising or falling), competition
 * (room for one more seller), margin (euros left for ads) and fit (Connor's niches and Jev's read of the product). A risk
 * multiplier (documents, sizes, fragile, bulky, hard to source) scales it, and two gates take a product out completely:
 * excluded (supplements, food and drink, anything people eat or take, gymwear) and blocked (the risk radar's Block). A product
 * that is not physical is never gated for that. Categories Connor has not decided on are flagged, never decided.
 *
 * Pure: no network, no database, no clock (the day comes in). The margin is the board's own (worker/src/econ.mjs evaluate) and
 * the risk verdict the board's own (worker/src/risk.mjs verdict), so the score never disagrees with the card. Every number
 * says where it came from: kind 'fact' (data, with its source and date), 'estimate' (Jev, a default, a guess) or 'claim'.
 * The spec, with every threshold and why: research/2026-11-05-winner-system/wh-score/SCORE-SPEC.md (product-research repo).
 */
import { evaluate } from '../worker/src/econ.mjs';
import { verdict, fromAd, fromTikTok } from '../worker/src/risk.mjs';
import { classify } from './world.mjs';

export const VERSION = 1;

/** Every weight and threshold in one place. The learning step may change WEIGHTS (bounded, see learnWeights), nothing else. */
export const SPEC = {
  weights: { proof: 0.3, demand: 0.1, competition: 0.15, margin: 0.25, fit: 0.2 },
  // A pillar with no data at all counts at this value: unknown is not good, and not as bad as a measured zero.
  prior: { proof: 0.2, demand: 0.4, competition: 0.5, margin: 0.3, fit: 0.45 },
  // [x, y] points, read on a log10 scale where log is set: strength of one piece of evidence (0..1).
  sold: { log: true, pts: [[3, 0.25], [4, 0.55], [5, 0.8], [6, 0.95]] }, // TikTok lifetime sold: 1k, 10k, 100k, 1M
  reviews: { log: true, pts: [[2, 0.15], [3, 0.35], [4, 0.5]] }, // product reviews (TikTok): 100, 1,000, 10,000
  storeReviews: { log: true, pts: [[2, 0.05], [3, 0.12], [4, 0.18]] }, // the store's Trustpilot reviews: a store-level hint
  adDays: { pts: [[7, 0], [14, 0.15], [30, 0.35], [60, 0.5], [90, 0.6], [180, 0.65]] }, // oldest ad still running
  copies: { pts: [[1, 0], [3, 0.12], [10, 0.3], [30, 0.42], [100, 0.5]] }, // copies of the ad / ads for the product
  shopAds: { pts: [[30, 0], [75, 0.1], [300, 0.2], [1000, 0.25]] }, // the shop's active ads: how much it spends overall
  reachDay: { log: true, pts: [[2.7, 0.05], [3, 0.1], [4, 0.25], [4.7, 0.38], [5.3, 0.45]] }, // EU reach a day: 500, 1k, 10k, 50k, 200k
  markets: { pts: [[1, 0.3], [2, 0.5], [3, 0.65], [5, 0.75]] },
  // Best-seller rank in its own store (Shopify's sales order, top 50): rank → strength.
  rank: [[1, 0.8], [3, 0.7], [10, 0.55], [25, 0.35], [50, 0.2]],
  margin: { pts: [[0, 0], [8, 0.15], [15, 0.4], [25, 0.65], [35, 0.8], [50, 0.92], [80, 1]] }, // break-even CPA in €
  guessShrink: 0.7, // a margin on a guessed supplier price counts at this share…
  guessCap: 0.7, // …and at most this: the top of the margin pillar needs a real supplier price
  pageLevel: 0.5, // ad numbers of a shop's page that no sampled ad ties to this product count at this share (TikTok rows)
  rivals: [[0, 0.9], [1, 0.75], [2, 0.6], [4, 0.45], [5, 0.3], [10, 0.2]],
  storeSize: [[3, 0.75], [20, 0.75], [100, 0.6], [250, 0.5], [1000, 0.35], [5000, 0.25]],
  ladder: { sustainedDays: 30, sustainedCopies: 5, sustainedShopAds: 75, sellingSold: 10000, sellingRank: 10, sellingRankStore: 10, sellingReviews: 500, profitableCpa: 20, profitableCpaGuess: 25 },
  // The risk multiplier: what makes a launch harder without stopping it.
  // Sizing is a check, not a disqualifier (CLAUDE.md blockers list; Connor approved 12 sized products of 36 by 1 Nov).
  risk: { docs: 0.93, docsFloor: 0.75, sizing: 0.8, fragile: 0.9, bulky: 0.85, ioss: 0.85, hardsource: 0.85, floor: 0.4 },
  // Jev's answers that make the product more or less appealing (estimates). Weights of the appeal mix.
  appeal: { problem: 0.2, wow: 0.15, clear3s: 0.15, impulse: 0.1, gift: 0.1, beforeafter: 0.1, smalllight: 0.1, ad_pain: 0.05, ad_clear: 0.05 },
  unappeal: { generic: 0.15, face: 0.2, personal: 0.1, repeat: 0.05 },
  // Snuggro's niches (sleep and home) before Connor's decisions say otherwise: Jev's main category → fit.
  niche: { 'Sleep and comfort': 0.8, Home: 0.75, Kitchen: 0.6, 'Gifts and hobbies': 0.6, 'Outdoor and travel': 0.55, 'Tools and DIY': 0.55, Garden: 0.5,
    'Health and pain relief': 0.5, Pets: 0.5, 'Jewelry and accessories': 0.45, Clothing: 0.4, Shoes: 0.35, Tech: 0.45, Car: 0.45, 'Baby and kids': 0.4, Fitness: 0.35,
    'Beauty and personal care': 0.3, 'Food and supplements': 0.1, Other: 0.45 },
  nicheDefault: 0.45,
  learnK: 8, // shrinkage of a learned niche rate toward the overall rate: as if 8 more decisions at the overall rate
};

// Categories Connor has not decided on (CLAUDE.md): flagged on the card, never decided by the score.
const UNDECIDED = [
  ['shaping or cellulite leggings', /\b(?:shap(?:e|ing)\s*(?:wear|leggings?)|shapewear|cellulite|anti[\s-]?cellulite|body\s*shap\w*|formende?\s+leggings?|figurformend\w*|legging\s+gainant\w*)\b/i],
  ['running socks', /\b(?:running|hardloop|lauf|compression|compressie|kompressions?)\s*(?:socks?|sokken|socken|chaussettes?)\b/i],
  ['home gym gear', /\b(?:home\s*gym|dumbbells?|kettlebells?|resistance\s+bands?|pull[\s-]?up\s+bars?|weight\s+bench|ab\s+rollers?|fitness\s+(?:bands?|equipment)|halters?|hanteln?)\b/i],
  ['pet food', /\b(?:dog|cat|pet|puppy|kitten)[\s-]+(?:food|treats?|chews?)\b|hundefutter|katzenfutter|croquettes?|friandises?|snacks?\s+(?:for\s+)?(?:dogs?|cats?)/i],
  ['nose strips and sprays', /\b(?:nose|nasal|neus|nasen)\s*(?:strips?|sprays?|pleisters?|dilators?|clips?)\b|\bnasenpflaster\b/i],
];

// Skin-care words the risk radar's cosmetics list does not have (seen on the board: "Total Bye Hyperpigmentation Package").
// A safety net for the daily picks only; the card's badge stays the radar's. Kept narrow: a tool or device is no cosmetic.
const SKIN = /(?<![\p{L}\p{N}])(?:skin\s?care|hyper\s?pigment\p{L}*|pigmentation|pigmentflecken|dark\s+spots?|age\s+spots?|anti[\s-]?(?:aging|ageing|wrinkle|rimpel|falten|rides)|wrinkles?|rimpels?|falten|blackheads?|mee[\s-]?eters?|pores?|poriën|poren|glow\s+serum|skin\s+(?:serum|booster|barrier|glow)|huidverzorging|hautpflege|soins?\s+(?:du\s+)?visage|peau\s+(?:parfaite|nette|ferme))(?![\p{L}\p{N}])/iu;
// Health promises the radar's pseudo list does not have: grounding or earthing products (Connor on GroundingWell, 1 Nov 2026:
// "to risky") and menopause relief ("Your natural menopause solution" on a bracelet).
const PSEUDO = /(?<![\p{L}\p{N}])(?:grounding|earthing|geerdet|aarding)(?:\s*[\p{L}™®]+)?\s+(?:sheets?|bed\s?sheets?|mats?|pads?|blankets?|pillow\s?cases?|socks?|bands?|kits?|lakens?|matten?|decken?)(?![\p{L}\p{N}])|groundingwell|earthing|(?<![\p{L}\p{N}])(?:menopaus\p{L}*|menopauze|wechseljahr\p{L}*|m[ée]nopause|hot\s+flash(?:es)?|opvliegers|hitzewallungen)(?![\p{L}\p{N}])/iu;
const NOT_SKIN = /(?<![\p{L}\p{N}])(?:brush(?:es)?|device|machine|tool|roller|mirror|led|light|wand|steamer|massager|scrubber|bag|case|organi[sz]er|fridge|towel|pillow ?case|silk|satin)(?![\p{L}\p{N}])/iu;

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Piecewise-linear through [x, y] points, flat outside them. log: x is compared on a log10 scale. */
export function ramp(x, spec) {
  const pts = Array.isArray(spec) ? spec : spec.pts;
  const log = !Array.isArray(spec) && spec.log;
  if (x == null || !Number.isFinite(x)) return null;
  const v = log ? (x > 0 ? Math.log10(x) : -Infinity) : x;
  if (v <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (v <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

/** A best-seller rank's strength: rank 1 strongest, 50 weakest; a small store's rank says less (rank 2 of 3 is no news). */
export function rankStrength(rank, storeProducts) {
  const r = num(rank);
  if (r == null || r < 1) return null;
  if (r > 50) return 0;
  let s = ramp(r, SPEC.rank);
  const n = num(storeProducts);
  if (n != null && n <= 3) s *= 0.3;
  else if (n != null && n <= 10) s *= 0.6;
  return s;
}

/** Noisy-OR: the chance that at least one piece of evidence is right, each counted at its strength. */
const anyOf = (list) => 1 - list.reduce((p, s) => p * (1 - clamp(s)), 1);

/** A file-safe id for a product key: a slug plus 6 hex of a hash (stable). */
export function idOf(key) {
  const s = String(key || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  const slug = s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return (slug || 'product') + '-' + h.toString(16).padStart(8, '0').slice(0, 6);
}

/** The undecided categories a product's words fall in (flag only). */
export function undecidedOf(text) {
  const t = String(text || '');
  return UNDECIDED.filter(([, re]) => re.test(t)).map(([name]) => name);
}

/**
 * Whether a product is out by Connor's board rules: { gate: 'excluded' | 'blocked' | null, why, risk }.
 * excluded: people eat or take it (Jev people ≥ 0.5, the risk radar's food or supplement reason, the hunt's words), or gymwear
 * (Jev ≥ 0.5 or the words). blocked: any other Block of the risk radar (cosmetics, medical, brand, weapon...). Pet food is
 * not excluded (Connor 2026-10-31: it stays on) and a product that is not physical never is.
 */
export function gateOf(f, risk) {
  const p = (f.jev && f.jev.p) || {};
  const words = classify(f.title || '', f.labels || '');
  if (num(p.people) != null && p.people >= 0.5) return { gate: 'excluded', why: 'People eat or take it (Jev)' };
  if (words.out === 'supplement' || words.out === 'food or drink') return { gate: 'excluded', why: words.out === 'supplement' ? 'Supplement (name)' : 'Food or drink (name)' };
  if ((num(p.gymwear) != null && p.gymwear >= 0.5) || words.out === 'gymwear') return { gate: 'excluded', why: 'Gymwear' };
  // A source's own exclusion (the TikTok export's hand reads) counts for what is eaten, taken or gymwear only: a product that
  // is not physical is never gated for that (Connor, 1 Nov 2026).
  if (f.excluded && /supplement|food|drink|gym/i.test(String(f.excluded))) return { gate: 'excluded', why: String(f.excluded) };
  const name = `${f.title || ''} ${String(f.product_url || '').split('/products/')[1] || ''}`.replace(/[-_]+/g, ' ');
  if (SKIN.test(name) && !NOT_SKIN.test(name) && !(risk && risk.level === 'block')) return { gate: 'blocked', why: 'Cosmetic (skin-care words)' };
  if (PSEUDO.test(`${name} ${f.store_url || ''}`) && !(risk && risk.level === 'block')) return { gate: 'blocked', why: 'Health promise (grounding, earthing or menopause)' };
  if (risk && risk.level === 'block') {
    const r = risk.reasons.find((x) => x.level === 'block') || {};
    if (r.k === 'eat') return { gate: 'excluded', why: 'People eat or take it' };
    return { gate: 'blocked', why: r.short || 'Risk radar: Block' };
  }
  return { gate: null, why: '' };
}

/** The risk radar's verdict for a product's facts (the board's own rules, worker/src/risk.mjs). */
export function riskOf(f) {
  const x = f.src === 'tiktok'
    ? fromTikTok({ id: f.id || f.key, title: f.title, url: f.product_url, shop: f.shop, blockers: f.jev && f.jev.blockers, cat: f.jev && f.jev.main, p: f.price, price_min: f.price })
    : fromAd({ id: f.ad_id || f.key, title: f.title, product: f.product_url, store: f.store_url, world: f.src === 'world', copy: '', price: f.price, cur: f.cur,
      jev: f.jev && f.jev.p ? { p: f.jev.p, main: f.jev.main, sub: f.jev.sub } : null });
  if (f.src === 'tiktok') x.cur = 'USD';
  return verdict(x, f.riskCheck || null);
}

// Papers the risk radar does not list: detergents and cleaning chemicals (EU CLP 1272/2008 labels, detergents regulation
// 648/2004). A docs reason, not a block.
const CHEMICAL = /(?<![\p{L}\p{N}])(?:detergents?|laundry\s+(?:sheets?|pods?|strips?|tablets?)|wasmiddel\p{L}*|waschmittel\p{L}*|lessive|dishwasher\s+(?:tablets?|pods?)|vaatwastabletten|cleaning\s+(?:paste|spray|solution|tablets?|concentrate)|bleach|chlorine|drain\s+(?:cleaner|unblocker)|ontstopper)(?![\p{L}\p{N}])/iu;

/** The risk multiplier and the reasons for it. */
export function riskMult(risk, f) {
  const R = SPEC.risk;
  const flags = [];
  let docs = 1;
  if (CHEMICAL.test(String(f.title || ''))) {
    docs *= R.docs;
    flags.push('Docs: Chemical labels (CLP)');
  }
  for (const r of risk.reasons) {
    if (r.level === 'docs') {
      docs *= R.docs;
      flags.push('Docs: ' + r.short);
    } else if (r.level === 'info') flags.push(r.short);
  }
  let m = Math.max(docs, R.docsFloor);
  for (const r of risk.returns) {
    const k = r.k;
    if (R[k] != null) {
      m *= R[k];
      flags.push('Returns: ' + r.short);
    }
  }
  const p = (f.jev && f.jev.p) || {};
  if (num(p.hardsource) != null && p.hardsource >= 0.5) {
    m *= R.hardsource;
    flags.push('Hard to source (Jev)');
  }
  return { mult: Math.max(m, R.floor), flags };
}

/** Connor's niches learned from his decisions: { rate, n, byCat: { cat: { a, n, fit } } } (fit 0..1, shrunk to the prior). */
export function learnNiche(decisions, spec = SPEC) {
  const all = decisions.filter((d) => d && (d.y === 0 || d.y === 1));
  const n = all.length;
  const rate = n ? all.reduce((s, d) => s + d.y, 0) / n : 0.3;
  const byCat = {};
  for (const d of all) {
    const c = d.cat || 'Other';
    const e = (byCat[c] = byCat[c] || { a: 0, n: 0 });
    e.a += d.y;
    e.n += 1;
  }
  for (const [c, e] of Object.entries(byCat)) {
    const prior = spec.niche[c] != null ? spec.niche[c] : spec.nicheDefault;
    const shrunk = (e.a + spec.learnK * rate) / (e.n + spec.learnK); // the category's approval rate, pulled to the overall rate
    const ratio = rate > 0 ? shrunk / rate : 1; // 1 = as often as anything else
    // Prior fit moved by the evidence: ×(ratio) on the odds, bounded.
    const odds = (prior / (1 - prior)) * ratio;
    e.fit = round(clamp(odds / (1 + odds), 0.05, 0.95), 3);
  }
  return { rate: round(rate, 3), n, byCat };
}

const ev = (signal, value, kind, source, date, link) => ({ signal, value, kind, source, date: date || null, ...(link ? { link } : {}) });

/**
 * Score one product. f: its facts (toFacts below gives the shape), ctx: { day, niche (learnNiche), weights, econSettings }.
 * Returns the scored product of shared/INTERFACES.md (without rank).
 */
export function scoreProduct(f, ctx = {}) {
  const W = { ...SPEC.weights, ...(ctx.weights || {}) };
  const P = SPEC.prior;
  const day = ctx.day || (f.as_of || '').slice(0, 10) || null;
  const evidence = [];
  const src = f.src || 'eu';
  const asOf = (f.as_of || day || '').slice(0, 10);
  const SRC = { eu: 'Meta Ad Library API (EU transparency)', world: 'Meta Ad Library (public, logged out)', tiktok: 'TikTok Shop via ScrapeCreators', research: 'Research run' }[src] || src;

  // ---- Risk first: a gated product is still scored (so its card can say why), but never picked.
  const risk = riskOf(f);
  const gate = gateOf(f, risk);
  const rm = riskMult(risk, f);
  const undecided = undecidedOf(`${f.title || ''} ${f.product_url || ''}`);

  // ---- Proof: sales evidence (independent of ads) and spend evidence (the ads), two groups.
  const sales = [];
  const spend = [];
  const known = { proof: 0, demand: 0, competition: 0, margin: 0, fit: 0 };
  const sold = num(f.sold);
  if (sold != null) {
    sales.push(ramp(sold, SPEC.sold));
    evidence.push(ev('tiktok_sold', sold, 'fact', 'TikTok Shop lifetime sold (US listing; may include other regions)' + (f.sold_note ? ', ' + f.sold_note : ''), asOf, f.tiktok_url));
  }
  const rs = rankStrength(f.bs_rank, f.store_products);
  if (rs != null) {
    sales.push(rs);
    evidence.push(ev('best_seller_rank', f.bs_rank > 50 ? 'not in top 50' : f.bs_rank, 'fact', "Its store's Shopify best-seller order (top 50)", f.bs_checked || asOf, f.product_url));
    if (num(f.bs_move) != null && f.bs_move >= 3) sales.push(0.15);
  } else if (f.bs_checked && f.bs_rank == null && f.bs_ok) {
    evidence.push(ev('best_seller_rank', 'not in top 50', 'fact', "Its store's Shopify best-seller order (top 50)", f.bs_checked, f.product_url));
  }
  const reviews = num(f.reviews);
  if (reviews != null && reviews > 0) {
    sales.push(ramp(reviews, SPEC.reviews));
    evidence.push(ev('product_reviews', reviews, 'fact', src === 'tiktok' ? 'TikTok Shop reviews' : 'Product reviews', asOf));
  }
  const tpr = num(f.tp_reviews);
  if (tpr != null && tpr > 0) {
    sales.push(ramp(tpr, SPEC.storeReviews) * (num(f.tp_score) != null && f.tp_score < 3.5 ? 0.5 : 1));
    evidence.push(ev('store_trustpilot', `${tpr} reviews${f.tp_score != null ? ', ' + f.tp_score + '★' : ''}`, 'fact', "The store's Trustpilot page", f.tp_checked || asOf));
  }
  const adDays = num(f.ad_days);
  if (adDays != null) {
    spend.push(ramp(adDays, SPEC.adDays));
    evidence.push(ev('oldest_ad_days', adDays, 'fact', SRC + (src === 'eu' ? ' (the EU board keeps ads 7 to 42 days old)' : ''), asOf, (f.links && f.links.ad_library) || null));
  }
  const copies = num(f.copies);
  if (copies != null) {
    spend.push(ramp(copies, SPEC.copies));
    evidence.push(ev(src === 'world' ? 'ads_for_product' : 'ad_copies', copies, 'fact', SRC, asOf));
  }
  const shopAds = num(f.shop_ads);
  if (shopAds != null) {
    spend.push(ramp(shopAds, SPEC.shopAds));
    evidence.push(ev('shop_active_ads', shopAds, 'fact', SRC + (f.shop_ads_capped ? ' (500 = 500 or more)' : ''), asOf));
  }
  const rpd = num(f.reach_day);
  if (rpd != null && rpd > 0) {
    spend.push(ramp(rpd, SPEC.reachDay));
    evidence.push(ev('eu_reach_per_day', Math.round(rpd), 'fact', 'Meta Ad Library API, EU reach of its best ad ÷ its age', asOf));
  }
  if (f.page_level) for (let i = 0; i < spend.length; i++) spend[i] *= SPEC.pageLevel;
  const salesP = sales.length ? anyOf(sales) : 0;
  const spendSorted = spend.slice().sort((a, b) => b - a);
  const spendP = spendSorted.length ? Math.min(0.75, spendSorted[0] + 0.25 * spendSorted.slice(1).reduce((s, x) => s + x, 0)) : 0;
  const hasProof = sales.length + spend.length > 0;
  const proof = hasProof ? 1 - (1 - salesP) * (1 - spendP) : P.proof;
  known.proof = hasProof ? 1 : 0;

  // ---- Demand: is it rising? Momentum, new ads, markets, sales speed.
  const dem = [];
  const mom = num(f.momentum);
  if (mom != null) {
    dem.push(clamp(0.5 + 0.5 * mom));
    evidence.push(ev('momentum', round(mom, 2), 'fact', 'Board momentum (momentum.mjs): -1 falling to +1 rising', f.momentum_day || asOf));
  }
  const n14 = num(f.new14);
  const adsN = num(f.ads_n) || copies;
  if (n14 != null && adsN) {
    const share = clamp(n14 / Math.max(adsN, 1));
    dem.push(0.3 + 0.5 * share);
    evidence.push(ev('new_ads_14d', `${n14} of ${adsN}`, 'fact', SRC, asOf));
  }
  const mk = num(f.markets_n);
  if (mk != null && mk > 0) {
    dem.push(ramp(mk, SPEC.markets));
    evidence.push(ev('markets', f.markets && f.markets.length ? f.markets.join(', ') : mk, 'fact', SRC, asOf));
  }
  const speed = num(f.sold_per_day);
  if (speed != null) {
    dem.push(ramp(Math.max(speed, 0.1), { log: true, pts: [[0, 0.3], [1, 0.55], [2, 0.75], [3, 0.9]] }));
    evidence.push(ev('tiktok_sold_per_day', round(speed, 1), 'fact', 'TikTok sold count, two snapshots apart', asOf));
  }
  const trend = num(f.trends);
  if (trend != null) {
    dem.push(clamp(0.5 + trend / 2));
    evidence.push(ev('google_trends', round(trend, 2), 'fact', 'Google Trends via SerpApi: last 4 weeks against the 4 before', asOf));
  }
  const demand = dem.length ? dem.reduce((s, x) => s + x, 0) / dem.length : P.demand;
  known.demand = dem.length ? 1 : 0;

  // ---- Competition: room for one more seller.
  const comp = [];
  const rivals = num(f.rivals);
  if (rivals != null) {
    let c = ramp(rivals, SPEC.rivals);
    if (num(f.rivals_new) != null && f.rivals_new >= 2) c *= 0.85;
    comp.push(c);
    evidence.push(ev('rival_stores', rivals, 'fact', 'Board momentum: other stores the hunts found selling the same item (a floor)', f.momentum_day || asOf));
  }
  const sp = num(f.store_products);
  if (sp != null && sp > 0) {
    comp.push(ramp(sp, SPEC.storeSize));
    evidence.push(ev('store_products', sp, 'fact', "The store's product count (Shopify)", asOf));
  }
  if (f.gap != null) {
    comp.push(f.gap ? 0.7 : 0.45);
    evidence.push(ev('market_gap', f.gap ? 'no ads found in ' + (f.gap_markets || 'the target markets') : 'already advertised in ' + (f.gap_markets || 'the target markets'), 'fact', 'Meta Ad Library search per market', asOf));
  }
  const brand = num(((f.jev && f.jev.p) || {}).brand);
  if (brand != null && brand >= 0.5) comp.push(0.25);
  if (f.brand_owned) {
    comp.push(0.25);
    evidence.push(ev('brand_listing', f.brand_note || 'a brand sells it under its own name', 'estimate', 'Shop name in the title (word match)', asOf));
  }
  const competition = comp.length ? comp.reduce((s, x) => s + x, 0) / comp.length : P.competition;
  known.competition = comp.length ? 1 : 0;

  // ---- Margin: the board's own unit economics (VAT out first, fees, refunds, product, shipping, EU customs).
  const settings = ctx.econSettings || null;
  const basis = { price: f.price, cur: f.cur || 'EUR', age: adDays, src: src === 'world' ? 'world' : 'eu', products: sp, risks: [], checked: true };
  const inputs = { cost_text: f.supplier_cost_text || '', weight: f.weight_g, ship: f.ship_eur, price: f.my_price, from: f.supplier_from ? { cost: f.supplier_from } : {} };
  const e = num(f.price) > 0 || num(f.my_price) > 0 ? evaluate(basis, inputs, settings, day) : null;
  let margin = P.margin;
  let econ = null;
  if (e && e.m) {
    const m = e.m;
    const guess = m.cost_from === 'guess';
    margin = guess ? Math.min(ramp(m.be_cpa, SPEC.margin) * SPEC.guessShrink, SPEC.guessCap) : ramp(m.be_cpa, SPEC.margin);
    known.margin = guess ? 0.5 : 1;
    econ = { price_eur: m.price, margin_eur: m.contribution, breakeven_cpa_eur: m.be_cpa, breakeven_roas: m.be_roas, landed_eur: m.landed, supplier_cost_eur: m.cost,
      supplier: guess ? 'est' : m.cost_from, weight_g: m.weight, weight_from: m.weight_from, vat_pct: m.vat_pct, level: e.level };
    evidence.push(ev('breakeven_cpa_eur', m.be_cpa, guess ? 'estimate' : 'fact', guess ? `Board unit economics, supplier price guessed at ${m.guess_pct}% of the price` : 'Board unit economics, your supplier price', day));
  }

  // ---- Fit: Connor's niches (learned from his decisions) and Jev's read of the product.
  const j = f.jev || {};
  const cat = j.main || f.category || '';
  const learned = ctx.niche && ctx.niche.byCat && ctx.niche.byCat[cat];
  const nichePrior = SPEC.niche[cat] != null ? SPEC.niche[cat] : SPEC.nicheDefault;
  const niche = learned ? learned.fit : nichePrior;
  let appeal = null;
  const p = j.p || null;
  if (p && Object.keys(p).length > 3) {
    let s = 0;
    let w = 0;
    for (const [k, wt] of Object.entries(SPEC.appeal)) if (num(p[k]) != null) { s += wt * p[k]; w += wt; }
    let neg = 0;
    for (const [k, wt] of Object.entries(SPEC.unappeal)) if (num(p[k]) != null) neg += wt * p[k];
    if (w > 0) appeal = clamp(s / w - neg + 0.1);
  }
  if (num(j.product_score) != null) appeal = appeal == null ? clamp(j.product_score / 4) : 0.5 * appeal + 0.5 * clamp(j.product_score / 4);
  const fit = cat || appeal != null ? (appeal == null ? niche : 0.5 * niche + 0.5 * appeal) : P.fit;
  known.fit = appeal != null ? 0.5 : 0; // Jev and learned niches are estimates
  if (cat) evidence.push(ev('niche', `${cat}${j.sub ? ' › ' + j.sub : ''}: fit ${round(niche, 2)}${learned ? ` (from ${learned.n} of Connor's decisions)` : ' (snuggro prior)'}`, 'estimate', learned ? "Connor's decisions on the board" : 'wh-score prior', day));
  if (appeal != null) evidence.push(ev('appeal', round(appeal, 2), 'estimate', 'Jev (TypeSafe): problem, wow, clear in 3 s, impulse, gift…', j.checked_at ? String(j.checked_at).slice(0, 10) : asOf));

  // ---- Total.
  const pillars = { proof: round(proof, 3), demand: round(demand, 3), competition: round(competition, 3), margin: round(margin, 3), fit: round(fit, 3) };
  const wsum = Object.values(W).reduce((s, x) => s + x, 0);
  const base = Object.entries(W).reduce((s, [k, w]) => s + w * pillars[k], 0) / wsum;
  const coverage = Object.entries(W).reduce((s, [k, w]) => s + w * known[k], 0) / wsum;
  const score = gate.gate ? 0 : Math.round(100 * base * rm.mult);

  // ---- The ladder: each rung true, false or null (not known).
  const L = SPEC.ladder;
  const paid = src === 'tiktok' ? (num(f.shop_ads) > 0 ? true : null) : src === 'research' ? (adDays != null ? true : null) : true;
  const sustained = adDays == null && copies == null ? null : (adDays != null && adDays >= L.sustainedDays) || (copies != null && copies >= L.sustainedCopies && (shopAds == null || shopAds >= L.sustainedShopAds));
  const rankOk = num(f.bs_rank) != null && f.bs_rank <= L.sellingRank && (sp == null || sp >= L.sellingRankStore);
  const sellingKnown = sold != null || num(f.bs_rank) != null || (f.bs_checked && f.bs_ok) || reviews != null;
  const selling = (sold != null && sold >= L.sellingSold) || rankOk || (reviews != null && reviews >= L.sellingReviews) ? true : sellingKnown ? false : null;
  const profitable = econ ? econ.breakeven_cpa_eur >= (econ.supplier === 'est' ? L.profitableCpaGuess : L.profitableCpa) : null;
  const ladder = { paid, sustained, selling, profitable };
  const level = Object.values(ladder).filter((x) => x === true).length;

  const why = whyOf({ pillars, ladder, econ, f, sold, adDays, copies });
  return {
    key: f.key, id: idOf(f.key), name: f.name || f.title || '', src, category: cat || null, sub: j.sub || null,
    score, base: round(100 * base, 1), level, ladder, pillars, coverage: round(coverage, 2),
    risk: { mult: round(rm.mult, 2), level: risk.level, gate: gate.gate, why: gate.why || null, flags: rm.flags.concat(f.brand_owned ? ["A brand's own listing: sell the product type, not the brand"] : []).concat(f.page_level ? ['Ad numbers are the shop page’s, not this product’s'] : []), returns: risk.returns.map((r) => r.short), undecided },
    price: num(f.price) != null ? { amount: num(f.price), currency: f.cur || 'EUR', eur: econ ? econ.price_eur : null } : null,
    econ, why, evidence,
    links: { product_url: f.product_url || null, store_url: f.store_url || null, ad_library: (f.links && f.links.ad_library) || null, tiktok: f.tiktok_url || null },
    ad_ids: f.ad_ids || [], stores: f.store ? [f.store] : [], markets: f.markets || [], image: f.image || null, as_of: asOf || null, version: VERSION,
  };
}

/** One line on why: the score's strongest facts, plain English. */
function whyOf({ ladder, econ, f, sold, adDays, copies }) {
  const out = [];
  if (sold != null && sold >= 1000) out.push(`${sold >= 1e6 ? (sold / 1e6).toFixed(1) + 'M' : sold >= 1e4 ? Math.round(sold / 1000) + 'k' : sold} sold on TikTok`);
  if (num(f.bs_rank) != null && f.bs_rank <= 50) out.push(`#${f.bs_rank} in its store`);
  if (adDays != null && adDays >= 14) out.push(`ads ${adDays} days`);
  if (copies != null && copies >= 5) out.push(`${copies} ${f.src === 'world' ? 'ads' : 'ad copies'}`);
  if (num(f.reach_day) >= 1000) out.push(`${Math.round(f.reach_day / 1000)}k EU reach a day`);
  if (num(f.rivals) != null) out.push(f.rivals === 0 ? 'no rival stores found' : `${f.rivals} rival stores`);
  if (econ) out.push(`break-even CPA €${Math.round(econ.breakeven_cpa_eur)}${econ.supplier === 'est' ? ' (est.)' : ''}`);
  if (!out.length) out.push(ladder.paid ? 'runs paid ads' : 'little evidence yet');
  return out.slice(0, 4).join(', ');
}

/** Score a list; rank the ungated ones by score (ties: more evidence first, then the key). */
export function scoreAll(facts, ctx = {}) {
  const scored = facts.map((f) => scoreProduct(f, ctx));
  const ok = scored.filter((s) => !s.risk.gate).sort((a, b) => b.score - a.score || b.level - a.level || b.coverage - a.coverage || (a.key < b.key ? -1 : 1));
  ok.forEach((s, i) => { s.rank = i + 1; });
  return { ranked: ok, gated: scored.filter((s) => s.risk.gate) };
}
