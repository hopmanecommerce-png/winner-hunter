/*
 * Audience engine, stage 2: read what customers wrote. Pure functions, no network.
 *
 *   tagStatement(text)   which kinds a statement is: pain, trigger, objection, outcome, intent, question (word lists)
 *   themesOf(items)      the pain / trigger / objection / outcome themes with counts and their best quotes
 *   situationsOf(items)  who is talking: dog owner, parent, caravan owner, gift giver… (self-descriptions, counted)
 *   phrasesOf(items)     the 2–4 word phrases customers repeat (customer words), counted once per statement
 *   claimsIn(text)       words that make a claim we may not make (medical, cosmetic, brands, fake scarcity)
 *   angleOf(adText)      what kind of hook a competitor ad opens with (multilingual)
 *
 * The word lists are English first: Reddit, TikTok and YouTube comments are pulled in English. Competitor ad copy can be
 * German, French, Dutch, Spanish or Italian, so angleOf and claimsIn also know those words. Jev (lib/audience-jev.mjs)
 * can label statements instead of the word lists; these lists are the fallback, so a card never depends on one vendor.
 *
 * Never inferred: a speaker's gender or age from their words ("my husband" says nothing reliable about who writes it).
 * Gender and age come only from Meta's reach data (lib/audience-meta.mjs).
 */

const rx = (src) => new RegExp(src, 'iu');
const any = (list) => rx(`(?<![\\p{L}\\p{N}])(?:${list.join('|')})(?![\\p{L}\\p{N}])`);

// ---------------------------------------------------------------------------
// Statement kinds
// ---------------------------------------------------------------------------
export const KINDS = ['pain', 'trigger', 'objection', 'outcome', 'intent', 'question'];

