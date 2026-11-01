/*
 * What Jev is asked about a product and its ad, and how the board names the answers. Where each question comes from:
 * research/2026-11-01-jev-ad-check/CRITERIA.md. Mostly practitioners, no controlled study: these describe, they do not prove.
 */
export const VERSION = 2;

export const TAXONOMY = {
  Pets: ['Harnesses, leashes and collars', 'Beds and blankets', 'Car travel', 'Carriers and bags', 'Cat toys', 'Dog toys', 'Litter and litter boxes', 'Fountains and feeders', 'Grooming', 'Hair removal', 'Clothing', 'Training and behaviour', 'Food and treats', 'Supplements and dental care', 'Other pets'],
  'Sleep and comfort': ['Pillows', 'Blankets and weighted blankets', 'Sheets and toppers', 'Sleep masks and sound', 'Seat cushions', 'Other sleep'],
  'Health and pain relief': ['Massagers', 'Posture and back', 'Joint and foot support', 'Heat and cold therapy', 'Light therapy', 'Monitors and measuring', 'Other health'],
  'Fitness': ['Home gym gear', 'Recovery tools', 'Sports accessories', 'Gymwear', 'Other fitness'],
  'Beauty and personal care': ['Skincare', 'Face tools', 'Makeup', 'Hair removal for people', 'Hair care and styling', 'Nails', 'Teeth', 'Fragrance', 'Shaving and grooming for men', 'Other beauty'],
  Home: ['Cleaning tools', 'Vacuums and floor care', 'Laundry', 'Air quality and scent', 'Heating and cooling', 'Lighting', 'Furniture covers', 'Storage and organizing', 'Bathroom', 'Decor and wall art', 'Windows and doors', 'Other home'],
  Kitchen: ['Gadgets', 'Cookware and knives', 'Coffee and drinks', 'Food storage and lunch boxes', 'Water bottles', 'Other kitchen'],
  'Baby and kids': ['Baby sleep and monitors', 'Strollers and carriers', 'Feeding', 'Learning toys', 'Outdoor toys and bikes', 'Kids clothing', 'Other kids'],
  Clothing: ['Women', 'Men', 'Underwear and shapewear', 'Socks', 'Heated clothing', 'Outerwear', 'Other clothing'],
  Shoes: ['Comfort and orthopedic', 'Barefoot', 'Slippers', 'Other shoes'],
  'Jewelry and accessories': ['Necklaces', 'Bracelets and rings', 'Personalized jewelry', 'Bags and wallets', 'Sunglasses', 'Hats and scarves', 'Watches', 'Other accessories'],
  Car: ['Seat covers', 'Organizers', 'Cleaning', 'Phone holders', 'Dash cams and electronics', 'Other car'],
  Tech: ['Audio', 'Chargers and power', 'Wearables', 'Projectors and screens', 'Phone accessories', 'Smart home', 'Other tech'],
  'Outdoor and travel': ['Camping', 'Travel gear', 'Caravans and motorhomes', 'Fishing', 'Pool and beach', 'Other outdoor'],
  Garden: ['Tools and hoses', 'Solar and outdoor lights', 'Birds and wildlife', 'Plants and growing', 'Other garden'],
  'Tools and DIY': ['Power tools', 'Hand tools and sets', 'Other tools'],
  'Gifts and hobbies': ['Personalized gifts', 'Puzzles and games', 'Crafts and patterns', 'Books and learning', 'Other hobbies'],
  'Food and supplements': ['Supplements and vitamins', 'Food and snacks', 'Drinks', 'Other food'],
  Other: ['Services and digital', 'Anything else'],
};
export const SEP = ' > ';

