/*
 * Unit economics and the go / no-go verdict: the Decision card on top of the Inbox, the margin line on every card, the
 * Margin and Break-even ROAS sorts, and the € view. For every product in the Inbox and on ✓, and every TikTok product you
 * approved: what one order costs you landed in the EU and what it leaves you, its break-even ROAS and CPA, the profit per
 * order at the ROAS you plan with, and a red / amber / green verdict with every reason written out. Plus the decision
 * log: each approve and reject with the facts the board showed at that moment, and Undo.
 *   GET  /econ.js                                   econKit as a script: the board works the numbers out as you type
 *   GET  /api/econ?src=&status=&level=&q=&real=&sort=&dir=&offset=&limit=   { rows, total, counts, settings, day }
 *   GET  /api/econ?part=settings                    { settings, defaults, day }
 *   POST /api/econ {key, cost, weight, price}       your supplier price, parcel weight and selling price for one product
 *   POST /api/econ {settings: {…} | null}           the settings (null: back to the defaults)
 *   GET  /api/decisions?d=&undone=&offset=&limit=   { rows, total, counts }: the decision log, the newest first
 *   POST /api/decisions {undo: id}                  takes that decision back: the product is undecided again
 * A supplier you chose in 🔎 Sourcing (sourcing.mjs, D1 product_sourcing: its price, packed weight and shipping quote) counts
 * for its product unless you typed your own (read here, never written).
 * Every decision on the board is logged here: app.mjs wraps /api/hide (decisionLogged) and /api/tiktok (tiktokLogged),
 * checks the PIN cookie, the origin and the JSON before any of this runs, and hands in what this needs from the board
 * (deps), so this module imports nothing from app.mjs. All SQL is parameterized. The tables come with
 * migrations/0020_unit_economics.sql; a database without them yet (a test link before the merge) gets the default
 * settings and no log, and the board works as before.
 */
import { boardFacts, tiktokFacts, jevRisks, keyOf } from './launch.mjs';
import { tiktokDecide } from './tiktok.mjs';

/**
 * Everything the numbers need, in one function that uses nothing from outside itself: the Worker calls it, and /econ.js
 * sends its source to the board, so the browser runs the same tested code while you type.
 */
