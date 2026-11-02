/*
 * 🔎 Sourcing, the supplier match pipeline: a panel on a launch card (launch.mjs) that takes the product you launch to a
 * supplier you trust, at a cost you know. Search links to 1688, AliExpress, Alibaba and CJ (by its name, and by its photo
 * where a link can carry one); supplier candidates you paste or fill in (link, price, MOQ, rating, factory or trader,
 * repeat buyers, notes), compared on what one order costs at the customer's door; the vetting and sample-order
 * checklists; a first message for an agent or a supplier in English and Chinese; and CJ Dropshipping's own cost, stock
 * and freight to NL, DE and FR when the Worker has a CJ_API_KEY secret (off without it).
 * Choosing a supplier wires its numbers into the launch: product_sourcing (supplier_cost, supplier_url, weight_g: the
 * shared columns other parts of the board read) and the launch card's Sourcing step (unit cost, supplier link, shipping,
 * MOQ, lead time), which its margin and break-even ROAS already use. Tables: migrations/0016_sourcing.sql.
 *   GET  /api/sourcing?key=…                              { sourcing, suppliers, fx, fees, cj }: the panel of one card
 *   POST /api/sourcing {key, add: {paste, …fields}}       a candidate: a link or the text an app shares, and its facts
 *   POST /api/sourcing {key, id, set: {…fields}}          change a candidate (the chosen one: the launch follows)
 *   POST /api/sourcing {key, id, remove: true}            delete a candidate
 *   POST /api/sourcing {key, choose: id | null}           the supplier you go with (null: none)
 *   POST /api/sourcing {key, check: {list, k, on}}        tick an item of the vetting ('vet') or sample ('sample') list
 *   POST /api/sourcing {key, info: {zh, weight_g, eur_cny, eur_usd}}  the product's own sourcing facts
 *   POST /api/sourcing {key, cj: {find: 'photo' | 'name', q}}         CJ: products like this one
 *   POST /api/sourcing {key, cj: {pid, add}}               CJ: one product's cost, stock and freight; add: as a candidate
 *   GET  /sourcing.js                                     sourcingKit as a script (window.SOURCING), as /launch.js
 * key: a launch card's product_key, exactly as launches holds it. app.mjs checks the PIN cookie, the origin and the JSON
 * before any of this runs. All SQL is parameterized; the only names put into SQL come from the fixed FIELDS list.
 */
import { cleanStep, launchOut, STEPS } from './launch.mjs';

/**
 * Everything the panel works out, in one function that uses nothing from outside itself: the Worker calls it, and
 * /sourcing.js sends its source to the board, so the browser runs the same tested code.
 */
