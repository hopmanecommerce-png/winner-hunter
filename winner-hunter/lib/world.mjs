/*
 * Outside the EU, without reach. Meta's Ad Library API only returns shop ads that ran in the EU or UK (tested
 * 2026-10-28), but the public Ad Library website lists a country's ads for any country, with the ad's start date, its
 * copies, where it links and the page's likes. No login. This file holds the pure parts: reading that page, what is on
 * the board, and adding ads up to products. lib/adlibrary.mjs opens the pages, world.mjs runs the night.
 */
import { landing, productOf, NON_STORE, hostKey, hostOf, noTemplate, SHOPIFY_HDR } from './score.mjs';
import { sized } from './storephoto.mjs';

const DAY = 864e5;

// The markets to hunt (Connor, 2026-10-31): first Switzerland, Norway, Australia, New Zealand, Dubai, US, Canada, then the
// ones that passed the low-hassle screen (research/2026-10-31-easy-markets). Meta's Ad Library has no city filter, so
// Dubai means the whole UAE. The board has the same list (worker/src/app.mjs WORLD_MARKETS).
export const MARKETS = ['CH', 'NO', 'AU', 'NZ', 'AE', 'US', 'CA', 'SG', 'JE', 'HK', 'MO', 'JP', 'KR', 'MY', 'TW', 'IL', 'LI'];
export const LANGS = { CH: ['de', 'fr'], NO: ['no'], AU: ['en'], NZ: ['en'], AE: ['en'], US: ['en'], CA: ['en'], SG: ['en'], JE: ['en'], HK: ['en', 'zh'], MO: ['zh'], JP: ['ja'], KR: ['ko'], MY: ['en'], TW: ['zh'], IL: ['en'], LI: ['de'] };
export const MIN_DAYS = 7; // a younger ad proves nothing yet (the same lower limit as the EU board)
export const KEEP_DAYS = 21; // an ad counts as running for this long after it was last seen (one round of the keywords takes many nights)

/** keywords-world.txt: 'en: dog harness | de: hundegeschirr | fr: harnais chien | no: hundesele | …' → [{ en, de, fr, no, … }]. */
export function parseWorldKeywords(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const row = {};
    for (const part of line.split('|')) {
      const m = /^\s*([a-z]{2})\s*:\s*(.+?)\s*$/.exec(part);
      if (m) row[m[1]] = m[2];
    }
    if (row.en) out.push(row);
  }
  return out;
}

/** The searches for one keyword line: [{ cc, q }], every market in its own languages (English where a word is missing). */
export function searchesOf(row, markets = MARKETS) {
  const out = [];
  for (const cc of markets) {
    const words = new Set((LANGS[cc] || ['en']).map((l) => row[l] || row.en));
    for (const q of words) out.push({ cc, q });
  }
  return out;
}

export const libraryUrl = ({ cc, q, pageId }) => {
  const p = new URLSearchParams({ active_status: 'active', ad_type: 'all', country: cc, media_type: 'all' });
  if (pageId) {
    p.set('search_type', 'page');
    p.set('view_all_page_id', pageId);
  } else {
    p.set('q', q);
    p.set('search_type', 'keyword_unordered');
  }
  return `https://www.facebook.com/ads/library/?${p}`;
};

/**
 * The JSON blocks of an Ad Library page → { ads: raw ads, count }. count is null when the page holds no search result
 * at all (a block or a page that did not load, not "nothing found"). Meta shows 50001 for "more than 50,000".
 */
export function readLibrary(blocks) {
  const ads = new Map();
  let count = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      o.forEach(walk);
      return;
    }
    if (o.ad_archive_id && o.snapshot) {
      ads.set(String(o.ad_archive_id), o);
      return;
    }
    if (o.search_results_connection && typeof o.search_results_connection.count === 'number') count = o.search_results_connection.count;
    for (const k of Object.keys(o)) walk(o[k]);
  };
  for (const b of blocks || []) {
    try {
      walk(typeof b === 'string' ? JSON.parse(b) : b);
    } catch (e) {
      // not JSON
    }
  }
  return { ads: [...ads.values()], count };
}

