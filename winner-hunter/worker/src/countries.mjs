// Target markets outside the EU for the 🧭 Pipeline (pipeline.mjs): what matters per country when you source and launch
// there. General research, not legal or tax advice: every item says how far it was checked (fact, estimate or
// unverified) and where it comes from, as market-rules.mjs does. Check again before you rely on one.
//   - Tax, customs, safety, labels, claims, returns, pricing and blockers: market-rules.mjs where it has the country
//     (17 markets, researched 2026-10-31); for the countries it does not have yet, EXTRA_RULES below.
//   - Currency, language, plug and voltage (IEC World Plugs) and a shipping range from China, below.
// Add a country: one line in COUNTRIES (and its rules in EXTRA_RULES when market-rules.mjs has none), then switch it on
// under Pipeline → Countries on the board (docs/pipeline/README.md).
import { MARKET_RULES } from './market-rules.mjs';

export const AS_OF = '2026-11-01';
const IEC = 'https://www.iec.ch/world-plugs';
const YUN = 'https://www.yunexpress.com/our-solutions/b2c/33'; // YunExpress's own table (Standard Express)
const YUN3 = 'https://carriers.aftership.com/yunexpress'; // YunExpress lines as a tracking site lists them (third party)

// The default list, in the order the board shows it. Settings on the board can change it (any country of COUNTRIES).
export const DEFAULT_MARKETS = ['US', 'GB', 'CA', 'AU', 'NZ', 'CH', 'NO', 'AE', 'SA', 'SG', 'MY', 'JP', 'KR', 'IL', 'ZA', 'MX', 'BR', 'CL', 'TR'];

/**
 * One country: name (English, and Chinese for the agent texts), currency, language, plug types and voltage, and the
 * shipping range from China [min, max, status, line, source] in business days. status 'estimate': a carrier's published
 * table; 'unverified': a rough range for a tracked line, from no table: ask your agent for the line's own days.
 */