export function sourcingKit() {
  // Where a supplier link is from, and the currency its prices are shown in.
  const PLATFORMS = {
    1688: { label: '1688', cur: 'CNY', host: /(^|\.)1688\.com$/ },
    aliexpress: { label: 'AliExpress', cur: 'EUR', host: /(^|\.)aliexpress\.(com|us|ru)$/ },
    alibaba: { label: 'Alibaba', cur: 'USD', host: /(^|\.)alibaba\.com$/ },
    cj: { label: 'CJ', cur: 'USD', host: /(^|\.)cjdropshipping\.(com|cn)$/ },
    other: { label: 'Other', cur: 'EUR', host: null },
  };
  const SIGN = { CNY: '¥', USD: '$', EUR: '€' };
  // One euro in yuan and in dollars until you set your own rate for a product (the panel's numbers).
  const FX = { CNY: 8.3, USD: 1.16 };
  const RATES = { eur_cny: [4, 15], eur_usd: [0.5, 2] }; // a rate outside these is a typo
  // EU import fees on a parcel from outside the EU, as researched for the board (docs/learnings): a €3 customs duty on a
  // parcel worth under €150 from 1 July 2026, and a €2 handling fee per item line from 1 November 2026. One product in
  // an order: €5. Stock already in the EU pays none. (A parcel of €150 or more pays the normal duty: not estimated here.)
  const EU_FEES = { duty: 3, duty_from: '2026-07-01', under: 150, handling: 2, handling_from: '2026-11-01' };
  const MAX = { url: 500, text: 200, notes: 1000, paste: 2000, zh: 100 };

  // A supplier candidate's fields. t: url, text, money (in its currency), int, pct, rating (0 to 5) or choice.
  const FIELDS = [
    { k: 'url', t: 'url', label: 'Link' },
    { k: 'title', t: 'text', label: 'Name' },
    { k: 'unit_price', t: 'money', label: 'Price per unit' },
    { k: 'currency', t: 'choice', label: 'Currency', options: [['CNY', '¥ yuan'], ['USD', '$ dollar'], ['EUR', '€ euro']] },
    { k: 'ship_price', t: 'money', label: 'Shipping to NL, one order' },
    { k: 'moq', t: 'int', label: 'MOQ (units)', max: 1e7 },
    { k: 'rating', t: 'rating', label: 'Rating (0–5)' },
    { k: 'repeat_rate', t: 'pct', label: 'Repeat buyers %' },
    { k: 'kind', t: 'choice', label: 'Factory or trader', options: [['factory', 'Factory'], ['trader', 'Trader']] },
    { k: 'origin', t: 'choice', label: 'Ships from', options: [['cn', 'China'], ['eu', 'EU stock']] },
    { k: 'weight_g', t: 'int', label: 'Packed weight (g)', max: 1e6 },
    { k: 'lead_days', t: 'int', label: 'Days to the customer', max: 365 },
    { k: 'notes', t: 'text', label: 'Notes', long: true },
  ];
  // The product's own facts in the panel. '' clears one (a rate then goes back to the default).
  const INFO = [
    { k: 'zh', t: 'text', label: 'Chinese search words (1688)', max: MAX.zh },
    { k: 'weight_g', t: 'int', label: 'Packed weight (g)', max: 1e6 },
    { k: 'eur_cny', t: 'rate', label: '¥ for €1' },
    { k: 'eur_usd', t: 'rate', label: '$ for €1' },
  ];

  // Before you pay a supplier (questions 4–14 of the sourcing research, docs/learnings/sourcing-and-shipping.md).
  const VET = [
    { k: 'factory', label: 'Factory, or a trader you trust; monthly capacity asked' },
    { k: 'record', label: 'Track record: years on the platform, rating, repeat buyers (1688: 回头率)' },
    { k: 'video', label: 'Unedited video showing today’s date and your name, or a short video call' },
    { k: 'certs', label: 'CE / RoHS / REACH report: number, lab and applicant, checked as genuine' },
    { k: 'battery', label: 'Battery: UN38.3 summary, safety data sheet, capacity in Wh (or no battery)' },
    { k: 'packed', label: 'Packed weight and size, units per carton, carton size and weight' },
    { k: 'lead', label: 'Lead time per quantity; ships to your agent or single parcels, how fast after payment' },
    { k: 'defects', label: 'Defect policy in writing' },
    { k: 'branding', label: 'Logo or own packaging: MOQ and cost; a private mould fee, if any' },
    { k: 'pay', label: 'Paid through 1688, Trade Assurance or your agent: never a private bank account' },
  ];
  // From sample to first order (the research's seven-day plan, D0 to D6).
  const SAMPLE = [
    { k: 'two', label: 'Samples from the top two suppliers, through your agent' },
    { k: 'same', label: 'Sample is bulk quality; the sample fee is credited on a bulk order' },
    { k: 'qc', label: 'Agent QC: photos, a function video, measurements' },
    { k: 'rival', label: 'A competitor’s unit bought locally, as the quality bar' },
    { k: 'weighed', label: 'Sample weighed and measured, packed (the weight below)' },
    { k: 'tested', label: 'Full test on arrival: function, materials, smell, finish, box' },
    { k: 'labels', label: 'CE mark and GPSR label: EU address, product ID, warnings' },
    { k: 'lines', label: 'Line quotes for 0.5 and 1 kg to NL, DE, FR from 2–3 agents (PostNL, Hermes, La Poste last mile)' },
    { k: 'ioss', label: 'In writing: how the line bills the €3 + €2, that it uses your IOSS and your real sale price' },
    { k: 'tiers', label: 'Price tiers agreed for 50, 100 and 500 units' },
  ];
  const LISTS = { vet: VET, sample: SAMPLE };

  const round = (x, d) => {
    const f = 10 ** d;
    const r = Math.round(x * f) / f;
    return r === 0 ? 0 : r; // never -0
  };
  const cleanText = (x, n, lines) => String(x).replace(lines ? /[\u0000-\u0009\u000b-\u001f\u007f]+/g : /[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
  // A typed number, as the launch card reads one: "8,50", "€ 8.50" and 8.5 are 8.5 (a comma is a decimal comma unless
  // there is a dot as well).
  const numberOf = (x) => {
    if (typeof x === 'number') return x;
    if (typeof x !== 'string') return NaN;
    let s = x.replace(/[\s€$£¥￥%]/g, '');
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
    return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
  };
  // An amount in shared text: "1,234.50", "1.234,50", "12,34" and "1,234" (a comma before exactly three digits groups them).
  const amountOf = (s) => {
    let x = String(s).replace(/[.,]+$/, '');
    if (/,\d{1,2}$/.test(x)) x = x.replace(/\./g, '').replace(',', '.');
    else x = x.replace(/,/g, '');
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 && n <= 1e6 ? round(n, 2) : null;
  };

  function platformOf(url) {
    let h = '';
    try {
      h = new URL(url).hostname.toLowerCase();
    } catch (e) {
      return 'other';
    }
    for (const [k, p] of Object.entries(PLATFORMS)) if (p.host && p.host.test(h)) return k;
    return 'other';
  }

  // Tracking bits in a shared link: dropped, so the same offer pasted twice is the same link.
  const TRACKING = /^(spm|scm|utm_.*|pvid|algo_.*|aff_.*|sk|tt|src|srcSns|businessType|gatewayAdapt|ptl|tracelog|clickTrackInfo|sourceType|sharetype|shareId|share_?from|_t|bdsource)$/i;
  /** The link as it is saved: https, the offer's own address on 1688 and AliExpress, without tracking. '' when it is not a web link. */
  function cleanUrl(x) {
    let s = cleanText(x, 2 * MAX.url).replace(/\s+/g, '');
    if (/^http:\/\//i.test(s)) s = 'https://' + s.slice(7);
    else if (!/^https:\/\//i.test(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)+([/?#]\S*)?$/i.test(s)) s = 'https://' + s;
    if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+([/?#:]|$)/i.test(s)) return '';
    let u;
    try {
      u = new URL(s);
    } catch (e) {
      return '';
    }
    if (u.username || u.password) return '';
    const p = platformOf(u.href);
    const h = u.hostname.toLowerCase();
    let m;
    let out;
    if (p === '1688' && ((m = /\/offer\/(\d{5,20})\.html/.exec(u.pathname)) || (m = /^(\d{5,20})$/.exec(u.searchParams.get('offerId') || '')))) out = `https://detail.1688.com/offer/${m[1]}.html`;
    else if (p === 'aliexpress' && (m = /\/item\/(\d{5,20})\.html/.exec(u.pathname))) out = `https://www.aliexpress.com/item/${m[1]}.html`;
    else if ((p === 'alibaba' && /\/product-detail\//.test(u.pathname)) || (p === 'cj' && /\/product\//.test(u.pathname))) out = `https://${h}${u.pathname}`;
    else {
      for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
      u.hash = '';
      out = u.href.replace(/\?$/, '');
    }
    return out.length <= MAX.url ? out : '';
  }

  // Prices in shared text, with the currency they are in. A number glued to letters ("￥8kL2", a share code) is no price.
  const PRICES = [
    [/[¥￥]\s*(\d[\d,]*(?:\.\d+)?)(?![\dA-Za-z])/, 'CNY'], [/(\d[\d,]*(?:\.\d+)?)\s*元/, 'CNY'], [/\b(?:CNY|RMB)\s*(\d[\d,]*(?:\.\d+)?)(?![\dA-Za-z])/i, 'CNY'],
    [/€\s*(\d[\d.,]*\d|\d)(?![\dA-Za-z])/, 'EUR'], [/(\d[\d.,]*\d|\d)\s*€/, 'EUR'], [/\bEUR\s*(\d[\d.,]*\d|\d)(?![\dA-Za-z])/i, 'EUR'],
    [/(?:\bUS\s*)?\$\s*(\d[\d,]*(?:\.\d+)?)(?![\dA-Za-z])/i, 'USD'], [/\bUSD\s*(\d[\d,]*(?:\.\d+)?)(?![\dA-Za-z])/i, 'USD'],
  ];
  // The minimum order. Price tiers ("2-99件 ¥12 ≥100件 ¥10") start at it, so a tier's "≥" comes last.
  const MOQS = [/起批量?\s*[:：≥]?\s*(\d[\d,]*)/, /(?:MOQ|Min\.?\s*(?:order|qty)|minimum order)(?:\s*quantity)?\s*[:：]?\s*(\d[\d,]*)/i, /(\d[\d,]*)\s*(?:件|个|pcs|pieces)\s*起/i,
    /(\d[\d,]*)\s*[-~～]\s*\d[\d,]*\s*(?:件|个|pcs|pieces)/i, /[≥>]=?\s*(\d[\d,]*)\s*(?:件|个|pcs|pieces|units)/i];
  const REPEATS = [/回头率\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%/, /repeat\s*(?:buyers?|purchases?|customers?|orders?)?\s*(?:rate)?\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)\s*%/i];
  // Share-text boilerplate, never a product's name.
  const BOILER = /快来|复制|打开|淘口令|分享|发现了|好货|check (this|it) out|look what i found|i found this/i;
  // Where the facts start after a product's name in shared text: a price, a tier, the MOQ, a rating, repeat buyers, factory or trader.
  const FACT = /\d[\d.,]*\s*(?:€|元)|[¥￥€$]|\b(?:US|USD|EUR|CNY|RMB)\b|起批|\bMOQ\b|\bMin\.?\s*(?:order|qty)|minimum order|回头率|\brepeat\b|好评|\bpositive\b|\d(?:[.,]\d+)?\s*(?:分|\/\s*5\b|stars?\b)|★|源头工厂|生产厂家|工厂|厂家|\bmanufacturer\b|\bfactory\b|贸易|经销|批发商|trading company|\btrader\b|\d\s*[-~～]\s*\d+\s*(?:件|个|pcs|pieces)|[≥>]=?\s*\d/i;
  // A price in front of the name, as AliExpress shares one ("€12,34 | Name").
  const LEAD = /^(?:(?:US\s*)?[$¥￥€]\s*[\d.,]+|[\d.,]+\s*€)\s*[|｜:：\-–—]?\s*/i;

  /** What a pasted link or app share text tells about a supplier: { url, platform, currency, unit_price, moq, … }. */
  function fromPaste(text) {
    const t = cleanText(text == null ? '' : text, MAX.paste, true);
    const m = /https?:\/\/[^\s"'<>，。、；）)\]】]+/i.exec(t);
    const first = t.split(/\s+/)[0] || '';
    const url = m ? cleanUrl(m[0]) : /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(first) ? cleanUrl(first) : '';
    const rest = m ? t.replace(m[0], ' ') : url ? t.slice(first.length) : t;
    const out = {};
    if (url) {
      out.url = url;
      out.platform = platformOf(url);
      out.currency = PLATFORMS[out.platform].cur;
    }
    let price = null;
    for (const [re, cur] of PRICES) {
      const x = re.exec(rest);
      if (x && (!price || x.index < price.at)) price = { at: x.index, v: amountOf(x[1]), cur, text: x[0] };
    }
    if (price && price.v != null) Object.assign(out, { unit_price: price.v, currency: price.cur });
    for (const re of MOQS) {
      const x = re.exec(rest);
      const n = x ? Number(x[1].replace(/,/g, '')) : NaN;
      if (Number.isFinite(n) && n > 0 && n <= 1e7) { out.moq = n; break; }
    }
    for (const re of REPEATS) {
      const x = re.exec(rest);
      if (x && Number(x[1]) <= 100) { out.repeat_rate = Number(x[1]); break; }
    }
    const star = /(\d(?:[.,]\d{1,2})?)\s*(?:分|\/\s*5\b|stars?\b|★)/i.exec(rest) || /★\s*(\d(?:[.,]\d{1,2})?)/.exec(rest);
    const good = /(\d{2,3}(?:[.,]\d)?)\s*%\s*(?:positive|好评)/i.exec(rest) || /(?:好评率|positive feedback)\s*[:：]?\s*(\d{2,3}(?:[.,]\d)?)\s*%/i.exec(rest);
    const r = star ? Number(star[1].replace(',', '.')) : good ? Number(good[1].replace(',', '.')) / 20 : NaN;
    if (r >= 0 && r <= 5) out.rating = round(r, 2);
    const factory = /源头工厂|生产厂家|工厂|厂家|\bmanufacturer\b|\bfactory\b/i.test(rest);
    const trader = /贸易|经销|批发商|trading company|\btrader\b/i.test(rest);
    if (factory !== trader) out.kind = factory ? 'factory' : 'trader';
    // The name: the words before the facts start.
    let title = rest.replace(/【[^】]*】|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    title = title.slice((LEAD.exec(title) || [''])[0].length);
    const cut = FACT.exec(title);
    title = (cut ? title.slice(0, cut.index) : title).replace(/^[|｜:：\-–—,，\s]+|[|｜:：\-–—,，\s]+$/g, '');
    if (title.length < 3 || BOILER.test(title) || /^[\d\s.,%¥￥€$]+$/.test(title)) title = '';
    if (title) out.title = title.slice(0, MAX.text);
    return out;
  }

  /** One field as it is saved, or undefined (empty or not valid). */
  function cleanField(f, x) {
    if (x == null || x === '' || x === false) return undefined;
    if (f.t === 'choice') return f.options.some((o) => o[0] === x) ? x : undefined;
    if (f.t === 'text') return cleanText(x, f.long ? MAX.notes : f.max || MAX.text, f.long) || undefined;
    if (f.t === 'url') return cleanUrl(x) || undefined;
    let n = numberOf(x);
    if (f.t === 'rating' && typeof x === 'string') {
      const pct = /^\s*(\d{1,3}(?:[.,]\d+)?)\s*%\s*$/.exec(x); // 96% positive feedback is 4.8 out of 5
      const of5 = /^\s*(\d(?:[.,]\d+)?)\s*\/\s*5\s*$/.exec(x);
      if (pct) n = Number(pct[1].replace(',', '.')) / 20;
      else if (of5) n = Number(of5[1].replace(',', '.'));
    }
    if (!Number.isFinite(n) || n < 0) return undefined;
    if (f.t === 'int') return n <= f.max ? Math.round(n) : undefined;
    if (f.t === 'pct') return n <= 100 ? round(n, 1) : undefined;
    if (f.t === 'rating') return n <= 5 ? round(n, 2) : undefined;
    if (f.t === 'rate') return n >= RATES[f.k][0] && n <= RATES[f.k][1] ? round(n, 4) : undefined;
    return n <= 1e6 ? round(n, 2) : undefined; // money
  }

  /**
   * A candidate as it is saved: { field: value or null }. Every field, or with partial only the fields given (a field
   * given empty or not valid is null: cleared). The currency follows the link's platform when it is not given.
   */
  function cleanSupplier(input, { partial = false } = {}) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const out = {};
    for (const f of FIELDS) {
      if (partial && !Object.hasOwn(i, f.k)) continue;
      const v = cleanField(f, i[f.k]);
      out[f.k] = v === undefined ? null : v;
    }
    if (!partial && !out.currency) out.currency = PLATFORMS[out.url ? platformOf(out.url) : 'other'].cur;
    return out;
  }
  /** The product's own facts, as saved: only those given; '' or not valid is null. */
  function cleanInfo(input) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const out = {};
    for (const f of INFO) {
      if (!Object.hasOwn(i, f.k)) continue;
      const v = cleanField(f, i[f.k]);
      out[f.k] = v === undefined ? null : v;
    }
    return out;
  }
  /** Which fields of a form cannot be saved as typed (not a number, not a link): their keys. */
  const badFields = (input, list = FIELDS) => list.filter((f) => {
    const x = input && input[f.k];
    return x != null && String(x).trim() !== '' && cleanField(f, x) === undefined;
  }).map((f) => f.k);

  // Money -------------------------------------------------------------------------------------------------------------
  /** The rates of a product: its own, else the defaults. */
  const fxOf = (s) => ({ CNY: s && Number(s.eur_cny) > 0 ? Number(s.eur_cny) : FX.CNY, USD: s && Number(s.eur_usd) > 0 ? Number(s.eur_usd) : FX.USD });
  /** An amount in euros (null when it is not known). */
  function toEur(v, cur, fx) {
    if (v == null || v === '' || !Number.isFinite(Number(v))) return null;
    if (!cur || cur === 'EUR') return round(Number(v), 2);
    const r = (fx || FX)[cur];
    return r > 0 ? round(Number(v) / r, 2) : null;
  }
  /** The EU import fees on one order of one product from outside the EU, on that day (YYYY-MM-DD): { duty, handling, total }. */
  function euFeesOf(day, value) {
    const d = String(day || '').slice(0, 10);
    const duty = d >= EU_FEES.duty_from && !(Number(value) >= EU_FEES.under) ? EU_FEES.duty : 0;
    const handling = d >= EU_FEES.handling_from ? EU_FEES.handling : 0;
    return { duty, handling, total: duty + handling };
  }
  /**
   * One order of one unit at the customer's door, in euros: the unit, its shipping and the EU import fees when it ships
   * from outside the EU. landed: null until the price is known (shipping not known yet counts as 0, and is flagged).
   */
  function landedOf(s, fx, day) {
    const unit = toEur(s && s.unit_price, s && s.currency, fx);
    const ship = toEur(s && s.ship_price, s && s.currency, fx);
    const fees = s && s.origin === 'eu' ? 0 : euFeesOf(day, unit).total;
    return { unit, ship, fees, landed: unit == null ? null : round(unit + (ship || 0) + fees, 2) };
  }

  /** What to look at before you choose a supplier: [{ k, level: red | amber | green, text }], red first. */
  function flagsOf(s, x) {
    const out = [];
    const add = (k, level, text) => out.push({ k, level, text });
    if (!x || x.unit == null) add('price', 'amber', 'No price yet');
    else if (x.ship == null && s.origin !== 'eu') add('ship', 'amber', 'Shipping to NL not known yet');
    if (s.kind === 'trader') add('trader', 'amber', 'A trader, not the factory');
    if (s.repeat_rate != null && s.repeat_rate < 20) add('repeat', 'amber', `Few repeat buyers: ${s.repeat_rate}%`);
    if (s.rating != null && s.rating < 4.5) add('rating', s.rating < 4 ? 'red' : 'amber', `Rating ${s.rating}`);
    if (s.moq != null && s.moq > 50) add('moq', 'amber', `MOQ ${s.moq}: stock bought up front`);
    if (s.lead_days != null && s.lead_days > 15) add('slow', 'amber', `Slow: ${s.lead_days} days to the customer`);
    if (s.kind === 'factory') add('factory', 'green', 'Factory');
    if (s.repeat_rate != null && s.repeat_rate >= 30) add('repeat', 'green', `${s.repeat_rate}% repeat buyers`);
    if (s.rating != null && s.rating >= 4.7) add('rating', 'green', `Rating ${s.rating}`);
    if (s.origin === 'eu') add('eu', 'green', 'EU stock: no import fees');
    const order = { red: 0, amber: 1, green: 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  /**
   * The candidates as the panel lists them: each with x (its landed cost) and its flags, the cheapest order at the
   * customer's door first; those without a price last, oldest first. best: the cheapest one with a price.
   */
  function ranked(list, fx, day) {
    const out = (Array.isArray(list) ? list : []).map((s) => {
      const x = landedOf(s, fx, day);
      return Object.assign({}, s, { x, flags: flagsOf(s, x), best: false });
    });
    out.sort((a, b) => (a.x.landed == null) - (b.x.landed == null) || (a.x.landed ?? 0) - (b.x.landed ?? 0) || a.id - b.id);
    if (out[0] && out[0].x.landed != null) out[0].best = true;
    return out;
  }

  /**
   * What the chosen supplier puts into the launch card's Sourcing step (launch.mjs): only what it knows, in euros and
   * without the EU import fees (the margin and the landed cost add their own). weight_g only lands where the step has
   * that field.
   */
  function wireOf(s, fx) {
    const v = {};
    const unit = toEur(s.unit_price, s.currency, fx);
    const ship = toEur(s.ship_price, s.currency, fx);
    if (s.url) v.supplier = s.url;
    if (unit != null) v.unit = unit;
    if (ship != null) v.ship = ship;
    if (s.moq != null) v.moq = s.moq;
    if (s.lead_days != null) v.lead = s.lead_days;
    if (s.weight_g != null) v.weight_g = s.weight_g;
    return v;
  }

  // Search ------------------------------------------------------------------------------------------------------------
  /** The words to search for: the title without ™ ® ©, brackets or a "| colour" tail, at most 80 characters. */
  const searchWords = (t) => String(t || '').replace(/[™®©]/g, '').replace(/【[^】]*】|\[[^\]]*\]/g, ' ').split(/\s+[|｜]\s+/)[0].replace(/\s+/g, ' ').trim().slice(0, 80);
  /**
   * Search links for a product (its launch card facts): by name on 1688 (its Chinese words when you set them),
   * AliExpress, Alibaba and CJ; by photo on Google Lens and Yandex (they take a photo's link; 1688, AliExpress and
   * Alibaba only search a photo you upload in their own app, so the photo itself is there to save).
   */
  function searchLinks(f, zh) {
    const q = searchWords(f && f.title);
    const cn = cleanText(zh || '', MAX.zh);
    const e = encodeURIComponent;
    const img = f && typeof f.img === 'string' && /^https:\/\//i.test(f.img) ? f.img : '';
    const out = [];
    if (cn || q) out.push({ k: '1688', by: 'name', label: '1688', url: 'https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=' + e(cn || q) });
    if (q) {
      out.push({ k: 'aliexpress', by: 'name', label: 'AliExpress', url: 'https://www.aliexpress.com/wholesale?SearchText=' + e(q) });
      out.push({ k: 'alibaba', by: 'name', label: 'Alibaba', url: 'https://www.alibaba.com/trade/search?SearchText=' + e(q) });
      out.push({ k: 'cj', by: 'name', label: 'CJ', url: 'https://cjdropshipping.com/?searchValue=' + e(q) + '&selectedTabKey=cj' });
    }
    if (img) {
      out.push({ k: 'lens', by: 'photo', label: 'Google Lens', url: 'https://lens.google.com/uploadbyurl?url=' + e(img) });
      out.push({ k: 'yandex', by: 'photo', label: 'Yandex', url: 'https://yandex.com/images/search?rpt=imageview&url=' + e(img) });
      out.push({ k: 'photo', by: 'photo', label: 'The photo', url: img });
    }
    if (q) out.push({ k: 'translate', by: 'tool', label: 'Translate the name', url: 'https://translate.google.com/?sl=auto&tl=zh-CN&op=translate&text=' + e(q) });
    return out;
  }

  // The first message -------------------------------------------------------------------------------------------------
  /**
   * A first message, ready to copy. to: 'supplier' (about its listing) or 'agent' (find and check this product on 1688).
   * lang: 'en' or 'zh'. o: { title, link (the supplier's listing), photo, page (where it sells now), zh, name, qty, battery }.
   */
  function messageOf(o) {
    const zhLang = o.lang === 'zh';
    const name = cleanText(o.name || '', 60);
    const qty = Number.isInteger(o.qty) && o.qty > 0 && o.qty <= 1e6 ? o.qty : 50;
    const title = cleanText(o.title || '', MAX.text) || null;
    const link = (x) => (typeof x === 'string' && /^https:\/\//i.test(x) ? x : null);
    const zh = cleanText(o.zh || '', MAX.zh);
    // Lines; null drops a line ('' is an empty line between the parts).
    const line = (...xs) => xs.filter((x) => x != null).join('\n');
    const num = (xs) => xs.filter(Boolean).map((x, i) => `${i + 1}. ${x}`).join('\n');
    if (o.to === 'agent') {
      return zhLang
        ? line(`您好！我${name ? `叫${name}，` : ''}在荷兰开网店，面向整个欧盟销售。请帮我在1688上采购这款产品：`, title, link(o.photo) && `图片：${o.photo}`, link(o.page) && `国外售卖链接：${o.page}`, zh ? `中文关键词：${zh}` : null, '', '请帮我：',
          num(['找2–3家供应商（优先源头工厂），发我链接、单价和起订量', '从最好的两家各拿1–2个样品（在1688下单），并做质检：照片、功能视频、尺寸测量', '报0.5公斤和1公斤快递到荷兰、德国、法国的运费，尾程最好是PostNL、Hermes或La Poste',
            '书面确认每条线路如何收取欧盟3欧元关税和2欧元处理费，是否使用我的IOSS号码并按真实售价申报', '告诉我您的服务费，以及能否存20–50个现货并一件代发给我的客户', o.battery ? '产品带电池：线路需要能走带电产品，我需要UN38.3测试摘要和MSDS' : '']),
          '', `首单约${qty}个试卖。谢谢！`)
        : line(`Hello! ${name ? `I'm ${name}. ` : ''}I run an online shop in the Netherlands and sell across the EU. Could you help me source this product on 1688?`, title, link(o.photo) && `Photo: ${o.photo}`, link(o.page) && `Sold here: ${o.page}`, zh ? `Chinese search words: ${zh}` : null, '', 'Please:',
          num(['Find 2–3 suppliers (factories first) and send me their links, unit prices and MOQ', 'Order 1–2 samples from the best two, paid on 1688, and do a QC: photos, a function video, measurements',
            'Quote express shipping for 0.5 kg and 1 kg to the Netherlands, Germany and France, on lines that end with PostNL, Hermes or La Poste',
            'Confirm in writing how each line bills the EU €3 duty and €2 handling fee, that it uses my IOSS number and declares my real sale price',
            'Tell me your fees, and whether you can hold 20–50 units of starter stock and ship single parcels to my customers', o.battery ? 'It has a battery: the line must take batteries, and I need the UN38.3 summary and the safety data sheet' : '']),
          '', `A first test of about ${qty} units. Thank you!`);
    }
    return zhLang
      ? line(`您好！我${name ? `叫${name}，` : ''}在荷兰开网店，面向整个欧盟销售。我对这款产品很感兴趣：`, title, link(o.link) || link(o.photo), '', `我想先拿1–2个样品，然后先试单约${qty}个，卖得好会稳定返单。请问：`,
        num([`1个、${qty}个、100个、500个分别的单价是多少？`, '每个数量的交期是多久？付款后多久发货？', '包装后的重量和尺寸，每箱装多少个，外箱尺寸和重量？', '可以发到我在国内的代理仓库吗？或者可以一件代发到欧盟的客户吗？',
          '有CE / RoHS / REACH检测报告吗？请提供报告编号、检测机构和申请人。', '样品和大货一致吗？下大货时样品费可以抵扣吗？', '定制logo或包装的起订量和费用是多少？', '次品怎么处理？', '您是工厂还是贸易公司？月产能是多少？',
          `可以拍一段未剪辑的产品视频（写上今天的日期${name ? `和我的名字${name}` : ''}），或者简单视频通话一下吗？`, o.battery ? '产品带电池：请提供UN38.3测试摘要、MSDS安全数据表和电池容量（Wh）。' : '']),
        '', '谢谢！')
      : line(`Hello! ${name ? `I'm ${name}. ` : ''}I run an online shop in the Netherlands and sell across the EU. I'm interested in this product:`, title, link(o.link) || link(o.photo), '',
        `I'd like 1–2 samples first, then about ${qty} units for a test, with regular reorders if it sells. Could you tell me:`,
        num([`The price per unit for 1, ${qty}, 100 and 500 units`, 'The lead time for each quantity, and how soon you ship after payment', 'The packed weight and size, units per carton, and the carton size and weight',
          'Can you ship to my agent in China, or single parcels to customers in the EU?', 'The CE / RoHS / REACH test reports: report number, lab and applicant', 'Is the sample the same as bulk production? Is the sample fee credited on a bulk order?',
          'Logo or own packaging: the MOQ and the cost', 'Your policy for defective units', 'Are you the factory or a trading company? What is your monthly capacity?',
          `Could you send an unedited video of the product showing today's date${name ? ` and my name, ${name}` : ''}, or do a short video call?`, o.battery ? 'It has a battery: please send the UN38.3 summary, the safety data sheet (MSDS) and the capacity in Wh' : '']),
        '', 'Thank you!');
  }

  return { PLATFORMS, SIGN, FX, EU_FEES, FIELDS, INFO, VET, SAMPLE, LISTS, cleanUrl, platformOf, fromPaste, cleanSupplier, cleanInfo, badFields, fxOf, toEur, euFeesOf, landedOf, flagsOf, ranked, wireOf, searchLinks, messageOf };
}

export const { PLATFORMS, FX, EU_FEES, FIELDS, INFO, VET, SAMPLE, LISTS, cleanUrl, platformOf, fromPaste, cleanSupplier, cleanInfo, badFields, fxOf, toEur, euFeesOf, landedOf, flagsOf, ranked, wireOf, searchLinks, messageOf } = sourcingKit();
/** GET /sourcing.js: the kit's source, run once in the board as window.SOURCING. */
export const SOURCING_JS = `'use strict';\nwindow.SOURCING = (${sourcingKit})();\n`;

// ---------------------------------------------------------------------------
// D1: the shared row of a product, its candidates
// ---------------------------------------------------------------------------

// The launch card's keys, as launch.mjs takes them (the Google tab's 'google|…' too: its cards have this panel as well).
const keyIn = (k) => (typeof k === 'string' && k.length <= 1000 && /^(eu|world|google|tiktok)\|./s.test(k) ? k : '');
const idIn = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 && String(x).length <= 15 ? Number(x) : 0);
const numOr = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const parse = (s) => {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    return {};
  }
};
const dayOf = (now) => new Date(now).toISOString().slice(0, 10);
const bad = (error, status = 400) => ({ status, body: { error } });
export const MAX_SUPPLIERS = 30;

const SX_COLS = ['supplier_cost', 'supplier_url', 'weight_g', 'ship_cost', 'moq', 'lead_days', 'supplier_id', 'zh', 'eur_cny', 'eur_usd', 'checks', 'updated_at'];
const SUP_COLS = 'id, product_key, platform, url, title, unit_price, currency, moq, rating, kind, repeat_rate, ship_price, weight_g, lead_days, origin, notes, source, data, created_at, updated_at';
// The launch card and its product's sourcing row in one read: no card, no panel.
const CARD_SQL = `SELECT l.product_key AS card, l.facts, l.steps, ${SX_COLS.map((c) => 's.' + c).join(', ')} FROM launches l LEFT JOIN product_sourcing s ON s.product_key = l.product_key WHERE l.product_key = ?`;
const LIST_SQL = `SELECT ${SUP_COLS} FROM product_suppliers WHERE product_key = ? ORDER BY id`;
const ENSURE_SQL = 'INSERT INTO product_sourcing (product_key, updated_at) VALUES (?, ?) ON CONFLICT(product_key) DO NOTHING';
const CLEAR_SQL = 'UPDATE product_sourcing SET supplier_id = NULL, supplier_cost = NULL, supplier_url = NULL, ship_cost = NULL, moq = NULL, lead_days = NULL, updated_at = ? WHERE product_key = ?';
const STEP_SQL = "UPDATE launches SET steps = json_set(CASE WHEN json_valid(steps) THEN steps ELSE '{}' END, '$.sourcing', json(?)), updated_at = ? WHERE product_key = ?";
const LAUNCH_SQL = 'SELECT product_key, title, facts, steps, pinned, decision, created_at, updated_at FROM launches WHERE product_key = ?';

/**
 * The chosen supplier of a product as the rest of the board reads it, by its launch card's key: { supplier_cost (euros,
 * one unit, product only), supplier_url, weight_g, ship_cost (euros, one order to NL), moq, lead_days } or null.
 */
export const CHOSEN_SQL = 'SELECT product_key, supplier_cost, supplier_url, weight_g, ship_cost, moq, lead_days FROM product_sourcing WHERE product_key = ?';
export async function chosenSupplier(env, key) {
  return (await env.DB.prepare(CHOSEN_SQL).bind(key).first()) || null;
}

function supplierOut(r) {
  const d = parse(r.data);
  return {
    id: Number(r.id), platform: Object.hasOwn(PLATFORMS, r.platform || '') ? r.platform : 'other', url: r.url || '', title: r.title || '', unit_price: numOr(r.unit_price),
    currency: r.currency || null, moq: numOr(r.moq), rating: numOr(r.rating), kind: r.kind || null, repeat_rate: numOr(r.repeat_rate), ship_price: numOr(r.ship_price),
    weight_g: numOr(r.weight_g), lead_days: numOr(r.lead_days), origin: r.origin || null, notes: r.notes || '', source: r.source === 'cj' ? 'cj' : 'manual',
    cj: d.cj && typeof d.cj === 'object' ? d.cj : null, created_at: r.created_at || '', updated_at: r.updated_at || '',
  };
}
function sourcingOut(r) {
  const checks = parse(r && r.checks);
  const ticks = (list, saved) => Object.fromEntries(list.map((i) => [i.k, !!(saved && saved[i.k] === true)]));
  return {
    supplier_cost: numOr(r && r.supplier_cost), supplier_url: (r && r.supplier_url) || '', weight_g: numOr(r && r.weight_g), ship_cost: numOr(r && r.ship_cost),
    moq: numOr(r && r.moq), lead_days: numOr(r && r.lead_days), supplier_id: numOr(r && r.supplier_id), zh: (r && r.zh) || '',
    eur_cny: numOr(r && r.eur_cny), eur_usd: numOr(r && r.eur_usd), checks: { vet: ticks(VET, checks.vet), sample: ticks(SAMPLE, checks.sample) }, updated_at: (r && r.updated_at) || '',
  };
}

/** The card (with its sourcing row) and its candidates, or null when there is no launch card under that key. */
async function load(env, key) {
  const [card, list] = await Promise.all([env.DB.prepare(CARD_SQL).bind(key).first(), env.DB.prepare(LIST_SQL).bind(key).all()]);
  return card ? { card, sourcing: sourcingOut(card), suppliers: (list.results || []).map(supplierOut) } : null;
}

/** The panel's data: the product's sourcing row, its candidates ranked, the rates, the EU fees today, and whether CJ is on. */
function view(env, key, st, now, extra = {}) {
  const fx = fxOf(st.sourcing);
  const day = dayOf(now);
  return { ok: true, key, sourcing: st.sourcing, suppliers: ranked(st.suppliers, fx, day), fx, fees: euFeesOf(day, 0), cj: { on: cjOn(env) }, ...extra };
}

/**
 * The statements that put the chosen supplier into the launch: its numbers in product_sourcing (the shared columns) and
 * in the launch card's Sourcing step, where everything else (the sample tick, your note, a field it does not know)
 * stays. The supplier link always follows the chosen supplier. The weight is the product's: one you typed (weighed on
 * the sample) is never replaced by what a supplier says; without one, the supplier's fills it.
 */
function wire(env, key, st, s, at) {
  const fx = fxOf(st.sourcing);
  const w = wireOf(s, fx);
  const weight = st.sourcing.weight_g ?? s.weight_g ?? null;
  if (weight == null) delete w.weight_g;
  else w.weight_g = weight;
  const cur = parse(st.card.steps).sourcing;
  const old = cur && typeof cur === 'object' ? cur : {};
  const v = Object.assign({}, old.v && typeof old.v === 'object' ? old.v : {}, w);
  if (!w.supplier) delete v.supplier;
  const step = cleanStep('sourcing', { done: old.done === true, note: old.note == null ? '' : String(old.note), v });
  return [
    env.DB.prepare(ENSURE_SQL).bind(key, at),
    env.DB.prepare('UPDATE product_sourcing SET supplier_id = ?, supplier_cost = ?, supplier_url = ?, ship_cost = ?, moq = ?, lead_days = ?, weight_g = COALESCE(weight_g, ?), updated_at = ? WHERE product_key = ?')
      .bind(s.id, w.unit ?? null, s.url || null, w.ship ?? null, s.moq ?? null, s.lead_days ?? null, s.weight_g ?? null, at, key),
    env.DB.prepare(STEP_SQL).bind(JSON.stringify(step), at, key),
  ];
}
// Does the launch card's Sourcing step have a weight field (weight_g)? Then a weight typed here goes there as well.
const STEP_HAS_WEIGHT = (STEPS.find((s) => s.k === 'sourcing') || { items: [] }).items.some((f) => f.k === 'weight_g');

/** GET /api/sourcing?key=…: the panel of one launch card. */
export async function sourcingGet(env, params, now) {
  const key = keyIn(params.get('key'));
  if (!key) return bad('Bad key');
  const st = await load(env, key);
  if (!st) return bad('No launch card for this product', 404);
  return { status: 200, body: view(env, key, st, now) };
}

/** POST /api/sourcing: add, change, remove or choose a candidate, tick a checklist, the product's facts, or CJ. Returns { status, body }. */
export async function sourcingPost(env, j, now, deps = {}) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('Bad JSON');
  const key = keyIn(j.key);
  if (!key) return bad('Bad key');
  const st = await load(env, key);
  if (!st) return bad('No launch card for this product', 404);
  const at = new Date(now).toISOString();
  // The panel after the change; with wired, the launch card too (its Sourcing step and its numbers changed).
  const again = async ({ wired = false, ...extra } = {}) => {
    const fresh = await load(env, key);
    if (!fresh) return bad('No launch card for this product', 404); // removed meanwhile
    const out = view(env, key, fresh, now, extra);
    const row = wired ? await env.DB.prepare(LAUNCH_SQL).bind(key).first() : null;
    if (row) out.launch = launchOut(row);
    return { status: 200, body: out };
  };
  const chosen = st.sourcing.supplier_id;

  if (j.add != null) {
    const a = j.add && typeof j.add === 'object' && !Array.isArray(j.add) ? j.add : {};
    const pasted = a.paste != null ? fromPaste(String(a.paste)) : {};
    const typed = cleanSupplier(a, { partial: true });
    const s = cleanSupplier(pasted);
    for (const [k, v] of Object.entries(typed)) if (v != null) s[k] = v; // what you typed wins over what the paste said
    if (!s.url && !s.title && s.unit_price == null) return bad(a.paste ? 'No link, name or price in what you pasted' : 'Paste a supplier link, or give it a name or a price');
    return addSupplier(env, key, st, s, 'manual', null, at, again);
  }

  const id = j.id != null ? idIn(j.id) : 0;
  const s = id ? st.suppliers.find((x) => x.id === id) : null;
  if ((j.set != null || j.remove != null) && !s) return bad('No such supplier for this product', 404);

  if (j.set != null) {
    const ch = cleanSupplier(j.set, { partial: true });
    if (!Object.keys(ch).length) return bad('Nothing to save');
    if (ch.url && st.suppliers.some((x) => x.id !== id && x.url === ch.url)) return bad('That supplier is already in the list', 409);
    if (Object.hasOwn(ch, 'url')) ch.platform = ch.url ? platformOf(ch.url) : 'other';
    if (Object.hasOwn(ch, 'currency') && !ch.currency) ch.currency = PLATFORMS[ch.platform || s.platform].cur;
    const cols = Object.keys(ch); // FIELDS keys and platform only
    const steps = [env.DB.prepare(`UPDATE product_suppliers SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND product_key = ?`).bind(...cols.map((c) => ch[c]), at, id, key)];
    const merged = Object.assign({}, s, ch);
    const rewire = chosen === id && merged.unit_price != null;
    if (rewire) steps.push(...wire(env, key, st, merged, at));
    else if (chosen === id) steps.push(env.DB.prepare(CLEAR_SQL).bind(at, key)); // its price taken out: no longer a cost to go with
    await env.DB.batch(steps);
    return again({ wired: rewire });
  }

  if (j.remove === true) {
    const steps = [env.DB.prepare('DELETE FROM product_suppliers WHERE id = ? AND product_key = ?').bind(id, key)];
    if (chosen === id) steps.push(env.DB.prepare(CLEAR_SQL).bind(at, key)); // the launch card keeps its numbers: they are yours now
    await env.DB.batch(steps);
    return again({ removed: id });
  }

  if (j.choose !== undefined) {
    if (j.choose === null) {
      await env.DB.batch([env.DB.prepare(ENSURE_SQL).bind(key, at), env.DB.prepare(CLEAR_SQL).bind(at, key)]);
      return again();
    }
    const c = st.suppliers.find((x) => x.id === idIn(j.choose));
    if (!c) return bad('No such supplier for this product', 404);
    if (c.unit_price == null) return bad('Add its price first: the launch card works out the margin from it', 409);
    await env.DB.batch(wire(env, key, st, c, at));
    return again({ wired: true });
  }

  if (j.check != null) {
    const c = j.check && typeof j.check === 'object' ? j.check : {};
    const list = Object.hasOwn(LISTS, String(c.list)) ? String(c.list) : '';
    const item = list && LISTS[list].find((i) => i.k === c.k);
    if (!item) return bad('Bad checklist item');
    // One tick in one statement: another tick at the same moment is not lost. The path is made of fixed keys.
    await env.DB.batch([
      env.DB.prepare(ENSURE_SQL).bind(key, at),
      env.DB.prepare("UPDATE product_sourcing SET checks = json_set(CASE WHEN json_valid(checks) THEN checks ELSE '{}' END, ?, json(?)), updated_at = ? WHERE product_key = ?")
        .bind(`$.${list}.${item.k}`, c.on === true ? 'true' : 'false', at, key),
    ]);
    return again();
  }

  if (j.info != null) {
    const ch = cleanInfo(j.info);
    const cols = Object.keys(ch); // INFO keys only
    if (!cols.length) return bad('Nothing to save');
    const steps = [env.DB.prepare(ENSURE_SQL).bind(key, at), env.DB.prepare(`UPDATE product_sourcing SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE product_key = ?`).bind(...cols.map((c) => ch[c]), at, key)];
    // New rates change what the chosen supplier costs in euros: the launch follows.
    const sx = Object.assign({}, st.sourcing, ch);
    const c = chosen ? st.suppliers.find((x) => x.id === chosen) : null;
    let rewire = false;
    if (c && c.unit_price != null && (Object.hasOwn(ch, 'eur_cny') || Object.hasOwn(ch, 'eur_usd') || (Object.hasOwn(ch, 'weight_g') && STEP_HAS_WEIGHT))) {
      steps.push(...wire(env, key, Object.assign({}, st, { sourcing: sx }), c, at));
      rewire = true;
    }
    await env.DB.batch(steps);
    return again({ wired: rewire });
  }

  if (j.cj != null) return cjAction(env, key, st, j.cj, now, at, again, deps);
  return bad('Nothing to save');
}

// What a new CJ quote brings up to date on a CJ candidate that is already there: its numbers. Your name for it, notes,
// rating and judgment stay.
const CJ_FIELDS = ['unit_price', 'currency', 'ship_price', 'weight_g', 'lead_days', 'origin'];

/**
 * A new candidate (from you or from CJ). The same link again is the same supplier: refused, or (from CJ) its numbers
 * brought up to date, and when it is the chosen one, the launch follows.
 */
async function addSupplier(env, key, st, s, source, data, at, again) {
  const same = s.url ? st.suppliers.find((x) => x.url === s.url) : null;
  const cols = FIELDS.map((f) => f.k);
  if (same && source !== 'cj') return bad('That supplier is already in the list', 409);
  if (same) {
    const steps = [env.DB.prepare(`UPDATE product_suppliers SET ${CJ_FIELDS.map((c) => `${c} = ?`).join(', ')}, source = ?, data = ?, updated_at = ? WHERE id = ? AND product_key = ?`)
      .bind(...CJ_FIELDS.map((c) => s[c] ?? null), source, data ? JSON.stringify(data) : null, at, same.id, key)];
    const merged = Object.assign({}, same, Object.fromEntries(CJ_FIELDS.map((c) => [c, s[c] ?? null])));
    const rewire = st.sourcing.supplier_id === same.id && merged.unit_price != null;
    if (rewire) steps.push(...wire(env, key, st, merged, at));
    await env.DB.batch(steps);
    return again({ added: same.id, wired: rewire });
  }
  if (st.suppliers.length >= MAX_SUPPLIERS) return bad(`At most ${MAX_SUPPLIERS} suppliers per product: remove one first`, 409);
  const row = await env.DB.prepare(`INSERT INTO product_suppliers (product_key, platform, ${cols.join(', ')}, source, data, created_at, updated_at)
VALUES (?, ?, ${cols.map(() => '?').join(', ')}, ?, ?, ?, ?) RETURNING id`)
    .bind(key, s.url ? platformOf(s.url) : 'other', ...cols.map((c) => s[c] ?? null), source, data ? JSON.stringify(data) : null, at, at).first();
  return again({ added: row ? Number(row.id) : null });
}

// ---------------------------------------------------------------------------
// CJ Dropshipping (only with the CJ_API_KEY secret): products by photo or name; one product's cost, stock and freight
// ---------------------------------------------------------------------------
// API 2.0 (developers.cjdropshipping.com): POST authentication/getAccessToken {apiKey} gives a token (the same one for a
// day; it lasts weeks), sent as CJ-Access-Token. product/queryProductsByImage (accounts at Level 3 and up),
// product/listV2, product/query (variants, their weight and stock per country), product/stock/getInventoryByPid and
// logistic/freightCalculate (prices in USD). The token is kept in memory and in D1 (state 'cj_token'), sealed with a key
// made from CJ_API_KEY: the hunts can read D1, and a token there is no use to them.

export const CJ_API = 'https://developers.cjdropshipping.com/api2.0/v1';
const CJ_TO = ['NL', 'DE', 'FR'];
const EU_CC = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
export const cjOn = (env) => typeof env.CJ_API_KEY === 'string' && env.CJ_API_KEY.trim().length >= 8;

const TOKENS = new WeakMap(); // per D1 binding (tests); on Cloudflare one Worker has one key: CJ_MEM
let CJ_MEM = null;
const onCloudflare = () => typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers';
const te = new TextEncoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0));
const hex = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const sealKey = async (apiKey) => crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', te.encode('winner-hunter|cj-token|' + apiKey)), 'AES-GCM', false, ['encrypt', 'decrypt']);
/** The token, sealed (AES-GCM) with a key only the Worker can make: JSON { v, iv, ct }. */
export async function seal(apiKey, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(apiKey), te.encode(JSON.stringify(obj))));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}
/** A sealed token opened, or null (another key, or not a sealed token). */
export async function unseal(apiKey, s) {
  try {
    const o = JSON.parse(s);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv) }, await sealKey(apiKey), unb64(o.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    return null;
  }
}

/** An error CJ gave, in words for the panel (never the key or the token). */
const cjError = (msg, status = 502) => Object.assign(new Error(String(msg).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 200)), { cj: true, status });

