/*
 * Untapped markets outside the EU. The products on the board are proven by their EU (and UK) reach; the question is
 * where their shop's ads do NOT aim yet. Meta's Ad Library API only shows shop ads that ran in the EU or UK (asking it
 * for New Zealand returns the same EU/UK ads, none aimed at New Zealand: tested 2026-10-28), but every ad it returns
 * says exactly where it is aimed: target_locations ("Worldwide", "Europe", "Netherlands", "Florence, Italy", …).
 * So "open" means: none of the shop's ads that Meta shows aim there. A campaign that runs only outside the EU and UK
 * stays invisible, which is why the board offers a check of that market in the Ad Library itself.
 * markets.mjs stores each shop's distinct targeting; the board turns it into markets here, at read time, so a change
 * to the lists below applies at once.
 */

// Wealthy markets outside the EU (agreed 2026-10-25: all of them, not the poorer ones such as India or Pakistan).
// The order is the order on the cards: the biggest English-speaking markets first.
export const FOCUS = ['US', 'GB', 'CA', 'AU', 'NZ', 'CH', 'NO', 'IS', 'SG', 'HK', 'JP', 'KR', 'IL', 'AE', 'SA', 'QA', 'KW'];
const ALL = '*'; // every focus market (the shop's ads aim worldwide)
const UNSURE = '?'; // can't tell (an unknown country group, or more ads than were read)
// The 27 EU countries (Meta's codes).
export const EU = 'AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' ');

// Meta's English names for these countries (and the other names it uses for some).
const NAMES = new Map(Object.entries({
  'united states': 'US', 'united states of america': 'US', usa: 'US', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB',
  canada: 'CA', australia: 'AU', 'new zealand': 'NZ', switzerland: 'CH', norway: 'NO', iceland: 'IS', singapore: 'SG',
  'hong kong': 'HK', 'hong kong sar': 'HK', japan: 'JP', 'south korea': 'KR', korea: 'KR', 'republic of korea': 'KR',
  israel: 'IL', 'united arab emirates': 'AE', uae: 'AE', 'saudi arabia': 'SA', qatar: 'QA', kuwait: 'KW',
}));

// Meta's country groups and the focus markets in them. A group not listed here makes the shop "can't tell" (never
// "worldwide", never "open"), and markets.mjs logs its name so it can be added.
const ASIA = ['SG', 'HK', 'JP', 'KR', 'IL', 'AE', 'SA', 'QA', 'KW'];
const GULF = ['AE', 'SA', 'QA', 'KW'];
const GROUPS = new Map(Object.entries({
  worldwide: ALL,
  europe: ['GB', 'CH', 'NO', 'IS'],
  'european union': [],
  'european economic area': ['NO', 'IS'],
  'european economic area (eea)': ['NO', 'IS'], // seen 2026-10-28
  eea: ['NO', 'IS'],
  'euro area': [], // the euro countries: all in the EU (seen 2026-10-28)
  eurozone: [],
  'schengen area': ['CH', 'NO', 'IS'],
  'nordic countries': ['NO', 'IS'],
  nordics: ['NO', 'IS'],
  scandinavia: ['NO', 'IS'],
  'north america': ['US', 'CA'],
  nafta: ['US', 'CA'],
  oceania: ['AU', 'NZ'],
  'australia and new zealand': ['AU', 'NZ'],
  asia: ASIA,
  'asia pacific': ['AU', 'NZ', 'SG', 'HK', 'JP', 'KR'],
  apac: ['AU', 'NZ', 'SG', 'HK', 'JP', 'KR'],
  'asia-pacific economic cooperation': ['US', 'CA', 'AU', 'NZ', 'SG', 'HK', 'JP', 'KR'],
  apec: ['US', 'CA', 'AU', 'NZ', 'SG', 'HK', 'JP', 'KR'],
  'middle east': ['IL', ...GULF],
  'middle east and north africa': ['IL', ...GULF],
  mena: ['IL', ...GULF],
  'gulf cooperation council': GULF,
  gcc: GULF,
  emea: ['GB', 'CH', 'NO', 'IS', 'IL', ...GULF],
  'europe, middle east and africa': ['GB', 'CH', 'NO', 'IS', 'IL', ...GULF],
  'association of southeast asian nations': ['SG'],
  asean: ['SG'],
  'southeast asia': ['SG'],
  'south asia': [],
  africa: [],
  'south america': [],
  'central america': [],
  caribbean: [],
  'latin america': [],
  latam: [],
}));