export function econKit() {
  // What the numbers assume until you change it in the € view (Settings, saved in D1). Each is said next to the number
  // it changes. The EU customs are those of 2026 for a parcel sent from China straight to the buyer.
  const DEFAULTS = {
    vat_pct: 21, // VAT of the country you sell to (NL), collected at checkout and paid through IOSS
    fee_pct: 2.9, // payment fees per order: a share of the price…
    fee_fixed: 0.3, // …plus a fixed amount
    refund_pct: 5, // orders refunded; the goods do not go back to China, so a refund costs the price before VAT
    agent_fee: 1, // your sourcing agent's or fulfilment fee per order
    cost_cur: 'CNY', // a supplier price typed without a currency: yuan (1688)
    cost_guess_pct: 15, // no supplier price yet: this share of the selling price, until you type the real one
    weight_guess_g: 300, // no weight yet: this
    ship: [[100, 2.8], [250, 3.9], [500, 5.5], [1000, 8.9], [2000, 15.5]], // China → NL, tracked: [up to grams, €]
    ship_extra_kg: 7, // past the last tier: € per started kilo more
    direct: true, // one parcel per order from China to the buyer: the EU's parcel customs apply
    duty_eur: 3, // EU customs duty per parcel worth up to duty_max before VAT…
    duty_from: '2026-07-01', // …from this day
    duty_max: 150,
    handling_eur: 2, // EU handling fee per item line in a parcel…
    handling_from: '2026-11-01', // …from this day
    lines: 1, // item lines in a parcel: one product per order is 1
    target_roas: 2.5, // the ROAS you plan with: the profit per order after ads is worked out at it
    green_roas: 2, // break-even ROAS up to this: green
    red_roas: 3, // from this: red; in between: amber
    min_profit: 10, // margin per order before ads under this: amber (little room for a CPA)
    young_days: 14, // ads running fewer days: amber
    big_store: 500, // a store with more products: amber (its ads may sell the store, not this product)
    focused_store: 50, // up to this many products: a focused store (green)
    // € for one unit of each currency: approximate, change them when they move.
    fx: { USD: 0.86, GBP: 1.16, CNY: 0.12, AUD: 0.57, NZD: 0.52, CAD: 0.62, CHF: 1.07, NOK: 0.085, SEK: 0.091, DKK: 0.134,
      PLN: 0.235, CZK: 0.041, HUF: 0.0025, RON: 0.2, SGD: 0.67, HKD: 0.11, MOP: 0.107, JPY: 0.0058, KRW: 0.00062, MYR: 0.2,
      TWD: 0.028, ILS: 0.25, AED: 0.234 },
  };
  // Each number setting: [lowest, highest, whole number].
  const NUMS = {
    vat_pct: [0, 50], fee_pct: [0, 20], fee_fixed: [0, 5], refund_pct: [0, 50], agent_fee: [0, 50], cost_guess_pct: [0, 100],
    weight_guess_g: [1, 50000, true], ship_extra_kg: [0, 200], duty_eur: [0, 100], duty_max: [0, 100000], handling_eur: [0, 100],
    lines: [1, 20, true], target_roas: [0.5, 20], green_roas: [0.5, 20], red_roas: [0.5, 20], min_profit: [0, 1000],
    young_days: [0, 365, true], big_store: [1, 1000000, true], focused_store: [0, 1000000, true],
  };
  // Risks that stop most launches from China to the EU: what people or pets take, no physical product, the face and skin
  // (cosmetics rules), health claims, brands, and what the post refuses. Every other risk is amber. Jev's keys
  // (jev-questions.mjs), also the TikTok tab's blockers.
  const RED = ['people', 'animals', 'digital', 'face', 'skin', 'medical', 'brand', 'restricted'];
  const ORDER = { red: 0, amber: 1, green: 2, info: 3 };
  const SYM = { EUR: '€', USD: '$', GBP: '£', CNY: '¥' };

  const round = (x, d = 2) => {
    const f = 10 ** d;
    const r = Math.round(x * f) / f;
    return r === 0 ? 0 : r; // never -0
  };
  const eur = (v) => (v < 0 ? '−€' : '€') + Math.abs(v).toFixed(2);
  const money = (v, cur) => (Object.hasOwn(SYM, cur) ? SYM[cur] + Number(v).toFixed(2) : `${Number(v).toFixed(2)} ${cur}`);
  const times = (x) => round(x, 2) + '×';
  const cleanText = (x, n) => String(x ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
  const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));

  // "8,50", "1,250.00", "1.250,00" and 8.5 are numbers. A comma alone is a decimal comma (a Dutch keyboard), unless it
  // groups thousands: a comma before exactly three digits, after a number that does not start with 0.
  const numberOf = (x) => {
    if (typeof x === 'number') return Number.isFinite(x) ? x : NaN;
    if (typeof x !== 'string') return NaN;
    let s = x.replace(/[\s  ]/g, '');
    if (!/^-?[\d.,]+$/.test(s)) return NaN;
    const dot = s.lastIndexOf('.');
    const comma = s.lastIndexOf(',');
    if (dot >= 0 && comma >= 0) s = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
    else if (comma >= 0) s = /^-?[1-9]\d{0,2}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
  };

  // A currency named in a price, the first that matches. A plain ¥ is the yuan here (supplier prices come from 1688),
  // a plain $ the US dollar.
  const CURS = [['JPY', /JP¥|JPY|円/i], ['CNY', /CN¥|RMB|CNY|元|[¥￥]|yuan/i], ['USD', /\bUS\s?\$|\bUSD\b/i], ['HKD', /\bHK\$|\bHKD\b/i],
    ['AUD', /\bAU?\$|\bAUD\b/i], ['NZD', /\bNZ\$|\bNZD\b/i], ['CAD', /\bCA?\$|\bCAD\b/i], ['SGD', /\bS\$|\bSGD\b/i], ['USD', /\$/],
    ['EUR', /€|\bEUR\b|\beuros?\b/i], ['GBP', /£|\bGBP\b/i]];
  /**
   * A price as typed or pasted: "¥23.50", "23,5 元", "US $3.20", "€2,80", "12.50-15.00 CNY". A range is two prices: the
   * top is used (what small orders pay). Returns { amount, cur, low } (low: the bottom of a range, else null), or null.
   * A number without a currency is in cur0.
   */
  function parsePrice(x, cur0 = 'EUR') {
    if (typeof x === 'number') return Number.isFinite(x) && x >= 0 ? { amount: round(x, 4), cur: cur0, low: null } : null;
    const s = cleanText(x, 80);
    if (!s || /^[-−]/.test(s)) return null; // empty or below zero
    let cur = '';
    for (const [c, re] of CURS) {
      if (re.test(s)) {
        cur = c;
        break;
      }
    }
    if (!cur) cur = (/\b([A-Z]{3})\b/.exec(s) || [])[1] || '';
    const nums = (s.match(/\d[\d.,]*\d|\d/g) || []).map(numberOf);
    if (!nums.length || nums.length > 2 || nums.some((n) => !(n >= 0))) return null;
    const amount = Math.max(...nums);
    return { amount: round(amount, 4), cur: cur || cur0, low: nums.length === 2 ? round(Math.min(...nums), 4) : null };
  }

  /** { eur, rate, cur } for an amount in cur, or null when the settings have no rate for that currency. */
  function toEur(amount, cur, s) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return null;
    const c = String(cur || 'EUR').toUpperCase();
    const rate = c === 'EUR' ? 1 : s && s.fx && Object.hasOwn(s.fx, c) && Number(s.fx[c]) > 0 ? Number(s.fx[c]) : null;
    return rate == null ? null : { eur: n * rate, rate, cur: c };
  }

  /** "300", "300 g", "0,3 kg", "1.2kg" in grams (a number with a decimal point and no unit is in kilos), 1 g to 50 kg; else null. */
  function parseWeight(x) {
    if (typeof x === 'number') return Number.isFinite(x) && x >= 1 && x <= 50000 ? Math.round(x) : null;
    const s = cleanText(x, 40).toLowerCase().replace(/\s+/g, '').replace(',', '.');
    const m = /^(\d+(?:\.\d+)?)(kg|kilos?|kilograms?|g|gr|grams?)?$/.exec(s);
    if (!m) return null;
    const kilos = m[2] ? m[2].startsWith('k') : m[1].includes('.');
    const g = Math.round(Number(m[1]) * (kilos ? 1000 : 1));
    return g >= 1 && g <= 50000 ? g : null;
  }

  /**
   * The settings as they are used and saved: every number within its bounds (else its default), the two customs days
   * (YYYY-MM-DD, or '' for never), shipping tiers sorted by weight, exchange rates as three-letter codes. Anything else
   * is dropped. Red never starts below green.
   */
  function cleanSettings(raw) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const val = (x) => (typeof x === 'string' ? numberOf(x) : x);
    const s = {};
    for (const [k, [lo, hi, whole]] of Object.entries(NUMS)) {
      const n = val(r[k]);
      s[k] = typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? (whole ? Math.round(n) : round(n, 4)) : DEFAULTS[k];
    }
    if (s.red_roas < s.green_roas) s.red_roas = s.green_roas;
    for (const k of ['duty_from', 'handling_from']) s[k] = r[k] === '' || isDay(r[k]) ? r[k] : DEFAULTS[k];
    s.direct = typeof r.direct === 'boolean' ? r.direct : DEFAULTS.direct;
    s.fx = {};
    const fx = r.fx && typeof r.fx === 'object' && !Array.isArray(r.fx) ? r.fx : DEFAULTS.fx;
    for (const [c, v] of Object.entries(fx).slice(0, 60)) {
      const n = val(v);
      if (/^[A-Z]{3}$/.test(c) && c !== 'EUR' && typeof n === 'number' && n > 0 && n <= 10000) s.fx[c] = round(n, 6);
    }
    s.cost_cur = r.cost_cur === 'EUR' || (typeof r.cost_cur === 'string' && Object.hasOwn(s.fx, r.cost_cur)) ? r.cost_cur
      : Object.hasOwn(s.fx, DEFAULTS.cost_cur) ? DEFAULTS.cost_cur : 'EUR';
    const tiers = (Array.isArray(r.ship) ? r.ship : []).slice(0, 12)
      .map((t) => (Array.isArray(t) ? [val(t[0]), val(t[1])] : [NaN, NaN]))
      .filter(([g, e]) => Number.isFinite(g) && g >= 1 && g <= 50000 && Number.isFinite(e) && e >= 0 && e <= 1000)
      .map(([g, e]) => [Math.round(g), round(e, 2)])
      .sort((a, b) => a[0] - b[0])
      .filter((t, i, a) => !i || t[0] !== a[i - 1][0]);
    s.ship = tiers.length ? tiers : DEFAULTS.ship.map((t) => t.slice());
    return s;
  }

  /**
   * What you typed for one product, as it is saved: { inputs: { cost_text, weight, price }, errors }. Each input is null
   * when empty; errors names the fields that are filled in but cannot be read. The supplier price stays as you typed it
   * (its currency and range count every time the numbers are worked out); weight in grams; your selling price in euros.
   */
  function cleanInputs(raw, s) {
    const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const inputs = { cost_text: null, weight: null, price: null };
    const errors = {};
    const filled = (x) => x != null && String(x).trim() !== '';
    if (filled(r.cost)) {
      const t = cleanText(r.cost, 80);
      const p = parsePrice(t, s.cost_cur);
      if (p && p.amount <= 1e6 && toEur(p.amount, p.cur, s)) inputs.cost_text = t;
      else errors.cost = 'Not a price: try ¥23.50, $3.20 or €2.80';
    }
    if (filled(r.weight)) {
      const w = parseWeight(r.weight);
      if (w != null) inputs.weight = w;
      else errors.weight = 'Not a weight: try 300 g or 0.3 kg';
    }
    if (filled(r.price)) {
      const p = parsePrice(typeof r.price === 'number' ? r.price : cleanText(r.price, 40), 'EUR');
      const e = p && toEur(p.amount, p.cur, s);
      if (e && e.eur > 0 && e.eur <= 1e5) inputs.price = round(e.eur, 2);
      else errors.price = 'Not a price: try 39,95';
    }
    return { inputs, errors };
  }

  /**
   * What counts for one product, field by field: what you typed (cleanInputs), else the supplier you chose in 🔎 Sourcing
   * (sourcing.mjs, D1 product_sourcing: { cost: its price in euros, weight: packed grams, ship: its shipping quote in
   * euros }). from: where the supplier price and the weight came from. The quote counts when there is one.
   */
  function mergeInputs(typed, sourced) {
    const t = typed || {};
    const so = sourced || {};
    const out = { cost_text: t.cost_text || null, weight: t.weight == null ? null : t.weight, price: t.price == null ? null : t.price, ship: null,
      from: { cost: t.cost_text ? 'yours' : null, weight: t.weight != null ? 'yours' : null } };
    if (!out.cost_text && num(so.cost) > 0) {
      out.cost_text = '€' + round(num(so.cost), 4);
      out.from.cost = 'sourcing';
    }
    if (out.weight == null && num(so.weight) >= 1) {
      out.weight = Math.round(num(so.weight));
      out.from.weight = 'sourcing';
    }
    if (num(so.ship) != null && num(so.ship) >= 0) out.ship = round(num(so.ship));
    return out;
  }

  /** Shipping for a parcel of g grams: the first tier it fits in; past the last one, that tier plus a rate per started kilo. */
  function shipOf(g, s) {
    const t = s.ship.find((x) => g <= x[0]);
    if (t) return { eur: t[1], tier: `up to ${t[0]} g`, over: false };
    const last = s.ship[s.ship.length - 1];
    return { eur: round(last[1] + Math.ceil((g - last[0]) / 1000) * s.ship_extra_kg, 2), tier: `over ${last[0]} g`, over: true };
  }

  /**
   * The EU's customs on one parcel from China to the buyer, on day (YYYY-MM-DD): the flat duty on a parcel worth up to
   * duty_max before VAT, from duty_from, and the handling fee per item line, from handling_from. Over duty_max (over:
   * true): no flat duty and no IOSS, the buyer pays VAT and duty at the door. Sent from EU stock (direct false): none.
   */
  function customsOf(net, day, s) {
    if (!s.direct) return { duty: 0, handling: 0, over: false };
    const over = net > s.duty_max;
    const on = (from) => !!from && !!day && day >= from;
    return { duty: !over && on(s.duty_from) ? s.duty_eur : 0, handling: on(s.handling_from) ? round(s.handling_eur * s.lines, 2) : 0, over };
  }

  /**
   * One product's unit economics and verdict.
   *   basis: what the board knows: { src: 'eu' | 'world' | 'tiktok', price and cur: its store's price (in the ads),
   *     age: days its ads run (outside the EU: its oldest ad), products: its store's size, risks: [{ k, text }],
   *     checked: Jev has read it }
   *   inputs: cleanInputs().inputs, or null    settings: cleanSettings()    day: 'YYYY-MM-DD' (which customs apply)
   * An order: the price (yours, else theirs in euros) − VAT − payment fees − refunds − the landed cost (supplier + agent
   * + shipping + EU duty + handling) = the margin before ads. Break-even ROAS = price / margin; break-even CPA = margin.
   * Returns { m: the money of one order (null without a price), level: 'red' | 'amber' | 'green', reasons: [{ k, level,
   * text }] (red, amber, green, then info), guess: { cost, weight }: what is still a guess }.
   */
  function evaluate(basis, inputs, settings, day) {
    const s = settings && Array.isArray(settings.ship) && settings.fx ? settings : cleanSettings(settings);
    const b = basis || {};
    const i = inputs || {};
    const today = typeof day === 'string' ? day.slice(0, 10) : '';
    const reasons = [];
    const add = (k, level, text) => reasons.push({ k, level, text });
    const theirs = num(b.price) > 0 ? toEur(num(b.price), b.cur || 'EUR', s) : null;
    const yours = num(i.price) > 0 ? num(i.price) : null;
    const price = yours != null ? round(yours) : theirs ? round(theirs.eur) : null;
    const from = i.from && typeof i.from === 'object' ? i.from : {};
    const typed = i.cost_text ? parsePrice(i.cost_text, s.cost_cur) : null;
    const typedEur = typed ? toEur(typed.amount, typed.cur, s) : null;
    const weight = num(i.weight) >= 1 ? Math.round(num(i.weight)) : null;
    const quoted = num(i.ship) != null && num(i.ship) >= 0 ? round(num(i.ship)) : null; // a supplier's shipping quote
    const guess = { cost: !typedEur, weight: weight == null && quoted == null };
    let m = null;
    if (price == null) {
      add('price', 'amber', num(b.price) > 0 ? `No euro rate for ${b.cur} in Settings: type your selling price` : 'No price known: type what you would sell it for');
    } else {
      const v = s.vat_pct;
      const vat = (price * v) / (100 + v);
      const net = price - vat;
      const fees = (price * s.fee_pct) / 100 + s.fee_fixed;
      const refunds = (net * s.refund_pct) / 100;
      const cost = typedEur ? typedEur.eur : (price * s.cost_guess_pct) / 100;
      const g = weight != null ? weight : s.weight_guess_g;
      const ship = quoted != null ? { eur: quoted, tier: "the chosen supplier's quote", over: false } : shipOf(g, s);
      const cu = customsOf(net, today, s);
      const fixed = s.agent_fee + ship.eur + cu.duty + cu.handling; // per order, whatever the price
      const landed = cost + fixed;
      const c = net - fees - refunds - landed;
      const beRoas = c > 0 ? price / c : null;
      // The lowest price that is green at this supplier cost (a guessed one: a free product, the floor no supplier beats):
      // the margin is k × price − K, so break-even ROAS g at g K / (g k − 1).
      const k = (1 - s.refund_pct / 100) / (1 + v / 100) - s.fee_pct / 100;
      const K = s.fee_fixed + fixed + (guess.cost ? 0 : cost);
      const gk = s.green_roas * k;
      const maxCost = cost + c - price / s.green_roas; // the most the supplier may ask for green at this price
      m = {
        price, price_from: yours != null ? 'yours' : 'theirs',
        theirs: theirs ? { price: round(num(b.price)), cur: theirs.cur, rate: theirs.rate, eur: round(theirs.eur) } : null,
        vat: round(vat), vat_pct: v, net: round(net), fees: round(fees), fee_pct: s.fee_pct, fee_fixed: s.fee_fixed, refunds: round(refunds), refund_pct: s.refund_pct,
        cost: round(cost), cost_from: guess.cost ? 'guess' : from.cost === 'sourcing' ? 'sourcing' : 'yours', guess_pct: s.cost_guess_pct, cost_amount: typedEur ? typed.amount : null, cost_cur: typedEur ? typed.cur : null,
        cost_low: typedEur ? typed.low : null, agent: round(s.agent_fee), weight: g, weight_from: weight == null ? 'guess' : from.weight === 'sourcing' ? 'sourcing' : 'yours',
        ship: round(ship.eur), ship_tier: ship.tier, ship_from: quoted != null ? 'quote' : 'tier',
        duty: round(cu.duty), handling: round(cu.handling), lines: s.lines, landed: round(landed),
        contribution: round(c), pct: round((c / price) * 100, 1), be_roas: beRoas == null ? null : round(beRoas), be_cpa: round(Math.max(c, 0)),
        target_roas: s.target_roas, profit: round(c - price / s.target_roas),
        max_cost: round(maxCost), max_cost_cny: s.fx.CNY > 0 ? round(maxCost / s.fx.CNY) : null,
        min_price: gk > 1 ? round((s.green_roas * K) / (gk - 1)) : null, min_price_free: guess.cost,
      };
      if (c <= 0) add('loss', 'red', `Loses ${eur(-c)} on every order before ads`);
      else if (beRoas >= s.red_roas) add('roas', 'red', `Break-even ROAS ${times(beRoas)}: ads must bring in ${times(beRoas)} what they cost just to break even (red from ${times(s.red_roas)})`);
      else if (beRoas > s.green_roas) add('roas', 'amber', `Break-even ROAS ${times(beRoas)} (green up to ${times(s.green_roas)})`);
      else add('roas', 'green', `Break-even ROAS ${times(beRoas)}: room for ads (green up to ${times(s.green_roas)})`);
      if (c > 0 && c < s.min_profit) add('thin', 'amber', `${eur(c)} per order to pay for ads: a CPA above that loses money (amber under ${eur(s.min_profit)})`);
      if (cu.over) add('over', 'red', `${eur(net)} before VAT is over ${eur(s.duty_max)}: no IOSS and no flat duty, so the buyer pays VAT and import duty at the door`);
      if (ship.over) add('heavy', 'amber', `${g} g is past the last shipping tier: get a freight quote (counted as ${eur(ship.eur)})`);
      if (i.cost_text && !typedEur) add('cost', 'info', `No euro rate for the supplier price "${i.cost_text}": guessed at ${s.cost_guess_pct}% of the price (${eur(cost)})`);
      else if (guess.cost) add('cost', 'info', `Supplier price is a guess: ${s.cost_guess_pct}% of the selling price (${eur(cost)}). Type the 1688 price.`);
      else if (from.cost === 'sourcing') add('sourced', 'info', `Supplier price from Sourcing: ${eur(cost)}, the supplier you chose`);
      else if (typed.low != null) add('range', 'info', `Price range ${money(typed.low, typed.cur)} to ${money(typed.amount, typed.cur)}: the top is used, what small orders pay`);
      if (quoted != null) add('quoted', 'info', `Shipping as the chosen supplier quotes it: ${eur(quoted)}`);
      if (guess.weight) add('weight', 'info', `Weight is a guess: ${g} g`);
      if (yours == null && theirs && theirs.cur !== 'EUR') add('fx', 'info', `Their ${money(num(b.price), theirs.cur)} is ${eur(theirs.eur)} at €${theirs.rate} per ${theirs.cur}`);
      if (yours != null && theirs) add('yours', 'info', `Your price ${eur(price)}; their store asks ${theirs.cur === 'EUR' ? eur(theirs.eur) : money(num(b.price), theirs.cur)}`);
      if (!s.direct) add('stock', 'info', 'Sent from EU stock: no EU parcel customs counted');
    }
    // Proof: how long its ads run, how big its store is.
    const age = num(b.age);
    if (age != null) {
      const what = b.src === 'world' ? `Its oldest ad runs ${age} days` : `Its ads run ${age} days`;
      if (age < s.young_days) add('young', 'amber', `${what}: young (amber under ${s.young_days})`);
      else add('age', 'green', what);
    }
    const n = num(b.products);
    if (n != null) {
      if (n > s.big_store) add('bigstore', 'amber', `Big store: ${n} products, its ads may sell the store more than this product`);
      else if (n <= s.focused_store) add('focused', 'green', `Focused store: ${n} products`);
    }
    // Risks: what Jev said yes to (or the TikTok tab's blockers).
    const risks = Array.isArray(b.risks) ? b.risks.filter((r) => r && r.k) : [];
    for (const r of risks) add('risk:' + r.k, RED.includes(String(r.k)) ? 'red' : 'amber', cleanText(r.text || r.k, 80));
    if (!risks.length) {
      if (b.checked) add('norisk', 'green', 'No risk flags from Jev');
      else add('nojev', 'info', 'Jev has not read it yet: its risks are not known');
    }
    reasons.sort((x, y) => ORDER[x.level] - ORDER[y.level]); // a stable sort: each level keeps its own order
    const level = reasons.some((r) => r.level === 'red') ? 'red' : reasons.some((r) => r.level === 'amber') ? 'amber' : 'green';
    return { m, level, reasons, guess };
  }

  return { DEFAULTS, cleanSettings, cleanInputs, mergeInputs, parsePrice, parseWeight, toEur, shipOf, customsOf, evaluate };
}