/**
 * A CJ client for one request. deps.fetch: fetch (tests pass a fake); deps.wait: a pause before a retry (tests: none).
 * get(path, query) and post(path, body) return CJ's data, or throw cjError.
 */
export function cjClient(env, { fetch: doFetch = (...a) => globalThis.fetch(...a), now = Date.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const apiKey = String(env.CJ_API_KEY || '').trim();
  const cache = () => (onCloudflare() ? CJ_MEM : TOKENS.get(env.DB));
  const keep = (t) => (onCloudflare() ? (CJ_MEM = t) : TOKENS.set(env.DB, t));
  const fresh = (t, tag) => t && t.tag === tag && typeof t.token === 'string' && Number(t.exp) - now > 3600e3;
  let tag = '';

  async function token(renew) {
    tag = tag || (await hex('cj|' + apiKey)).slice(0, 16);
    if (!renew && fresh(cache(), tag)) return cache().token;
    if (!renew) {
      const row = await env.DB.prepare('SELECT value FROM state WHERE key = ?').bind('cj_token').first().catch(() => null);
      const saved = row && (await unseal(apiKey, row.value));
      if (saved && fresh(Object.assign(saved, { tag }), tag)) {
        keep(saved);
        return saved.token;
      }
    }
    const res = await doFetch(`${CJ_API}/authentication/getAccessToken`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey }), signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => null);
    if (!j || Number(j.code) !== 200 || !j.data || typeof j.data.accessToken !== 'string') {
      throw cjError(res.status === 429 ? 'CJ: too many logins in a short time; try again in five minutes' : `CJ refused the API key: ${(j && j.message) || 'HTTP ' + res.status}`, res.status === 429 ? 429 : 502);
    }
    const exp = Date.parse(j.data.accessTokenExpiryDate) || now + 15 * 864e5;
    const t = { tag, token: j.data.accessToken, exp };
    keep(t);
    await env.DB.prepare('INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .bind('cj_token', await seal(apiKey, { token: t.token, exp }), new Date(now).toISOString()).run().catch(() => {}); // kept in memory either way
    return t.token;
  }

  /**
   * One call. A 401 gets a new token and one more try (renew: false for a call that an account may simply not be allowed
   * to make, such as the search by photo below Level 3); a 429 (CJ allows about one call a second) waits and tries again,
   * twice at most.
   */
  async function call(method, path, { query, body, renew = true } = {}, busy = 0, renewed = false) {
    const url = `${CJ_API}${path}${query ? '?' + new URLSearchParams(query) : ''}`;
    const headers = Object.assign({ 'CJ-Access-Token': await token(false) }, body ? { 'Content-Type': 'application/json' } : {});
    const res = await doFetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => null);
    const code = j ? Number(j.code) : 0;
    if (res.status === 401 && renew && !renewed) {
      await token(true);
      return call(method, path, { query, body, renew }, busy, true);
    }
    if ((res.status === 429 || code === 1600200) && busy < 2) {
      await wait(1100);
      return call(method, path, { query, body, renew }, busy + 1, renewed);
    }
    if (res.status === 401 || res.status === 403) throw cjError(`CJ: ${(j && j.message) || 'not allowed for this account'}`, res.status);
    if (res.status === 429 || code === 1600200) throw cjError('CJ: too many requests just now; try again in a minute', 429);
    if (!j || code !== 200 || j.result === false) throw cjError(`CJ: ${(j && j.message) || 'HTTP ' + res.status}`);
    return j.data;
  }

  return { get: (path, query, o = {}) => call('GET', path, { query, ...o }), post: (path, body, o = {}) => call('POST', path, { body, ...o }) };
}