/** Themes per kind: [key, label, pattern]. The first theme that matches names the statement's theme for that kind. */
export const THEMES = {
  pain: [
    ['dirty', 'Gets dirty, slimy or gross', any(['slim(?:e|y)', 'gross', 'disgusting', 'dirty', 'filthy', 'grime', 'mou?ld(?:y)?', 'algae', 'film', 'gunk', 'nasty', 'bacteria', 'germs?', 'crumbs', 'scrub(?:bing)?'])],
    ['smell', 'Smells', any(['smell(?:s|y|ing)?', 'stinks?', 'stinky', 'odou?rs?', 'reeks?'])],
    ['hot', 'Too hot or sweaty', any(['too hot', 'overheat(?:ing|s)?', 'sweat(?:y|ing|s)?', 'night sweats', 'hot sleeper', 'burning up', 'heat ?wave', 'so hot', 'boiling'])],
    ['cold', 'Too cold', any(['too cold', 'freezing', 'so cold', 'chilly'])],
    ['sleep', 'Bad sleep', any(["can'?t sleep", 'cannot sleep', 'wake up', 'waking up', 'woke up', 'toss(?:ing)? and turn(?:ing)?', 'restless', 'tired all', 'exhausted', 'no sleep', 'sleepless', 'up all night'])],
    ['pain', 'Physical discomfort', any(['(?<!(?:a|such a|what a|be a|is a) )pain(?:ful)?(?! (?:to|in the))', 'hurts?', 'hurting', 'sore', 'aches?', 'aching', 'stiff', 'uncomfortable', 'discomfort', 'pinch(?:es|ing)?', 'rub(?:s|bing)? (?:raw|sores?)', 'chaf(?:e|ing)'])],
    ['mess', 'Mess, clutter or no space', any(['mess(?:y)?', 'clutter(?:ed)?', 'everywhere', 'no space', 'no room', 'tiny space', 'small space', 'tangled', 'spill(?:s|ed|ing)?', 'leak(?:s|ed|ing|y)?'])],
    ['falls', 'Slips, falls off or does not fit', any(['slips? off', 'slipping', 'falls? off', 'keeps falling', 'comes? off', 'pops? off', 'rides? up', "doesn'?t fit", "won'?t fit", 'never fits?', 'too short', 'too small', 'too big', 'wrong size', 'escape(?:s|d)?', 'backs? out'])],
    ['pull', 'Pulling, chewing or behaviour', any(['pull(?:s|ing)?', 'lunge(?:s|ing)?', 'chew(?:s|ed|ing)?', 'bark(?:s|ing)?', 'jump(?:s|ing)? on', 'destroy(?:s|ed)?', 'scratch(?:es|ing)? the'])],
    ['broke', 'Breaks or stops working', any(['broke(?:n)?', 'breaks', 'stopped working', 'died', 'dies', 'falls? apart', 'fell apart', 'cracked', 'ripped', 'torn', 'wore out', 'worn out', 'lasted (?:only )?\\d+'])],
    ['time', 'Takes time or effort', any(['takes forever', 'time[- ]consuming', 'hassle', 'a pain to', 'such a pain', 'chore', 'struggle', 'struggling', 'constantly (?:have|having|need|cleaning|washing|fixing|adjusting|refilling)',
      '(?:hard|difficult|impossible|annoying) to (?:clean|wash|find|get|put|take|use|fit|open|close|carry|keep|remove|install|adjust|fold|store)'])],
    ['money', 'Costs money over time', any(['waste of money', 'keep buying', 'replace(?:d)? (?:it|them) every', 'expensive to', 'costs? (?:me )?a fortune', 'vet bills?'])],
    ['worry', 'Worry or stress', any(['worr(?:y|ied|ies|ying)', 'scared', 'afraid', 'anxious', 'stress(?:ed|ful)?', 'panic', 'nervous', 'paranoid', 'terrified'])],
    ['annoy', 'Plain frustration', any(['hate', 'annoying', 'annoyed', 'frustrat(?:ing|ed|ion)', 'sick of', 'tired of', 'fed up', 'nightmare', 'drives? me (?:crazy|nuts)', 'ugh', 'the worst'])],
  ],
  trigger: [
    ['newpet', 'A new pet', any(['new (?:puppy|pup|dog|kitten|cat)', 'got (?:a|my) (?:new )?(?:puppy|dog|kitten|cat)', 'adopt(?:ed|ing)?', 'rescue(?:d)?', 'brought (?:him|her) home', 'first dog', 'first cat'])],
    ['baby', 'A baby or small child', any(['new ?born', 'baby', 'babies', 'toddler', 'pregnan(?:t|cy)', 'expecting', 'nursery', 'first child'])],
    ['move', 'A move or new home', any(['moved', 'moving', 'new (?:house|home|apartment|flat|place)', 'just bought a house', 'renovat(?:e|ing|ion)'])],
    ['season', 'Weather or season', any(['summer', 'heat ?wave', 'hot weather', 'winter', 'cold weather', 'cold snap', 'autumn', 'fall season', 'spring', 'rainy season', 'aircon', 'air con'])],
    ['travel', 'A trip', any(['trip', 'travel(?:l?ing)?', 'vacation', 'flight', 'road ?trip', 'camping', 'caravan(?:ning)?', 'roadtrip', 'long drive', 'airport'])],
    ['gift', 'A gift moment', any(['gift', 'present', 'christmas', 'xmas', 'birthday', 'anniversary', "valentine(?:'?s)?", "mother'?s day", "mum'?s day", "mom'?s day", "father'?s day", 'secret santa', 'stocking stuffer', 'wedding'])],
    ['health', 'A health scare or vet visit', any(['vet (?:said|told|visit|bill|recommended)', 'the vet', 'doctor (?:said|told)', 'after (?:surgery|the surgery|an operation)', 'diagnos(?:ed|is)', 'hospital'])],
    ['age', 'Getting older', any(['getting older', 'senior', 'elderly', 'old age', 'retire(?:d|ment)?', 'arthritis'])],
    ['replace', 'The old one broke', any(['old one (?:broke|died|stopped)', 'needed a new', 'replace(?:d|ment)', 'third one', 'second one', 'gave up on'])],
  ],
  objection: [
    ['price', 'Price', any(['too expensive', 'expensive', 'pricey', 'overpriced', 'costs? too much', 'not worth', 'worth it\\?', 'is it worth', 'rip ?off', 'cheaper', 'for that price', "can'?t afford", '\\$\\d+ for'])],
    ['quality', 'Quality and how long it lasts', any(['cheap(?:ly)? made', 'flimsy', 'feels cheap', 'looks cheap', 'poor quality', 'bad quality', 'low quality', 'broke (?:after|within|in)', 'stopped working', 'died after', 'lasted', 'fell apart', 'durab(?:le|ility)'])],
    ['clean', 'Hard to clean', any(['hard to clean', 'difficult to clean', 'easy to clean\\?', 'how (?:easy|hard|do you) .{0,20}clean', 'cleaning (?:it )?is a pain', 'pain to clean', 'clean it\\?', 'wash it\\?', 'machine washable\\?'])],
    ['noise', 'Noise', any(['loud', 'noisy', 'noise', 'hum(?:ming)?', 'buzz(?:ing)?', 'rattl(?:e|es|ing)', 'squeak(?:y|s)?'])],
    ['fit', 'Size and fit', any(['too (?:small|big|shallow|short|long|heavy|tight|loose|thin|thick)', "doesn'?t fit", 'what size', 'which size', 'sizing', 'size (?:up|down)', 'fit (?:a|my|large|big|small)', 'big enough', 'deep enough'])],
    ['works', 'Does it really work', any(["doesn'?t work", "didn'?t work", 'does (?:it|this|that) (?:really |actually )?work', 'actually work', 'useless', 'gimmick', 'scam', 'fake', 'too good to be true', 'skeptic(?:al)?', 'sceptic(?:al)?', 'returned it', 'sent it back', 'waste of money'])],
    ['wontuse', 'The pet, child or partner will not use it', any(['scared of it', "won'?t use", "wouldn'?t use", 'refuses? to', "won'?t drink", "won'?t wear", "won'?t sleep", 'hates? it', 'ignores? it', 'prefers? (?:his|her|the|their) (?:old|nasty|bowl)'])],
    ['safety', 'Safety or materials', any(['toxic', 'bpa', 'plastic', 'chemicals?', 'safe for', 'is it safe', 'choking', 'electric(?:ity|al)?', 'cord', 'shock', 'fire hazard', 'microplastics?'])],
    ['copy', 'Cheaper elsewhere or a dupe', any(['temu', 'aliexpress', 'ali express', 'shein', 'wish\\.com', 'amazon (?:has|is|sells)', 'same (?:thing|one) on', 'dupe', 'knock ?off', 'dropship(?:ping|ped|per)?'])],
    ['shipping', 'Shipping and support', any(['shipping (?:took|takes)', 'arrived (?:late|broken|damaged)', 'never arrived', 'still waiting', 'customer service', 'no response', "can'?t contact", 'refund'])],
    ['power', 'Power, battery or cords', any(['battery', 'batteries', 'charging', 'charge it', 'plug(?:ged)? in', 'outlet', 'cordless', 'power (?:goes|cut|outage|fails?)', 'if power fails'])],
  ],
  outcome: [
    ['finally', 'Finally solved', any(['finally', 'no more', 'never again', 'problem solved', 'solved (?:it|my|the)', 'fixed (?:it|my|the)'])],
    ['love', 'Love it', any(['love (?:it|this|mine|them|that)', 'obsessed', 'game ?changer', 'life ?saver', 'best (?:thing|purchase|investment|buy)', 'changed my life', 'highly recommend', '10/10', 'worth every', 'so happy with', 'must ?have'])],
    ['works', 'Works as promised', any(['works (?:great|perfectly|so well|like a charm|amazing)', 'actually works', 'does the job', 'as described', 'exactly what'])],
    ['easy', 'Easy and saves time', any(['so easy', 'easy to (?:clean|use|install|wash)', 'saves? (?:me )?(?:so much )?(?:time|money)', 'in seconds', 'takes (?:two|2|five|5) minutes', 'no effort', 'effortless'])],
    ['comfort', 'Comfortable', any(['so (?:comfy|soft|comfortable|cozy|cosy|cool)', 'comfortable', 'comfy', 'stays? (?:cool|dry|put|in place|clean|fresh)', 'sleeps? (?:better|through|so well)', 'slept (?:better|through|like)'])],
    ['pet', 'The pet or child loves it', any(['drinks? (?:more|so much)', 'loves? (?:it|his|her|the)', 'happier', 'so happy', 'calmer', 'favorite (?:spot|toy|place)', 'favourite (?:spot|toy|place)'])],
    ['sooner', 'Wish I had it sooner', any(['wish I (?:had|got|bought|found) (?:this|it|one|these)', 'should have (?:bought|got) (?:this|it|one)', 'where has this been'])],
  ],
  intent: [
    ['want', 'Wants it', any(['i need (?:this|one|it|these)', 'i want (?:this|one|it|these)', 'need this', 'want this', 'take my money', 'adding to (?:my )?cart', 'added to (?:my )?cart', 'want one'])],
    ['where', 'Asks where to buy', any(['where (?:can|do|did) (?:i|you) (?:buy|get|find|order)', 'where to (?:buy|get)', 'link\\??', "what'?s the (?:name|brand|link)", 'what brand', 'name of (?:it|this|the product)'])],
    ['bought', 'Bought one', any(['just (?:bought|ordered|got)', 'i (?:bought|ordered) (?:one|it|this|these|mine)', 'ordered (?:mine|one|it)', 'bought (?:one|it|this) (?:for|after)', 'got (?:one|mine) (?:for|after|last)'])],
  ],
};
const QUESTION = /(?:^|[.!?]\s+)(?:does|do|is|are|can|will|would|how|what|which|why|where|has|have|should|any)\b[^.!?]*\?|\?\s*$/i;

