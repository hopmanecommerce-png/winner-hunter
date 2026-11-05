/*
 * Validate-first: the product sheet for every candidate, made with no manual step. For one product it works out what one
 * order costs and leaves in each market (euros, VAT first, then fees, refunds, the product, shipping and import costs),
 * the break-even CPA and ROAS per offer (1, 2 or 3 units), the compliance blockers (GPSR, CE, WEEE, battery, cosmetics,
 * medical claims, brands, sizes), the supplier path (a Kungfubuy quote when there is one, the 1688 link to paste
 * when there is not, the search links), a cheap validation test plan (budget, creatives, kill and scale rules, dates), and
 * what is fact and what is an estimate. The daily pipeline runs it for every pick (validate.mjs, the CLI) and the board
 * can run the same code in the browser (validateKit as a script, like econKit and launchKit).
 *
 * Everything unknown gets an estimate that says what it rests on, so a sheet never waits for a person: a supplier price
 * from the selling price, a weight from the product type, shipping from a fit of Connor's own Kungfubuy quotes. A pasted
 * 1688 link with its price, or a Kungfubuy quote, replaces the estimate on the next run.
 *
 * Sources (every number below says which): EU VAT rates, Your Europe (last checked 13 Jul 2026, read 5 Nov 2026); the euro
 * reference rates of the ECB (4 Nov 2026); Shopify Payments NL rates (shopify.com/nl/prijzen, read 5 Nov 2026; snuggro is on
 * Basic, Admin API 5 Nov 2026); the EU's €3 duty and €2 handling fee (docs/sourcing/showerhead-muravai.md, European
 * Commission); the market rules outside the EU (market-rules.mjs and countries.mjs, researched 31 Oct and 1 Nov 2026); the
 * shipping fit (28 Kungfubuy quotations of Jun-Sep 2026, research/2026-11-05-winner-system/wh-validate in the
 * product-research repo). General research, not tax or legal advice.
 */

/**
 * The whole kit, in one function that uses nothing from outside itself but its arguments, so the board can run it as a
 * script: R is riskKit() (risk.mjs: the Block / Docs / OK radar), S is sourcingKit() (sourcing.mjs: search links, the
 * paste parser). Both are optional: without R the compliance list has only the checks every product needs.
 */
