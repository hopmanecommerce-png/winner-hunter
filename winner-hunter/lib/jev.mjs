/*
 * Jev, TypeSafe's decision model (docs.typesafe.ai): its answers about one product outside the EU, from the product's name,
 * type and shop and its photo. Tested on 209 products on 2026-11-01 (research/2026-11-01-jev-ad-check). Images are
 * "dreamer-ready" at TypeSafe: not production-ready, the format can change. So a failure only means: no answers for this product.
 */
import { sized } from './storephoto.mjs';

export const MODEL = 'jev-1.14.0';
export const PRICE_PER_TOKEN = 0.042 / 1e6; // input only, output is free (docs.typesafe.ai/models, 2026-11-01)
const API = 'https://api.typesafe.ai/v1/systemone';
const MAX_IMAGE = 8e6;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const noul = (instructions, yes, no) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });
export const QUESTIONS = {
  people: noul('Is this product something a person eats, drinks or swallows?', 'Food, drink, supplements, vitamins, gummies, powders, teas, capsules, or anything else a person swallows.', 'Anything else, including devices, skincare, nose strips and nose sprays.'),
  animals: noul('Is this product something an animal eats or takes?', 'Pet food, treats, chews or pet supplements.', 'Anything else, including pet toys, harnesses and beds.'),
  gymwear: noul('Is this product clothing made for working out?', 'Gym shorts, gym shirts, workout leggings, sports bras and other activewear.', 'Anything else, including shaping or cellulite leggings, running socks and home gym equipment.'),
  physical: noul('Does this sell a physical product that someone receives?', 'A physical product that is shipped to the buyer.', 'A service, app, membership, gift card, digital download, or a general store offer without one product.'),
  category: { type: 'choice', instructions: 'Which category fits this product best?', criteria: {
    pet: 'For pets.', home: 'For the home.', kitchen: 'For the kitchen.', beauty: 'Beauty or skincare.', 'health device': 'A health or wellness device.',
    'baby or kids': 'For babies or children.', clothing: 'Everyday clothing.', gymwear: 'Clothing made for working out.', 'fitness gear': 'Fitness equipment.',
    'garden or outdoor': 'For the garden or outdoors.', car: 'For the car.', tech: 'Electronics or gadgets.', 'jewelry or accessories': 'Jewelry or accessories.',
    'food or supplement': 'Food, drink or supplements.', other: 'None of these.' } },
};

/** An error with what the caller needs: stop asking (the key, the balance, a changed format) or just skip this product. */
export class JevError extends Error {
  constructor(message, { status = 0, stop = false } = {}) {
    super(message);
    Object.assign(this, { status, stop });
  }
}

const formatOf = (b) => (b[0] === 0x89 && b[1] === 0x50 ? 'png' : b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : '');

/**
 * A product photo as Jev's asset, or null when there is no usable photo: Jev only reads PNG and JPEG, Shopify's image server
 * can convert the rest. A photo server that is down throws JevError: the product is asked again next run, not from its title for good.
 */
export async function photoAsset(url, { doFetch = globalThis.fetch } = {}) {
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
      throw new JevError(`photo not reachable (${e.message || e.name})`);
    }
  };
  let b = await read(sizedUrl);
  if (b && !formatOf(b) && shopify) {
    const jpg = new URL(sizedUrl);
    jpg.searchParams.set('format', 'jpg');
    b = await read(jpg.toString());
  }
  return b && formatOf(b) ? { type: 'image', format: formatOf(b), data_base64: b.toString('base64') } : null;
}

async function ask(body, photo, { key, doFetch, pause, tries = 5 }) {
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (photo) headers['TypeSafe-Danger-Zone-Images'] = 'true';
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
    // 400 and 413: this request (an image too small or too big). Anything else will not get better by asking again.
    throw new JevError(`HTTP ${res.status}`, { status: res.status, stop: res.status !== 400 && res.status !== 413 });
  }
}

/**
 * Jev's answers about one product: { input, model, people, animals, gymwear, physical, category, category_conf, tokens }.
 * A photo Jev refuses (too small, for instance): the name, type and shop only, with input 'title'. Throws JevError.
 */
export async function checkProduct(p, { key, doFetch = globalThis.fetch, pause = wait } = {}) {
  const state = { product_name: String(p.title || ''), shop_product_type: String(p.type || ''), shop: String(p.store || '') };
  const asset = p.image ? await photoAsset(p.image, { doFetch }) : null;
  const base = { model: MODEL, questions: QUESTIONS };
  const ref = 'photo-of-the-product';
  let j;
  let input = 'title';
  try {
    if (!asset) throw new JevError('no photo', { status: 400 });
    j = await ask({ ...base, state: { ...state, picture: ref }, assets: { [ref]: asset } }, true, { key, doFetch, pause });
    input = 'photo';
  } catch (e) {
    if (!(e instanceof JevError) || e.stop || (e.status !== 400 && e.status !== 413)) throw e;
    j = await ask({ ...base, state }, false, { key, doFetch, pause });
  }
  const a = j && j.answers;
  const prob = (k) => {
    const v = a && a[k] && a[k].noul;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new JevError(`unexpected answer for ${k}`, { stop: true });
    return v;
  };
  const c = a && a.category;
  if (!c || typeof c.choice !== 'string' || !Object.hasOwn(QUESTIONS.category.criteria, c.choice)) throw new JevError('unexpected answer for category', { stop: true });
  return { input, model: String(j.model || MODEL), people: prob('people'), animals: prob('animals'), gymwear: prob('gymwear'), physical: prob('physical'),
    category: c.choice, category_conf: typeof c.confidence === 'number' ? c.confidence : null, tokens: Number(j.usage && j.usage.input_tokens) || 0 };
}