/** The kinds a statement is (a statement can be several), and the theme per kind. skip: theme keys that do not apply. */
export function tagStatement(text, { skip = [] } = {}) {
  const t = String(text || '');
  const tags = {};
  for (const kind of Object.keys(THEMES)) {
    for (const [key, , re] of THEMES[kind]) {
      if (skip.includes(key)) continue;
      if (re.test(t)) {
        tags[kind] = key;
        break;
      }
    }
  }
  if (t.includes('?') && QUESTION.test(t.trim())) tags.question = 'ask';
  // A doubt about the product is not a pain about the situation: "my dog is scared of it and prefers his nasty bowl".
  if (tags.objection && ['wontuse', 'works', 'quality', 'fit'].includes(tags.objection) && tags.pain && !['dirty', 'smell', 'hot', 'cold'].includes(tags.pain)) delete tags.pain;
  if (tags.objection === 'wontuse' && tags.pain) delete tags.pain;
  return tags;
}

/** Statements in English only: the word lists read English, and a quote is shown as written. */
export function isEnglish(text) {
  const w = (String(text || '').toLowerCase().match(/\p{L}+/gu) || []);
  if (w.length < 3) return false;
  const common = new Set(['the', 'a', 'and', 'is', 'it', 'to', 'i', 'my', 'this', 'of', 'for', 'in', 'that', 'you', 'on', 'with', 'was', 'but', 'so', 'not', 'have', 'me', 'they', 'are', 'just', 'be', 'at', 'he', 'she', 'we', 'one', 'can', 'do', 'if', 'or', 'get', 'got', 'like', 'all', 'no', 'when', 'out', 'up', 'would', 'what', 'mine', 'dog', 'her', 'his', 'them']);
  const hits = w.filter((x) => common.has(x)).length;
  return hits / w.length >= 0.18;
}

