// The compliance and risk radar (worker/src/risk.mjs): Block, Docs or OK on the 36 approved products of
// test/fixtures/approved-36.json (P1-P36 of docs/learnings/approved-products-review.md: its 9 restricted ones are blocked, its
// 12 that need a size are flagged), the word lists in English, Dutch and German against
// the EU screen of the hunt, Jev's answers, your checks, /risk.js (the same code in the board), /api/risk and ?risk=hide on
// /api/ads and /export.csv, on an in-memory D1 (node:sqlite) with every migration applied.
import test from 'node:test';
import assert from 'node:assert';
import vm from 'node:vm';
import { handle, tokenFor, toAd, products } from '../worker/src/app.mjs';
import { riskKit, RISK_JS, verdict, auto, blocks, blockedBy, finish, fromAd, fromTikTok, fromFacts, keyOf, cleanCheck, supplierRequest, rowInput, rowBlocked,
  CHECKS_SQL, TEXT, SHORT, LEVEL, BLOCKERS, TRAITS as RISK_TRAITS } from '../worker/src/risk.mjs';
import { TRAITS } from '../worker/src/jev-questions.mjs';
import { screenEU, classify } from '../lib/world.mjs';
import { seededEnv, NOW } from './helpers/seed.mjs';
import { APPROVED, NOT_APPROVED, cardOf, idOf, loadApproved } from './helpers/risk-seed.mjs';

const ORIGIN = 'https://winner-hunter.example.workers.dev';
const xOf = (p) => (p.source === 'tiktok' ? fromTikTok(cardOf(p)) : fromAd(cardOf(p)));
const name = (title, extra = {}) => ({ source: 'eu', id: '1', title, product: '', copy: '', p: null, main: '', sub: '', ...extra });
const reasonKeys = (v) => v.reasons.filter((r) => r.level === 'block' || r.level === 'docs').map((r) => r.k);