export const COUNTRIES = {
  US: { name: 'United States', zh: '美国', cur: 'USD', lang: 'English', plug: 'A, B', volt: '120 V, 60 Hz', ship: [5, 8, 'estimate', 'YunExpress Standard Express', YUN] },
  GB: { name: 'United Kingdom', zh: '英国', cur: 'GBP', lang: 'English', plug: 'G', volt: '230 V, 50 Hz', ship: [3, 5, 'estimate', 'YunExpress Standard Express', YUN] },
  CA: { name: 'Canada', zh: '加拿大', cur: 'CAD', lang: 'English, French', plug: 'A, B', volt: '120 V, 60 Hz', ship: [8, 10, 'estimate', 'YunExpress Standard Express', YUN] },
  AU: { name: 'Australia', zh: '澳大利亚', cur: 'AUD', lang: 'English', plug: 'I', volt: '230 V, 50 Hz', ship: [4, 7, 'estimate', 'YunExpress Standard Express (not remote postcodes)', YUN] },
  NZ: { name: 'New Zealand', zh: '新西兰', cur: 'NZD', lang: 'English, Māori', plug: 'I', volt: '230 V, 50 Hz', ship: [7, 14, 'unverified'] },
  CH: { name: 'Switzerland', zh: '瑞士', cur: 'CHF', lang: 'German, French, Italian', plug: 'J (C fits)', volt: '230 V, 50 Hz', ship: [7, 14, 'unverified'] },
  NO: { name: 'Norway', zh: '挪威', cur: 'NOK', lang: 'Norwegian', plug: 'C, F', volt: '230 V, 50 Hz', ship: [7, 14, 'unverified'] },
  AE: { name: 'United Arab Emirates', zh: '阿联酋', cur: 'AED', lang: 'Arabic (English widely used)', plug: 'G', volt: '230 V, 50 Hz', ship: [7, 10, 'estimate', 'YunExpress Middle East Registered DDP', YUN3] },
  SA: { name: 'Saudi Arabia', zh: '沙特阿拉伯', cur: 'SAR', lang: 'Arabic', plug: 'G', volt: '230 V, 60 Hz', ship: [7, 10, 'estimate', 'YunExpress Middle East Registered DDP', YUN3] },
  SG: { name: 'Singapore', zh: '新加坡', cur: 'SGD', lang: 'English, Malay, Mandarin, Tamil', plug: 'G', volt: '230 V, 50 Hz', ship: [5, 10, 'unverified'] },
  MY: { name: 'Malaysia', zh: '马来西亚', cur: 'MYR', lang: 'Malay (English widely used)', plug: 'G', volt: '240 V, 50 Hz', ship: [6, 12, 'unverified'] },
  JP: { name: 'Japan', zh: '日本', cur: 'JPY', lang: 'Japanese', plug: 'A, B', volt: '100 V, 50/60 Hz', ship: [3, 7, 'estimate', 'YunExpress Japan Registered Direct', YUN3] },
  KR: { name: 'South Korea', zh: '韩国', cur: 'KRW', lang: 'Korean', plug: 'C, F', volt: '220 V, 60 Hz', ship: [4, 8, 'unverified'] },
  IL: { name: 'Israel', zh: '以色列', cur: 'ILS', lang: 'Hebrew, Arabic', plug: 'H (C fits)', volt: '230 V, 50 Hz', ship: [8, 15, 'unverified'] },
  ZA: { name: 'South Africa', zh: '南非', cur: 'ZAR', lang: 'English (and 10 more)', plug: 'M, N (C fits)', volt: '230 V, 50 Hz', ship: [10, 20, 'unverified'] },
  MX: { name: 'Mexico', zh: '墨西哥', cur: 'MXN', lang: 'Spanish', plug: 'A, B', volt: '127 V, 60 Hz', ship: [10, 20, 'unverified'] },
  BR: { name: 'Brazil', zh: '巴西', cur: 'BRL', lang: 'Portuguese', plug: 'N (C fits)', volt: '127 or 220 V by state, 60 Hz', ship: [15, 30, 'unverified'] },
  CL: { name: 'Chile', zh: '智利', cur: 'CLP', lang: 'Spanish', plug: 'C, L', volt: '220 V, 50 Hz', ship: [10, 20, 'unverified'] },
  TR: { name: 'Türkiye', zh: '土耳其', cur: 'TRY', lang: 'Turkish', plug: 'C, F', volt: '230 V, 50 Hz', ship: [8, 15, 'unverified'] },
  // In market-rules.mjs too, not on the default list: switch them on under Pipeline → Countries.
  JE: { name: 'Jersey', zh: '泽西岛', cur: 'GBP', lang: 'English', plug: 'G', volt: '230 V, 50 Hz', ship: [5, 10, 'unverified'] },
  HK: { name: 'Hong Kong', zh: '香港', cur: 'HKD', lang: 'Chinese, English', plug: 'G', volt: '220 V, 50 Hz', ship: [2, 5, 'unverified'] },
  MO: { name: 'Macao', zh: '澳门', cur: 'MOP', lang: 'Chinese, Portuguese', plug: 'G (D, M in older buildings)', volt: '220 V, 50 Hz', ship: [2, 5, 'unverified'] },
  TW: { name: 'Taiwan', zh: '台湾', cur: 'TWD', lang: 'Chinese', plug: 'A, B', volt: '110 V, 60 Hz', ship: [3, 7, 'unverified'] },
  LI: { name: 'Liechtenstein', zh: '列支敦士登', cur: 'CHF', lang: 'German', plug: 'J (C fits)', volt: '230 V, 50 Hz', ship: [7, 14, 'unverified'] },
};

const item = (k, label, text, status, source) => ({ k, label, text, status, source, checked: AS_OF });
/**
 * The rules of the default countries market-rules.mjs does not have yet (researched 2026-11-01, same shape). The low-value
 * import rules of these countries changed often in 2024–2026: most items are estimates from secondary sources.
 */