const cut = (t, n) => Array.from(String(t ?? '')).slice(0, n).join('');
const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? cut(u, 1000) : '');

/** One raw ad → the row for world_ads, or null when it no longer runs. */
export function toRow(raw, cc, keyword) {
  if (raw.is_active === false || raw.end_date_active === false) return null;
  const s = raw.snapshot || {};
  const card = (Array.isArray(s.cards) && s.cards[0]) || {};
  const img = (Array.isArray(s.images) && s.images[0]) || {};
  const vid = (Array.isArray(s.videos) && s.videos[0]) || {};
  const link = String(s.link_url || card.link_url || '');
  const caption = String(s.caption || card.caption || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  const lh = landing({ links: link ? [link] : [], cap: caption });
  const store = lh && !NON_STORE.test(lh.key) ? lh.key : '';
  const prod = lh ? productOf({ lh }) : null;
  return {
    ad_id: String(raw.ad_archive_id),
    cc,
    page_id: String(raw.page_id || s.page_id || ''),
    page_name: cut(s.page_name || raw.page_name || '', 200),
    likes: Number.isFinite(Number(s.page_like_count)) && s.page_like_count != null ? Number(s.page_like_count) : null,
    collation_id: String(raw.collation_id || raw.ad_archive_id),
    copies: Math.max(1, Number(raw.collation_count) || 1),
    start_at: Number(raw.start_date) || null,
    link: cut(lh ? lh.url : link, 1000),
    caption: cut(caption, 200),
    title: cut(noTemplate(s.title || card.title || ''), 200),
    body: cut(noTemplate((s.body && s.body.text) || card.body || ''), 2000),
    image_url: https(img.original_image_url || img.resized_image_url || card.original_image_url || card.resized_image_url || vid.video_preview_image_url || card.video_preview_image_url || ''),
    keyword: cut(keyword || '', 100),
    store,
    product_key: store && prod && prod.kind === 'product' ? prod.key : '',
  };
}

// ---------------------------------------------------------------------------
// What is on the board (CLAUDE.md, board exclusions)
// ---------------------------------------------------------------------------
const words = (s) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${s})(?![\\p{L}\\p{N}])`, 'iu');
// Pet food is on the board (Connor, 2026-10-31: all of the categories he had left open stay on). Without this, the food words would take it off.
const PET_FOOD = words('(?:dog|cat|pet|puppy|kitten)[\\s-]+(?:food|treats?)(?![\\s-]+(?:bowl|mat|dispenser|container|storage))|hundefutter|katzenfutter|hundemat|kattemat|croquettes?');
// Words that only mean something you take or eat: the name, the type and the tags count. A description is not read: it
// mentions these things on ordinary goods too. Kept narrow on purpose: a product wrongly taken off never shows again,
// while one wrongly kept can simply be rejected.
const OUT_ANYWHERE = [
  ['supplement', words('dietary supplements?|food supplements?|nahrungserg[äa]nzung\\w*|kosttilskudd|kosttillskott|compl[eé]ment alimentaire|gummies|protein powder|greens powder|creatine|kreatin|shilajit|ashwagandha')],
  // No word boundaries in these scripts.
  ['supplement', /サプリ|コラーゲン|ビタミン|健康食品|영양제|비타민|콜라겐|건강기능식품|保健食品|膠原蛋白|胶原蛋白|維他命|维生素|益生菌/u],
];
const NOT_TAKEN = words('laundry|dishwasher|wardrobe|holder|case|organi[sz]er|filter|shaker|machine|maker|grinder|storage');
// The name only.
const OUT_IN_NAME = [
  ['supplement', words('supplements?|suppl[eé]ments?|capsules|kapseln|g[ée]lules|softgels|(?:vitamins?|vitamines?|collag[eè]ne?|kollagen|probiotics?|probiotique|whey|magnesium|omega[\\s-]?3)(?:\\s+[\\p{L}\\p{N}]+)?\\s+(?:capsules?|tablets?|pills?|powder|pulver|drops|sachets?)')],
  ['food or drink', words('protein bars?|drink mix|energy drinks?|herbal tea|superfoods?|coffee creamer|mushroom coffee')],
  ['gymwear', words('gymwear|gym wear|gym[\\s-]+(?:shorts|shirts?|leggings?|tank|tops?|stringer)|workout[\\s-]+(?:shorts|shirts?|leggings?|tops?)|activewear|sportswear|sportbekleidung|fitnessbekleidung|treningsklær')],
];
const NOT_A_PRODUCT = /(?:shipping|order|package) protection|shipping insurance|gift ?cards?|geschenk(?:gutschein|karte)|carte cadeau|gavekort|ギフト券|ギフトカード|상품권|禮券|禮物卡|礼品卡/iu;

/** { out: '' | why it is off the board }. title: the product's name. labels: its type and tags. Words miss some: Reject handles those. */
export function classify(title, labels = '') {
  const name = String(title || '');
  const all = `${name}\n${labels || ''}`;
  if (NOT_A_PRODUCT.test(name)) return { out: 'not a product' };
  if (PET_FOOD.test(name)) return { out: '' };
  for (const [why, re] of OUT_ANYWHERE) if (re.test(all)) return { out: why };
  if (!NOT_TAKEN.test(name)) for (const [why, re] of OUT_IN_NAME.slice(0, 1)) if (re.test(name)) return { out: why };
  for (const [why, re] of OUT_IN_NAME.slice(1)) if (re.test(name)) return { out: why };
  return { out: '' };
}

// The EU board (lib/meta.mjs) leaves out more: selling these in the EU takes paperwork a dropshipper does not have (a safety
// report and a responsible person for cosmetics and perfume, medical-device rules once a product promises to treat pain or a
// condition, veterinary rules for pet medicine), on top of the supplements, food and drink above. Read as above: the name,
// for perfume and pet health also the type and tags, never the description. Narrow on purpose; Reject handles the rest.
const COSMETICS = words([
  'serums?|sérums?|moisturi[sz]ers?|bodylotions?|body\\s+lotions?|körperlotion|lait\\s+corporel|shampoos?|shampoings?|(?<!air[\\s-]?)conditioners?',
  '(?:face|facial|eye|night|day|hand|foot|body|neck|lip|skin|anti[\\s-]?(?:aging|ageing|wrinkle)|moisturi[sz]ing|hydrating|whitening|retinol|collagen|vitamin\\s?c)\\s+(?:creams?|lotions?|balms?|butters?)',
  '(?:dag|nacht|hand|voet|gezichts|huid|oog|anti[\\s-]?rimpel)cr[eè]mes?|(?:tages|nacht|hand|fuß|fuss|gesichts|augen|haut|anti[\\s-]?falten)cremes?',
  'crèmes?\\s+(?:visage|de\\s+jour|de\\s+nuit|hydratantes?|anti[\\s-]?(?:âge|rides)|mains|corps)|(?:face|body|hand)\\s?wash(?:es)?|shower\\s?gels?|douchegel|duschgel|gels?\\s+douche',
  'tooth\\s?paste|tandpasta|zahnpasta|dentifrices?|(?:teeth|tooth)\\s+whitening|whitening\\s+(?:strips|gel|kit|pen|powder|foam)|tandenbleek\\p{L}*|zahnaufhellung|blanchiment\\s+(?:des\\s+dents|dentaire)',
  'lipsticks?|lip\\s?gloss(?:es)?|lippenstift\\p{L}*|rouges?\\s+à\\s+lèvres|mascaras?|eye\\s?liners?|eye\\s?shadows?|concealers?|bronzers?|nail\\s+(?:polish|varnish|lacquer)|gel\\s+polish|nagellak|nagellack|vernis\\s+à\\s+ongles',
  'hair\\s+(?:dyes?|colou?rs?|bleach|oils?|serums?|masks?|tonics?|growth)|beard\\s+(?:oils?|balms?)|haarverf|haarfarbe\\p{L}*|coloration\\s+(?:capillaire|cheveux)|eyelash\\s+serums?|lash\\s+serums?|wimpernserum',
  'sunscreens?|sun\\s?creams?|sun\\s?blocks?|zonnebrand\\p{L}*|sonnencreme\\p{L}*|crèmes?\\s+solaires?|écran\\s+solaire|deodorants?|déodorants?|deos?',
  '(?:sheet|clay|peel[\\s-]?off|mud|charcoal|collagen|hydrogel|face|facial)\\s+masks?|gezichtsmaskers?|gesichtsmasken?|masques?\\s+(?:visage|faciale?s?)',
  'cosmetics?|cosmétiques?|kosmetik\\p{L}*|cosmetica|make[\\s-]?up|maquillage|schminke|self[\\s-]?tan(?:ner|ning)?|zelfbruiner|selbstbräuner|autobronzant|retinol|hyaluron\\p{L}*|niacinamide',
].join('|'));
// A tool or a holder for them is no cosmetic: "makeup brush", "LED face mask", "lotion dispenser".
const NOT_COSMETIC = words('brush(?:es)?|combs?|rollers?|mirrors?|bags?|cases?|organi[sz]ers?|holders?|applicators?|sponges?|dispensers?|machines?|devices?|tools?|stands?|storage|pouch(?:es)?|led|fridge|removers?|pads?|towels?|cloths?');
const MEDICAL = words([
  'pain\\s+relie(?:f|vers?|ving)|relie(?:f|ves?|ving)\\s+(?:\\p{L}+\\s+){0,2}pain|painkillers?|pain\\s+(?:patch(?:es)?|cream|gel|spray)',
  '(?:back|neck|knee|joint|nerve|period|menstrual|muscle|shoulder|hip|foot|heel|sciatic|tooth)\\s+pain',
  '(?:rug|nek|knie|gewrichts|spier|menstruatie|hiel|voet|schouder|tand)pijn|pijnverlichting|pijnstill\\p{L}*|pijnbestrijding',
  '(?:rücken|nacken|knie|gelenk|muskel|regel|perioden|fersen|fuß|schulter|zahn|kopf)schmerz\\p{L}*|schmerzlinder\\p{L}*|schmerzmittel|schmerztherapie',
  'mal\\s+de\\s+dos|douleurs?\\s+(?:articulaires?|dorsales?|lombaires?|musculaires?|cervicales?|menstruelles?)|anti[\\s-]?douleurs?|antidouleurs?|analgésiques?',
  'sciatica|ischias|sciatique|arthritis|artritis|arthrite|arthrose|artrose|fasciitis|fasciite|fersensporn|hielspoor|neuropath\\p{L}*|tinnitus|acouphènes?|oorsuizen|migraines?|migräne',
  'hemorrhoids?|haemorrhoids?|aambeien|hämorrhoiden|hémorroïdes|varicose|spataderen|krampfadern|varices|scoliosis|scoliose|skoliose|incontinen\\p{L}*|inkontinenz',
  'eczema|eczeem|ekzem|eczéma|psoriasis|acne|acné|diabet\\p{L}*|insomnia|slapeloosheid|schlaflosigkeit|insomnie|bunions?|hallux\\s+valgus|carpal\\s+tunnel|karpaltunnel|tendinitis|tendonitis',
  'tens\\s+(?:units?|devices?|machines?|massagers?|apparaat|gerät|geräte|appareils?)|tens[\\s/-]+ems|electrotherap\\p{L}*|elektrotherap\\p{L}*|électrothérap\\p{L}*|muscle\\s+stimulators?',
  'blood\\s+(?:pressure|sugar|glucose)|bloeddruk\\p{L}*|blutdruck\\p{L}*|tension\\s+artérielle|tensiomètres?|glucose\\s+(?:meters?|monitors?)|bloedsuiker\\p{L}*|blutzucker\\p{L}*',
  'hearing\\s+aids?|hoortoestel\\p{L}*|hörgerät\\p{L}*|appareils?\\s+auditifs?|(?:pulse\\s+)?oximeters?|oxymètres?|pulsoximeter|fever\\s+thermometers?|koortsthermometers?|fieberthermometer\\p{L}*',
  'weight\\s+loss|fat\\s+burn(?:ers?|ing)|anti[\\s-]?snor\\p{L}*|snoring|snurk\\p{L}*|schnarch\\p{L}*|ronflement|medical\\s+devices?|medizinprodukt\\p{L}*',
].join('|'));
const PERFUME = words('perfumes?|parfums?|parfüms?|eaux?\\s+de\\s+(?:parfum|toilette|cologne)|colognes?|body\\s+mists?');
// A bottle for it or a scent for the house or the car is no perfume.
const NOT_PERFUME = words('bottles?|atomi[sz]ers?|cases?|holders?|organi[sz]ers?|stands?|display|car|auto|voiture|home|room|maison|intérieur|diffusers?|diffuseurs?|candles?|bougies?|kerzen?|kaarsen?');
const PET_HEALTH = words([
  'fleas?|vlooien(?:band|middel|druppels|shampoo|spray)?|flöhe|floh(?:halsband|mittel|schutz|tropfen|shampoo|spray)\\p{L}*|anti[\\s-]?(?:puces?|vlooien|tiques?)',
  'ticks?\\s+(?:collars?|drops|treatments?|sprays?|repellents?|prevention|protection)|teken(?:band|druppels|middel)|zecken(?:halsband|schutz|mittel|tropfen|spray)\\p{L}*',
  '(?:de)?wormers?|worming|ontworm\\p{L}*|wurmkur\\p{L}*|entwurm\\p{L}*|vermifuges?',
  '(?:dogs?|cats?|pets?|puppy|kittens?|hond(?:en)?|katten|hunde?|katzen?|chiens?|chats?)\\s+(?:supplements?|vitamins?|probiotics?|medicines?|medications?|meds|painkillers?)',
  '(?:supplements?|vitamins?|probiotics?|medicines?|medications?|meds)\\s+for\\s+(?:dogs?|cats?|pets?|puppies|kittens?)|calming\\s+(?:chews|treats|drops|tablets)',
].join('|'));
// A tool against fleas or ticks is no medicine: a comb, tweezers, a trap.
const NOT_PET_MEDICINE = words('combs?|brush(?:es)?|removers?|tweezers?|twisters?|hooks?|traps?|lamps?|markets?');

/**
 * The EU board's screen: { out: '' | why it is off the EU board }. title: the product's name (and the ad's title), labels:
 * its type and tags. Supplements, food or drink and what is not a product as classify() above (gymwear stays on: it was
 * a call for the markets outside the EU), plus cosmetics, perfume, medical claims and pet health.
 */
export function screenEU(title, labels = '') {
  const name = String(title || '');
  const all = `${name}\n${labels || ''}`;
  const c = classify(name, labels);
  if (c.out && c.out !== 'gymwear') return c;
  if (!NOT_COSMETIC.test(name) && COSMETICS.test(name)) return { out: 'cosmetics' };
  if (!NOT_PERFUME.test(name) && PERFUME.test(all)) return { out: 'perfume' };
  if (MEDICAL.test(name)) return { out: 'medical claim' };
  if (!NOT_PET_MEDICINE.test(name) && PET_HEALTH.test(all)) return { out: 'pet health' };
  return { out: '' };
}

// ---------------------------------------------------------------------------
// Stores and products (Shopify's open endpoints, no Meta requests)
// ---------------------------------------------------------------------------
// Shopify answers 429 across its stores once one address asks too much (seen 2026-10-31: 286 of 292 stores in a row). A 429
// is not "no such product": everybody waits, then asks again.
let coolUntil = 0;
export const COOL_MS = 45000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const resetCooling = () => { coolUntil = 0; };

async function getText(doFetch, url, { timeout = 15000, tries = 3, coolMs = COOL_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (Date.now() < coolUntil) await wait(coolUntil - Date.now());
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await doFetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { Accept: 'application/json' } });
      if (res.status === 429 && attempt + 1 < tries) {
        coolUntil = Math.max(coolUntil, Date.now() + coolMs * (attempt + 1));
        continue;
      }
      const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
      return { status: res.status, text: await res.text(), headers, url: res.url || url };
    } catch (e) {
      return { status: 0, text: '', headers: '', url, error: e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Is the store on Shopify? { shopify, host, currency, products, myshopify }. shopify null: it did not answer (also used by
 * the EU hunt, lib/meta.mjs).
 */
export async function checkStore(store, doFetch = globalThis.fetch, opts = {}) {
  let answered = false;
  for (const host of [store, 'www.' + store]) {
    const r = await getText(doFetch, `https://${host}/meta.json`, opts);
    if (r.status === 429) return { shopify: null, host: store, currency: '', products: null, myshopify: '' }; // still limited: asked again next run
    // A 403 (a bot wall) or a 5xx (down for a moment) says nothing either: only a real answer means "not on Shopify".
    if (r.status && r.status !== 403 && r.status < 500) answered = true;
    let j = null;
    try {
      j = JSON.parse(r.text);
    } catch (e) {
      // not JSON
    }
    const shop = j && /\.myshopify\.com$/i.test(j.myshopify_domain || '');
    if (shop || SHOPIFY_HDR.test(r.headers)) {
      // host: the address that answered, some stores only answer on www.
      return { shopify: 1, host: hostOf(r.url) || host, currency: (shop && j.currency) || '', products: shop && typeof j.published_products_count === 'number' ? j.published_products_count : null,
        myshopify: shop ? j.myshopify_domain : '' };
    }
  }
  return { shopify: answered ? 0 : null, host: store, currency: '', products: null, myshopify: '' };
}