const n = (k, group, label, q, yes, no) => ({ k, group, label, q, yes, no });
// k is kept in the answers; 0.5 or more is a yes.
export const TRAITS = [
  // Connor's board rules (CLAUDE.md).
  n('people', 'rules', 'People take', 'Is this product something a person eats, drinks or swallows?', 'Food, drink, supplements, vitamins, gummies, powders, teas, capsules, or anything else a person swallows.', 'Anything else, including devices, skincare, nose strips and nose sprays.'),
  n('animals', 'rules', 'Pets take', 'Is this product something an animal eats or takes?', 'Pet food, treats, chews or pet supplements.', 'Anything else, including pet toys, harnesses and beds.'),
  n('gymwear', 'rules', 'Gymwear', 'Is this product clothing made for working out?', 'Gym shorts, gym shirts, workout leggings, sports bras and other activewear.', 'Anything else, including shaping or cellulite leggings, running socks and home gym equipment.'),
  n('physical', 'rules', 'Physical product', 'Does this sell a physical product that someone receives?', 'A physical product that is shipped to the buyer.', 'A service, app, membership, gift card, digital download, or a general store offer without one product.'),
  n('face', 'rules', 'Goes on the face', 'Is this product rubbed or applied on the face?', 'Creams, serums, masks, makeup and other products put on the skin of the face.', 'Anything else, including tools that do not leave anything on the face.'),
  // Blockers (research/2026-10-25-25-videos, section 5).
  n('electric', 'blockers', 'Battery or electric', 'Does this product contain a battery or run on electricity?', 'It has a battery, plugs in, charges by USB or has electronics.', 'It has no battery and no electronics.'),
  n('skin', 'blockers', 'Cosmetics', 'Is this product applied to skin, hair, nails or teeth?', 'Creams, oils, serums, sprays, whitening products or other substances applied to the body.', 'Anything else, including tools and devices that leave nothing on the body.'),
  n('medical', 'blockers', 'Medical claim', 'Does the product or its ad claim to treat, cure or relieve a health condition?', 'It names a condition or symptom and says the product helps it, such as pain, anxiety, sleep disorders or inflammation.', 'It makes no health claim beyond comfort or looks.'),
  n('brand', 'blockers', 'Brand or copy risk', 'Does this use a famous brand or character, or look like a copy of a known branded product?', 'It shows a well-known logo or character, or copies a famous product.', 'It has its own or no brand, and copies no famous product.'),
  n('sizing', 'blockers', 'Sizing returns', 'Must the buyer pick a size, with a wrong fit likely to cause a return?', 'Clothing, shoes, harnesses, rings and other items that have to fit.', 'One size, or fit does not matter.'),
  n('fragile', 'blockers', 'Fragile', 'Does this product break easily in shipping?', 'Glass, ceramics or delicate parts.', 'It survives normal parcel handling.'),
  n('bulky', 'blockers', 'Big or heavy', 'Is this product big or heavy to ship?', 'It does not fit a small parcel or weighs more than about 2 kg.', 'It fits a small parcel and is light.'),
  n('restricted', 'blockers', 'Hard to ship', 'Is this product restricted or hard to ship by post?', 'Liquids, powders, aerosols, sharp blades, flammable items or large batteries.', 'None of these.'),
  n('kids', 'blockers', 'For children', 'Is this product made for children under 14?', 'Toys and products for babies or children, which fall under child safety rules.', 'It is for adults or pets.'),
  n('foodcontact', 'blockers', 'Touches food', 'Does this product touch food or drink?', 'Bottles, lunch boxes, cookware and kitchen tools.', 'It does not touch food or drink.'),
  n('hardsource', 'blockers', 'Hard to source', 'Would this product be hard to source from a normal supplier?', 'Custom made, unusual materials, patented, handmade or made to measure, so a standard factory or AliExpress listing would not offer it.', 'A similar item is likely available from ordinary suppliers.'),
  // What makes a product sell, according to the creators and guides.
  n('problem', 'product', 'Solves a real problem', 'Does this product solve a specific problem the buyer clearly feels?', 'It removes a physical pain, a daily hassle or something the buyer dislikes seeing.', 'It is mainly nice to have.'),
  n('wow', 'product', 'Wow factor', 'Would people stop and react on seeing this product?', 'It is surprising, clever or unlike what shops normally sell.', 'It looks ordinary.'),
  n('beforeafter', 'product', 'Visible result', 'Can the result be shown as a visible before and after?', 'The difference can be seen on camera.', 'The result cannot be seen.'),
  n('clear3s', 'product', 'Clear in 3 seconds', 'Can someone understand this product within 3 seconds without sound?', 'What it is and what it does is obvious from a picture or short clip.', 'It needs explaining.'),
  n('smalllight', 'product', 'Small and light', 'Is this product small, light and not fragile?', 'It fits a small parcel, is light and survives shipping.', 'It is big, heavy or delicate.'),
  n('repeat', 'product', 'Repeat purchase', 'Is this used up or replaced, so buyers come back?', 'Refills, consumables or parts that wear out.', 'One purchase lasts for years.'),
  n('upsell', 'product', 'Easy to upsell', 'Can this easily be sold in multiples, as a bundle or with add-ons?', 'A second unit, refills or matching extras make sense.', 'One is enough and nothing goes with it.'),
  n('generic', 'product', 'Generic item', 'Does this look like a generic item that many shops sell?', 'A common import with no visible difference from other listings.', 'It has a visible own design, brand or feature.'),
  n('impulse', 'product', 'Impulse buy', 'Would someone buy this on impulse from one ad at this price?', 'The price and need make a quick decision likely.', 'People would compare or think it over first.'),
  n('gift', 'product', 'Gift', 'Is this often bought as a gift?', 'Personal, seasonal or made for giving.', 'People mostly buy it for themselves.'),
  n('personal', 'product', 'Personalized', 'Is this personalized or made to order?', 'Names, photos or made to measure.', 'Every buyer gets the same item.'),
];
export const AD_TRAITS = [
  n('ad_clear', 'ad', 'Ad clear fast', 'Does the ad show what is sold and why within 3 seconds, without sound?', 'The product and the benefit are obvious at a glance.', 'You have to read or watch more to get it.'),
  n('ad_inuse', 'ad', 'Shows it in use', 'Does the ad show the product being used?', 'A person or pet uses it, or it is shown working.', 'It only shows the product itself or a graphic.'),
  n('ad_benefit', 'ad', 'States a benefit', 'Does the ad say what the buyer gains?', 'It names a result or benefit, not only features.', 'It only names the product or its features.'),
  n('ad_pain', 'ad', 'Names a pain', 'Does the ad name a pain or problem the buyer has?', 'It speaks about the problem.', 'It does not mention a problem.'),
  n('ad_proof', 'ad', 'Social proof', 'Does the ad show proof from other buyers?', 'Reviews, star ratings, customer numbers, testimonials or press.', 'None of these.'),
  n('ad_offer', 'ad', 'Shows an offer', 'Does the ad show a price, discount or special offer?', 'It shows one.', 'It does not.'),
  n('ad_urgency', 'ad', 'Urgency', 'Does the ad push to buy now?', 'A deadline, limited stock or a last-chance message.', 'None of these.'),
  n('ad_native', 'ad', 'Looks native', 'Does the ad look like a normal post rather than a polished ad?', 'Phone footage, a real person, a casual look.', 'A studio look or a designed banner.'),
  n('ad_textimage', 'ad', 'Text on image', 'Does the picture carry a readable text message?', 'A headline or message is readable in the picture.', 'The picture has no message in text.'),
  n('ad_audience', 'ad', 'Names the audience', 'Does the ad name who it is for?', 'For example dog owners, women over 50 or new parents.', 'It speaks to everyone.'),
];
export const CHOICES = {
  audience: { label: 'Audience', q: 'Who is the main buyer of this product?', options: ['Women', 'Men', 'Parents', 'Dog owners', 'Cat owners', 'Other pet owners', 'Older adults', 'Sports people', 'Drivers', 'Home owners', 'Gift givers', 'Everyone'] },
  problemtype: { label: 'Problem type', q: 'What kind of problem does this product mainly solve?', options: ['Physical pain', 'Appearance', 'Time or hassle', 'Cleaning or mess', 'Sleep', 'Stress or anxiety', 'Safety', 'Pet behaviour', 'Saving money', 'Boredom or fun', 'None'] },
  season: { label: 'Season', q: 'When does this product sell best?', options: ['All year', 'Christmas and gifting', 'Winter', 'Summer', 'Spring and garden', 'Back to school', 'Other moment'] },
};
export const AD_CHOICES = {
  ad_format: { label: 'Ad format', q: 'What kind of ad is this?', options: ['Product demo', 'Before and after', 'Problem and solution', 'Person talking to camera', 'Customer review', 'Lifestyle', 'Comparison', 'Offer banner', 'Plain product photo', 'Other'] },
  ad_hook: { label: 'Ad hook', q: 'How does this ad try to get attention first?', options: ['A question', 'A pain point', 'A transformation', 'A surprising claim', 'Social proof', 'A discount or urgency', 'A striking visual', 'No clear hook'] },
};
export const SCORES = {
  product_score: { label: 'Product score', q: 'Judge this product against: solves a felt problem, wow factor, understood in 3 seconds, small and light, room for margin at this price, and few blockers.', levels: ['Weak: almost none of these', 'Below average: one or two of these', 'Average: about half of these', 'Strong: most of these', 'Very strong: nearly all of these'] },
};
export const AD_SCORES = {
  ad_score: { label: 'Ad score', q: 'Judge this ad against: grabs attention at once, clear without sound, shows the product in use, names a pain or benefit, proof or offer, and looks native to the feed.', levels: ['Weak: almost none of these', 'Below average: one or two of these', 'Average: about half of these', 'Strong: most of these', 'Very strong: nearly all of these'] },
};
export const CATEGORIES = Object.entries(TAXONOMY).flatMap(([main, subs]) => subs.map((s) => main + SEP + s));
export const YES_AT = 0.5;

/** All questions in Jev's format. withAd: only when there is an ad to read. */
export function questions(withAd) {
  const out = { category: { type: 'choice', instructions: 'Which category and subcategory fit this product best?', criteria: Object.fromEntries(CATEGORIES.map((c) => [c, c])) } };
  for (const t of withAd ? [...TRAITS, ...AD_TRAITS] : TRAITS) out[t.k] = { type: 'noul', instructions: t.q, criteria: { true: t.yes, false: t.no } };
  for (const [k, c] of Object.entries(withAd ? { ...CHOICES, ...AD_CHOICES } : CHOICES)) out[k] = { type: 'choice', instructions: c.q, criteria: Object.fromEntries(c.options.map((o) => [o, o])) };
  for (const [k, s] of Object.entries(withAd ? { ...SCORES, ...AD_SCORES } : SCORES)) out[k] = { type: 'score', instructions: s.q, criteria: s.levels };
  return out;
}