export function validateKit(R, S) {
  const VERSION = 1;

  // ---- Money and rates --------------------------------------------------------------------------------------------
  // Units of each currency for €1: the ECB's euro reference rates of 4 Nov 2026. AED, SAR and MOP are pegged (to the
  // dollar at 3.6725 and 3.75, to the Hong Kong dollar at 1.03) and worked out from those. TWD: no ECB rate, so none.
  const FX = {
    as_of: '2026-11-04', source: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
    per_eur: { USD: 1.1267, JPY: 178.3, CZK: 24.309, DKK: 7.4738, GBP: 0.8346, HUF: 363.03, PLN: 4.399, RON: 5.344, SEK: 10.9718, CHF: 0.9188, ISK: 136.8,
      NOK: 10.397, TRY: 56.3598, AUD: 1.6061, BRL: 6.1579, CAD: 1.5701, CNY: 7.5177, HKD: 8.8399, IDR: 20425.83, ILS: 3.5641, INR: 106.6318, KRW: 1508.18,
      MXN: 21.0086, MYR: 4.5789, NZD: 1.9988, PHP: 71.578, SGD: 1.4398, THB: 37.902, ZAR: 18.5404, AED: 4.1378, SAR: 4.2251, MOP: 9.1051 },
  };
  // Shopify Payments, Netherlands, Basic plan (snuggro's plan): EU cards 1.9% + €0.25, international cards 2.9% + €0.25.
  // A buyer who pays in another currency than the payout (euros): 2% conversion, as measured on snuggro's own orders
  // (1.9% + about €0.25 + 2% FX, read in Shopify on 1 Nov 2026; research/2026-11-01-cheapest-test, knowledge_gaps.md).
  const PAY = {
    eea: { pct: 1.9, fixed: 0.25, status: 'fact', source: 'https://www.shopify.com/nl/prijzen', checked: '2026-11-05' },
    intl: { pct: 2.9, fixed: 0.25, status: 'fact', source: 'https://www.shopify.com/nl/prijzen', checked: '2026-11-05' },
    conv: { pct: 2, status: 'fact', source: '', note: 'Currency conversion to a payout in euros: 2%, measured on snuggro\'s orders (1 Nov 2026)' },
  };
  // Shipping and the agent's price from China, fitted on Connor's own Kungfubuy quotations (YunExpress Global Special
  // Line, registered, general goods): an order of n units of g grams costs parcel + n × (per_kg × kg + per_item), and
  // the agent charges goods at goods_eur_per_cny × the 1688 price (6.1% over the ECB rate). The EU quotes are of June
  // 2026, before the EU's parcel duty and handling fee: those are added on top (customsOf).
  const LINES = {
    AU: { parcel: 5.91, per_kg: 5.77, per_item: -0.16, n: 18, products: 6, from: '2026-07-05', to: '2026-09-29', rmse: 0.44 },
    NL: { parcel: 3.31, per_kg: 5.5, per_item: 2.08, n: 20, products: 5, from: '2026-06-25', to: '2026-06-28', rmse: 0.52 },
    PL: { parcel: 2.09, per_kg: 7.67, per_item: 1.97, n: 36, products: 9, from: '2026-06-24', to: '2026-06-28', rmse: 1.02 },
  };
  const AGENT = { goods_eur_per_cny: 0.1411, markup_pct: 6.1, line: 'YunExpress Global Special Line (registered, general goods) via Kungfubuy' };
  // Markets without a Kungfubuy quote: YunExpress's public list price (Economy, Shenzhen, regular goods, 20×15×5 cm, "for
  // reference only") for 300 g and 500 g in yuan, queried 28 Oct 2026 (research/2026-10-28-product-hunt/markets-and-moq.md
  // A2), as a straight line through the two, plus what Kungfubuy charges over the list price on its Australia quotes
  // (its fit minus the AU list price at 300 g and 500 g: about €2.62). An estimate: ask for a quote before you rely on it.
  const LIST = { SG: [26.2, 33.0], NZ: [53.51, 72.31], GB: [37.3, 52.5], CH: [59.4, 87.0], CA: [49.5, 70.0], AU: [34.8, 47.0], NO: [48.2, 63.0], US: [67.9, 99.5], AE: [44.5, 59.5] };
  const LIST_AT = { day: '2026-10-28', premium: 2.62, source: 'https://www.yunexpress.com/' };
  // Observed China → buyer days, median and middle 80% (ParcelsApp, all carriers, 60 days to 27 Oct 2026; the same A2
  // table), where there is one. PL: snuggro's own two orders took 13 days (knowledge_gaps.md, 1 Nov 2026).
  // [median, low (10%), high (90%)] in calendar days; null: not given. NL and DE: median and 90% within (ParcelsApp, Sep–Oct
  // 2026, as docs/sourcing/supplier-selection.md quotes it).
  const OBSERVED = { SG: [6, 3, 10], NZ: [8, 5, 12], GB: [9, 6, 19], CH: [9, 6, 15], CA: [9, 6, 16], AU: [10, 5, 19], NO: [10, 7, 17], US: [10, 6, 18], NL: [8, null, 15], DE: [10, null, 19], PL: [13, 13, 13] };
  const OBSERVED_SRC = { PL: 'snuggro\'s own 2 orders (knowledge_gaps.md, 1 Nov 2026)', NL: 'ParcelsApp, Sep–Oct 2026', DE: 'ParcelsApp, Sep–Oct 2026', other: 'ParcelsApp, 60 days to 27 Oct 2026' };
  // EU customs on a parcel sent from China straight to the buyer: a €3 duty per kind of item in a parcel worth up to €150
  // (1 Jul 2026 to 1 Jul 2028), a €2 Union handling fee per item line from 1 Nov 2026 (also above €150) with VAT on it.
  // Over €150: no IOSS, so the buyer pays import VAT and duty at the door.
  const EU_CUSTOMS = { duty: 3, duty_from: '2026-07-01', duty_to: '2028-07-01', max: 150, uhf: 2, uhf_from: '2026-11-01',
    source: 'https://commission.europa.eu/news-and-media/news/ensuring-fairness-and-safety-eur3-customs-duty-low-value-parcels-2026-06-29_en', status: 'fact' };

  // ---- Markets ----------------------------------------------------------------------------------------------------
  // tax.how: 'checkout' (you charge it at checkout: IOSS, UK VAT, VOEC), 'registered' (you charge it once your sales there
  // pass the threshold; counted from the first order, so the margin holds at scale), 'none' (nothing at the door below the
  // limit and no registration at snuggro's size), 'door' (the buyer pays at the door unless the line is DDP: counted as
  // your cost on a DDP line). duty: a share of the price you pay on a DDP line (an estimate), or the EU's fixed fees.
  // ship: which fitted line it uses (quote: fitted on that country's own quotes; else an estimate from a nearby one).
  const YE = 'https://europa.eu/youreurope/business/finance-and-tax/vat/vat-rules-rates/index_en.htm';
  const EU_VAT = { AT: 20, BE: 21, BG: 20, CY: 19, CZ: 21, DE: 19, DK: 25, EE: 24, GR: 24, ES: 21, FI: 25.5, FR: 20, HR: 25, HU: 27, IE: 23, IT: 22, LT: 21,
    LU: 17, LV: 21, MT: 18, NL: 21, PL: 23, PT: 23, RO: 21, SE: 25, SI: 22, SK: 23 };
  const EU_NAMES = { AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany', DK: 'Denmark', EE: 'Estonia', GR: 'Greece', ES: 'Spain',
    FI: 'Finland', FR: 'France', HR: 'Croatia', HU: 'Hungary', IE: 'Ireland', IT: 'Italy', LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', MT: 'Malta', NL: 'Netherlands',
    PL: 'Poland', PT: 'Portugal', RO: 'Romania', SE: 'Sweden', SI: 'Slovenia', SK: 'Slovakia' };
  const EU_CUR = { BG: 'BGN', CZ: 'CZK', DK: 'DKK', HU: 'HUF', PL: 'PLN', RO: 'RON', SE: 'SEK' };
  // Days from China to the buyer: YunExpress's published times where countries.mjs has them (business days, after
  // pick-up), else a rough range for a tracked line. NL and DE: YunExpress, as docs/sourcing/supplier-selection.md quotes it.
  const YUN = 'https://www.yunexpress.com/our-solutions/b2c/33';
  const MKT = {
    GB: { name: 'United Kingdom', cur: 'GBP', tax: { pct: 20, how: 'checkout', limit: 'Up to £135 a parcel you charge UK VAT at checkout (register from the first sale); no duty up to £135', status: 'fact', source: 'https://www.gov.uk/government/publications/changes-to-vat-treatment-of-overseas-goods-sold-to-customers-from-1-january-2021/changes-to-vat-treatment-of-overseas-goods-sold-to-customers-from-1-january-2021' }, max_local: 135, ship: 'NL', days: [3, 5, 'estimate', YUN] },
    US: { name: 'United States', cur: 'USD', tax: { pct: 0, how: 'none', limit: 'No VAT; state sales tax from $100,000 a state', status: 'unverified', source: 'https://www.salestaxinstitute.com/resources/economic-nexus-state-guide' },
      duty: { pct: 35, status: 'estimate', text: 'No de minimis: every parcel from China owes duty (MFN 0–12% + Section 301 7.5% or 25% + 12.5%, about 28–50% by HTS code). Counted at 35% of the price on a DDP line', source: 'https://ustr.gov/sites/default/files/files/Press/Releases/2026/FLIP%20301%20Investigation%20Final%20Action%20FRN%207-23-26%20FINAL.pdf' }, ship: 'AU', days: [5, 8, 'estimate', YUN] },
    CA: { name: 'Canada', cur: 'CAD', tax: { pct: 13, how: 'door', limit: 'Over CAD 20 the buyer owes GST 5% or HST 13–15%, duty and a fee at the border; counted at 13% on a DDP line', status: 'estimate', source: 'https://www.cbsa-asfc.gc.ca/services/cusma-aceum/lvs-efv-eng.html' },
      duty: { pct: 10, status: 'estimate', text: 'Duty on China goods by HS code: counted at 10% of the price (not checked per product)', source: 'https://www.cbsa-asfc.gc.ca/services/cusma-aceum/lvs-efv-eng.html' }, ship: 'AU', days: [8, 10, 'estimate', YUN] },
    AU: { name: 'Australia', cur: 'AUD', tax: { pct: 10, how: 'registered', limit: 'GST 10% once your sales to Australia pass A$75,000 a year; nothing at the door up to A$1,000', status: 'unverified', source: 'https://trykintsugi.com/sales-tax-guides/apac/australia' }, ship: 'AU', quote: true, days: [4, 7, 'estimate', YUN] },
    NZ: { name: 'New Zealand', cur: 'NZD', tax: { pct: 15, how: 'registered', limit: 'GST 15% once your sales to New Zealand pass NZ$60,000 in 12 months; nothing at the door up to NZ$1,000', status: 'fact', source: 'https://www.ird.govt.nz/gst/gst-for-overseas-businesses/gst-on-low-value-imported-goods/registering-for-gst-on-low-value-imported-goods' },
      fee: { local: 2.54, status: 'estimate', text: 'Border levy NZ$2.21 + GST per air consignment, on whoever lodges the clearance (assumed passed on to you)', source: 'https://www.customs.govt.nz/media/utdnkqm0/quick-reference-guide-all-goods-levies-from-1-april-2026.pdf' }, ship: 'AU', days: [7, 14, 'unverified', ''] },
    CH: { name: 'Switzerland', cur: 'CHF', tax: { pct: 8.1, how: 'door', free_local: 62, limit: 'Nothing at the door up to about CHF 62; above it VAT 8.1% + Swiss Post CHF 16 + 3% (counted as yours on a DDP line)', status: 'estimate', source: 'https://www.post.ch/en/receiving-mail/import-customs-clearance' },
      fee: { local: 16, above_local: 62, status: 'estimate', text: 'Swiss Post clearance CHF 16 (+3% of the goods) above about CHF 62', source: 'https://www.post.ch/en/receiving-mail/import-customs-clearance' }, ship: 'NL', days: [7, 14, 'unverified', ''] },
    NO: { name: 'Norway', cur: 'NOK', tax: { pct: 25, how: 'checkout', limit: 'VAT 25% at checkout through VOEC (register before the first sale, required from NOK 50,000 a year); no door fee then', status: 'fact', source: 'https://www.skatteetaten.no/en/business-and-organisation/vat-and-duties/vat/foreign/e-commerce-voec/register' }, ship: 'NL', days: [7, 14, 'unverified', ''] },
    SG: { name: 'Singapore', cur: 'SGD', tax: { pct: 0, how: 'none', limit: 'GST 9% only once you pass S$1M worldwide and S$100,000 in Singapore; by air up to S$400 nothing at the door', status: 'fact', source: 'https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/gst-and-digital-economy/overseas-businesses' }, ship: 'AU', days: [5, 10, 'unverified', ''] },
    HK: { name: 'Hong Kong', cur: 'HKD', tax: { pct: 0, how: 'none', limit: 'No VAT and no tariff on ordinary goods', status: 'fact', source: 'https://www.customs.gov.hk/en/service-enforcement-information/cargo-clearance/index.html' }, ship: 'AU', days: [2, 5, 'unverified', ''] },
    JP: { name: 'Japan', cur: 'JPY', tax: { pct: 0, how: 'none', limit: 'Customs value up to ¥10,000: no duty or consumption tax at the door', status: 'fact', source: 'https://www.customs.go.jp/english/c-answer_e/imtsukan/1006_e.htm' }, max_local: 10000, ship: 'AU', days: [3, 7, 'estimate', YUN] },
    KR: { name: 'South Korea', cur: 'KRW', tax: { pct: 0, how: 'none', limit: 'Personal goods up to $150 with shipping: no duty or VAT; the buyer gives a clearance code', status: 'fact', source: 'https://www.customs.go.kr/english/cm/cntnts/cntntsView.do?mi=8058&cntntsId=2734' }, max_usd: 150, ship: 'AU', days: [4, 8, 'unverified', ''] },
    MY: { name: 'Malaysia', cur: 'MYR', tax: { pct: 0, how: 'none', limit: 'Low-value goods tax 10% only once you pass RM500,000 in 12 months; air courier up to RM500 exempt at the door', status: 'fact', source: 'https://mylvg.customs.gov.my/FAQ' }, ship: 'AU', days: [6, 12, 'unverified', ''] },
    IL: { name: 'Israel', cur: 'ILS', tax: { pct: 0, how: 'none', limit: 'Up to $75 no VAT or duty at the door (news, gov.il blocked); VAT 18% above', status: 'unverified', source: 'https://www.timesofisrael.com/knesset-revokes-smotrichs-order-expanding-personal-import-tax-exemption-to-130/amp/' }, max_usd: 75, ship: 'AU', days: [8, 15, 'unverified', ''] },
    AE: { name: 'United Arab Emirates', cur: 'AED', tax: { pct: 5, how: 'door', limit: 'Import VAT 5%, paid by the importer (counted as yours on a DDP line); Dubai duty-free up to AED 1,000', status: 'fact', source: 'https://tax.gov.ae/DownloadOpenTextFile?fileUrl=en%2FVAT_VAT_Guides%2FE_Commerce%2FE_Commerce_VAT+Guide_EN_09_08_2020_EN.pdf' }, ship: 'AU', days: [7, 10, 'estimate', 'https://carriers.aftership.com/yunexpress'] },
  };
  for (const [cc, vat] of Object.entries(EU_VAT)) {
    const nl = cc === 'NL';
    MKT[cc] = { name: EU_NAMES[cc], cur: EU_CUR[cc] || 'EUR', eu: true,
      tax: { pct: vat, how: 'checkout', limit: `VAT ${vat}% charged at checkout through IOSS (parcels up to €150)`, status: 'fact', source: YE, checked: '2026-11-05' },
      ship: cc === 'PL' ? 'PL' : 'NL', quote: nl || cc === 'PL',
      days: nl ? [3, 6, 'estimate', YUN] : cc === 'DE' ? [5, 8, 'estimate', YUN] : [5, 10, 'unverified', ''] };
  }
  const MARKET_ORDER = ['NL', 'BE', 'DE', 'FR', 'AT', 'IE', 'IT', 'ES', 'DK', 'SE', 'FI', 'PL', 'PT', 'LU', 'GB', 'US', 'CA', 'AU', 'NZ', 'CH', 'NO', 'SG', 'HK', 'JP', 'KR', 'MY', 'IL', 'AE',
    ...Object.keys(EU_VAT).filter((c) => !['NL', 'BE', 'DE', 'FR', 'AT', 'IE', 'IT', 'ES', 'DK', 'SE', 'FI', 'PL', 'PT', 'LU'].includes(c))];

  // ---- What the numbers assume until a pick says otherwise ----------------------------------------------------------
  const DEFAULTS = {
    refund_pct: 5, // orders refunded (the goods do not go back to China): the board's 💶 default, an assumption
    refund_sizes_pct: 15, // the same when the buyer has to pick a size (the radar's ↩ Sizes): an assumption
    cost_guess_pct: 15, // no supplier price yet: this share of the selling price (the board's default), an estimate
    weight_guess_g: 300, // no weight and no product type that says more: the board's default
    offers: [{ units: 1, off: 0 }, { units: 2, off: 15 }, { units: 3, off: 25 }], // 1, "2 for 15% off", "3 for 25% off": assumptions
    target_roas: 2.5, green_roas: 2, red_roas: 3, min_profit: 10, // the board's 💶 verdict thresholds
    max_days: 12, // the most days a customer waits (supplier.mjs's delivery gate; the May 2026 rule "under 12 days to NL/BE")
    home: 'NZ', // the test market: snuggro's primary Shopify market (Admin API, 5 Nov 2026)
    // Connor's staged test of 1 Nov 2026 (research/2026-11-01-cheapest-test, waiting for his OK): €20 a day per product,
    // 3 statics, checks at €20 (CPC and CTR), €40 (a sale or enough carts), €60 (the page) and €140 (keep or stop).
    // cr: the conversion rate the CPC check assumes (3%: CPC up to break-even ÷ 33); cart_share: a cart may cost up to 40%
    // of the break-even CPA. The pre-order test (made-to-order products) is the 29 Oct validate-first one.
    test: { daily: 20, creatives: 3, gate_cpc: 20, gate_cart: 40, gate_page: 60, round: 140, cr: 3, cart_share: 40, ctr: 1, lpv: 70, scale_pct: 20, scale_every: 2,
      cap_total: 300, store_cr: { pct: 1.4, low: 0.29, high: 4.08, n: '3 orders in 215 paid sessions, May–Jul 2026' } },
  };
  // A weight for a product with none yet, from words in its name (packed, grams): rough guesses from the quotes above and
  // the earlier runs, each said on the sheet as a guess. The first that matches counts.
  const WEIGHTS = [
    [/\b(weighted blanket|duvet|comforter|quilt|mattress topper|body pillow|pregnancy pillow|u[- ]shaped pillow)\b/i, 1500],
    [/\b(pillow|cushion|blanket|throw|sleeping bag|mattress|bedding set|sheet set)\b/i, 900],
    [/\b(pillowcase|pillow case|eye mask|sleep mask|mouth tape|nose strip|ear ?plugs?|socks?|scrunchie|patch(es)?)\b/i, 120],
    [/\b(lamp|light|speaker|humidifier|diffuser|fan|heater|massager|projector|alarm)\b/i, 600],
    [/\b(bottle|tumbler|mug|cup|jar)\b/i, 450],
  ];

  const round = (x, d = 2) => {
    const f = 10 ** d;
    const r = Math.round(x * f) / f;
    return r === 0 ? 0 : r; // never -0
  };
  const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
  const clean = (x, n = 300) => String(x ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
  const eur = (v) => (v == null ? '–' : (v < 0 ? '−€' : '€') + Math.abs(v).toFixed(2));
  const pct = (v) => (v == null ? '–' : `${round(v, 1)}%`);
  const times = (v) => (v == null ? '–' : `${round(v, 2)}×`);
  const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
  const addDays = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const https = (u) => (typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u.trim()) ? u.trim() : '');
  const slug = (s) => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'product';

  /** € for an amount in cur (ECB rates), or null when the kit has no rate for it. */
  function toEur(amount, cur) {
    const n = num(amount);
    if (n == null) return null;
    const c = String(cur || 'EUR').toUpperCase();
    if (c === 'EUR') return n;
    const r = FX.per_eur[c];
    return r > 0 ? n / r : null;
  }
  /** The amount in cur for €x, or null. */
  function fromEur(x, cur) {
    const c = String(cur || 'EUR').toUpperCase();
    if (c === 'EUR') return x;
    const r = FX.per_eur[c];
    return r > 0 ? x * r : null;
  }
  /** A price as written: "¥23.50", "23,5 元", "$3.20", "€2,80", "A$59.95", 12.5 (in cur0). The top of a range. */
  function priceOf(x, cur0 = 'EUR') {
    if (typeof x === 'number') return Number.isFinite(x) && x >= 0 ? { amount: x, cur: cur0 } : null;
    const s = clean(x, 80);
    if (!s) return null;
    const curs = [['CNY', /CN¥|RMB|CNY|元|[¥￥]|yuan/i], ['AUD', /A\$|AUD/i], ['NZD', /NZ\$|NZD/i], ['CAD', /C\$|CAD/i], ['USD', /US\$|USD|\$/i], ['GBP', /£|GBP/i], ['EUR', /€|EUR/i]];
    let cur = '';
    for (const [c, re] of curs) {
      if (re.test(s)) {
        cur = c;
        break;
      }
    }
    if (!cur) cur = (/\b([A-Z]{3})\b/.exec(s) || [])[1] || cur0;
    const nums = (s.match(/\d[\d.,]*/g) || []).map((t) => {
      let v = t.replace(/[.,]$/, '');
      if (/,\d{1,2}$/.test(v) && !/\.\d/.test(v)) v = v.replace(/\./g, '').replace(',', '.');
      else v = v.replace(/,/g, '');
      return Number(v);
    }).filter((n) => Number.isFinite(n));
    if (!nums.length || nums.length > 2) return null;
    return { amount: Math.max(...nums), cur };
  }

  // ---- One order in one market ------------------------------------------------------------------------------------
  /** The market's rules, or null. */
  const marketOf = (cc) => (Object.hasOwn(MKT, String(cc || '').toUpperCase()) ? Object.assign({ cc: String(cc).toUpperCase() }, MKT[String(cc).toUpperCase()]) : null);

  /**
   * Shipping (and the agent's handling) of one parcel of `units` × `grams` to a market, from China: { eur, line, status,
   * basis }. Its own Kungfubuy quotes where there are some (AU, NL, PL: a fit); else YunExpress's list price plus the
   * premium Kungfubuy charges over it; else the nearest fit (the EU: the Netherlands; elsewhere: Australia), a guess.
   */
  function shipOf(market, units, grams) {
    const cc = market.cc;
    const g = Math.max(Number(grams) || 0, 1);
    const n = Math.max(1, Math.round(units) || 1);
    const fit = (L, status, basis) => ({ eur: round(Math.max(0, L.parcel + n * (L.per_kg * (g / 1000) + L.per_item))), line: 'fit', status, basis });
    if (LINES[cc]) {
      const L = LINES[cc];
      return fit(L, 'estimate', `fit of ${L.n} Kungfubuy quotes to ${market.name} (${L.from} to ${L.to}; within about €${L.rmse})`);
    }
    if (LIST[cc]) {
      const [p3, p5] = LIST[cc];
      const kg = (g * n) / 1000;
      const cny = p3 + ((p5 - p3) / 0.2) * (kg - 0.3);
      return { eur: round(cny / FX.per_eur.CNY + LIST_AT.premium), line: 'list', status: 'estimate',
        basis: `YunExpress list price to ${market.name} (${LIST_AT.day}) + €${LIST_AT.premium} that Kungfubuy charges over it on its Australia quotes` };
    }
    const near = market.eu ? 'NL' : 'AU';
    return fit(LINES[near], 'guess', `no quote or list price for ${market.name}: modelled on the ${near === 'NL' ? 'Netherlands' : 'Australia'} quotes (${LINES[near].from} to ${LINES[near].to})`);
  }

  /** Delivery days to a market: { median, low, high, unit, status, basis } (observed where known, else the carrier's own). */
  function daysOf(market) {
    const o = OBSERVED[market.cc];
    if (o) return { median: o[0], low: o[1], high: o[2], unit: 'days', status: market.cc === 'PL' ? 'fact' : 'fact', basis: OBSERVED_SRC[market.cc] || OBSERVED_SRC.other };
    const d = market.days || [7, 14, 'unverified', ''];
    return { median: null, low: d[0], high: d[1], unit: 'business days', status: d[2], basis: d[2] === 'estimate' ? 'YunExpress\'s published time' : 'a rough range for a tracked line (no table): ask the agent', source: d[3] || '' };
  }

  /**
   * Import costs on one parcel worth `net` euros before VAT, with `lines` kinds of item, on `day`: { eur, parts:
   * [{ k, eur, text }], over: true when it is above the market's low-value limit (the buyer pays at the door) }.
   */
  function customsOf(market, net, price, day, lines = 1) {
    const parts = [];
    let over = false;
    if (market.eu) {
      if (net > EU_CUSTOMS.max) over = true;
      else if (day >= EU_CUSTOMS.duty_from && day < EU_CUSTOMS.duty_to) parts.push({ k: 'duty', eur: EU_CUSTOMS.duty * lines, text: `EU duty €${EU_CUSTOMS.duty} per kind of item (parcel up to €150)` });
      if (day >= EU_CUSTOMS.uhf_from) {
        const fee = EU_CUSTOMS.uhf * lines;
        parts.push({ k: 'uhf', eur: round(fee * (1 + market.tax.pct / 100)), text: `EU handling fee €${EU_CUSTOMS.uhf} per item line + ${market.tax.pct}% VAT on it` });
      }
    } else {
      const local = fromEur(price, market.cur);
      if (market.max_local != null && local != null && local > market.max_local) over = true;
      if (market.max_usd != null && fromEur(price, 'USD') > market.max_usd) over = true;
      if (market.duty) parts.push({ k: 'duty', eur: round((price * market.duty.pct) / 100), text: market.duty.text });
      if (market.fee) {
        const above = market.fee.above_local == null || (local != null && local > market.fee.above_local);
        const e = toEur(market.fee.local, market.cur);
        if (above && e != null) parts.push({ k: 'fee', eur: round(e), text: market.fee.text });
      }
    }
    return { eur: round(parts.reduce((s, p) => s + p.eur, 0)), parts, over };
  }

  /**
   * One order: units at price (euros, what the buyer pays with any VAT you charge), the unit's supplier cost (euros, the
   * product only) and packed weight, in one market on one day. VAT first, then payment fees, refunds, the product, the
   * shipping and the import costs. contribution: what it leaves before ads = the break-even CPA. be_roas: price ÷ that.
   */
  function orderOf({ market, price, units = 1, unit_cost, grams, refund_pct, day, lines = 1, local: given = null }) {
    const m = market;
    const t = m.tax;
    const local = given != null ? given : fromEur(price, m.cur); // the price as written when it is in this market's currency
    // Who pays the tax: you at checkout (it comes out of the price), you on a DDP line (a cost), or nobody below the limit.
    const doorFree = t.how === 'door' && t.free_local != null && local != null && local <= t.free_local;
    const inPrice = t.how === 'checkout' || t.how === 'registered';
    const vat = inPrice ? (price * t.pct) / (100 + t.pct) : 0;
    const net = price - vat;
    const ddpTax = t.how === 'door' && !doorFree ? (price * t.pct) / 100 : 0;
    const card = m.eu ? PAY.eea : PAY.intl;
    const conv = m.cur !== 'EUR' ? PAY.conv.pct : 0;
    const fees = (price * (card.pct + conv)) / 100 + card.fixed;
    const refunds = (net * refund_pct) / 100;
    const product = unit_cost * units;
    const ship = shipOf(m, units, grams);
    const cu = customsOf(m, net, price, day, lines);
    const landed = product + ship.eur + cu.eur + ddpTax;
    const c = net - fees - refunds - landed;
    return {
      cc: m.cc, units, price: round(price), local: local == null ? null : round(local), cur: m.cur, vat: round(vat), vat_pct: t.pct, vat_how: t.how, net: round(net),
      fees: round(fees), fee_text: `${card.pct}%${conv ? ` + ${conv}% conversion` : ''} + €${card.fixed}`, refunds: round(refunds), refund_pct,
      product: round(product), ship: ship.eur, ship_status: ship.status, ship_basis: ship.basis, customs: cu.eur, customs_parts: cu.parts, ddp_tax: round(ddpTax),
      over: cu.over, landed: round(landed), contribution: round(c), margin_pct: price > 0 ? round((c / price) * 100, 1) : null,
      be_cpa: round(Math.max(c, 0)), be_roas: c > 0 ? round(price / c) : null, profit_at_target: null,
    };
  }

  /** The verdict of one order, the board's 💶 thresholds: { level, reasons }. */
  function levelOf(o, s) {
    const reasons = [];
    if (o.contribution <= 0) reasons.push({ level: 'red', text: `Loses ${eur(-o.contribution)} per order before ads` });
    else if (o.be_roas >= s.red_roas) reasons.push({ level: 'red', text: `Break-even ROAS ${times(o.be_roas)} (red from ${times(s.red_roas)})` });
    else if (o.be_roas > s.green_roas) reasons.push({ level: 'amber', text: `Break-even ROAS ${times(o.be_roas)} (green up to ${times(s.green_roas)})` });
    else reasons.push({ level: 'green', text: `Break-even ROAS ${times(o.be_roas)}: room for ads` });
    if (o.contribution > 0 && o.contribution < s.min_profit) reasons.push({ level: 'amber', text: `${eur(o.contribution)} per order for ads (amber under ${eur(s.min_profit)})` });
    if (o.over) reasons.push({ level: 'red', text: 'Above the low-value limit: the buyer pays import tax at the door' });
    const level = reasons.some((r) => r.level === 'red') ? 'red' : reasons.some((r) => r.level === 'amber') ? 'amber' : 'green';
    return { level, reasons };
  }

  // ---- The inputs of one pick, with where each comes from -------------------------------------------------------------
  /**
   * The numbers a sheet starts from: the selling price (euros), the supplier's unit cost (euros, the product only), the
   * packed weight, each with its basis and status (fact: from a quote or a source; estimate: worked out; guess: a default).
   * A Kungfubuy quote for the product wins; then a supplier price on the pick (a pasted 1688 link); then the guess.
   */
  function inputsOf(pick, s, quote) {
    const out = {};
    const p = pick || {};
    const theirs = p.price != null ? priceOf(p.price, p.cur || 'EUR') : null;
    const theirEur = theirs ? toEur(theirs.amount, theirs.cur) : null;
    const mine = p.sell_price != null ? priceOf(p.sell_price, 'EUR') : null;
    const mineEur = mine ? toEur(mine.amount, mine.cur) : null;
    if (mineEur > 0) out.price = { eur: round(mineEur), status: 'assumption', basis: `your price ${mine.cur === 'EUR' ? eur(mine.amount) : `${mine.amount} ${mine.cur}`}` };
    else if (theirEur > 0) out.price = { eur: round(theirEur), status: 'fact', basis: `their store's price ${theirs.cur === 'EUR' ? eur(theirs.amount) : `${theirs.amount} ${theirs.cur}`} at the ECB rate of ${FX.as_of}`, local: theirs };
    else out.price = null;
    const sup = p.supplier && typeof p.supplier === 'object' ? p.supplier : {};
    const sc = sup.cost != null ? priceOf(sup.cost, 'CNY') : null;
    if (quote && quote.goods_cny > 0) {
      out.cost = { eur: round(quote.goods_cny * AGENT.goods_eur_per_cny, 2), status: 'fact', basis: `Kungfubuy quote ${quote.id} (${quote.day}): goods ¥${quote.goods_cny} at the agent's rate (¥${round(1 / AGENT.goods_eur_per_cny, 2)} per €)` };
    } else if (sc) {
      const e = sc.cur === 'CNY' ? sc.amount * AGENT.goods_eur_per_cny : toEur(sc.amount, sc.cur);
      out.cost = e != null ? { eur: round(e), status: sup.status === 'fact' ? 'fact' : 'estimate', basis: `supplier price ${sc.cur === 'CNY' ? '¥' : ''}${sc.amount}${sc.cur === 'CNY' ? '' : ' ' + sc.cur}${sc.cur === 'CNY' ? ` at the agent's rate (¥${round(1 / AGENT.goods_eur_per_cny, 2)} per €)` : ''}${sup.url ? ' (' + (sup.platform || 'link') + ')' : ''}` } : null;
    }
    if (!out.cost && out.price) out.cost = { eur: round((out.price.eur * s.cost_guess_pct) / 100), status: 'guess', basis: `no supplier price yet: ${s.cost_guess_pct}% of the selling price (the board's default)` };
    const qw = quote && quote.weight_g > 0 ? quote.weight_g : null;
    const w = num(sup.weight_g) >= 1 ? num(sup.weight_g) : null;
    if (qw) out.grams = { g: Math.round(qw), status: 'fact', basis: `Kungfubuy's weight for quote ${quote.id}` };
    else if (w) out.grams = { g: Math.round(w), status: sup.status === 'fact' ? 'fact' : 'estimate', basis: 'the supplier\'s packed weight' };
    else {
      const name = `${p.name || ''} ${p.category && p.category.sub ? p.category.sub : ''}`;
      const hit = WEIGHTS.find(([re]) => re.test(name));
      out.grams = hit ? { g: hit[1], status: 'guess', basis: `no weight yet: ${hit[1]} g for "${(hit[0].exec(name) || [''])[0]}"` } : { g: s.weight_guess_g, status: 'guess', basis: `no weight yet: ${s.weight_guess_g} g (the board's default)` };
    }
    return out;
  }

  /**
   * The markets to work out, the test market first: `home` (the market the store sells in now: snuggro's primary Shopify
   * market is New Zealand, Admin API 5 Nov 2026), then the pick's own (where its ads run), then the main ones. At most 8.
   */
  function marketsOf(pick, home = 'NZ') {
    const own = (Array.isArray(pick && pick.markets) ? pick.markets : []).map((c) => String(c).toUpperCase()).filter((c) => Object.hasOwn(MKT, c));
    const first = Object.hasOwn(MKT, String(home || '').toUpperCase()) ? [String(home).toUpperCase()] : [];
    const src = pick && pick.source;
    const base = src === 'eu' ? ['NL', 'DE', 'BE', 'FR', 'AU', 'US'] : ['AU', 'US', 'GB', 'CA', 'NL', 'DE'];
    return [...new Set([...first, ...own, ...base])].slice(0, 8);
  }

  /**
   * The money of a pick in every market of marketsOf, for every offer: { main, markets: [{ cc, name, offers: [order],
   * best, level, reasons, days }], inputs }. main: the first market (the pick's own first, else NL or AU).
   */
  // Kungfubuy's names for its destination countries.
  const QUOTE_CC = { australia: 'AU', holland: 'NL', netherlands: 'NL', poland: 'PL', germany: 'DE', france: 'FR', belgium: 'BE', 'new zealand': 'NZ', 'united states': 'US', usa: 'US', 'united kingdom': 'GB', uk: 'GB', canada: 'CA' };
  const quoteCc = (q) => QUOTE_CC[String((q && q.country) || '').trim().toLowerCase()] || '';

  function economicsOf(pick, s, day, quote, returnsSizes) {
    const inp = inputsOf(pick, s, quote);
    const refund = returnsSizes ? s.refund_sizes_pct : s.refund_pct;
    const markets = [];
    for (const cc of marketsOf(pick, s.home)) {
      const m = marketOf(cc);
      if (!inp.price || !inp.cost) {
        markets.push({ cc, name: m.name, cur: m.cur, offers: [], level: 'amber', reasons: [{ level: 'amber', text: 'No price known: no margin yet' }], days: daysOf(m), tax: m.tax });
        continue;
      }
      // A Kungfubuy quote to this very country is the fact for product + shipping of 1 to 5 units: it replaces the fit.
      const quoted = quote && quoteCc(quote) === cc ? quote.eur : null;
      const own = inp.price.local && inp.price.local.cur === m.cur ? inp.price.local.amount : null; // their price is in this currency
      const run = (price, units, off = 0, scaled = false) => {
        const local = own != null && !scaled ? round(own * units * (1 - off / 100), 2) : null; // scaled: a price that is not theirs
        const x = orderOf({ market: m, price, units, unit_cost: inp.cost.eur, grams: inp.grams.g, refund_pct: refund, day, local });
        const total = quoted && quoted[units - 1] > 0 ? quoted[units - 1] : null;
        if (total != null) {
          const ship = round(total - x.product);
          const d = ship - x.ship;
          Object.assign(x, { ship, ship_status: 'fact', ship_basis: `Kungfubuy quote ${quote.id} (${quote.day}): ${eur(total)} for ${units} unit${units > 1 ? 's' : ''} with shipping`, landed: round(x.landed + d), contribution: round(x.contribution - d) });
          x.margin_pct = price > 0 ? round((x.contribution / price) * 100, 1) : null;
          x.be_cpa = round(Math.max(x.contribution, 0));
          x.be_roas = x.contribution > 0 ? round(price / x.contribution) : null;
        }
        return x;
      };
      const offers = s.offers.map((o) => {
        const price = round(inp.price.eur * o.units * (1 - o.off / 100));
        const x = run(price, o.units, o.off);
        x.off = o.off;
        x.profit_at_target = round(x.contribution - price / s.target_roas);
        return x;
      });
      const one = offers[0];
      const v = levelOf(one, s);
      // Margin as a straight line in the price, c(p) = k·p − K (from two prices): the price from which break-even ROAS is
      // green_roas, and the most the supplier may charge per unit for that at this price.
      const p1 = one.price;
      const c2 = run(round(p1 * 2), 1, 0, true).contribution;
      const k = (c2 - one.contribution) / p1;
      const K = k * p1 - one.contribution;
      const g = 1 / s.green_roas;
      const minPrice = k > g ? round(K / (k - g)) : null;
      const maxCost = round(inp.cost.eur + one.contribution - p1 * g);
      // Below a registration threshold (AU, NZ) the tax is not yours to pay yet: what an order leaves in the test phase.
      const before = m.tax.how === 'registered' ? round(one.contribution + one.vat) : null;
      markets.push({ cc, name: m.name, cur: m.cur, offers, level: v.level, reasons: v.reasons, days: daysOf(m), tax: m.tax, quoted: !!quoted,
        max_cost: maxCost > 0 ? maxCost : null, max_cost_cny: maxCost > 0 ? round(maxCost / AGENT.goods_eur_per_cny, 1) : null, min_price: minPrice,
        min_price_local: minPrice != null && m.cur !== 'EUR' && fromEur(minPrice, m.cur) != null ? round(fromEur(minPrice, m.cur), 2) : null,
        before_registration: before, best: offers.reduce((a, b) => (b.contribution > a.contribution ? b : a), one).units });
    }
    const main = markets[0] ? markets[0].cc : null;
    return { main, markets, inputs: inp, refund_pct: refund };
  }

  // ---- Compliance -------------------------------------------------------------------------------------------------
  // Connor's board exclusions (CLAUDE.md) and the categories he has not decided on: flagged, never decided here.
  // Gymwear only with a gym word (shaping and cellulite leggings are undecided, below); food and supplements come from the
  // radar ('eat', a Block) and Jev's "people take it".
  const EXCLUDED = [
    ['gymwear', /\b(gym ?wear|gym (?:leggings|shorts|set|top)|workout (?:leggings|set|shorts|top)|yoga (?:pants|leggings)|sports? bras?|scrunch butt)\b/i, 'Gymwear: off the board (Connor\'s rule)'],
  ];
  const UNDECIDED = [
    ['shaping', /\b(shap(?:ing|ewear)|cellulite|butt lift|tummy control)\b/i, 'Shaping or cellulite leggings'],
    ['socks', /\brunning socks?\b/i, 'Running socks'],
    ['homegym', /\b(home gym|dumbbells?|kettlebells?|resistance bands?|pull ?up bar|ab roller|weight plates?)\b/i, 'Home gym gear'],
    ['petfood', /\b(dog|cat|pet) (?:food|treats?|snacks?|chews?)\b/i, 'Pet food'],
    ['nose', /\b(nose|nasal) (?:strips?|sprays?|dilators?)\b|\bnasal strips?\b/i, 'Nose strips or sprays'],
  ];
  // The checklist every sheet shows, in this order (CLAUDE.md: GPSR, CE, WEEE and battery rules, cosmetics rules, medical
  // claims, brand dupes and return risk from sizing). The radar keys that feed each.
  const CHECKS = [
    { k: 'gpsr', label: 'GPSR (EU)', keys: [], eu: true },
    { k: 'ce', label: 'CE (EMC, RoHS, LVD)', keys: ['ce'] },
    { k: 'weee', label: 'WEEE registration', keys: ['ce'] },
    { k: 'battery', label: 'Battery rules (UN38.3, EU 2023/1542)', keys: ['battery'] },
    { k: 'radio', label: 'Radio (RED)', keys: ['radio'] },
    { k: 'cosmetics', label: 'Cosmetics rules (CPNP)', keys: ['cosmetics'] },
    { k: 'medical', label: 'Medical claims and devices', keys: ['medical', 'device', 'pseudo', 'claims'] },
    { k: 'brand', label: 'Brand dupes and trademark', keys: ['brand', 'tm'] },
    { k: 'kids', label: 'Toys and children (EN 71)', keys: ['kids'] },
    { k: 'food', label: 'Food contact', keys: ['food', 'bamboo'] },
    { k: 'other', label: 'Other restricted (weapons, biocides, adult, CBD, pet medicine)', keys: ['weapon', 'regulated', 'adult', 'biocide', 'pet_med', 'eat', 'pet_eat', 'blade', 'ship'] },
    { k: 'returns', label: 'Return risk (sizes, fragile, bulky)', keys: ['sizing', 'fragile', 'bulky', 'ioss'] },
  ];
  // Market-specific stops for electric and radio goods (market-rules.mjs blocker items, 31 Oct 2026).
  const MARKET_STOPS = {
    AU: { keys: ['ce'], text: 'Mains-powered goods: the EESS responsible supplier must be an Australian or NZ entity (phone-type chargers count)', source: 'https://www.eess.gov.au/responsible-supplier/manufacturers-and-importers-responsible-suppliers/' },
    NZ: { keys: ['ce', 'radio'], text: 'Electronics: a conformity declaration signed by an NZ supplier or an NZ agent of the seller', source: 'https://www.rsm.govt.nz/assets/Uploads/documents/compliance-guide.pdf' },
    US: { keys: ['radio', 'ce'], text: 'FCC supplier declaration (SDoC) needs a responsible party in the US', source: 'https://www.law.cornell.edu/cfr/text/47/2.1077' },
  };

  /**
   * The compliance list of one pick: { level: block | docs | ok, items: [{ k, label, status: blocker | docs | todo |
   * clear | n/a, text, ask }], main: the main blocker in a few words, excluded, undecided, markets: per-market stops,
   * radar: the radar's own answer }. status: blocker (do not sell it as it is), docs (papers from the supplier first),
   * todo (a check every product needs, not done yet), clear (nothing found), n/a.
   */
  function complianceOf(pick, markets) {
    const p = pick || {};
    const name = `${p.name || ''} ${p.product_url || ''}`;
    let radar = null;
    if (R && typeof R.verdict === 'function') {
      const x = { source: p.source === 'tiktok' ? 'tiktok' : p.source === 'world' ? 'world' : 'eu', id: String(p.id || ''), title: String(p.name || ''), product: https(p.product_url), store: https(p.store_url),
        shop: String(p.shop || ''), copy: String(p.ad_text || ''), p: p.jev && p.jev.p && typeof p.jev.p === 'object' ? p.jev.p : null, yesno: !!(p.jev && p.jev.yesno),
        main: p.category ? String(p.category.main || '') : '', sub: p.category ? String(p.category.sub || '') : '', price: p.price, cur: p.cur || '' };
      if (!x.p && Array.isArray(p.risks) && p.risks.length && typeof R.fromFacts === 'function') {
        const f = R.fromFacts({ source: x.source, id: x.id, title: x.title, product: x.product, store: x.store, risks: p.risks, jev: p.category ? { main: x.main, sub: x.sub } : null, price: p.price, cur: p.cur });
        x.p = f.p;
        x.yesno = true;
      }
      radar = R.verdict(x, p.check || null);
    }
    const found = new Map(); // radar key -> reason
    for (const r of radar ? radar.reasons.concat(radar.returns || []) : []) if (r.level !== 'off' && r.level !== 'done') found.set(r.k, r);
    const done = new Set((radar ? radar.reasons : []).filter((r) => r.level === 'done').map((r) => r.k));
    const items = [];
    const anyEu = markets.some((cc) => MKT[cc] && MKT[cc].eu);
    for (const c of CHECKS) {
      if (c.k === 'gpsr') {
        items.push({ k: 'gpsr', label: c.label, status: anyEu ? 'todo' : 'n/a', text: anyEu ? 'An EU responsible person (you as importer, or a paid service) on the product and its page, with the maker, a type or batch number and warnings in the buyer\'s language (EU 2023/988)' : 'Not selling in the EU', source: 'https://eur-lex.europa.eu/eli/reg/2023/988/oj' });
        continue;
      }
      const hits = c.keys.map((k) => found.get(k)).filter(Boolean);
      if (c.k === 'brand') {
        const h = hits[0];
        items.push({ k: 'brand', label: c.label, status: h ? 'blocker' : 'todo', text: h ? h.text : 'Nothing in its name: still search TMview for the name and the shop before you sell', source: radar && radar.tm && radar.tm.url ? radar.tm.url : 'https://www.tmdn.org/tmview/' });
        continue;
      }
      if (c.k === 'weee') {
        const h = found.get('ce');
        items.push({ k: 'weee', label: c.label, status: h ? 'docs' : 'clear', text: h ? 'Electric or electronic: register as a producer for WEEE in each EU country you sell to (NL: Stichting OPEN) before the first sale' : 'Not electric', source: 'https://www.stichting-open.org/' });
        continue;
      }
      if (!hits.length) {
        items.push({ k: c.k, label: c.label, status: done.size && c.keys.some((k) => done.has(k)) ? 'clear' : 'clear', text: c.k === 'returns' ? 'No size, fragile or bulky flag' : 'Nothing found in its name, link or Jev\'s answers' });
        continue;
      }
      const blocker = hits.find((h) => h.level === 'block');
      const status = blocker ? 'blocker' : c.k === 'returns' ? 'risk' : 'docs';
      items.push({ k: c.k, label: c.label, status, text: (blocker || hits[0]).text + (hits.length > 1 ? ` (+${hits.length - 1} more)` : ''), hits: hits.map((h) => h.k) });
    }
    const flags = new Set([...(p.jev && Array.isArray(p.jev.flags) ? p.jev.flags : []), ...(Array.isArray(p.risks) ? p.risks.map((r) => r && r.k) : [])].filter(Boolean));
    const undecided = UNDECIDED.filter(([, re]) => re.test(name)).map(([k, , text]) => ({ k, text: `${text}: Connor has not decided on this category` }));
    if ((found.has('pet_eat') || flags.has('animals')) && !undecided.some((u) => u.k === 'petfood')) undecided.push({ k: 'petfood', text: 'Pet food or something pets take: Connor has not decided on this category' });
    const excluded = [];
    if (found.has('eat') || flags.has('people')) excluded.push({ k: 'eat', text: 'People eat or take it (supplements, food and drink): off the board (Connor\'s rule)' });
    const shaping = undecided.some((u) => u.k === 'shaping');
    if (!shaping && (flags.has('gymwear') || EXCLUDED.some(([, re]) => re.test(name)))) excluded.push({ k: 'gymwear', text: 'Gymwear: off the board (Connor\'s rule)' });
    const stops = [];
    for (const cc of markets) {
      const st = MARKET_STOPS[cc];
      if (st && st.keys.some((k) => found.has(k))) stops.push({ cc, text: st.text, source: st.source });
    }
    const radarLevel = radar ? radar.level : 'ok';
    const level = radarLevel === 'block' || excluded.length ? 'block' : radarLevel === 'docs' || items.some((i) => i.status === 'docs') ? 'docs' : 'ok';
    // The main blocker in a few words (the digest's line): a block first, then the papers, then a market stop.
    const blockers = items.filter((i) => i.status === 'blocker');
    const docs = items.filter((i) => i.status === 'docs');
    const label = (i) => i.label.split(' (')[0];
    let main;
    if (excluded.length) main = `Block: ${excluded[0].k === 'eat' ? 'people eat or take it' : 'gymwear'} (off the board)`;
    else if (blockers.length) main = `Block: ${blockers.map(label).join(', ')}`;
    else if (docs.length) main = `Docs: ${docs.map(label).join(', ')}`;
    else if (stops.length) main = `${stops[0].cc}: ${stops[0].text.split(':')[0]}`;
    else main = 'No blocker found';
    if (!excluded.length && !blockers.length && undecided.length) main += ` · flag: ${undecided[0].text.split(':')[0]}`;
    const returns = items.find((i) => i.k === 'returns' && i.status === 'risk');
    if (!excluded.length && !blockers.length && returns) main += ` · ↩ ${(returns.hits || []).map((h) => ({ sizing: 'sizes', fragile: 'fragile', bulky: 'bulky', ioss: 'over €150' })[h] || h).join(', ')}`;
    return { level, items, main, excluded, undecided, stops, ask: radar ? radar.ask : [], pay: radar ? radar.pay : '', radar: radar ? { level: radar.level, auto: radar.auto, jev: !!radar.jev, reasons: radar.reasons.map((r) => ({ k: r.k, level: r.level, short: r.short })) } : null };
  }

  // ---- Supplier path ----------------------------------------------------------------------------------------------
  /** Kungfubuy's offer id of a 1688 link, for matching a quote: '1005491662212'. */
  const offerId = (u) => (/1688\.com\/offer\/(\d{6,20})\.html/.exec(String(u || '')) || [])[1] || '';

  /**
   * The quote for a pick: one of `quotes` (rows of Kungfubuy's quotation export, shaped by the CLI: { id, day, offer,
   * asked, sku, spec, country, goods_cny, weight_g, eur: [1..5 units] }) whose 1688 offer id or asked link matches the
   * pick's supplier link, its product link or its own quote id. Else null.
   */
  function quoteFor(pick, quotes) {
    if (!Array.isArray(quotes) || !quotes.length) return null;
    const p = pick || {};
    const sup = (p.supplier && p.supplier.url) || '';
    const ids = new Set([offerId(sup), offerId(p.product_url)].filter(Boolean));
    const want = (p.supplier && p.supplier.quote_id) || p.quote_id || '';
    const hit = quotes.filter((q) => (want && q.id === want) || (q.offer && ids.has(q.offer)) || (q.asked && ids.has(offerId(q.asked))) || (q.asked && p.product_url && q.asked === p.product_url));
    return hit.length ? hit.sort((a, b) => (a.day < b.day ? 1 : -1))[0] : null;
  }

  /** The supplier path: where the cost comes from, what to paste, where to search, the gates to pass. */
  function supplierOf(pick, econ, comp, quote, s) {
    const p = pick || {};
    const sup = p.supplier && typeof p.supplier === 'object' ? p.supplier : {};
    const main = econ.markets[0];
    const status = quote ? 'quote' : sup.url || sup.cost ? 'link' : 'none';
    const links = {};
    if (S && typeof S.searchLinks === 'function') {
      try {
        for (const l of S.searchLinks({ title: p.name, img: https(p.img) }, p.zh || '') || []) if (l.k !== 'photo') links[l.label || l.k] = l.url;
      } catch (e) {
        // the search links are a convenience: none is no problem
      }
    }
    if (!Object.keys(links).length) {
      const q = encodeURIComponent(clean(p.name, 80));
      links['1688'] = `https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=${encodeURIComponent(p.zh || clean(p.name, 80))}`;
      links.AliExpress = `https://www.aliexpress.com/wholesale?SearchText=${q}`;
      links.Alibaba = `https://www.alibaba.com/trade/search?SearchText=${q}`;
      if (https(p.img)) links['Google Lens'] = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(https(p.img))}`;
    }
    const d = main ? main.days : null;
    const typical = d ? (d.median != null ? d.median : d.high) : null;
    const gates = [
      { k: 'samples', label: 'Samples before stock', status: 'open', text: 'Order 1–2 samples through Kungfubuy first (about €13 and 7–13 days each, earlier quotes)' },
      { k: 'certs', label: 'Certificates', status: comp.level === 'docs' ? 'open' : comp.level === 'block' ? 'fail' : 'pass', text: comp.level === 'docs' ? 'Ask for: ' + (comp.ask || []).map((a) => a[0]).slice(0, 4).join('; ') : comp.level === 'block' ? 'Blocked: no certificate makes it sellable as it is' : 'None needed beyond the label' },
      { k: 'delivery', label: `Delivery within ${s.max_days} days`, status: typical == null ? 'open' : typical <= s.max_days ? 'pass' : 'fail',
        text: d ? `${d.median != null ? `median ${d.median} days` : ''}${d.median != null && d.high != null ? ', ' : ''}${d.high != null ? `${d.low != null ? d.low + '–' : 'up to '}${d.high} ${d.unit}` : ''} to ${main.name} (${d.basis}); Kungfubuy says 7–13 days in total` : 'Unknown' },
      { k: 'moq', label: 'MOQ fits a test (≤ 50)', status: sup.moq == null ? 'open' : sup.moq <= 50 ? 'pass' : 'fail', text: sup.moq == null ? 'MOQ not known' : `MOQ ${sup.moq}` },
    ];
    return {
      status, quote: quote ? { id: quote.id, day: quote.day, country: quote.country, sku: quote.sku, spec: quote.spec, goods_cny: quote.goods_cny, weight_g: quote.weight_g, eur: quote.eur, link: quote.offer ? `https://detail.1688.com/offer/${quote.offer}.html` : quote.asked || '' } : null,
      url: https(sup.url) || (quote && quote.offer ? `https://detail.1688.com/offer/${quote.offer}.html` : ''),
      paste: { field: '1688 link', how: 'Paste the 1688 link (or what the 1688 app shares) on the board under 🧭 Pipeline → 1688 links, or run: node winner-hunter/validate.mjs paste <picks.json> <id> "<link or share text>"', max_cny: main && main.max_cost_cny != null ? main.max_cost_cny : null },
      search: links, gates,
      ask: 'Draft only (nothing is sent): a Kungfubuy quotation for 1–4 units to the main markets, with the line, days and whether the EU €3 + €2 are included',
    };
  }

  // ---- The validation test plan -----------------------------------------------------------------------------------
  /** P(no sale) after spending `spend` when the true CPA is `cpa`: purchases as a Poisson count, e^(−spend/cpa). */
  const pNone = (spend, cpa) => (cpa > 0 ? Math.exp(-spend / cpa) : 0);
  /** P(at least k sales) after spending `spend` at a true CPA of `cpa` (Poisson). */
  function pAtLeast(k, spend, cpa) {
    if (!(cpa > 0)) return 0;
    const lam = spend / cpa;
    let term = Math.exp(-lam);
    let below = 0;
    for (let i = 0; i < k; i++) {
      below += term;
      term *= lam / (i + 1);
    }
    return Math.max(0, 1 - below);
  }

  /**
   * A cheap test for the test market, with every rule written down before the first euro.
   *   dropship (a product a supplier has now: the board's picks): Connor's staged test of 1 Nov 2026. €20 a day, 3 statics;
   *     at €20 the CPC and CTR, at €40 a sale or enough carts, at €60 the page, at €140 keep (CPA up to break-even) or stop.
   *   preorder (made to order, no stock to ship: the 29 Oct validate-first concepts): a waitlist week, then pre-orders with a
   *     ship date the agent confirmed in writing.
   * odds: how often the €40 and €140 rules keep a product whose true CPA is half the break-even (good), at it (even) or
   * twice it (bad), purchases as a Poisson count. Dates from the sheet's day (D0).
   */
  function testPlanOf(econ, comp, pick, s, day) {
    const T = s.test;
    const m = econ.markets[0];
    const o = m && m.offers[0];
    const angles = pick && pick.audience && Array.isArray(pick.audience.angles) ? pick.audience.angles.slice(0, T.creatives).map((a) => clean(typeof a === 'string' ? a : a.hook || a.text || '', 140)).filter(Boolean) : [];
    const fix = m ? [m.min_price != null ? `green from a selling price of ${eur(m.min_price)}${m.min_price_local != null ? ` (${m.min_price_local} ${m.cur})` : ''}` : '', m.max_cost != null ? `or a supplier price up to ${eur(m.max_cost)} (¥${m.max_cost_cny})` : ''].filter(Boolean).join(' ') : '';
    if (!o || !(o.be_cpa > 0) || comp.level === 'block' || m.level === 'red') {
      const why = !o ? 'No price: no break-even CPA to test against' : comp.level === 'block' ? `Blocked: ${comp.main}`
        : o.contribution <= 0 ? `Loses money before ads in ${m.name}${fix ? `: ${fix}` : ''}` : `${m.reasons.find((r) => r.level === 'red').text} in ${m.name}: no test at this price${fix ? `; ${fix}` : ''}`;
      return { go: false, why, market: m ? m.cc : null, fix };
    }
    const be = o.be_cpa;
    const local = (x) => (m.cur !== 'EUR' && fromEur(x, m.cur) != null ? ` (${round(fromEur(x, m.cur), 2)} ${m.cur})` : '');
    const best = m.offers.reduce((a, b) => (b.contribution > a.contribution ? b : a), o);
    const d0 = isDay(day) ? day : '';
    const at = (n) => (d0 ? addDays(d0, n) : '');
    const creatives = angles.length ? angles : ['The problem, shown in the first 2 seconds', 'The product solving it, close up', 'A buyer\'s own words (a review or a comment)'];
    const before = ['A test order shows a Purchase in the pixel (Events Manager)', 'The supplier\'s quote for this market is back, with the line and the days', 'The page says only what is true: no health or cure claims, the real delivery time'];
    if (comp.items.some((i) => i.k === 'gpsr' && i.status === 'todo') && MKT[m.cc] && MKT[m.cc].eu) before.push('GPSR details on the page and the product (an EU market)');
    if (comp.level === 'docs') before.push('The documents the risk radar asks for are in (Docs)');
    const preorder = !!(pick && (pick.mode === 'preorder' || pick.made_to_order));
    if (preorder) {
      const budgetLocal = 450; // A$450 (29 Oct REPORT), shown in euros at the ECB rate
      const budget = round(toEur(budgetLocal, 'AUD'));
      return {
        go: true, mode: 'preorder', market: m.cc, market_name: m.name, be_cpa: be, be_roas: o.be_roas, budget, daily: round(budget / 7), days: 14, creatives: Math.max(3, T.creatives),
        structure: `Meta, broad Advantage+ in ${m.name}, 3–5 AI creatives. Week 1: a waitlist, no payment. Week 2: pre-orders only with a ship date the agent confirmed in writing; show the price as "from …, launching <date>"`,
        angles: creatives, before,
        gates: [
          { at: 'after 5,000 impressions', rule: 'CTR under 0.8%: stop' },
          { at: 'after 250 clicks', rule: 'Under 5% sign up for the waitlist, or 0 orders in week 2: stop' },
          { at: 'end of week 2', rule: `Keep: CTR 1.2% or more, cost per click up to A$1.50 (${eur(round(toEur(1.5, 'AUD')))}), and 15% or more sign-ups or 5 or more paid pre-orders` },
        ],
        scale: ['Keep: samples from 2 factories (€50–150), then a batch of 30–200 at the agent or made to order per sale', 'Above about 10 orders a day: a bigger batch and an Australian warehouse'],
        odds: null, source: 'research/2026-10-29-unique-products/REPORT.md (validate-first, 29 Oct 2026)',
        timeline: [
          { d: 0, day: at(0), what: 'Connor taps Launch test: waitlist page, creatives and the agent\'s ship-date question are drafted' },
          { d: 1, day: at(1), what: 'Week 1: waitlist ads live' },
          { d: 8, day: at(8), what: 'Week 2: pre-orders, only with the agent\'s ship date in writing' },
          { d: 15, day: at(15), what: 'Keep or stop by the rules above' },
        ],
      };
    }
    const cpcMax = round((be * T.cr) / 100);
    const carts = Math.max(1, Math.ceil(T.gate_cart / ((be * T.cart_share) / 100)));
    const keepSales = Math.max(1, Math.ceil(T.round / be));
    const storeCpc = round((be * T.store_cr.pct) / 100);
    const days = Math.ceil(T.round / T.daily);
    const odds = (k, spend) => ({ good: round(pAtLeast(k, spend, be / 2) * 100, 1), even: round(pAtLeast(k, spend, be) * 100, 1), bad: round(pAtLeast(k, spend, be * 2) * 100, 1) });
    const sale40 = odds(1, T.gate_cart);
    const keep = odds(keepSales, T.round);
    return {
      go: true, mode: 'dropship', market: m.cc, market_name: m.name, be_cpa: be, be_roas: o.be_roas, budget: T.round, daily: T.daily, days, creatives: T.creatives,
      structure: `1 sales campaign, 1 ad set at ${eur(T.daily)} a day, broad in ${m.name}${pick && pick.audience && pick.audience.targeting ? ' (targeting: see the audience card)' : ''}, ${T.creatives} statics; offer: 1 unit at ${eur(o.price)}${local(o.price)}, with "${best.units} for ${best.off}% off" as the upsell`,
      angles: creatives, before,
      gates: [
        { at: eur(T.gate_cpc), rule: `Stop if a click costs more than ${eur(cpcMax)}${local(cpcMax)} (break-even CPA × ${T.cr}%) or the link CTR is under ${T.ctr}%` },
        { at: eur(T.gate_cart), rule: `Stop unless there is 1 sale or ${carts} add-to-carts (a cart at most ${T.cart_share}% of the break-even CPA)` },
        { at: eur(T.gate_page), rule: `Landing-page views under ${T.lpv}% of clicks: fix the page first, don't judge the product` },
        { at: eur(T.round), rule: `Keep with ${keepSales} or more sales (CPA up to ${eur(be)}${local(be)}); else stop` },
      ],
      scale: [`Kept: budget +${T.scale_pct}% every ${T.scale_every} days while the CPA stays under ${eur(be)}; 3 new creatives a week`, `CPA under ${eur(round(be * 0.7))}: open a second market (the next row of the margin table)`],
      odds: { sale40, keep, text: `A good product (true CPA ${eur(round(be / 2))}) makes a sale by ${eur(T.gate_cart)} ${sale40.good}% of the time and is kept at ${eur(T.round)} ${keep.good}%; a break-even one ${sale40.even}% and ${keep.even}%; a losing one (CPA ${eur(round(be * 2))}) ${sale40.bad}% and ${keep.bad}%` },
      cr_note: `The CPC check assumes a ${T.cr}% conversion rate. The store's own rate was ${T.store_cr.pct}% (${T.store_cr.n}; 95% range ${T.store_cr.low}–${T.store_cr.high}%): at that rate a click may cost at most ${eur(storeCpc)}`,
      cap: `At most ${eur(T.cap_total)} across the products in one test round (the 1 Nov plan's hard cap)`,
      season: 'CPMs rise from mid-November (+27% on 20 Nov, +84% on Black Friday, Superads 2025): a test from 20 Nov to early December buys fewer clicks for the same money',
      source: 'research/2026-11-01-cheapest-test (Connor\'s staged test of 1 Nov 2026, waiting for his OK)',
      timeline: [
        { d: 0, day: at(0), what: 'Connor taps Launch test: the sheet, a Kungfubuy quote request and a sample order are drafted (nothing is sent before his OK)' },
        { d: 0, day: at(0), what: `Store page and ${T.creatives} statics from the competitor's ads and the audience card; a test order to check the pixel` },
        { d: 1, day: at(1), what: `Ads live in ${m.name}, ${eur(T.daily)} a day` },
        { d: 2, day: at(2), what: `${eur(T.gate_cart)} spent: a sale or ${carts} carts, else stop` },
        { d: days, day: at(days), what: `${eur(T.round)} spent: keep or stop` },
      ],
    };
  }

  // ---- The sheet ----------------------------------------------------------------------------------------------------
  /**
   * The sheet of one pick. opts: { day: 'YYYY-MM-DD' (D0, also which customs apply), quotes: Kungfubuy quote rows,
   * settings: overrides of DEFAULTS, links: { url: { ok, status, checked } } (a link check the CLI ran) }.
   * Never throws on a missing field: what is unknown is said, and estimated where a number is needed.
   */
  function sheetOf(pick, opts = {}) {
    const p = pick && typeof pick === 'object' ? pick : {};
    const s = Object.assign({}, DEFAULTS, opts.settings || {}, { test: Object.assign({}, DEFAULTS.test, (opts.settings && opts.settings.test) || {}) });
    const day = isDay(opts.day) ? opts.day : new Date().toISOString().slice(0, 10);
    const quote = quoteFor(p, opts.quotes);
    const markets = marketsOf(p);
    const comp = complianceOf(p, markets);
    const sizes = comp.items.some((i) => i.k === 'returns' && (i.hits || []).includes('sizing'));
    const econ = economicsOf(p, s, day, quote, sizes);
    const supplier = supplierOf(p, econ, comp, quote, s);
    const plan = testPlanOf(econ, comp, p, s, day);
    const id = clean(p.id, 120) || slug(p.name);
    const linkInfo = opts.links || {};
    const link = (url, label) => {
      const u = https(url);
      if (!u) return null;
      const c = linkInfo[u];
      return { label, url: u, ok: c ? !!c.ok : null, status: c ? c.status : null, checked: c ? c.checked : null };
    };
    const links = [link(p.product_url, 'Product page'), link(p.store_url, 'Store'), link(p.ad_url, 'Ad (Meta Ad Library)'), link(supplier.url, 'Supplier'), link(p.board_url, 'Board card')].filter(Boolean);
    const main = econ.markets[0];
    const one = main && main.offers[0];
    // The overall verdict: blocked beats everything, then the main market's money.
    const level = comp.level === 'block' ? 'red' : main ? main.level : 'amber';
    const facts = [];
    const assumptions = [];
    const put = (x, text) => (x && (x.status === 'fact') ? facts : assumptions).push(text);
    if (econ.inputs.price) put(econ.inputs.price, `Selling price ${eur(econ.inputs.price.eur)}: ${econ.inputs.price.basis} (${econ.inputs.price.status})`);
    if (econ.inputs.cost) put(econ.inputs.cost, `Supplier cost ${eur(econ.inputs.cost.eur)} a unit: ${econ.inputs.cost.basis} (${econ.inputs.cost.status})`);
    if (econ.inputs.grams) put(econ.inputs.grams, `Packed weight ${econ.inputs.grams.g} g: ${econ.inputs.grams.basis} (${econ.inputs.grams.status})`);
    if (one) assumptions.push(`Shipping ${eur(one.ship)} to ${main.name}: ${one.ship_basis} (${one.ship_status})`);
    facts.push(`VAT and import rules: ${markets.map((cc) => `${cc} ${MKT[cc].tax.pct}% (${MKT[cc].tax.status})`).join(', ')}; EU €3 duty + €2 handling fee (${EU_CUSTOMS.status})`);
    facts.push(`Payment fees: Shopify Payments NL Basic, EU cards ${PAY.eea.pct}% + €${PAY.eea.fixed}, other cards ${PAY.intl.pct}% + €${PAY.intl.fixed} (${PAY.eea.checked})`);
    facts.push(`Currency conversion ${PAY.conv.pct}% on a payment in another currency than the euro (measured on snuggro's orders, 1 Nov 2026)`);
    assumptions.push(`Refunds ${econ.refund_pct}% of orders${sizes ? ' (it needs a size)' : ''} (assumption; the store's only data, 2 of 3 paid orders refunded in May–Jul 2026, is too little to use); offers ${s.offers.map((o) => `${o.units}${o.off ? ` at −${o.off}%` : ''}`).join(', ')} (assumption)`);
    if (p.score && p.score.claims) assumptions.push('Spy-tool revenue and creator claims on the score are unverified');
    for (const l of links) if (l.ok === false) assumptions.push(`${l.label} did not open (${l.status || 'no answer'}) when checked ${l.checked || ''}`.trim());
    const notChecked = links.filter((l) => l.ok == null).map((l) => l.label);
    if (notChecked.length) assumptions.push(`Not checked yet: ${notChecked.join(', ')} (links)`);
    return {
      v: VERSION, id, key: clean(p.key, 1000), name: clean(p.name, 200) || 'Untitled product', day, source: p.source || '', level,
      product: { name: clean(p.name, 200), problem: clean((p.audience && p.audience.problem) || p.problem || '', 400), category: p.category || null, img: https(p.img) },
      score: p.score || null, audience: p.audience ? { problem: clean(p.audience.problem, 300), persona: p.audience.personas && p.audience.personas[0] ? p.audience.personas[0] : null, line: clean(p.audience.line || '', 200) } : null,
      evidence: evidenceOf(p), links, economics: econ, compliance: comp, supplier, test_plan: plan, facts, assumptions,
      fx: { as_of: FX.as_of, source: FX.source },
    };
  }

  /** What shows that it sells, as plain facts with their date (the pick's own fields; claims stay claims). */
  function evidenceOf(p) {
    const out = [];
    const add = (text, url, status = 'fact', date = '') => out.push({ text, url: https(url) || '', status, date });
    if (num(p.age_days) != null) add(`Its ads run ${num(p.age_days)} days`, p.ad_url, 'fact', p.measured || '');
    if (num(p.ads) != null) add(`${num(p.ads)} ads for this product`, p.ad_url, 'fact', p.measured || '');
    if (num(p.shop_ads) != null) add(`Its store runs ${num(p.shop_ads)} active ads`, p.store_url, 'fact', p.measured || '');
    if (num(p.best_rank) != null) add(`#${num(p.best_rank)} in its store's best sellers`, p.store_url, 'fact', p.measured || '');
    if (num(p.store_products) != null) add(`Store size: ${num(p.store_products)} products`, p.store_url, 'fact', p.measured || '');
    if (p.trust && num(p.trust.reviews) != null) add(`Trustpilot ${p.trust.score ?? '?'} from ${p.trust.reviews} reviews`, p.trust.url, 'fact', p.measured || '');
    if (num(p.sold) != null) add(`${num(p.sold)} sold on TikTok Shop (US)`, p.product_url, 'fact', p.measured || '');
    for (const e of Array.isArray(p.evidence) ? p.evidence.slice(0, 8) : []) if (e && e.text) add(clean(e.text, 200), e.url, e.status || 'unverified', e.date || '');
    return out;
  }

  // ---- What the digest and the board need --------------------------------------------------------------------------
  /** The digest fields of a sheet (ADDENDUM 2): { market, margin_eur, be_cpa_eur, be_roas, level, main_blocker, line }. */
  function digestOf(sheet) {
    const m = sheet.economics.markets[0];
    const o = m && m.offers[0];
    const guess = sheet.economics.inputs.cost && sheet.economics.inputs.cost.status !== 'fact';
    const money = o ? `${m.cc}: ${eur(o.contribution)} margin, break-even CPA ${eur(o.be_cpa)}${guess ? ' (est. supplier price)' : ''}` : 'no price yet';
    return { market: m ? m.cc : null, margin_eur: o ? o.contribution : null, be_cpa_eur: o ? o.be_cpa : null, be_roas: o ? o.be_roas : null, level: sheet.level,
      main_blocker: sheet.compliance.main, cost_status: sheet.economics.inputs.cost ? sheet.economics.inputs.cost.status : null, line: `${money} · ${sheet.compliance.main}` };
  }

  const CSV_COLS = ['id', 'name', 'day', 'level', 'market', 'price_eur', 'margin_eur', 'be_cpa_eur', 'be_roas', 'best_offer_units', 'best_offer_margin_eur', 'cost_eur', 'cost_status', 'weight_g', 'ship_eur', 'customs_eur', 'compliance', 'main_blocker', 'supplier', 'test_budget_eur', 'test_daily_eur', 'product_url'];
  /** One CSV row (the CSV_COLS) of a sheet. */
  function csvRow(sheet) {
    const m = sheet.economics.markets[0];
    const o = m && m.offers[0];
    const best = m && m.offers.length ? m.offers.reduce((a, b) => (b.contribution > a.contribution ? b : a)) : null;
    const i = sheet.economics.inputs;
    const v = {
      id: sheet.id, name: sheet.name, day: sheet.day, level: sheet.level, market: m ? m.cc : '', price_eur: o ? o.price : '', margin_eur: o ? o.contribution : '', be_cpa_eur: o ? o.be_cpa : '',
      be_roas: o && o.be_roas != null ? o.be_roas : '', best_offer_units: best ? best.units : '', best_offer_margin_eur: best ? best.contribution : '', cost_eur: i.cost ? i.cost.eur : '', cost_status: i.cost ? i.cost.status : '',
      weight_g: i.grams ? i.grams.g : '', ship_eur: o ? o.ship : '', customs_eur: o ? o.customs : '', compliance: sheet.compliance.level, main_blocker: sheet.compliance.main, supplier: sheet.supplier.status,
      test_budget_eur: sheet.test_plan.go ? sheet.test_plan.budget : '', test_daily_eur: sheet.test_plan.go ? sheet.test_plan.daily : '', product_url: (sheet.links.find((l) => l.label === 'Product page') || {}).url || '',
    };
    const esc = (x) => {
      const t = String(x ?? '');
      return /[",\n;]/.test(t) || /^[=+\-@]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; // a leading = + - @ is quoted: no formula in a spreadsheet
    };
    return CSV_COLS.map((c) => esc(v[c])).join(',');
  }

  // ---- The one-page markdown ----------------------------------------------------------------------------------------
  const STATUS = { blocker: 'Block', docs: 'Docs', todo: 'To do', clear: 'Clear', 'n/a': 'n/a', risk: 'Risk' };
  const LEVEL = { red: 'Red', amber: 'Amber', green: 'Green' };
  const mdText = (x) => String(x ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  const mdLink = (label, url) => (url ? `[${mdText(label)}](${url})` : mdText(label));

  /** The sheet as one page of markdown: the sections CLAUDE.md asks for, in its order. */
  function renderSheet(sh) {
    const L = [];
    const e = sh.economics;
    const m = e.markets[0];
    const o = m && m.offers[0];
    const dg = digestOf(sh);
    L.push(`# ${mdText(sh.name)}`, '');
    L.push(`Sheet of ${sh.day} · verdict **${LEVEL[sh.level] || sh.level}** · ${mdText(dg.line)}`, '');
    if (sh.score && (sh.score.total != null || sh.score.score != null)) L.push(`Winner score: **${sh.score.total ?? sh.score.score}**${sh.score.breakdown ? ' (' + Object.entries(sh.score.breakdown).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : ''}`, '');
    L.push('## Product and problem', '');
    L.push(`- ${mdText(sh.product.name)}${sh.product.category ? ` (${mdText([sh.product.category.main, sh.product.category.sub].filter(Boolean).join(' › '))})` : ''}`);
    L.push(`- Problem it solves: ${mdText(sh.product.problem || (sh.audience && sh.audience.problem) || 'not filled in yet (the audience card adds it)')}`);
    if (sh.audience && sh.audience.persona) {
      const pe = sh.audience.persona;
      L.push(`- Buyer: ${mdText([pe.age, pe.gender, Array.isArray(pe.countries) ? pe.countries.join('/') : pe.countries, pe.situation].filter(Boolean).join(', '))}`);
    }
    L.push('', '## Evidence that it sells', '');
    if (sh.evidence.length) for (const x of sh.evidence) L.push(`- ${mdLink(x.text, x.url)}${x.date ? ` (${x.date})` : ''}${x.status !== 'fact' ? ` *(${x.status})*` : ''}`);
    else L.push('- None on this pick yet');
    L.push('', '## Links', '');
    for (const l of sh.links) L.push(`- ${mdLink(l.label, l.url)}: ${l.ok == null ? 'not checked' : l.ok ? `opens (${l.status}, ${l.checked})` : `**did not open** (${l.status || 'no answer'}, ${l.checked})`}`);
    if (!sh.links.length) L.push('- No links on this pick');
    L.push('', '## Margin per offer and break-even CPA', '');
    if (o) {
      L.push(`One order of 1 unit in ${m.name}, line by line: price ${eur(o.price)}${o.local != null && m.cur !== 'EUR' ? ` (${o.local} ${m.cur})` : ''} − VAT ${eur(o.vat)} (${o.vat_pct}%, ${o.vat_how}) − fees ${eur(o.fees)} (${o.fee_text}) − refunds ${eur(o.refunds)} (${o.refund_pct}%) − product ${eur(o.product)} − shipping ${eur(o.ship)} − import ${eur(o.customs + o.ddp_tax)} = **${eur(o.contribution)}** before ads.`, '');
      L.push(`Offers in ${m.name}:`, '', '| Offer | Price | Margin | Break-even CPA | Break-even ROAS | Profit at ROAS ' + DEFAULTS.target_roas + ' |', '|---|---:|---:|---:|---:|---:|');
      for (const x of m.offers) L.push(`| ${x.units} unit${x.units > 1 ? 's' : ''}${x.off ? ` (−${x.off}%)` : ''} | ${eur(x.price)} | ${eur(x.contribution)} | ${eur(x.be_cpa)} | ${times(x.be_roas)} | ${eur(x.profit_at_target)} |`);
      const others = e.markets.slice(1);
      if (others.length) {
        L.push('', 'Other markets, 1 unit:', '', '| Market | Price | Margin | Break-even CPA | Break-even ROAS | Verdict | Why |', '|---|---:|---:|---:|---:|---|---|');
        for (const mk of others) {
          const x = mk.offers[0];
          L.push(x ? `| ${mk.cc} | ${eur(x.price)} | ${eur(x.contribution)} | ${eur(x.be_cpa)} | ${times(x.be_roas)} | ${LEVEL[mk.level]} | ${mdText(mk.reasons[0].text)} |` : `| ${mk.cc} | – | – | – | – | – | ${mdText(mk.reasons[0].text)} |`);
        }
      }
      L.push('', `Verdict in ${m.name}: **${LEVEL[m.level]}** (${m.reasons.map((r) => mdText(r.text)).join('; ')}).`);
      const fixes = [m.min_price != null ? `green (break-even ROAS ${DEFAULTS.green_roas}×) from a selling price of ${eur(m.min_price)}${m.min_price_local != null ? ` (${m.min_price_local} ${m.cur})` : ''}` : `no selling price makes it green here`,
        m.max_cost != null ? `at this price, a supplier price up to ${eur(m.max_cost)} (¥${m.max_cost_cny}) is green` : 'no supplier price makes it green at this price'];
      L.push(`It turns ${fixes.join('; ')}.`);
      if (m.before_registration != null) L.push(`Below the ${m.tax.pct}% registration threshold (${mdText(m.tax.limit.split(';')[0])}) you keep the tax: ${eur(m.before_registration)} an order in the test phase.`);
    } else L.push('No price known yet: no margin. Add the competitor\'s price or your own.');
    L.push('', '## Landed cost and shipping', '');
    if (o) {
      L.push(`- Product ${eur(o.product)}: ${mdText(e.inputs.cost.basis)} (${e.inputs.cost.status})`);
      L.push(`- Weight ${e.inputs.grams.g} g: ${mdText(e.inputs.grams.basis)} (${e.inputs.grams.status})`);
      L.push(`- Shipping ${eur(o.ship)}: ${mdText(o.ship_basis)} (${o.ship_status})`);
      for (const c of o.customs_parts) L.push(`- ${mdText(c.text)}: ${eur(c.eur)}`);
      if (o.ddp_tax) L.push(`- Import tax on a DDP line: ${eur(o.ddp_tax)}`);
      const d = m.days;
      L.push(`- Delivery to ${m.name}: ${d.median != null ? `median ${d.median} days, ` : ''}${d.low != null ? d.low : 'up to'}${d.low != null ? '–' : ' '}${d.high} ${d.unit} (${mdText(d.basis)}${d.source ? ', ' + mdLink('source', d.source) : ''}); Kungfubuy says 7–13 days in total`);
    }
    L.push('', '## Compliance and IP', '');
    L.push(`Risk radar: **${sh.compliance.level === 'block' ? 'Block' : sh.compliance.level === 'docs' ? 'Docs' : 'OK'}**${sh.compliance.pay ? ` (Shopify Payments: ${sh.compliance.pay})` : ''}${sh.compliance.radar && !sh.compliance.radar.jev ? '. Jev has not read it: words in its name and link only' : ''}`, '');
    L.push('| Check | Status | Why |', '|---|---|---|');
    for (const i of sh.compliance.items) L.push(`| ${mdText(i.label)} | ${STATUS[i.status] || i.status} | ${i.source ? mdLink(i.text, i.source) : mdText(i.text)} |`);
    for (const x of sh.compliance.excluded) L.push(`| Board exclusion | Block | ${mdText(x.text)} |`);
    for (const x of sh.compliance.undecided) L.push(`| Undecided category | Flag | ${mdText(x.text)} |`);
    for (const x of sh.compliance.stops) L.push(`| ${x.cc} market | Block | ${mdLink(x.text, x.source)} |`);
    if (sh.compliance.ask && sh.compliance.ask.length) L.push('', `Ask the supplier for: ${sh.compliance.ask.map((a) => mdText(a[0])).join('; ')}.`);
    L.push('', '## Supplier path', '');
    const sp = sh.supplier;
    if (sp.quote) L.push(`- Kungfubuy quote ${sp.quote.id} (${sp.quote.day}, ${mdText(sp.quote.country)}): ${sp.quote.eur.filter((x) => x > 0).map((x, i) => `${i + 1} unit${i ? 's' : ''} ${eur(x)}`).join(', ')}; goods ¥${sp.quote.goods_cny}, ${sp.quote.weight_g} g${sp.quote.link ? ` · ${mdLink('1688 listing', sp.quote.link)}` : ''}`);
    else if (sp.url) L.push(`- Supplier link: ${mdLink(sp.url, sp.url)}`);
    else L.push('- No supplier yet.');
    L.push(`- **1688 link: ______** ${mdText(sp.paste.how)}${sp.paste.max_cny != null ? `. Look for a price up to ¥${sp.paste.max_cny} (green in ${m.name}).` : ''}`);
    const search = Object.entries(sp.search).map(([k, u]) => mdLink(k, u)).join(' · ');
    if (search) L.push(`- Search: ${search}`);
    for (const g of sp.gates) L.push(`- ${g.status === 'pass' ? '✓' : g.status === 'fail' ? '✗' : '○'} ${mdText(g.label)}: ${mdText(g.text)}`);
    L.push(`- ${mdText(sp.ask)}`);
    L.push('', '## Validation test plan', '');
    const tp = sh.test_plan;
    if (tp.go) {
      L.push(`${tp.mode === 'preorder' ? 'Pre-order test' : 'Dropship test'} in ${tp.market_name}: budget **${eur(tp.budget)}** (${eur(tp.daily)} a day, about ${tp.days} days), ${tp.creatives} creatives, against a break-even CPA of ${eur(tp.be_cpa)} (ROAS ${times(tp.be_roas)}). Rules from ${mdText(tp.source)}.`, '');
      L.push(`- Set-up: ${mdText(tp.structure)}`);
      L.push(`- Creatives: ${tp.angles.map((a, i) => `${i + 1}. ${mdText(a)}`).join(' ')}`);
      L.push(`- Before the first euro: ${tp.before.map(mdText).join('; ')}`);
      L.push('', '| Spent | Rule |', '|---|---|');
      for (const g of tp.gates) L.push(`| ${mdText(g.at)} | ${mdText(g.rule)} |`);
      L.push('');
      L.push(`- Scale: ${tp.scale.map(mdText).join('; ')}`);
      if (tp.odds) L.push(`- Odds: ${mdText(tp.odds.text)}`);
      if (tp.cr_note) L.push(`- ${mdText(tp.cr_note)}`);
      if (tp.cap) L.push(`- ${mdText(tp.cap)}`);
      if (tp.season) L.push(`- ${mdText(tp.season)}`);
      L.push(`- Timeline: ${tp.timeline.map((t) => `D${t.d}${t.day ? ` (${t.day})` : ''} ${mdText(t.what)}`).join('; ')}`);
    } else L.push(`- No test: ${mdText(tp.why)}`);
    L.push('', '## Blockers and the reason not to do it', '');
    const nos = [];
    for (const i of sh.compliance.items) if (i.status === 'blocker') nos.push(`${i.label}: ${i.text}`);
    for (const x of sh.compliance.excluded) nos.push(x.text);
    for (const x of sh.compliance.stops) nos.push(`${x.cc}: ${x.text}`);
    for (const mk of e.markets) for (const r of mk.reasons) if (r.level === 'red') nos.push(`${mk.cc}: ${r.text}`);
    for (const x of sh.compliance.undecided) nos.push(x.text);
    if (e.inputs.cost && e.inputs.cost.status === 'guess') nos.push('The supplier price is a guess until a 1688 link or a quote is in: the margin can be off either way');
    if (!nos.length) nos.push('No blocker found. The open points are the To do and Docs rows above.');
    for (const n of nos.slice(0, 8)) L.push(`- ${mdText(n)}`);
    L.push('', '## Facts and assumptions', '');
    L.push('Facts (sourced):');
    for (const f of sh.facts) L.push(`- ${mdText(f)}`);
    L.push('', 'Estimates, guesses and assumptions:');
    for (const a of sh.assumptions) L.push(`- ${mdText(a)}`);
    L.push('', `FX: ECB euro reference rates of ${sh.fx.as_of}. Made by winner-hunter/worker/src/validate.mjs v${sh.v}.`);
    return L.join('\n') + '\n';
  }

  return { VERSION, FX, PAY, LINES, LIST, LIST_AT, OBSERVED, AGENT, EU_CUSTOMS, MARKETS: MKT, MARKET_ORDER, DEFAULTS, CHECKS, CSV_COLS, toEur, fromEur, priceOf, marketOf, shipOf, daysOf, customsOf, orderOf, levelOf,
    inputsOf, marketsOf, economicsOf, complianceOf, quoteFor, offerId, supplierOf, testPlanOf, pNone, pAtLeast, sheetOf, evidenceOf, digestOf, csvRow, renderSheet, slug };
}

import { riskKit } from './risk.mjs';
import { sourcingKit } from './sourcing.mjs';

/** The kit with the board's own risk radar and sourcing kit: what the Worker and the CLI (validate.mjs) use. */
export const VALIDATE = validateKit(riskKit(), sourcingKit());
export const { sheetOf, renderSheet, digestOf, csvRow, CSV_COLS, MARKETS, DEFAULTS, FX, orderOf, shipOf, customsOf, marketOf, quoteFor, testPlanOf, complianceOf, pAtLeast } = VALIDATE;
/** GET /validate.js: the kit's source, run once in the board as window.VALIDATE, after /risk.js and /sourcing.js. */
export const VALIDATE_JS = `'use strict';\nwindow.VALIDATE = (${validateKit})(window.RISK, window.SOURCING);\n`;