const price = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) || Number(v) === 0 ? null : Number(v));

/** A product from its store: /products/handle.json. Prices there are in the store's own currency. null when it has none. */
export async function fetchProduct(key, { host, currency = '' }, doFetch = globalThis.fetch, opts = {}) {
  const handle = key.split('/products/')[1];
  if (!handle) return null;
  const r = await getText(doFetch, `https://${host}/products/${encodeURIComponent(handle)}.json`, opts);
  let p = null;
  try {
    p = JSON.parse(r.text).product;
  } catch (e) {
    return null;
  }
  if (!p || !p.title) return null;
  const v = (Array.isArray(p.variants) && p.variants[0]) || {};
  const tags = Array.isArray(p.tags) ? p.tags.join(' ') : p.tags;
  const c = classify(p.title, [p.product_type, tags].filter(Boolean).join(' \n '));
  const src = (p.image && p.image.src) || (Array.isArray(p.images) && p.images[0] && p.images[0].src) || '';
  return { title: cut(p.title, 200), price: price(v.price), compare_at_price: price(v.compare_at_price), currency: cut(v.price_currency || currency, 8), image_url: src ? sized(src) : '',
    product_type: cut(p.product_type, 100), out: c.out ? 1 : 0 };
}

const NOISE = new Set('the and for with your you our now new get buy free sale off shop store official best today shipping offer deal deals limited only this that from more'.split(' '));
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/gu;
const CJK_NOISE = /送料無料|今だけ|限定|セール|新作|人気|公式|特價|特价|優惠|优惠|限時|限时|新款|免運|免运|熱賣|官方|무료배송|특가|할인|세일|공식|인기/gu;

