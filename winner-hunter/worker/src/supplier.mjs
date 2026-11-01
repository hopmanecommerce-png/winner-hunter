/*
 * The Supplier view: which supplier to choose for a product, with the evidence. One scorecard per product (D1 table
 * sourcing, migrations/0060_sourcing.sql): its setup (target market, the most days a customer may wait, the weights,
 * your price, the sample tests, the questions for suppliers, the certificates it needs), the process checklist, up to
 * 5 suppliers side by side, and your decision (the pick, a backup, why, and when to check it again).
 *   GET  /api/supplier                                 { products }: every scorecard in short, the last touched first
 *   GET  /api/supplier?key=…                           { product }: one scorecard, whole, with its summary
 *   POST /api/supplier {start: launch key}             a scorecard for the product of a launch card (its facts come along)
 *   POST /api/supplier {add: {title, link}}            a scorecard for a product by name: key 'own|<slug of the title>'
 *   POST /api/supplier {key, setup}                    the setup, saved as a whole
 *   POST /api/supplier {key, checks}                   the checklist's ticks
 *   POST /api/supplier {key, slot, supplier}           one supplier (slot 1 to 5), saved as a whole
 *   POST /api/supplier {key, slot, drop: true}         that supplier out (not your choice or its backup)
 *   POST /api/supplier {key, choose: {slot, backup, note}}  your decision: the supplier as it is now, kept as a record
 *   POST /api/supplier {key, choose: null}             the decision taken back (it stays in the history)
 *   POST /api/supplier {key, recheck: {note}}          a re-check done today: the next one is due in 90 days
 *   POST /api/supplier {key, remove: true}             the scorecard deleted
 *   GET  /supplier.js                                  the kit as a script (window.SUPPLIER): the board scores as you type
 * app.mjs checks the PIN cookie, the origin and the JSON before any of this runs. All SQL is parameterized.
 * The method behind it, for every product: docs/sourcing/supplier-selection.md.
 */
import { launchKit } from './launch.mjs';

/**
 * Everything a scorecard works out, in one function that uses nothing from outside itself but the launch kit it is
 * given (its margin): the Worker calls it, and /supplier.js sends its source to the board with the launch kit's, so the
 * browser runs the same tested code while you type.
 */