/** The focus market a location is in ("New Zealand", "Auckland, New Zealand", "Ontario, Canada"), or ''. */
function marketOf(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  if (NAMES.has(n)) return NAMES.get(n);
  const tail = n.split(',').pop().trim(); // a city or region: its country comes last
  return NAMES.get(tail) || '';
}

// One location as stored: [name, type, excluded 0/1]; Meta's own objects are taken too.
const parts = (l) => (Array.isArray(l) ? [l[0], l[1], l[2]] : l ? [l.name, l.type, l.excluded] : []);

/**
 * The focus markets one ad's target_locations aim at: a Set of codes. Excluded countries are taken out ("Worldwide"
 * without New Zealand leaves New Zealand open). unknown (optional Set) collects country groups not in GROUPS.
 */
export function aimedAt(locations, unknown = null, info = null) {
  const out = new Set();
  const minus = new Set();
  for (const l of Array.isArray(locations) ? locations : []) {
    const [name, type, excluded] = parts(l);
    if (!name) continue;
    const kind = String(type || '').toLowerCase();
    const key = String(name).trim().toLowerCase();
    const group = kind === 'country_groups' || kind === 'country_group';
    if (group && !GROUPS.has(key)) { // included or excluded: can't tell what it means
      if (unknown) unknown.add(String(name).trim());
      if (excluded && info) info.unsure = true; // "Worldwide without <unknown>": the markets it aims at are unclear
      continue;
    }
    if (excluded) {
      // "Worldwide without Asia" leaves Asia's markets open; a city or region left out does not open its country.
      if (group) {
        const g = GROUPS.get(key);
        for (const cc of g === ALL ? FOCUS : g) minus.add(cc);
      } else if (NAMES.has(key)) minus.add(NAMES.get(key));
      continue;
    }
    if (group) {
      const g = GROUPS.get(key);
      for (const cc of g === ALL ? FOCUS : g) out.add(cc);
      continue;
    }
    const cc = marketOf(name);
    if (cc) out.add(cc);
  }
  for (const cc of minus) out.delete(cc);
  return out;
}

/** An ad's target_locations as stored: [[name, type, excluded 0/1], …], sorted, so equal targetings compare equal. */
export function compactAims(locations) {
  return (Array.isArray(locations) ? locations : []).filter((l) => l && l.name)
    .map((l) => [String(l.name).slice(0, 80), String(l.type || '').slice(0, 24), l.excluded ? 1 : 0])
    .sort((a, b) => (a.join('|') < b.join('|') ? -1 : a.join('|') > b.join('|') ? 1 : 0));
}

/**
 * A shop's markets from its ads' distinct targetings (aims: [[[name, type, excluded], …], …]): '*' when its ads aim at
 * every focus market, '?' when an unknown country group leaves it unclear, else the codes in FOCUS order ('' = none).
 * unknown (optional Set) collects the unknown group names.
 */
export function coverOf(aims, unknown = null) {
  const cover = new Set();
  const odd = unknown || new Set();
  const before = odd.size;
  let unsure = false;
  for (const one of Array.isArray(aims) ? aims : []) {
    const info = {};
    const got = aimedAt(one, odd, info);
    if (info.unsure) { unsure = true; continue; } // an unknown place left out: this ad proves nothing
    for (const cc of got) cover.add(cc);
  }
  if (FOCUS.every((cc) => cover.has(cc))) return ALL; // worldwide somewhere: sure, whatever else is unclear
  if (unsure || odd.size > before) return UNSURE;
  return FOCUS.filter((cc) => cover.has(cc)).join(',');
}

/** The focus markets a shop's ads leave open, in FOCUS order; null when not checked yet or can't tell. */
export function untappedOf(covered) {
  if (covered == null || covered === UNSURE) return null;
  const s = String(covered);
  if (s === ALL) return [];
  const have = new Set(s.split(',').filter(Boolean));
  return FOCUS.filter((cc) => !have.has(cc));
}