// ---------------------------------------------------------------------------
// Themes, situations, phrases
// ---------------------------------------------------------------------------
const label = (kind, key) => (THEMES[kind].find((x) => x[0] === key) || [key, key])[1];
const weight = (it) => 1 + Math.log10(1 + (it.likes || 0)); // a liked statement speaks for more people, but not 1,000 times more
const shortEnough = (t, n) => Array.from(t).length <= n;

/**
 * Per kind: themes sorted by how many statements carry them, each with up to 3 quotes (most liked first, short ones
 * preferred). items: voice items with .tags (from tagStatement or Jev). Returns { pain: [{ key, label, n, share, quotes }], … }.
 */
export function themesOf(items, { quotes = 3 } = {}) {
  const out = {};
  const usableN = items.length || 1;
  for (const kind of KINDS) {
    const by = new Map();
    for (const it of items) {
      const key = it.tags && it.tags[kind];
      if (!key) continue;
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(it);
    }
    out[kind] = [...by.entries()]
      .map(([key, list]) => ({ key, label: kind === 'question' ? 'Questions people ask' : label(kind, key), n: list.length, share: Math.round((1000 * list.length) / usableN) / 10,
        quotes: pickQuotes(list, quotes) }))
      .sort((a, b) => b.n - a.n || b.quotes.length - a.quotes.length);
  }
  return out;
}