export function supplierKit(L) {
  const MAX_SUPPLIERS = 5;
  const RECHECK_DAYS = 90; // and before every reorder
  // Duties and fees on one order shipped to an EU customer from outside the EU, when the supplier's price is not DDP:
  // the EU's €3 customs duty on a parcel under €150 (from 1 July 2026; per item category in the parcel, one here) and
  // the €2 handling fee on such parcels (from 1 November 2026). docs/sourcing/supplier-selection.md has the sources.
  const EU_PARCEL = 5;

  // The 7 criteria, weighted for quality and delivery first (the weights are yours to change per product).
  // levels: what each score from 0 to 5 means. auto: how the board scores it when you leave it on Auto.
  const CRITERIA = [
    { k: 'quality', label: 'Product quality evidence', short: 'Quality', w: 25, auto: 'from the sample tests, once you test a sample',
      levels: ['Failed a test, or fake parts', 'Weak: stock photos, claims that do not add up', 'Listing only: photos and sales', 'No sample yet: real photos, the inside, repeat buyers', 'Sample passed the must-pass tests', 'Sample passed every test'] },
    { k: 'delivery', label: 'Delivery time to the customer', short: 'Delivery', w: 25, auto: 'from the days to your market and your limit',
      levels: ['Over your limit', 'Within your limit', '8 to 10 days', '6 or 7 days', '4 or 5 days', '3 days or less'] },
    { k: 'reliability', label: 'Reliability and communication', short: 'Reliability', w: 15,
      levels: ['No answer', 'Evasive, or contradicts itself', 'Slow or vague', 'Answers within 2 days, some vague', 'Answers within a day, clear', 'Within a day, clear, 3+ years, verified'] },
    { k: 'cost', label: 'Landed cost and margin', short: 'Cost', w: 15, auto: 'from your price and its landed cost (without a price: against the cheapest)',
      levels: ['Loses money on every order', 'Break-even ROAS above 3, or far dearer', 'Break-even ROAS up to 3', 'Break-even ROAS up to 2.5', 'Break-even ROAS up to 2', 'Break-even ROAS 1.6 or lower, or the cheapest'] },
    { k: 'compliance', label: 'Compliance and certificates', short: 'Compliance', w: 10,
      levels: ['Refuses, or fake reports', 'No reports, vague', 'Can get reports (time, cost)', 'Reports, not for your market or not theirs', 'Reports for your market, not checked yet', 'Reports for your market, checked at the lab'] },
    { k: 'returns', label: 'Returns and defect handling', short: 'Returns', w: 5,
      levels: ['No way to get anything back', 'Replacement at your cost', 'Case by case', 'Platform protection only', 'In writing, with limits', 'In writing: free replacement or refund'] },
    { k: 'scale', label: 'Scalability, MOQ and branding', short: 'Scale', w: 5,
      levels: ['Cannot supply after the first batch', 'Cannot grow with you', 'High MOQ or small capacity', 'No branding yet, capacity fine', 'Logo or box at a fair MOQ', 'Low MOQ, logo and box, 10,000+ a month'] },
  ];
  // The hard gates: one fail and the supplier is out, whatever its score. Open: not known yet (confirm before paying).
  const GATES = [
    { k: 'samples', label: 'Samples', q: 'Can you order 1 to 3 samples before you buy stock?' },
    { k: 'certs', label: 'Certificates', q: 'Has it the certificates and test reports this product needs (see the setup)?' },
    { k: 'delivery', label: 'Delivery days', auto: true },
    { k: 'identity', label: 'Identity', q: 'Is it who it says it is (business licence, verified company, a real factory)?' },
    { k: 'defects', label: 'Defects', q: 'Can you get a replacement or a refund for a defect (in writing, or the platform’s protection)?' },
    { k: 'sample', label: 'Sample tests', auto: true },
  ];
  // The process for every product, in order. The decision and its re-check are the scorecard's own record.
  const CHECKS = [
    { k: 'shortlist', label: 'Shortlist 5 to 8 listings: image search sorted by sales; factories with 2+ years and repeat buyers' },
    { k: 'message', label: 'First message sent to the top 5, with the questions below' },
    { k: 'bar', label: 'A competitor’s unit bought: the quality bar for the samples' },
    { k: 'samples', label: 'Samples ordered from the top 3 (2 or 3 units each)' },
    { k: 'tested', label: 'Every sample tested with the tests below, results per supplier' },
    { k: 'timed', label: 'Delivery timed: the samples or test parcels, order to doorstep' },
    { k: 'reports', label: 'Test reports checked at the lab: report number, lab, applicant is this supplier' },
  ];
  const MARKETS = [['eu', 'NL/DE (EU)'], ['us', 'US'], ['both', 'EU and US']];
  const ROUTES = [['1688', '1688 factory via an agent'], ['platform', 'CJ or another dropship platform'], ['alibaba', 'Alibaba.com manufacturer'], ['local', 'EU/US wholesaler or 3PL stock'], ['app', 'Zendrop, Spocket or AutoDS'], ['other', 'Other']];
  const FROM = [['cn', 'China'], ['eu', 'An EU warehouse'], ['us', 'A US warehouse'], ['other', 'Elsewhere']];
  const CURRENCIES = [['EUR', '€'], ['USD', '$'], ['GBP', '£']];
  // A supplier's facts. t: text, long (lines), url (https only), money, int, pct, tick (a checkbox), choice.
  const FIELDS = [
    { k: 'name', t: 'text', label: 'Name, as on its shop' },
    { k: 'link', t: 'url', label: 'Link: its listing or shop' },
    { k: 'route', t: 'choice', label: 'Route', options: ROUTES },
    { k: 'from', t: 'choice', label: 'Ships from', options: FROM },
    { k: 'place', t: 'text', label: 'Where (city, province)' },
    { k: 'unit', t: 'money', label: 'Unit cost, fees included' },
    { k: 'ship_eu', t: 'money', label: 'Shipping per order to NL/DE' },
    { k: 'ship_us', t: 'money', label: 'Shipping per order to the US' },
    { k: 'ddp', t: 'tick', label: 'Shipping price includes duties and fees (DDP)' },
    { k: 'days_eu', t: 'int', label: 'Days to a customer in NL/DE', max: 365 },
    { k: 'days_us', t: 'int', label: 'Days to a customer in the US', max: 365 },
    { k: 'measured', t: 'tick', label: 'Days measured with a sample or test parcels' },
    { k: 'lead', t: 'int', label: 'Lead time for stock (days)', max: 365 },
    { k: 'moq', t: 'int', label: 'MOQ (units)' },
    { k: 'years', t: 'int', label: 'Years on the platform', max: 100 },
    { k: 'repeat', t: 'pct', label: 'Repeat buyers %' },
    { k: 'reply', t: 'int', label: 'Hours to answer your first message', max: 10000 },
    { k: 'brand', t: 'tick', label: 'Your logo and box possible' },
    { k: 'note', t: 'long', label: 'Notes' },
  ];
  // The product's setup. def: what an empty field means.
  const SETUP = [
    { k: 'market', t: 'choice', label: 'Customers in', options: MARKETS, def: 'eu' },
    { k: 'max_days', t: 'int', label: 'Most days a customer waits (a gate)', def: 12, min: 1, max: 90 },
    { k: 'price', t: 'money', label: 'Your price per order, VAT included' },
    { k: 'units', t: 'int', label: 'Units in one order (2 for buy 1 get 1)', def: 1, min: 1, max: 20 },
    { k: 'vat', t: 'pct', label: 'VAT %', def: 21 },
    { k: 'fees', t: 'pct', label: 'Payment fees %', def: 3 },
    { k: 'duty_eu', t: 'money', label: 'EU duties and fees per order from outside the EU', def: EU_PARCEL },
    { k: 'cur', t: 'choice', label: 'Currency', options: CURRENCIES, def: 'EUR' },
    { k: 'zh', t: 'text', label: 'Search words for 1688 (Chinese)' },
    { k: 'certs', t: 'long', label: 'Certificates and tests this product needs' },
  ];
  // For a new product. A product's own tests and questions replace these (the showerhead's come with migration 0060).
  const TESTS = [
    { label: 'Works as described: every function, 10 times', must: true },
    { label: 'Build: dropped from 1 m three times, no crack or rattle', must: false },
    { label: 'Matches the listing: size, colour, material, weight', must: false },
    { label: 'Packaging and labels: undamaged, no other brand on it', must: false },
    { label: 'Delivery timed: order to doorstep days match the quote', must: false },
  ];
  const QUESTIONS = [
    { en: 'Are you the factory or a trading company? Please send your business licence and a short video of the production line today.', zh: '您是工厂还是贸易公司？请发营业执照和今天生产线的短视频。' },
    { en: 'Price per unit at 50, 200 and 1,000 units?', zh: '50、200、1000件的单价分别是多少？' },
    { en: 'Lead time from payment to dispatch for a sample, 200 units and 1,000 units?', zh: '从付款到发货：样品、200件、1000件分别需要多久？' },
    { en: 'Packed weight and size of one unit, units per carton, carton size and weight?', zh: '单件包装重量和尺寸、每箱数量、外箱尺寸和重量？' },
    { en: 'Can you ship single orders to customers in the Netherlands and Germany (and the US)? Which line, how many days door to door, and are the duties and fees included (DDP/IOSS)?', zh: '能否一件代发到荷兰和德国（以及美国）的客户？用什么物流线路、门到门几天、是否包税（DDP/IOSS）？' },
    { en: 'Test reports for the EU (CE, RoHS or REACH, as the product needs): report number, lab, and the applicant’s name?', zh: '欧盟检测报告（按产品需要：CE、RoHS或REACH）：报告编号、实验室和申请人名称？' },
    { en: 'What is your defect rate, and do you replace or refund a defective unit for free? In writing, please.', zh: '不良率是多少？不良品是否免费补发或退款？请书面确认。' },
    { en: 'Your logo and packaging: MOQ and cost?', zh: '印我的logo和定制包装：起订量和费用？' },
    { en: 'Is the sample the same as bulk production, and is the sample fee refunded on a bulk order?', zh: '样品和大货是否一致？下大货后样品费可以退吗？' },
    { en: 'Monthly capacity, and can you keep stock for me?', zh: '月产能是多少？可以为我备货吗？' },
  ];
  const MAX = { text: 200, long: 1000, url: 500, title: 120, q: 300, test: 120, tests: 15, questions: 15, past: 10, rechecks: 20, note: 1000 };

  const round = (x, d) => {
    const f = 10 ** d;
    const r = Math.round(x * f) / f;
    return r === 0 ? 0 : r; // never -0
  };
  // "8,50", "€ 8.50" and 8.5 are 8.5. A comma is a decimal comma (a Dutch keyboard) unless there is a dot as well.
  const numberOf = (x) => {
    if (typeof x === 'number') return x;
    if (typeof x !== 'string') return NaN;
    let s = x.replace(/[\s€$£¥%]/g, '');
    if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
    return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
  };
  const cleanText = (x, n, lines) => String(x).replace(lines ? /[\u0000-\u0009\u000b-\u001f\u007f]+/g : /[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const stepOf = (list, k) => list.find((x) => x.k === k);
  const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');

  /** An https link as it is saved, or undefined. A link without https:// gets it. */
  function urlOf(x) {
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

  /** One field as it is saved, or undefined (empty or not valid: not saved). */
  function cleanField(f, x) {
    if (x == null || x === '' || x === false) return undefined;
    if (f.t === 'tick') return x === true ? true : undefined;
    if (f.t === 'choice') return f.options.some((o) => o[0] === x) ? x : undefined;
    if (f.t === 'text') return cleanText(x, MAX.text) || undefined;
    if (f.t === 'long') return cleanText(x, MAX.long, true) || undefined;
    if (f.t === 'url') return urlOf(x);
    const n = numberOf(x);
    if (!Number.isFinite(n) || n < 0) return undefined;
    if (f.t === 'int') {
      const i = Math.round(n);
      return i >= (f.min ?? 0) && i <= (f.max ?? 1e6) ? i : undefined;
    }
    if (f.t === 'pct') return n <= 100 ? round(n, 2) : undefined;
    return n <= 1e6 ? round(n, 2) : undefined; // money
  }

  /** The sample tests as saved: [{ k, label, must }], at most 15. k: from the label, so a result follows its test. */
  function cleanTests(list) {
    const out = [];
    const seen = new Set();
    for (const t of Array.isArray(list) ? list : []) {
      if (out.length >= MAX.tests) break;
      const label = cleanText(typeof t === 'string' ? t : obj(t).label ?? '', MAX.test);
      if (!label) continue;
      let k = slug(label) || 't' + (out.length + 1);
      for (let n = 2; seen.has(k); n++) k = `${slug(label) || 't'}-${n}`;
      seen.add(k);
      out.push({ k, label, must: typeof t === 'object' && t !== null && t.must === true });
    }
    return out;
  }
  /** The questions as saved: [{ en, zh }], at most 15; the English is needed, the Chinese is optional. */
  function cleanQuestions(list) {
    const out = [];
    for (const q of Array.isArray(list) ? list : []) {
      if (out.length >= MAX.questions) break;
      const en = cleanText(typeof q === 'string' ? q : obj(q).en ?? '', MAX.q);
      if (!en) continue;
      const zh = typeof q === 'object' && q !== null && q.zh != null ? cleanText(q.zh, MAX.q) : '';
      out.push(zh ? { en, zh } : { en });
    }
    return out;
  }
  /** One test per line; a line that starts with ! is a must-pass test (one fail and the supplier is out). */
  const parseTests = (text) => cleanTests(String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => ({ label: l.replace(/^!\s*/, ''), must: l.startsWith('!') })));
  const testsText = (tests) => tests.map((t) => (t.must ? '! ' : '') + t.label).join('\n');
  /** One question per line: the English, then " | " and the Chinese. */
  const parseQuestions = (text) => cleanQuestions(String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(.*?)\s*\|\s*(.*)$/.exec(l);
    return m ? { en: m[1], zh: m[2] } : { en: l };
  }));
  const questionsText = (qs) => qs.map((q) => (q.zh ? `${q.en} | ${q.zh}` : q.en)).join('\n');

  /** The setup as saved: only valid values you set. The defaults fill in what is empty (setupOf). */
  function cleanSetup(raw) {
    const i = obj(raw);
    const out = {};
    for (const f of SETUP) {
      const x = cleanField(f, i[f.k]);
      if (x !== undefined) out[f.k] = x;
    }
    if (i.certs_needed === false) out.certs_needed = false; // needed unless you say it is not
    const w = {};
    for (const c of CRITERIA) {
      const n = numberOf(obj(i.weights)[c.k]);
      if (Number.isFinite(n) && n >= 0 && n <= 100) w[c.k] = round(n, 1);
    }
    if (Object.keys(w).length) out.weights = w;
    if (Array.isArray(i.tests)) out.tests = cleanTests(i.tests);
    if (Array.isArray(i.questions)) out.questions = cleanQuestions(i.questions);
    return out;
  }

  /** The weights in use: yours where set, else the defaults; all of them 0 is no weighting: the defaults. */
  function weightsOf(raw) {
    const w = {};
    let sum = 0;
    for (const c of CRITERIA) {
      const x = obj(raw)[c.k];
      w[c.k] = typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100 ? x : c.w;
      sum += w[c.k];
    }
    if (!(sum > 0)) for (const c of CRITERIA) w[c.k] = c.w;
    return w;
  }

  /** The setup in use: what you saved, the defaults for the rest. */
  function setupOf(raw) {
    const s = cleanSetup(raw);
    const out = {};
    for (const f of SETUP) out[f.k] = s[f.k] ?? f.def ?? null;
    out.certs = s.certs || '';
    out.certs_needed = s.certs_needed !== false;
    out.weights = weightsOf(s.weights);
    out.tests = s.tests || cleanTests(TESTS);
    out.questions = s.questions || cleanQuestions(QUESTIONS);
    return out;
  }

  /** A supplier as saved: its facts, the gates you answered (yes / no), your scores (0 to 5) and its sample results. */
  function cleanSupplier(raw, setup) {
    const i = obj(raw);
    const out = {};
    for (const f of FIELDS) {
      const x = cleanField(f, i[f.k]);
      if (x !== undefined) out[f.k] = x;
    }
    const gates = {};
    for (const g of GATES) {
      const x = obj(i.gates)[g.k];
      if (!g.auto && (x === 'yes' || x === 'no')) gates[g.k] = x;
    }
    const scores = {};
    for (const c of CRITERIA) {
      const x = obj(i.scores)[c.k];
      const n = typeof x === 'string' && /^[0-5]$/.test(x) ? Number(x) : x;
      if (Number.isInteger(n) && n >= 0 && n <= 5) scores[c.k] = n;
    }
    const tests = {};
    const known = new Set(setupOf(setup).tests.map((t) => t.k));
    for (const [k, x] of Object.entries(obj(i.tests))) if (known.has(k) && (x === 'pass' || x === 'fail')) tests[k] = x;
    return Object.assign(out, { gates, scores, tests });
  }

  /** The checklist's ticks: { shortlist: true, … }. */
  function cleanChecks(raw) {
    const out = {};
    for (const c of CHECKS) if (obj(raw)[c.k] === true) out[c.k] = true;
    return out;
  }

  // ---- Scoring -------------------------------------------------------------------------------------------------

  /** The days that count for the market: 'both' waits for both and counts the slower one. null: not known. */
  function daysFor(s, market) {
    if (market === 'us') return s.days_us ?? null;
    if (market === 'both') return s.days_eu == null || s.days_us == null ? null : Math.max(s.days_eu, s.days_us);
    return s.days_eu ?? null;
  }
  /** Delivery from the days: 3 days or less 5, 4-5 4, 6-7 3, 8-10 2, within your limit 1, over it 0. */
  const deliveryScore = (days, max) => (days == null ? null : days > max ? 0 : days <= 3 ? 5 : days <= 5 ? 4 : days <= 7 ? 3 : days <= 10 ? 2 : 1);
  /** Cost from the break-even ROAS of an order at your price: 1.6 or lower 5, up to 2 4, 2.5 3, 3 2, above 1; a loss 0. */
  const roasScore = (be) => (be == null ? 0 : be <= 1.6 ? 5 : be <= 2 ? 4 : be <= 2.5 ? 3 : be <= 3 ? 2 : 1);

  /**
   * What one order costs landed in market m ('eu' or 'us'): the units × the unit cost + the shipping, + the EU's duties
   * and fees when it comes to an EU customer from outside the EU and the price is not DDP. null: a number is missing.
   */
  function landedOf(s, set, m) {
    const ship = m === 'us' ? s.ship_us : s.ship_eu;
    if (s.unit == null || ship == null) return null;
    const duty = m === 'eu' && !s.ddp && s.from !== 'eu' ? set.duty_eu || 0 : 0; // from China, elsewhere or not filled in
    return { cogs: round(set.units * s.unit, 2), ship: round(ship + duty, 2), duty: round(duty, 2), total: round(set.units * s.unit + ship + duty, 2) };
  }
  const marketsOf = (set) => (set.market === 'both' ? ['eu', 'us'] : [set.market]);

  /**
   * The cost of every supplier: { landed (the dearest of your markets), be_roas, score, basis }. With your price: the
   * break-even ROAS of an order (VAT and payment fees as in the setup); without it: against the cheapest supplier that
   * fails no gate (a supplier that is out sets no bar), or the cheapest of all when every one fails.
   */
  function costsOf(list, set, out) {
    const cost = new Map();
    for (const { slot, s } of list) {
      const per = marketsOf(set).map((m) => landedOf(s, set, m));
      if (per.some((x) => x == null)) {
        cost.set(slot, { landed: null, be_roas: null, score: null, basis: '' });
        continue;
      }
      const worst = per.reduce((a, b) => (b.total > a.total ? b : a));
      let be = null;
      let score = null;
      if (set.price > 0) {
        const ms = per.map((x) => L.marginOf({ price: set.price, cogs: x.cogs, ship: x.ship, fees: set.fees, vat: set.vat }));
        const loss = ms.some((x) => !x || x.be_roas == null);
        be = loss ? null : Math.max(...ms.map((x) => x.be_roas));
        score = roasScore(be);
      }
      cost.set(slot, { landed: worst.total, duty: worst.duty, be_roas: be, score, basis: set.price > 0 ? 'margin' : '' });
    }
    if (!(set.price > 0)) {
      const known = [...cost.entries()].filter(([, c]) => c.landed != null);
      const bar = known.filter(([slot]) => !out.has(slot));
      const min = Math.min(...(bar.length ? bar : known).map(([, c]) => c.landed));
      for (const [, c] of known) {
        c.score = c.landed > 0 ? Math.min(5, Math.max(1, Math.round((5 * min) / c.landed))) : 5;
        c.basis = 'cheapest';
      }
    }
    return cost;
  }

  /** Its sample results: tests done and passed, the must-pass tests failed or not done yet, and the score they give. */
  function sampleOf(s, tests) {
    const r = obj(s.tests);
    const done = tests.filter((t) => r[t.k] === 'pass' || r[t.k] === 'fail');
    const passed = done.filter((t) => r[t.k] === 'pass').length;
    const must = tests.filter((t) => t.must);
    const failedMust = must.filter((t) => r[t.k] === 'fail').map((t) => t.label);
    const openMust = must.filter((t) => r[t.k] !== 'pass' && r[t.k] !== 'fail').map((t) => t.label);
    // Every test passed 5; a test not done counts as not passed, so a half-tested sample is not a 5. A must-pass fail 0.
    const score = !done.length || !tests.length ? null : failedMust.length ? 0 : Math.round(1 + (4 * passed) / tests.length);
    return { done: done.length, passed, of: tests.length, must: must.length, failedMust, openMust, score };
  }

  /** The gates of one supplier: [{ k, label, state: 'pass' | 'fail' | 'open', why }]. */
  function gatesOf(s, set, sample, days) {
    const g = obj(s.gates);
    const yn = (x) => (x === 'yes' ? 'pass' : x === 'no' ? 'fail' : 'open');
    const where = { eu: 'NL/DE', us: 'the US', both: 'the slower of NL/DE and the US' }[set.market];
    const out = [];
    for (const x of GATES) {
      let state;
      let why = '';
      if (x.k === 'certs' && !set.certs_needed) {
        state = 'pass';
        why = 'Not needed for this product (setup)';
      } else if (x.k === 'delivery') {
        state = days == null ? 'open' : days <= set.max_days ? 'pass' : 'fail';
        why = days == null ? `Days to ${where} not filled in` : `${days} days to ${where}: ${state === 'pass' ? 'within' : 'over'} your ${set.max_days}`;
      } else if (x.k === 'sample') {
        state = !sample.must ? 'pass' : sample.failedMust.length ? 'fail' : sample.openMust.length ? 'open' : 'pass';
        const n = sample.openMust.length;
        why = !sample.must ? 'No must-pass test set' : sample.failedMust.length ? `Failed: ${sample.failedMust.join('; ')}` : n ? `${n} must-pass test${n === 1 ? '' : 's'} not done yet` : 'Passed every must-pass test';
      } else {
        state = yn(g[x.k]);
        why = state === 'open' ? x.q : '';
      }
      out.push({ k: x.k, label: x.label, state, why });
    }
    return out;
  }

  /** The suppliers of a scorecard: [{ slot, s }], each cleaned against the product's tests, slot 1 to 5 in order. */
  function suppliersOf(p) {
    const all = obj(p && p.suppliers);
    const out = [];
    for (let slot = 1; slot <= MAX_SUPPLIERS; slot++) {
      const x = all['s' + slot];
      if (x && typeof x === 'object' && !Array.isArray(x)) out.push({ slot, s: cleanSupplier(x, p && p.setup) });
    }
    return out;
  }

  /** One supplier's line in the comparison: its weighted score (0-100), its 7 parts, its gates and its numbers. */
  function rowOf(slot, s, set, cost) {
    const sample = sampleOf(s, set.tests);
    const days = daysFor(s, set.market);
    const auto = { quality: sample.score, delivery: deliveryScore(days, set.max_days), cost: cost ? cost.score : null };
    const W = CRITERIA.reduce((a, c) => a + set.weights[c.k], 0);
    const parts = {};
    let pts = 0;
    let scored = 0;
    for (const c of CRITERIA) {
      const manual = s.scores[c.k];
      const a = auto[c.k] ?? null;
      const v = manual ?? a;
      parts[c.k] = { v, auto: a, manual: manual != null, w: set.weights[c.k] };
      if (v != null) {
        pts += (v / 5) * set.weights[c.k];
        scored++;
      }
    }
    const gates = gatesOf(s, set, sample, days);
    const status = gates.some((x) => x.state === 'fail') ? 'fail' : gates.some((x) => x.state === 'open') ? 'open' : 'pass';
    return {
      slot, name: s.name || `Supplier ${slot}`, link: s.link || '', route: s.route || '', from: s.from || '', place: s.place || '',
      score: round((100 * pts) / W, 1), parts, scored, of: CRITERIA.length, gates, status,
      failed: gates.filter((x) => x.state === 'fail').map((x) => x.label), open: gates.filter((x) => x.state === 'open').map((x) => x.label),
      days, measured: s.measured === true, ddp: s.ddp === true, landed: cost ? cost.landed : null, duty: cost ? (cost.duty ?? 0) : 0, be_roas: cost ? cost.be_roas : null,
      cost_basis: cost ? cost.basis : '', unit: s.unit ?? null, moq: s.moq ?? null, lead: s.lead ?? null, sample,
    };
  }

  /**
   * The order of the comparison: a supplier that fails a gate goes last. Then the higher score; a tie goes to the better
   * quality, then the faster delivery, then fewer gates still open, then the lower landed cost, then the first added.
   */
  function order(a, b) {
    const known = (x) => (x == null ? -1 : x);
    return (a.status === 'fail') - (b.status === 'fail') || b.score - a.score || known(b.parts.quality.v) - known(a.parts.quality.v)
      || known(b.parts.delivery.v) - known(a.parts.delivery.v) || a.open.length - b.open.length
      || (a.landed ?? Infinity) - (b.landed ?? Infinity) || a.slot - b.slot;
  }

  /** The decision record and its history: { current: record | null, past: [record] }. */
  function choiceOf(p) {
    const c = obj(p && p.choice);
    return { current: c.current && typeof c.current === 'object' && !Array.isArray(c.current) ? c.current : null, past: Array.isArray(c.past) ? c.past : [] };
  }
  const day = (iso) => String(iso || '').slice(0, 10);

  /**
   * The scorecard worked out: every supplier ranked, the pick (the best that fails no gate) and a backup, the verdict,
   * the flags (red first), the checklist done, and your decision with its next re-check.
   */
  function summaryOf(p, now = Date.now()) {
    const set = setupOf(p && p.setup);
    const list = suppliersOf(p);
    // Who is out (a gate failed) does not depend on the cost: known first, so the cost bar is set by those still in.
    const out = new Set(list.filter(({ s }) => gatesOf(s, set, sampleOf(s, set.tests), daysFor(s, set.market)).some((g) => g.state === 'fail')).map((x) => x.slot));
    const costs = costsOf(list, set, out);
    const rows = list.map(({ slot, s }) => rowOf(slot, s, set, costs.get(slot)));
    rows.sort(order);
    rows.forEach((r, i) => (r.rank = i + 1));
    const ok = rows.filter((r) => r.status !== 'fail');
    const pick = ok[0] || null;
    const backup = ok[1] || null;
    const { current } = choiceOf(p);
    const chosen = current ? rows.find((r) => r.slot === current.slot) || null : null;
    const flags = [];
    const add = (k, level, text) => flags.push({ k, level, text });
    if (!rows.length) add('none', 'amber', 'Add the suppliers you compare: up to 5');
    else if (rows.length < 3) add('few', 'amber', 'Compare at least 3 suppliers');
    if (rows.length && !ok.length) add('allfail', 'red', 'No supplier passes the gates');
    if (current && chosen && chosen.status === 'fail') add('chosenfail', 'red', `Your choice ${chosen.name} now fails: ${chosen.failed.join(', ')}`);
    const due = current ? Date.parse(current.next) : NaN;
    const overdue = Number.isFinite(due) && now > due;
    if (overdue) add('overdue', 'red', `Re-check overdue since ${day(current.next)}: price, complaints, delivery days`);
    if (rows.length && !rows.some((r) => r.sample.done)) add('nosample', 'amber', 'Order samples from your top 3 and test them');
    const ref = chosen || pick;
    if (ref && ref.open.length) add('confirm', 'amber', `Before you pay for stock, confirm for ${ref.name}: ${ref.open.join(', ')}`);
    if (pick && pick.score < 60) add('weak', 'amber', `Best score ${pick.score}/100: get more evidence or more suppliers`);
    if (current && chosen && pick && pick.slot !== chosen.slot && pick.score - chosen.score >= 5) add('better', 'amber', `${pick.name} now scores ${pick.score}, your choice ${chosen.score}`);
    if (marketsOf(set).includes('us') && rows.some((r) => r.from !== 'us' && !r.ddp)) {
      add('usduty', 'amber', 'US import duty is not in the landed cost: ask for DDP, or add it to the US shipping');
    }
    flags.sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1));
    const checks = cleanChecks(p && p.checks);
    let verdict;
    if (current) verdict = `Your choice: ${current.name}`;
    else if (!rows.length) verdict = 'No suppliers yet';
    else if (!pick) verdict = 'No supplier passes the gates';
    else if (pick.status === 'pass' && pick.scored === CRITERIA.length) verdict = `Choose ${pick.name}`;
    else verdict = `Best now: ${pick.name}`;
    return {
      rows, pick: pick ? pick.slot : null, backup: backup ? backup.slot : null, verdict, flags,
      level: flags.some((x) => x.level === 'red') ? 'red' : flags.length ? 'amber' : 'green',
      checks: { done: CHECKS.filter((c) => checks[c.k]).length, of: CHECKS.length },
      chosen: current ? { slot: current.slot, name: current.name, at: current.at || '', next: current.next || '', overdue, row: chosen ? chosen.slot : null } : null,
      setup: set,
    };
  }

  // ---- The decision record ----------------------------------------------------------------------------------------

  const addDays = (iso, n) => new Date(Date.parse(iso) + n * 864e5).toISOString();
  /**
   * Your decision: the supplier in `slot` as it is now (its numbers, its score and parts, the gates still open), a
   * backup (the one you name, else the next best that fails no gate; 0: none), why, the date and the next re-check.
   * A supplier that fails a gate cannot be chosen. Returns { choice } or { error, status }.
   */
  function decide(p, input, at) {
    const i = obj(input);
    const slot = Number(i.slot);
    const sum = summaryOf(p, Date.parse(at));
    const row = sum.rows.find((r) => r.slot === slot);
    if (!row) return { error: 'No supplier in that slot', status: 404 };
    if (row.status === 'fail') return { error: `It fails a gate: ${row.failed.join(', ')}`, status: 409 };
    let b = null;
    if (i.backup != null && Number(i.backup) !== 0) {
      b = sum.rows.find((r) => r.slot === Number(i.backup));
      if (!b || b.slot === slot) return { error: 'Bad backup', status: 400 };
      if (b.status === 'fail') return { error: `The backup fails a gate: ${b.failed.join(', ')}`, status: 409 };
    } else if (i.backup == null) b = sum.rows.find((r) => r.slot !== slot && r.status !== 'fail') || null;
    const s = suppliersOf(p).find((x) => x.slot === slot).s;
    const keep = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
    const record = {
      slot, ...keep(s, ['name', 'link', 'route', 'from', 'place', 'unit', 'ship_eu', 'ship_us', 'ddp', 'days_eu', 'days_us', 'measured', 'lead', 'moq']),
      name: row.name, score: row.score, parts: Object.fromEntries(CRITERIA.map((c) => [c.k, row.parts[c.k].v])), status: row.status, open: row.open,
      landed: row.landed, days: row.days, market: sum.setup.market, max_days: sum.setup.max_days, weights: sum.setup.weights,
      backup: b ? { slot: b.slot, name: b.name, score: b.score, link: b.link } : null,
      note: i.note == null ? '' : cleanText(i.note, MAX.note, true), at, next: addDays(at, RECHECK_DAYS), rechecks: [],
    };
    const c = choiceOf(p);
    const past = c.current ? [{ ...c.current, ended: at, why: 'replaced' }, ...c.past].slice(0, MAX.past) : c.past.slice(0, MAX.past);
    return { choice: { current: record, past } };
  }
  /** The decision taken back: it moves to the history. */
  function undecide(p, at) {
    const c = choiceOf(p);
    if (!c.current) return { error: 'No decision to take back', status: 409 };
    return { choice: { current: null, past: [{ ...c.current, ended: at, why: 'taken back' }, ...c.past].slice(0, MAX.past) } };
  }
  /** A re-check done today (before a reorder, or the 90 days are up): its numbers now, your note; the next one in 90 days. */
  function recheck(p, input, at) {
    const c = choiceOf(p);
    if (!c.current) return { error: 'Choose a supplier first', status: 409 };
    const row = summaryOf(p, Date.parse(at)).rows.find((r) => r.slot === c.current.slot);
    const r = { at, note: cleanText(obj(input).note ?? '', MAX.note, true), score: row ? row.score : null, unit: row ? row.unit : null, days: row ? row.days : null, status: row ? row.status : 'gone' };
    const rechecks = [r, ...(Array.isArray(c.current.rechecks) ? c.current.rechecks : [])].slice(0, MAX.rechecks);
    return { choice: { current: { ...c.current, rechecks, next: addDays(at, RECHECK_DAYS) }, past: c.past } };
  }

  /** The first message to a supplier, in English or Chinese, with the product's questions. */
  function messageOf(p, lang) {
    const qs = setupOf(p && p.setup).questions;
    if (lang === 'zh') return ['您好！', '我在荷兰和德国（以及美国）经营网店，正在为这款产品（见图片）比较供应商。请回答以下问题：', ...qs.map((q, i) => `${i + 1}. ${q.zh || q.en}`), '谢谢！'].join('\n');
    return ['Hello,', 'I run an online store in the Netherlands and Germany (and the US), and I am comparing suppliers for this product (see the photo). Could you answer these questions?', ...qs.map((q, i) => `${i + 1}. ${q.en}`), 'Thank you!'].join('\n');
  }

  return {
    CRITERIA, GATES, CHECKS, FIELDS, SETUP, MARKETS, ROUTES, FROM, CURRENCIES, MAX_SUPPLIERS, RECHECK_DAYS, EU_PARCEL,
    cleanSetup, setupOf, cleanSupplier, cleanChecks, cleanTests, cleanQuestions, parseTests, testsText, parseQuestions, questionsText,
    landedOf, summaryOf, decide, undecide, recheck, messageOf,
  };
}

