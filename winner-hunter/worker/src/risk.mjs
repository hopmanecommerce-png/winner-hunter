/*
 * The compliance and risk radar: Block, Docs or OK for every product on the board, and why. For a store in the
 * Netherlands that ships from 1688 to customers in the EU: what EU and Dutch rules, Shopify Payments and the shipping
 * lines say about a product (docs/risk-radar.md: the rules and where they come from). A block of its own, like launch.mjs.
 *   GET  /risk.js     riskKit as a script: the board shows the very verdict the Worker filters with (window.RISK)
 *   GET  /api/risk    { checks }: every check you made, by product key
 *   POST /api/risk    { id | tiktok, tm?, docs?, level?, note? }: your check on one product (trademark, documents, your call)
 *   ?risk=hide on /api/ads and /export.csv: Inbox and Browse leave out what the radar blocks (riskHide, called by app.mjs)
 * Your checks are rows of D1's state table, 'risk:<product key>' (like the PIN tries were): no migration, nothing to deploy first.
 * app.mjs checks the PIN cookie, the origin and the JSON before any of this runs. All SQL is parameterized.
 */

/**
 * Everything the radar decides, in one function that uses nothing from outside itself: the Worker calls it, and /risk.js
 * sends its source to the board (as launch.mjs does), so the browser runs the same tested rules.
 */
