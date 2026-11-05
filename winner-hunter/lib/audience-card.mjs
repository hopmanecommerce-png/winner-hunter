/*
 * Audience engine, stage 3: the audience card. Pure: everything it needs is passed in, so the daily job, the research
 * runs and the tests build the same card from the same data.
 *
 *   buildCard(input)    → the card (JSON, stable keys: see TEMPLATE.md in research/2026-11-05-winner-system/audience)
 *   cardMarkdown(card)  → the card as Markdown (the daily digest links to it; Connor reads it on the board)
 *   oneLine(card)       → "audience in one line" for the daily digest
 *
 * Every line on a card says where it comes from and whether it is a fact, a count, an estimate or an assumption. Hooks are
 * drafts in our own words, built from what customers say: never a customer quote presented as a review (no reviews or
 * quotes in ads until real reviews exist), never a claim, never "you" with health, age, money or body (Meta's personal-
 * attributes rule), never a competitor's name, never an em dash.
 */
import { THEMES, KINDS, tagStatement, isEnglish, themesOf, situationsOf, phrasesOf, claimsIn, hookOf, angleOf, ANGLES, pickQuotes, PERSONA } from './audience-text.mjs';
import { demographics, demoLine } from './audience-meta.mjs';
import { ownWords } from './audience-phrase.mjs';

export const CARD_VERSION = 1;
const DAY = 864e5;
const clip = (s, n) => {
  const a = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim());
  return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('');
};
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------------------------------------------------------------------------
// Markets: currency, the VAT or GST rule in one line, and a Meta CPM benchmark (third-party, see sources)
// ---------------------------------------------------------------------------
export const BENCH_SOURCE = 'Lebesgue 2026 e-commerce CPM (page updated 12 Oct 2026), CPC range Superads median Jul 2025-Jul 2026 to AdAmigo 2026; via research/2026-10-28-product-hunt/markets-and-moq.md A1 (27-28 Oct 2026). Third-party, sources disagree.';
export const MARKETS = {
  NZ: { name: 'New Zealand', currency: 'NZD', tax: 'GST 15%, collected by an overseas seller on low-value goods once NZ sales pass NZ$60k a year', cpm: 9.01, cpc: '0.92-1.60', south: true },
  AU: { name: 'Australia', currency: 'AUD', tax: 'GST 10% on goods up to A$1,000 once AU sales pass A$75k a year; no duty or GST at the border up to A$1,000', cpm: 11.63, cpc: '0.95-2.10', south: true },
  CA: { name: 'Canada', currency: 'CAD', tax: 'GST/HST; duty and tax free only up to CAD 20', cpm: 11.47, cpc: '0.90-1.75', south: false },
  UK: { name: 'United Kingdom', currency: 'GBP', tax: 'VAT 20%, registration from the first sale for non-UK sellers', cpm: 11.81, cpc: '1.18-1.95', south: false },
  US: { name: 'United States', currency: 'USD', tax: 'Sales tax per state; China tariffs 20-40%+, de minimis suspended', cpm: 16.08, cpc: '1.18-2.69', south: false },
  CH: { name: 'Switzerland', currency: 'CHF', tax: 'VAT 8.1%', cpm: 8.4, cpc: '1.10-2.40', south: false },
  NO: { name: 'Norway', currency: 'NOK', tax: 'VAT 25% (VOEC for low-value goods)', cpm: 7.31, cpc: '0.71-1.55', south: false },
  SG: { name: 'Singapore', currency: 'SGD', tax: 'GST 9% on low-value goods via OVR', cpm: 7.21, cpc: '1.00-1.80', south: false },
  AE: { name: 'United Arab Emirates', currency: 'AED', tax: 'VAT 5%; registration rules for foreign sellers unclear', cpm: 10.0, cpc: '1.08-1.40', south: false },
  NL: { name: 'Netherlands', currency: 'EUR', tax: 'BTW 21% (IOSS); EU duty EUR 3 per tariff line and EUR 2 handling per China parcel', cpm: null, cpc: '', south: false },
  DE: { name: 'Germany', currency: 'EUR', tax: 'MwSt 19% (IOSS); EU duty EUR 3 + EUR 2 per China parcel', cpm: null, cpc: '', south: false },
  BE: { name: 'Belgium', currency: 'EUR', tax: 'BTW/TVA 21% (IOSS)', cpm: null, cpc: '', south: false },
  FR: { name: 'France', currency: 'EUR', tax: 'TVA 20% (IOSS)', cpm: null, cpc: '', south: false },
  IE: { name: 'Ireland', currency: 'EUR', tax: 'VAT 23% (IOSS)', cpm: null, cpc: '', south: false },
  AT: { name: 'Austria', currency: 'EUR', tax: 'USt 20% (IOSS)', cpm: null, cpc: '', south: false },
  ES: { name: 'Spain', currency: 'EUR', tax: 'IVA 21% (IOSS)', cpm: null, cpc: '', south: false },
  IT: { name: 'Italy', currency: 'EUR', tax: 'IVA 22% (IOSS)', cpm: null, cpc: '', south: false },
  PT: { name: 'Portugal', currency: 'EUR', tax: 'IVA 23% (IOSS)', cpm: null, cpc: '', south: false },
  PL: { name: 'Poland', currency: 'PLN', tax: 'VAT 23% (IOSS)', cpm: null, cpc: '', south: false },
  SE: { name: 'Sweden', currency: 'SEK', tax: 'Moms 25% (IOSS)', cpm: null, cpc: '', south: false },
  DK: { name: 'Denmark', currency: 'DKK', tax: 'Moms 25% (IOSS)', cpm: null, cpc: '', south: false },
  FI: { name: 'Finland', currency: 'EUR', tax: 'ALV 25.5% (IOSS)', cpm: null, cpc: '', south: false },
  GB: { name: 'United Kingdom', currency: 'GBP', tax: 'VAT 20%, registration from the first sale for non-UK sellers', cpm: 11.81, cpc: '1.18-1.95', south: false },
};
export const DEFAULT_MARKETS = ['NZ', 'AU'];