async function session(env) {
  const cookie = `__Host-wh=${await tokenFor(env, NOW)}`;
  const call = (path, init = {}) => handle(new Request(ORIGIN + path, { ...init, headers: { cookie, ...init.headers } }), env, { now: NOW });
  return {
    get: async (path) => (await call(path)).json(),
    post: (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
    call,
  };
}
const risk = async (s, body, headers) => {
  const res = await s.post('/api/risk', body, headers);
  return { status: res.status, ...(await res.json()) };
};

// ---------------------------------------------------------------------------
// The 36 approved products
// ---------------------------------------------------------------------------

test('the 36 approved products (P1-P36 of the review): exactly its 9 restricted ones are Block, each for its reason; the other 27 sell; its 12 with sizes are flagged, not blocked', () => {
  assert.deepStrictEqual(APPROVED.map((p) => p.n), Array.from({ length: 36 }, (_, i) => i + 1), 'P1-P36, the review\'s numbers');
  const restricted = APPROVED.filter((p) => p.restricted);
  assert.deepStrictEqual(restricted.map((p) => p.n), [10, 13, 17, 20, 24, 26, 28, 29, 33], "the review's restricted approvals");
  assert.ok(restricted.every((p) => p.source === 'eu'), 'all of them from the EU tab');
  const blocked = [];
  for (const p of APPROVED.concat(NOT_APPROVED)) {
    const v = verdict(xOf(p));
    assert.strictEqual(v.level, p.expect, `P${p.n} ${p.title}: ${v.level} (${reasonKeys(v).join(', ')})`);
    for (const k of p.why) assert.ok(reasonKeys(v).includes(k), `P${p.n} ${p.title}: ${k} among ${reasonKeys(v).join(', ')}`);
    assert.deepStrictEqual(v.returns.map((r) => r.k), p.returns, `P${p.n} ${p.title}: its return flags`);
    if (p.pay) assert.strictEqual(v.pay, p.pay, `P${p.n}: Shopify Payments`);
    if (v.level === 'block') blocked.push(p.n);
    else assert.ok(!v.reasons.some((r) => r.level === 'block'), `P${p.n} ${p.title} sells: no block reason`);
  }
  assert.deepStrictEqual(blocked.filter((n) => n <= 36), restricted.map((p) => p.n), 'blocked: the restricted ones and no other');
  const level = (k) => APPROVED.filter((p) => verdict(xOf(p)).level === k).length;
  assert.deepStrictEqual([level('block'), level('docs'), level('ok')], [9, 9, 18]);
  // Each for its category in the review: perfume, essential oils, pet health, a skin cosmetic, a health-claim device, a skin
  // cosmetic, a supplement, food (coffee), hair care
  assert.deepStrictEqual(restricted.map((p) => p.why[0]), ['cosmetics', 'cosmetics', 'pet_med', 'cosmetics', 'medical', 'cosmetics', 'eat', 'eat', 'cosmetics']);
  // The 12 that need a size: a return flag beside an OK, never a block (the review: the two lists do not overlap)
  assert.deepStrictEqual(APPROVED.filter((p) => verdict(xOf(p)).returns.some((r) => r.k === 'sizing')).map((p) => p.n), [3, 7, 8, 9, 12, 14, 16, 19, 21, 27, 30, 35]);
  assert.ok(APPROVED.filter((p) => p.returns.includes('sizing')).every((p) => verdict(xOf(p)).level === 'ok'));
  // P16 and P35, the same jacket (a Dutch and a German ad): one product page, so one key and one check for both
  const p = (n) => APPROVED.find((x) => x.n === n);
  assert.strictEqual(keyOf(xOf(p(16))), 'page:valkental.myshopify.com/products/outdoor-jacket-men');
  assert.strictEqual(keyOf(xOf(p(35))), keyOf(xOf(p(16))));
  // Where Jev's answers alone would not block, the words do: P17 (Jev "animals" is pet food: Docs), P13 and P33 (skin under a yes)
  const jevOnly = (n) => verdict(name('Product', { p: p(n).jev.p, main: p(n).jev.main, sub: p(n).jev.sub })).level;
  assert.deepStrictEqual([17, 13, 33].map(jevOnly), ['docs', 'docs', 'ok']);
  assert.deepStrictEqual([17, 28, 29].map((n) => verdict(xOf(p(n))).reasons.filter((r) => (r.from || []).includes('jev')).map((r) => r.k)), [['pet_eat'], ['eat'], ['eat']],
    'Jev flagged P17 (animals), P28 and P29 (people), as the review says');
  // The look-alikes sell: a case for AirPods, a wireless bra (no radio), a cat brush whose ad is about something else
  for (const n of [5, 27, 23]) assert.strictEqual(verdict(xOf(p(n))).level, 'ok', p(n).title);
  assert.deepStrictEqual(reasonKeys(verdict(xOf(p(23)))), [], "P23's ad copy is another product's: the radar reads the product it was matched to");
});

test('/risk.js is the kit on its own: in a bare context it gives the module\'s verdicts on all 36, with and without your checks', () => {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(RISK_JS, ctx);
  const K = ctx.window.RISK;
  assert.match(RISK_JS, /^'use strict';\nwindow\.RISK = \(function riskKit\(\) \{/);
  const same = (a, b, what) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), what);
  const checks = [null, { tm: 'clear' }, { tm: 'conflict' }, { docs: true }, { level: 'ok' }, { level: 'block', note: 'no' }];
  for (const p of APPROVED.concat(NOT_APPROVED)) {
    const card = cardOf(p);
    const x = p.source === 'tiktok' ? K.fromTikTok(card) : K.fromAd(card);
    same(x, xOf(p), `#${p.n} input`);
    same(K.keyOf(x), keyOf(xOf(p)), `#${p.n} key`);
    same(K.blocks(x), blocks(xOf(p)), `#${p.n} blocks`);
    for (const c of checks) same(K.verdict(x, c), verdict(xOf(p), c), `#${p.n} with ${JSON.stringify(c)}`);
  }
  const blender = APPROVED.find((p) => p.title.startsWith('Portable Blender'));
  same(K.supplierRequest(K.verdict(K.fromAd(cardOf(blender))), 'Blender'), supplierRequest(verdict(xOf(blender)), 'Blender'));
  assert.ok(!/^\s*import\s|\bimport\(|\brequire\(/m.test(RISK_JS), 'nothing from outside');
  assert.ok(!/\(\?<[=!]/.test(RISK_JS), 'no lookbehind: older phones read the rules too');
});

test('the Worker\'s filter answers as the card: blocks() and blockedBy() equal the full verdict, with and without checks; the ad\'s words never block', () => {
  const checks = [null, { tm: 'clear' }, { tm: 'conflict' }, { docs: true }, { level: 'ok' }, { level: 'docs' }, { level: 'block' }, { tm: 'clear', level: 'docs' }];
  const xs = APPROVED.concat(NOT_APPROVED).map(xOf).concat(['Disney Stitch Hoodie', 'Stanley Cup Dupe 40oz', 'Vitamin C Serum', 'LED Face Mask', 'Pepper Spray', 'Flea Comb'].map((t) => name(t)));
  for (const x of xs) {
    for (const c of checks) assert.strictEqual(blockedBy(blocks(x), c), verdict(x, c).level === 'block', `${x.title} with ${JSON.stringify(c)}`);
    const words = [x.copy, 'Cures back pain, heals eczema, clinically proven. Pfefferspray, CBD, Disney, vape, supplement.', ''];
    const at = words.map((copy) => verdict({ ...x, copy }).level === 'block');
    assert.deepStrictEqual(at, at.map(() => at[2]), `${x.title}: the ad's words change no block`);
  }
  // The ad's words do add a caution: claims are docs. Beside a health block they are not repeated.
  assert.deepStrictEqual(reasonKeys(verdict(name('TENS Pain Relief Device', { p: { electric: 0.97, medical: 0.95 } }))), ['medical', 'ce'], 'no claims beside the medical block');
  assert.deepStrictEqual(reasonKeys(verdict(name('Posture Corrector', { copy: 'Cures back pain' }))), ['claims']);
  const massager = verdict(name('Shiatsu Foot Massager', { copy: 'Relieves foot pain in 10 minutes' }));
  assert.deepStrictEqual([massager.level, reasonKeys(massager)], ['docs', ['claims', 'ce']]);
  assert.strictEqual(massager.reasons[0].adhit, 'relieves');
});

// ---------------------------------------------------------------------------
// The word lists
// ---------------------------------------------------------------------------

test('restricted words in English, Dutch and German block by the name alone; compounds and accents too', () => {
  const cases = [
    ['Vitamin D3 Capsules', 'eat'], ['Voedingssupplement magnesium', 'eat'], ['Nahrungsergänzungsmittel Vitamin D', 'eat'], ['Kollagen Pulver', 'eat'],
    ['Vitamin C Face Serum', 'cosmetics'], ['Gezichtscrème met SPF', 'cosmetics'], ['Nachtcreme mit Retinol', 'cosmetics'], ['Tandenbleekset met LED', 'cosmetics'], ['Zahnaufhellungsstreifen', 'cosmetics'],
    ['Eau de Parfum Oud 100ml', 'cosmetics'], ['Duschgel Kokos', 'cosmetics'], ['Natuurlijke zeep lavendel', 'cosmetics'],
    ['Knee Pain Brace', 'medical'], ['Rugpijn kussen', 'medical'], ['Rückenschmerzen Gürtel', 'medical'], ['Anti-Snoring Mouthpiece', 'medical'], ['Anti-snurk neusclip', 'medical'], ['Schnarchstopper', 'medical'],
    ['Blood Pressure Monitor', 'device'], ['Bloeddrukmeter pols', 'device'], ['Blutdruckmessgerät Handgelenk', 'device'], ['IPL Hair Removal', 'device'], ['Coloured Contact Lenses', 'device'],
    ['Flea and Tick Collar for Dogs', 'pet_med'], ['Vlooienband kat', 'pet_med'], ['Flohhalsband für Katzen', 'pet_med'], ['Dog Dewormer Tablets', 'pet_med'],
    ['Pepper Spray Keychain', 'weapon'], ['Pepperspray sleutelhanger', 'weapon'], ['Pfefferspray', 'weapon'], ['Butterfly Knife', 'weapon'], ['Vlindermes', 'weapon'], ['Schlagring', 'weapon'], ['Stun Gun Flashlight', 'weapon'],
    ['Disposable Vape 6000', 'regulated'], ['E-sigaret starterset', 'regulated'], ['CBD Oil 10%', 'regulated'], ['Lachgas tank', 'regulated'], ['Feuerwerk Batterie', 'regulated'], ['Vuurwerkpakket', 'eat', false],
    ['Detox Foot Pads', 'pseudo'], ['Afslankpleisters', 'pseudo'], ['Weight Loss Patch', 'pseudo'], ['Lymphdrainage Öl', 'pseudo'],
    ['Mosquito Repellent Spray', 'biocide'], ['Muggenspray DEET', 'biocide'], ['Hand Sanitizer 500ml', 'biocide'], ['Weed Killer Spray', 'biocide'],
    ['Disney Princess Dress', 'brand'], ['Pokémon Pikachu Lamp', 'brand'], ['Stanley Quencher Dupe', 'brand'], ['Labubu Keychain', 'brand'], ['1:1 Replica Watch', 'brand'],
    ['Bamboo Fiber Kids Plate Set', 'bamboo'], ['Bambusfaser Becher', 'bamboo'], ['Gift Card €50', 'digital'], ['Cadeaubon 25 euro', 'digital'], ['Sex Toy for Couples', 'adult'],
    // brought in by the 36 approvals: essential oils, hair growth, pet supplements and magnesium in Dutch and German
    ['Ätherische Öle Set 6 x 10 ml', 'cosmetics'], ['Ätherisches Öl Lavendel', 'cosmetics'], ['Etherische oliën set', 'cosmetics'], ['Essentiële olie eucalyptus', 'cosmetics'],
    ['Rozemarijn Haargroei Olie', 'cosmetics'], ['Haarwuchsmittel für Männer', 'cosmetics'], ['Oud Parfum voor Heren', 'cosmetics'],
    ['Gelenktabletten für Hunde', 'pet_med'], ['Vitaminen voor honden', 'pet_med'], ['Nahrungsergänzung für Katzen', 'pet_med'], ['Hip and Joint Supplement for Dogs', 'pet_med'],
    ['Magnesium Glycinaat 120 stuks', 'eat'], ['Magnesiumcitrat Kapseln', 'eat'], ['TENS Pijnverlichting Apparaat', 'medical'],
  ];
  for (const [t, k, want = true] of cases) {
    const v = verdict(name(t));
    if (!want) { assert.notStrictEqual(v.level, 'block', t); continue; }
    assert.strictEqual(v.level, 'block', `${t}: ${reasonKeys(v).join(', ')}`);
    assert.ok(reasonKeys(v).includes(k), `${t}: ${k} among ${reasonKeys(v).join(', ')}`);
    assert.ok(v.reasons.find((r) => r.k === k).hit, `${t}: the words it matched`);
  }
  // Docs in three languages
  for (const [t, k] of [['Oplaadbare nekverwarmer', 'battery'], ['Akku Staubsauger kabellos', 'battery'], ['Draadloze oordopjes Bluetooth', 'radio'], ['Kinderspielzeug Holz', 'kids'],
    ['Speelgoed auto', 'kids'], ['Drinkfles RVS', 'food'], ['Trinkflasche Edelstahl', 'food'], ['Koksmes Damast', 'blade'], ['Küchenmesser Set', 'blade'], ['Lijm voor hout', 'ship'],
    ['Elektrische eierkoker', 'food'], ['Eierkocher für 6 Eier', 'food'], ['Anti-kreuk spray', 'ship']]) {
    const v = verdict(name(t));
    assert.strictEqual(v.level, 'docs', `${t}: ${reasonKeys(v).join(', ')}`);
    assert.ok(reasonKeys(v).includes(k), `${t}: ${k}`);
  }
  // One reason, not two: a vitamin C serum is no food, a pet supplement is not food for people, pain relief is no lighting
  for (const [t, keys] of [['Vitamine C Serum voor het gezicht', ['cosmetics']], ['Vitamin C Serum Drops', ['cosmetics']], ['Gelenktabletten für Hunde', ['pet_med']],
    ['Vitaminen voor honden', ['pet_med']], ['Hip and Joint Supplement for Dogs', ['pet_med']], ['TENS Pijnverlichting Apparaat', ['medical']], ['Vitamine D3 1000 IE', ['eat']]]) {
    assert.deepStrictEqual(reasonKeys(verdict(name(t))), keys, t);
  }
});

test('sizes in English, Dutch and German, glued words too; a wireless bra needs a size and has no radio', () => {
  const sized = ['Steppweste für Herren', 'Sommerkleid mit Blumenmuster', 'Wasserdichte Winterjacke', 'Linnen overhemd heren', 'Satijnen pyjama set', 'Waterdichte outdoor jas heren',
    'Zomerjurk bloemen', 'Joggingbroek dames', 'Wandelschoenen heren', 'Laufschuhe Damen', 'Jogginghose Herren', 'Kanten bh-set', 'Naadloze lingerie set', 'Wireless Bra',
    'Wireless Push-Up Bra', 'Draadloze push-up bh', 'Slip-on sneakers dames'];
  for (const t of sized) {
    const v = verdict(name(t));
    assert.deepStrictEqual([v.level, v.returns.map((r) => r.k)], ['ok', ['sizing']], `${t}: ${reasonKeys(v).join(', ')}`);
  }
  for (const t of ['Kleiderbügel Samt 50 Stück', 'Schoenenrek 5 lagen', 'Garden Hose 30m', 'Ninja Turtles Figures', 'Western Saddle Pad']) {
    assert.ok(!verdict(name(t)).returns.some((r) => r.k === 'sizing'), t);
  }
});

test('everything the hunt\'s EU screen takes off the board is Block on the radar; its tools and look-alikes are not (two differences on purpose)', () => {
  // The titles of world.test.mjs: screenEU() and classify() take these off the board.
  const off = ['Vitamin C Face Serum', 'Retinol Night Cream', 'Teeth Whitening Strips', 'Purple Toothpaste', 'Hair Growth Oil', 'Collagen face mask', 'Gel Polish Kit', 'Gezichtscrème met SPF',
    'Nachtcreme mit Retinol', 'Crème de nuit anti-rides', 'Zonnebrandcrème SPF50', 'Eau de Parfum Oud 100ml', 'Parfum Homme Intense', 'TENS Unit Pain Relief', 'Knee Pain Brace', 'Sciatica Cushion',
    'Plantar Fasciitis Insoles', 'Rugpijn kussen', 'Rückenschmerzen Gürtel', 'Ceinture mal de dos', 'Blood Pressure Monitor', 'Anti-Snoring Mouthpiece', 'Acne Patches 72pcs', 'Flea and Tick Collar for Dogs',
    'Flohhalsband für Katzen', 'Dog Dewormer Tablets', 'Collier anti-puces chien', 'Calming Chews for Dogs', 'Collagen Capsules', 'Protein bar box', 'Gift Card', 'Collagen Capsules for Face',
    'Vitamin D3 Capsules', 'Food Grade Collagen Powder', 'Mushroom Coffee with Collagen', 'Collagen Coffee Creamer', 'Amla Superfruit Capsules', 'Collagen gummies', 'Vitamin C Powder', 'Kollagen Pulver',
    'Creatine monohydrate powder', 'Shipping & Order Protection', 'Geschenkgutschein 50'];
  for (const t of off) {
    assert.ok(screenEU(t).out || classify(t).out, `${t}: off the EU board`);
    assert.strictEqual(verdict(name(t)).level, 'block', t);
  }
  const stays = ['Posture Corrector Pro', 'Heated Neck Pillow', 'Pet Hair Remover Roller', 'Silk Sleep Mask', 'Shiatsu Foot Massager', 'Orthopedic Dog Bed', 'Facial Ice Roller', 'Back Stretcher',
    'Wrinkle Release Spray', 'Cordless Hair Straightener', 'Portable Air Conditioner', 'Makeup Brush Set', 'LED Face Mask', 'Lotion Dispenser', 'Perfume Atomizer Bottle', 'Car Perfume Diffuser',
    'Flea Comb for Cats', 'Tick Remover Tool', 'Ice Cream Maker', 'Electric Toothbrush', 'Foot Gel Pads', 'Stress Relief Toy', 'Sonnenschutz Auto Frontscheibe', 'Abnehmbarer Griff Pfanne',
    'Blush Pink Dress', 'Calming Dog Bed', 'Massagegerät', 'Gym Leggings', 'Memory foam pillow', 'Food processor 5L', 'Dog harness', 'Lamp shade', 'Tea towel set', 'Anti-cellulite leggings',
    'Running socks 3-pack', 'Adjustable dumbbells', 'Nasal strips', 'Glass jar'];
  for (const t of stays) assert.notStrictEqual(verdict(name(t)).level, 'block', t);
  // Kept on the board by the hunt, blocked here: IPL is a medical device in the EU (MDR Annex XVI), and pet food is papers, not a block.
  assert.strictEqual(screenEU('Pain-free hair removal IPL').out, '');
  assert.deepStrictEqual([verdict(name('Pain-free hair removal IPL')).level, reasonKeys(verdict(name('Pain-free hair removal IPL')))[0]], ['block', 'device']);
  assert.strictEqual(screenEU('Grain free dog food').out, '');
  assert.deepStrictEqual([verdict(name('Grain free dog food')).level, reasonKeys(verdict(name('Grain free dog food')))], ['docs', ['pet_eat']], 'Connor keeps pet food (2026-10-31)');
});

test('ordinary winners are not blocked by a word that only looks alike', () => {
  const ok = ['Wireless Bra', 'Plush Blanket', 'SPF 50 UV Sun Hat', 'E-book Reader Cover', 'Detox Water Bottle Fruit Infuser', 'Airsoft Target', 'Cigarette Case', 'Car Cigarette Lighter Adapter',
    'Sleep Eye Mask', 'Face Mask Cloth Reusable', 'Eye Gel Mask Cooling', 'Perfume Sample Vials Empty', 'Scalp Massager Shampoo Brush', 'Hair Removal Epilator', 'Mosquito Killer Lamp',
    'Stanley Knife', 'Yeti Plush', 'Crocs Charms', 'Case for AirPods Pro', 'Stanley Cup Straw Lids', 'Gift Card Holder', 'Printable Vinyl Sticker Paper', 'Capsule Coffee Machine', 'Pill Box Weekly',
    'Protein Shaker Bottle', 'Gummy Bear Mold', 'Foundation Brush', 'Toner Cartridge', 'Mascara Wands Disposable', 'Self Tanning Mitt', 'Knife Sharpener 3-Stage', 'Indestructible Dog Chew Toy',
    'Durchmesser 28 cm Pfanne', 'Messenger Bag', 'Accurate Kitchen Scale', 'Electric Blue Hoodie', 'Baby Pink Hoodie', 'Dog Shampoo', 'Paw Balm for Dogs', 'Phone Ring Holder', 'Shoe Rack 5 Tier'];
  for (const t of ok) assert.notStrictEqual(verdict(name(t)).level, 'block', `${t}: ${reasonKeys(verdict(name(t))).join(', ')}`);
  assert.deepStrictEqual(reasonKeys(verdict(name('Wireless Bra'))), [], 'no radio in a bra without an underwire');
});

// ---------------------------------------------------------------------------
// Jev's answers, your checks, payments, customs
// ---------------------------------------------------------------------------

test('Jev\'s answers: its traits are reasons; "not physical" blocks; a category counts only where Jev gave no answer; the TikTok tab\'s blockers; a launch card\'s risks', () => {
  assert.deepStrictEqual(RISK_TRAITS.slice().sort(), TRAITS.filter((t) => t.group === 'rules' || t.group === 'blockers').map((t) => t.k).sort(), 'the same questions as jev-questions.mjs');
  assert.deepStrictEqual(BLOCKERS, TRAITS.filter((t) => t.group === 'blockers').map((t) => t.k));
  const jev = (p, main = '', sub = '') => name('Product', { p, main, sub });
  const keys = (x) => verdict(x).reasons.map((r) => r.k).concat(verdict(x).returns.map((r) => r.k));
  assert.deepStrictEqual(keys(jev({ people: 0.9 })), ['eat']);
  assert.deepStrictEqual(keys(jev({ animals: 0.6 })), ['pet_eat']);
  assert.deepStrictEqual(keys(jev({ skin: 0.5 })), ['cosmetics'], '0.5 is a yes');
  assert.deepStrictEqual(keys(jev({ skin: 0.49, face: 0.8 })), ['cosmetics']);
  assert.deepStrictEqual(keys(jev({ physical: 0.2 })), ['digital']);
  assert.deepStrictEqual(keys(jev({ physical: 0.9, brand: 0.7, electric: 0.9, kids: 0.8, foodcontact: 0.6, medical: 0.7, restricted: 0.9, sizing: 0.9, fragile: 0.8, bulky: 0.7 })),
    ['brand', 'claims', 'ce', 'kids', 'food', 'ship', 'sizing', 'fragile', 'bulky'], 'blockers first, return risks after');
  assert.strictEqual(verdict(jev({ medical: 0.95 })).level, 'docs', "Jev's medical answer (it may be the ad): a claims caution, not a block");
  const p = verdict(jev({ people: 0.97 })).reasons[0];
  assert.deepStrictEqual([p.from, p.p, p.pay], [['jev'], 97, ''], 'food from Jev: no Shopify flag (that is for supplements)');
  // The category only where the question was not answered
  assert.deepStrictEqual(keys(jev(null, 'Beauty and personal care', 'Skincare')), ['cosmetics']);
  assert.deepStrictEqual(keys(jev({ skin: 0.1 }, 'Beauty and personal care', 'Skincare')), [], 'Jev said it goes on no skin');
  assert.deepStrictEqual(keys(jev(null, 'Food and supplements', 'Food and snacks')), ['eat']);
  assert.deepStrictEqual(keys(jev(null, 'Health and pain relief', 'Massagers')), ['claims']);
  assert.deepStrictEqual(keys(jev(null, 'Pets', 'Food and treats')), ['pet_eat']);
  assert.deepStrictEqual(verdict(jev(null, 'Pets', 'Food and treats')).reasons[0].cat, 'Pets › Food and treats');
  // TikTok: its blockers and its category
  const tt = (blockers, cat = '') => fromTikTok({ id: '1', title: 'Thing', url: 'https://www.tiktok.com/shop/pdp/1', blockers, cat });
  assert.deepStrictEqual(verdict(tt('electric skin')).reasons.map((r) => r.k), ['cosmetics', 'ce']);
  assert.deepStrictEqual(verdict(tt('electric skin')).reasons.map((r) => [r.from, r.p]), [[['jev'], undefined], [['jev'], undefined]], "the tab keeps Jev's yes, not a percentage")
  assert.deepStrictEqual(verdict(tt('', 'Beauty and personal care')).level, 'ok', 'read by Jev, nothing flagged');
  assert.deepStrictEqual(verdict(tt(null, 'Food and supplements')).level, 'block', 'never read by Jev: its category tells');
  assert.strictEqual(keyOf(tt('')), 'tiktok:1');
  // A launch card: its risk keys are Jev's yes answers
  const facts = { source: 'eu', id: '9001', title: 'Pod', product: 'https://pod.test/products/pod', jev: { main: 'Home', sub: '' }, risks: [{ k: 'electric' }, { k: 'brand' }] };
  assert.deepStrictEqual(verdict(fromFacts(facts)).reasons.map((r) => r.k), ['brand', 'ce']);
  assert.deepStrictEqual(verdict(fromFacts({ ...facts, risks: [{ k: 'digital' }] })).reasons.map((r) => r.k), ['digital']);
  assert.strictEqual(keyOf(fromFacts(facts)), 'page:pod.test/products/pod');
  assert.strictEqual(keyOf(fromFacts({ source: 'tiktok', id: '17', title: 'X', risks: [{ k: 'kids' }], jev: { main: 'Baby and kids', sub: '' } })), 'tiktok:17');
  assert.strictEqual(verdict(fromFacts({ source: 'tiktok', id: '17', title: 'X', risks: [{ k: 'kids' }], jev: { main: 'Baby and kids', sub: '' } })).level, 'docs');
  assert.strictEqual(verdict(name('Thing')).jev, false, 'no Jev answer: the card says the radar read the name only');
});

test('your checks: a clear trademark takes the brand block off, a conflict blocks, documents tick the docs off, your call wins; only valid fields are kept', () => {
  const stitch = name('Lilo & Stitch Plush Toy');
  assert.deepStrictEqual([verdict(stitch).level, verdict(stitch, { tm: 'clear' }).level], ['block', 'docs'], 'cleared: what is left is a toy');
  assert.strictEqual(verdict(stitch, { tm: 'clear' }).reasons.find((r) => r.k === 'brand').level, 'off');
  const lamp = name('LED Sunset Lamp');
  const conflict = verdict(lamp, { tm: 'conflict' });
  assert.deepStrictEqual([conflict.level, conflict.reasons[0].k, conflict.pay], ['block', 'tm', 'Counterfeit products']);
  const done = verdict(lamp, { docs: true });
  assert.deepStrictEqual([done.level, done.radar, done.auto, done.reasons.map((r) => r.level)], ['ok', 'ok', 'docs', ['done']], 'documents received: nothing open');
  assert.deepStrictEqual(done.ask, [["Label: the maker's name and address, model or batch number", '产品标签：制造商名称和地址、型号或批号']], 'nothing left to ask but the label');
  const mine = verdict(name('Vitamin C Serum'), { level: 'ok', note: 'EU supplier with a CPNP number' });
  assert.deepStrictEqual([mine.level, mine.radar, mine.mine, mine.check.note], ['ok', 'block', true, 'EU supplier with a CPNP number'], 'your call, the radar\'s stays visible');
  assert.strictEqual(verdict(lamp, { level: 'block' }).level, 'block');
  assert.strictEqual(cleanCheck({ tm: 'maybe', docs: 'yes', level: 'great', note: '' }), null, 'nothing valid: no check');
  assert.deepStrictEqual(cleanCheck({ tm: 'clear', docs: true, level: 'docs', note: ' a\u0000b '.repeat(1), at: '2026-11-01T00:00:00.000Z', extra: 1 }),
    { tm: 'clear', docs: true, level: 'docs', note: 'a b', at: '2026-11-01T00:00:00.000Z' });
  assert.strictEqual(cleanCheck({ note: 'x'.repeat(400) }).note.length, 300);
});

test('every verdict: GPSR and customs, the documents to ask for (in English and Chinese), TMview for the brand or the shop; payments; €150 and IOSS', () => {
  const v = verdict(fromAd(cardOf(APPROVED.find((p) => p.title.startsWith('Portable Blender')))));
  assert.match(v.gpsr, /^GPSR \(since 13 Dec 2024\): an EU responsible person/);
  assert.match(v.customs, /about €5 an order \(€3 duty a parcel under €150 from 1 Jul 2026, €2 handling an item line from 1 Nov 2026\)/);
  assert.deepStrictEqual(v.ask.map((x) => x[0]), ['CE declaration of conformity (EMC, RoHS)', 'Test reports (EMC; LVD if it plugs in)', 'UN38.3 test summary', 'MSDS for the battery',
    'Battery capacity in Wh', 'Food-contact declaration of compliance (EU 1935/2004, EU 10/2011)', 'LFGB migration test report', "Label: the maker's name and address, model or batch number"]);
  const text = supplierRequest(v, 'Portable Blender');
  assert.match(text, /^Hello, before I order "Portable Blender": could you send these documents\?\n1\. CE declaration of conformity/);
  assert.match(text, /您好，下单前请提供此产品的以下文件：\n1\. CE 符合性声明（EMC、RoHS）[\s\S]*3\. UN38\.3 测试摘要/);
  assert.match(v.tm.url, /^https:\/\/www\.tmdn\.org\/tmview\/#\/tmview\/results\?.*basicSearch=Blender%20USB%20Rechargeable$/, 'its first words, without the generic ones');
  assert.deepStrictEqual([v.tm.shop, v.tm.status], ['blendgo', '']);
  assert.match(v.tm.shopUrl, /basicSearch=blendgo$/);
  assert.strictEqual(verdict(name('PawPal Self-Cleaning Brush')).tm.q, 'PawPal', 'a brand-like word');
  assert.strictEqual(verdict(name('Disney Princess Dress')).tm.q, 'disney', 'the brand it names');
  assert.strictEqual(verdict(fromTikTok({ id: '5', title: 'GLOWUP Lip Oil', shop: 'Glow Up Store', url: 'https://www.tiktok.com/shop/pdp/5', blockers: '' })).tm.shop, 'Glow Up Store');
  // Payments: Shopify's prohibited groups
  for (const [t, pay] of [['Disposable Vape', 'Regulated or illegal products'], ['Pepper Spray', 'Regulated or illegal products'], ['Vibrator', 'Adult products'], ['Detox Foot Pads', 'Pseudo pharmaceuticals'],
    ['Collagen Capsules', 'Pseudo pharmaceuticals'], ['Protein Powder Vanilla', 'Pseudo pharmaceuticals'], ['Nike Air Dupe Sneakers', 'Counterfeit products'], ['Protein bar box', ''], ['Energy Drinks 24 pack', ''], ['Vitamin C Serum', '']]) {
    assert.strictEqual(verdict(name(t)).pay, pay, t);
  }
  // IOSS: only up to €150 before VAT; a rough rate per currency
  const ioss = (price, cur) => verdict(name('Garden Bench', { price, cur })).returns.some((r) => r.k === 'ioss');
  // €179 incl. 21% VAT is €148 before it; $199 is about €183, so €151
  assert.deepStrictEqual([ioss(179, 'EUR'), ioss(185, 'EUR'), ioss(189, 'USD'), ioss(199, 'USD'), ioss(299, 'AUD'), ioss(360, 'AUD'), ioss(null, 'EUR'), ioss(500, 'XXX')], [false, true, false, true, false, true, false, false]);
  assert.strictEqual(verdict(name('Garden Bench', { price: 185, cur: 'EUR' })).level, 'ok', 'a return risk, not a block');
});

test('keyOf: the product page (www, a locale, the query and the case do not matter), else the ad; a check follows the product, not the ad', () => {
  const k = (product, id = '42') => keyOf(name('X', { product, id }));
  assert.strictEqual(k('https://www.Shop.test/en/products/Pod-Pillow?variant=1#x'), 'page:shop.test/products/pod-pillow');
  assert.strictEqual(k('https://shop.test/collections/a/products/pod-pillow'), 'page:shop.test/products/pod-pillow');
  assert.strictEqual(k('https://shop.test/'), 'ad:42', 'a home page: the ad');
  assert.strictEqual(k('http://shop.test/products/pod'), 'ad:42', 'only https links count, as on the card');
  assert.strictEqual(k('https://shop.test/products/' + 'a'.repeat(400)), 'ad:42');
});

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

test('/risk.js and /api/risk need the PIN; /risk.js is the kit as a script', async () => {
  const env = await seededEnv();
  const anon = (path, init) => handle(new Request(ORIGIN + path, init), env, { now: NOW });
  assert.strictEqual((await anon('/risk.js')).status, 401);
  assert.strictEqual((await anon('/api/risk')).status, 401);
  assert.strictEqual((await anon('/api/risk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"9001","tm":"clear"}' })).status, 401);
  const s = await session(env);
  const js = await s.call('/risk.js');
  assert.strictEqual(js.status, 200);
  assert.strictEqual(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.strictEqual(js.headers.get('cache-control'), 'no-store');
  assert.strictEqual(await js.text(), RISK_JS);
  assert.strictEqual((await s.call('/risk.js', { method: 'POST' })).status, 405);
  assert.strictEqual((await s.call('/api/risk', { method: 'PUT' })).status, 405);
  assert.deepStrictEqual(await s.get('/api/risk'), { checks: {} });
  assert.strictEqual(env.db.prepare("SELECT COUNT(*) AS n FROM state WHERE key LIKE 'risk:%'").get().n, 0);
});

test('POST /api/risk: a check is a state row by product page; fields merge and come back out; an empty check goes; bad input and other sites are refused', async () => {
  const env = await seededEnv();
  const s = await session(env);
  const row = (k) => { const r = env.db.prepare('SELECT value, updated_at FROM state WHERE key = ?').get('risk:' + k); return r ? { ...JSON.parse(r.value), at: r.updated_at } : null; };
  // 9001 is Posture Corrector Pro on shop1.test/products/item-1
  const a = await risk(s, { id: '9001', tm: 'clear', note: 'TMview: no EU mark for this name' });
  assert.deepStrictEqual([a.status, a.key, a.check], [200, 'page:shop1.test/products/item-1', { tm: 'clear', docs: false, level: '', note: 'TMview: no EU mark for this name', at: new Date(NOW).toISOString() }]);
  assert.deepStrictEqual(row(a.key), { tm: 'clear', note: 'TMview: no EU mark for this name', title: 'Posture Corrector Pro', at: new Date(NOW).toISOString() });
  const b = await risk(s, { id: '9001', docs: true });
  assert.deepStrictEqual([b.check.tm, b.check.docs, b.check.note], ['clear', true, 'TMview: no EU mark for this name'], 'one field at a time: the others stay');
  assert.deepStrictEqual((await risk(s, { id: '9001', tm: '' })).check, { tm: '', docs: true, level: '', note: 'TMview: no EU mark for this name', at: new Date(NOW).toISOString() }, "'' takes it back");
  await risk(s, { id: '9001', docs: false, note: '' });
  assert.strictEqual(row(a.key), null, 'nothing left: the row goes');
  assert.deepStrictEqual((await risk(s, { id: '9001', level: 'block' })).check.level, 'block');
  // TikTok products by their id
  await env.DB.prepare('INSERT INTO tiktok_products (id, title, url, sold_us) VALUES (?, ?, ?, ?)').bind('1700000000000000009', 'Neck Fan', 'https://www.tiktok.com/shop/pdp/9', 100).run();
  const t = await risk(s, { tiktok: '1700000000000000009', tm: 'conflict' });
  assert.deepStrictEqual([t.status, t.key, t.check.tm], [200, 'tiktok:1700000000000000009', 'conflict']);
  assert.deepStrictEqual(Object.keys((await s.get('/api/risk')).checks).sort(), ['page:shop1.test/products/item-1', 'tiktok:1700000000000000009']);
  // Refused
  for (const [body, error, status = 400] of [[{ id: '9001' }, 'Nothing to save'], [{ id: '9001', tm: 'yes' }, 'Bad trademark check'], [{ id: '9001', docs: 'true' }, 'Bad docs'],
    [{ id: '9001', level: 'maybe' }, 'Bad level'], [{ id: '9001', note: 5 }, 'Bad note'], [{ id: "9001' OR '1'='1", tm: 'clear' }, 'Bad product'], [{ tiktok: 'abc', tm: 'clear' }, 'Bad product'],
    [{ id: '424242', tm: 'clear' }, 'Unknown product', 404], [{ tiktok: '1', tm: 'clear' }, 'Unknown product', 404], [[1], 'Bad JSON']]) {
    assert.deepStrictEqual(await risk(s, body), { status, error }, JSON.stringify(body));
  }
  assert.strictEqual((await s.post('/api/risk', { id: '9001', tm: 'clear' }, { origin: 'https://evil.test' })).status, 403);
  assert.strictEqual((await s.post('/api/risk', { id: '9001', tm: 'clear' }, { 'content-type': 'text/plain' })).status, 415);
  assert.strictEqual((await s.post('/api/risk', 'not json')).status, 400);
  assert.strictEqual((await s.post('/api/risk', { id: '9001', note: 'x'.repeat(3000) })).status, 413);
  await risk(s, { id: '9001', note: "'); DELETE FROM state; --" });
  assert.strictEqual(row('page:shop1.test/products/item-1').note, "'); DELETE FROM state; --", 'kept as text');
  assert.ok(env.db.prepare("SELECT 1 FROM state WHERE key = 'last_run'").get(), 'nothing else in state changed');
  assert.ok(!env.DB.log.some((l) => /DELETE FROM state;|shop1\.test|Posture/.test(l.sql)), 'user text never in the SQL');
});

test('?risk=hide: Block products leave the Inbox and Browse of both tabs (counts too), ✓ keeps them with the levels of all you approved; no risk param: as before', async () => {
  const env = await seededEnv();
  await loadApproved(env, NOW, { approve: 'none', others: true });
  const s = await session(env);
  const ids = (j) => j.ads.map((a) => a.id);
  // EU: 27 seeded products (one of them blocked: Anti-Snoring Mouthpiece, 9011) and 29 of the 36 (P16 and P35 are one product),
  // the 9 restricted ones among them
  const all = await s.get('/api/ads?view=all&limit=100');
  const hid = await s.get('/api/ads?view=all&limit=100&risk=hide');
  assert.deepStrictEqual([all.total, hid.total], [56, 46]);
  assert.deepStrictEqual(ids(all).filter((id) => !ids(hid).includes(id)).sort(), ['8010', '8013', '8017', '8020', '8024', '8026', '8028', '8029', '8033', '9011'],
    'P10, P13, P17, P20, P24, P26, P28, P29, P33 and the anti-snoring mouthpiece');
  assert.deepStrictEqual([hid.risk.hide, hid.risk.hidden, all.risk.hide, all.risk.hidden], [true, 10, false, 0]);
  assert.deepStrictEqual([hid.counts.all, hid.counts.inbox, all.counts.all, all.counts.inbox], [46, 46, 56, 53], 'the counts follow');
  // Without the radar the Inbox leaves out the 3 that Jev says people or animals take (P17, P28, P29); the radar all 9
  const inbox0 = await s.get('/api/ads?view=inbox&limit=100');
  assert.deepStrictEqual(ids(all).filter((id) => !ids(inbox0).includes(id)).sort(), ['8017', '8028', '8029']);
  const inbox = await s.get('/api/ads?view=inbox&limit=100&risk=hide');
  assert.ok(inbox.ads.every((a) => !ids(all).filter((id) => !ids(hid).includes(id)).includes(a.id)) && inbox.total === 46);
  // Outside the EU: 4 of the 36 and 2 the hunt found there (never approved), both restricted
  const wAll = await s.get('/api/ads?scope=world&view=all&limit=100');
  const wHid = await s.get('/api/ads?scope=world&view=all&limit=100&risk=hide');
  assert.deepStrictEqual([wAll.total, wHid.total, wHid.risk.hidden, wHid.counts.world, wHid.counts.eu], [6, 4, 2, 4, 46]);
  assert.deepStrictEqual(ids(wAll).filter((id) => !ids(wHid).includes(id)).sort(), ['7037', '7038']);
  // The board's cards carry the same verdict the filter used
  for (const a of all.ads.concat(wAll.ads)) assert.strictEqual(verdict(fromAd(a)).level === 'block', !ids(hid).concat(ids(wHid)).includes(a.id), a.title);
  // ✓: approve the 34 of the 36 on the board: they all stay in ✓ (33 cards: P16 and P35 are one), with their levels
  for (const p of APPROVED.filter((x) => x.source !== 'tiktok')) assert.strictEqual((await s.post('/api/hide', { ad_id: idOf(p), status: 'seen' })).status, 200);
  const made = await s.get('/api/ads?view=made&risk=hide');
  assert.strictEqual(made.total, 33, 'nothing hidden in ✓');
  assert.deepStrictEqual(made.risk.levels, { block: 9, docs: 8, ok: 16 }, 'with the 2 from TikTok (Docs, OK) and P35: 9 Block, 9 Docs and 18 OK of 36');
  assert.strictEqual(made.ads.filter((a) => verdict(fromAd(a)).level === 'block').length, 9);
  assert.strictEqual((await s.get('/api/ads?view=made')).risk.levels.block, 9, 'the levels with or without hiding');
  const tt = (await s.get('/api/tiktok')).products;
  assert.deepStrictEqual(tt.filter((t) => verdict(fromTikTok(t)).level === 'block').map((t) => t.title), ['Lilo & Stitch Plush Toy 30cm'], 'the TikTok tab: its list on the phone, the same rules');
  // Without ?risk the API is as it was
  assert.deepStrictEqual(Object.keys(all.risk), ['hide', 'hidden', 'checks']);
});

test('your check moves a product: your call OK brings a blocked one back, a trademark conflict hides one; /api/ads sends the checks of its page; the CSV follows ?risk=hide', async () => {
  const env = await seededEnv();
  const s = await session(env);
  const browse = async () => (await s.get('/api/ads?view=all&limit=100&risk=hide')).ads.map((a) => a.id);
  assert.ok(!(await browse()).includes('9011'));
  const ok = await risk(s, { id: '9011', level: 'ok' });
  assert.strictEqual(ok.key, 'page:shop11.test/products/item-11');
  const back = await s.get('/api/ads?view=all&limit=100&risk=hide');
  assert.ok(back.ads.some((a) => a.id === '9011'), 'your call: back in Browse');
  assert.deepStrictEqual(back.risk.checks, { 'page:shop11.test/products/item-11': ok.check }, 'its check with the page');
  assert.strictEqual(back.risk.hidden, 0);
  await risk(s, { id: '9005', tm: 'conflict' }); // Cooling Dog Mat
  assert.ok(!(await browse()).includes('9005'), 'a trademark conflict blocks');
  const csv = async (q) => (await (await s.call('/export.csv?view=all' + q)).text()).split('\r\n').filter(Boolean).slice(1).map((l) => l.split(',')[0]);
  assert.deepStrictEqual([(await csv('')).length, (await csv('&risk=hide')).length], [27, 26]);
  assert.ok(!(await csv('&risk=hide')).includes('9005') && (await csv('')).includes('9005'));
  // Take your call back: blocked again
  await risk(s, { id: '9011', level: '' });
  assert.ok(!(await browse()).includes('9011'));
});

test('D1 reads: your checks are one read of the risk rows (an index range on state), and the board reads no table again for them', async () => {
  const env = await seededEnv();
  const s = await session(env);
  await s.get('/api/ads?view=all&risk=hide');
  const plan = env.db.prepare('EXPLAIN QUERY PLAN ' + CHECKS_SQL).all().map((r) => r.detail).join(' ');
  assert.match(plan, /SEARCH state USING INDEX sqlite_autoindex_state_1 \(key>\? AND key<\?\)/, plan);
  const before = env.DB.log.length;
  await s.get('/api/ads?view=all&risk=hide&offset=40');
  const sql = env.DB.log.slice(before).map((l) => l.sql);
  assert.strictEqual(sql.filter((q) => q === CHECKS_SQL).length, 1);
  assert.ok(!sql.some((q) => /FROM winners w$/.test(q.trim())), 'no new scan of the winners');
});

test('rowInput: the Worker reads a board row as its card does (toAd), for every seeded and fixture product', async () => {
  const env = await seededEnv();
  await loadApproved(env, NOW, { approve: 'none', others: true });
  const s = await session(env);
  await s.get('/api/ads'); // the board reads its tables
  const { snapshot } = await import('../worker/src/app.mjs');
  const list = products(await snapshot(env.DB, NOW), [], [], NOW);
  assert.ok(list.k.length >= 27 + 29 + 6, 'the seeded products and the fixture\'s');
  for (const r of list.k) {
    const card = fromAd(toAd(r));
    assert.strictEqual(keyOf(rowInput(r)), keyOf(card), r.product_title);
    assert.deepStrictEqual(blocks(rowInput(r)), blocks(card), r.product_title);
    assert.strictEqual(rowBlocked(r, new Map()), verdict(card).level === 'block', r.product_title);
  }
  // Kept per Jev answer and name: another name on the same answer is read again, the first one keeps its own answer
  const r0 = list.k.find((r) => r.jev && !rowBlocked(r, new Map()));
  assert.strictEqual(rowBlocked({ ...r0, product_title: 'Pepper Spray Keychain' }, new Map()), true);
  assert.strictEqual(rowBlocked(r0, new Map()), false);
  assert.strictEqual(rowBlocked(r0, new Map([[keyOf(rowInput(r0)), { level: 'block', at: '' }]])), true, 'with your call on it');
});

test('the reasons read plainly: every reason has a short label and a sentence; the kit has no reason the board cannot name', () => {
  for (const k of Object.keys(LEVEL).concat(['sizing', 'fragile', 'bulky', 'ioss'])) {
    assert.ok(SHORT[k] && SHORT[k].length <= 26, `${k}: ${SHORT[k]}`);
    assert.ok(TEXT[k] && /^[A-Z]/.test(TEXT[k]) && !/\.$/.test(TEXT[k]), `${k}: ${TEXT[k]}`);
  }
  assert.ok(!Object.values(TEXT).some((t) => /reach/i.test(t)), 'no "reach" (the Outside EU cards never say it)');
  const kit = riskKit();
  assert.deepStrictEqual(Object.keys(kit.LEVEL), Object.keys(LEVEL));
  const all = APPROVED.concat(NOT_APPROVED).map((p) => verdict(xOf(p)));
  assert.ok(all.every((v) => v.reasons.every((r) => r.text && r.short) && v.returns.every((r) => r.text && r.short)));
  assert.strictEqual(auto(name('Vitamin C Serum')).level, 'block');
  assert.strictEqual(finish(auto(name('Vitamin C Serum')), null).level, 'block');
});