export function riskKit() {
  const YES = 0.5; // Jev's yes (YES_AT in jev-questions.mjs)
  const raw = String.raw;
  // Lower case, accents off ("crème" is "creme", "ß" is "ss"); dashes, slashes and underscores are spaces ("anti-snoring").
  const norm = (s) => String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\u00df/g, 'ss').replace(/[\u2018\u2019\u02bc`]/g, "'")
    .toLowerCase().replace(/[-\u2010-\u2015_/\\|+]+/g, ' ').replace(/\s+/g, ' ').trim();
  // A list of words: no letter or digit right before or after. Stems: also inside a longer word (Dutch and German glue words
  // together: "tandenbleekset", "Zahnaufhellungsstreifen"). The text is normalized first, so plain a-z classes do.
  const W = (s) => new RegExp('(^|[^a-z0-9])(' + s + ')(?![a-z0-9])', 'g');
  const S = (s) => new RegExp('()(' + s + ')', 'g');
  // What does not count, read on the hit with two words before and two after it: a "lotion dispenser" is no lotion.
  const NOT = (s) => new RegExp('(?:^|[^a-z0-9])(?:' + s + ')(?![a-z0-9])');
  const NOTS = (s) => new RegExp(s);
  const letter = /[a-z0-9]/;

  // ---- The reasons. block: do not sell it (as is). docs: it sells, with papers or care first. info: a note that changes
  // nothing (not physical is never a block, Connor 2026-11-01). Returns are flags beside it.
  const LEVEL = { weapon: 'block', regulated: 'block', adult: 'block', eat: 'block', pet_med: 'block', cosmetics: 'block', device: 'block', medical: 'block',
    pseudo: 'block', biocide: 'block', bamboo: 'block', brand: 'block', tm: 'block',
    pet_eat: 'docs', claims: 'docs', ce: 'docs', battery: 'docs', radio: 'docs', kids: 'docs', food: 'docs', blade: 'docs', ship: 'docs', digital: 'info' };
  const RETURNS = ['sizing', 'fragile', 'bulky', 'ioss'];
  const HEALTH = ['eat', 'pet_med', 'cosmetics', 'device', 'medical', 'pseudo'];
  const ORDER = Object.keys(LEVEL).concat(RETURNS);
  const SHORT = { weapon: 'Weapon', regulated: 'Tobacco, CBD or fireworks', adult: 'Adult', eat: 'Food or supplement', pet_med: 'Pet medicine', cosmetics: 'Cosmetic',
    device: 'Medical device', medical: 'Medical claim', pseudo: 'Health promise', biocide: 'Biocide or pesticide', bamboo: 'Bamboo tableware', brand: 'Brand risk', digital: 'Digital',
    tm: 'Trademark conflict', pet_eat: 'Pet food', claims: 'Claims', ce: 'CE', battery: 'Battery', radio: 'Radio', kids: 'Kids', food: 'Food contact', blade: 'Blade',
    ship: 'Hard to ship', sizing: 'Sizes', fragile: 'Fragile', bulky: 'Bulky', ioss: 'Over €150' };
  const TEXT = {
    weapon: 'Weapon under Dutch and German law (pepper spray, stun gun, brass knuckles, butterfly or switch knife, airsoft): you may not sell it',
    regulated: 'Tobacco, vape, CBD, laughing gas or fireworks: age, drug and fireworks rules, and Shopify Payments prohibits regulated products',
    adult: 'Adult product: Shopify Payments prohibits adult products',
    eat: 'People eat or take it (food or supplement): EU food law, health-claim rules (EU 1924/2006) and a food business registration',
    pet_med: 'Pet medicine, flea or tick product: EU veterinary medicine and biocide rules',
    cosmetics: 'Cosmetic (on skin, hair, nails or teeth; perfume; essential oils): an EU responsible person, CPNP notification and a safety report for each product (EU 1223/2009); essential oils also need CLP hazard labels (EU 1272/2008)',
    device: 'Medical device (blood pressure, oximeter, hearing aid, fever thermometer, IPL or laser hair removal, contact lenses): EU medical device rules (MDR)',
    medical: 'Medical promise in its name (pain, a condition, snoring): EU medical device rules (MDR), and Meta rejects health ads like it',
    pseudo: 'Health promise (detox, weight loss, lymphatic drainage): Shopify Payments prohibits pseudo-pharmaceuticals and Meta rejects the ads',
    biocide: 'Biocide or pesticide (insect repellent, disinfectant, hand sanitiser, weed or pest killer): it needs an EU or Dutch authorisation (EU 528/2012, EU 1107/2009)',
    bamboo: 'Bamboo-fibre tableware: bamboo in plastic is not allowed for food contact in the EU',
    brand: 'Famous brand or character: counterfeit risk. EU customs seize it, and Shopify Payments prohibits counterfeit products',
    digital: 'Not a physical product (gift card, download, course, shipping protection): a note, not a block',
    tm: 'Trademark conflict (your check)',
    pet_eat: 'Pets eat it (pet food or treats): EU feed rules; only from an EU or approved supplier, since animal products from China are stopped at the border',
    claims: 'Health claim in its name, category or ad: sell it without treat, cure or relieve claims, or it counts as a medical device (MDR) and Meta rejects the ad',
    ce: 'Electric or electronic: CE declaration and test reports from the supplier (EMC, RoHS; LVD if it plugs into the mains) and WEEE registration (NL: Stichting OPEN)',
    battery: 'Battery: UN38.3 test summary and MSDS from the supplier, battery labels and registration (EU 2023/1542), and a shipping line that takes batteries',
    radio: 'Radio (Bluetooth, Wi-Fi, remote control): a RED test report and declaration of conformity',
    kids: 'For children: CE and EN 71 test reports for a toy, and age warnings; baby and childcare products need their own EN safety test',
    food: 'Touches food or drink: a food-contact declaration (EU 1935/2004; plastics EU 10/2011) and a migration test (LFGB) from the supplier',
    blade: 'Blade: ask your shipping line first; Meta limits weapon ads, and some EU countries want an 18+ check',
    ship: 'Hard to ship by post (spray, liquid, glue, paint, flammable, strong magnets): an MSDS and a shipping line that takes it',
    sizing: 'Sizes: a wrong fit comes back. Show a size chart',
    fragile: 'Breaks in shipping: pack it well and expect damage claims',
    bulky: 'Big or heavy: shipping and returns cost a lot, and cheap China lines refuse it',
    ioss: 'Over €150 before VAT: no IOSS, so the buyer pays import VAT and duty at the door (refusals)',
  };
  // Shopify Payments' prohibited groups (help.shopify.com, Shopify Payments eligibility).
  const PAY = { weapon: 'Regulated or illegal products', regulated: 'Regulated or illegal products', adult: 'Adult products', pseudo: 'Pseudo pharmaceuticals',
    brand: 'Counterfeit products', tm: 'Counterfeit products' };
  const GPSR = 'GPSR (since 13 Dec 2024): an EU responsible person (you as importer, or a paid service) on the product and its page, with the maker, a type or batch number and warnings in Dutch or German';
  const CUSTOMS = 'Customs straight from China: about €5 an order (€3 duty a parcel under €150 from 1 Jul 2026, €2 handling an item line from 1 Nov 2026)';
  // What to ask the supplier for, in English and Chinese (the 1688 chat).
  const ASK = {
    ce: [['CE declaration of conformity (EMC, RoHS)', 'CE 符合性声明（EMC、RoHS）'], ['Test reports (EMC; LVD if it plugs in)', '检测报告（EMC；插电产品需 LVD）']],
    radio: [['RED test report (radio)', 'RED 无线电检测报告']],
    battery: [['UN38.3 test summary', 'UN38.3 测试摘要'], ['MSDS for the battery', '电池 MSDS（化学品安全技术说明书）'], ['Battery capacity in Wh', '电池容量（Wh）']],
    kids: [['EN 71-1/2/3 test report (toys)', 'EN71-1/2/3 检测报告（玩具）'], ['CE declaration of conformity (toys)', '玩具 CE 符合性声明']],
    food: [['Food-contact declaration of compliance (EU 1935/2004, EU 10/2011)', '食品接触材料符合性声明（EU 1935/2004、EU 10/2011）'], ['LFGB migration test report', 'LFGB 迁移测试报告']],
    ship: [['MSDS', 'MSDS（化学品安全技术说明书）']],
  };
  const LABEL = ['Label: the maker\'s name and address, model or batch number', '产品标签：制造商名称和地址、型号或批号'];

  // ---- The words (EN, NL, DE; some FR). Read on the product's name and its product link; claims also in the ad's words.
  // Pills, drops and supplements for a pet (EN, NL, DE): pet medicine or a pet supplement, not food for people.
  const PET = raw`(?:de |den |die |uw |je |your |ihren? |ihre )?(?:dogs?|cats?|pets?|puppies|kittens|hunde?n?|katzen?|honden?|katten?|hond|kat|huisdieren|haustiere|pferde?n?|paarden?)`;
  const PET_PILL = raw`(?:[a-z]*tabletten|[a-z]*kapseln|[a-z]*capsules|[a-z]*tropfen|[a-z]*druppels|vitaminen?|vitamins?|supplementen?|supplements?|probiotics?|probiotica|probiotika|nahrungserganzung[a-z]*|erganzungsfutter[a-z]*|voedingssupplement[a-z]*)`;
  // "Wireless" on a bra: no underwire, no radio.
  const NO_WIRE = raw`wireless (?:[a-z]+ )?(?:bras?|bralettes?|underwire)|wireless push up|bras? wireless|draadloze? (?:[a-z]+ )?(?:beha|bh)|draadloze? push up`;
  const R = [];
  const rule = (k, re, not, extra) => R.push(Object.assign({ k, re, not: not || [] }, extra || {}));
  rule('weapon', [W(raw`pepper ?sprays?|(?:self )?defen[cs]e sprays?|self defen[cs]e(?: [a-z]+)?|stun ?guns?|tasers?|electric shock (?:devices?|weapons?|torch(?:es)?)|brass knuckles?|knuckle ?dusters?|butterfly (?:knife|knives)|balisongs?|switch ?blades?|gravity (?:knife|knives)|flick (?:knife|knives)|automatic (?:knife|knives)|spring (?:assisted )?(?:knife|knives)|push daggers?|throwing (?:stars?|knife|knives|axes?)|shurikens?|(?:credit )?card knife|(?:lipstick|comb|pen|belt buckle|hidden|knuckle|key) knife|(?:expandable|telescopic|tactical|police|self defen[cs]e) batons?|airsoft(?: [a-z]+)?|bb guns?`),
    W(raw`pepperspray|traangas|stroomstoot[a-z]*|boksbeugels?|vlindermes(?:sen)?|springmes(?:sen)?|valmes(?:sen)?|werpsterren|werpster|zelfverdediging[a-z]*|pfefferspray[a-z]*|abwehrspray[a-z]*|elektroschocker|schlagringe?|butterflymesser|springmesser|fallmesser|wurfsterne?|teleskopschlagst[a-z]*|schlagst(?:ock|ocke)|selbstverteidigung[a-z]*`)],
    [NOT(raw`self defen[cs]e (?:class|classes|course|courses|book|books|training)|airsoft (?:targets?|goggles?|masks?|vests?|gloves?|helmets?|patches?|bags?)`)]);
  rule('regulated', [W(raw`vapes?|vaping|vape pens?|e cig(?:arettes?|s)?|e liquids?|nicotine(?: pouches)?|snus|tobacco|cigarettes?|cigars?|shisha tobacco|cbd|cannabidiol|thc|hhc|cannabis|marijuana|hemp (?:oil|extract|gummies|drops|balm|cream|tincture)|kratom|poppers|nitrous oxide|laughing gas|fireworks?|firecrackers?|bongs?|dab rigs?`),
    W(raw`e sigaret(?:ten)?|e zigarett[a-z]*|nikotin[a-z]*|tabak|hennepolie|hanfol|lachgas|vuurwerk|feuerwerk[a-z]*|boller`)],
    [NOT(raw`(?:cigarette|cigar|tobacco)s? (?:lighters?|sockets?|adapters?|chargers?|plugs?|cases?|holders?|boxes?|tins?|humidors?|cutters?|ashtrays?|pouch(?:es)?)|(?:anti|no|quit|stop) (?:smoking|vaping|vape)|tobacco free|nicotine free`)]);
  rule('adult', [W(raw`sex ?toys?|adult toys?|vibrators?|dildos?|butt ?plugs?|anal (?:plugs?|beads|toys?)|bdsm|bondage (?:kits?|sets?|ropes?|gear)|masturbat[a-z]*|penis (?:pumps?|rings?|extenders?|sleeves?)|cock rings?|fleshlights?|erotic toys?`),
    W(raw`seksspeeltje[a-z]*|seksspeelgoed|erotisch speelgoed|sexspielzeug|erotikspielzeug|liebesspielzeug`)],
    [NOT(raw`vibrators? (?:motors?|modules?)|concrete vibrators?`)]);
  // Supplements: Shopify Payments counts them as pseudo-pharmaceuticals (nutraceuticals). Plain food after them, without that.
  rule('eat', [W(raw`(?:dietary |food |health |herbal |natural )?supplements?|multi ?vitamins?|vitamins?(?: [a-z]\d{0,2})?(?: [a-z]+)? (?:gummies|tablets|capsules|pills|drops|powder|softgels|chews)|gummies|gummy (?:vitamins?|bears? vitamins?)|capsules|softgels?|probiotics?|prebiotics?|collagen (?:powder|peptides|drinks?|gummies|capsules|supplements?|shots?|sachets)|protein (?:powder|shakes?)|whey|creatine|pre ?workouts?|greens powder|super ?foods?|ashwagandha|shilajit|melatonin|sea moss|lion'?s mane|apple cider vinegar (?:gummies|capsules|tablets)|electrolytes? (?:powder|tablets|drink mix|sachets)|magnesium (?:(?:bis ?)?glycin(?:ate|aat|at)|citr(?:ate|aat|at)|tablets|tabletten|capsules|kapseln|supplements?)|omega ?3|fish oil|cod liver oil|biotin|keto (?:pills|gummies|drops|capsules)|appetite suppressants?|nootropics?|detox teas?|slimming teas?`),
    W(raw`voedingssupplement[a-z]*|supplementen|vitaminen|vitamine (?:[a-z]\d{0,2}|tabletten|capsules|gummies|kauwtabletten)|kapseln|nahrungserganzung[a-z]*|eiwitpoeder|eiweisspulver|eiweiss ?shake|proteinpulver|collageen ?poeder|kollagen ?pulver|kollagenpulver|probiotica|probiotika|kruidenthee|krautertee|afslankthee|abnehmtee`)],
    [NOT(raw`(?:pill|vitamin|supplement|capsule|tablet)s? (?:organi[sz]ers?|box(?:es)?|cases?|dispensers?|holders?|cutters?|crushers?|splitters?)|(?:coffee|espresso|tea|nespresso|dolce gusto) capsules|capsules? (?:holders?|storage|drawers?|stands?|racks?|machines?)`
      + raw`|vitamin(?:e|s)? [a-z]\d{0,2} (?:face |facial )?(?:serums?|creams?|cremes?|essences?|toners?|ampoules?|oils?|olie|masks?|maskers?|lotions?|cleansers?|gels?|shampoos?)`
      + raw`|${PET_PILL} (?:for|fur|voor) ${PET}|(?:dogs?|cats?|pets?|puppy|puppies|kittens?|honden|katten|hunde|katzen) (?:supplements?|vitamins?|probiotics?|capsules|tablets)`)],
    { pay: 'Pseudo pharmaceuticals' });
  rule('eat', [W(raw`protein (?:bars?|cookies?)|coffee creamer|mushroom coffee|drink mix|energy drinks?|herbal teas?|energy bars?|beef jerky|coffee beans|ground coffee|instant coffee|matcha powder|cocoa powder|hot sauce`)], [NOT(raw`grinders?|storage|containers?|canisters?|jars?|scoops?|tins?|vacuum`)]);
  rule('pet_med', [W(raw`fleas?|flea (?:and|&) ticks?|ticks? (?:collars?|drops|treatments?|repellents?|prevention|protection|sprays?|shampoo)|spot ?on (?:for )?(?:cats?|dogs?|pets?)|(?:cats?|dogs?|pets?) spot ?on|(?:flea|tick|worm) (?:pipettes?|tablets?|treatments?|medicines?)|de ?wormers?|worming(?: [a-z]+)?|(?:dogs?|cats?|pets?|puppy|puppies|kittens?) (?:supplements?|vitamins?|probiotics?|medicines?|medications?|meds|painkillers?|cbd|joint supplements?)|(?:supplements?|vitamins?|probiotics?|medicines?|meds|cbd oil|cbd) for (?:dogs?|cats?|pets?|puppies|kittens)|calming (?:chews|treats|drops|tablets|supplements?)|hip (?:and|&) joint (?:chews|supplements?|treats)|anti ?puces?|antiparasitaires?|${PET_PILL} (?:for|fur|voor) ${PET}`),
    W(raw`vlooien[a-z]*|vlo|teken(?:band|middel|druppels|halsband)[a-z]*|ontworm[a-z]*|wormkuur|floh[a-z]*|flohe|zecken(?:halsband|schutz|mittel|tropfen|spray)[a-z]*|wurmkur[a-z]*|entwurm[a-z]*`),
    S(raw`flohschutz|flohmittel|flohhalsband|zeckenschutz|zeckenhalsband|vlooienband|tekenband`)],
    [NOT(raw`fleas? (?:combs?|brush(?:es)?|traps?|lamps?|markets?)|flea market|ticks? (?:removers?|tweezers?|twisters?|hooks?|cards?)`), NOTS(raw`flohkamm|flohmarkt|vlooienkam|vlooienmarkt`)]);
  // Pet food stays on the board (Connor, 2026-10-31): papers, not a block.
  rule('pet_eat', [W(raw`(?:dogs?|cats?|pets?|puppy|puppies|kittens?|birds?|parrots?|rabbits?|hamsters?) (?:food|foods|treats?|snacks?|chews?|kibble|jerky|biscuits?|cookies?)|dental chews?|bully sticks?|rawhides?|freeze dried (?:treats?|chicken|liver)|pet treats?`),
    W(raw`hondenvoer|kattenvoer|honden ?snoepjes|katten ?snoepjes|hondensnacks?|kattensnacks?|hundefutter|katzenfutter|hundesnacks?|katzensnacks?|leckerlis?|kauknochen`)],
    [NOT(raw`(?:food|treats?|snacks?|chews?|kibble) (?:bowls?|dispensers?|pouch(?:es)?|bags?|mats?|containers?|storage|balls?|toys?|puzzles?|feeders?|scoops?|holders?|jars?|bins?|stations?)|(?:chew|chews) toys?|treat (?:dispensers?|pouch(?:es)?|bags?|balls?|toys?|puzzles?|jars?|mats?|cameras?)|slow feeders?|lick mats?`), NOTS(raw`napf|spender|houder|dispenser|beutel|speelgoed|spielzeug|voerbak`)]);
  const TOOLS = raw`brush(?:es)?|brush sets?|sponges?|blenders?|applicators?|dispensers?|pumps?|bottles?|empty|containers?|mirrors?|bags?|cases?|organi[sz]ers?|holders?|stands?|storage|pouch(?:es)?|trays?|fridges?|machines?|devices?|tools?|(?:ice|jade|face|facial|derma|eye) rollers?|gua sha|remover pads?|pads?|towels?|cloths?|headbands?|caps?|lamps?|lights?|dryers?|drills?|warmers?|heaters?|steamers?|atomi[sz]ers?|sprayers?|diffusers?|dish(?:es)?|savers?|molds?|moulds?|shelf|shelves|racks?|led (?:face |facial )?masks?|reed diffusers?|refills? bottles?|wands?|mitts?|gloves?|vials?`;
  rule('cosmetics', [W(raw`serums?|moisturi[sz]ers?|moisturi[sz]ing (?:creams?|lotions?|gels?)|(?:face|facial|eye|under eye|night|day|hand|foot|feet|body|neck|lip|skin|anti ?aging|anti ?ageing|anti ?wrinkle|wrinkle|whitening|brightening|retinol|collagen|vitamin c|niacinamide|snail|tallow|cica|barrier|repair|firming|tightening|stretch marks?|scar|dark spots?|tattoo|nipple|butt|breast|bust|hemp|arnica|aloe vera|shea|baby) (?:creams?|lotions?|balms?|butters?|gels?|essences?|toners?|cleansers?|oils?|scrubs?|serums?|sticks?|mists?|drops|treatments?|patch(?:es)?|ointments?|salves?|powder|shampoo|wash)|body lotions?|lotions?|balms?|body butters?|ointments?|salves?|shampoos?|conditioners?|hair (?:dyes?|colou?rs?|bleach|oils?|serums?|masks?|tonics?|growth(?: [a-z]+)?|removal (?:creams?|wax|spray|foam)|sprays?|gels?|wax|pomade|perfume|mist|treatment|lotion)|dry shampoo|beard (?:oils?|balms?|growth(?: [a-z]+)?|wash)|tooth ?paste|tooth ?powder|(?:teeth|tooth) whitening(?: [a-z]+)?|whitening (?:strips?|gel|kit|pen|powder|foam|toothpaste)|mouthwash|lipsticks?|lip ?gloss(?:es)?|lip (?:oils?|tints?|stains?|plumpers?|liners?)|mascaras?|eye ?liners?|eye ?shadows?|(?:eye ?)?brow (?:gel|pencil|pomade|tint|serum|lamination)|concealers?|foundations?|bronzers?|contour (?:sticks?|palettes?)|setting (?:spray|powder)|face powder|loose powder|nail (?:polish|varnish|lacquer|glue|oil|serum)|gel polish|nail gel|perfumes?|parfums?|eaux? de (?:parfum|toilette|cologne)|colognes?|body (?:mists?|sprays?|oils?|scrubs?|wash(?:es)?|glitter|shimmer)|deodorants?|antiperspirants?|deos?|sunscreens?|sun ?creams?|sun ?blocks?|spf ?\d+ (?:creams?|lotions?|sprays?|sunscreens?|sticks?|balms?|serums?|moisturi[sz]ers?|fluids?|mists?|oils?)|snail mucin(?: [a-z]+)?|(?:face|facial|skin|snail|toner|first) essences?|self ?tan(?:ner|ning)?(?: [a-z]+)?|tanning (?:drops|mousse|lotion|oil|water)|glow drops|retinol|hyaluronic(?: acid)?|niacinamide|essential oils?|atherische[ns]? (?:ole|ol|olen)|(?:etherische|essentiele) olie(?:n|s)?|massage oils?|(?:castor|rosemary|argan|jojoba|ginger|rosehip|tea tree|coconut|cuticle|bath|batana|pumpkin seed|lymphatic|tummy|belly) oils?|soaps?|bath (?:bombs?|salts?|oils?|soaks?)|shower (?:gels?|oils?|steamers?)|(?:face|facial) (?:wash|cleansers?|toners?|oils?|mists?|scrubs?|peels?|creams?)|(?:sheet|clay|peel ?off|mud|charcoal|collagen|hydrogel|sleeping|lip|nose|gold|bubble|hydrating|moisturi[sz]ing|whitening|brightening|anti ?aging|anti ?ageing|vitamin c|snail|rice|retinol|hyaluronic)(?: face| facial)? masks?|under ?eye masks?|(?:pimple|acne|eye|under ?eye|nose|lip|wrinkle|forehead|smile line) patch(?:es)?|foot peel(?: mask)?|lash (?:serums?|lift(?: [a-z]+)?|glue|adhesive|tint)|eyelash (?:serums?|glue|growth(?: [a-z]+)?)|wax strips|depilatory(?: [a-z]+)?|makeup remover|micellar(?: water)?|cosmetics?|make ?up|kosmetik[a-z]*|cosmetica|cremes? (?:de (?:jour|nuit)|visage|hydratantes?|anti ?(?:age|rides)|mains|corps|solaires?)|dentifrices?|blanchiment dentaire`),
    S(raw`haargroei|haarwuchs|rozemarijnolie|rosmarinol|tagescreme|nachtcreme|gesichtscreme|augencreme|handcreme|fusscreme|korpercreme|hautcreme|bodylotion|korperlotion|dagcreme|gezichtscreme|oogcreme|voetcreme|huidcreme|gezichtsmasker|gesichtsmaske|haarmasker|haarmaske|haarolie|haarol|haarverf|haarfarbe|haarkur|baardolie|bartol|tandpasta|zahnpasta|tandenbleek|zahnaufhell|zahnbleaching|lippenstift|nagellak|nagellack|wimperntusche|zonnebrand|sonnencreme|sonnenmilch|sonnenschutzcreme|sonnenschutzspray|zelfbruiner|selbstbrauner|douchegel|duschgel|massageolie|massageol|lichaamsolie|korperol|gezichtsreiniger|gesichtsreiniger|parfum|deodorant|serum`),
    W(raw`zeep|zepen|seife|seifen`)],
    [NOT(raw`(?:air|air cooler) conditioners?|(?:dog|cat|pet|puppy|horse)s? (?:shampoos?|conditioners?|soaps?|balms?|wash|deodorants?|perfumes?|colognes?|wipes|paw balms?)|paw balms?|(?:car|room|home|auto|house|closet|shoe|fridge|linen) (?:perfumes?|parfums?|fragrances?|deodori[sz]ers?|deos?|sprays?)|shoe deodori[sz]ers?|fragrance oils? for diffusers?|diffuser oils?|oils? (?:diffusers?|burners?)|soap (?:dispensers?|dish(?:es)?|holders?|savers?|bags?|pumps?|molds?|moulds?|trays?|boxes?|bottles?|nets?|making|base)|make ?up (?:brush(?:es)?|brush sets?|bags?|cases?|mirrors?|organi[sz]ers?|sponges?|blenders?|remover pads?|remover towels?|remover cloths?|lamps?|lights?|storage|pouch(?:es)?|trains?|tables?|vanity|chairs?|stands?|holders?|fridges?)|ice cream|creme brulee|(?:gel|cooling|heated|warm|sleep|sleeping|silk|steam) (?:eye )?masks?|eye gel masks?|cream (?:makers?|chargers?|whippers?|dispensers?|jugs?|pitchers?)|creamers?|` + TOOLS),
      NOTS(raw`dispenser|spender|pompje|houder|halter|flasche|flesje|zerstauber|verstuiver|spiegel|tasche|kwast|pinsel|vernevelaar|diffuser|autoparfum|raumparfum|schuhdeo|schoendeo|schuhdeodorant`)]);
  rule('medical', [W(raw`pain relie(?:f|vers?|ving)|relie(?:f|ves?|ving) (?:[a-z]+ ){0,2}pain|painkillers?|pain (?:patch(?:es)?|creams?|gels?|sprays?|relievers?|killers?)|(?:back|neck|knee|joint|nerve|period|menstrual|muscle|shoulder|hip|foot|heel|sciatic|tooth|arthritis|chronic|lower back|wrist|elbow) pain|sciatica|arthritis|fasciitis|neuropath[a-z]*|tinnitus|migraines?|headache relief|hemorrhoids?|haemorrhoids?|varicose(?: veins?)?|scoliosis|incontinen[a-z]*|eczema|psoriasis|acne|rosacea|dermatitis|diabet[a-z]*|insomnia|sleep apnea|bunions?|hallux valgus|carpal tunnel|tendonitis|tendinitis|tens (?:units?|devices?|machines?|massagers?|pads?|electrodes?)|tens ems|ems (?:muscle|stimulators?|trainers?|massagers?|pads?|belts?|foot|devices?)|muscle stimulators?|electro ?therap[a-z]*|electric (?:muscle|nerve) stimulat[a-z]*|anti ?snor[a-z]*|snor(?:e|ing) (?:stoppers?|stop|devices?|solutions?|aids?|clips?|strips?|mouthpieces?|bands?|chin straps?)|stop snoring|snoring|nasal dilators?|cpap|nebuli[sz]ers?|inhalers?|cold sores?|fungal|athlete'?s foot|wart removers?|mal de dos|douleurs? (?:articulaires?|dorsales?|lombaires?|musculaires?|cervicales?)|anti ?douleurs?`),
    S(raw`pijnverlicht|pijnstill|pijnbestrijd|rugpijn|nekpijn|kniepijn|gewrichtspijn|spierpijn|menstruatiepijn|hielpijn|voetpijn|schouderpijn|tandpijn|hoofdpijn|ischias|artrose|artritis|hielspoor|oorsuizen|aambei|spatader|incontinentie|eczeem|slapeloosheid|snurk|schmerzlinder|schmerzmittel|ruckenschmerz|nackenschmerz|knieschmerz|gelenkschmerz|muskelschmerz|regelschmerz|periodenschmerz|fersenschmerz|fussschmerz|schulterschmerz|zahnschmerz|kopfschmerz|arthrose|fersensporn|hamorrhoid|krampfader|inkontinenz|ekzem|schuppenflechte|schlaflosigkeit|schnarch|reizstrom|muskelstimul|tens ?gerat|tens ?apparaat`), W(raw`akne`)],
    [NOT(raw`(?:dog|cat|pet|puppy|horse)s? (?:[a-z]+ )?(?:arthritis|joint|pain)|for (?:dogs?|cats?|pets?) (?:with )?(?:arthritis|joint|pain)|pain free(?: [a-z]+)?|painless`)]);
  rule('device', [W(raw`blood pressure(?: [a-z]+)?|blood (?:sugar|glucose)(?: [a-z]+)?|glucose (?:meters?|monitors?|test(?: [a-z]+)?)|(?:pulse )?oximeters?|hearing (?:aids?|amplifiers?)|(?:fever|ear|forehead|infrared|baby|clinical|body|basal) thermometers?|thermometer guns?|ipl(?: [a-z]+)?|(?:laser|ipl) hair (?:removal|removers?)(?: [a-z]+)?|hair removal (?:laser|ipl)(?: [a-z]+)?|laser hair(?: [a-z]+)?|(?:colou?red |cosplay |halloween )?contact lens(?:es)?|stethoscopes?|ecg(?: [a-z]+)?|ekg|pregnancy tests?|ovulation tests?|covid tests?`),
    S(raw`bloeddruk|bloedsuiker|saturatiemeter|hoortoestel|koortsthermometer|oorthermometer|voorhoofdthermometer|blutdruck|blutzucker|pulsoximeter|horgerat|fieberthermometer|ohrthermometer|stirnthermometer|laserontharing|laser ?haarentfernung|kontaktlinsen|contactlenzen|zwangerschapstest|schwangerschaftstest`)],
    [NOT(raw`(?:meat|bbq|grill|kitchen|cooking|oven|candy|room|weather|indoor|outdoor|aquarium|pool|wine|milk|bath|fridge|freezer|soil|cheese|oil|jam|baking|food) thermometers?|contact lens (?:cases?|holders?)|ipl (?:sunglasses|goggles|glasses|cooling gel)`)]);
  rule('pseudo', [W(raw`detox(?: foot)? (?:pads?|patch(?:es)?|teas?|drops|foot baths?)|foot detox(?: [a-z]+)?|lymphatic(?: drainage)?(?: [a-z]+)?|lymph drainage|weight loss(?: [a-z]+)?|lose weight|slimming(?: [a-z]+)?|fat burn(?:ers?|ing)(?: [a-z]+)?|belly fat(?: [a-z]+)?|fat (?:freezing|dissolving)(?: [a-z]+)?|metabolism boost[a-z]*|immune (?:boost[a-z]*|support)|testosterone(?: [a-z]+)?|libido(?: [a-z]+)?|erection(?: [a-z]+)?|hangover (?:cure|patch(?:es)?|pills?|relief)|magnet(?:ic)? therapy|(?:negative )?ion(?:ic)? (?:bracelets?|necklaces?|bands?)|bio ?energy|quantum (?:pendants?|healing|scalar)|scalar energy|terahertz|ontgift[a-z]*|afslank[a-z]*|afvallen|vetverbrand[a-z]*|lymfedrainage|entgift[a-z]*|abnehmen|abnehm(?:tee|tabletten|kapseln|pflaster|gurtel|creme|produkt[a-z]*)|fettverbrenn[a-z]*|schlankheits[a-z]*|lymphdrainage`)],
    [NOT(raw`slimming (?:fit|cut|jeans|trousers|pants|dress(?:es)?|shirts?|jackets?|look|mirror|shapewear|bodysuits?|body suits?|underwear|briefs|leggings|tights|swimsuits?|tops?|tanks?)|digital detox|detox (?:box|kit for hair)`)]);
  rule('biocide', [W(raw`insect repellents?(?: [a-z]+)?|mosquito (?:repellents?|sprays?|killer sprays?|coils?|patch(?:es)?)|bug sprays?|insecticides?|pesticides?|weed ?killers?|herbicides?|rodenticides?|rat poison|mouse poison|ant (?:killers?|baits?|poison)|disinfectants?(?: [a-z]+)?|disinfecting (?:sprays?|wipes|liquid)|hand saniti[sz]ers?|saniti[sz]ing (?:sprays?|gel)|antibacterial (?:sprays?|gel|wipes|liquid)`),
    W(raw`muggenspray|insectenspray|insectenwerend[a-z]*|ontsmetting[a-z]*|desinfectie[a-z]*|desinfektion[a-z]*|insektenschutz ?spray|muckenspray|mueckenspray|insektizid[a-z]*|unkrautvernichter|rattengift|handdesinfektion[a-z]*`)],
    [NOT(raw`(?:electric|uv|ultrasonic|led|solar|usb) (?:mosquito|insect|bug)|mosquito (?:zappers?|lamps?|lights?|traps?|nets?|killer lamps?)|bug zappers?|insect (?:zappers?|lamps?|traps?|nets?|screens?)|(?:disinfectant|saniti[sz]er) (?:dispensers?|stations?|holders?|bottles?|stands?)|uv (?:saniti[sz]ers?|steriliz[a-z]*|disinfect[a-z]*)`)]);
  rule('bamboo', [W(raw`bamboo (?:fib(?:er|re)|melamine|powder)(?: [a-z]+)?(?: [a-z]+)? (?:cups?|mugs?|plates?|bowls?|tumblers?|lunch ?box(?:es)?|cutlery|tableware|dinnerware|sets?)|bamboo fib(?:er|re) (?:cups?|mugs?|plates?|bowls?|tumblers?|lunch ?box(?:es)?|cutlery|tableware|dinnerware|kids|baby)|melamine bamboo|bamboevezel (?:bekers?|borden?|kommen?|serviesset|servies|lunchbox|bestek)|bambusfaser (?:becher|teller|schalen?|schusseln?|geschirr|brotdose|besteck)`)]);
  const COMPAT = raw`dyson|airpods(?: pro| max)?|apple watch|nintendo(?: switch)?|playstation(?: \d)?|ps\d|xbox|lego|crocs|stanley|owala|yeti|hydro ?flask|theragun`;
  rule('brand', [W(raw`disney|marvel|pixar|star wars|harry potter|hogwarts|pokemon|pikachu|hello kitty|sanrio|kuromi|cinnamoroll|my melody|pochacco|lilo (?:and |& )?stitch|stitch (?:plush|toys?|dolls?|figures?|lamps?|night lights?|backpacks?|slippers|pajamas|pyjamas|onesies?|blankets?|pillows?|squishmallows?|keychains?|mugs?|cups?)|mickey(?: mouse)?|minnie(?: mouse)?|winnie the pooh|paw patrol|peppa pig|bluey|barbie|lego|duplo|minecraft|fortnite|roblox|nintendo|super mario|mario kart|zelda|playstation|xbox|squishmallows?|labubu|pop mart|sonny angels?|tamagotchi|rubik'?s?|nike|adidas|yeezy|new balance|gucci|louis vuitton|chanel|dior|prada|balenciaga|versace|hermes|rolex|cartier|omega (?:watch|seamaster|speedmaster)|ray ?ban|oakley|north face|moncler|canada goose|stone island|uggs?|crocs|birkenstocks?|lululemon|stanley (?:cups?|quencher|tumblers?|mugs?|flasks?)|owala|hydro ?flask|yeti (?:tumblers?|cups?|mugs?|coolers?|rambler)|dyson|theragun|airpods|apple watch|spider ?man|batman|superman|avengers|hulk|sailor moon|naruto|dragon ?ball|demon slayer|jujutsu kaisen|my little pony|hot wheels|nerf|care bears?|smurfs?|garfield|snoopy|sesame street|cocomelon|baby shark|pinkfong|gabby'?s dollhouse|sonic the hedgehog|stussy|off white|replicas?|1 ?: ?1 (?:copy|replica|quality)|aaa (?:quality|grade|replica)|dupes?|(?:inspired|insp) by`)],
    [NOT(raw`(?:for|fits?|fits for|compatible with|replacement for|works with) (?:the )?(?:` + COMPAT + raw`)|(?:` + COMPAT + raw`)(?: [a-z]+)? (?:cases?|covers?|bands?|straps?|chargers?|stands?|holders?|filters?|attachments?|accessor[a-z]*|grips?|skins?|protectors?|replacement|parts?|batteries|charms?|lids?|straws?|boots?|handles?|organi[sz]ers?|docks?|mounts?|bags?|pouch(?:es)?|keychains?|hooks?)|compatible|kompatibel|geschikt voor|passend fur|passend voor`)]);
  rule('digital', [W(raw`gift ?cards?|e ?gift cards?|e ?books?|digital (?:downloads?|products?|files?|planners?|art prints?|guides?)|printable (?:planners?|wall art|pdfs?|files?)|online (?:courses?|classes?|coaching)|masterclass|(?:shipping|order|package) protection|shipping insurance|cadeaukaart(?:en)?|cadeaubon(?:nen)?|geschenkgutschein[a-z]*|geschenkkarte[a-z]*|gutschein[a-z]*`)],
    [NOT(raw`gift card (?:holders?|boxes?|envelopes?|cases?)|e ?book readers?|ebook readers?|e ?book covers?|e ?book cases?`)]);
  // ---- Docs: it sells, with papers or care first.
  rule('claims', [W(raw`cures?|heals?|healing|treats? (?:pain|anxiety|insomnia|arthritis|acne|eczema|psoriasis|migraines?|headaches?)|relie(?:f|ves?|ving)|pain|aches?|soreness|anxiety|stress relief|clinically (?:proven|tested)|doctors? (?:recommended|approved|designed)|physio(?:therapist)?s? (?:recommended|approved)|chiropractors?(?: [a-z]+)?|medical grade|fda (?:approved|cleared|registered)|therapeutic|therapy|anti ?inflammatory|inflammation|circulation|boosts? (?:immunity|immune|metabolism)|burns? fat|insomnia|sleep better|deep sleep|posture correct[a-z]*|orthopedic|orthopaedic|orthotic|cellulite|varicose|lymphatic|sciatica|arthritis|plantar|neuropathy|migraines?|headaches?`),
    W(raw`geneest|genezen|pijn|pijnlijk[a-z]*|klinisch (?:bewezen|getest)|aanbevolen door (?:artsen|fysio[a-z]*)|ontsteking[a-z]*|bloedcirculatie|bloedsomloop|houdingscorrector|heilt|heilung|lindert|linderung|schmerz[a-z]*|klinisch (?:getestet|bewiesen|erwiesen)|von arzten empfohlen|entzundung[a-z]*|durchblutung|haltungskorrektur`)],
    [NOT(raw`(?:dog|cat|pet|puppy|horse)s? (?:[a-z]+ )?(?:orthopedic|orthopaedic|therapy|anxiety|arthritis|joint|pain|relief)|(?:orthopedic|orthopaedic|calming) (?:dog|cat|pet|puppy)|for (?:dogs?|cats?|pets?)|retail therapy|art therapy|sound therapy|aroma ?therapy|air circulation|pain free|painless`)], { ad: true });
  rule('ce', [W(raw`electric(?:al|ally)?|electronics?|usb(?: c)?|rechargeable|cordless|wireless|bluetooth|wi ?fi|smart ?(?:watch[a-z]*|bracelets?|rings?|scales?|plugs?|bulbs?|locks?|home|cameras?|doorbells?|thermostats?|bottles?|mugs?|feeders?|collars?|glasses|lights?|switch(?:es)?|sockets?|blinds?|speakers?|displays?|tv|pens?|garden)|leds?|lamps?|(?:night|string|fairy|ring|book|reading|desk|ceiling|wall|solar|garden|strip|neon|bike|bicycle|car|puck|motion sensor|sunset|mood|accent|cabinet|grow|tree|christmas|camping|head|work|flash|spot|pendant|floor|table|bedside|picture|mirror|vanity|aquarium|disco|party|projector) ?lights?|lights? (?:bulbs?|strips?|up|therapy)|flashlights?|headlamps?|lighting|projectors?|heaters?|heated|heating(?: [a-z]+)?|(?:hand|neck|foot|bed|cup|mug|seat|bottle|lunch|shoe|towel|wax|candle) warmers?|massagers?|massage (?:guns?|chairs?|pillows?|mats?|cushions?|devices?)|chargers?|charging(?: [a-z]+)?|power ?banks?|power stations?|speakers?|soundbars?|earbuds|earphones|headphones|headsets?|cameras?|dash ?cams?|webcams?|camcorders?|drones?|robots?|vacuum (?:cleaners?|sealers?)|robot vacuums?|blenders?|juicers?|kettles?|toasters?|air fryers?|(?:rice|slow|pressure) cookers?|coffee (?:makers?|machines?|grinders?)|espresso machines?|milk frothers?|(?:mini|neck|desk|ceiling|handheld|portable|electric|usb|tower|bladeless|clip|stroller|cooling|exhaust|pedestal|wall|bed|camping) fans?|fan heaters?|air conditioners?|air coolers?|humidifiers?|dehumidifiers?|(?:aroma|ultrasonic|scent|essential oil) diffusers?|air purifiers?|trimmers?|shavers?|(?:hair|dog|pet|electric|cordless) clippers?|epilators?|hair dryers?|blow dryers?|straighteners?|straightening brush(?:es)?|curling (?:irons?|wands?|tongs)|hot (?:brush(?:es)?|combs?)|(?:electric|sonic) toothbrush(?:es)?|water flossers?|(?:bathroom|kitchen|body ?fat|digital|smart|weighing|luggage|food|baby) scales?|motors?|motori[sz]ed|brushless|solar(?: [a-z]+)?|batter(?:y|ies)|lithium|li ion|li ?po|\d+ ?mah|\d+ ?watts?|\d+w|\d+ ?volts?|\d+v|plug ?in|(?:smart|wall|eu|uk|power) plugs?|power strips?|extension (?:cords?|leads?)|(?:usb|charging|hdmi|lightning|type c|power|extension) cables?|(?:travel|power|usb|charger|wall) adapters?|gps(?: [a-z]+)?|remote controls?|remote controlled|rc (?:cars?|planes?|boats?|trucks?|drones?|helicopters?|toys?)|walkie talkies?|radios?|baby monitors?|monitors?|doorbells?|alarms?|alarm clocks?|sensors?|thermostats?|(?:wall|alarm|digital|led|desk|smart) clocks?|keyboards?|(?:wireless|gaming|computer|bluetooth|optical) mouse|microphones?|(?:game|gaming|retro|handheld|video game) consoles?|(?:game|gaming|wireless) controllers?|(?:steam|travel|clothes|flat|curling|hair|soldering|waffle|electric) irons?|(?:garment|clothes|facial|face|hair|handheld|travel) steamers?|sewing machines?|glue guns?|drills?|(?:electric|power|circular|jig|reciprocating|cordless|chain|mini|table|miter|mitre) saws?|chainsaws?|soldering(?: [a-z]+)?|sanders?|angle grinders?|heat guns?|vibrating|vibration (?:plates?|platforms?)|uv (?:lamps?|lights?|saniti[sz]ers?|steriliz[a-z]*)|ultrasonic(?: [a-z]+)?|ionic(?: [a-z]+)?|ozone(?: [a-z]+)?|e ?bikes?|e ?scooters?|hoverboards?|(?:drawing|writing|lcd|graphics|android|kids) tablets?|e ?readers?|smart ?tvs?|routers?|thermal printers?|label printers?|printers?|scanners?|laminators?|shredders?|bug zappers?|(?:mosquito|insect) (?:zappers?|lamps?|killer lamps?)|(?:ice|ice cream|yogurt|bread|popcorn|waffle|sandwich|cotton candy) makers?|egg cookers?|food processors?|(?:hand|stand|electric) mixers?|sous vide|air pumps?|aquarium (?:pumps?|heaters?|filters?|lights?)|water pumps?|(?:cat|pet|dog) (?:water )?fountains?|automatic (?:[a-z]+ )?(?:feeders?|litter box(?:es)?|doors?)|self cleaning litter(?: [a-z]+)?`),
    S(raw`elektrisch|elektronisch|oplaadba|batterij|draadlo|nachtlamp|verlichting|projector|beamer|verwarm|kachel|ventilator|luchtbevochtig|stofzuig|oplader|powerbank|koptelefoon|scheerapparaat|fohn|stijltang|krultang|weegschaal|wiederaufladbar|akku|batterie|kabellos|drahtlos|leuchte|nachtlicht|lichterkette|projektor|heiz|beheizt|luftbefeuchter|staubsauger|ladegerat|lautsprecher|kopfhorer|kamera|rasierer|haartrockner|glatteisen|lockenstab|massagegerat|massageapparaat|zahnburste elektrisch|elektrische zahnburste`), W(raw`lamp[a-z]*|[a-z]+lamp(?:je|en)?|[a-z]+lampe|accu|accus|camera|speaker|waage|[a-z]+waage`)],
    [NOT(raw`electric (?:blue|purple|green|pink|violet|lime|yellow)|${NO_WIRE}|leg warmers?|arm warmers?|lamp ?shades?|clamps?|(?:camera|speaker|monitor|charger|drone) (?:bags?|straps?|lens caps?|tripods?|stands?|covers?|cases?|mounts?)|charger (?:organi[sz]ers?|holders?)|cable (?:organi[sz]ers?|clips?|ties?|management|holders?|protectors?)|habit trackers?|(?:makeup|beauty) blenders?|reed diffusers?|heatless(?: [a-z]+)?|vacuum (?:storage|bags?|seal(?:er)? bags)|drill bits?|catnip|toy mice|mouse ?(?:pads?|traps?|mats?)`), NOTS(raw`schoenlepel|lampenkap|lampenschirm|pijnverlicht`)]);
  rule('battery', [W(raw`batter(?:y|ies)(?: (?:powered|operated))?|rechargeable|cordless|lithium|li ion|li ?po|\d+ ?mah|power ?banks?|power stations?|solar (?:lights?|lamps?|lanterns?|panels?|chargers?|powered)|portable (?:blenders?|fans?|chargers?|speakers?|projectors?|heaters?|lights?|lamps?|massagers?|monitors?)|usb rechargeable|handheld fans?|neck fans?|e ?bikes?|e ?scooters?|hoverboards?|wireless (?:earbuds|headphones|mouse|keyboard|speakers?)|earbuds|smart ?watch[a-z]*`),
    W(raw`oplaadba[a-z]*|accu|accus|accupack|accuboor[a-z]*|batterij[a-z]*|akku[a-z]*|wiederaufladbar[a-z]*|batterie[a-z]*|kabellos[a-z]*|powerbank[a-z]*`)],
    [NOT(raw`(?:no|without|zonder|ohne) batter(?:y|ies|ij|ijen|ie|ien)|batter(?:y|ies) (?:not (?:needed|required|included)|free)|battery ?less|batteryless|batter(?:y|ies) (?:storage|organi[sz]ers?|cases?|holders?|testers?|boxes?)`)]);
  rule('radio', [W(raw`wireless|bluetooth|wi ?fi|gps(?: [a-z]+)?|rf(?: [a-z]+)?|nfc|zigbee|remote controls?|remote controlled|rc (?:cars?|planes?|boats?|trucks?|drones?|helicopters?|toys?)|walkie talkies?|radios?|smart ?watch[a-z]*|smart (?:home|plugs?|bulbs?|locks?|cameras?|doorbells?|rings?|glasses|speakers?|switch(?:es)?|sockets?|thermostats?|scales?|feeders?|collars?)|drones?|baby monitors?|(?:gps|pet|key|bluetooth|item|luggage|fitness) trackers?|airtags?|earbuds|tws|wifi cameras?|ip cameras?|security cameras?|video doorbells?`),
    W(raw`draadloze?|draadloos|drahtlos[a-z]*|funk[a-z]*|bluetooth[a-z]*`)],
    [NOT(raw`${NO_WIRE}|funky|funko`)]);
  rule('kids', [W(raw`kids?|kid'?s|children'?s?|childrens|child|toddlers?|babies|baby|infants?|newborns?|toys?|montessori|nursery|strollers?|prams?|pushchairs?|cribs?|bassinets?|pacifiers?|dummies|teethers?|teething|bibs?|diapers?|nappies|nappy|play ?mats?|playpens?|plush(?:ies|ie)?|plush (?:toys?|dolls?|animals?)|stuffed (?:animals?|toys?)|soft toys?|teddy bears?|dolls?|dollhouses?|action figures?|building (?:blocks?|bricks?|sets?)|slime|kinetic sand|play ?dough|fidget(?: [a-z]+)?|squish(?:y|ies)|pop ?its?|rattles?|baby walkers?|baby carriers?|booster seats?|high ?chairs?|potty(?: [a-z]+)?|school ?bags?|safety gates?`),
    W(raw`kinder[a-z]*|kindje[a-z]*|peuter[a-z]*|kleuter[a-z]*|speelgoed[a-z]*|knuffel[a-z]*|babyfoon|kinderwagen|wandelwagen|buggy|wieg|ledikant|speen(?:tje)?|fopspeen|bijtring|slabbetjes?|luiers?|speelmat|kleinkind[a-z]*|saugling[a-z]*|spielzeug[a-z]*|kuscheltier[a-z]*|pluschtier[a-z]*|puppen?|schnuller|beissring|latzchen|windeln?|spielmatte|babyphone|hochstuhl|kindersitz|lauflernhilfe|schleim|baby[a-z]+`), S(raw`kinderspeelgoed|kinderspielzeug|babyspeelgoed|babyspielzeug`)],
    [NOT(raw`(?:dog|cat|pet|puppy|kitten|bird|parrot|hamster|rabbit|chew|squeaky|catnip|rope|treat|dogs|cats) toys?|toys? for (?:dogs?|cats?|pets?|puppies|kittens|birds?|parrots?)|baby (?:pink|blue|yellow|green|purple|lilac|soft|hair|oil|powder|wipes|lotion|shampoo)|babydoll|baby doll (?:dress|lingerie|tops?|nightie)|(?:adult|sex|erotic) toys?|for adults|adult|kinderfrei|fur ?babies|plush (?:blankets?|throws?|robes?|rugs?|pillows?|slippers?|carpets?|sofas?|cushions?|bath ?mats?|towels?|sweaters?|jackets?|hoodies?)|kid ?gloves?|puppy pads?`), NOTS(raw`hondenspeelgoed|kattenspeelgoed|hundespielzeug|katzenspielzeug|haustierspielzeug|huisdierenspeelgoed|kinderfrei`)]);
  rule('food', [W(raw`(?:water|drinking|sports|baby|feeding|insulated|thermal|glass|kids|motivational|smart|vacuum|stainless steel|reusable|gym|travel) bottles?|tumblers?|mugs?|(?:coffee|tea|travel|drinking|sippy|measuring|silicone|reusable|espresso|paper|kids|baby) cups?|thermos(?:es)?|flasks?|lunch ?box(?:es)?|bento(?: box(?:es)?)?|food (?:containers?|storage|bags?|wraps?|covers?|processors?|choppers?|warmers?|grade)|storage (?:containers?|jars?)|(?:silicone|reusable|zip|freezer|sandwich) (?:food |storage )?bags|beeswax wraps?|(?:cutting|chopping|serving|charcuterie) boards?|cookware|frying pans?|(?:non ?stick|cast iron|copper|stainless steel|ceramic|grill|crepe|sauce|saute|baking) pans?|saucepans?|woks?|dutch ovens?|(?:cooking|stock|soup|instant|pressure) pots?|baking (?:mats?|trays?|sheets?|molds?|moulds?|dishes?)|(?:silicone|cake|ice|popsicle|chocolate|candy|gummy) (?:molds?|moulds?|trays?)|ice cube trays?|spatulas?|ladles?|whisks?|tongs|(?:kitchen|cooking|silicone|wooden) utensils?|cutlery|flatware|chopsticks|(?:drinking|reusable|silicone|metal|glass|bamboo|paper) straws?|(?:dinner|serving|salad|soup|mixing|cereal|ramen|rice|fruit|snack|kids) (?:plates?|bowls?)|dinnerware|tableware|plates? sets?|bowls? sets?|blenders?|juicers?|kettles?|coffee (?:makers?|presses|filters?|grinders?|machines?|scoops?)|french press|tea (?:infusers?|strainers?|pots?|sets?)|egg (?:cookers?|separators?|boilers?)|peelers?|graters?|slicers?|mandolines?|vegetable choppers?|can openers?|garlic (?:press(?:es)?|crushers?)|kitchen (?:gadgets?|tools?|scales?)|bpa ?free|baby (?:bottles?|spoons?|plates?|bowls?|feeders?)|sippy|(?:glass|storage|spice|honey|jam|mason) jars?|(?:cereal|rice) dispensers?|air fryer (?:liners?|paper|baskets?)`),
    W(raw`drinkfles[a-z]*|waterfles[a-z]*|thermosfles|bekers?|mok|mokken|broodtrommel|lunchbox|vershoud[a-z]*|snijplank[a-z]*|koekenpan[a-z]*|wokpan|braadpan|steelpan|bakvorm[a-z]*|bakmat|spatel|garde|bestek[a-z]*|rietjes|sapcentrifuge|theezeef|ijsblokjesvorm|eierkokers?|eierkocher|voorraadpot[a-z]*|kruidenpot[a-z]*|trinkflasche[a-z]*|wasserflasche[a-z]*|thermoskanne|thermosflasche|becher|tasse|tassen|brotdose|frischhaltedose[a-z]*|vorratsdose[a-z]*|schneidebrett|bratpfanne|pfanne[a-z]*|[a-z]+pfanne|kochtopf[a-z]*|topfset|backform[a-z]*|backmatte|pfannenwender|schneebesen|besteck[a-z]*|strohhalme?|entsafter|teesieb|eiswurfelform[a-z]*|gewurzglas[a-z]*|vorratsglas[a-z]*|lebensmittelecht|bpa ?frei`), S(raw`kaffeebecher|trinkbecher|koffiebeker|drinkbeker`)],
    [NOT(raw`(?:hair|curling|ceramic|styling) tongs|(?:wax|cosmetic|makeup) spatulas?|(?:foot|callus|skin) (?:peelers?|graters?)|(?:makeup|beauty) blenders?|(?:dog|cat|pet) (?:bowls?|bottles?|feeders?)|bottle openers?|(?:spray|hot water) bottles?|bottle brush(?:es)?|cups? holders?|mug (?:rugs?|racks?|trees?|holders?)`), NOTS(raw`flaschenoffner|flesopener`)]);
  rule('blade', [W(raw`knife|knives|cleavers?|machetes?|axe|hatchets?|swords?|katanas?|daggers?|box cutters?|utility knife|(?:chef|chefs|kitchen|santoku|paring|bread|steak|boning|fillet|carving|butcher|pocket|folding|hunting|survival|camping|tactical|damascus|ceramic|japanese) knif(?:e|es)|scalpels?|razor blades?|straight razors?|karambits?|multi ?tools?`),
    W(raw`mes|messen|messenset|koksmes|keukenmes[a-z]*|zakmes|broodmes|vleesmes|schilmesje|bijl|bijltje|zwaard|dolk|messer|messerset|kochmesser|kuchenmesser|taschenmesser|jagdmesser|brotmesser|axt|beil|schwert|dolch`)],
    [NOT(raw`sharpen[a-z]*|sharpeners?|knife (?:blocks?|holders?|racks?|stands?|storage|magnetic strip|guards?|covers?|sheaths?|rolls?|bags?)|magnetic knife|whetstones?|(?:butter|cheese|pizza|palette|putty|oyster|letter|craft|plastic|cake) knif(?:e|es)|axe throwing|messenslijper|messerscharfer|wetzstein|messenblok|messerblock|messenhouder|messerhalter`)]);
  rule('ship', [W(raw`sprays?|aerosols?|spray cans?|spray paint|liquids?|(?:washing|laundry|dish ?washer|dish) (?:liquid|powder|pods|gel)|inks?|paints?|glues?|super glue|adhesives?|resins?|epoxy|solvents?|bleach|butane|lighter fluid|(?:torch|jet|gas|butane|windproof|refillable) lighters?|neodymium|magnetic balls?|fire ?starters?|flammable|corrosive`),
    W(raw`spuitbus[a-z]*|vloeistof[a-z]*|lijm|verf|hars|aansteker|spruhdose|flussigkeit|kleber|klebstoff|harz|epoxidharz|sekundenkleber`), S(raw`feuerzeug`)],
    [NOT(raw`spray (?:bottles?|nozzles?|guns?|heads?|mops?|tan|tans)|mister bottles?|empty|liquid crystal|paint (?:brush(?:es)?|rollers?|trays?|sprayers?|pens?)|paint by numbers|glue (?:guns?|sticks?)|ink (?:pens?|stamps?)`)]);
  rule('sizing', [W(raw`dress(?:es)?|shirts?|t shirts?|tees?|blouses?|tank tops?|crop tops?|jeans|pants|trousers|leggings|shorts|skirts?|jackets?|coats?|hoodies?|sweaters?|jumpers?|cardigans?|vests?|bras?|bralettes?|underwear|briefs|boxers|panties|knickers|lingerie|shapewear|corsets?|waist trainers?|bodysuits?|jumpsuits?|rompers?|onesies?|p[ay]jamas?|swimsuits?|swimwear|bikinis?|tracksuits?|blazers?|shoes|sneakers|trainers|boots|sandals|slippers|heels|loafers|clogs|flip ?flops|compression (?:socks?|sleeves?|leggings)|gloves?|rings?|wedding bands?|(?:dog|cat|pet|puppy) (?:harness(?:es)?|coats?|jackets?|sweaters?|clothes|boots|shoes)|harness(?:es)?|insoles?`),
    W(raw`[a-z]*jurk(?:je|en)?|blouses?|[a-z]*broek(?:en)?|rok(?:ken)?|(?:winter|regen|zomer|leren|spijker|dons|outdoor|motor|softshell|ski|tussen|wind|fleece)?jas(?:je|sen)?|trui(?:en)?|vestje|beha|bh|ondergoed|badpak|[a-z]*schoenen|laarzen|sandalen|pantoffels|tuigje|[a-z]*kleid(?:er)?|[a-z]*hemd(?:en)?|bluse|hosen|(?:jogging|wander|stoff|leinen|cargo|outdoor|thermo|schlaf|bade|sport|stretch|jeans|regen|ski)hosen?|[a-z]*jacke(?:n)?|[a-z]*weste(?:n)?|pullover|unterwasche|dessous|badeanzug|[a-z]*schuhe|[a-z]*stiefel|hundegeschirr|kleding|kleidung`)],
    [NOT(raw`(?:ring|key|o|binder|phone|doorbell|teething|cock|napkin|curtain|shower curtain) rings?|rings? (?:lights?|holders?|stands?|binders?|doorbells?|cameras?|toss|sizers?)|onion rings|(?:spinning|table|counter|desk|bottle|stove) tops?|golf tees|(?:car|dash|seat) (?:boots?|covers?)|dress (?:forms?|hangers?|makers?)|shoe (?:racks?|horns?|organi[sz]ers?|deodori[sz]ers?|cleaners?|brush(?:es)?|trees?|covers?|bags?|storage|stretchers?)|boot (?:racks?|trays?|dryers?)|glove (?:boxes?|compartments?)`)]);
  rule('fragile', [W(raw`glass(?:es)?|glassware|ceramics?|porcelain|crystals?|mirrors?|marble|terrariums?|vases?|stoneware|earthenware|china (?:sets?|cups?|plates?)|light bulbs?|(?:smart|led|edison|vintage) bulbs?|aquariums?|fish tanks?|(?:snow )?globes?|lava lamps?`),
    W(raw`glas|glazen|glaswerk|keramiek|porselein|kristal|spiegel|vaas|vazen|keramik|porzellan|kristall|vase|vasen|glaser`), S(raw`wijnglazen|weinglaser|bierglazen|bierglaser`)],
    [NOT(raw`sun ?glasses|eye ?glasses|reading glasses|blue light glasses|safety glasses|swim(?:ming)? glasses|goggles|tempered glass|glass (?:screen )?protectors?|screen protectors?|magnifying glass|glass cleaner|crystal (?:clear|beads?)|liquid crystal|fiber ?glass|fibre ?glass|plexiglass|acrylic|unbreakable|shatter ?proof|car mirror|blind spot mirror|rear ?view mirror|healing crystals?|crystals? (?:healing|stones?)|zonnebril|sonnenbrille`)]);
  rule('bulky', [W(raw`furniture|sofas?|couch(?:es)?|armchairs?|recliners?|mattress(?:es)?|bed frames?|wardrobes?|bookcases?|bookshelves|cabinets?|dressers?|desks?|standing desks?|treadmills?|rowing machines?|exercise bikes?|spin bikes?|home gym|weight bench(?:es)?|power racks?|dumbbells? sets?|kettlebells?|trampolines?|bicycles?|e ?bikes?|bikes?|e ?scooters?|scooters?|kayaks?|paddle ?boards?|sup boards?|inflatable (?:pools?|boats?|kayaks?|hot tubs?)|hot tubs?|above ground pools?|pools?|bathtubs?|dog crates?|crates?|kennels?|cat trees?|cat towers?|strollers?|prams?|high ?chairs?|cribs?|bunk beds?|loungers?|hammock stands?|gazebos?|grills?|bbqs?|barbecues?|massage chairs?|massage tables?|(?:[2-9]|[1-9]\d+)(?:[.,]\d+)? ?kg`),
    W(raw`meubel[a-z]*|bank|banken|zetel|fauteuil|matras(?:sen)?|kledingkast|boekenkast|loopband|hometrainer|trampoline|fiets(?:en)?|zwembad|ligbad|mobel[a-z]*|sessel|matratze|kleiderschrank|bucherregal|schreibtisch|laufband|heimtrainer|fahrrad|badewanne|hundebox|kratzbaum`)],
    [NOT(raw`desk (?:organi[sz]ers?|lamps?|mats?|pads?|fans?|clocks?|calendars?|shelf risers?|accessor[a-z]*|chairs? cushions?|tidy)|under ?cabinet|cabinet (?:lights?|organi[sz]ers?|handles?|locks?|knobs?)|pool (?:floats?|noodles?|cleaners?|toys?|covers?|lights?|thermometers?|skimmers?|nets?|brush(?:es)?|cues?|tables?)|bikes? (?:lights?|locks?|holders?|mounts?|bells?|bags?|pumps?|seat covers?|gloves|helmets?|computers?|accessor[a-z]*|phone holders?|bottle holders?)|grill (?:pans?|mats?|brush(?:es)?|tools?|covers?|thermometers?)|(?:holds?|load|capacity|max|up to|bearing|supports?|tested) (?:[a-z]+ )?(?:[2-9]|[1-9]\d+)(?:[.,]\d+)? ?kg|piggy banks?|money banks?|power ?banks?`)]);

  // ---- Jev's answers (jev-questions.mjs): a yes at 0.5 or more; physical is the other way round ("not a physical product").
  const JEV = [['people', 'eat'], ['animals', 'pet_eat'], ['skin', 'cosmetics'], ['face', 'cosmetics'], ['brand', 'brand'], ['physical', 'digital', true],
    ['medical', 'claims'], ['electric', 'ce'], ['kids', 'kids'], ['foodcontact', 'food'], ['restricted', 'ship'], ['sizing', 'sizing'], ['fragile', 'fragile'], ['bulky', 'bulky']];
  const BLOCKERS = ['electric', 'skin', 'medical', 'brand', 'sizing', 'fragile', 'bulky', 'restricted', 'kids', 'foodcontact', 'hardsource'];
  const TRAITS = ['people', 'animals', 'gymwear', 'physical', 'face'].concat(BLOCKERS);
  // Jev's category, only where Jev gave no answer to the question behind it (an older answer, the TikTok tab).
  const CATS = [['Food and supplements', '', 'eat', 'people'], ['Pets', 'Food and treats', 'pet_eat', 'animals'], ['Beauty and personal care', 'Skincare', 'cosmetics', 'skin'],
    ['Beauty and personal care', 'Makeup', 'cosmetics', 'skin'], ['Beauty and personal care', 'Fragrance', 'cosmetics', 'skin'], ['Health and pain relief', '', 'claims', 'medical'],
    ['Baby and kids', '', 'kids', 'kids'], ['Kitchen', '', 'food', 'foodcontact'], ['Tech', '', 'ce', 'electric'], ['Clothing', '', 'sizing', 'sizing'], ['Shoes', '', 'sizing', 'sizing'],
    ['Pets', 'Clothing', 'sizing', 'sizing'], ['Pets', 'Harnesses, leashes and collars', 'sizing', 'sizing'], ['Other', 'Services and digital', 'digital', 'physical']];
  // About what a price is in euro, for the €150 line (a rough rate is enough for that).
  const RATE = { EUR: 1, USD: 0.92, GBP: 1.17, CHF: 1.05, AUD: 0.6, NZD: 0.55, CAD: 0.67, SGD: 0.68, HKD: 0.12, MOP: 0.115, JPY: 0.0061, KRW: 0.00066, MYR: 0.2,
    TWD: 0.028, AED: 0.25, ILS: 0.25, NOK: 0.085, SEK: 0.087, DKK: 0.134, PLN: 0.23, CZK: 0.04, HUF: 0.0025, RON: 0.2, CNY: 0.13 };
  const TMVIEW = 'https://www.tmdn.org/tmview/#/tmview/results?page=1&pageSize=30&criteria=C&basicSearch=';
  const GENERIC = new Set('a an and the of for with in on to by new pro plus max mini set kit pack pcs piece pieces premium original best smart portable electric 2 in 1 voor met en de het een van fur mit und der die das ein eine fuer'.split(' '));
  const CAPS = new Set('LED USB UV IPL SPF EMS TENS XXL XL XS RGB HD UK EU US NL DE BPA PVC ABS LCD DIY PCS MAX PRO NEW SET KIT'.split(' '));

  const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
  /** 'store.com/products/handle' for an https product page (as productKey in app.mjs), else ''. */
  function pageKey(u) {
    const m = /^https:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(https(u));
    if (!m) return '';
    const host = m[1].toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\d?\./, '');
    const h = /\/products\/([^/?#]+)/.exec(m[2] || '');
    if (!h || !host) return '';
    let handle = h[1];
    try {
      handle = decodeURIComponent(handle);
    } catch (e) {
      // keep it as it is
    }
    handle = handle.replace(/\.(js|json)$/i, '').toLowerCase();
    return handle ? host + '/products/' + handle : '';
  }
  const slugOf = (u) => { const k = pageKey(u); return k ? k.split('/products/')[1] : ''; };

  function around(t, a, b) {
    let s = a;
    while (s > 0 && letter.test(t[s - 1])) s--;
    let e = b;
    while (e < t.length && letter.test(t[e])) e++;
    const before = t.slice(Math.max(0, s - 60), s).trim().split(' ').slice(-2).join(' ');
    const after = t.slice(e, e + 60).trim().split(' ').slice(0, 2).join(' ');
    return (before + ' ' + t.slice(s, e) + ' ' + after).trim();
  }
  /** The hit as it stands in the name: a stem grows to its whole word ("pijnverlicht" in "pijnverlichting"). */
  function word(t, a, b) {
    while (a > 0 && letter.test(t[a - 1])) a--;
    while (b < t.length && letter.test(t[b])) b++;
    return t.slice(a, b).trim();
  }
  /** The first hit of a rule in a text that the words around it do not take back, or ''. */
  function hitOf(r, t) {
    if (!t) return '';
    for (const re of r.re) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) {
        const a = m.index + m[1].length;
        const hit = m[2];
        if (!r.not.some((n) => n.test(around(t, a, a + hit.length)))) return word(t, a, a + hit.length);
        re.lastIndex = a + Math.max(hit.length, 1);
      }
    }
    return '';
  }
  const eurOf = (price, cur) => {
    const p = Number(price);
    const r = RATE[String(cur || 'EUR').toUpperCase()];
    return price == null || price === '' || !Number.isFinite(p) || p <= 0 || !r ? null : p * r;
  };
  const sortReasons = (list) => list.sort((a, b) => ORDER.indexOf(a.k) - ORDER.indexOf(b.k));

  /** The name the words are read in: the title, and the words of its product link that the title does not have. */
  function textOf(x) {
    const title = norm(x.title);
    const have = new Set(title.split(' '));
    const extra = norm(slugOf(x.product)).split(' ').filter((w) => w && !have.has(w) && (have.add(w), true));
    return extra.length ? (title + ' ' + extra.join(' ')).trim() : title;
  }

  /** The reasons found for one product. block: only what can block it (the Worker's filter needs no more). */
  function scan(x, block) {
    const name = textOf(x);
    const ad = block ? '' : norm(x.copy).slice(0, 2000);
    const found = new Map();
    const add = (k, from, extra) => {
      let r = found.get(k);
      if (!r) found.set(k, (r = { k, level: LEVEL[k] || 'ret', short: SHORT[k], text: TEXT[k], from: [], hit: '', pay: PAY[k] || '' }));
      if (!r.from.includes(from)) r.from.push(from);
      for (const [f, v] of Object.entries(extra || {})) if (v != null && v !== '' && (r[f] == null || r[f] === '')) r[f] = v;
    };
    for (const r of R) {
      if (block && LEVEL[r.k] !== 'block') continue;
      const hit = hitOf(r, name);
      if (hit) add(r.k, 'name', { hit, pay: r.pay });
      else if (r.ad) {
        const h = hitOf(r, ad);
        if (h) add(r.k, 'ad', { adhit: h });
      }
    }
    const p = x.p && typeof x.p === 'object' ? x.p : {};
    const num = (k) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? p[k] : null);
    for (const [t, k, other] of JEV) {
      if (block && LEVEL[k] !== 'block') continue;
      const v = num(t);
      if (v != null && (other ? v < YES : v >= YES)) add(k, 'jev', x.yesno ? {} : { p: Math.round((other ? 1 - v : v) * 100) }); // yes / no only: no percentage
    }
    for (const [main, sub, k, t] of CATS) if ((!block || LEVEL[k] === 'block') && x.main === main && (!sub || x.sub === sub) && num(t) == null) add(k, 'cat', { cat: sub ? main + ' › ' + sub : main });
    const eur = block ? null : eurOf(x.price, x.cur);
    if (eur != null && eur / 1.21 > 150) add('ioss', 'price', { eur: Math.round(eur) });
    return { found, jev: Object.keys(p).length > 0 || !!x.main };
  }
  /**
   * The radar's own verdict on one product (x: fromAd, fromTikTok or fromFacts). Never the ad's words for a block: they
   * only add a claims caution, so the Worker can filter without them.
   */
  function auto(x) {
    const { found, jev } = scan(x, false);
    // A health block (medical, supplement, cosmetic...) says it all: no claims caution beside it.
    if ([...found.values()].some((r) => r.level === 'block' && HEALTH.includes(r.k))) found.delete('claims');
    const all = sortReasons([...found.values()]);
    const reasons = all.filter((r) => r.level !== 'ret');
    return { level: reasons.some((r) => r.level === 'block') ? 'block' : reasons.some((r) => r.level === 'docs') ? 'docs' : 'ok',
      reasons, returns: all.filter((r) => r.level === 'ret'), jev, x };
  }
  /** What can block a product, without the rest: its block reasons' keys (the Worker's filter). */
  const blocks = (x) => [...scan(x, true).found.keys()];
  /** Whether those keys with your check on top block it: the same answer as finish(auto(x), check).level === 'block'. */
  function blockedBy(keys, check) {
    const c = cleanCheck(check);
    if (c && c.level) return c.level === 'block';
    if (c && c.tm === 'conflict') return true;
    return keys.some((k) => k !== 'brand' || !(c && c.tm === 'clear'));
  }

  /** The words to search TMview for: the brand it names, a brand-like word (PawPal, GLOWUP), else the first words of the title. */
  function tmOf(x, brandHit) {
    const words = String(x.title || '').replace(/[^\p{L}\p{N}'& ]+/gu, ' ').split(/\s+/).filter(Boolean);
    const branded = words.find((w) => /^\p{Lu}?\p{Ll}+\p{Lu}[\p{L}\p{N}]*$/u.test(w) || (/^\p{Lu}{3,}$/u.test(w) && !CAPS.has(w)));
    const plain = words.filter((w) => !GENERIC.has(norm(w)) && !/\d/.test(w));
    const q = (brandHit || branded || plain.slice(0, 3).join(' ') || words.slice(0, 3).join(' ')).slice(0, 60);
    let shop = String(x.shop || '').trim();
    const host = (/^https:\/\/([^/?#:]+)/i.exec(https(x.store)) || [])[1] || '';
    if (!shop && host) {
      const parts = host.toLowerCase().replace(/^www\d?\./, '').split('.');
      shop = /myshopify\.com$/.test(host) ? parts[0] : parts.length > 2 && /^(?:co|com|org|net)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[Math.max(0, parts.length - 2)];
    }
    shop = shop.replace(/[-_]+/g, ' ').slice(0, 60);
    return { q, url: q ? TMVIEW + encodeURIComponent(q) : '', shop, shopUrl: shop && norm(shop) !== norm(q) ? TMVIEW + encodeURIComponent(shop) : '' };
  }

  /** Your check as it is kept: { tm, docs, level, note, at }, or null when there is nothing in it. */
  function cleanCheck(c) {
    if (!c || typeof c !== 'object') return null;
    const out = { tm: c.tm === 'clear' || c.tm === 'conflict' ? c.tm : '', docs: c.docs === true, level: ['ok', 'docs', 'block'].includes(c.level) ? c.level : '',
      note: typeof c.note === 'string' ? c.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) : '', at: typeof c.at === 'string' ? c.at.slice(0, 40) : '' };
    return out.tm || out.docs || out.level || out.note ? out : null;
  }

  /**
   * The verdict with your check on top. A trademark found clear takes the brand reasons off; a conflict blocks. Documents
   * received tick off every docs reason. Your call (level) wins over the radar's, which stays in auto.
   */
  function finish(a, check) {
    const c = cleanCheck(check);
    const reasons = a.reasons.map((r) => Object.assign({}, r));
    if (c && c.tm === 'clear') for (const r of reasons) if (r.k === 'brand') r.level = 'off';
    if (c && c.tm === 'conflict') reasons.unshift({ k: 'tm', level: 'block', short: SHORT.tm, text: TEXT.tm, from: ['you'], hit: '', pay: PAY.tm });
    if (c && c.docs) for (const r of reasons) if (r.level === 'docs') r.level = 'done';
    const radar = reasons.some((r) => r.level === 'block') ? 'block' : reasons.some((r) => r.level === 'docs') ? 'docs' : 'ok';
    const level = c && c.level ? c.level : radar;
    const ask = reasons.filter((r) => r.level === 'docs' && ASK[r.k]).flatMap((r) => ASK[r.k]).filter((x, i, l) => l.findIndex((y) => y[0] === x[0]) === i).concat([LABEL]);
    return { level, auto: a.level, radar, mine: !!(c && c.level), reasons, returns: a.returns, pay: (reasons.find((r) => r.level === 'block' && r.pay) || {}).pay || '',
      ask, tm: Object.assign({ status: c ? c.tm : '' }, tmOf(a.x || {}, ((a.reasons.find((r) => r.k === 'brand') || {}).hit) || '')), check: c, jev: a.jev, gpsr: GPSR, customs: CUSTOMS };
  }
  const verdict = (x, check) => finish(auto(x), check);

  // ---- The product as the radar reads it, from each place the board shows one.
  /** A board card (toAd in app.mjs). */
  function fromAd(a) {
    const j = a && a.jev;
    return { source: a && a.world ? 'world' : 'eu', id: String((a && a.id) ?? ''), title: String((a && a.title) || ''), product: https(a && a.product), store: https(a && a.store),
      shop: '', copy: String((a && a.copy) || ''), p: j && j.p && typeof j.p === 'object' ? j.p : null, main: j ? String(j.main || '') : '', sub: j ? String(j.sub || '') : '',
      price: a ? a.price : null, cur: a ? a.cur || '' : '' };
  }
  /** A row of the TikTok tab (/api/tiktok): Jev's blockers ("electric skin") and category, no other answers. */
  function fromTikTok(t) {
    const b = t.blockers == null ? null : String(t.blockers).split(/[\s,]+/).filter(Boolean);
    const p = b ? Object.fromEntries(BLOCKERS.map((k) => [k, b.includes(k) ? 1 : 0])) : null;
    return { source: 'tiktok', id: String(t.id ?? ''), title: String(t.title || ''), product: https(t.url), store: '', shop: String(t.shop || ''), copy: '', p, yesno: true,
      main: String(t.cat || t.category || ''), sub: '', price: t.p ?? t.price_min, cur: 'USD' };
  }
  /** A launch card's facts (launch.mjs): its risk keys stand for Jev's yes answers. */
  function fromFacts(f) {
    const risks = (Array.isArray(f && f.risks) ? f.risks : []).map((r) => r && r.k).filter(Boolean);
    let p = null;
    if (f && (f.jev || risks.length)) {
      p = {};
      for (const k of f.source === 'tiktok' ? BLOCKERS : TRAITS) p[k] = risks.includes(k) ? 1 : 0;
      if (f.source !== 'tiktok') p.physical = risks.includes('digital') ? 0 : 1;
    }
    return { source: f && f.source === 'tiktok' ? 'tiktok' : f && f.source === 'world' ? 'world' : 'eu', id: String((f && f.id) ?? ''), title: String((f && f.title) || ''),
      product: https(f && f.product), store: https(f && f.store), shop: String((f && f.adv) || ''), copy: '', p, yesno: true, main: f && f.jev ? String(f.jev.main || '') : '',
      sub: f && f.jev ? String(f.jev.sub || '') : '', price: f ? f.price : null, cur: f ? f.cur || '' : '' };
  }
  /** Where your check on a product is kept: its product page (store.com/products/handle), else its ad or its TikTok id. */
  function keyOf(x) {
    if (x.source === 'tiktok') return 'tiktok:' + x.id;
    const k = pageKey(x.product);
    return k && k.length <= 300 ? 'page:' + k : 'ad:' + x.id;
  }
  /** What to send the supplier on 1688: the documents to ask for, in English and Chinese. */
  function supplierRequest(v, title) {
    const list = (v && v.ask) || [LABEL];
    return [`Hello, before I order${title ? ` "${String(title).slice(0, 80)}"` : ''}: could you send these documents?`, ...list.map((x, i) => `${i + 1}. ${x[0]}`), '',
      '您好，下单前请提供此产品的以下文件：', ...list.map((x, i) => `${i + 1}. ${x[1]}`)].join('\n');
  }

  return { LEVEL, SHORT, TEXT, PAY, GPSR, CUSTOMS, TRAITS, BLOCKERS, norm, pageKey, auto, blocks, blockedBy, finish, verdict, cleanCheck, fromAd, fromTikTok, fromFacts, keyOf, supplierRequest };
}

export const { LEVEL, SHORT, TEXT, PAY, GPSR, CUSTOMS, TRAITS, BLOCKERS, norm, pageKey, auto, blocks, blockedBy, finish, verdict, cleanCheck, fromAd, fromTikTok, fromFacts, keyOf, supplierRequest } = riskKit();
/** GET /risk.js: the kit's source, run once in the board as window.RISK. */
export const RISK_JS = `'use strict';\nwindow.RISK = (${riskKit})();\n`;

// ---------------------------------------------------------------------------
// The board's lists: ?risk=hide on /api/ads and /export.csv
// ---------------------------------------------------------------------------

/** A board row (products() in app.mjs) as the radar reads it: the fields of its card (toAd), without the ad's words. */
export const rowInput = (r) => fromAd({ id: r.ad_id, title: r.product_title, product: r.product_url, store: r.store_url, world: r.world, jev: r.jev, price: r.price, cur: r.currency });

// The radar's answer per product, so a page of the board does not read every name again (the rows change a few times a
// day). What can block a product depends on its name, link and Jev's answers only (not its price or ad). A row with Jev's
// answers keeps it on that answer object (the board reads it once per read of its tables), the others by name and link.
const BY_JEV = new WeakMap();
const AUTO = new Map();
const AUTO_MAX = 20000;
function autoRow(r) {
  const j = r.jev && typeof r.jev === 'object' ? r.jev : null;
  let hit = j ? BY_JEV.get(j) : AUTO.get((r.world ? 'w' : 'e') + '\u0001' + r.ad_id + '\u0001' + (r.product_title || '') + '\u0001' + (r.product_url || ''));
  if (hit && hit.t === r.product_title && hit.u === r.product_url && hit.id === r.ad_id) return hit;
  const x = rowInput(r);
  hit = { t: r.product_title, u: r.product_url, id: r.ad_id, blocks: blocks(x), key: keyOf(x) };
  if (j) BY_JEV.set(j, hit);
  else {
    if (AUTO.size >= AUTO_MAX) AUTO.clear();
    AUTO.set((r.world ? 'w' : 'e') + '\u0001' + r.ad_id + '\u0001' + (r.product_title || '') + '\u0001' + (r.product_url || ''), hit);
  }
  return hit;
}
/** Whether the radar blocks a board row, with your check on it (blockedBy: the same answer as its card shows). */
export function rowBlocked(r, checks) {
  const { blocks: keys, key } = autoRow(r);
  return blockedBy(keys, checks && checks.get(key));
}

/**
 * With ?risk=hide, every product the radar blocks leaves the Inbox and Browse of the EU tab, outside the EU and the Google tab
 * (list.v, list.w, list.gl: their counts too). ✓ Approved and ★ (list.k) keep them, with their badge. On ✓ (view=made) it also
 * counts its levels. list.risk: for riskOut.
 */
export function riskHide(list, params, checks = new Map(), toAd = null) {
  const hide = params.get('risk') === 'hide';
  const scope = params.get('scope');
  const on = scope === 'world' ? 'w' : scope === 'google' ? 'gl' : 'v'; // the tab you look at: its hidden products are counted
  const out = { hide, hidden: 0 };
  if (hide) {
    for (const k of ['v', 'w', 'gl']) { // the EU tab, outside the EU, the Google tab
      if (!Array.isArray(list[k])) continue;
      const keep = [];
      for (const r of list[k]) {
        if (!rowBlocked(r, checks)) keep.push(r);
        else if (k === on && r.hid === 0) out.hidden++;
      }
      list[k] = keep;
    }
  }
  if (params.get('view') === 'made' && typeof toAd === 'function' && Array.isArray(list.k)) {
    out.levels = { block: 0, docs: 0, ok: 0 };
    for (const r of list.k) {
      if (r.hid !== 1) continue;
      const x = fromAd(toAd(r));
      out.levels[verdict(x, checks.get(keyOf(x))).level]++;
    }
  }
  list.risk = Object.assign(out, { checks });
  return out;
}

/** /api/ads' risk: { hide, hidden, levels?, checks: your checks on the products of this page, by key }. */
export function riskOut(list, rows) {
  const r = list.risk || { hide: false, hidden: 0, checks: new Map() };
  const checks = {};
  for (const row of rows) {
    const k = autoRow(row).key;
    const c = r.checks && r.checks.get(k);
    if (c) checks[k] = c;
  }
  const out = { hide: r.hide, hidden: r.hidden, checks };
  if (r.levels) out.levels = r.levels;
  return out;
}

// ---------------------------------------------------------------------------
// Your checks: rows 'risk:<key>' in the state table, JSON { tm, docs, level, note, title }
// ---------------------------------------------------------------------------

// A range on the primary key: D1 reads the risk rows only, never the whole table.
export const CHECKS_SQL = "SELECT key, value, updated_at FROM state WHERE key >= 'risk:' AND key < 'risk;'";
// One check merged into what is there (JSON merge patch: a null takes a field out), in one statement.
export const SAVE_SQL = `INSERT INTO state (key, value, updated_at) VALUES (?1, json_patch('{}', ?2), ?3)
ON CONFLICT(key) DO UPDATE SET value = json_patch(CASE WHEN json_valid(state.value) THEN state.value ELSE '{}' END, ?2), updated_at = ?3`;
// Nothing left in it (every field taken back): the row goes.
export const EMPTY_SQL = "DELETE FROM state WHERE key = ?1 AND json_extract(value, '$.tm') IS NULL AND json_extract(value, '$.docs') IS NULL AND json_extract(value, '$.level') IS NULL AND json_extract(value, '$.note') IS NULL";

function checkOf(row) {
  let v;
  try {
    v = JSON.parse(row.value || '{}');
  } catch (e) {
    return null;
  }
  return cleanCheck(Object.assign({}, v, { at: row.updated_at || '' }));
}

/** Every check: Map(key → check). A read that fails is no check at all: the board still works. */
export async function riskChecks(env) {
  try {
    const { results } = await env.DB.prepare(CHECKS_SQL).all();
    const m = new Map();
    for (const row of results || []) {
      const c = checkOf(row);
      if (c && typeof row.key === 'string') m.set(row.key.slice('risk:'.length), c);
    }
    return m;
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) console.error(e); // no tables yet: the board says so on its own
    return new Map();
  }
}

/** GET /api/risk: { checks } (the TikTok tab and the launch cards read them here). */
export async function riskList(env) {
  return { checks: Object.fromEntries(await riskChecks(env)) };
}

const bad = (error, status = 400) => ({ status, body: { error } });

/**
 * POST /api/risk: your check on one product. {id}: a board product (any of its ads), {tiktok}: a TikTok product.
 * tm: 'clear' | 'conflict' | '' (taken back); docs: true | false; level: 'ok' | 'docs' | 'block' | '' (the radar's call); note.
 * Only the fields sent change. deps.rows(): every board row (snapshot in app.mjs). Returns { status, body } (body.check: it now).
 */
export async function riskPost(env, j, now, deps) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('Bad JSON');
  const patch = {};
  if (j.tm !== undefined) {
    if (!['', 'clear', 'conflict'].includes(j.tm)) return bad('Bad trademark check');
    patch.tm = j.tm || null;
  }
  if (j.docs !== undefined) {
    if (typeof j.docs !== 'boolean') return bad('Bad docs');
    patch.docs = j.docs || null;
  }
  if (j.level !== undefined) {
    if (!['', 'ok', 'docs', 'block'].includes(j.level)) return bad('Bad level');
    patch.level = j.level || null;
  }
  if (j.note !== undefined) {
    if (typeof j.note !== 'string') return bad('Bad note');
    patch.note = j.note.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) || null;
  }
  if (!Object.keys(patch).length) return bad('Nothing to save');
  let key;
  let title;
  if (j.tiktok != null) {
    const id = String(j.tiktok);
    if (!/^\d{1,25}$/.test(id)) return bad('Bad product');
    const t = await env.DB.prepare('SELECT id, title FROM tiktok_products WHERE id = ?').bind(id).first().catch(() => null); // no TikTok table: unknown
    if (!t) return bad('Unknown product', 404);
    key = 'tiktok:' + id;
    title = t.title;
  } else {
    const id = String(j.id ?? '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return bad('Bad product');
    const r = (await deps.rows()).find((w) => String(w.ad_id) === id);
    if (!r) return bad('Unknown product', 404);
    key = keyOf(rowInput(r));
    title = r.product_title;
  }
  patch.title = String(title || '').slice(0, 200);
  const at = new Date(now).toISOString();
  const k = 'risk:' + key;
  await env.DB.batch([env.DB.prepare(SAVE_SQL).bind(k, JSON.stringify(patch), at), env.DB.prepare(EMPTY_SQL).bind(k)]);
  const row = await env.DB.prepare('SELECT key, value, updated_at FROM state WHERE key = ?').bind(k).first();
  return { status: 200, body: { ok: true, key, check: row ? checkOf(row) : null } };
}