const text = (x, n) => (x == null ? '' : String(x).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n));
const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u) && u.length <= 1000 ? u : '');
const round2 = (x) => Math.round(x * 100) / 100;
// '8.13-8.62' → 8.13 (CJ gives a price or a weight as a range when its variants differ).
const lowOf = (x, max) => {
  const m = /\d+(?:\.\d+)?/.exec(String(x ?? ''));
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? round2(n) : null;
};
const pidIn = (x) => (typeof x === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(x) ? x : '');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'product';
/** A CJ product's page on cjdropshipping.com. */
export const cjUrl = (pid, name) => `https://cjdropshipping.com/product/${slug(name)}-p-${pid}.html`;

/** A product from CJ's search (by photo or by name), as the panel lists it. */
export function cjItem(p) {
  const pid = pidIn(String((p && (p.id || p.pid)) || ''));
  if (!pid) return null;
  const name = text(p.nameEn || p.productNameEn, 200);
  const now = lowOf(p.nowPrice, 1e5);
  return { pid, name, sku: text(p.sku || p.productSku, 64), img: https(p.bigImage || p.productImage), price: now > 0 ? now : lowOf(p.sellPrice, 1e5),
    weight_g: lowOf(p.weight ?? p.productWeight ?? p.packWeight, 1e6), stock: numOr(p.warehouseInventoryNum ?? p.inventory), listed: numOr(p.listedNum), url: cjUrl(pid, name) };
}