/** The best quotes of a list: liked first, then short (a hook must be short), never the same text twice. */
export function pickQuotes(list, n = 3) {
  const seen = new Set();
  return [...list]
    .sort((a, b) => weight(b) - weight(a) || Array.from(a.text).length - Array.from(b.text).length)
    .filter((it) => {
      const k = it.text.toLowerCase().replace(/\W+/g, ' ').trim().slice(0, 80);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, n)
    .map((it) => ({ text: it.text, src: it.src, likes: it.likes || 0, date: it.date || null, url: it.url || '' }));
}

/** Who is talking, from what they say about themselves. [key, label, pattern]. */
export const SITUATIONS = [
  ['dog', 'Dog owner', any(['my (?:dogs?|pups?|puppy|puppies|boy|girl|pooch|doggo|lab|labrador|golden|retriever|shepherd|husky|frenchie|bulldog|pug|dachshund|doodle|collie|terrier|spaniel|poodle|chihuahua|beagle|boxer|rottweiler|greyhound|whippet)', 'our (?:dogs?|puppy|pup)', 'dog (?:mom|mum|dad|owner|parent)s?', '(?:two|2|three|3|four|4) dogs'])],
  ['bigdog', 'Big or giant dog', any(['big dogs?', 'large dogs?', 'large breed', 'giant breed', 'great dane', 'mastiff', 'newfoundland', 'bernese', 'st\\.? bernard', '(?:\\d{2,3}) ?(?:lb|lbs|pounds|kg) (?:dog|boy|girl)'])],
  ['olddog', 'Older dog', any(['senior dog', 'old dog', 'older dog', 'elderly dog', 'old (?:boy|girl|man|lady)', '1[0-9] ?(?:years?|yrs?)[- ]old', '(?:8|9) ?(?:years?|yrs?)[- ]old'])],
  ['puppy', 'New puppy', any(['puppy', 'puppies', 'new pup'])],
  ['cat', 'Cat owner', any(['my (?:cats?|kitty|kitties|kitten|kittens)', 'our (?:cats?|kitten)', 'cat (?:mom|mum|dad|owner|parent)s?'])],
  ['multipet', 'Several pets', any(['(?:two|2|three|3|four|4|multiple) (?:dogs|cats|pets)', 'dogs and (?:a )?cats?', 'cats and (?:a )?dogs?', 'multi[- ]?(?:dog|cat|pet)'])],
  ['parent', 'Parent', any(['my (?:son|daughter|kids?|children|toddler|baby|babies|little one|boys|girls)', 'our (?:son|daughter|kids?|children|toddler|baby)', 'as a (?:mom|mum|mother|dad|father|parent)', '(?:mom|mum|dad|mother|father) of (?:two|three|four|\\d)', 'new (?:mom|mum|dad|parents?)'])],
  ['grandparent', 'Grandparent', any(['grand(?:kids|children|son|daughter|baby)', 'my grandson', 'my granddaughter', 'as a grand(?:ma|pa|mother|father|parent)'])],
  ['partner', 'Mentions a partner', any(['my (?:husband|wife|hubby|boyfriend|girlfriend|partner|fianc[eé]e?|bf|gf|spouse)'])],
  ['giftgiver', 'Buys it as a gift', any(['(?:gift|present) for (?:my|a|her|him|them)', 'bought (?:it|this|one) for my', 'got (?:it|this|one) for my', 'for my (?:mom|mum|mother|dad|father|sister|brother|friend|grandma|nan|wife|husband|girlfriend|boyfriend|daughter|son)'])],
  ['olderadult', 'Older adult (self)', any(["i'?m (?:in my )?(?:5|6|7|8)\\d", 'in my (?:fifties|sixties|seventies|50s|60s|70s)', 'retired', 'pension(?:er)?', 'my age', 'at (?:5|6|7)\\d'])],
  ['caravan', 'Caravan, RV or van owner', any(['caravan', 'rv', 'motorhome', 'motor home', 'camper ?van', 'camper', 'van ?life', 'travel trailer', 'fifth wheel', '5th wheel', 'pop[- ]top', 'jayco'])],
  ['traveller', 'Traveller', any(['travel(?:l?ing)?', 'flights?', 'airport', 'road ?trips?', 'backpack(?:ing)?', 'carry[- ]on', 'hotel'])],
  ['outdoors', 'Outdoors and camping', any(['camping', 'hiking', 'hike', 'beach', 'fishing', '4wd', '4x4', 'off[- ]?road', 'tent'])],
  ['smallhome', 'Small home or apartment', any(['apartment', 'condo', 'small space', 'studio apartment', 'dorm', 'tiny house', 'tiny flat', 'my flat'])],
  ['house', 'House with a garden', any(['backyard', 'back yard', 'garden', 'yard', 'house'])],
  ['hotsleeper', 'Sleeps hot', any(['hot sleeper', 'night sweats', 'sleep hot', 'wake up sweating', 'sweaty at night'])],
  ['worker', 'Long shifts or on their feet', any(['nurse', 'night shift', 'shift work', '12[- ]hour shifts?', 'on my feet', 'truck driver', 'teacher', 'warehouse'])],
  ['driver', 'Drives a lot or cares for a car', any(['my car', 'my truck', 'detailing', 'car wash', 'wash my car', 'commute'])],
  ['student', 'Student', any(['college', 'university', 'student', 'campus', 'dorm room'])],
  ['wfh', 'Works from home or a desk', any(['work from home', 'wfh', 'home office', 'desk job', 'at my desk', 'office chair'])],
];

/** A persona name per situation (plural, plain English). */
export const PERSONA = { dog: 'Dog owners', bigdog: 'Owners of big dogs', olddog: 'Owners of older dogs', puppy: 'New puppy owners', cat: 'Cat owners', multipet: 'Homes with several pets',
  parent: 'Parents', grandparent: 'Grandparents', partner: 'People buying with a partner in mind', giftgiver: 'Gift buyers', olderadult: 'Older adults', caravan: 'Caravan, RV and van owners',
  traveller: 'Travellers', outdoors: 'Campers and hikers', smallhome: 'People in small homes', house: 'Home owners with a garden', hotsleeper: 'Hot sleepers', worker: 'Shift workers',
  driver: 'Car owners', student: 'Students', wfh: 'Desk workers' };

/** Situations with counts (one per statement) and a quote each, most mentioned first; only those said 2+ times. */
export function situationsOf(items, { min = 2 } = {}) {
  const by = new Map();
  for (const it of items) {
    for (const [key, name, re] of SITUATIONS) {
      if (!re.test(it.text)) continue;
      if (!by.has(key)) by.set(key, { key, label: name, n: 0, list: [] });
      const s = by.get(key);
      s.n++;
      s.list.push(it);
    }
  }
  return [...by.values()].filter((s) => s.n >= min).sort((a, b) => b.n - a.n)
    .map((s) => ({ key: s.key, label: s.label, n: s.n, share: Math.round((1000 * s.n) / (items.length || 1)) / 10, quotes: pickQuotes(s.list, 2) }));
}

const STOP = new Set(('a an the and or but if so of to in on at by for from with without as is are was were be been being am do does did done have has had having i me my mine we our ours you your yours he him his she her hers they them their it its this that these those there here ' +
  'not no yes very really just also too only even still then than now up out off over about into onto again more most much many some any all each every one ones two can could will would should may might must shall ' +
  'get got gets getting go goes going went make makes made like likes liked thing things lol omg im ive dont doesnt didnt cant wont isnt its thats whats youre theyre ill id u ur ya yeah oh ok okay well what when where who why how which ' +
  'because cause while though although after before since until via per etc amp theyd youd hed shed wed theyll youll itll theyve youve weve hes shes thats theres heres lets gonna wanna gotta kinda sorta').split(/\s+/));
const tokens = (t) => (String(t || '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[@#]\S+/g, ' ').replace(/['’]/g, '').match(/\p{L}[\p{L}\p{N}-]*/gu) || []);
/** The text cut at punctuation, so a phrase never spans a comma or a full stop ("steel, plastic" is not a phrase). */
const chunksOf = (t) => String(t || '').split(/[,.;:!?()\[\]\/|"“”…\n]+|\s[-–—]\s/).map(tokens).filter((c) => c.length >= 2);

/**
 * The phrases customers repeat: 2–4 words, counted once per statement, not starting or ending with a stop word, said in
 * min+ statements. ignore: words of the product's own name, so "water fountain" does not crowd out what they say about it.
 * Returns [{ phrase, n, likes, example: { text, url, src } }], most said first, the longer phrase kept when two overlap.
 */
export function phrasesOf(items, { min = 2, top = 15, ignore = [] } = {}) {
  const skip = new Set(ignore.map((w) => String(w).toLowerCase()));
  const by = new Map();
  for (const it of items) {
    const seen = new Set();
    for (const w of chunksOf(it.text)) for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= w.length; i++) {
        const g = w.slice(i, i + n);
        if (STOP.has(g[0]) || STOP.has(g[n - 1]) || g.every((x) => skip.has(x) || STOP.has(x))) continue;
        if (g.some((x) => x.length < 2) || g.filter((x) => !STOP.has(x)).length < 2) continue;
        const p = g.join(' ');
        if (seen.has(p)) continue;
        seen.add(p);
        if (!by.has(p)) by.set(p, { phrase: p, n: 0, likes: 0, example: null });
        const e = by.get(p);
        e.n++;
        e.likes += it.likes || 0;
        if (!e.example || (it.likes || 0) > (e.example.likes || 0)) e.example = { text: it.text, url: it.url || '', src: it.src, likes: it.likes || 0 };
      }
    }
  }
  const list = [...by.values()].filter((e) => e.n >= min).sort((a, b) => b.n - a.n || b.phrase.split(' ').length - a.phrase.split(' ').length || b.likes - a.likes);
  const kept = [];
  for (const e of list) {
    // A shorter phrase inside a kept longer one with the same count says nothing new; a longer one inside a kept shorter one neither.
    if (kept.some((k) => (k.phrase.includes(e.phrase) || e.phrase.includes(k.phrase)) && Math.abs(k.n - e.n) <= 1)) continue;
    kept.push(e);
    if (kept.length >= top) break;
  }
  return kept.map((e) => ({ phrase: e.phrase, n: e.n, likes: e.likes, example: e.example }));
}