// ---------------------------------------------------------------------------
// Words for the drafts
// ---------------------------------------------------------------------------
// What people use today instead of the product (the "status quo"), by the last word(s) of the search phrase.
export const STATUS_QUO = [
  [/\b(?:fountain)(?:e?s)?\b/, 'water bowl'], [/\b(?:feeder|bowl)(?:e?s)?\b/, 'food bowl'], [/\b(?:harness)(?:e?s)?\b/, 'collar'], [/\b(?:leash|lead)(?:e?s)?\b/, 'old lead'], [/\b(?:dog bed|calming)(?:e?s)?\b/, 'old dog bed'], [/\b(?:litter)(?:e?s)?\b/, 'litter tray'],
  [/\b(?:cooling mat)(?:e?s)?\b/, 'hot floor'], [/\b(?:grooming|hair remover|brush)(?:e?s)?\b/, 'lint roller'], [/\b(?:coat|jacket)(?:e?s)?\b/, 'old jacket'], [/\b(?:pillowcase)(?:e?s)?\b/, 'cotton pillowcase'], [/\b(?:neck pillow|travel)(?:e?s)?\b/, 'rolled-up jumper'],
  [/\b(?:pillow)(?:e?s)?\b/, 'flat old pillow'], [/\b(?:topper|mattress)(?:e?s)?\b/, 'tired mattress'], [/\b(?:duvet|blanket|throw)(?:e?s)?\b/, 'heavy duvet'], [/\b(?:sheet|bedding)(?:e?s)?\b/, 'standard sheet'], [/\b(?:blind|insert|curtain)(?:e?s)?\b/, 'thin curtain'],
  [/\b(?:sleep mask|eye mask)(?:e?s)?\b/, 'pillow over the face'], [/\b(?:shapewear)(?:e?s)?\b/, 'shapewear that rolls down'], [/\b(?:bra)(?:e?s)?\b/, 'underwire bra'], [/\b(?:tights)(?:e?s)?\b/, 'thin tights'], [/\b(?:slippers|socks)(?:e?s)?\b/, 'cold floor'],
  [/\b(?:shoes)(?:e?s)?\b/, 'stiff old pair'], [/\b(?:wallet|card)(?:e?s)?\b/, 'bulky wallet'], [/\b(?:bag|backpack)(?:e?s)?\b/, 'overstuffed bag'], [/\b(?:towel)(?:e?s)?\b/, 'old towel'], [/\b(?:organi[sz]er|drawer|storage)(?:e?s)?\b/, 'junk drawer'],
  [/\b(?:ornament)(?:e?s)?\b/, 'shop-bought bauble'], [/\b(?:watch band|band\b)(?:e?s)?\b/, 'stock band'], [/\b(?:paint by numbers)(?:e?s)?\b/, 'blank canvas'], [/\b(?:necklace|bracelet|earrings|jewel\w*)(?:e?s)?\b/, 'generic jewellery'], [/\b(?:strap)(?:e?s)?\b/, 'stock strap'], [/\b(?:bottle)(?:e?s)?\b/, 'plastic bottle'],
  [/\b(?:gutter)(?:e?s)?\b/, 'ladder and bucket'], [/\b(?:threader)(?:e?s)?\b/, 'squinting at the needle'], [/\b(?:vacuum storage)(?:e?s)?\b/, 'overflowing wardrobe'], [/\b(?:bread bag)(?:e?s)?\b/, 'plastic bread bag'],
];
const objectOf = (phrase) => {
  for (const [re, o] of STATUS_QUO) if (re.test(phrase)) return o;
  return '';
};
const WHO = { dog: 'dog', bigdog: 'dog', olddog: 'dog', puppy: 'puppy', cat: 'cat', multipet: 'pets', parent: 'kids', grandparent: 'grandkids', caravan: 'caravan', traveller: 'traveller' };
const RECIPIENT = { dog: 'dog lover', bigdog: 'dog lover', olddog: 'dog lover', puppy: 'new puppy owner', cat: 'cat lover', parent: 'parents', grandparent: 'grandparent', partner: 'partner',
  caravan: 'caravan lover', traveller: 'traveller', outdoors: 'camper', driver: 'car lover', hotsleeper: 'hot sleeper' };
const AUDIENCE_WHO = { 'Dog owners': 'dog', 'Cat owners': 'cat', 'Other pet owners': 'pet', Parents: 'kids', Drivers: 'car' };

/** Draft hooks per angle slot. Placeholders: {object} {who} {thing} {name} {recipient}. Each list best first. */
export const TEMPLATES = {
  pain: {
    dirty: ['The {object} that never looks clean for long.', 'Still scrubbing the {object} every day?'],
    slimy: ['Slimy {object} again?', 'Still scrubbing the {object} every day?'],
    smell: ['That smell by day two? It is the {object}.'],
    hot: ['Too hot, too sticky, every summer.'],
    cold: ['Cold nights and a {object} that never warms up.'],
    sleep: ['3am. Wide awake. Blame the {object}.'],
    pain: ['The {object} that digs in by the end of the day.'],
    mess: ['The {object} mess nobody shows on Instagram.'],
    falls: ['The {object} that slips off every single time.', 'Rides up, slips off, start again.'],
    pull: ['Walks that feel like a tug of war.'],
    broke: ['Another {thing} that gave up too soon?'],
    time: ['The {object} routine nobody enjoys.'],
    money: ['A new {object} every few months adds up.'],
    worry: [],
    annoy: [],
  },
  objection: {
    price: ['What the price actually gets: shown in 20 seconds.'],
    quality: ['We tried to wreck it. Here is the footage.'],
    clean: ['Cleaning it, start to finish, in one take.'],
    noise: ['Sound on. This is how loud it is.'],
    fit: ['Find the right size with one measurement.'],
    works: ['Day 1 and day 7. Same angle, no edits.'],
    wontuse: ['A fussy {who} meets it for the first time.'],
    safety: ['What it is made of, in plain words.'],
    copy: ['Side by side: what makes this one different.'],
    shipping: ['Where it ships from, and when it really arrives.'],
    power: ['How it is powered, and how long it runs.'],
  },
  trigger: {
    newpet: ['New {who} at home? Sort this first.'],
    baby: [],
    move: ['New place, new {object}. Start here.'],
    summer: ['Before the first hot night of summer.'],
    winter: ['Before the cold nights set in.'],
    travel: ['Packing for the next trip? Add this.'],
    gift: ['A gift for the {recipient} who has everything.'],
    replace: ['When the old {object} gives up, upgrade.'],
  },
  outcome: {
    finally: ['Finally, a {thing} that does the job.'],
    easy: ['Less time on the {object}, more time for the good stuff.'],
    comfort: ['Comfortable from the very first day.'],
    pet: ['The {who} found a new favourite spot.'],
    sooner: ['The {thing} we wish we had bought years ago.'],
    any: ['What a week with a {thing} looks like.'],
  },
  open: {
    demo: ['{name}: what it does, in 15 seconds.'],
    comparison: ['{object} vs {thing}: one week later.'],
    question: ['The question nobody asks before buying a {thing}.'],
    gift: ['A gift for the {recipient} who has everything.'],
    story: ['How a {object} problem turned into this.'],
  },
};
// Without Jev: how much one statement behind a draft counts, per kind. A real pain opens an ad best; a doubt is the
// second ad, not the first (practice on file: LAUNCH-KIT.md, 25-videos README section 4).
export const SLOT_WEIGHT = { pain: 1.5, trigger: 1.3, outcome: 1, objection: 0.7, open: 1 };
export const PROOF = {
  pain: 'Open on the problem in the first 2 seconds (close-up, real setting), then the product in use.',
  trigger: 'Show the moment itself first, then the product in that moment.',
  outcome: 'Before and after in one shot: same angle, same light.',
  demo: 'A 15-second demo that is clear without sound.',
  comparison: 'Side by side with what people use today, same test, no other brand shown.',
  question: 'Answer the question on screen within 5 seconds.',
  gift: 'Unboxing, the gift box, the reaction.',
  story: 'Founder or maker voice, real photos of the product being made or tested.',
};
export const ANSWERS = {
  price: 'Show what the price buys (materials, a bundle) and the cost of the cheap alternative over a year. No fake was-price.',
  quality: 'Close-ups of materials and seams and one real stress test. Only promise a warranty you can honour.',
  clean: 'Show the full clean in one take and say how often it is needed.',
  noise: 'Let a clip play with sound on, close to the product.',
  fit: 'A one-measurement size guide, a fit photo per size and an easy exchange.',
  works: 'One unedited demo in a real home. No claim the video does not show.',
  wontuse: 'Show a real first try and how to introduce it; offer an easy return.',
  safety: 'Name the materials and the documents the supplier really has (test reports, certificates).',
  copy: 'Show what is different side by side, without naming other sellers.',
  shipping: 'State the real dispatch origin and delivery window, with tracking.',
  power: 'Show how it is powered and how long it runs, precisely.',
};
const CATEGORY_RULES = {
  Pets: 'No vet, health or welfare claims (hydration, kidneys, anxiety, heatstroke). Show the animal in shade and safe.',
  'Sleep and comfort': 'No sleep-disorder, pain or measured-cooling claims; no fibre names without a fibre label.',
  'Health and pain relief': 'Health category: anything that names a condition is a medical claim. Comfort words only.',
  Clothing: 'Fibre-composition label required; no posture, slimming or medical claims; show the size guide.',
  Shoes: 'Material labelling (Directive 94/11/EC); no foot-health claims.',
  'Jewelry and accessories': 'Say the metal (316L steel, 925 silver) only if the supplier proves it; no brand names.',
  'Baby and kids': 'Child safety rules apply; nothing for under 3s without the right tests.',
  'Beauty and personal care': 'Cosmetics rules apply to anything put on the skin; Connor rejects face products.',
  Home: 'No antibacterial, allergy or air-quality claims without tests.',
  Kitchen: 'Food-contact rules (EU 1935/2004): the supplier must give a declaration of compliance.',
  Car: 'No safety claims; do not show it blocking the driver\'s view.',
};
const INTERESTS = {
  dog: ['Dogs', 'Dog training'], bigdog: ['Dogs'], olddog: ['Dogs'], puppy: ['Puppy', 'Dogs'], cat: ['Cats', 'Kitten'], multipet: ['Pets'],
  parent: ['Parenting'], grandparent: ['Grandparents'], caravan: ['Caravan', 'Recreational vehicle', 'Camping'], traveller: ['Travel'], outdoors: ['Camping', 'Hiking'],
  smallhome: ['Interior design'], house: ['Home and garden'], hotsleeper: ['Sleep'], worker: ['Nursing'], driver: ['Car wash'], student: ['College'], wfh: ['Remote work'],
  giftgiver: ['Gifts'], partner: [],
};
const AUDIENCE_INTERESTS = { 'Dog owners': ['Dogs'], 'Cat owners': ['Cats'], Parents: ['Parenting'], 'Gift givers': ['Gifts'], 'Home owners': ['Home improvement'], Drivers: ['Cars'],
  'Sports people': ['Physical fitness'], 'Older adults': [], Women: [], Men: [], Everyone: [] };