/** CJ's products like this one: by its photo (Level 3 accounts), else by name. { by, results, note }. */
export async function cjFind(cj, { img, q }) {
  let note = '';
  if (img) {
    try {
      const d = await cj.post('/product/queryProductsByImage', { imageUrl: img }, { renew: false });
      const results = (Array.isArray(d) ? d : []).map(cjItem).filter(Boolean).slice(0, 8);
      if (results.length) return { by: 'photo', results, note };
      note = 'CJ found nothing by the photo: by name instead.';
    } catch (e) {
      if (!e.cj || e.status === 429) throw e;
      note = e.status === 401 || e.status === 403 ? 'CJ searches by photo for Level 3 accounts only: by name instead.' : `${e.message}: by name instead.`;
    }
  }
  if (!q) return { by: 'name', results: [], note: note || 'No name to search for.' };
  const d = await cj.get('/product/listV2', { keyWord: q, page: '1', size: '10' });
  const lists = d && Array.isArray(d.content) ? d.content.flatMap((c) => (c && Array.isArray(c.productList) ? c.productList : [])) : d && Array.isArray(d.list) ? d.list : [];
  return { by: 'name', results: lists.map(cjItem).filter(Boolean).slice(0, 8), note };
}

/**
 * One CJ product: its cheapest variant's price and packed weight, the stock per country (the EU's apart), and the
 * cheapest freight to NL, DE and FR from China and from its EU warehouse with the most stock (prices in USD).
 */
