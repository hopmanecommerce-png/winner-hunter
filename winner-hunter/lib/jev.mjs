/*
 * Jev, TypeSafe's decision model (docs.typesafe.ai): its answers about one product outside the EU, from everything we know:
 * the product page, its photos, the ad's image and words, and where the ads run. Tested on 209 products on 2026-11-01
 * (research/2026-11-01-jev-ad-check). Images are "dreamer-ready" at TypeSafe: not production-ready, the format can change.
 * So a failure only means: no answers for this product.
 */
import { sized } from './storephoto.mjs';
import { questions, TAXONOMY, SEP, TRAITS, AD_TRAITS, CHOICES, AD_CHOICES, SCORES, AD_SCORES, VERSION } from '../worker/src/jev-questions.mjs';

export const MODEL = 'jev-1.14.0';
export const PRICE_PER_TOKEN = 0.042 / 1e6; // input only, output is free (docs.typesafe.ai/models, 2026-11-01)
const API = 'https://api.typesafe.ai/v1/systemone';
const MAX_IMAGE = 8e6;
const MIN_SIDE = 280; // Jev refuses anything outside these, it does not resize
const MAX_SIDE = 1568;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };

/** An error with what the caller needs: stop asking (the key, the balance, a changed format) or just skip this product. */
export class JevError extends Error {
  constructor(message, { status = 0, stop = false } = {}) {
    super(message);
    Object.assign(this, { status, stop });
  }
}

const formatOf = (b) => (b[0] === 0x89 && b[1] === 0x50 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : '');