export const EXTRA_RULES = {
  GB: {
    short: 'VAT 20%: up to £135 a parcel you charge it at checkout. No duty up to £135 (that relief ends by March 2029).',
    items: [
      item('tax', 'Tax', 'VAT 20%. Goods of £135 or less sent from abroad: register for UK VAT and charge it at checkout (a marketplace charges it when you sell there).', 'fact', 'https://www.gov.uk/government/publications/changes-to-vat-treatment-of-overseas-goods-sold-to-customers-from-1-january-2021/changes-to-vat-treatment-of-overseas-goods-sold-to-customers-from-1-january-2021'),
      item('customs', 'Customs', 'No customs duty on a parcel of £135 or less (excise goods aside); over £135 the buyer pays duty and import VAT at the door. The £135 duty relief ends by March 2029 at the latest (Autumn Budget 2025).', 'fact', 'https://www.gov.uk/government/consultations/reforming-the-customs-treatment-of-low-value-imports-into-the-united-kingdom'),
    ],
  },
  SA: {
    short: 'VAT 15%. No duty on a personal parcel to SAR 1,000; VAT below that is unclear. SABER certificates for regulated goods.',
    items: [
      item('tax', 'Tax', 'VAT 15% (since July 2020).', 'fact', 'https://www.pwc.com/m1/en/services/tax/me-tax-legal-news/2021/saudi-arabia-ecommerce-vat-guide-sep-2021.html'),
      item('customs', 'Customs', 'No customs duty on a personal parcel worth up to SAR 1,000. Whether the 15% VAT is still charged below that is not clear: sources disagree.', 'unverified', 'https://www.pwc.com/m1/en/services/tax/me-tax-legal-news/2021/saudi-arabia-ecommerce-vat-guide-sep-2021.html'),
      item('blocker', 'Blocker', 'Regulated products (electrical goods, toys and many more) need SASO conformity certificates in the SABER system before they clear.', 'unverified', 'https://saber.sa/'),
    ],
  },
  ZA: {
    short: 'VAT 15%. Parcels to R500: a flat 20% customs charge plus 15% VAT (since September 2024).',
    items: [
      item('tax', 'Tax', 'VAT 15%.', 'fact', 'https://www.sars.gov.za/types-of-tax/value-added-tax/'),
      item('customs', 'Customs', 'Parcels of R500 or less: a flat 20% customs charge plus 15% VAT since 1 September 2024 (clothing pays the full duty). Over R500: the normal duty and VAT. Not confirmed for 2026.', 'estimate', 'https://www.sars.gov.za/media-release/changes-to-customs-import-system/'),
    ],
  },
  MX: {
    short: 'IVA 16%. Courier parcels of China-made goods: one 33.5% rate up to USD 2,500 (since August 2025).',
    items: [
      item('tax', 'Tax', 'IVA (VAT) 16%.', 'fact', 'https://www.trade.gov/country-commercial-guides/mexico-customs-regulations'),
      item('customs', 'Customs', 'Courier parcels up to USD 2,500 from countries without a trade deal with Mexico (China included): one 33.5% global rate (duty and VAT together) since 15 August 2025. The USD 50 tax-free allowance is for US and Canadian goods.', 'estimate', 'https://globalimportblog.bakermckenzie.com/2025/07/29/mexico-increase-to-the-rates-of-duty-applicable-upon-importation-through-courier-companies/'),
    ],
  },
  BR: {
    short: 'Remessa Conforme stores: 0% import tax to USD 50 (since May 2026) plus state ICMS 17–20%; above that 60%.',
    items: [
      item('tax', 'Tax', 'State ICMS of 17–20% on every import, worked out on the value including the import tax.', 'estimate', 'https://www.dhl.com/discover/en-br/regulatory-affairs/remessa-conforme-brazil'),
      item('customs', 'Customs', 'Stores in the Remessa Conforme programme: up to USD 50, 0% import tax since 12 May 2026 (Law 15.502); USD 50–3,000: 60% with a USD 30 deduction. Stores outside it: 60%.', 'estimate', 'https://www.dhl.com/discover/en-br/regulatory-affairs/remessa-conforme-brazil'),
      item('blocker', 'Blocker', 'Products with radio (Bluetooth, Wi-Fi) and phone chargers need ANATEL approval before they are sold.', 'unverified', 'https://www.gov.br/anatel/pt-br'),
    ],
  },
  CL: {
    short: 'IVA 19% on purchases up to USD 500 (since October 2025); over USD 500 also 6% duty.',
    items: [
      item('tax', 'Tax', 'IVA (VAT) 19%. Since 25 October 2025 charged on purchases up to USD 500 from foreign stores registered with the SII; the USD 41 tax-free allowance is gone.', 'fact', 'https://www.aduana.cl/cambios-en-tus-compras-internacionales/aduana/2025-10-15/153938.html'),
      item('customs', 'Customs', 'Over USD 500: IVA plus 6% customs duty.', 'fact', 'https://www.aduana.cl/cambios-en-tus-compras-internacionales/aduana/2025-10-15/153938.html'),
    ],
  },
  TR: {
    short: 'KDV 20%. No low-value route since February 2026: full customs, reported 60% duty on goods from outside the EU.',
    items: [
      item('tax', 'Tax', 'KDV (VAT) 20%.', 'fact', 'https://taxnews.ey.com/news/2026-0158-turkiye-removes-simplified-entries-for-b2c-e-commerce-imports'),
      item('customs', 'Customs', 'Since 6 February 2026 every B2C parcel goes through full customs (the €30 simplified route is gone). Reports cite 60% duty on goods from outside the EU (30% from the EU), plus VAT.', 'estimate', 'https://taxnews.ey.com/news/2026-0158-turkiye-removes-simplified-entries-for-b2c-e-commerce-imports'),
    ],
  },
};