export async function cjQuote(cj, pid, now) {
  const d = await cj.get('/product/query', { pid });
  if (!d || typeof d !== 'object') throw cjError('CJ gave no product for this id', 404);
  const vs = (Array.isArray(d.variants) ? d.variants : []).filter((v) => v && pidIn(String(v.vid || '')));
  const price = (v) => lowOf(v.variantSellPrice, 1e5);
  const v = vs.slice().sort((a, b) => (price(a) ?? 1e9) - (price(b) ?? 1e9))[0];
  if (!v) throw cjError('CJ gave no variant to price for this product', 404);
  const by = {};
  const add = (cc, n) => {
    const c = String(cc || '').toUpperCase();
    if (/^[A-Z]{2}$/.test(c) && Number(n) > 0) by[c] = (by[c] || 0) + Math.round(Number(n));
  };
  if (Array.isArray(v.inventories) && v.inventories.length) for (const i of v.inventories) add(i.countryCode, i.totalInventory ?? i.totalInventoryNum);
  else {
    const s = await cj.get('/product/stock/getInventoryByPid', { pid }).catch(() => null);
    for (const i of (s && Array.isArray(s.inventories) ? s.inventories : [])) add(i.countryCode, i.totalInventoryNum ?? i.totalInventory);
  }
  const eu = Object.entries(by).filter(([cc]) => EU_CC.has(cc)).sort((a, b) => b[1] - a[1]);
  const froms = ['CN'].concat(eu.length ? [eu[0][0]] : []);
  const freight = [];
  for (const from of froms) {
    for (const to of CJ_TO) {
      const opts = await cj.post('/logistic/freightCalculate', { startCountryCode: from, endCountryCode: to, products: [{ quantity: 1, vid: String(v.vid) }] }).catch((e) => {
        if (e.status === 429) throw e;
        return [];
      });
      const best = (Array.isArray(opts) ? opts : []).map((o) => ({ name: text(o.logisticName, 60), usd: lowOf(o.logisticPrice, 1e4), days: text(o.logisticAging, 20) }))
        .filter((o) => o.usd != null).sort((a, b) => a.usd - b.usd)[0];
      if (best) freight.push(Object.assign({ from, to }, best));
    }
  }
  const prices = vs.map(price).filter((x) => x != null);
  const name = text(d.productNameEn || v.variantNameEn, 200);
  return {
    pid: pidIn(String(d.pid || pid)) || pid, vid: String(v.vid), name, sku: text(v.variantSku || d.productSku, 64), variant: text(v.variantKey || v.variantNameEn, 80), img: https(d.bigImage || v.variantImage),
    price: price(v), variants: vs.length, range: prices.length ? [Math.min(...prices), Math.max(...prices)] : null, weight_g: lowOf(v.variantWeight ?? d.productWeight, 1e6),
    stock: { total: Object.values(by).reduce((a, n) => a + n, 0), eu: eu.reduce((a, [, n]) => a + n, 0), by }, freight, url: cjUrl(pidIn(String(d.pid || pid)) || pid, name), at: new Date(now).toISOString(),
  };
}

