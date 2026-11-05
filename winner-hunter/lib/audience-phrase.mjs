/*
 * Audience engine: the English search words for a product, with no human in the loop.
 *
 * Board titles are often an ad headline ("PLEASE do not use a water bowl!") and often German, French or Dutch; handles can
 * be opaque ("fun-8-cro-152"). Reddit, TikTok and YouTube are searched in English. So, in this order:
 *   1. pick.phrase when the caller gives one (a research candidate, or wh-score's clean name)
 *   2. the most specific match of a multilingual product-noun dictionary in the handle, the title and the ad text
 *   3. Jev's subcategory (world_checks.sub) → a default English query for that subcategory
 *   4. an English title, cleaned of brand, size, colour and marketing words
 * candidates() returns every distinct option, so Jev can choose between them (lib/audience-jev.mjs).
 */

const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
  .replace(/[-_/+.,:;!?()[\]{}"'’`™®©|]+/g, ' ').replace(/\s+/g, ' ').trim();

// [words (folded, any language; '|' between options), English search phrase]. Longer and more specific first: the first match wins.
export const DICT = [
  // Pets
  ['no pull (?:dog )?harness|anti ?zug|anti ?traction|harnais anti|anti ?trek', 'no pull dog harness'],
  ['cat harness|katzengeschirr|harnais (?:pour )?chat', 'cat harness'],
  ['hundegeschirr|harnais (?:pour )?chien|hondentuig|dog harness|brustgeschirr|harness', 'dog harness'],
  ['(?:pet |dog |cat )?water fountain|trinkbrunnen|wasserbrunnen|fontaine (?:a eau )?(?:pour )?(?:chat|chien|animaux)|drinkfontein|waterfontein|fuente de agua', 'pet water fountain'],
  ['slow feeder|anti ?schling|anti ?glouton|schlingnapf', 'slow feeder dog bowl'],
  ['lick ?mat|leckmatte|tapis de lechage|likmat', 'dog lick mat'],
  ['cooling mat|kuhlmatte|tapis rafraichissant|koelmat', 'dog cooling mat'],
  ['donut (?:dog )?bed|calming bed|beruhigungsbett|panier apaisant|kalmerende mand|hundebett|dog bed|hondenmand|panier (?:pour )?chien', 'calming dog bed'],
  ['herding ball|hutebal|vallningsboll|ballon de troupeau', 'herding ball for dogs'],
  ['litter ?box|katzenklo|katzentoilette|litiere|kattenbak|arenero', 'self cleaning litter box'],
  ['cat (?:tunnel|toy)|katzenspielzeug|jouet (?:pour )?chat|kattenspeelgoed', 'interactive cat toy'],
  ['dog toy|hundespielzeug|jouet (?:pour )?chien|hondenspeelgoed', 'interactive dog toy'],
  ['grooming (?:brush|glove)|fellburste|brosse (?:pour )?(?:chat|chien)|vachtborstel|deshedding', 'pet grooming brush'],
  ['pet hair remover|tierhaarentferner|anti poils|dierenhaar', 'pet hair remover'],
  ['dog (?:coat|jacket)|hundemantel|manteau (?:pour )?chien|hondenjas', 'dog winter coat'],
  ['dog car seat|car seat cover (?:for )?dog|hundedecke auto|autostoel hond|siege auto chien', 'dog car seat cover'],
  ['dog boots?|hundeschuhe|chaussures (?:pour )?chien|hondenschoenen', 'dog boots'],
  ['muzzle|maulkorb|museliere|muilkorf', 'dog muzzle'],
  ['leash|leine|laisse|riem', 'dog leash'],
  // Sleep and bedding
  ['coverless duvet|hoesloos dekbed|couette 2 en 1|bettdecke ohne bezug', 'coverless duvet'],
  ['weighted blanket|gewichtsdecke|couverture lestee|verzwaringsdeken', 'weighted blanket'],
  ['cooling (?:blanket|duvet|comforter)|kuhldecke|couverture rafraichissante|verkoelende deken', 'cooling blanket'],
  ['cooling pillow ?case|kuhlender kissenbezug|taie rafraichissante', 'cooling pillowcase'],
  ['silk pillow ?case|seidenkissenbezug|taie (?:d oreiller )?en soie|zijden kussensloop', 'silk pillowcase'],
  ['silk (?:sleep|eye) ?mask|schlafmaske aus seide|masque de (?:sommeil|nuit) (?:en )?soie|zijden slaapmasker', 'silk sleep mask'],
  ['sleep mask|schlafmaske|masque de (?:sommeil|nuit)|slaapmasker|eye mask', 'sleep mask'],
  ['travel (?:neck )?pillow|reisekissen|coussin de voyage|reiskussen|nomarest', 'travel neck pillow'],
  ['neck pillow|nackenkissen|oreiller cervical|nekkussen|cervical pillow|nakkepute', 'cervical neck pillow'],
  ['body pillow|seitenschlaferkissen|coussin de corps|lichaamskussen|lichaamskussen', 'body pillow'],
  ['knee pillow|kniekissen|coussin genoux|kniekussen', 'knee pillow'],
  ['(?:mattress )?topper|matratzenauflage|surmatelas|matrastopper', 'mattress topper'],
  ['mattress|matratze|matelas|matras', 'mattress'],
  ['duvet cover|bettwasche|housse de couette|dekbedovertrek', 'duvet cover'],
  ['fitted sheet|spannbettlaken|drap housse|hoeslaken', 'fitted sheet'],
  ['(?:bed )?sheets?|bettlaken|draps?|lakens?', 'bed sheets'],
  ['pillow|kissen|oreiller|kussen|almohada|cuscino', 'pillow'],
  ['blanket|throw|plaid|kuscheldecke|couverture|deken|manta', 'throw blanket'],
  ['blackout (?:blind|curtain|shade)s?|verdunkelung|occultant|verduisterend', 'blackout blinds'],
  ['white noise|sound machine|einschlafhilfe|bruit blanc', 'white noise machine'],
  // Clothing and shoes
  ['shapewear|bauchweg|shaping (?:body|shorts|slip)|culotte gainante|gainant|corrigerend', 'tummy control shapewear'],
  ['period (?:underwear|pants)|periodenunterwasche|culotte menstruelle|menstruatieondergoed', 'period underwear'],
  ['seamless bra|komfort ?bh|soutien gorge sans armature|naadloze bh|wireless bra|bh ohne bugel', 'wireless comfort bra'],
  ['fleece (?:lined )?tights|thermo ?strumpfhose|collant polaire|fleece panty', 'fleece lined tights'],
  ['barefoot shoes?|barfussschuhe|chaussures barefoot|barrevoetschoenen', 'barefoot shoes'],
  ['slippers?|hausschuhe|pantoufles?|pantoffels?|sloffen', 'slippers'],
  ['changing robe|surf poncho|wechselponcho|robe a langer', 'changing robe'],
  ['weighted hoodie|hoodie verzwaringsdeken|oversized hoodie', 'oversized hoodie'],
  ['compression socks|kompressionsstrumpfe|chaussettes de contention|steunkousen', 'compression socks'],
  ['socks|socken|chaussettes|sokken', 'socks'],
  ['dress|kleid|robe|jurk|vestido', 'dress'],
  ['jacket|jacke|veste|jas|coat|manteau|mantel', 'winter jacket'],
  // Jewellery and accessories
  ['name necklace|namenskette|collier prenom|naamketting|kette mit name', 'name necklace'],
  ['hug (?:necklace|ring)|umarmungskette|collier calin', 'hug necklace'],
  ['necklace|kette|collier|ketting|collana', 'necklace'],
  ['leather bracelet|lederarmband|bracelet (?:en )?cuir|leren armband', 'leather bracelet'],
  ['bracelet|armband|pulsera|bracciale', 'bracelet'],
  ['earrings?|ohrringe|boucles d oreilles|oorbellen', 'earrings'],
  ['watch (?:strap|band)|uhrenarmband|bracelet (?:de )?montre|horlogebandje|smartwatch bandje|apple watch armband', 'smartwatch strap'],
  ['card ?(?:holder|wallet)|kartenetui|porte cartes|pasjeshouder|pop up wallet|smart wallet', 'pop up card wallet'],
  ['sling bag|crossbody|umhangetasche|sac bandouliere|crossbody tas|schoudertas', 'anti theft crossbody bag'],
  ['under ?seat|cabin bag|handgepack|bagage cabine|handbagage|carry ?on', 'under seat cabin backpack'],
  ['laptop bag|laptoptasche|sac (?:pour )?ordinateur|laptoptas', 'women laptop bag'],
  ['photo ornament|weihnachtskugel (?:mit )?foto|kerstbal met foto|boule de noel photo|personalisierter weihnachtsschmuck', 'personalized photo christmas ornament'],
  ['paint by numbers|malen nach zahlen|peinture par numeros|schilderen op nummer', 'custom paint by numbers'],
  ['advent ?calendar|adventskalender|calendrier de l avent|adventskalender', 'advent calendar'],
  ['preserved rose|ewige rose|rose eternelle', 'preserved rose gift box'],
  // Home, kitchen, car, garden, travel
  ['vacuum (?:storage )?bags?|vakuumbeutel|sacs sous vide|vacuumzakken', 'vacuum storage bags'],
  ['bread bag|brotbeutel|sac a pain|broodzak', 'reusable bread bag'],
  ['shoe wash(?:ing)? bag|schuhwaschbeutel|sac de lavage (?:pour )?chaussures', 'shoe washing bag'],
  ['gutter (?:cleaning|cleaner)|dachrinnen|gouttiere|dakgoot', 'gutter cleaning tool'],
  ['needle threader|einfadler|enfile aiguille|draadinsteker', 'needle threader'],
  ['drying towel|trockentuch|serviette de sechage|droogdoek|microfib(?:er|re) towel|twist (?:car )?(?:wash )?towel', 'car drying towel'],
  ['car (?:seat )?organi[sz]er|auto ?organizer|rangement voiture|auto organizer', 'car seat organizer'],
  ['sofa ?cover|sofabezug|housse de canape|bankhoes', 'stretch sofa cover'],
  ['water bottle|trinkflasche|gourde|waterfles', 'water bottle'],
  ['copper (?:water )?bottle|kupferflasche|koperen fles', 'copper water bottle'],
  ['caravan|motorhome|wohnmobil|camping ?car|rv bedding|campervan', 'caravan bedding'],
  ['drawer (?:organi[sz]er|insert)|gridfinity|schubladeneinsatz|organisateur de tiroir|ladeverdeler', 'drawer organizer'],
  ['window (?:insert|film)|fensterfolie|film fenetre|raamfolie', 'blackout window insert'],
  ['kids pillow|kinderkissen|oreiller enfant|kinderkussen', 'kids pillow'],
  ['posture corrector|haltungskorrektor|correcteur de posture|houdingcorrector', 'posture corrector'],
];
const DICT_RE = DICT.map(([w, p]) => [new RegExp(`(?:^| )(?:${w})(?: |$)`), p]);

// Jev subcategory → a default English query. Missing or excluded subcategories map to '' (no query: no customer data).
export const SUBCAT_QUERY = {
  'Pets > Harnesses, leashes and collars': 'dog harness', 'Pets > Beds and blankets': 'calming dog bed', 'Pets > Car travel': 'dog car seat cover',
  'Pets > Carriers and bags': 'pet carrier', 'Pets > Cat toys': 'interactive cat toy', 'Pets > Dog toys': 'interactive dog toy', 'Pets > Litter and litter boxes': 'self cleaning litter box',
  'Pets > Fountains and feeders': 'pet water fountain', 'Pets > Grooming': 'pet grooming brush', 'Pets > Hair removal': 'pet hair remover', 'Pets > Clothing': 'dog winter coat',
  'Pets > Training and behaviour': 'dog training', 'Sleep and comfort > Pillows': 'pillow', 'Sleep and comfort > Blankets and weighted blankets': 'weighted blanket',
  'Sleep and comfort > Sheets and toppers': 'mattress topper', 'Sleep and comfort > Sleep masks and sound': 'sleep mask', 'Sleep and comfort > Seat cushions': 'seat cushion',
  'Sleep and comfort > Other sleep': 'sleep better', 'Home > Cleaning tools': 'cleaning tool', 'Home > Vacuums and floor care': 'cordless vacuum', 'Home > Laundry': 'laundry hack',
  'Home > Air quality and scent': 'air purifier', 'Home > Heating and cooling': 'portable fan', 'Home > Lighting': 'lamp', 'Home > Furniture covers': 'stretch sofa cover',
  'Home > Storage and organizing': 'storage organizer', 'Home > Bathroom': 'bathroom organizer', 'Home > Decor and wall art': 'wall art', 'Home > Windows and doors': 'blackout blinds',
  'Kitchen > Gadgets': 'kitchen gadget', 'Kitchen > Cookware and knives': 'non stick pan', 'Kitchen > Coffee and drinks': 'coffee maker', 'Kitchen > Food storage and lunch boxes': 'food storage containers',
  'Kitchen > Water bottles': 'water bottle', 'Baby and kids > Baby sleep and monitors': 'baby sleep', 'Baby and kids > Strollers and carriers': 'baby carrier', 'Baby and kids > Feeding': 'baby feeding',
  'Baby and kids > Learning toys': 'montessori toys', 'Baby and kids > Outdoor toys and bikes': 'kids outdoor toys', 'Baby and kids > Kids clothing': 'kids clothes',
  'Clothing > Women': 'women clothing', 'Clothing > Men': 'men clothing', 'Clothing > Underwear and shapewear': 'shapewear', 'Clothing > Socks': 'socks', 'Clothing > Heated clothing': 'heated jacket',
  'Clothing > Outerwear': 'winter jacket', 'Shoes > Comfort and orthopedic': 'comfortable shoes', 'Shoes > Barefoot': 'barefoot shoes', 'Shoes > Slippers': 'slippers', 'Shoes > Other shoes': 'shoes',
  'Jewelry and accessories > Necklaces': 'necklace', 'Jewelry and accessories > Bracelets and rings': 'bracelet', 'Jewelry and accessories > Personalized jewelry': 'name necklace',
  'Jewelry and accessories > Bags and wallets': 'crossbody bag', 'Jewelry and accessories > Sunglasses': 'sunglasses', 'Jewelry and accessories > Hats and scarves': 'scarf', 'Jewelry and accessories > Watches': 'smartwatch strap',
  'Car > Seat covers': 'car seat cover', 'Car > Organizers': 'car seat organizer', 'Car > Cleaning': 'car detailing', 'Car > Phone holders': 'car phone holder',
  'Outdoor and travel > Camping': 'camping gear', 'Outdoor and travel > Travel gear': 'travel essentials', 'Outdoor and travel > Caravans and motorhomes': 'caravan accessories',
  'Outdoor and travel > Fishing': 'fishing gear', 'Outdoor and travel > Pool and beach': 'beach essentials', 'Garden > Tools and hoses': 'garden hose', 'Garden > Birds and wildlife': 'bird feeder',
  'Garden > Plants and growing': 'indoor plants', 'Tools and DIY > Hand tools and sets': 'tool set', 'Gifts and hobbies > Personalized gifts': 'personalized gift',
  'Gifts and hobbies > Puzzles and games': 'puzzle', 'Gifts and hobbies > Crafts and patterns': 'craft kit', 'Gifts and hobbies > Books and learning': 'book',
  'Health and pain relief > Posture and back': 'posture', 'Health and pain relief > Joint and foot support': 'foot support', 'Health and pain relief > Massagers': 'massager',
  'Fitness > Recovery tools': 'muscle recovery', 'Fitness > Sports accessories': 'sports accessories', 'Fitness > Home gym gear': 'home gym',
};

const FLUFF = new Set(('new neu nouveau nieuw original premium luxury luxe edition limited official best top ultra super pro plus max mini xl xxl set pack bundle kit offer sale gift ' +
  'free gratis 2025 2026 2027 black white grey gray pink blue red green beige brown navy cream gold silver rose women men womens mens unisex for the and with your my our a an of in on ' +
  'by to from size one two three 1 2 3 4 5 pcs pieces stuck stuk teilig stueck').split(/\s+/));

/** English-looking: mostly ASCII words and some common English words. */
const englishish = (t) => {
  const w = fold(t).split(' ').filter(Boolean);
  if (w.length < 2) return false;
  const en = new Set(['the', 'for', 'and', 'with', 'your', 'dog', 'cat', 'pillow', 'bed', 'bag', 'set', 'kids', 'baby', 'women', 'men', 'car', 'home', 'water', 'sleep', 'travel', 'cover', 'blanket', 'shoes', 'necklace', 'bracelet', 'harness', 'towel']);
  return w.some((x) => en.has(x));
};
const handleOf = (url) => {
  const m = /\/products\/([^/?#]+)/.exec(String(url || ''));
  return m ? decodeURIComponent(m[1]).replace(/-/g, ' ') : '';
};

/**
 * Every distinct candidate phrase for a product, best first: [{ phrase, how }]. p: { phrase, name, title, url, handle, sub
 * ("Main > Sub" or just "Sub" with main), main, ad (ad text) }.
 */
export function candidates(p) {
  const out = [];
  const add = (phrase, how) => {
    const x = fold(phrase).split(' ').filter(Boolean).slice(0, 6).join(' ');
    if (x && !out.some((o) => o.phrase === x)) out.push({ phrase: x, how });
  };
  if (p.phrase) add(p.phrase, 'given');
  const hay = [p.handle || handleOf(p.url), p.name, p.title, String(p.ad || '').slice(0, 400)].map(fold).filter(Boolean);
  for (const h of hay) {
    for (const [re, phrase] of DICT_RE) {
      if (re.test(` ${h} `)) {
        add(phrase, 'dictionary');
        break;
      }
    }
  }
  const sub = p.sub && p.sub.includes(' > ') ? p.sub : p.main && p.sub ? `${p.main} > ${p.sub}` : '';
  if (sub && SUBCAT_QUERY[sub]) add(SUBCAT_QUERY[sub], 'category');
  for (const t of [p.name, p.title]) {
    if (!t || !englishish(t)) continue;
    const words = fold(t).split(' ').filter((w) => w && !FLUFF.has(w) && !/^\d+$/.test(w) && w.length > 1);
    if (words.length >= 2) add(words.slice(0, 4).join(' '), 'title');
  }
  return out;
}

/** The phrase to search with: the first candidate, or '' when nothing fits (then the card is built from ads only). */
export function phraseOf(p) {
  const c = candidates(p);
  return c.length ? c[0] : { phrase: '', how: 'none' };
}

/** The product's own words, so customer-word mining does not just echo the product name. */
export const ownWords = (phrase) => fold(phrase).split(' ').filter((w) => w.length > 2);