export const { DEFAULTS, cleanSettings, cleanInputs, mergeInputs, parsePrice, parseWeight, toEur, shipOf, customsOf, evaluate } = econKit();
/** GET /econ.js: the kit's source, run once in the board as window.ECON. */
export const ECON_JS = `'use strict';\nwindow.ECON = (${econKit})();\n`;

// ---------------------------------------------------------------------------
// The board's products, their inputs and the settings
// ---------------------------------------------------------------------------

const SETTINGS_SQL = "SELECT value FROM econ_settings WHERE key = 'settings'";
const SAVE_SETTINGS_SQL = `INSERT INTO econ_settings (key, value, updated_at) VALUES ('settings', ?1, ?2)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
const INPUT_COLS = 'product_key, cost, cost_text, weight_g, price, updated_at';
const SAVE_INPUTS_SQL = `INSERT INTO econ_inputs (${INPUT_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
ON CONFLICT(product_key) DO UPDATE SET cost = excluded.cost, cost_text = excluded.cost_text, weight_g = excluded.weight_g, price = excluded.price, updated_at = excluded.updated_at`;
const TT_SQL = 'SELECT id, title, shop, url, image_url, price_min, rating, reviews, sold_us, category, blockers, meta_status, meta_url, meta_us, meta_au, meta_nz, decision, decided_at FROM tiktok_products';
export const NOT_READY = 'The unit economics tables are not in the database yet: they come with the next deploy of the board.';

const noTable = (e) => /no such table/i.test(String(e && e.message));
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const keyIn = (k) => (typeof k === 'string' && k.length <= 1000 && /^(eu|world|tiktok)\|./s.test(k) ? k : '');
const r2 = (x) => Math.round(x * 100) / 100;
const ok = (body) => ({ status: 200, body });
const bad = (error, status = 400) => ({ status, body: { error } });
const parse = (s) => {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
};
/** An econ_inputs row as the kit takes it. */
const inputsOf = (row) => (row ? { cost_text: row.cost_text || null, weight: row.weight_g == null ? null : Number(row.weight_g), price: row.price == null ? null : Number(row.price) } : null);
const settingsOf = (row) => cleanSettings(row ? parse(row.value) : null);
// The supplier you chose in 🔎 Sourcing (sourcing.mjs): product_sourcing is the shared place for it, by the same product key.
const SOURCING_COLS = 'product_key, supplier_cost, weight_g, ship_cost';
const sourcedOf = (row) => (row && (row.supplier_cost != null || row.weight_g != null || row.ship_cost != null) ? { cost: row.supplier_cost, weight: row.weight_g, ship: row.ship_cost } : null);
/** All rows of a table the board may not have yet (an older database): none. */
const optional = (stmt) => stmt.all().then((r) => (r && r.results) || [], (e) => {
  if (noTable(e)) return [];
  throw e;
});

/**
 * The settings, every product's inputs and every supplier chosen in Sourcing, read once per request: { s, inputs: Map key →
 * inputs, sourcing: Map key → sourced, day, ready, pageKey }. Without the tables (a test link before the merge): the
 * defaults, no inputs, ready false. strict: any other D1 error is thrown (the € view); without it the board gets the
 * defaults too, so a problem here never keeps the board from opening.
 */
export async function econContext(DB, now, { pageKey = () => '', strict = false } = {}) {
  const ctx = { s: cleanSettings(null), inputs: new Map(), sourcing: new Map(), day: dayOf(now), ready: true, pageKey };
  const fail = (e, what) => {
    if (strict && !noTable(e)) throw e;
    if (!noTable(e)) console.error(`econ: ${what} not read`, e);
  };
  await Promise.all([
    Promise.all([DB.prepare(SETTINGS_SQL).first(), DB.prepare(`SELECT ${INPUT_COLS} FROM econ_inputs`).all()]).then(([row, list]) => {
      ctx.s = settingsOf(row);
      for (const x of (list && list.results) || []) ctx.inputs.set(x.product_key, inputsOf(x));
    }, (e) => {
      fail(e, 'settings and inputs');
      ctx.ready = false;
    }),
    optional(DB.prepare(`SELECT ${SOURCING_COLS} FROM product_sourcing`)).then((rows) => {
      for (const x of rows) if (sourcedOf(x)) ctx.sourcing.set(x.product_key, sourcedOf(x));
    }, (e) => fail(e, 'Sourcing')),
  ]);
  return ctx;
}

/**
 * A board product's key: outside the EU 'world|<store.com/products/handle>' (its group key); in the EU 'eu|' + its
 * product page (pageKey: productKey in app.mjs), else 'eu|' + its advertiser + title (jk once the board groups EU products
 * by product page, gk before). The key launch.mjs gives a product once the board groups by product page, and one that
 * does not change when it does.
 */
export function econKey(r, pageKey = () => '') {
  if (!r) return '';
  if (r.world) return String(r.gk);
  return 'eu|' + (pageKey(r.product_url) || r.jk || r.gk);
}

/** What the verdict needs from a product's facts (the shape of boardFacts and tiktokFacts in launch.mjs). */
export function basisOf(f, checked) {
  return {
    src: f.source, price: f.price ?? null, cur: f.cur || 'EUR', age: f.age ?? null, products: f.products ?? null,
    risks: (f.risks || []).map((r) => ({ k: String(r.k), text: String(r.text || r.k) })), checked: checked ?? !!f.jev,
  };
}
/** The same from a card of /api/ads (toAd in app.mjs). */
const basisOfAd = (a) => basisOf({ source: a.world ? 'world' : 'eu', price: a.price, cur: a.cur, age: a.age, products: a.products, risks: jevRisks(a.jev), jev: a.jev });

/**
 * A product's unit economics for the board: its key, what they were worked out from (the facts, what you typed, the
 * supplier chosen in Sourcing), and the verdict.
 */
function econOf(key, basis, inputs, ctx) {
  const sourced = (ctx.sourcing && ctx.sourcing.get(key)) || null;
  return { key, basis, inputs: inputs || null, sourced, ...evaluate(basis, mergeInputs(inputs, sourced), ctx.s, ctx.day) };
}

/** /api/ads: a card (toAd) with its unit economics (a.econ). A problem here leaves the card as it was. */
export function econAd(a, r, ctx) {
  try {
    const key = econKey(r, ctx.pageKey);
    a.econ = econOf(key, basisOfAd(a), ctx.inputs.get(key), ctx);
  } catch (e) {
    console.error('econ: card', e);
  }
  return a;
}

/**
 * Before the board sorts by margin or break-even ROAS (econSorts): each product's two numbers (r.ec), from its store's
 * price, your inputs and the settings. Only money: risks and proof do not change these two.
 */
export function econBoard(list, ctx, sort) {
  if (sort !== 'profit' && sort !== 'beroas') return list;
  const done = new Set();
  for (const r of [...list.v, ...list.k, ...(list.w || [])]) {
    if (done.has(r)) continue;
    done.add(r);
    try {
      const key = ctx.inputs.size || ctx.sourcing.size ? econKey(r, ctx.pageKey) : '';
      const { m } = evaluate({ price: r.price, cur: r.currency || 'EUR' }, key ? mergeInputs(ctx.inputs.get(key), ctx.sourcing.get(key)) : null, ctx.s, ctx.day);
      r.ec = m ? { profit: m.contribution, roas: m.be_roas } : null;
    } catch (e) {
      r.ec = null;
    }
  }
  return list;
}

/** The board's sorts by money (in SORTS and WORLD_SORTS, app.mjs): most margin per order first; lowest break-even ROAS first. Unknown last. */
export const econSorts = (tie) => ({
  profit: (a, b) => (b.ec ? b.ec.profit : -Infinity) - (a.ec ? a.ec.profit : -Infinity) || tie(a, b),
  beroas: (a, b) => (a.ec && a.ec.roas != null ? a.ec.roas : Infinity) - (b.ec && b.ec.roas != null ? b.ec.roas : Infinity) || tie(a, b),
});

// ---------------------------------------------------------------------------
// The € table: every product in the Inbox and on ✓, and the TikTok products you approved
// ---------------------------------------------------------------------------

const LEVEL_RANK = { green: 0, amber: 1, red: 2 };
const SORTS = {
  level: [(x) => LEVEL_RANK[x.econ.level], 'asc'],
  profit: [(x) => x.econ.m && x.econ.m.contribution, 'desc'],
  roas: [(x) => x.econ.m && x.econ.m.be_roas, 'asc'],
  price: [(x) => x.econ.m && x.econ.m.price, 'desc'],
  landed: [(x) => x.econ.m && x.econ.m.landed, 'asc'],
  days: [(x) => x.econ.basis.age, 'desc'],
  store: [(x) => x.econ.basis.products, 'asc'],
  title: [(x) => x.title.toLowerCase(), 'asc'],
  new: [(x) => x.at || null, 'desc'],
};
const roasOf = (x) => (x.econ.m && x.econ.m.be_roas != null ? x.econ.m.be_roas : Infinity);
/** By one column, unknown last either way; then green first, the lowest break-even ROAS, the name. */
function sorter(sort, dir) {
  const [get] = SORTS[sort];
  const sign = dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const x = get(a);
    const y = get(b);
    if ((x == null) !== (y == null)) return x == null ? 1 : -1;
    const d = x == null ? 0 : (typeof x === 'string' ? x.localeCompare(y) : x - y) * sign;
    return d || LEVEL_RANK[a.econ.level] - LEVEL_RANK[b.econ.level] || roasOf(a) - roasOf(b) || a.title.localeCompare(b.title) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  };
}

const host = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
};
/** A row of the € table, from a product's facts. */
const rowOf = (key, status, f, at, econ) => ({ key, src: f.source, status, id: String(f.id), title: f.title, img: f.img || '', ad: f.ad || '', product: f.product || f.store || '', shop: host(f.store || f.product) || f.adv || '', at: at || '', econ });

/** Every product of the table, unsorted: the EU Inbox, the Inbox outside the EU, ✓ (both), the TikTok products you approved. */
async function tableRows(env, ctx, deps) {
  const [b, tt] = await Promise.all([
    deps.board(),
    env.DB.prepare(`${TT_SQL} WHERE decision = 'approved' ORDER BY decided_at DESC LIMIT 500`).all().then((r) => r.results || [], () => []), // no TikTok table: none
  ]);
  const out = [];
  const add = (r, status) => {
    const f = boardFacts(r, deps.toAd);
    const key = econKey(r, ctx.pageKey);
    out.push(rowOf(key, status, f, status === 'approved' ? f.approved_at : r.first_seen, econOf(key, basisOf(f), ctx.inputs.get(key), ctx)));
  };
  for (const r of b.v) if (!r.world && r.hid === 0) add(r, 'inbox'); // the EU board: passes the rules, not decided
  for (const r of b.w || []) if (r.hid === 0) add(r, 'inbox'); // outside the EU: still running, not decided
  for (const r of b.k) if (r.hid === 1) add(r, 'approved'); // ✓, also once it is out of the rules
  for (const t of tt) {
    const f = tiktokFacts(t);
    const key = 'tiktok|' + t.id;
    out.push(rowOf(key, 'approved', f, f.approved_at, econOf(key, basisOf(f, t.blockers != null), ctx.inputs.get(key), ctx)));
  }
  return out;
}

/** GET /api/econ: the € table (filtered, sorted, a page of it), or ?part=settings. */
export async function econGet(env, url, now, deps) {
  const p = url.searchParams;
  const ctx = await econContext(env.DB, now, { pageKey: deps.pageKey, strict: true });
  if (p.get('part') === 'settings') return ok({ settings: ctx.s, defaults: cleanSettings(null), day: ctx.day, ready: ctx.ready });
  let rows = await tableRows(env, ctx, deps);
  const pick = (k, list) => (list.includes(p.get(k)) ? p.get(k) : '');
  const src = pick('src', ['eu', 'world', 'tiktok']);
  const status = pick('status', ['inbox', 'approved']);
  if (src) rows = rows.filter((x) => x.src === src);
  if (status) rows = rows.filter((x) => x.status === status);
  const q = String(p.get('q') || '').trim().slice(0, 80).toLowerCase();
  if (q) rows = rows.filter((x) => (x.title + ' ' + x.shop).toLowerCase().includes(q));
  if (p.get('real') === '1') rows = rows.filter((x) => !x.econ.guess.cost);
  const counts = { all: rows.length, green: 0, amber: 0, red: 0 };
  for (const x of rows) counts[x.econ.level]++;
  const level = pick('level', ['green', 'amber', 'red']);
  if (level) rows = rows.filter((x) => x.econ.level === level);
  const sort = Object.hasOwn(SORTS, p.get('sort') || '') ? p.get('sort') : 'level';
  const dir = pick('dir', ['asc', 'desc']) || SORTS[sort][1];
  rows.sort(sorter(sort, dir));
  const limit = Math.min(Math.max(parseInt(p.get('limit'), 10) || 50, 1), 100);
  const offset = Math.min(Math.max(parseInt(p.get('offset'), 10) || 0, 0), 100000);
  return ok({ rows: rows.slice(offset, offset + limit), total: rows.length, offset, counts, sort, dir, settings: ctx.s, day: ctx.day, ready: ctx.ready });
}

/** The product a key names, with what its numbers need: { facts, basis }, or null when the board has no such product. */
async function productOf(env, key, now, deps, ctx) {
  if (key.startsWith('tiktok|')) {
    const id = key.slice('tiktok|'.length);
    if (!/^\d{1,25}$/.test(id)) return null;
    const t = await env.DB.prepare(`${TT_SQL} WHERE id = ?`).bind(id).first().catch((e) => {
      if (noTable(e)) return null;
      throw e;
    });
    if (!t) return null;
    const f = tiktokFacts(t);
    return { facts: f, basis: basisOf(f, t.blockers != null) };
  }
  const r = deps.products(await deps.rows(), [], [], now).k.find((x) => econKey(x, ctx.pageKey) === key);
  if (!r) return null;
  const f = boardFacts(r, deps.toAd);
  return { facts: f, basis: basisOf(f) };
}

/** POST /api/econ: one product's inputs ({key, cost, weight, price}: all three, each '' to clear it), or the settings. */
export async function econPost(env, j, now, deps) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('Bad JSON');
  const at = new Date(now).toISOString();
  try {
    if (Object.hasOwn(j, 'settings')) {
      if (j.settings === null) {
        await env.DB.prepare("DELETE FROM econ_settings WHERE key = 'settings'").run();
        return ok({ ok: true, settings: cleanSettings(null) });
      }
      if (!j.settings || typeof j.settings !== 'object' || Array.isArray(j.settings)) return bad('Bad settings');
      const s = cleanSettings(j.settings);
      await env.DB.prepare(SAVE_SETTINGS_SQL).bind(JSON.stringify(s), at).run();
      return ok({ ok: true, settings: s });
    }
    const key = keyIn(j.key);
    if (!key) return bad('Bad key');
    const ctx = await econContext(env.DB, now, { pageKey: deps.pageKey, strict: true });
    if (!ctx.ready) return bad(NOT_READY, 503);
    const { inputs, errors } = cleanInputs(j, ctx.s);
    if (Object.keys(errors).length) return { status: 400, body: { error: Object.values(errors)[0], errors } };
    const product = await productOf(env, key, now, deps, ctx);
    if (!product) return bad('Unknown product', 404);
    const empty = inputs.cost_text == null && inputs.weight == null && inputs.price == null;
    if (empty) await env.DB.prepare('DELETE FROM econ_inputs WHERE product_key = ?').bind(key).run();
    else {
      const p = inputs.cost_text ? parsePrice(inputs.cost_text, ctx.s.cost_cur) : null;
      const e = p ? toEur(p.amount, p.cur, ctx.s) : null;
      await env.DB.prepare(SAVE_INPUTS_SQL).bind(key, e ? r2(e.eur) : null, inputs.cost_text, inputs.weight, inputs.price, at).run();
    }
    return ok({ ok: true, key, econ: econOf(key, product.basis, empty ? null : inputs, ctx) });
  } catch (e) {
    if (noTable(e)) return bad(NOT_READY, 503);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The decision log: every approve and reject with the facts the board showed then; Undo
// ---------------------------------------------------------------------------

const LOG_COLS = 'd.id, d.product_key, d.ad_id, d.source, d.decision, d.title, d.level, d.profit, d.be_roas, d.facts, d.at, d.undone_at, d.undo_via';
const LATEST = '(SELECT MAX(x.id) FROM decision_log x WHERE x.product_key = d.product_key) = d.id AS latest';
const INSERT_LOG_SQL = 'INSERT INTO decision_log (product_key, ad_id, source, decision, title, level, profit, be_roas, facts, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
const DECIDED = { seen: 'approved', rejected: 'rejected' };

/** A decision_log row for the board. latest: no newer decision on its product (only that one can be taken back). */
export const logOut = (r) => ({
  id: Number(r.id), key: r.product_key, ad_id: r.ad_id || '', src: r.source || '', decision: r.decision, title: r.title || '', level: r.level || null,
  profit: r.profit == null ? null : Number(r.profit), be_roas: r.be_roas == null ? null : Number(r.be_roas), facts: parse(r.facts) || {},
  at: r.at || '', undone_at: r.undone_at || null, undo_via: r.undo_via || null, latest: Number(r.latest) === 1,
});

/**
 * The decisions on one product that still stand: logged under its key (the board's own: launch.mjs keyOf, the group
 * /api/hide decides on), or on one of its ads (ids: so a row logged before the board grouped products another way is
 * still found). At most 90 ids: D1 takes 100 bound values a query.
 */
function standing(env, sql, args, key, ids) {
  const part = ids.slice(0, 90);
  const inIds = part.length ? ` OR ad_id IN (${part.map(() => '?').join(', ')})` : '';
  return env.DB.prepare(`${sql} WHERE undone_at IS NULL AND (product_key = ?${inIds})`).bind(...args, key, ...part);
}
/**
 * One decision, logged: a decision before it on the same product that still stood is now replaced (in one batch).
 * facts: the product as the board showed it, with its unit economics (econ: key, inputs, money, verdict and reasons).
 */
async function logIt(env, x) {
  const e = x.econ;
  const facts = Object.assign({}, x.facts, { econ: { key: e.key, inputs: e.inputs, sourced: e.sourced, m: e.m, level: e.level, reasons: e.reasons, guess: e.guess } });
  await env.DB.batch([
    standing(env, "UPDATE decision_log SET undone_at = ?, undo_via = 'replaced'", [x.at], x.key, x.ids),
    env.DB.prepare(INSERT_LOG_SQL).bind(x.key, x.adId, x.src, x.decision, String(x.title || '').slice(0, 300), e.level, e.m ? e.m.contribution : null, e.m ? e.m.be_roas : null, JSON.stringify(facts), x.at),
  ]);
}
/** The decision on a product that still stood, taken back on the board (Undo, Remove from ✓, Unhide, or the TikTok tab). */
const takenBack = (env, key, ids, at) => standing(env, "UPDATE decision_log SET undone_at = ?, undo_via = 'board'", [at], key, ids).run();
/** The settings, one product's inputs and its supplier chosen in Sourcing, for one decision (3 rows read, not every product's). */
async function econFor(env, key, now) {
  const [row, input, src] = await Promise.all([env.DB.prepare(SETTINGS_SQL).first(), env.DB.prepare(`SELECT ${INPUT_COLS} FROM econ_inputs WHERE product_key = ?`).bind(key).first(),
    optional(env.DB.prepare(`SELECT ${SOURCING_COLS} FROM product_sourcing WHERE product_key = ?`).bind(key))]);
  const sourced = sourcedOf(src[0]);
  return { ctx: { s: settingsOf(row), day: dayOf(now), sourcing: new Map(sourced ? [[key, sourced]] : []) }, inputs: inputsOf(input) };
}

/**
 * /api/hide with the log: the decision is made as before (run). Once it went through, it is logged with the product's
 * facts and unit economics as the board shows them now (seen: approved; rejected), or the last decision on the product
 * that still stood is taken back (none: Undo, Remove from ✓, Unhide). The star is no decision. A log that cannot be
 * written (no table yet, a D1 error) leaves the decision as it is.
 */
export async function decisionLogged(req, env, now, deps, run) {
  let body = '';
  try {
    body = await req.clone().text();
  } catch (e) {
    body = '';
  }
  const res = await run(req);
  if (res.status !== 200) return res;
  try {
    const j = JSON.parse(body);
    const status = String((j && j.status) || '');
    if (status === 'none' || Object.hasOwn(DECIDED, status)) {
      const id = String(j.ad_id || '');
      const rows = await deps.rows();
      const me = rows.find((w) => w.ad_id === id);
      const group = me ? rows.filter((w) => w.gk === me.gk) : [];
      const r = group.length && deps.products(group, [], [], now).k[0];
      if (r) {
        const key = keyOf(r); // the product as /api/hide decides on it
        const ids = group.map((w) => String(w.ad_id));
        const at = new Date(now).toISOString();
        if (status === 'none') await takenBack(env, key, ids, at);
        else {
          const f = boardFacts(r, deps.toAd);
          const ek = econKey(r, deps.pageKey); // its inputs: by product page
          const { ctx, inputs } = await econFor(env, ek, now);
          await logIt(env, { key, ids, adId: id, src: f.source, decision: DECIDED[status], title: f.title, facts: f, econ: econOf(ek, basisOf(f), inputs, ctx), at });
        }
      }
    }
  } catch (e) {
    if (!noTable(e)) console.error('decision log', e);
  }
  return res;
}

/** /api/tiktok with the log: a decision on the TikTok tab (body: what tiktokDecide answered), logged as one on the board. */
export async function tiktokLogged(env, body, now) {
  try {
    const id = String((body && body.id) || '');
    if (!/^\d{1,25}$/.test(id)) return;
    const key = 'tiktok|' + id;
    const at = new Date(now).toISOString();
    if (!body.decision) {
      await takenBack(env, key, [], at);
      return;
    }
    const t = await env.DB.prepare(`${TT_SQL} WHERE id = ?`).bind(id).first();
    if (!t) return;
    const f = tiktokFacts(t);
    const { ctx, inputs } = await econFor(env, key, now);
    await logIt(env, { key, ids: [], adId: id, src: 'tiktok', decision: body.decision === 'approved' ? 'approved' : 'rejected', title: f.title, facts: f, econ: econOf(key, basisOf(f, t.blockers != null), inputs, ctx), at });
  } catch (e) {
    if (!noTable(e)) console.error('decision log (TikTok)', e);
  }
}

/**
 * Every decision the board holds now, logged or from before the log: products approved (✓) and rejected, on the board
 * (hidden: one row per decided product) and on the TikTok tab. Read-only; your approval rate.
 */
async function boardCounts(env) {
  const all = (sql) => env.DB.prepare(sql).all().then((r) => r.results || [], (e) => {
    if (noTable(e)) return [];
    throw e;
  });
  const [h, t] = await Promise.all([all('SELECT status AS d, COUNT(*) AS n FROM hidden GROUP BY status'), all('SELECT decision AS d, COUNT(*) AS n FROM tiktok_products WHERE decision IS NOT NULL GROUP BY decision')]);
  const out = { approved: 0, rejected: 0 };
  for (const x of h.concat(t)) {
    if (x.d === 'seen' || x.d === 'approved') out.approved += Number(x.n);
    else if (x.d === 'rejected') out.rejected += Number(x.n);
  }
  return out;
}

/**
 * GET /api/decisions: the log, the newest first. d: approved | rejected; undone=1: also the ones taken back or replaced.
 * board: every decision the board holds now (boardCounts), also those from before the log.
 */
export async function decisionsGet(env, url) {
  const board = await boardCounts(env);
  const p = url.searchParams;
  const d = ['approved', 'rejected'].includes(p.get('d')) ? p.get('d') : '';
  const where = [];
  const args = [];
  if (d) {
    where.push('d.decision = ?');
    args.push(d);
  }
  if (p.get('undone') !== '1') where.push('d.undone_at IS NULL');
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(Math.max(parseInt(p.get('limit'), 10) || 50, 1), 100);
  const offset = Math.min(Math.max(parseInt(p.get('offset'), 10) || 0, 0), 1000000);
  try {
    const [rows, n, c] = await Promise.all([
      env.DB.prepare(`SELECT ${LOG_COLS}, ${LATEST} FROM decision_log d ${w} ORDER BY d.id DESC LIMIT ? OFFSET ?`).bind(...args, limit, offset).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM decision_log d ${w}`).bind(...args).first(),
      env.DB.prepare('SELECT decision, COUNT(*) AS n FROM decision_log WHERE undone_at IS NULL GROUP BY decision').all(),
    ]);
    const counts = { approved: 0, rejected: 0 };
    for (const x of c.results || []) if (Object.hasOwn(counts, x.decision)) counts[x.decision] = Number(x.n);
    return ok({ rows: (rows.results || []).map(logOut), total: Number((n && n.n) || 0), offset, counts, board, ready: true });
  } catch (e) {
    if (!noTable(e)) throw e;
    return ok({ rows: [], total: 0, offset: 0, counts: { approved: 0, rejected: 0 }, board, ready: false });
  }
}

