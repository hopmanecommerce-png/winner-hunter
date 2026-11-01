/*
 * The Launch view: from an approved product (✓ on the board, or Approved on the TikTok tab) to a test campaign today.
 * One launch card per product (D1 table launches, migrations/0015_launch.sql): the product's facts when the launch
 * started, a checklist of seven steps with ticks, values and notes, your decision, and one launch pin (the product you
 * launch now; a partial unique index keeps it to one).
 *   GET  /api/launch                                { launches }: every card, the launch pin first, each with its summary
 *   GET  /api/launch?pick=1                         { candidates }: approved products without a card, the last approved first
 *   POST /api/launch {start: key}                   a card for an approved product (the launch pin when nothing is pinned)
 *   POST /api/launch {key, step, done, note, v}     one checklist step, saved as a whole
 *   POST /api/launch {key, pin: true | false}       pin it (the old pin is cleared in the same batch) or unpin it
 *   POST /api/launch {key, decision: 'go' | 'no' | ''}  your launch decision; a no-go loses the pin
 *   POST /api/launch {key, remove: true}            the card is deleted
 *   GET  /launch.js                                 launchKit as a script: the board works the numbers out as you type
 * key: the product's key on the board. 'eu|<store.com/products/handle>' (an EU product: its product page, as the board
 * groups it; an ad without a product page: 'eu|<page id>|<title>', its advertiser + title), 'world|<store.com/products/handle>'
 * (outside the EU) or 'tiktok|<id>'. A card keeps the key it was saved under: one saved before the board grouped EU
 * products by product page has its advertiser + title key, and is still its product's card under either key (cardProduct).
 * app.mjs checks the PIN cookie, the origin and the JSON before any of this runs. All SQL is parameterized.
 */
import { TRAITS, YES_AT } from './jev-questions.mjs';

/**
 * Everything a launch card works out, in one function that uses nothing from outside itself: the Worker calls it, and
 * /launch.js sends its source to the board, so the browser runs the same tested code while you type.
 */