const KIT = supplierKit(launchKit());
export const { CRITERIA, GATES, CHECKS, MAX_SUPPLIERS, cleanSetup, setupOf, cleanSupplier, cleanChecks, parseTests, parseQuestions, landedOf, summaryOf, decide, undecide, recheck, messageOf } = KIT;
export { KIT };
/** GET /supplier.js: the kit's source with the launch kit it uses, run once in the board as window.SUPPLIER. */
export const SUPPLIER_JS = `'use strict';\nwindow.SUPPLIER = (${supplierKit})((${launchKit})());\n`;

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

const COLS = 'product_key, title, facts, setup, checks, suppliers, choice, created_at, updated_at';
export const LIST_SQL = `SELECT ${COLS} FROM sourcing ORDER BY updated_at DESC, product_key LIMIT 100`;
const ROW_SQL = `SELECT ${COLS} FROM sourcing WHERE product_key = ?`;
export const ADD_SQL = `INSERT INTO sourcing (${COLS}) VALUES (?1, ?2, ?3, '{}', '{}', '{}', '{}', ?4, ?4) ON CONFLICT(product_key) DO NOTHING`;
const LAUNCH_SQL = 'SELECT product_key, title, facts FROM launches WHERE product_key = ?';
// One supplier replaced in one statement: a save of another supplier at the same moment is not lost.
const SUPPLIER_SQL = "UPDATE sourcing SET suppliers = json_set(CASE WHEN json_valid(suppliers) THEN suppliers ELSE '{}' END, ?, json(?)), updated_at = ? WHERE product_key = ?";
const DROP_SQL = "UPDATE sourcing SET suppliers = json_remove(CASE WHEN json_valid(suppliers) THEN suppliers ELSE '{}' END, ?), updated_at = ? WHERE product_key = ?";