/** A CJ quote as a candidate: the route to NL that lands cheapest (EU stock pays no import fees). */
export function cjSupplier(q, fx, day) {
  const routes = q.freight.filter((f) => f.to === 'NL').map((f) => {
    const s = { unit_price: q.price, currency: 'USD', ship_price: f.usd, origin: EU_CC.has(f.from) ? 'eu' : 'cn' };
    return { f, s, landed: landedOf(s, fx, day).landed ?? Infinity };
  }).sort((a, b) => a.landed - b.landed);
  const r = routes[0];
  const days = r ? Math.max(...(r.f.days.match(/\d+/g) || []).map(Number).filter((n) => n <= 365), 0) : 0;
  const fmt = (n) => n.toLocaleString('en-US');
  const notes = [`CJ ${q.sku || q.pid}${q.variants > 1 ? ` (cheapest of ${q.variants} variants${q.variant ? ': ' + q.variant : ''})` : ''}`,
    `${fmt(q.stock.total)} in stock${q.stock.eu ? `, ${fmt(q.stock.eu)} in the EU (${Object.keys(q.stock.by).filter((cc) => EU_CC.has(cc)).join(', ')})` : ', none in the EU'}`,
    r ? `To NL from ${r.f.from} by ${r.f.name || 'CJ'}${r.f.days ? `, ${r.f.days} days` : ''}` : 'No freight to NL from CJ'].join('. ') + '.';
  return cleanSupplier({ url: q.url, title: q.name, unit_price: q.price, currency: 'USD', ship_price: r ? r.f.usd : null, weight_g: q.weight_g, lead_days: days || null, origin: r ? r.s.origin : 'cn', moq: 1, notes });
}