const PERSONAL = /(?<![\p{L}])(?:you|your|you'?re|yourself)(?![\p{L}])/iu;
const SENSITIVE = /(?<![\p{L}])(?:age|aged|old|older|over \d+|young|health|healthy|ill|sick|pain|ache|sleep|insomnia|weight|fat|belly|skin|body|debt|money|broke|budget|income|anxious|anxiety|stress|stressed|depress\w*|lonely|single|divorced|pregnan\w*|disab\w*)(?![\p{L}])/iu;

/** Can this line run as a hook: short, no claim word, no personal attribute in the address, no em dash. Returns '' or why not. */
export function hookProblem(text) {
  const t = String(text || '');
  if (!t.trim()) return 'empty';
  if (/[—–]/.test(t)) return 'em dash';
  if (/\{[a-z]+\}/.test(t)) return 'placeholder';
  if (t.split(/\s+/).length > 14) return 'too long';
  const c = claimsIn(t);
  if (c.length) return `claim: ${c[0].label} ("${c[0].word}")`;
  if (PERSONAL.test(t) && SENSITIVE.test(t)) return 'personal attribute';
  return '';
}

function fill(tpl, v) {
  let missing = false;
  const out = tpl.replace(/\{(\w+)\}/g, (m, k) => {
    if (!v[k]) {
      missing = true;
      return m;
    }
    return v[k];
  });
  return missing ? '' : cap1(out);
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * input: { pick: { id, key, name, title, url, store, price, currency, markets[], main, sub, jev: { audience, problemtype,
 *          season } }, phrase: { phrase, how, candidates }, collected: { ads, voice, pulls, credits, errors, stopped },
 *          baseline, jev: { used, labelled, error, ranking }, now, markets, labelledBy }
 */
export function buildCard(input) {
  const { pick = {}, phrase = {}, collected = {}, baseline = null, jev = {}, now = Date.now() } = input;
  // Launch markets: the ones the pick names that this card knows (currency, tax, CPM); else the run's, else NZ and AU.
  // The pick's other markets are where the competitor already runs: shown, not targeted.
  const up = (l) => [].concat(l || []).map((m) => String(m).toUpperCase()).filter(Boolean);
  const named = up(pick.launch && pick.launch.length ? pick.launch : pick.markets);
  const known = named.filter((m) => MARKETS[m]);
  const markets = known.length ? known : up(input.markets).length ? up(input.markets) : DEFAULT_MARKETS;
  const competitorMarkets = up(pick.markets).filter((m) => !markets.includes(m));
  const name = clip(pick.name || pick.title || phrase.phrase || pick.id, 120);
  const ph = phrase.phrase || '';

  // Statements: English, tagged by the word lists; Jev's kind (when it ran) decides the kind, the word list the theme.
  const own = new Set(ownWords(ph));
  const raw = (collected.voice || []).filter((v) => v && v.text && isEnglish(v.text) && relevant(v, ph));
  const seen = new Set();
  const voice = [];
  for (const v of raw) {
    const k = v.text.toLowerCase().replace(/\W+/g, ' ').trim().slice(0, 120);
    if (seen.has(k)) continue;
    seen.add(k);
    // "Pull" is a dog on a lead only for pet products; elsewhere it is a drawer or a card being pulled out.
    const tags = tagStatement(v.text, { skip: pick.main === 'Pets' ? [] : ['pull', 'newpet'] });
    if (v.jev !== undefined) {
      if (v.jev === '') continue; // Jev: off topic
      for (const kind of KINDS) if (kind !== v.jev && kind !== 'question') delete tags[kind];
      if (!tags[v.jev]) tags[v.jev] = 'other';
    }
    voice.push({ ...v, tags });
  }
  const themes = themesOf(voice);
  // Pet owners call their pet "baby" and "my boy": in the Pets category those are no baby trigger and no parents.
  if (pick.main === 'Pets') themes.trigger = themes.trigger.filter((t) => t.key !== 'baby');
  const situations = situationsOf(voice).filter((s) => !(pick.main === 'Pets' && ['parent', 'grandparent'].includes(s.key)));
  const words = phrasesOf(voice, { ignore: [...own] });
  const ads = collected.ads || [];
  const reach = demographics(ads, baseline);
  const jevAud = pick.jev && pick.jev.audience;

  // Competitors: their hook, its angle, how long it ran, its reach.
  const competitors = ads.map((a) => ({ page: a.page, ad_id: a.id, url: a.id ? `https://www.facebook.com/ads/library/?id=${a.id}` : '', hook: hookOf(a.body || a.title), angle: angleOf(a.body || a.title),
    angle_label: ANGLES[angleOf(a.body || a.title)], days: a.started ? Math.max(0, Math.round(((a.ended ? Date.parse(a.ended) : now) - Date.parse(a.started)) / DAY)) : null,
    reach: a.reach && a.reach.total || 0, targeting: a.targeting, link: a.link, claims: claimsIn(a.body) }));
  const usedAngles = new Set(competitors.map((c) => c.angle));

  // The problem.
  const pains = themes.pain.filter((t) => t.n >= 3).slice(0, 4);
  const topPain = pains[0] || null;
  const problemLine = topPain ? `${topPain.label} (${topPain.n} of ${voice.length} statements)` : pick.jev && pick.jev.problemtype ? `${pick.jev.problemtype} (Jev's reading of the product, no customer data)` : 'not enough customer statements to say';

  // Personas.
  const whoKey = (situations.find((s) => WHO[s.key]) || {}).key;
  const who = (whoKey && WHO[whoKey]) || AUDIENCE_WHO[jevAud] || '';
  const personas = buildPersonas({ reach, situations, themes, jevAud, markets, gift: themes.trigger.find((t) => t.key === 'gift'), voiceN: voice.length });

  // Hooks: drafts per slot, filtered, ranked by Jev when it ran.
  const south = MARKETS[markets[0]] ? MARKETS[markets[0]].south : false;
  const month = new Date(now).getUTCMonth(); // 0 = Jan
  const summerSoon = south ? month >= 8 || month <= 1 : month >= 2 && month <= 7;
  const recipient = RECIPIENT[(situations.find((s) => RECIPIENT[s.key]) || {}).key] || '';
  const vars = { object: objectOf(ph), who, thing: ph, name: cap1(ph) || name, recipient: recipient || 'person' };
  const drafts = draftAngles({ themes, vars, usedAngles, summerSoon, words });
  const ranking = jev && jev.ranking;
  const scored = drafts.map((d) => ({ ...d, jev_p: ranking && ranking.probs ? ranking.probs[d.hook] ?? null : null, jev_claim: ranking && ranking.claims ? ranking.claims[d.hook] ?? null : null }));
  let angles = scored.filter((d) => !(typeof d.jev_claim === 'number' && d.jev_claim >= 0.6));
  if (ranking && ranking.probs) angles = angles.map((a) => ({ ...a, _r: -(a.jev_p || 0) + a._i / 1e6 })).sort((a, b) => a._r - b._r);
  // No Jev ranking: the angle with the most statements behind it goes first (a draft with no evidence goes last).
  else angles = angles.map((a) => ({ ...a, _r: -(a.weight || 0) * (SLOT_WEIGHT[a.slot] || 1) + a._i / 1e6 })).sort((a, b) => a._r - b._r);
  const chosen = pickFive(angles);
  angles = chosen.map((a, i) => ({ n: i + 1, first_test: i < 3, angle: a.angle, slot: a.slot, persona: personas[0] ? personas[0].label : '', trigger: a.trigger || '', hook: a.hook,
    proof: a.proof, compliance: compliance(pick.main, a.hook), based_on: a.based_on, jev_p: a.jev_p ?? null, needs_proof: !!a.needs_proof }));

  const objections = themes.objection.slice(0, 5).map((t) => ({ ...t, answer: ANSWERS[t.key] || 'Answer it in the first 5 seconds of an ad or on the product page.' }));
  const targeting = buildTargeting({ reach, situations, jevAud, markets, main: pick.main });
  if (competitorMarkets.length) targeting.competitor_markets = competitorMarkets;

  const card = {
    version: CARD_VERSION, id: pick.id || '', key: pick.key || '', name, url: pick.url || '', store: pick.store || '', phrase: ph, phrase_how: phrase.how || 'none',
    built_at: new Date(now).toISOString(),
    data: dataSummary(collected, voice, raw.length, reach, jev),
    problem: { line: problemLine, themes: pains, jev_problemtype: (pick.jev && pick.jev.problemtype) || null },
    reach, reach_line: demoLine(reach),
    personas,
    triggers: themes.trigger.slice(0, 5),
    objections,
    outcomes: themes.outcome.slice(0, 4),
    questions: themes.question.slice(0, 1).map((t) => ({ ...t, quotes: pickQuotes(voice.filter((v) => v.tags.question), 4) })),
    intent: themes.intent.slice(0, 3),
    situations,
    words: { phrases: words.map((w) => (claimsIn(w.phrase).length ? { ...w, claim: claimsIn(w.phrase)[0].label } : w)), avoid: avoidList(competitors, pick.main) },
    competitors,
    angles,
    drafts: scored.map((d) => ({ hook: d.hook, slot: d.slot, angle: d.angle, jev_p: d.jev_p, jev_claim: d.jev_claim, chosen: chosen.some((c) => c.hook === d.hook) })),
    targeting,
    rules: [CATEGORY_RULES[pick.main], GENERAL_RULES].filter(Boolean),
  };
  card.facts = factsOf(card);
  card.assumptions = assumptionsOf(card);
  card.gaps = gapsOf(card, collected, jev);
  card.one_line = shortLine(card);
  card.one_line_long = oneLine(card);
  card.evidence = (collected.pulls || []).map((p) => ({ key: p.key, kind: p.kind, at: p.at, n: p.n, cached: !!p.cached, credits: p.credits || 0 }));
  return card;
}

/**
 * A statement found by a site-wide search (Reddit's comment search) must name the product's head noun in its text or in
 * its thread's title: "dog water fountain" finds plant and aquarium talk too. Comments under a video or thread about the
 * product are about it by context, and buyer reviews always are.
 */
export function relevant(v, phrase) {
  if (!(v.src === 'reddit' && v.kind === 'comment' && !v.thread)) return true;
  const words = ownWords(phrase);
  const head = words[words.length - 1];
  if (!head) return true;
  const stem = head.replace(/(?:es|s)$/, '');
  const re = new RegExp(`(?<![\\p{L}])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:s|es)?(?![\\p{L}])`, 'iu');
  return re.test(v.text) || re.test(v.on || '');
}

function dataSummary(collected, voice, rawN, reach, jev) {
  const by = {};
  for (const v of voice) by[v.src] = (by[v.src] || 0) + 1;
  const pulls = collected.pulls || [];
  return { statements: voice.length, statements_raw: rawN, by_platform: by, ads: (collected.ads || []).length, ads_with_reach: reach ? reach.ads : 0,
    credits: collected.credits || 0, pulls_live: pulls.filter((p) => !p.cached).length, pulls_cached: pulls.filter((p) => p.cached).length,
    first_pull: pulls.map((p) => p.at).filter(Boolean).sort()[0] || null, last_pull: pulls.map((p) => p.at).filter(Boolean).sort().slice(-1)[0] || null,
    labelled_by: jev && jev.used ? `Jev (${jev.labelled || 0} statements labelled)` : `word lists${jev && jev.error ? ` (Jev: ${jev.error})` : ''}`, stopped: collected.stopped || '', errors: collected.errors || [] };
}

function buildPersonas({ reach, situations, themes, jevAud, markets, gift, voiceN }) {
  const out = [];
  const sits = situations.filter((s) => !['partner', 'house', 'giftgiver'].includes(s.key));
  const bySplit = reach && reach.skew ? `${reach.skew === 'women' ? 'Women' : 'Men'}${reach.span ? ` ${reach.span.label}` : ''}` : '';
  const base = jevAud && !['Everyone', 'Women', 'Men'].includes(jevAud) ? jevAud : sits[0] && sits[0].n >= 3 ? PERSONA[sits[0].key] || sits[0].label : bySplit || (jevAud === 'Women' ? 'Women' : jevAud === 'Men' ? 'Men' : 'Broad buyers');
  const baseKey = jevAud && !['Everyone', 'Women', 'Men'].includes(jevAud) ? '' : sits[0] && sits[0].n >= 3 ? sits[0].key : '';
  const qualifier = sits.filter((s) => ['bigdog', 'olddog', 'puppy', 'multipet', 'caravan', 'smallhome', 'hotsleeper', 'sidesleeper', 'traveller', 'parent', 'worker', 'outdoors'].includes(s.key) && s.key !== baseKey &&
    !base.toLowerCase().includes((PERSONA[s.key] || s.label).toLowerCase().split(' ')[0]))
    .slice(0, 2).map((s) => (PERSONA[s.key] || s.label).toLowerCase());
  const label = qualifier.length ? `${base} (${qualifier.join(', ')})` : base;
  const sexLine = reach ? reach.skew === 'women' ? `mostly women (${reach.women}% of reach)` : reach.skew === 'men' ? `mostly men (${reach.men}% of reach)` : `women and men (${reach.women}% / ${reach.men}%)` : 'unknown (no EU reach data)';
  const ageLine = reach && reach.span ? `${reach.span.label} (${reach.span.share}% of reach)` : 'unknown (no EU reach data)';
  const wants = themes.outcome.slice(0, 2).map((t) => ({ label: t.label, n: t.n, quote: t.quotes[0] || null }));
  const fears = themes.objection.slice(0, 2).map((t) => ({ label: t.label, n: t.n, quote: t.quotes[0] || null }));
  out.push({
    label, gender: sexLine, ages: ageLine,
    countries: { launch: markets, eu_reach: reach ? reach.countries.slice(0, 4) : [] },
    situation: sits.slice(0, 4).map((s) => ({ label: s.label, n: s.n, share: s.share })),
    wants, fears,
    evidence: [
      reach ? { tag: 'fact', text: `Meta EU reach of ${reach.ads} competitor ad(s), ${reach.reach.toLocaleString('en')} people: ${demoLine(reach)}` } : null,
      jevAud ? { tag: 'fact', text: `Jev's buyer choice for the product: ${jevAud}` } : null,
      ...sits.slice(0, 2).map((s) => ({ tag: 'count', text: `${s.label}: ${s.n} of ${voiceN} statements`, quote: s.quotes[0] || null })),
      reach ? { tag: 'estimate', text: `Launch markets ${markets.join(', ')} get the EU split as an estimate: Meta publishes no reach split outside the EU` } : null,
    ].filter(Boolean),
  });
  // Second persona from the reach split, only when it is a different group: an older group that holds a quarter of the
  // reach, or the other sex peaking at another age. A plain cell of the split ("men 25-34") is not a persona.
  if (reach) {
    const older = (reach.ages.find((a) => a.band === '55-64') || {}).share + (reach.ages.find((a) => a.band === '65+') || {}).share;
    const peak = (sex) => reach.cells.filter((c) => c.sex === sex).sort((a, b) => b.share - a.share)[0];
    const major = reach.women >= reach.men ? 'F' : 'M';
    const minor = major === 'F' ? 'M' : 'F';
    const pm = peak(major);
    const pn = peak(minor);
    const minorShare = minor === 'F' ? reach.women : reach.men;
    if (older >= 25) {
      out.push({ label: 'Buyers 55 and over', gender: sexLine, ages: `55+ (${Math.round(older * 10) / 10}% of reach)`, countries: { launch: markets, eu_reach: reach.countries.slice(0, 3) },
        situation: [], wants: [], fears: [], evidence: [{ tag: 'fact', text: `55-64 and 65+ hold ${Math.round(older * 10) / 10}% of the competitors' EU reach` },
          { tag: 'assumption', text: 'Target them by age in Ads Manager if anything; never name their age in the ad (Meta personal-attributes rule)' }] });
    } else if (pm && pn && minorShare >= 35 && pn.band !== pm.band) {
      out.push({ label: `${minor === 'F' ? 'Women' : 'Men'}, peak ${pn.band}`, gender: `${minor === 'F' ? 'women' : 'men'} (${minorShare}% of reach)`, ages: pn.band,
        countries: { launch: markets, eu_reach: reach.countries.slice(0, 3) }, situation: [], wants: [], fears: [],
        evidence: [{ tag: 'fact', text: `${minorShare}% of the competitors' EU reach, peaking at ${pn.band} (${pn.share}%) while ${major === 'F' ? 'women' : 'men'} peak at ${pm.band}` }] });
    }
  }
  // Gift buyers: when people talk about buying it for someone.
  const giftN = (gift ? gift.n : 0) + (situations.find((s) => s.key === 'giftgiver') || { n: 0 }).n;
  if (giftN >= 3 || jevAud === 'Gift givers') {
    out.push({ label: 'Gift buyers', gender: reach ? sexLine : 'unknown', ages: reach && reach.span ? reach.span.label : 'unknown', countries: { launch: markets, eu_reach: [] }, situation: [], wants: [], fears: [],
      evidence: [{ tag: 'count', text: `${giftN} statements about buying it as a gift`, quote: gift && gift.quotes[0] || null }] });
  }
  return out.slice(0, 3);
}

function draftAngles({ themes, vars, usedAngles, summerSoon, words }) {
  const out = [];
  let i = 0;
  const push = (slot, angle, key, tpls, extra) => {
    for (const t of tpls || []) {
      const hook = fill(t, vars);
      if (!hook || hookProblem(hook)) continue;
      if (out.some((o) => o.hook === hook)) continue;
      out.push({ _i: i++, slot, angle, hook, ...extra });
      return true;
    }
    return false;
  };
  // 1. Pain: the top pain themes, then a hook made of the customers' own phrase ("Slimy water bowl, again?").
  for (const t of themes.pain.filter((x) => x.n >= 3).slice(0, 3)) {
    // "Slimy" only when the customers say slime; else the plain "never looks clean".
    const key = t.key === 'dirty' && t.quotes.some((x) => /slim/i.test(x.text)) ? 'slimy' : t.key;
    push('pain', 'Problem first', key, TEMPLATES.pain[key], { trigger: '', proof: PROOF.pain, based_on: t.quotes.slice(0, 2), needs_proof: false, theme: t.label, weight: t.n });
  }
  const painWord = THEMES.pain.map(([, , re]) => re);
  const ph = (words || []).find((w) => w.phrase.split(' ').length <= 3 && painWord.some((re) => re.test(w.phrase)) && !claimsIn(w.phrase).length);
  if (ph) push('pain', 'Problem first, in their words', 'phrase', [`${cap1(ph.phrase)}, again?`], { proof: PROOF.pain, based_on: [ph.example].filter(Boolean), needs_proof: false, theme: `"${ph.phrase}" (${ph.n} statements)`, weight: ph.n });
  // 2. The top objections, answered.
  for (const t of themes.objection.slice(0, 2)) push('objection', `Answer the doubt: ${t.label.toLowerCase()}`, t.key, TEMPLATES.objection[t.key], { proof: ANSWERS[t.key], based_on: t.quotes.slice(0, 2), needs_proof: ['quality', 'fit', 'works'].includes(t.key), theme: t.label, weight: t.n });
  // 3. Triggers: the top one, then the season that is coming in the first market.
  for (const t of themes.trigger.slice(0, 2)) {
    const key = t.key === 'season' ? (summerSoon ? 'summer' : 'winter') : t.key;
    push('trigger', `The moment: ${t.label.toLowerCase()}`, key, TEMPLATES.trigger[key], { trigger: t.label, proof: PROOF.trigger, based_on: t.quotes.slice(0, 2), needs_proof: false, theme: t.label, weight: t.n });
  }
  push('trigger', 'The moment: the season ahead', summerSoon ? 'summer' : 'winter', TEMPLATES.trigger[summerSoon ? 'summer' : 'winter'], { trigger: summerSoon ? 'Summer coming' : 'Winter coming', proof: PROOF.trigger, based_on: [], needs_proof: false, theme: 'calendar', weight: 1 });
  // 4. Outcomes.
  for (const t of themes.outcome.slice(0, 2)) push('outcome', `The result: ${t.label.toLowerCase()}`, t.key, TEMPLATES.outcome[t.key] || TEMPLATES.outcome.any, { proof: PROOF.outcome, based_on: t.quotes.slice(0, 2), needs_proof: true, theme: t.label, weight: t.n });
  push('outcome', 'The result', 'any', TEMPLATES.outcome.any, { proof: PROOF.outcome, based_on: [], needs_proof: false, theme: 'generic', weight: 1 });
  // A phrase people repeat (not the product's own name, no claim) as a curiosity hook: "Front clip? Watch this first."
  const rep = (words || []).find((w) => w.n >= 3 && w.phrase.split(' ').length <= 3 && !claimsIn(w.phrase).length && !painWord.some((re) => re.test(w.phrase)));
  if (rep) push('open', 'Open angle: their own words as the question', 'phrase', [`${cap1(rep.phrase)}? Watch this first.`], { proof: PROOF.question, based_on: [rep.example].filter(Boolean), needs_proof: false, theme: `"${rep.phrase}" (${rep.n} statements)`, weight: 2.5 });
  // 5. Open angles: kinds no competitor ad uses yet.
  for (const k of ['comparison', 'demo', 'question', 'gift', 'story']) {
    if (usedAngles.has(k)) continue;
    push('open', `Open angle: ${ANGLES[k] ? ANGLES[k].toLowerCase() : k} (no competitor ad uses it)`, k, TEMPLATES.open[k], { proof: PROOF[k], based_on: [], needs_proof: false, theme: 'not used by competitors', weight: 2 });
  }
  return out;
}

/** Five angles, one per slot first (pain, objection, trigger, outcome, open), then the best of the rest. */
function pickFive(list) {
  const out = [];
  for (const slot of ['pain', 'objection', 'trigger', 'outcome', 'open']) {
    const a = list.find((x) => x.slot === slot && !out.includes(x));
    if (a) out.push(a);
  }
  for (const a of list) {
    if (out.length >= 5) break;
    if (!out.includes(a)) out.push(a);
  }
  // Keep the ranked order (Jev's, when it ran) among the chosen five.
  return out.sort((a, b) => (a._r ?? a._i) - (b._r ?? b._i)).slice(0, 5);
}

export const GENERAL_RULES = 'No fake was-prices, countdowns or "only 3 left". No customer quotes or reviews in ads until real reviews exist. Do not name or knock competitors. No "you" with health, age, money or body. No em dashes.';
function compliance(main, hook) {
  const c = claimsIn(hook);
  if (c.length) return `Hook uses a claim word: ${c.map((x) => x.word).join(', ')}`;
  return 'OK against the rules below';
}

function avoidList(competitors, main) {
  const out = [];
  const seen = new Set();
  for (const c of competitors) {
    for (const x of c.claims || []) {
      const k = `${x.key}:${x.word.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ word: x.word, label: x.label, where: `competitor ad ${c.ad_id}` });
    }
  }
  if (CATEGORY_RULES[main]) out.push({ word: '', label: CATEGORY_RULES[main], where: 'category rule' });
  return out;
}

function buildTargeting({ reach, situations, jevAud, markets, main }) {
  const young = reach && (reach.ages.find((a) => a.band === '18-24') || {});
  const minAge = young && young.share >= 15 && (young.index || 100) >= 120 ? 18 : 25;
  const control = {
    campaign: 'Sales campaign, optimised for Purchase; one ad set per product (ABO); the 3 first-test angles as 3 ads',
    countries: markets,
    age: `${minAge}-65+`,
    gender: 'All',
    audience: 'Advantage+ audience on, no interests (let Meta find the buyers)',
    placements: 'Advantage+ placements',
    why: reach ? (reach.targeting.broadAge && reach.targeting.broadSex ? `The ${reach.ads} competitor ad(s) with reach data target all genders and broad ages too, and still reach a clear audience: Meta finds it.` :
      `Some competitor ads narrow ${[!reach.targeting.broadAge && `the ages (${reach.targeting.ages.map((a) => `${a.min || 18}-${a.max || '65+'}`).join(', ')})`, !reach.targeting.broadSex && `the gender (${reach.targeting.gender.join(', ')})`].filter(Boolean).join(' and ')}; broad stays the control, the split above says who Meta found.`) :
      'Same as the launch kit (all of the market, 25-65+, Advantage+ audience, no interests): no data says otherwise.',
  };
  if (minAge === 18) control.why += ` 18-24 hold ${young.share}% of the competitors' reach (index ${young.index}), so the age floor is 18.`;
  const suggestions = {};
  if (reach && reach.span && reach.span.to - reach.span.from <= 40) suggestions.age = `${reach.span.label} (holds ${reach.span.share}% of competitor reach)`;
  if (reach && reach.skew) suggestions.gender = reach.skew === 'women' ? `Women (${reach.women}% of reach)` : `Men (${reach.men}% of reach)`;
  const ints = [];
  for (const s of situations) for (const x of INTERESTS[s.key] || []) if (!ints.includes(x)) ints.push(x);
  for (const x of AUDIENCE_INTERESTS[jevAud] || []) if (!ints.includes(x)) ints.push(x);
  const countries = markets.map((cc) => {
    const m = MARKETS[cc] || {};
    return { cc, name: m.name || cc, currency: m.currency || '', tax: m.tax || '', cpm_usd: m.cpm ?? null, cpc_usd: m.cpc || '' };
  });
  const proven = reach ? reach.countries.filter((c) => c.share >= 8).map((c) => `${c.cc} ${c.share}%`) : [];
  return {
    control, suggestions,
    interests: { names: ints.slice(0, 4), status: 'unverified: check each name in Ads Manager detailed targeting before use', when: 'Only as a second ad set after the broad control has spent its test budget' },
    countries, bench_source: BENCH_SOURCE,
    proven_eu: proven,
    notes: [
      'Do not compare CPA between age, gender or country breakdowns of one ad set: Meta moves budget between segments on purpose (the breakdown effect).',
      reach ? 'The age and gender split is EU reach of competitor ads, transferred to the launch markets as an estimate.' : 'No EU reach data: age and gender rest on the launch-kit default.',
      main === 'Baby and kids' ? 'Products for children: no ads aimed at minors.' : '',
    ].filter(Boolean),
  };
}

function factsOf(card) {
  const f = [];
  if (card.reach) f.push(`Meta EU transparency data for ${card.reach.ads} competitor ad(s): ${card.reach_line}.`);
  if (card.data.statements) f.push(`${card.data.statements} English customer statements read (${Object.entries(card.data.by_platform).map(([k, v]) => `${k} ${v}`).join(', ')}).`);
  if (card.problem.themes[0]) f.push(`Top pain theme: ${card.problem.themes[0].label}, ${card.problem.themes[0].n} statements.`);
  if (card.competitors.length) f.push(`Competitor hooks read from ${card.competitors.length} ad(s) in the Meta Ad Library.`);
  return f;
}

function assumptionsOf(card) {
  const a = ['Reach is not purchases: Meta shows ads to the people its delivery predicts, and cheap age bands and countries get more reach for the money.'];
  if (card.reach) a.push(`The EU split holds for ${card.targeting.countries.map((c) => c.cc).join(', ')}.`);
  a.push('The comment sample speaks for buyers: comments come from people who watch or search, not only buyers, and the search words decide what is found.');
  a.push('Hooks are drafts: their wording is untested; the test decides.');
  return a;
}

function gapsOf(card, collected, jev) {
  const g = [];
  if (!card.reach) g.push('No EU reach data: no competitor ad with EU transparency numbers. Add the Meta Ad Library id of an EU competitor ad to fix it.');
  if (card.data.statements < 30) g.push(`Only ${card.data.statements} usable customer statements: themes and counts are thin.`);
  if (!card.phrase) g.push('No English search phrase: no customer data could be pulled.');
  if (!(jev && jev.used)) g.push(`Statements labelled by word lists, not Jev${jev && jev.error ? ` (${jev.error})` : ''}.`);
  if (collected.stopped) g.push(`Data pull stopped early: ${collected.stopped}.`);
  g.push('Interest names are unverified until checked in Ads Manager.');
  if (card.competitors.some((c) => !/[a-z]{3,}.*\b(the|and|you|your)\b/i.test(c.hook))) g.push('Some competitor hooks are not in English; they are shown as written.');
  return g;
}

/** The audience in at most 110 characters, for the digest line "For <this>.": who, the reach split, the launch markets. */
export function shortLine(card) {
  const p = card.personas && card.personas[0];
  const bits = [];
  if (p) bits.push(p.label.charAt(0).toLowerCase() + p.label.slice(1));
  const fromSplit = p && /^(Women|Men)\b/.test(p.label);
  if (card.reach && fromSplit) {
    const share = card.reach.skew === 'women' ? card.reach.women : card.reach.men;
    bits[bits.length - 1] += ` (${share}% of reach)`;
  } else if (card.reach) {
    const sex = card.reach.skew === 'women' ? `${card.reach.women}% women` : card.reach.skew === 'men' ? `${card.reach.men}% men` : '';
    const age = card.reach.span ? card.reach.span.label : '';
    const x = [sex, age].filter(Boolean).join(' ');
    if (x) bits.push(x);
  }
  const mk = (card.targeting && card.targeting.countries || []).map((c) => c.cc).join('/');
  if (mk) bits.push(mk);
  let line = bits.join(', ');
  const pain = card.problem && card.problem.themes && card.problem.themes[0];
  if (pain && Array.from(line).length + pain.label.length + 9 <= 110) line += `; pain: ${pain.label.toLowerCase()}`;
  return clip(line, 110);
}

/** The audience in one line with the first hook, at most 160 characters (board and card header). */
export function oneLine(card) {
  const p = card.personas && card.personas[0];
  const parts = [];
  if (p) parts.push(p.label);
  if (card.reach) {
    const sex = card.reach.skew === 'women' ? `${card.reach.women}% women` : card.reach.skew === 'men' ? `${card.reach.men}% men` : 'women and men';
    parts.push(card.reach.span ? `${sex}, ${card.reach.span.label}` : sex);
  }
  if (card.problem && card.problem.themes && card.problem.themes[0]) parts.push(`pain: ${card.problem.themes[0].label.toLowerCase()}`);
  const a = card.angles && card.angles[0];
  let line = parts.join(' · ');
  if (a) line += ` · hook: "${a.hook}"`;
  return clip(line, 160);
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------
const q = (x) => (x && x.text ? `"${clip(x.text, 180)}"${x.url ? ` ([${x.src}](${x.url})${x.date ? `, ${x.date}` : ''}${x.likes ? `, ${x.likes} likes` : ''})` : x.src ? ` (${x.src})` : ''}` : '');
const pct = (x) => (x == null ? '' : `${x}%`);

export function cardMarkdown(c) {
  const L = [];
  L.push(`# Audience card: ${c.name}`, '');
  L.push(`One line: ${c.one_line_long || c.one_line}`, '');
  L.push('| Field | Value |', '|---|---|');
  L.push(`| Card id | \`${c.id}\`${c.key ? ` (board key \`${c.key}\`)` : ''} |`);
  if (c.url) L.push(`| Product page | ${c.url} |`);
  L.push(`| Search phrase | "${c.phrase}" (${c.phrase_how}) |`);
  L.push(`| Built | ${c.built_at.slice(0, 16).replace('T', ' ')} UTC, card version ${c.version} |`);
  L.push(`| Data | ${c.data.statements} statements (${Object.entries(c.data.by_platform).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}), ${c.data.ads_with_reach} ad(s) with EU reach data |`);
  L.push(`| Pulls | ${c.data.pulls_live} live, ${c.data.pulls_cached} from cache, ${c.data.credits} ScrapeCreators credits; labelled by ${c.data.labelled_by} |`);
  L.push(`| Launch markets | ${c.targeting.countries.map((x) => x.cc).join(', ')} |`, '');

  L.push('## 1. Core problem', '');
  L.push(`[count] ${c.problem.line}`, '');
  for (const t of c.problem.themes) L.push(`- **${t.label}**: ${t.n} statements (${pct(t.share)}). ${t.quotes.slice(0, 2).map(q).join(' · ')}`);
  if (!c.problem.themes.length) L.push('- No pain theme found in the sample.');
  L.push('');

  L.push('## 2. Who the ads reach (Meta EU transparency data)', '');
  if (c.reach) {
    L.push(`[fact] ${c.reach_line}. Reached is not bought.`, '');
    L.push('| Band | Share of reach | Index vs all ads read |', '|---|---|---|');
    for (const a of c.reach.ages) L.push(`| ${a.band} | ${pct(a.share)} | ${a.index ?? 'n/a'} |`);
    L.push(`| Women / men / unknown | ${c.reach.women}% / ${c.reach.men}% / ${c.reach.unknown}% | ${c.reach.sexIndex ? `${c.reach.sexIndex.F} / ${c.reach.sexIndex.M}` : 'n/a'} |`, '');
    L.push(`Top countries: ${c.reach.countries.map((x) => `${x.cc} ${x.share}%`).join(', ')}. Baseline: ${c.reach.baseline} ads.`, '');
  } else L.push('No EU reach data for this product.', '');

  L.push('## 3. Personas', '');
  for (const p of c.personas) {
    L.push(`### ${p.label}`, '');
    L.push(`- Gender: ${p.gender}`);
    L.push(`- Ages: ${p.ages}`);
    L.push(`- Countries: launch ${p.countries.launch.join(', ')}${p.countries.eu_reach.length ? `; competitors reach ${p.countries.eu_reach.map((x) => `${x.cc} ${x.share}%`).join(', ')}` : ''}`);
    if (p.situation.length) L.push(`- Situation [count]: ${p.situation.map((s) => `${s.label} (${s.n})`).join(', ')}`);
    if (p.wants.length) L.push(`- Wants: ${p.wants.map((w) => `${w.label} (${w.n})${w.quote ? ` ${q(w.quote)}` : ''}`).join('; ')}`);
    if (p.fears.length) L.push(`- Fears: ${p.fears.map((w) => `${w.label} (${w.n})${w.quote ? ` ${q(w.quote)}` : ''}`).join('; ')}`);
    for (const e of p.evidence) L.push(`- [${e.tag}] ${e.text}${e.quote ? ` ${q(e.quote)}` : ''}`);
    L.push('');
  }

  L.push('## 4. Buying triggers', '');
  for (const t of c.triggers) L.push(`- **${t.label}** [count]: ${t.n} statements. ${t.quotes.slice(0, 1).map(q).join('')}`);
  if (!c.triggers.length) L.push('- None found in the sample.');
  L.push('');

  L.push('## 5. Objections and how to answer them', '');
  if (c.objections.length) {
    L.push('| Objection | Count | Quote | Answer in the ad or on the page |', '|---|---|---|---|');
    for (const o of c.objections) L.push(`| ${o.label} | ${o.n} | ${o.quotes[0] ? q(o.quotes[0]).replace(/\|/g, '/') : ''} | ${o.answer} |`);
  } else L.push('None found in the sample.');
  L.push('');
  if (c.questions.length && c.questions[0].quotes.length) {
    L.push('Questions people ask:', '');
    for (const x of c.questions[0].quotes) L.push(`- ${q(x)}`);
    L.push('');
  }

  L.push('## 6. Customer words', '');
  if (c.words.phrases.length) {
    L.push('| Phrase | Statements | Example |', '|---|---|---|');
    for (const w of c.words.phrases) L.push(`| ${w.phrase}${w.claim ? ` (${w.claim.toLowerCase()}: do not use in ads)` : ''} | ${w.n} | ${w.example ? q(w.example).replace(/\|/g, '/') : ''} |`);
  } else L.push('Not enough repeated phrases.');
  L.push('');
  if (c.words.avoid.length) {
    L.push('Words not to use:', '');
    for (const a of c.words.avoid) L.push(`- ${a.word ? `"${a.word}": ` : ''}${a.label} (${a.where})`);
    L.push('');
  }

  L.push('## 7. What competitors already say', '');
  if (c.competitors.length) {
    L.push('| Advertiser | Hook (first line) | Angle | Days live | EU reach |', '|---|---|---|---|---|');
    for (const x of c.competitors) L.push(`| ${x.page} ([ad](${x.url})) | ${clip(x.hook, 120).replace(/\|/g, '/')} | ${x.angle_label} | ${x.days ?? ''} | ${x.reach ? x.reach.toLocaleString('en') : ''} |`);
  } else L.push('No competitor ad read.');
  L.push('');

  L.push('## 8. Meta targeting for the first test', '');
  const t = c.targeting;
  L.push(`- **Control (broad):** ${t.control.campaign}. Countries ${t.control.countries.join(', ')}, age ${t.control.age}, gender ${t.control.gender}, ${t.control.audience}, ${t.control.placements}.`);
  L.push(`  - Why: ${t.control.why}`);
  if (t.suggestions.age || t.suggestions.gender) L.push(`- **Advantage+ audience suggestions** (hints, not limits): ${[t.suggestions.age && `age ${t.suggestions.age}`, t.suggestions.gender && `gender ${t.suggestions.gender}`].filter(Boolean).join('; ')}`);
  if (t.interests.names.length) L.push(`- **Optional interest ad set** [unverified]: ${t.interests.names.join(', ')}. ${t.interests.when}. ${t.interests.status}.`);
  L.push('- **Countries:**', '');
  L.push('| Market | Currency | Tax rule | CPM (USD) | CPC (USD) |', '|---|---|---|---|---|');
  for (const x of t.countries) L.push(`| ${x.name} | ${x.currency} | ${x.tax} | ${x.cpm_usd ?? 'n/a'} | ${x.cpc_usd || 'n/a'} |`);
  L.push('', `Benchmarks: ${t.bench_source}`, '');
  if (t.proven_eu.length) L.push(`- Competitors already reach (EU, share of reach): ${t.proven_eu.join(', ')}`);
  if (t.competitor_markets && t.competitor_markets.length) L.push(`- The product's own ads run in: ${t.competitor_markets.join(', ')} (not a launch market here: no tax and CPM data on file, or not named)`);
  for (const n of t.notes) L.push(`- ${n}`);
  L.push('- Budget, kill and scale rules: the wh-validate test plan for this product.', '');

  L.push('## 9. Five ad angles and hooks (drafts)', '');
  L.push('Hooks are our own words built from what customers say. Edit before use; never present a quote as a review.', '');
  L.push('| # | Angle | Hook | Proof to show | Compliance | Based on |', '|---|---|---|---|---|---|');
  for (const a of c.angles) {
    L.push(`| ${a.n}${a.first_test ? ' (test)' : ''} | ${a.angle} | ${a.hook}${a.needs_proof ? ' [needs proof]' : ''} | ${a.proof} | ${a.compliance.replace(/\|/g, '/')} | ${(a.based_on || []).map((x) => (x && x.url ? `[${x.src}](${x.url})` : x && x.src ? x.src : '')).filter(Boolean).join(', ') || a.slot} |`);
  }
  L.push('');
  for (const r of c.rules || []) L.push(`- Rule: ${r}`);
  if (c.drafts && c.drafts.length > c.angles.length) L.push(`- ${c.drafts.length} drafts considered${c.drafts.some((d) => d.jev_p != null) ? ', ranked by Jev' : ', in rule order (Jev off)'}; the 5 above were chosen one per kind.`);
  L.push('');

  L.push('## 10. Facts and assumptions', '');
  for (const f of c.facts) L.push(`- [fact] ${f}`);
  for (const a of c.assumptions) L.push(`- [assumption] ${a}`);
  L.push('');
  L.push('## 11. Evidence log and gaps', '');
  for (const e of c.evidence) L.push(`- ${e.kind} \`${clip(e.key, 90)}\`: ${e.n} item(s), ${e.cached ? 'from cache' : `${e.credits} credit(s)`}, pulled ${String(e.at || '').slice(0, 10)}`);
  for (const g of c.gaps) L.push(`- Gap: ${g}`);
  L.push('');
  return L.join('\n');
}