// ---------------------------------------------------------------------------
// Claims we may not make, and competitor hooks
// ---------------------------------------------------------------------------

/** [key, label, pattern]: words in copy that need proof or change what the product legally is (section 5 blockers). */
export const CLAIMS = [
  ['medical', 'Medical or health claim', any(['cure[sd]?', 'heal(?:s|ing)?', 'treat(?:s|ment)?', 'reliev(?:e|es|ing)', 'relief', 'therap(?:y|eutic)', 'clinically', 'doctor[- ]recommended', 'vet[- ]recommended', 'fda', 'medical', 'orthop(?:a)?edic',
    'pain', 'arthritis', 'inflammation', 'anxiety', 'depression', 'insomnia', 'apnea', 'snoring', 'migraine', 'headaches?', 'sciatica', 'plantar', 'fasciitis', 'kidney', 'urinary', 'uti', 'diabetes', 'cancer', 'immune', 'detox', 'posture', 'circulation', 'lymph(?:atic)?', 'cellulite',
    'schmerz(?:en)?', 'heilt', 'linder(?:t|ung)', 'douleurs?', 'soulage', 'pijn', 'verlicht', 'dolor(?:es)?', 'alivia', 'dolore', 'sollievo'])],
  ['cosmetic', 'Cosmetic claim', any(['anti[- ]?(?:aging|ageing|wrinkle|acne)', 'wrinkles?', 'acne', 'eczema', 'psoriasis', 'collagen', 'whiten(?:ing|s)?', 'hair (?:growth|loss)', 'glowing skin', 'falten', 'rides', 'rimpels'])],
  ['brand', 'Someone else\'s brand', any(['apple', 'iphone', 'samsung', 'dyson', 'stanley', 'crocs', 'lululemon', 'nike', 'adidas', 'disney', 'pandora', 'tempur', 'emma', 'ikea', 'petsafe', 'furbo', 'ugg', 'dupe'])],
  ['scarcity', 'Scarcity or urgency claim', any(['only \\d+ left', 'sold out', 'last chance', 'selling fast', 'ausverkauft', 'épuisé', 'uitverkocht', 'agotado', 'esaurito'])],
  ['eco', 'Green claim that needs proof', any(['eco[- ]?friendly', 'sustainable', 'biodegradable', 'non[- ]?toxic', 'chemical[- ]free', 'plastic[- ]free', 'klimaneutral', 'écologique', 'duurzaam'])],
];