// The rule items that say what may not be sold, or not without papers: listed as the country's restrictions.
const RESTRICT = ['blocker', 'safety', 'claims', 'labels'];
const ORDER = ['tax', 'customs', 'pricing', 'returns', 'blocker', 'safety', 'claims', 'labels'];

/**
 * Everything the board shows for one country, or null when it is not in COUNTRIES. compliance: the hook for the compliance
 * data (restricted categories per market). When that lands on main, pipelineGet passes its list for the country here
 * ([{ k, label, text, status, source }], from deps.compliance[cc]): it is listed first under the restrictions.
 */
export function countryFacts(cc, { compliance = null } = {}) {
  const c = Object.hasOwn(COUNTRIES, cc) ? COUNTRIES[cc] : null;
  if (!c) return null;
  const rules = MARKET_RULES.markets[cc] || EXTRA_RULES[cc] || { short: '', items: [] };
  const items = rules.items.slice().sort((a, b) => ORDER.indexOf(a.k) - ORDER.indexOf(b.k));
  const [min, max, status = 'unverified', line = '', source = ''] = c.ship;
  const extra = Array.isArray(compliance) ? compliance.filter((x) => x && x.text).map((x) => ({ k: String(x.k || 'compliance'), label: String(x.label || 'Compliance'), text: String(x.text), status: x.status || 'unverified', source: x.source || '', checked: x.checked || '' })) : [];
  return {
    cc, name: c.name, zh: c.zh, cur: c.cur, lang: c.lang,
    power: { plug: c.plug, volt: c.volt, status: 'fact', source: IEC },
    ship: { min, max, unit: 'business days', status, line, source,
      text: `${min}–${max} business days${line ? ` (${line})` : ''}`, note: status === 'estimate' ? 'A carrier’s published time, not a promise: your agent adds 1–3 days to pack and send.' : 'A rough range for a tracked line, from no carrier table: ask your agent for the line’s own days.' },
    short: rules.short || '', rules_from: MARKET_RULES.markets[cc] ? 'market-rules' : EXTRA_RULES[cc] ? 'extra' : '', as_of: MARKET_RULES.markets[cc] ? MARKET_RULES.as_of : AS_OF,
    items: items.filter((i) => !RESTRICT.includes(i.k)),
    restrictions: extra.concat(items.filter((i) => RESTRICT.includes(i.k))),
  };
}

/** The countries the board can offer, in the default order first, then the rest: [{ cc, name }]. */
export const ALL_COUNTRIES = [...DEFAULT_MARKETS, ...Object.keys(COUNTRIES).filter((cc) => !DEFAULT_MARKETS.includes(cc))].map((cc) => ({ cc, name: COUNTRIES[cc].name }));
