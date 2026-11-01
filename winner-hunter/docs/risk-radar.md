# Risk radar: Block, Docs or OK

Every product on the board gets one badge from the risk radar (`worker/src/risk.mjs`):

| Badge | Means | On the board |
|---|---|---|
| **Block** | Do not sell it as it is: a law, Shopify Payments or EU customs stops it. | Hidden in the Inbox and Browse (EU, Outside EU and Google tabs) and on the TikTok tab, until you tap **Show**. ✓ Approved keeps it, with its badge. |
| **Docs** | It sells, but with papers or care first: CE, a battery, a toy, food contact, a claim, a blade, a hard-to-ship liquid. | Shown, with what to ask the supplier for. |
| **OK** | Nothing found in its name, its link or Jev's answers. | Shown. |

Beside the badge, return risks: **↩ Sizes**, **Fragile**, **Bulky**, **Over €150**. They do not change the badge.

The radar is a checklist, not legal advice. It reads the product's name (and the words of its product link), Jev's answers
(world-check.mjs) and its category. It never blocks on the ad's words: those only add a claims caution (Docs). Words miss some
products and Jev can be wrong, so every badge says why, and your own call (below) always wins.

## Where you see it

- **Inbox**: one line under the title, for instance `Docs · CE · Battery · Food contact`. The data only, no buttons (the Inbox
  stays a place to decide fast). Block products are not in it, unless you tapped Show.
- **Browse, ✓ Approved, the TikTok tab, a launch card (🚀)**: the same line is a button. A tap opens the reasons (with the words
  it matched, Jev's answer or the category), Shopify Payments, the trademark search, the documents to ask the supplier for,
  your checks, GPSR and customs.
- **Above the cards**: how many Block products are hidden, and **Show** (or **Hide them**). On ✓: *Risk radar on the 33 you
  approved: 9 Block · 8 Docs · 16 OK*. The setting is kept on that phone (`localStorage` `wh-risk`).
- **TikTok tab**: the chip **Show blocked** with the number it hides.
- **CSV**: what you see. With Block hidden, no Block products in it either.

## Your checks

In the opened radar on a card (saved at once, one after the other):

- **Trademark: Clear / Conflict.** The links search TMview (EUIPO, the Benelux office BOIP, DPMA, WIPO and the other EU offices
  at once) for the brand it names or its first words, and for the shop's name. TMview has no free API (its server answers
  scripts with "Request Rejected"), so the search is yours: **Clear** takes a brand block off, **Conflict** blocks.
- **I have these documents.** The supplier sent what the radar asks for: the Docs reasons are ticked off.
- **Your call: OK / Docs / Block.** Wins over the radar's (which stays visible next to it).
- **Copy request (EN + 中文).** The documents to ask for, in English and Chinese, for the 1688 chat.

Kept in D1's `state` table, one row per product: key `risk:page:<store.com/products/handle>` (or `risk:ad:<ad id>` without a
product page, `risk:tiktok:<id>`), value JSON `{ tm, docs, level, note, title }`. No migration: nothing to deploy first. To read
them all: `SELECT key, value, updated_at FROM state WHERE key >= 'risk:' AND key < 'risk;'`.

## The rules