/** Claim words in a text: [{ key, label, word }]. */
export function claimsIn(text) {
  const t = String(text || '');
  const out = [];
  for (const [key, name, re] of CLAIMS) {
    const m = re.exec(t);
    if (m) out.push({ key, label: name, word: m[0] });
  }
  return out;
}

/** The first line of an ad: its hook. */
export function hookOf(text) {
  const lines = String(text || '').split(/\n+/).map((l) => l.trim()).filter((l) => /\p{L}{2,}/u.test(l));
  const first = lines[0] || '';
  return Array.from(first).length > 160 ? Array.from(first).slice(0, 157).join('') + '…' : first;
}

/** The angle a competitor ad opens with. Multilingual, plain rules. Returns one of ANGLES' keys. */
export const ANGLES = {
  story: 'Personal story',
  stop: 'Stop doing X / warning',
  question: 'Question',
  problem: 'Problem first',
  proof: 'Social proof',
  offer: 'Offer or discount',
  gift: 'Gift',
  comparison: 'Comparison',
  demo: 'Product and what it does',
};
const STOP_RE = any(['stop', "don'?t", 'never', 'please do not', 'warning', 'mistake', 'hör(?:t)? auf', 'nicht mehr', 'niemals', 'arrêtez?', 'ne (?:faites|plus)', 'jamais', 'stop met', 'nooit', 'niet meer', 'deja de', 'nunca', 'smetti']);
const OFFER_RE = any(['\\d+ ?%', '-\\d+ ?%', 'off', 'sale', 'discount', 'code', 'rabatt', 'gutschein', 'angebot', 'réduction', 'promo', 'soldes', 'korting', 'actie', 'descuento', 'oferta', 'sconto', 'gratis', 'free shipping', 'kostenlos(?:er)? versand', 'livraison gratuite', '1 ?\\+ ?1', 'black friday', 'cyber monday', 'bundle']);
const PROOF_RE = any(['\\+?\\d{1,3}(?:[.,]\\d{3})+\\+? (?:\\p{L}+ )?(?:customers|kunden|clients|klanten|clientes|clienti|reviews|bewertungen|avis|buyers|käufer|acheteurs|kopers)',
  '\\+?\\d{1,3}(?:[.,]\\d{3})+\\+? (?:happy|satisfied|zufriedene|glückliche|satisfaits|heureux|tevreden|blije|felices|soddisfatti) \\p{L}+', '\\d+k\\+? (?:customers|sold)', '★', '⭐', '5 stars?', 'bestseller', 'best[- ]seller', 'viral', 'trusted by', 'as seen on', 'tausende', 'des milliers', 'duizenden']);