// A key: a launch card's ('eu|…', 'world|…', 'tiktok|…', as launch.mjs saves it) or a product added by name ('own|slug').
const keyIn = (k) => (typeof k === 'string' && k.length <= 1000 && (/^(eu|world|tiktok)\|./s.test(k) || /^own\|[a-z0-9-]{1,80}$/.test(k)) ? k : '');
const parse = (s, or) => {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : or;
  } catch (e) {
    return or;
  }
};
const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u.slice(0, 500) : '');
const bad = (error, status = 400) => ({ status, body: { error } });

/** A sourcing row for the board: the scorecard with its summary. */
export function productOut(row, now = Date.now()) {
  const p = {
    key: row.product_key, title: row.title || '', facts: parse(row.facts, {}), setup: parse(row.setup, {}), checks: parse(row.checks, {}),
    suppliers: parse(row.suppliers, {}), choice: parse(row.choice, {}), created_at: row.created_at || '', updated_at: row.updated_at || '',
  };
  return Object.assign(p, { summary: summaryOf(p, now) });
}
/** The list's line of a scorecard: what it is, how far, and the decision. */
function shortOut(row, now) {
  const p = productOut(row, now);
  const s = p.summary;
  const best = s.rows.find((r) => r.slot === s.pick);
  return {
    key: p.key, title: p.title, img: https(p.facts.img), link: https(p.facts.link), suppliers: s.rows.length, verdict: s.verdict, level: s.level,
    best: best ? { name: best.name, score: best.score, status: best.status } : null, chosen: s.chosen, checks: s.checks, updated_at: p.updated_at,
  };
}