| Reason | Badge | Found by (examples; English, Dutch, German) | The rule behind it |
|---|---|---|---|
| Food or supplement | Block | Jev "people take it"; *supplement, capsules, gummies, collagen powder, ashwagandha, voedingssupplement, Nahrungsergänzungsmittel, Kapseln*; category Food and supplements | EU food law, health-claim rules (EU 1924/2006), food business registration. Supplements: Shopify Payments, pseudo pharmaceuticals |
| Cosmetic | Block | Jev "on the skin / on the face"; *serum, face cream, toothpaste, teeth whitening, perfume, essential oils, hair growth oil, sunscreen, nail polish, gezichtscrème, tandenbleekset, parfum, etherische olie, haargroei, zonnebrand, Nachtcreme, ätherische Öle, Haarwuchs, Zahnaufhellung, Duschgel*; Skincare, Makeup, Fragrance. Not for a diffuser | EU responsible person, CPNP notification and a safety report per product (EU 1223/2009); essential oils also CLP hazard labels (EU 1272/2008) |
| Medical claim | Block | *pain relief, back pain, sciatica, TENS, anti-snoring, eczema, rugpijn, Rückenschmerzen, Schnarchstopper* | Medical device rules (MDR, EU 2017/745); Meta rejects the ads |
| Medical device | Block | *blood pressure monitor, oximeter, hearing aid, fever thermometer, IPL, laser hair removal, contact lenses, bloeddrukmeter, Blutdruckmessgerät* | MDR, Annex XVI for IPL and coloured lenses |
| Health promise | Block | *detox pads, weight loss, slimming, lymphatic drainage, afslank, abnehmen, Lymphdrainage* | Shopify Payments: pseudo pharmaceuticals; Meta |
| Pet medicine | Block | *flea, tick collar, dewormer, calming chews, joint supplement for dogs, vlooienband, vitaminen voor honden, Flohhalsband, Wurmkur, Gelenktabletten für Hunde* | EU veterinary medicine and biocide rules |
| Biocide or pesticide | Block | *insect repellent, mosquito spray, hand sanitiser, disinfectant, weed killer, muggenspray* | EU 528/2012 (biocides), EU 1107/2009 (plant protection) |
| Weapon | Block | *pepper spray, stun gun, brass knuckles, butterfly knife, switchblade, airsoft, pepperspray, vlindermes, Pfefferspray, Schlagring* | Dutch Wet wapens en munitie, German Waffengesetz. Shopify Payments: regulated or illegal products |
| Tobacco, CBD or fireworks | Block | *vape, e-cigarette, nicotine, CBD, THC, kratom, laughing gas, fireworks, lachgas, vuurwerk, Feuerwerk* | Age, drug and fireworks rules; Shopify Payments: regulated or illegal products |
| Adult | Block | *sex toy, vibrator* | Shopify Payments: adult products |
| Brand risk | Block | Jev "a famous brand or a copy"; *Disney, Pokémon, Stitch, LEGO, Nike, Stanley cup, Labubu, dupe, replica, 1:1*. Not for "case for AirPods" or "compatible with" | Counterfeit: EU customs seize it; Shopify Payments: counterfeit products. A clear trademark check lifts it |
| Bamboo tableware | Block | *bamboo fibre cups, plates, lunch boxes, bamboevezel, Bambusfaser* | Bamboo in plastic is not allowed for food contact in the EU |
| Not physical | Block | Jev "not a physical product"; *gift card, e-book, shipping protection, cadeaubon, Geschenkgutschein* | The board's own rule |
| Pet food | Docs | Jev "pets take it"; *dog food, cat treats, hondenvoer, Hundefutter* | EU feed rules; animal products from China are stopped at the border. Docs, not Block: Connor keeps pet food on the board (2026-10-31) |
| CE | Docs | Jev "battery or electric"; *electric, USB, LED, lamp, heated, massager, projector, elektrisch, verwarmd, Akku, beheizt* | CE declaration and test reports (EMC, RoHS; LVD with mains power); WEEE registration (NL: Stichting OPEN) |
| Battery | Docs | *rechargeable, cordless, lithium, mAh, power bank, oplaadbaar, accu, wiederaufladbar, kabellos* | UN38.3 test summary, MSDS and the capacity in Wh; battery labels and registration (EU 2023/1542); a shipping line that takes batteries |
| Radio | Docs | *wireless, Bluetooth, Wi-Fi, GPS, remote control, draadloos, drahtlos, Funk* | RED test report (EU 2014/53) |
| Kids | Docs | Jev "for children"; *kids, baby, toy, plush, Montessori, kinder, speelgoed, Spielzeug*; Baby and kids. Not for "dog toy" | CE and EN 71 for toys (2009/48/EC), age warnings; childcare products need their own EN test |
| Food contact | Docs | Jev "touches food"; *water bottle, lunch box, cutting board, pan, egg cooker, drinkfles, eierkoker, Trinkflasche, Pfanne*; Kitchen | Food-contact declaration (EU 1935/2004; plastics EU 10/2011), LFGB migration test |
| Claims | Docs | Jev "a medical claim" (it may be the ad's); *posture corrector, relieves, clinically proven*, also in the ad's words | Sell it without treat, cure or relieve claims (MDR, Meta) |
| Blade | Docs | *knife, chef knife, axe, sword, koksmes, Küchenmesser*. Not for "knife sharpener" or "knife block" | Shipping lines, Meta's weapon ads, 18+ checks |
| Hard to ship | Docs | Jev "hard to ship"; *spray, liquid, glue, paint, resin, butane, spuitbus, lijm, Kleber* | MSDS and a line that takes it |
| ↩ Sizes, Fragile, Bulky | flag | Jev's answers; *dress, shoes, bra (wireless too), ring, jurk, overhemd, winterjas, Sommerkleid, Winterjacke, Steppweste, Laufschuhe; glass, ceramic, furniture, 7kg* | Returns and damage |
| ↩ Over €150 | flag | The price, about in euro, before 21% VAT | No IOSS above €150: the buyer pays import VAT and duty at the door |

On every product, whatever its badge:

- **GPSR** (EU 2023/988, since 13 Dec 2024): an EU responsible person (you as the importer, or a paid service) on the product
  and on its product page, with the maker, a type or batch number and warnings in Dutch or German.
- **Customs straight from China**: about €5 an order (€3 duty a parcel under €150 from 1 Jul 2026, €2 handling an item line
  from 1 Nov 2026; Connor's research).
- **Shopify Payments**: its prohibited groups (help.shopify.com, *Shopify Payments eligibility*): regulated or illegal products,
  adult products, pseudo pharmaceuticals, counterfeit products (and financial products and gambling, which the board does not have).

## How it filters

`/api/ads` and `/export.csv` take `?risk=hide`: the Worker leaves out every product the radar blocks from the Inbox and Browse
of the EU, Outside EU and Google tabs, and from their counts. It reads your checks once per request (an index range on `state`), and keeps the radar's
answer per product in memory (about 20 µs a product the first time, nothing after). Without `?risk`, the API is as it was. The
board sends `risk=hide` unless you tapped Show. The TikTok tab filters on the phone: all its rows are there already.

The browser runs the same code: `/risk.js` is `riskKit` as a script (`window.RISK`), as `/launch.js` is for the Launch view.

## Tests

- `test/fixtures/approved-36.json`: the 36 approvals of the review ([approved-products-review.md](../../docs/learnings/approved-products-review.md)),
  P1-P36 with its numbers. `test/risk.test.mjs` proves that exactly its 9 restricted ones (P10, P13, P17, P20, P24, P26, P28,
  P29, P33) are Block, each for its own reason (perfume, essential oils, pet health, skin twice, a health-claim device, a
  supplement, coffee, hair care), that the other 27 sell (9 Docs, 18 OK), that its 12 needing a size (P3, P7, P8, P9, P12, P14,
  P16, P19, P21, P27, P30, P35) carry ↩ Sizes and no block, and that P16 and P35 (the same jacket) share one key. The review
  kept the numbers, categories and findings, not the export's rows: titles (English, Dutch, German), stores and prices are
  reconstructions, and so is where the 6 approvals not from the EU tab came from. Put the real rows in (same fields) and the
  test checks them. Its `notApproved` products (outside the EU, TikTok) test those tabs' filters.
- Of the 9, the board on main already kept 3 out of the Inbox (P17, P28, P29: Jev says people or animals take them, #28);
  the radar takes out all 9, in Browse too.
- The same test file: every title the hunt's EU screen (`lib/world.mjs`) takes off is Block here, its tools and look-alikes
  are not; the Worker's filter and the card always agree; the ad's words never block; `/risk.js` answers as the module; the API.
- `test/risk.e2e.test.mjs`: the board in Chromium at iPhone size.

Two differences with the hunt's EU screen, on purpose: IPL hair removal is Block (MDR Annex XVI), pet food is Docs.