/** Is the ad's title about this product? A real word in common, not a sales word and not the shop's own name. */
export function sameThing(title, named, store = '') {
  const text = String(named || '').toLowerCase();
  const shop = String(store || '').toLowerCase().replace(/^(?:www|shop|store|get|try|buy)\./, '').split('.')[0];
  const low = String(title || '').toLowerCase();
  const theirs = new Set(text.split(/[^\p{L}\p{N}]+/u));
  for (const w of low.split(/[^\p{L}\p{N}]+/u)) {
    if (/^[a-z0-9à-ÿ-]+$/.test(w) && w.length >= 3 && !/^\d+$/.test(w) && !NOISE.has(w) && !(shop && (shop.includes(w) || w.includes(shop))) && theirs.has(w)) return true;
  }
  // No spaces between words here: two characters in a row in common, after the sales words.
  const quiet = text.replace(CJK_NOISE, ' ');
  for (const run of low.replace(CJK_NOISE, ' ').match(CJK_RUN) || []) {
    for (let i = 0; i + 2 <= run.length; i++) if (quiet.includes(run.slice(i, i + 2))) return true;
  }
  return false;
}

/**
 * The product an ad without a product link is about: the store's own search with the ad's title. Its key, '' when the
 * store has no such product, or null when the store did not answer (asked again next run). A search always answers
 * something, so it must be about the same thing ("Free shipping today" finds nothing).
 * store: the name the store is known by here, so the key matches links from ads (a store's host can be another domain).
 */