/** Width and height of a PNG or JPEG from its first bytes, or null. */
export function sizeOf(b) {
  if (formatOf(b) === 'png') return b.length >= 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  if (formatOf(b) !== 'jpg') return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * A picture as Jev's asset, or null when it is no use: Jev only reads PNG and JPEG of 280 to 1568 pixels, Shopify's image
 * server can convert and size. A photo server that is down throws JevError when must is set: asked again next run.
 */
export async function photoAsset(url, { doFetch = globalThis.fetch, must = true } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const sizedUrl = sized(url, 768);
  const shopify = /[?&]width=768(?:&|$)/.test(sizedUrl);
  const read = async (x) => {
    let res;
    try {
      res = await doFetch(x, { signal: AbortSignal.timeout(20000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return null;
      const b = Buffer.from(await res.arrayBuffer());
      return b.length && b.length <= MAX_IMAGE ? b : null;
    } catch (e) {
      if (!must) return null;
      throw new JevError(`photo not reachable (${e.message || e.name})`);
    }
  };
  let b = await read(sizedUrl);
  if (b && !formatOf(b) && shopify) {
    const jpg = new URL(sizedUrl);
    jpg.searchParams.set('format', 'jpg');
    b = await read(jpg.toString());
  }
  if (!b || !formatOf(b)) return null;
  const s = sizeOf(b);
  if (!s || s.w < MIN_SIDE || s.h < MIN_SIDE || s.w > MAX_SIDE || s.h > MAX_SIDE) return null;
  return { type: 'image', format: formatOf(b), data_base64: b.toString('base64') };
}

const text = (s, max) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The product page: description, tags, options and more photos, from Shopify's open JSON. Null when it does not answer. */
export async function productPage(key, { doFetch = globalThis.fetch, pause = wait } = {}) {
  const [host, handle] = String(key).split('/products/');
  if (!host || !handle) return null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await doFetch(`https://${host}/products/${encodeURIComponent(handle)}.json`, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (res.status === 429 && attempt === 1) {
        await pause(5000);
        continue;
      }
      if (!res.ok) return null;
      const p = (await res.json()).product;
      if (!p) return null;
      return { description: text(p.body_html, 4000), vendor: text(p.vendor, 100), tags: text(Array.isArray(p.tags) ? p.tags.join(', ') : p.tags, 500),
        options: (Array.isArray(p.options) ? p.options : []).map((o) => text(o.name, 40)).filter((o) => o && o !== 'Title'), variants: Array.isArray(p.variants) ? p.variants.length : 0,
        images: (Array.isArray(p.images) ? p.images : []).map((i) => i && i.src).filter(Boolean) };
    } catch (e) {
      return null;
    }
  }
  return null;
}

async function ask(body, withPictures, { key, doFetch, pause, tries = 5 }) {
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (withPictures) headers['TypeSafe-Danger-Zone-Images'] = 'true';
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await doFetch(API, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    } catch (e) {
      if (attempt >= tries) throw new JevError(`no answer (${e.name})`);
      await pause(2000 * attempt);
      continue;
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch (e) {
        throw new JevError(`unreadable answer (${e.name})`); // this product, not the run
      }
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= tries) throw new JevError(`HTTP ${res.status}`, { status: res.status });
      const after = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      await pause(after > 0 ? Math.min(after, 60) * 1000 : 3000 * attempt);
      continue;
    }
    // 400 and 413: this request (a picture Jev refuses). Anything else will not get better by asking again.
    throw new JevError(`HTTP ${res.status}`, { status: res.status, stop: res.status !== 400 && res.status !== 413 });
  }
}

/** From Jev's probabilities per "Main > Sub": the main category (the sum over its subs) and the best sub inside it. */
export function categoryOf(answer) {
  const probs = (answer && answer.probabilities) || {};
  const mains = {};
  for (const [c, p] of Object.entries(probs)) {
    const [m] = c.split(SEP);
    if (Object.hasOwn(TAXONOMY, m) && typeof p === 'number') mains[m] = (mains[m] || 0) + p;
  }
  const main = Object.keys(mains).sort((a, b) => mains[b] - mains[a])[0];
  if (!main) throw new JevError('unexpected answer for category', { stop: true });
  const subs = TAXONOMY[main].map((s) => [s, probs[main + SEP + s] || 0]).sort((a, b) => b[1] - a[1]);
  const total = mains[main] || 1;
  return { main, main_conf: Math.round(mains[main] * 1000) / 1000, sub: subs[0][0], sub_conf: Math.round((subs[0][1] / total) * 1000) / 1000 };
}

function readAnswers(j, withAd) {
  const a = j && j.answers;
  const prob = (k) => {
    const v = a && a[k] && a[k].noul;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new JevError(`unexpected answer for ${k}`, { stop: true });
    return v;
  };
  const p = {};
  for (const t of withAd ? [...TRAITS, ...AD_TRAITS] : TRAITS) p[t.k] = prob(t.k);
  const choices = {};
  for (const [k, c] of Object.entries(withAd ? { ...CHOICES, ...AD_CHOICES } : CHOICES)) {
    const x = a[k];
    if (!x || !c.options.includes(x.choice)) throw new JevError(`unexpected answer for ${k}`, { stop: true });
    choices[k] = { c: x.choice, conf: typeof x.confidence === 'number' ? x.confidence : null };
  }
  const scores = {};
  for (const k of Object.keys(withAd ? { ...SCORES, ...AD_SCORES } : SCORES)) {
    const x = a[k];
    if (!x || typeof x.score !== 'number') throw new JevError(`unexpected answer for ${k}`, { stop: true });
    scores[k] = Math.round(x.score * 100) / 100;
  }
  return { p, choices, scores, ...categoryOf(a.category) };
}

/**
 * Jev's answers about one product. p: { title, type, store, image, key, price, was, currency, products, advertiser, likes,
 * keyword, ads: { titles, texts, image, countries, count, days, new14, creatives } }.
 * A set of pictures Jev refuses: the words only. Throws JevError.
 */
export async function checkProduct(p, { key, doFetch = globalThis.fetch, pause = wait } = {}) {
  const page = p.key ? await productPage(p.key, { doFetch, pause }) : null;
  const ads = p.ads || {};
  const mainUrl = p.image || (page && page.images[0]) || '';
  const main = mainUrl ? await photoAsset(mainUrl, { doFetch, must: p.must !== false }) : null;
  const second = page && page.images[1] ? await photoAsset(page.images[1], { doFetch, must: false }) : null;
  const adPic = ads.image && ads.image !== mainUrl ? await photoAsset(ads.image, { doFetch, must: false }) : null; // a Facebook link can have expired
  const adWords = (ads.titles || []).length + (ads.texts || []).length;
  const withAd = !!adPic || adWords > 0;
  const state = {
    product: { name: text(p.title, 300), type: text(p.type, 100), price: p.price ?? null, was_price: p.was ?? null, currency: text(p.currency, 8),
      ...(page ? { description: page.description, vendor: page.vendor, tags: page.tags, options: page.options, variant_count: page.variants } : {}) },
    shop: { domain: text(p.store, 200), products_in_shop: p.products ?? null, advertiser: text(p.advertiser, 200), page_likes: p.likes ?? null },
    ads: { found_by_search: text(p.keyword, 100), titles: (ads.titles || []).map((t) => text(t, 200)), texts: (ads.texts || []).map((t) => text(t, 1200)),
      countries: ads.countries || [], running: ads.count ?? null, oldest_days: ads.days ?? null, new_in_14_days: ads.new14 ?? null, creatives: ads.creatives ?? null },
  };
  const assets = {};
  const used = [];
  const add = (name, asset, label) => {
    if (!asset) return;
    const ref = `picture-${name}-ref`;
    assets[ref] = asset;
    state[name] = ref;
    used.push(label);
  };
  add('product_photo', main, 'photo');
  add('second_product_photo', second, 'photo2');
  add('ad_picture', adPic, 'ad image');
  const qs = questions(withAd);
  const words = { ...state };
  for (const k of ['product_photo', 'second_product_photo', 'ad_picture']) delete words[k];
  let j;
  let input = 'title';
  try {
    if (!used.length) throw new JevError('no picture', { status: 400 });
    j = await ask({ model: MODEL, questions: qs, state, assets }, true, { key, doFetch, pause });
    input = 'photo';
  } catch (e) {
    if (!(e instanceof JevError) || e.stop || (e.status !== 400 && e.status !== 413)) throw e;
    used.length = 0;
    j = await ask({ model: MODEL, questions: qs, state: words }, false, { key, doFetch, pause });
  }
  const r = readAnswers(j, withAd);
  if (page) used.push('description');
  if ((ads.texts || []).length) used.push('ad text');
  if ((ads.titles || []).length) used.push('ad title');
  return { version: VERSION, input, model: String(j.model || MODEL), people: r.p.people, animals: r.p.animals, gymwear: r.p.gymwear, physical: r.p.physical,
    category: r.main, category_conf: r.main_conf, main: r.main, sub: r.sub, main_conf: r.main_conf, sub_conf: r.sub_conf,
    product_score: r.scores.product_score, ad_score: r.scores.ad_score ?? null, answers: JSON.stringify({ p: r.p, choices: r.choices, scores: r.scores }),
    used: used.join(', '), ad_text: (ads.texts || []).length ? 1 : 0, tokens: Number(j.usage && j.usage.input_tokens) || 0 };
}