const CHANGED = 'This product was decided again since (on the board): nothing to take back here';

/**
 * POST /api/decisions {undo: id}: takes a decision back from the log. Only the newest decision on its product, only
 * once, and only while the product still has that decision on the board (else the board changed since, and an undo here
 * would take back the newer one). The product is undecided again, as with Undo on the board: back in the Inbox (or on
 * the TikTok tab). deps.hide(adId, 'none'): /api/hide in app.mjs.
 */
export async function decisionsPost(env, j, now, deps) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('Bad JSON');
  const id = Number(j.undo);
  if (!Number.isSafeInteger(id) || id < 1) return bad('Bad id');
  try {
    const row = await env.DB.prepare(`SELECT ${LOG_COLS} FROM decision_log d WHERE d.id = ?`).bind(id).first();
    if (!row) return bad('No such decision', 404);
    if (row.undone_at) return bad('Already taken back', 409);
    const newer = await env.DB.prepare('SELECT id FROM decision_log WHERE product_key = ? AND id > ? LIMIT 1').bind(row.product_key, id).first();
    if (newer) return bad('A newer decision on this product replaced it: take that one back', 409);
    const adId = String(row.ad_id);
    let ids = [];
    if (row.source === 'tiktok') {
      const t = await env.DB.prepare('SELECT decision FROM tiktok_products WHERE id = ?').bind(adId).first();
      if (!t) return bad('This product is no longer on the TikTok tab', 404);
      if (t.decision !== row.decision) return bad(CHANGED, 409);
      const out = await tiktokDecide(env, { id: adId, decision: '' }, now);
      if (out.status !== 200) return bad('This product is no longer on the TikTok tab', 404);
    } else {
      const rows = await deps.rows();
      const me = rows.find((w) => w.ad_id === adId);
      if (!me) return bad('This product is no longer on the board', 404);
      ids = rows.filter((w) => w.gk === me.gk).map((w) => String(w.ad_id));
      const part = ids.slice(0, 90);
      const { results } = await env.DB.prepare(`SELECT status FROM hidden WHERE ad_id IN (${part.map(() => '?').join(', ')})`).bind(...part).all();
      if (!(results || []).some((h) => h.status === (row.decision === 'approved' ? 'seen' : 'rejected'))) return bad(CHANGED, 409);
      const res = await deps.hide(adId, 'none');
      if (res.status !== 200) return bad('This product is no longer on the board', 404);
    }
    // This decision is taken back from the log; any other of the same product that still stood went with it.
    await standing(env, "UPDATE decision_log SET undone_at = ?, undo_via = CASE WHEN id = ? THEN 'log' ELSE 'board' END", [new Date(now).toISOString(), id], row.product_key, ids).run();
    const after = await env.DB.prepare(`SELECT ${LOG_COLS}, ${LATEST} FROM decision_log d WHERE d.id = ?`).bind(id).first();
    return ok({ ok: true, undone: logOut(after) });
  } catch (e) {
    if (noTable(e)) return bad(NOT_READY, 503);
    throw e;
  }
}