export async function suggestProduct(title, host, doFetch = globalThis.fetch, store = host, opts = {}) {
  const q = cut(noTemplate(title), 60);
  if (!q) return '';
  const r = await getText(doFetch, `https://${host}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=1`, opts);
  if (r.status === 404) return '';
  if (r.status !== 200) return null; // an outage or a limit says nothing about the product: asked again next run
  try {
    const p = JSON.parse(r.text).resources.results.products[0];
    const m = /\/products\/([^/?#]+)/.exec(String((p && p.url) || ''));
    if (!m) return '';
    const handle = decodeURIComponent(m[1]).toLowerCase();
    if (!sameThing(q, `${p.title || ''} ${handle.replace(/[-_]+/g, ' ')}`, hostKey(store))) return '';
    return `${hostKey(store)}/products/${handle}`;
  } catch (e) {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Ads → products
// ---------------------------------------------------------------------------
/** What Meta's API says about a shop's active EU ads → { in_eu, eu_rpd, eu_ads }: only reach it publishes, per day of ad life. */
export function euFacts(ads, seen, now = Date.now()) {
  const list = Array.isArray(ads) ? ads : [];
  let best = null;
  const out = {};
  for (const a of list) {
    const reach = Number(a.eu_total_reach);
    const start = Date.parse(a.ad_delivery_start_time || '');
    if (!Number.isFinite(reach) || reach <= 0 || !Number.isFinite(start)) continue;
    const rpd = reach / Math.max(Math.floor((now - start) / DAY), 1);
    if (best == null || rpd > best) best = rpd;
    if (seen.has(String(a.id))) out[String(a.id)] = Math.round(rpd);
  }
  return { in_eu: list.length ? 1 : 0, eu_rpd: best == null ? null : Math.round(best), eu_ads: JSON.stringify(out) };
}

/**
 * The ads still running, added up per product. Only products on a Shopify store, not off the board, with an ad at
 * least MIN_DAYS old. ads: world_ads rows. items: Map product_key → world_items row. stores: Map store → world_stores
 * row. pages: Map page_id → { counts: {cc: n}, in_eu, eu_rpd, eu_ads: {ad id: reach a day} }. known: Map product_key → { ad_id, first_seen } (ad_id never changes).
 */
export function addUp(ads, { items, stores, pages, known = new Map(), now = Date.now() }) {
  const groups = new Map();
  for (const a of ads) {
    if (!a.product_key) continue;
    if (!groups.has(a.product_key)) groups.set(a.product_key, []);
    groups.get(a.product_key).push(a);
  }
  const out = [];
  const iso = new Date(now).toISOString();
  for (const [key, rows] of groups) {
    const item = items.get(key);
    if (!item || item.out) continue;
    const store = key.split('/')[0];
    const shop = stores.get(store);
    if (!shop || !shop.shopify) continue;
    const daysOf = (a) => (a.start_at ? Math.max(0, Math.floor((now - a.start_at * 1000) / DAY)) : 0);
    const oldest = rows.reduce((x, y) => (daysOf(y) > daysOf(x) || (daysOf(y) === daysOf(x) && y.ad_id < x.ad_id) ? y : x));
    const days = daysOf(oldest);
    if (days < MIN_DAYS) continue;
    const byCc = new Map();
    const creatives = new Map();
    const fresh = new Set();
    for (const a of rows) {
      const d = daysOf(a);
      if (!byCc.has(a.cc)) byCc.set(a.cc, { creatives: new Map(), ids: new Set(), days: 0, new14: new Set() });
      const m = byCc.get(a.cc);
      m.creatives.set(a.collation_id, Math.max(m.creatives.get(a.collation_id) || 0, a.copies || 1));
      m.days = Math.max(m.days, d);
      if (d <= 14) {
        m.new14.add(a.ad_id);
        fresh.add(a.ad_id);
      }
      creatives.set(a.collation_id, Math.max(creatives.get(a.collation_id) || 0, a.copies || 1));
    }
    const markets = {};
    for (const cc of MARKETS) {
      const m = byCc.get(cc);
      if (m) markets[cc] = { ads: [...m.creatives.values()].reduce((x, y) => x + y, 0), days: m.days, new14: m.new14.size };
    }
    if (!Object.keys(markets).length) continue;
    const pageCount = new Map();
    for (const a of rows) if (a.page_id) pageCount.set(a.page_id, (pageCount.get(a.page_id) || 0) + 1);
    const pageId = [...pageCount].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([p]) => p)[0] || oldest.page_id;
    const page = pages.get(pageId);
    const counts = (page && page.counts) || {};
    const shopAds = Object.entries(counts).filter(([cc]) => markets[cc]).reduce((x, [, n]) => Math.max(x, Number(n) || 0), 0);
    const fromPage = rows.find((a) => a.page_id === pageId) || oldest;
    const euAds = (page && page.eu_ads) || {};
    const euHits = rows.map((a) => Number(euAds[a.ad_id])).filter((n) => Number.isFinite(n) && n > 0);
    const k = known.get(key);
    out.push({
      product_key: key,
      // Its own id space: the same ad can also be an EU winner, and a decision on one must not reach the other.
      ad_id: (k && k.ad_id) || 'w' + oldest.ad_id,
      active: 1,
      product_title: item.title || oldest.title,
      price: item.price,
      compare_at_price: item.compare_at_price,
      currency: item.currency || shop.currency || '',
      image_url: item.image_url || oldest.image_url || '',
      store_url: `https://${shop.host || store}/`,
      product_url: `https://${shop.host || store}/products/${key.split('/products/')[1]}`,
      ad_library_url: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(oldest.ad_id)}`,
      advertiser: fromPage.page_name || '',
      page_id: pageId || '',
      likes: fromPage.likes ?? null,
      keyword: oldest.keyword || rows.map((a) => a.keyword).find(Boolean) || '',
      markets: JSON.stringify(markets),
      ads: [...creatives.values()].reduce((x, y) => x + y, 0),
      creatives: creatives.size,
      days,
      new14: fresh.size,
      shop_ads: shopAds || null,
      in_eu: page && page.in_eu != null ? Number(page.in_eu) : null,
      eu_rpd: euHits.length ? Math.round(Math.max(...euHits)) : null,
      shop_eu_rpd: page && page.eu_rpd ? Math.round(Number(page.eu_rpd)) : null,
      store_products: shop.products ?? null,
      first_seen: (k && k.first_seen) || rows.map((a) => a.first_seen).filter(Boolean).sort()[0] || iso,
      last_seen: rows.map((a) => a.last_seen).filter(Boolean).sort().pop() || iso,
    });
  }
  return out;
}