export function launchKit() {
  // The checklist. t: tick (a checkbox), money, pct, int, url (https only), text, choice. def: what an empty field means.
  const STEPS = [
    { k: 'sourcing', title: 'Sourcing', hint: 'Find the supplier, cost it, order a sample.', items: [
      { k: 'supplier', t: 'url', label: 'Supplier link (1688 / AliExpress)' },
      { k: 'unit', t: 'money', label: 'Unit cost' },
      { k: 'ship', t: 'money', label: 'Shipping per order' },
      { k: 'moq', t: 'int', label: 'MOQ (units)' },
      { k: 'lead', t: 'int', label: 'Lead time (days)' },
      { k: 'sample', t: 'tick', label: 'Sample ordered' },
    ] },
    { k: 'margin', title: 'Margin', hint: 'What one order leaves you. Empty COGS and shipping come from Sourcing.', items: [
      { k: 'price', t: 'money', label: 'Selling price (incl. VAT)' },
      { k: 'cogs', t: 'money', label: 'COGS' },
      { k: 'ship', t: 'money', label: 'Shipping' },
      { k: 'fees', t: 'pct', label: 'Payment fees %', def: 3 },
      { k: 'vat', t: 'pct', label: 'VAT %', def: 21 },
      { k: 'cpa', t: 'money', label: 'Target CPA' },
    ] },
    { k: 'compliance', title: 'Compliance', hint: 'Before you spend a euro on ads.', items: [
      { k: 'restricted', t: 'tick', label: 'Not a restricted category (Meta ads, EU)' },
      { k: 'trademark', t: 'tick', label: 'Trademark / EUIPO check done' },
      { k: 'claims', t: 'tick', label: 'Claims are safe (no health or cure claims)' },
      { k: 'ce', t: 'tick', label: 'CE and EU product rules met (GPSR, labels)' },
    ] },
    { k: 'research', title: 'Competitors and ads', hint: 'Who sells it, how they sell it, at what price.', items: [
      { k: 'ads', t: 'text', label: 'Ad Library links', long: true },
      { k: 'angle', t: 'text', label: 'Angle', long: true },
      { k: 'comp1', t: 'url', label: 'Competitor store 1' },
      { k: 'comp2', t: 'url', label: 'Competitor store 2' },
      { k: 'comp3', t: 'url', label: 'Competitor store 3' },
      { k: 'position', t: 'choice', label: 'Your price vs theirs', options: [['below', 'Cheaper'], ['same', 'About the same'], ['above', 'Pricier']] },
    ] },
    { k: 'store', title: 'Store', hint: 'Ready to take an order.', items: [
      { k: 'page', t: 'tick', label: 'Product page' },
      { k: 'photos', t: 'tick', label: 'Photos' },
      { k: 'reviews', t: 'tick', label: 'Reviews' },
      { k: 'policies', t: 'tick', label: 'Policies (shipping, returns, privacy)' },
      { k: 'checkout', t: 'tick', label: 'Checkout tested' },
      { k: 'pixel', t: 'tick', label: 'Pixel fires a purchase' },
    ] },
    { k: 'creatives', title: 'Creatives', hint: 'Three hooks, three videos or images (a link or a name).', items: [
      { k: 'hook1', t: 'text', label: 'Hook 1' },
      { k: 'hook2', t: 'text', label: 'Hook 2' },
      { k: 'hook3', t: 'text', label: 'Hook 3' },
      { k: 'video1', t: 'text', label: 'Video or image 1' },
      { k: 'video2', t: 'text', label: 'Video or image 2' },
      { k: 'video3', t: 'text', label: 'Video or image 3' },
    ] },
    { k: 'launch', title: 'Launch', hint: 'Test small, with the rules written down before the first euro.', items: [
      { k: 'budget', t: 'money', label: 'Daily budget' },
      { k: 'campaign', t: 'tick', label: 'Test campaign set up' },
      { k: 'kill', t: 'text', label: 'Kill rule', long: true },
      { k: 'scale', t: 'text', label: 'Scale rule', long: true },
    ] },
  ];
  const MAX = { text: 500, url: 500, note: 1000 };
  const stepOf = (k) => STEPS.find((s) => s.k === k);
  const DEF = {};
  for (const f of stepOf('margin').items) if (f.def != null) DEF[f.k] = f.def;
  // Product risks that stop most launches (rules, cosmetics, health claims, brands). Every other risk is amber.
  const RED = ['people', 'animals', 'digital', 'face', 'skin', 'medical', 'brand'];

  const round = (x, d) => {
    const f = 10 ** d;
    const r = Math.round(x * f) / f;
    return r === 0 ? 0 : r; // never -0
  };
  // "8,50", "€ 8.50" and 8.5 are 8.5. A comma is a decimal comma (a Dutch keyboard) unless there is a dot as well.
  const numberOf = (x) => {
    if (typeof x === 'number') return x;
    if (typeof x !== 'string') return NaN;
    let s = x.replace(/[\s€$£%]/g, '');
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
    return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
  };
  const cleanText = (x, n, lines) => String(x).replace(lines ? /[\u0000-\u0009\u000b-\u001f\u007f]+/g : /[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

  /** One field as it is saved, or undefined (empty or not valid: not saved). A link without https:// gets it. */
  function cleanField(f, x) {
    if (x == null || x === '' || x === false) return undefined;
    if (f.t === 'tick') return x === true ? true : undefined;
    if (f.t === 'choice') return f.options.some((o) => o[0] === x) ? x : undefined;
    if (f.t === 'text') return cleanText(x, MAX.text) || undefined;
    if (f.t === 'url') {
      let s = cleanText(x, 2 * MAX.url).replace(/\s+/g, '');
      if (/^http:\/\//i.test(s)) s = 'https://' + s.slice(7);
      else if (!/^https:\/\//i.test(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(s)) s = 'https://' + s;
      if (s.length > MAX.url || !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+([/?#:]|$)/i.test(s)) return undefined;
      try {
        new URL(s);
      } catch (e) {
        return undefined;
      }
      return s;
    }
    const n = numberOf(x);
    if (!Number.isFinite(n) || n < 0) return undefined;
    if (f.t === 'int') return n <= 1e6 ? Math.round(n) : undefined;
    if (f.t === 'pct') return n <= 100 ? round(n, 2) : undefined;
    return n <= 1e6 ? round(n, 2) : undefined; // money
  }

  /** A checklist step as it is saved: { done, note, v: only its own fields, valid and filled in }, or null (no such step). */
  function cleanStep(k, input) {
    const s = stepOf(k);
    if (!s) return null;
    const i = input && typeof input === 'object' ? input : {};
    const raw = i.v && typeof i.v === 'object' ? i.v : {};
    const v = {};
    for (const f of s.items) {
      const x = cleanField(f, raw[f.k]);
      if (x !== undefined) v[f.k] = x;
    }
    return { done: i.done === true, note: i.note == null ? '' : cleanText(i.note, MAX.note, true), v };
  }

  /** The margin step's numbers. COGS and shipping left empty come from Sourcing; fees and VAT from their defaults. */
  function marginInputs(steps) {
    const src = (steps && steps.sourcing && steps.sourcing.v) || {};
    const m = (steps && steps.margin && steps.margin.v) || {};
    return { price: m.price, cogs: m.cogs ?? src.unit, ship: m.ship ?? src.ship, fees: m.fees ?? DEF.fees, vat: m.vat ?? DEF.vat, cpa: m.cpa };
  }

  /**
   * One order. price is what the customer pays, VAT included; payment fees are taken on that price. contribution is
   * what the order leaves you before ads: price − VAT − fees − COGS − shipping. Break-even ROAS = price / contribution:
   * below it the ads cost more than the order leaves (none when an order loses money). be_cpa: the most an order may
   * cost in ads. profit and roas: at your target CPA. null until the price and the COGS are known.
   */
  function marginOf(m) {
    const price = Number(m && m.price);
    if (!m || !(price > 0) || m.cogs == null || !(Number(m.cogs) >= 0)) return null;
    const cogs = Number(m.cogs);
    const ship = Number(m.ship) || 0;
    const net = price / (1 + (Number(m.vat) || 0) / 100);
    const fees = (price * (Number(m.fees) || 0)) / 100;
    const c = net - fees - cogs - ship;
    const cpa = m.cpa != null && Number(m.cpa) >= 0 ? Number(m.cpa) : null;
    return {
      price: round(price, 2), vat: round(price - net, 2), fees: round(fees, 2), cost: round(cogs + ship, 2),
      contribution: round(c, 2), pct: round((c / price) * 100, 1),
      be_roas: c > 0 ? round(price / c, 2) : null, be_cpa: round(Math.max(c, 0), 2),
      cpa, profit: cpa == null ? null : round(c - cpa, 2), roas: cpa > 0 ? round(price / cpa, 2) : null,
    };
  }

  /**
   * The launch decision on one card: the margin, the break-even ROAS, how long its ads run, how big its store is, and
   * the risk flags (red first). level: red (a red flag), amber (only amber ones) or green. kill and scale: rules worked
   * out from the margin, as a start for the Launch step.
   */
  function summaryOf(l) {
    const f = (l && l.facts) || {};
    const steps = (l && l.steps) || {};
    const v = (k) => (steps[k] && steps[k].v) || {};
    const m = marginOf(marginInputs(steps));
    const flags = [];
    const add = (k, level, text) => flags.push({ k, level, text });
    for (const r of Array.isArray(f.risks) ? f.risks : []) if (r && r.k) add(String(r.k), RED.includes(r.k) ? 'red' : 'amber', String(r.text || r.k));
    if (!m) add('margin', 'amber', 'No margin yet: fill in the selling price and the unit cost');
    else {
      if (m.contribution <= 0) add('loss', 'red', 'Loses money on every order, before ads');
      else if (m.be_roas >= 3) add('thin', 'amber', `Thin margin: break-even ROAS ${m.be_roas}`);
      if (m.contribution > 0 && m.profit != null && m.profit <= 0) add('cpa', 'red', 'Loses money at your target CPA');
      if (v('margin').ship == null && v('sourcing').ship == null) add('ship', 'amber', 'Shipping cost not filled in');
    }
    if (v('sourcing').lead > 15) add('lead', 'amber', `Slow delivery: ${v('sourcing').lead} days`);
    if (v('sourcing').moq > 50) add('moq', 'amber', `MOQ ${v('sourcing').moq}: stock bought up front`);
    const checks = stepOf('compliance').items;
    const open = checks.filter((i) => v('compliance')[i.k] !== true).length;
    if (open) add('compliance', 'amber', `Compliance: ${open} of ${checks.length} checks open`);
    if (v('research').position === 'above') add('pricier', 'amber', 'Priced above the competitors');
    const age = f.age == null || !Number.isFinite(Number(f.age)) ? null : Number(f.age);
    if (age != null && age < 14) add('young', 'amber', `Its ads only run ${age} days`);
    const store = f.products == null || !Number.isFinite(Number(f.products)) ? null : Number(f.products);
    if (store != null && store > 500) add('bigstore', 'amber', `Big store: ${store} products`);
    flags.sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
    return {
      margin: m, be_roas: m ? m.be_roas : null, ad_days: age, store_products: store, flags,
      level: flags.some((x) => x.level === 'red') ? 'red' : flags.length ? 'amber' : 'green',
      done: STEPS.filter((s) => steps[s.k] && steps[s.k].done === true).length, of: STEPS.length,
      kill: m && m.be_cpa > 0 ? `No sale after €${round(2 * m.be_cpa, 2)} spent (2× the break-even CPA): stop the ad` : '',
      scale: m && m.be_roas ? `ROAS above ${m.be_roas} for 3 days: budget +20%` : '',
    };
  }

  return { STEPS, cleanStep, marginInputs, marginOf, summaryOf };
}

export const { STEPS, cleanStep, marginInputs, marginOf, summaryOf } = launchKit();
/** GET /launch.js: the kit's source, run once in the board as window.LAUNCH. */
export const LAUNCH_JS = `'use strict';\nwindow.LAUNCH = (${launchKit})();\n`;

// ---------------------------------------------------------------------------
// The product behind a card: its facts when the launch started
// ---------------------------------------------------------------------------

/**
 * The card's key of a board product (a row of products().k in app.mjs): 'eu|' + its group key (groupKey in app.mjs: its
 * product page, else its advertiser + title), or 'world|…' as it is.
 */
export const keyOf = (r) => (r.world ? String(r.gk) : 'eu|' + r.gk);
const keyIn = (k) => (typeof k === 'string' && k.length <= 1000 && /^(eu|world|tiktok)\|./s.test(k) ? k : '');
// An EU key of a product page ('eu|store.com/products/handle'). A host never holds '|' or '/', and an advertiser +
// title key always has a '|' right after its page id, so the two kinds never look alike.
const PAGE_KEY = /^eu\|[^|/]+\/products\//;

/**
 * The board's products by their launch key, and what finds the card of one. Until the board grouped EU products by
 * product page, an EU card was saved under 'eu|' + the advertiser + title of the product's ads, and such a row is never
 * rewritten. b: deps.board() ({ products: products().k, rows: every ad, each with gk and, in the EU, jk: its advertiser
 * + title }). byKey: board key → product. ofAd: EU ad id → the board key of its product. ofOld: an old key ('eu|' +
 * advertiser + title) → the board keys of the products its ads are in now (more than one when the old product is now
 * several product pages). pageKey: productKey in app.mjs.
 */
export function launchIndex(b, pageKey = () => '') {
  const byKey = new Map();
  const ofAd = new Map();
  const ofOld = new Map();
  for (const r of b.products || []) byKey.set(keyOf(r), r);
  for (const w of b.rows || []) {
    if (w.world || w.jk == null || w.gk == null) continue;
    const key = 'eu|' + w.gk;
    ofAd.set(String(w.ad_id), key);
    const old = 'eu|' + w.jk;
    if (!ofOld.has(old)) ofOld.set(old, new Set());
    ofOld.get(old).add(key);
  }
  return { byKey, ofAd, ofOld, pageKey };
}

/**
 * The board key of a card's product. A card under a product page, outside the EU or from TikTok: its own key. An EU card
 * under an advertiser + title (saved before the board grouped by product page, or a product without a product page):
 * the product its ad (facts.id) is in now; that ad gone, the product page in its facts; else its own key.
 */
export function cardProduct(row, idx) {
  const k = String(row.product_key);
  if (!k.startsWith('eu|') || PAGE_KEY.test(k)) return k;
  const f = parse(row.facts, {});
  const ofAd = f.id == null ? undefined : idx.ofAd.get(String(f.id));
  if (ofAd) return ofAd;
  const page = idx.pageKey(f.product);
  return page ? 'eu|' + page : k;
}

/**
 * The board product a launch key names: the product with that key, or, for an old EU key (advertiser + title; a board
 * opened before the board grouped by product page still sends one), the product its ads are in now. When the old
 * product is now several product pages: the approved one, then the one that passes the rules, then most reach a day.
 */
export function productFor(idx, key) {
  const r = idx.byKey.get(key);
  if (r || !idx.ofOld.has(key)) return r;
  const rank = (p) => [p.hid === 1 ? 1 : 0, Number(p.pass) || 0, Number(p.rpd) || 0];
  return [...idx.ofOld.get(key)].map((k) => idx.byKey.get(k)).filter(Boolean).sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2] || cmp(keyOf(a), keyOf(b));
  })[0];
}
const numOr = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const BLOCKERS = TRAITS.filter((t) => t.group === 'blockers');
const RULE_RISKS = { people: 'People take it', animals: 'Pets take it', gymwear: 'Gymwear', digital: 'Not a physical product', face: 'Goes on the face' };

/** Risk flags from Jev's answers: its rule flags (jevFlags in app.mjs) and the blockers it said yes to. */
export function jevRisks(jev) {
  if (!jev) return [];
  const out = (jev.flags || []).map((k) => ({ k, text: RULE_RISKS[k] || k }));
  for (const t of BLOCKERS) if (jev.p && jev.p[t.k] >= YES_AT) out.push({ k: t.k, text: t.label });
  return out;
}
/** The TikTok tab's blockers ('electric skin'): the same keys as Jev's blockers, named the same way. */
const tiktokRisks = (s) => String(s || '').split(/\s+/).filter(Boolean).map((k) => ({ k, text: (BLOCKERS.find((t) => t.k === k) || { label: k }).label }));

/** The product's name: its title, else the name in its product link, else its shop (as the board's cards do). */
function titleOf(a) {
  const t = String(a.title || '').trim();
  if (t && !/^https?:\/\//i.test(t)) return t.slice(0, 300);
  const m = /\/products\/([^/?#]+)/.exec(String(a.product || t));
  let slug = m ? m[1] : '';
  try {
    slug = decodeURIComponent(slug);
  } catch (e) {
    // keep it as it is
  }
  if (slug) return slug.replace(/[-_]+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 300);
  try {
    return new URL(a.store).hostname.replace(/^www\./, '');
  } catch (e) {
    return String(a.adv || '').slice(0, 300) || 'Untitled product';
  }
}

/** A board product's facts for its card, from the board's own card data (toAd in app.mjs). */
export function boardFacts(r, toAd) {
  const a = toAd(r);
  const w = a.world;
  return {
    source: w ? 'world' : 'eu', id: a.id, title: titleOf(a), img: a.img, price: numOr(a.price), cur: a.cur, store: a.store, product: a.product,
    ad: a.ad, kw: a.kw, adv: a.adv, age: numOr(a.age), shop_ads: numOr(a.ads), copies: numOr(a.scaled), products: numOr(a.products),
    rpd: w ? null : numOr(a.rpd), proof: w && w.proof ? { n: w.proof.n, of: w.proof.of } : null, best: a.best ? a.best.rank : null,
    trust: a.trust && (a.trust.status === 'page' || a.trust.status === 'widget') ? { score: a.trust.score, reviews: a.trust.reviews } : null,
    jev: a.jev ? { main: a.jev.main, sub: a.jev.sub } : null, risks: jevRisks(a.jev), approved_at: r.hat || '',
  };
}

const TT_SQL = 'SELECT id, title, shop, url, image_url, price_min, rating, reviews, sold_us, category, blockers, meta_status, meta_url, meta_us, meta_au, meta_nz, decision, decided_at FROM tiktok_products';
/** An approved TikTok product's facts. No ad dates or store size exist there: its sold count instead. */
export function tiktokFacts(t) {
  const matched = t.meta_status === 'matched';
  return {
    source: 'tiktok', id: String(t.id), title: String(t.title || '').replace(/^\s*【[^】]*】\s*/, '').trim().slice(0, 300) || 'TikTok product', img: https(t.image_url),
    price: numOr(t.price_min), cur: 'USD', store: '', product: https(t.url), ad: matched ? https(t.meta_url) : '', kw: '', adv: String(t.shop || ''),
    age: null, shop_ads: null, copies: null, products: null, rpd: null, proof: null, best: null, trust: null, jev: t.category ? { main: String(t.category), sub: '' } : null,
    sold: numOr(t.sold_us), rating: numOr(t.rating), reviews: numOr(t.reviews), meta: matched ? { us: numOr(t.meta_us), au: numOr(t.meta_au), nz: numOr(t.meta_nz) } : null,
    risks: tiktokRisks(t.blockers), approved_at: t.decided_at || '',
  };
}

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

const COLS = 'product_key, title, facts, steps, pinned, decision, created_at, updated_at';
export const LIST_SQL = `SELECT ${COLS} FROM launches ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC LIMIT 200`;
const ROW_SQL = `SELECT ${COLS} FROM launches WHERE product_key = ?`;
// Every card's key and facts, the launch pin first, then the last touched: which products have a card, and the card
// saved under another key than the one asked for.
const KEYS_SQL = 'SELECT product_key, facts FROM launches ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC';
// A new card is the launch pin when nothing else is pinned. A card that is already there stays as it is.
export const START_SQL = `INSERT INTO launches (${COLS})
VALUES (?1, ?2, ?3, '{}', CASE WHEN EXISTS (SELECT 1 FROM launches WHERE pinned = 1) THEN NULL ELSE 1 END, NULL, ?4, ?4)
ON CONFLICT(product_key) DO NOTHING`;
const PICK_MAX = 100;

const parse = (s, or) => {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : or;
  } catch (e) {
    return or;
  }
};
/** A launches row for the board, with its decision summary. */
export function launchOut(row) {
  const l = {
    key: row.product_key, title: row.title || '', facts: parse(row.facts, {}), steps: parse(row.steps, {}), pinned: Number(row.pinned) === 1,
    decision: row.decision === 'go' || row.decision === 'no' ? row.decision : null, created_at: row.created_at || '', updated_at: row.updated_at || '',
  };
  return Object.assign(l, { summary: summaryOf(l) });
}

/**
 * GET /api/launch. deps.board(): { products: every board product once (products().k in app.mjs, hid 1 = approved),
 * rows: every ad (launchIndex) }; deps.toAd: the board's card data; deps.pageKey: productKey. With pick: the approved
 * products that have no card yet (under their key, or under the old key of a card saved before), the last approved first.
 */
export async function launchList(env, pick, deps) {
  if (!pick) {
    const { results } = await env.DB.prepare(LIST_SQL).all();
    return { launches: (results || []).map(launchOut) };
  }
  const [cards, b, tt] = await Promise.all([
    env.DB.prepare(KEYS_SQL).all().then((r) => r.results || []),
    deps.board(),
    env.DB.prepare(`${TT_SQL} WHERE decision = 'approved' ORDER BY decided_at DESC LIMIT ${PICK_MAX}`).all().then((r) => r.results || [], () => []), // no TikTok table: none
  ]);
  const idx = launchIndex(b, deps.pageKey);
  const have = new Set(cards.flatMap((c) => [c.product_key, cardProduct(c, idx)]));
  const board = (b.products || []).filter((r) => r.hid === 1 && !have.has(keyOf(r))).map((r) => ({ key: keyOf(r), facts: boardFacts(r, deps.toAd) }));
  const tiktok = tt.filter((t) => !have.has('tiktok|' + t.id)).map((t) => ({ key: 'tiktok|' + t.id, facts: tiktokFacts(t) }));
  return { candidates: board.concat(tiktok).sort((a, b) => cmp(b.facts.approved_at, a.facts.approved_at)).slice(0, PICK_MAX) };
}

const bad = (error, status = 400) => ({ status, body: { error } });

/** The key of the card of the product with board key `want`: saved under it, else under an older key of it; or null. */
async function cardKeyOf(env, want, idx) {
  const rows = (await env.DB.prepare(KEYS_SQL).all()).results || [];
  const hit = rows.find((r) => r.product_key === want) || rows.find((r) => cardProduct(r, idx) === want);
  return hit ? hit.product_key : null;
}

/**
 * The card a request names: the one saved under its key. Not there, for an EU key: the card of the product that key
 * names now, so a board key finds a card saved under the old advertiser + title key, and an old key (a board opened
 * before the change) finds a card saved since under the board key. world| and tiktok| keys never changed.
 */
async function findCard(env, key, deps) {
  const row = await env.DB.prepare(ROW_SQL).bind(key).first();
  if (row || !key.startsWith('eu|')) return row;
  const idx = launchIndex(await deps.board(), deps.pageKey);
  const r = productFor(idx, key);
  const saved = await cardKeyOf(env, r ? keyOf(r) : key, idx);
  return saved == null ? null : env.DB.prepare(ROW_SQL).bind(saved).first();
}

/**
 * POST /api/launch: start a card, save a step, pin, decide or remove. Returns { status, body } (body.launch: the card now).
 * A launch row is only ever written under the key it was saved under, and deleted only by { remove: true }.
 */
export async function launchPost(env, j, now, deps) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('Bad JSON');
  const at = new Date(now).toISOString();
  const card = async (key) => {
    const row = await env.DB.prepare(ROW_SQL).bind(key).first();
    return row ? { status: 200, body: { ok: true, launch: launchOut(row) } } : bad('No launch card for this product', 404); // removed meanwhile
  };
  if (j.start != null) {
    let key = keyIn(j.start);
    if (!key) return bad('Bad product');
    let facts;
    if (key.startsWith('tiktok|')) {
      const id = key.slice('tiktok|'.length);
      if (!/^\d{1,25}$/.test(id)) return bad('Bad product');
      const t = await env.DB.prepare(`${TT_SQL} WHERE id = ?`).bind(id).first();
      if (!t) return bad('Unknown product', 404);
      if (t.decision !== 'approved') return bad('Approve it first', 409);
      facts = tiktokFacts(t);
    } else {
      const idx = launchIndex(await deps.board(), deps.pageKey);
      const r = productFor(idx, key);
      if (!r) return bad('Unknown product', 404);
      if (r.hid !== 1) return bad('Approve it first', 409);
      key = keyOf(r); // the board's key, also when an old key was sent
      // Its card already there, under this key or saved under its old key: it stays as it is.
      const have = await cardKeyOf(env, key, idx);
      if (have != null) return card(have);
      facts = boardFacts(r, deps.toAd);
    }
    await env.DB.prepare(START_SQL).bind(key, facts.title, JSON.stringify(facts), at).run();
    return card(key);
  }
  const asked = keyIn(j.key);
  if (!asked) return bad('Bad key');
  const row = await findCard(env, asked, deps);
  if (!row) return bad('No launch card for this product', 404);
  const key = row.product_key; // the key the card is saved under: every change below goes to that row
  if (j.step != null) {
    const k = String(j.step);
    const step = cleanStep(k, j);
    if (!step) return bad('Bad step');
    // One step replaced in one statement: a save of another step at the same moment is not lost.
    await env.DB.prepare("UPDATE launches SET steps = json_set(CASE WHEN json_valid(steps) THEN steps ELSE '{}' END, ?, json(?)), updated_at = ? WHERE product_key = ?")
      .bind('$.' + k, JSON.stringify(step), at, key).run();
  } else if (j.pin === true || j.pin === false) {
    if (j.pin && row.decision === 'no') return bad('A no-go cannot be the launch pin: take the no-go back first', 409);
    // Clear the old pin, then pin this one, in one batch: the index allows one pinned card, so it is never two.
    const steps = j.pin ? [env.DB.prepare('UPDATE launches SET pinned = NULL WHERE pinned = 1 AND product_key != ?').bind(key)] : [];
    steps.push(env.DB.prepare('UPDATE launches SET pinned = ?, updated_at = ? WHERE product_key = ?').bind(j.pin ? 1 : null, at, key));
    await env.DB.batch(steps);
  } else if (j.decision != null) {
    const d = String(j.decision);
    if (!['go', 'no', ''].includes(d)) return bad('Bad decision');
    await env.DB.prepare("UPDATE launches SET decision = ?1, pinned = CASE WHEN ?1 = 'no' THEN NULL ELSE pinned END, updated_at = ?2 WHERE product_key = ?3").bind(d || null, at, key).run();
  } else if (j.remove === true) {
    await env.DB.prepare('DELETE FROM launches WHERE product_key = ?').bind(key).run();
    return { status: 200, body: { ok: true, removed: key } };
  } else return bad('Nothing to save');
  return card(key);
}