const GIFT_RE = any(['gift', 'geschenk', 'cadeau', 'kado', 'regalo', 'christmas', 'weihnacht(?:en|s)?', 'noël', 'kerst', 'navidad', 'natale', "mother'?s day", 'muttertag', 'fête des mères', 'moederdag', 'valentin(?:e|stag)?']);
const CMP_RE = any(['vs\\.?', 'versus', 'compared to', 'unlike', 'better than', 'im vergleich', 'statt', 'anstatt', 'au lieu de', 'contrairement', 'in plaats van', 'beter dan', 'en lugar de', 'invece di']);
const FIRST_PERSON = any(['i', 'my', "i'?ve", "i'?m", 'ich', 'mein(?:e|en|er)?', 'je', "j'", 'mon', 'ma', 'mes', 'ik', 'mijn', 'yo', 'mi', 'io', 'mio', 'mia']);

export function angleOf(text) {
  const t = String(text || '');
  const first = hookOf(t);
  const fp = (t.match(new RegExp(FIRST_PERSON.source, 'giu')) || []).length;
  if (STOP_RE.test(first)) return 'stop';
  if (Array.from(t).length > 500 && fp >= 6) return 'story';
  if (/\?\s*$/.test(first) || /\?/.test(first.slice(0, 120))) return 'question';
  if (PROOF_RE.test(first)) return 'proof';
  if (OFFER_RE.test(first)) return 'offer';
  if (GIFT_RE.test(first)) return 'gift';
  if (CMP_RE.test(first)) return 'comparison';
  if (Object.values(THEMES.pain).some(([, , re]) => re.test(first))) return 'problem';
  return 'demo';
}