/** POST {key, cj: …}: CJ's products like this one, or one product's numbers (and with add: as a candidate). */
async function cjAction(env, key, st, c, now, at, again, deps) {
  if (!cjOn(env)) return bad('CJ is off: add the CJ_API_KEY secret to the Worker (README, Sourcing)', 409);
  const o = c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  const cj = cjClient(env, { fetch: deps.fetch, now, wait: deps.wait });
  try {
    if (o.find === 'photo' || o.find === 'name') {
      const f = parse(st.card.facts);
      const q = text(o.q, 100) || String(f.title || '').replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const found = await cjFind(cj, { img: o.find === 'photo' ? https(f.img) : '', q });
      return { status: 200, body: view(env, key, st, now, { cj: { on: true, find: found } }) };
    }
    const pid = pidIn(String(o.pid || ''));
    if (!pid) return bad('Bad CJ product');
    const q = await cjQuote(cj, pid, now);
    if (o.add !== true) return { status: 200, body: view(env, key, st, now, { cj: { on: true, quote: q } }) };
    const out = await addSupplier(env, key, st, cjSupplier(q, fxOf(st.sourcing), dayOf(now)), 'cj', { cj: q }, at, again);
    if (out.status === 200) out.body.cj = { on: true, quote: q };
    return out;
  } catch (e) {
    if (!e.cj) throw e;
    return bad(e.message, e.status === 429 ? 429 : 502);
  }
}