/** GET /api/supplier: every scorecard in short; ?key=…: one scorecard, whole. */
export async function supplierGet(env, params, now = Date.now()) {
  const want = params.get('key');
  if (want == null) {
    const { results } = await env.DB.prepare(LIST_SQL).all();
    return { status: 200, body: { products: (results || []).map((r) => shortOut(r, now)) } };
  }
  const key = keyIn(want);
  if (!key) return bad('Bad key');
  const row = await env.DB.prepare(ROW_SQL).bind(key).first();
  return row ? { status: 200, body: { product: productOut(row, now) } } : bad('No scorecard for this product', 404);
}

/** The key of a product added by name: 'own|' + its title in lower case, letters and digits only (else a short hash). */
export function ownKey(title) {
  const s = String(title).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 80).replace(/-+$/, '');
  if (s) return 'own|' + s;
  let h = 0;
  for (const c of String(title)) h = (Math.imul(h, 31) + c.codePointAt(0)) >>> 0;
  return 'own|p-' + h.toString(36);
}

/**
 * POST /api/supplier. Returns { status, body } (body.product: the scorecard now). A change names its scorecard by its
 * key: no scorecard under it (removed in another tab) is a 404, never a new one.
 */
export async function supplierPost(env, j, now = Date.now()) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('Bad JSON');
  const at = new Date(now).toISOString();
  const card = async (key) => {
    const row = await env.DB.prepare(ROW_SQL).bind(key).first();
    return row ? { status: 200, body: { ok: true, product: productOut(row, now) } } : bad('No scorecard for this product', 404);
  };
  if (j.start != null) {
    const key = keyIn(j.start);
    if (!key || key.startsWith('own|')) return bad('Bad product');
    const have = await env.DB.prepare(ROW_SQL).bind(key).first();
    if (have) return { status: 200, body: { ok: true, product: productOut(have, now) } };
    const l = await env.DB.prepare(LAUNCH_SQL).bind(key).first();
    if (!l) return bad('No launch card for this product: start one in Launch first', 404);
    const f = parse(l.facts, {});
    const facts = { source: String(f.source || ''), title: String(l.title || f.title || '').slice(0, 300), img: https(f.img), price: Number.isFinite(Number(f.price)) && f.price != null ? Number(f.price) : null, cur: String(f.cur || '').slice(0, 8), link: https(f.product) || https(f.store), launch: key };
    await env.DB.prepare(ADD_SQL).bind(key, facts.title || 'Product', JSON.stringify(facts), at).run();
    return card(key);
  }
  if (j.add != null) {
    const a = j.add && typeof j.add === 'object' && !Array.isArray(j.add) ? j.add : {};
    const title = String(a.title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120);
    if (!title) return bad('Give the product a name');
    const link = cleanLink(a.link);
    if (a.link != null && a.link !== '' && !link) return bad('Bad link: use an https link');
    const key = ownKey(title);
    await env.DB.prepare(ADD_SQL).bind(key, title, JSON.stringify({ source: 'own', title, img: '', price: null, cur: '', link: link || '' }), at).run();
    return card(key);
  }
  const key = keyIn(j.key);
  if (!key) return bad('Bad key');
  const row = await env.DB.prepare(ROW_SQL).bind(key).first();
  if (!row) return bad('No scorecard for this product', 404);
  const p = productOut(row, now);
  if (j.setup !== undefined) {
    await env.DB.prepare('UPDATE sourcing SET setup = ?, updated_at = ? WHERE product_key = ?').bind(JSON.stringify(cleanSetup(j.setup)), at, key).run();
  } else if (j.checks !== undefined) {
    await env.DB.prepare('UPDATE sourcing SET checks = ?, updated_at = ? WHERE product_key = ?').bind(JSON.stringify(cleanChecks(j.checks)), at, key).run();
  } else if (j.slot != null) {
    const slot = Number(j.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SUPPLIERS) return bad(`A slot is 1 to ${MAX_SUPPLIERS}`);
    const c = p.choice && p.choice.current;
    if (j.drop === true) {
      if (c && (c.slot === slot || (c.backup && c.backup.slot === slot))) return bad('This is your choice or its backup: take the decision back first', 409);
      await env.DB.prepare(DROP_SQL).bind('$.s' + slot, at, key).run();
    } else if (j.supplier !== undefined) {
      if (!j.supplier || typeof j.supplier !== 'object' || Array.isArray(j.supplier)) return bad('Bad supplier');
      await env.DB.prepare(SUPPLIER_SQL).bind('$.s' + slot, JSON.stringify(cleanSupplier(j.supplier, p.setup)), at, key).run();
    } else return bad('Nothing to save');
  } else if (j.choose !== undefined) {
    const out = j.choose === null ? undecide(p, at) : decide(p, j.choose, at);
    if (out.error) return bad(out.error, out.status);
    await env.DB.prepare('UPDATE sourcing SET choice = ?, updated_at = ? WHERE product_key = ?').bind(JSON.stringify(out.choice), at, key).run();
  } else if (j.recheck !== undefined) {
    const out = recheck(p, j.recheck, at);
    if (out.error) return bad(out.error, out.status);
    await env.DB.prepare('UPDATE sourcing SET choice = ?, updated_at = ? WHERE product_key = ?').bind(JSON.stringify(out.choice), at, key).run();
  } else if (j.remove === true) {
    await env.DB.prepare('DELETE FROM sourcing WHERE product_key = ?').bind(key).run();
    return { status: 200, body: { ok: true, removed: key } };
  } else return bad('Nothing to save');
  return card(key);
}

/** An https link from what was typed, as the kit cleans one, or ''. */
function cleanLink(x) {
  if (x == null || x === '') return '';
  return KIT.cleanSupplier({ link: x }, {}).link || '';
}
