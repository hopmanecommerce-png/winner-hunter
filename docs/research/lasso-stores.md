# Lasso checkout stores: how to find them, who they are, what they sell

Research for Winner Hunter, 2026-11-01. Every store in this report was fetched live on 2026-11-01. Where something
is an inference (a shared owner, a network), the text says so. The full list is `docs/research/lasso-stores.csv` (one row per store, 28 columns, 143 rows: the 129 live stores, plus the closed ones and the ones that left Lasso). The weekly method is built
into the repo as an optional, switched-off discovery source (`winner-hunter/lasso.mjs`, workflow **Lasso stores**).

## In short

- **Lasso** (lassocommerce.com, earlier lassocart.com; Lasso Inc., Wilmington DE, founded 2024) is a hosted checkout
  for Shopify stores: a visual checkout builder, upsells, downsells, order bumps, subscriptions, and payments routed
  over Whop, Stripe, Adyen and NMI (Gr4vy does the orchestration, Whop the marketplace payouts). Price: $149 per store
  per month billed yearly ($199 monthly) plus 1% of every sale. There is no Shopify app: a store installs it with a
  theme script and a DNS record.
- **How to recognise a Lasso store:** its pages load
  `https://checkout.<store>/shopify-scripts/lasso-script-v4.min.js` (older: `-v2`, plain `lasso-script.min.js`), and
  `checkout.<store>/checkout` serves Lasso's checkout app (title "Secure Checkout", markers `lasso_theme_hint` and
  `lasso-dark-boot`, Whop's payment elements). Details in [Fingerprints](#1-fingerprints-exact-strings).
- **How to find them for free:** urlscan.io's public search API, no account needed:
  `filename:"lasso-script-v4.min.js"` (plus v2, v1, `domain:lassocheckout.com` and Lasso's checkout pages). Free
  without a key means the last 30 days and 100 results per search, so the search goes in 2-day windows.
- **Found and verified:** **129 live Shopify stores on Lasso** (116 sure: script and checkout app both live; 13 likely:
  Lasso's checkout app live on their checkout subdomain, no script on the home page). Another 8 had Lasso but were
  closed or unreachable that day, and 6 still carry the script while their checkout has moved (they left Lasso).
  Aliases are counted once: one store with six domains is one row.
- **The universe is about 10x bigger:** StoreLeads tracks "Lasso Cart" on **1,316** stores; WhoisFreaks has **3,153**
  hostnames pointing at the Vercel address that Lasso checkouts use (shared with other Vercel apps, so not all are Lasso)
  and **95** pointing at Lasso's customer portal. urlscan only sees the stores somebody scanned in the last 30 days.
  The three WhoisFreaks hostnames visible without an account all verified as live Lasso stores.
- **What kind of stores:** mostly aggressive direct-response stores. At least a quarter (33) are "local family
  boutique" fashion stores with invented local stories ("Mathilde München", "Lowell Sydney", "The Thomas Family Palm Beach"); 38 of
  the 129 are registered in the Netherlands (Shopify's meta.json), selling in AUD, CAD, USD, GBP, EUR and DKK. Then
  subscription supplement/beauty funnels with advertorial pages (Glow Gummies, Flora), single-product gadget and home
  brands, "maker story" home-and-garden stores on native ads, and big general stores.
- **What sells across them** (a store's own best-seller order, Shopify Storefront API): orthopedic women's footwear is a
  top-5 best seller in **19** Lasso stores (AU, CA, US, UK, DE); hand-quilted animal baskets and artisan tote bags in
  **10**; "maker story" garden decor (bee hotels, bird baths) and copper jewelry in 4 each; velvet bedding; advent
  calendars for Q4. See [Top 15](#5-top-15-stores-and-products-to-look-at).

- **Ads:** 29 of the 129 stores had active Meta ads showing their domain on 2026-11-01 (public Ad Library, logged out,
  all countries); 17 of them 20 or more. The rest buy traffic elsewhere (native ads, Google, TikTok) or advertise through
  other domains. Biggest: Glow Gummies (484 active ads on its page), Goda (4,239 ads show goda.co), Bloomin (2,368),
  Jennifer Bags (184), EdJ VNTGE (128), MiracleMop (ads running since January 2025).
- **For the EU:** 21 stores sell in EUR and 9 in German, and the Dutch angle is strong: 38 of the 129 are registered in
  the Netherlands. See [EU and NL/DE](#4-eu-and-nlde).

## 1. Fingerprints (exact strings)

Checked on live stores (backroad-goods.com, tryglowgummies.com, outdoorhaven.dk, cocosydney.co and others) and in
Lasso's own code on 2026-11-01.

| Where | Exact fingerprint | Proof? |
|---|---|---|
| Store page (Shopify theme) | `<script src="https://checkout.<store>/shopify-scripts/lasso-script-v4.min.js" data-store-id="<24 hex>" data-checkout-url="checkout.<store>/checkout" defer>` | Yes (v4: 97 of 129 stores) |
| Older versions | `lasso-script-v2.min.js` (17 stores), `lasso-script.min.js` (2; this one also has `data-api-url="https://livebackend.lassocheckout.com:3000/api"`) | Yes |
| The checkout subdomain | Usually `checkout.<store>`, sometimes `secure.<store>` (edjvntge.uk) or another domain of the same owner (madebybellablu.com → `checkout.bellablunashville.com`, balm-official.com → `checkout.gencivie-official.com`) | — |
| Checkout page | `checkout.<store>/checkout`: `<title>Secure Checkout</title>`, `body.lasso-dark-boot`, `localStorage.getItem('lasso_theme_hint')`, query `?storeId=…&sid=…`, Vite bundle `/assets/main-*.js`, `server: Vercel`, `content-disposition: inline; filename="index.html"` | Yes: the most reliable sign |
| Checkout payments | `https://cdn.whop.com/elements/amber/elements.js`, `https://api.whop.com` (Whop's payment elements); error text "Backend Whop mode is unavailable or differs from this checkout." | Yes |
| Checkout extras | order bump (`lasso_order_bump_<n>`, "Order bump"), upsells/downsells (`declineUpsell`), post-purchase (`/cart-sessions/post-purchase`, `/checkout/post-purchase-surveys/live`), PostHog proxy `/ph/static/array.js`, IntentWave `/iw/track.js` | — |
| Store script's API calls | `https://api.lassocheckout.com/api/cart-sessions/sync-cart` (POST), `/cart-sessions/get-session-simple?session_id=`, `/cart-sessions/check-status`, `/cart-sessions/whop-pixel-config?store_id=`, `/integrations/intentwave/pixel-config?store_id=` | Yes |
| Cookie / storage | cookie `lasso_sid=<session>; domain=.<store>; max-age=1800`; localStorage `__lasso_token__`, `__lasso_cart_snapshot__`, `lasso_fbclid`, `lasso_fbclid_ts`, `lasso_fwd_params`, `lasso_iw_anonymous_id`, `lasso_ph_distinct_id`, `lasso_ph_session_id`, `__lasso_intentwave_config__:<storeId>`, `__lasso_whop_pixel_config__:<storeId>`, `shopify_country`, `shopify_language` | Yes |
| JS globals / elements | `window.__SHOPIFY_CART_LISTENER__`, `window.__LASSO_FETCHING_CURRENCY__`, `window.proceedToCheckout`; script ids `lasso-whop-pixel-script` (Whop pixel `https://t.whop.tw`) and `lasso-intentwave-script`; selector `[data-lasso-checkout]` | Yes |
| Customer portal | `account.` / `subscriptions.` / `billing.` / `portal.<store>`, CNAME `lasso-customer-portal.pages.dev`, `<title>Customer Portal</title>`, favicon `/assets/images/logos/lasso-favicon.png`, API `https://api.lassocheckout.com/api/customers/…` and `/api/store/by-portal-domain` | Yes (subscription stores only) |
| DNS of the checkout | CNAME to `1a28dfb57b1e1efc.vercel-dns-016.com` (most), also `e4e52b5c1254e1d1.vercel-dns-016.com` | **No.** Other Vercel apps share the same address: `checkout.stellamelbourne.co` points there and serves an app called "Revio" |
| A Lasso domain without a live store | `<title>Store not found</title>` "This domain is not connected to an active store." | Lasso domain, no store |
| Store id | `data-store-id` is a MongoDB ObjectId: the first 8 hex digits are the moment the store joined Lasso (`6a3c9a6d…` = 2026-06-25) | — |
| "Powered by" | None: no Lasso branding on the store or the checkout | — |
| Lasso's own hosts (crt.sh) | `checkout.lassocheckout.com` (Vercel), `api.lassocheckout.com`, `dashboard.lassocheckout.com`, `payments.lassocheckout.com` (Stripe custom domain), `hooks.lassocheckout.com`, `portal.shop.lassocheckout.com` (→ `lasso-customer-portal.pages.dev`), `shop.lassocheckout.com` (Shopify), `livebackend.lassocheckout.com`, `docs.lassocommerce.com` (Mintlify, behind a login) | — |

Lasso's docs (docs.lassocommerce.com) and Whop's Lasso guide (docs.whop.com/third-party-integrations/lasso) both ask
for a login, so they were not read. Search-engine snippets of the Whop guide describe Lasso as "a checkout platform
that connects your Shopify store to Whop's payment infrastructure", with T+3 payouts, 1% + $199 a month on Lasso's
side and Whop's 2.7% + $0.30. Lasso's sub-processor list (lassocommerce.com/subprocessor-appendix, 6 July 2026) names
Gr4vy, Whop, Rokt and AfterSell (post-purchase offers), IntentWave and Persistent (identity resolution), Klaviyo, Meta,
Google, Taboola and TikTok, and Anthropic and Firecrawl for "AI-assisted store and content generation".

## 2. Every route, and what it gave

| Route | Result | Free? | Cost |
|---|---|---|---|
| **urlscan.io search API**, `filename:"lasso-script-v4.min.js"`, `-v2`, `lasso-script.min.js`, `domain:lassocheckout.com` | **The main source**: 382 scans in 30 days → **105** of the 129 stores. Fresh every day (ad-spy tools and security feeds scan ad landing pages) | Free without an account: last 30 days, 100 results a search, result pages need login | Free account: 1,000 searches a day. Paid from $5,000 a year |
| urlscan.io, checkout pages: `page.domain:checkout.* AND page.title:"Secure Checkout"` (and `page.server:Vercel`) | 131 scans, most of them other checkout providers (CrispCheckout, Pay One…) → **13** more Lasso stores, e.g. velunira.nl, harperwells-boston.com | Free | — |
| urlscan.io, Lasso customer portals (found by `domain:lassocheckout.com`) | 9 portals → **7** more stores (subscription funnels: Goda, Pelvica, Bloomin, Divani…) | Free | — |
| Sister domains in `data-checkout-url` | 14 checked: mostly the same store under a second name (merged), 1 other store | Free | — |
| **Reverse CNAME: WhoisFreaks** | 3,153 records for `1a28dfb57b1e1efc.vercel-dns-016.com`, 95 for `lasso-customer-portal.pages.dev`. The 3 hostnames visible without an account → **3** stores, all live on Lasso | Free account: 500 credits; the CSV costs 160 and 5 credits | $75/month or $150 one-time for 50,000 credits |
| **StoreLeads** | Tracks "Lasso Cart": **1,316** stores (technology list, checked 2026-11-01) | Free preview only | $75/month browse only; **$250/month** with CSV export and API |
| PublicWWW (source-code search) | Could not be tested: a JavaScript bot check | Free account: top 3M sites, 1,000 rows | $79 a week, $109 a month |
| NerdyData (source-code search) | Not tested (app needs a login) | 100 rows per report | $200/month |
| BuiltWith | Unknown whether it detects Lasso (the page renders in the browser) | Single lookups free | $295/month |
| Wappalyzer | Only "Lasso CRM", a different product | 50 lookups a month | $250/month |
| Netlas.io DNS search (`cname:` field) | Documented, not tested | 50 requests a day | $49/month |
| crt.sh | Only Lasso's own hosts: a store's `checkout.` certificate carries no Lasso mark | Free | — |
| Common Crawl | Its index has URLs, no page source: no use without processing the raw archives | Free | Athena ~$1.50 per crawl index scan |
| GitHub code search | Only DuckDuckGo's Tracker Radar (Lasso seen on 4 sites; adds redlifelights.com) | Free | — |
| **Meta Ad Library** | No filter on link domain in the API. On the public site, a search for the domain as words also matches ads' links (castellacookware.com.au: 30 own ads) but finds other shops too ("aussie-flair.com" → "Flair Dancewear"); as one **exact phrase** it finds the ads that show the domain (tryglowgummies.com: 625). Both, keeping only the store's own ads | Free, logged out, needs a real browser | — |
| Shopify App Store | No Lasso app (the only "Lasso" app is an unrelated bulk editor) | — | — |
| Reddit, YouTube, TikTok, X, Trustpilot, case studies, agencies | Nothing that names a store. Lasso's site shows no customer logos or case studies; Trustpilot has 1 review; X refused the request | — | — |

## 3. What the stores are

129 live stores (2026-11-01):

| | Stores |
|---|---|
| Shop registered in (meta.json) | US 43 · **NL 38** · HK 16 · GB 13 · SE 3 · NZ 2 · AU 2 · ES 2 · BE 2 · CH, SI, AE, MA 1 · unknown 4 |
| Currency | USD 55 · AUD 21 · EUR 21 · GBP 13 · CAD 5 · DKK 3 · NZD 2 · SEK 2 · CHF, ILS, SGD 1 · unknown 4 |
| Language | English 105 · German 9 · French 4 · Danish 3 · Swedish 2 · Dutch, Spanish, Italian, Hebrew 1 · unknown 2 |
| Joined Lasso (from the store id) | 2025-11: 1 · 2025-12: 2 · 2026-01: 4 · 02: 1 · 04: 11 · 05: 8 · 06: 16 · 07: 15 · 08: 26 · 09: 17 · 10: 15 (unknown: 13) |
| Products in the store | median 534; 14 stores with 15 or fewer (single-product funnels); 39 with 1,000+ |

Patterns that matter for product research:

1. **"Local family boutique" fashion networks** (33 stores at least). Store names invent a local shop and family
   ("Mathilde München", "Feldmann München", "Karlson Berlin", "Hartmann Frankfurt", "Steinberg München", "Elle Zürich",
   "Lowell Sydney", "Ivy & Grace Sydney", "Wattle & Vale Melbourne", "Margaret's Kings Beach", "Heather's Okanagan",
   "Michael & Claire Vancouver", "Harper & Wells Boston", "The Thomas Family Palm Beach", "Mads and Freja Copenhagen",
   "Astrid Göteborg", "Maison Vivienne Paris"). Many are registered in the Netherlands and sell abroad. Products have a
   first name in front ("Franco | Premium-Komforthose", "Marta | Hand-Quilted Basket"), and the same product turns up
   in several stores in different markets, which looks like one operator rolling a tested product out market by market.
2. **Subscription supplement and beauty funnels** with advertorial "5 reasons" pages and a Lasso customer portal:
   Glow Gummies and Flora (probably one owner: both registered in Auckland, both joined Lasso on 2026-06-25), Arctic Organs, NutralisLabs,
   Venalia, Pelvica, Bloomin, Divani, TryCure, Vigewell, Viora, Hairfillup.
3. **Single-product and small brands**: ROVIX (KRATOS smartwatch), RedLife (red-light therapy), MiracleMop, Castella
   (titanium pans), HappyFlops, LYRX, Sleep by SĀNTI (velvet bedding, six domains on one store), Orthovel (12-hour shift
   shoes), Velunira (NL, acacia kitchen tools, joined Lasso 2026-10-29).
4. **"Maker story" home and garden** (BACKR and CedarAndTin, both registered in Albuquerque and sharing products;
   CRAFTFOLK and Marlow Market, both in London): every product is "<first name>'s hand-made …" (bee hotels, bird baths, quilted baskets, a ghost lantern).
   They run on native ads (Revcontent, Outbrain, Taboola) and Google, not on Meta.
5. **General stores** with thousands of products (Sydneyambrose, Verlimo, DecorsDeluxe, Lampelle, Embermont), and
   football-kit stores (Afufi, Nalisom, Xclusivejerseys; trademark risk).

## 4. EU and NL/DE

- **German-language Lasso stores (9):** mathilde-munchen.de (women's dresses, €39.95), feldmann-munchen.com,
  karlson-berlin.com, hartmann-frankfurt.com and steinberg-munchen.com (men's comfort clothing: "Franco |
  Premium-Komforthose" is a best seller in two of them, "Wilson | Langarm-Poloshirt" €54.95, half-zip pullovers €49.95),
  bergmannatelier.de (dungarees €59.95, "Levila – Orthopädische Sandalen"), shopnory.de (Chelsea boots €75.99, 3 active
  ads), verlimo-shop.com ("AirVibe" air cooler €149.95, "1+1 gratis" brow pencils), elle-zurich.com (CHF).
- **Dutch:** velunira.nl (acacia kitchen-utensil set €44.99, copper water bottle €39.99). It joined Lasso on
  2026-10-29, three days before this check, and is registered in Morocco. A new store, not proof yet.
- **Registered in the Netherlands, selling abroad (38 stores):** most of the "local boutique" network (Wattle & Vale
  Melbourne, Margaret's Kings Beach, Ivy & Grace Sydney, Mia & Rose Toronto, Michael & Claire Vancouver, Elaine & Heather
  Huntsville, Wardrobe of London, Mads and Freja Copenhagen, Maison Vivienne Paris…), the copper-jewelry stores (Mabel,
  Vera's, Della's) and Viora (Korean scalp bar). Shopify's meta.json shows the shop's own address, so these look like
  Dutch operators using Lasso: Connor's direct competition, and a sign that the setup (Lasso + Whop payouts) works
  for NL companies.
- **Other EUR stores:** happyflops.com (massage flip-flops €19.95, 80 reviews), sableau.com (sneakers €99.95), the
  French maisonvivienne-paris.fr, nathaliebernard.com and maison-avent.com (advent calendars €49.95), the Nordic
  astridgoteborg.se, djurfavorit.se (pet accessories), lilynewyork.com, madsandfreja-copenhagen.com, outdoorhaven.dk
  (padded cycling shorts, 469 reviews), and balm-official.com (urea cream, ES).
- Hardly any EU store showed Meta ads with its own domain. To see their EU reach, put their domains into Winner Hunter's
  keyword box (Meta's API has EU reach), or look up their brand names in the Ad Library.

## 5. Top 15 stores and products to look at

Ranked on proof (active ads, how long they run, scans, the same product in several stores, reviews) and on whether
Connor could sell it in NL/DE. Prices are the store's own, with its "compare at" price in brackets.

| # | Product (store) | Price | Proof | For NL/DE? |
|---|---|---|---|---|
| 1 | **Orthopedic comfort shoes and sandals for women.** Miami Style Co ("Vera Orthopedic Sandals"), Wattle & Vale Melbourne ("Christine Comfort Orthopaedic Loafers"), Lowell Sydney (braided cork sandals), Mia & Rose Toronto (cord boots), Bergmann Atelier (DE) | $39; AUD 69.95–79.95; €59.95 | A top-5 best seller in **19** Lasso stores; 63 + 41 + 25 + 17 active Meta ads in four of them | Yes. Sell comfort, not health claims |
| 2 | **Hand-quilted animal laundry baskets and artisan tote bags.** Jennifer Bags, Sophie & Millie Bags ("Five Colourful Chickens"), Margaret's Kings Beach and Heather's Okanagan (both "Marta \| Hand-Quilted Basket"), BACKR | $89.95; AUD 54.95–59.95; $72 | Best seller in **10** Lasso stores; Jennifer Bags runs **184** active ads (since 2026-10-07), Sophie & Millie 37 | Yes, Q4 gift |
| 3 | **Glow Tanning Gummies** (tryglowgummies.com, NZ) | NZD 48.87 (75) | **484** active ads on its page, oldest seen 2026-04-22; the most-scanned Lasso store (75 urlscan scans in 30 days); "5 reasons" advertorials | No: supplement (EU paperwork, off the board). Strong US/AU signal |
| 4 | **Mystery Signature Scent** (goda.co) | $39 | **4,239** active ads show goda.co, oldest 2026-02-19 | No: perfume (off the board). Biggest ad volume found |
| 5 | **Shilajit gummies for women** (trybloomin.com) | $49.95 (100) | **2,368** active ads show the domain, since 2026-05-21; 100 reviews | No: supplement |
| 6 | **Vintage clothing mystery boxes** (EdJ VNTGE, UK: "5 Piece Mystery Box", "The Gamble Box") | £82 (125) | **128** active ads since 2026-08-29 | Yes, with second-hand stock (not dropshipping) |
| 7 | **MiracleMop Magic Cleaning Kit** (miraclemop-au.com) | AUD 59.95 (300) | Oldest active ad **2025-01-16** (21 months), 49 active page ads, 178 ads show the domain, 143 reviews | Yes: evergreen |
| 8 | **Titanium hammered pan + free lid** (Castella Cookware AU) | AUD 139.95 (432.95) | 30+ active own ads since 2026-09-17; 50-product brand | Yes (food-contact rules) |
| 9 | **Chunky Cuban link necklace and gold jewelry** (The Johnsons Jewelry) | $39.95 (200) | **60** active ads; the oldest one seen started 2026-10-27: scaling now | Yes (nickel rules) |
| 10 | **Korean Scalp Revival Bar** (Viora, NL-registered) | $39.95 | 23 active ads on its page and more on two other pages ("The Hair Wellness Lab", "Root and Bloom hair co."): testing several accounts | Only with CPNP (cosmetic) |
| 11 | **Velvet bedding sets** (Sleep by SĀNTI: one store under 6 domains) | $299.95–329.95 | 334 reviews on the top set, 9 urlscan scans, no Meta ads with its domains | Yes: high order value |
| 12 | **"Maker story" garden and home decor**: "Wanda's Ghost Lantern", bronze bird baths, bee hotels, a quilted hippie-bus bag (BACKR, CedarAndTin, CRAFTFOLK, Marlow Market) | $39.95–59 | BACKR has the 3rd most urlscan scans (36); native ads (Revcontent, Outbrain, Taboola) and Google, the same products in sister stores | Yes, Q4 gift |
| 13 | **Cat tree "Migdal" and home items** (Mobido Shop, Israel, Hebrew) | ILS 109.99 | 29 active ads, the oldest seen started 2026-10-28; joined Lasso 2026-10-24 | Yes (pets) |
| 14 | **Dresses for women 45+** (MollyandSienna: "Marisa Long Contrast Chevron Dress"; Ivy & Grace Sydney: "Celeste One-Shoulder Floral Maxi") | AUD 89.95–99.95 | 21 and 20 active ads | Yes, but fashion returns |
| 15 | **Copper jewelry** (Mabel Copper, NL-registered, joined Lasso 2026-10-27; also Vera's, Della's, Copper & Canyon) | $44.99 (229.99) | 18 active page ads, 4 stores with the same niche | Yes, without health claims |

Also notable: FasciaBlaster (an established brand: 101 active ads, 1,100 reviews), RedLife (red-light devices,
$462–529), ROVIX (one smartwatch, $119.95), YourGreenhouses ($2,765 greenhouses, 30+ ads).

## 6. All live stores

Sorted by Meta ads. "Meta ads": active ads of the store's own Facebook page, all countries ("page"); else the store's
own ads among the first 30 search results ("seen"; 30+ = at least that many); 0 = no active Meta ad shows the domain
(many of these buy native, Google or TikTok traffic, or advertise through other domains). "Ad Library" opens the page's
ads, or the search. Every column, with the checkout URL and best sellers 2–5, is in the CSV.

<!-- generated from the verification data of 2026-11-01 -->

| # | Store | Conf. | Market | Type | Products | Lasso since | Best seller (price) | Meta ads | Ad Library |
|---|---|---|---|---|---|---|---|---|---|
| 1 | [tryglowgummies.com](https://tryglowgummies.com/) | high | NZ | supplement / wellness funnel | 7 | 2026-06-25 | Glow Tanning Gummies (48.87 NZD (was 75.00)) | 484 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=557249247463279) |
| 2 | [jennifer-bags.com](https://jennifer-bags.com/) | medium | US | fashion boutique (local-shop story) |  |  | Quilted laundry baskets and artisan bags (its ad landing pag (89.95 USD (home page)) | 184 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1292841353922174) |
| 3 | [edjvntge.uk](https://edjvntge.uk/) | high | UK | niche store | 41 | 2026-07-10 | 5 PIECE MYSTERY BOX (82.00 GBP (was 125.00)) | 128 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=521386541053415) |
| 4 | [fasciablaster.com](https://fasciablaster.com/) | high | US | niche store | 170 | 2026-04-29 | FasciaBlaster by Ashley Black – Original Tool (99.00 USD) | 101 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=625691560853469) |
| 5 | [miamistyleco.com](https://miamistyleco.com/) | high | US | niche store | 624 | 2026-05-28 | Vera Orthopedic Sandals (39.00 USD (was 68.00)) | 63 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=986159334591716) |
| 6 | [thejohnsonsjewelry.com](https://thejohnsonsjewelry.com/) | high | US | niche store | 308 | 2026-04-14 | Chunky Cuban Link Necklace (39.95 USD (was 200.00)) | 60 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1365608816637244) |
| 7 | [miraclemop-au.com](https://miraclemop-au.com/) | high | AU | niche store | 39 | 2026-05-18 | MiracleMop Magic Cleaning Kit (59.95 AUD (was 300.00)) | 49 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=144722865395769) |
| 8 | [wattlevale-melbourne.com](https://wattlevale-melbourne.com/) | high | AU | fashion boutique (local-shop story) | 1946 | 2026-08-01 | Christine / Comfort Orthopaedic Loafers (69.95 AUD (was 349.95)) | 41 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1094229220449527) |
| 9 | [sophiemilliebags.com](https://sophiemilliebags.com/) | high | AU | fashion boutique (local-shop story) | 402 | 2026-06-23 | Artisan Bag - Five Colourful Chickens (59.95 AUD (was 149.95)) | 37 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1235935279611138) |
| 10 | [castellacookware.com.au](https://castellacookware.com.au/) | high | AU | niche store | 50 | 2026-04-13 | Titanium Hammered Pan + FREE LID (139.95 AUD (was 432.95)) | 30+ seen | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1195826226956307) |
| 11 | [officialviora.com](https://officialviora.com/) | high | US | single-product or small brand | 10 | 2026-09-28 | Korean Scalp Revival Bar (39.95 USD) | 23 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1286900704500473) |
| 12 | [yourgreenhouses.com](https://yourgreenhouses.com/) | high | US | niche store | 70 | 2026-06-19 | Air Vent (95.00 USD) | 30+ seen | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=282543548275085) |
| 13 | [goda.co](https://goda.co/) | medium | US | niche store | 68 |  | Mystery Signature Scent (39.00 USD) | 30+ seen | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=611781792016565) |
| 14 | [mobido-shop.com](https://mobido-shop.com/) | high | IL | niche store | 113 | 2026-10-24 | ™Migdal / עמוד גירוד ועץ טיפוס מחוזק לבית (109.99 ILS) | 29 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=150160088184552) |
| 15 | [trybloomin.com](https://trybloomin.com/) | medium | US | supplement / wellness funnel | 16 |  | Bloomin - Shelajit Gummies (49.95 USD (was 100.00)) | 29+ seen | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=338512376012219) |
| 16 | [lowellsydney.com](https://lowellsydney.com/) | high | AU | fashion boutique (local-shop story) | 833 | 2026-09-04 | Hayleigh Braided Cork Orthopaedic Sandals – Double Buckles (79.95 AUD (was 189.95)) | 25 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1215508798306352) |
| 17 | [mollyandsienna.com](https://mollyandsienna.com/) | high | AU | niche store | 164 | 2026-08-24 | Marisa / Long Contrast Chevron Dress (99.95 AUD (was 200.00)) | 21 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1307566765776341) |
| 18 | [valestonejewelry.com](https://valestonejewelry.com/) | high | US | fashion boutique (local-shop story) | 127 | 2026-06-02 | Carnelian Heart Pendant Necklace (39.95 USD (was 132.95)) | 14 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1337053722831644) |
| 19 | [ivyandgracesydney.com](https://ivyandgracesydney.com/) | high | AU | fashion boutique (local-shop story) | 1307 | 2026-05-25 | Celeste / One-Shoulder Floral Maxi (89.95 AUD (was 224.95)) | 20 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1196553333544571) |
| 20 | [thethomasfamilypalmbeach.com](https://thethomasfamilypalmbeach.com/) | medium | US | fashion boutique (local-shop story) | 144 |  | Elara / Women's Oversized Knit Sweater (69.95 USD (was 180.00)) | 19 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=100623505686443) |
| 21 | [mabelcopper.com](https://mabelcopper.com/) | high | US | niche store | 134 | 2026-10-27 | Mabel Root Copper Bracelet (44.99 USD (was 229.99)) | 18 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1357994114065555) |
| 22 | [miarosetoronto.com](https://miarosetoronto.com/) | high | CA | fashion boutique (local-shop story) | 778 | 2026-08-13 | Melinda / Comfy Ankle Boots (57.95 CAD (was 180.00)) | 17 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1330353976826919) |
| 23 | [orolosangeles.com](https://orolosangeles.com/) | high | US | niche store | 116 | 2026-06-23 | THE CLASSIC BLACK CHELSEA BOOTS (424.00 USD) | 7 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1196336237073015) |
| 24 | [elizroseboutique.com](https://elizroseboutique.com/) | high | US | maker-story home & garden | 653 | 2026-07-23 | Sack Artisanal - Black Cat and Book Tote Bag (59.95 USD (was 135.00)) | 4 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=366280339911448) |
| 25 | [shopnory.de](https://shopnory.de/) | high | DE/AT | general store (many products) | 25001 | 2026-04-09 | Chelsea-Stiefel aus Leder, flacher Absatz, spitz zulaufend (75.99 EUR (was 151.99)) | 3 seen | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=109586031358084) |
| 26 | [tryrovix.co](https://tryrovix.co/) | high | US | single-product or small brand | 4 | 2026-08-29 | KRATOS - Smartwatch (119.95 USD (was 149.95)) | 3 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1294284953768249) |
| 27 | [westrowsco.com](https://westrowsco.com/) | high | US | general store (many products) | 1557 | 2026-09-11 | Opium Leather Flats (44.95 USD (was 149.95)) | 3 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1011563835377759) |
| 28 | [balm-official.com](https://balm-official.com/) | high | ES | supplement / wellness funnel | 47 | 2026-01-23 | BALM — Crema Queratolítica Avanzada · Urea 40 % (24.95 EUR (was 49.95)) | 1 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1070135216188833) |
| 29 | [northstarwellco.com](https://northstarwellco.com/) | high | IT | single-product or small brand | 9 | 2026-08-20 | Truths and Lies About Stomach Problems (4.99 EUR (was 9.99)) | 1 (page) | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=page&view_all_page_id=1408390969018442) |
| 30 | [4216ec.myshopify.com](https://4216ec.myshopify.com/) | high | EU (English) | general store (many products) | 1796 | 2026-05-01 | Beige cable knit sweater with leather elbow patches (39.95 EUR (was 79.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%224216ec.myshopify.com%22) |
| 31 | [adelise-rowan.com](https://adelise-rowan.com/) | high | AU | fashion boutique (local-shop story) | 342 | 2026-08-06 | Christina™ / A-Line V-Neck Dress (79.95 AUD (was 239.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22adelise-rowan.com%22) |
| 32 | [afufi.com](https://afufi.com/) | high | EU (English) | general store (many products) | 1594 | 2026-08-07 | Spain Away Jersey World Cup 2026 2 STARS ⭐️⭐️ (45.99 EUR (was 64.90)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22afufi.com%22) |
| 33 | [amarae.uk](https://amarae.uk/) | high | UK | general store (many products) | 25001 | 2026-08-24 | Women's shirt dress with belt and three-quarter sleeves Amar (48.99 GBP (was 97.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22amarae.uk%22) |
| 34 | [arcticorgans.com](https://arcticorgans.com/) | high | US | single-product or small brand | 1 | 2026-08-05 | Reindeer Arctic Organs (49.99 USD (was 375.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22arcticorgans.com%22) |
| 35 | [astridgoteborg.se](https://astridgoteborg.se/) | high | SE | fashion boutique (local-shop story) | 3371 | 2026-07-04 | Hedvig – Vardagströja med halvlång ärm (699.00 SEK (was 2399.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22astridgoteborg.se%22) |
| 36 | [aussie-flair.com](https://aussie-flair.com/) | high | AU | niche store | 534 | 2026-07-16 | Sonya / One-Shoulder Floral Maxi Dress (99.95 AUD (was 249.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22aussie-flair.com%22) |
| 37 | [backroad-goods.com](https://backroad-goods.com/) | high | US | maker-story home & garden | 101 | 2026-10-08 | Wanda's Ghost Lantern (49.00 USD (was 89.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22backroad-goods.com%22) |
| 38 | [belcien.com](https://belcien.com/) | high | US | niche store | 350 | 2026-06-12 | Men’s Knitted Polo Shirt Lightweight Breathable Fit (57.95 USD (was 76.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22belcien.com%22) |
| 39 | [bergmannatelier.de](https://bergmannatelier.de/) | high | DE/AT | general store (many products) | 2862 | 2026-06-08 | Ärmellose Latzhose (59.95 EUR (was 120.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22bergmannatelier.de%22) |
| 40 | [bimmerplug.com](https://bimmerplug.com/) | high | US | general store (many products) | 1835 | 2026-05-20 | Apple Carplay & Android Auto Retrofit - BMW F & E Chassis (399.99 USD (was 1050.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22bimmerplug.com%22) |
| 41 | [camillathelabel.com](https://camillathelabel.com/) | high | AU | niche store | 560 | 2026-10-23 | Emma Ruffle Maxi Dress (159.95 AUD (was 230.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22camillathelabel.com%22) |
| 42 | [cedarandtinco.com](https://cedarandtinco.com/) | high | US | maker-story home & garden | 196 | 2026-10-19 | Geoff's Handmade Bronze Bird Bath (39.95 USD (was 64.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22cedarandtinco.com%22) |
| 43 | [cocosydney.co](https://cocosydney.co/) | high | AU | general store (many products) | 2064 | 2025-11-30 | Christmas Ornament Advent Calendar – 24 Mini Building Sets f (40.99 AUD (was 81.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22cocosydney.co%22) |
| 44 | [craft-folk.com](https://craft-folk.com/) | high | US | maker-story home & garden | 156 | 2026-10-14 | Maggie's Handquilted Hippie Bus Weekender (59.00 USD (was 129.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22craft-folk.com%22) |
| 45 | [decorsdeluxe.com](https://decorsdeluxe.com/) | high | AU | general store (many products) | 3333 | 2026-02-14 | External Hard Drive Portable SSD High Speed USB Storage 128t (104.99 AUD (was 114.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22decorsdeluxe.com%22) |
| 46 | [dellacopper.com](https://dellacopper.com/) | high | US | niche store | 126 | 2026-08-15 | Della's Copper Water bottle | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22dellacopper.com%22) |
| 47 | [djurfavorit.se](https://djurfavorit.se/) | high | SE | niche store | 970 | 2026-10-01 | Kam i rostfritt stål för hund och katt - pälsvård (75.00 SEK (was 330.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22djurfavorit.se%22) |
| 48 | [doveandloom.co](https://doveandloom.co/) | high | US | fashion boutique (local-shop story) | 63 | 2026-09-28 | Eternal Drop Necklace | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22doveandloom.co%22) |
| 49 | [elaineheather-huntsville.com](https://elaineheather-huntsville.com/) | high | CA | fashion boutique (local-shop story) | 706 | 2026-08-20 | Maya / V Neck Short Sleeve Jumpsuit (84.95 CAD (was 340.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22elaineheather-huntsville.com%22) |
| 50 | [ellarose-melbourne.com](https://ellarose-melbourne.com/) | high | AU | fashion boutique (local-shop story) | 1275 | 2026-08-27 | Emily / Orthopedic Shoes (104.95 AUD (was 300.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22ellarose-melbourne.com%22) |
| 51 | [ellesedecor.com](https://ellesedecor.com/) | high | US | general store (many products) | 1740 | 2026-07-14 | Womens Hooded Rain Jacket Long Windproof With Pockets (49.99 USD (was 99.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22ellesedecor.com%22) |
| 52 | [elsies-melbourne.com](https://elsies-melbourne.com/) | high | AU | maker-story home & garden | 186 | 2026-06-09 | ROSIE - Hand-Quilted Sheep Laundry Basket (69.95 AUD (was 154.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22elsies-melbourne.com%22) |
| 53 | [embermont.store](https://embermont.store/) | high | US | general store (many products) | 3321 | 2026-10-15 | Long Range Outdoor TV Antenna with HD Signal Booster (164.95 USD (was 549.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22embermont.store%22) |
| 54 | [esme-durham.com](https://esme-durham.com/) | high | UK | niche store | 489 | 2026-01-16 | Giselle / Women's Tailored Single-Button Blazer With Flap Po (49.95 GBP (was 100.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22esme-durham.com%22) |
| 55 | [feldmann-munchen.com](https://feldmann-munchen.com/) | high | DE/AT | niche store | 801 | 2026-09-14 | Hugo / Premium Half-Zip-Pullover (49.95 EUR (was 100.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22feldmann-munchen.com%22) |
| 56 | [foxleyofficial.com](https://foxleyofficial.com/) | high | UK | niche store | 306 | 2026-05-30 | Foxley Ferran Saltwater Henley (26.00 GBP (was 50.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22foxleyofficial.com%22) |
| 57 | [getnutralislabs.com](https://getnutralislabs.com/) | high | US | supplement / wellness funnel | 7 | 2026-09-11 | Resilia Oil Of Oregano (39.99 USD) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22getnutralislabs.com%22) |
| 58 | [hairfillup.com](https://hairfillup.com/) | high | US | single-product or small brand | 5 | 2026-06-29 | Hairfillup Hair Concealer 50ML - Waterproof 3–7 days. (64.00 USD) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22hairfillup.com%22) |
| 59 | [hannah-goldcoast.com](https://hannah-goldcoast.com/) | high | AU | fashion boutique (local-shop story) | 606 | 2026-07-20 | Hannah / Men's Orthopaedic Leather Sandals (70.95 AUD (was 121.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22hannah-goldcoast.com%22) |
| 60 | [happyflops.com](https://happyflops.com/) | high | EU (English) | niche store | 19 | 2026-04-26 | HappyFlops Original (19.95 EUR (was 34.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22happyflops.com%22) |
| 61 | [harperboutiques.com](https://harperboutiques.com/) | high | AU | niche store | 909 | 2026-08-04 | Gold Necklace / Elegant Jewelry (59.95 AUD (was 99.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22harperboutiques.com%22) |
| 62 | [harperwears.co](https://harperwears.co/) | high | AU | niche store | 1263 | 2026-01-16 | Women's Wide-Fit Orthopedic Boots with Gel-Filled Sole and 4 (59.95 AUD) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22harperwears.co%22) |
| 63 | [harperwells-boston.com](https://harperwells-boston.com/) | high | US | fashion boutique (local-shop story) | 2925 | 2026-04-27 | Emma / Orthopedic Comfort Slip-Ons (69.95 USD (was 349.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22harperwells-boston.com%22) |
| 64 | [harrington-wells.com](https://harrington-wells.com/) | high | US | fashion boutique (local-shop story) | 402 | 2026-10-28 | Tom / Women's Lace-Up Mid-Calf Boots (69.95 USD (was 170.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22harrington-wells.com%22) |
| 65 | [hartmann-frankfurt.com](https://hartmann-frankfurt.com/) | high | DE/AT | fashion boutique (local-shop story) | 532 | 2026-04-08 | Tyson / Businesshemd für Herren mit Button-Down-Kragen (44.95 EUR (was 90.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22hartmann-frankfurt.com%22) |
| 66 | [hartwell-sisters.com](https://hartwell-sisters.com/) | high | CA | fashion boutique (local-shop story) | 263 | 2026-08-24 | Tina / Asymmetric Corduroy Top (74.95 CAD (was 262.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22hartwell-sisters.com%22) |
| 67 | [hattieandrosebags.com](https://hattieandrosebags.com/) | high | US | fashion boutique (local-shop story) | 402 | 2026-05-01 | Rosemary / Artisanal Tote - Spirit of the Lagoon (39.95 USD (was 99.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22hattieandrosebags.com%22) |
| 68 | [havendon.store](https://havendon.store/) | high | UK | general store (many products) | 2314 | 2026-09-15 | Outdoor Fountain Solar Garden Birdbath (54.95 GBP (was 184.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22havendon.store%22) |
| 69 | [ivyandcurve.com](https://ivyandcurve.com/) | high | UK | fashion boutique (local-shop story) | 1211 | 2026-07-02 | Pemberley Corset Bra (24.95 GBP (was 124.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22ivyandcurve.com%22) |
| 70 | [janes-jewelry.com](https://janes-jewelry.com/) | high | US | general store (many products) | 1882 | 2026-07-25 | Blue Crystal Floral Ring (29.99 USD) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22janes-jewelry.com%22) |
| 71 | [junejoanjenny.com](https://junejoanjenny.com/) | high | US | fashion boutique (local-shop story) | 2187 | 2026-01-12 | Darlene / Sophisticated Midi Dress (67.95 USD (was 225.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22junejoanjenny.com%22) |
| 72 | [karlson-berlin.com](https://karlson-berlin.com/) | high | DE/AT | fashion boutique (local-shop story) | 680 | 2026-07-22 | Wilson / Klassisches Langarm-Poloshirt (54.95 EUR (was 110.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22karlson-berlin.com%22) |
| 73 | [lampelle.com](https://lampelle.com/) | high | US | niche store | 1000 | 2026-10-07 | Wearable Heated Blanket with USB Power 8 Heating Zones and W (39.99 USD (was 79.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22lampelle.com%22) |
| 74 | [lilynewyork.com](https://lilynewyork.com/) | high | DK | fashion boutique (local-shop story) | 615 | 2026-08-30 | Charlotte / Dame Elegant Skjortebluse med Knaplukning (224.95 DKK) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22lilynewyork.com%22) |
| 75 | [loppist.com](https://loppist.com/) | high | US | niche store | 955 | 2026-04-13 | Romy / Dazzling Bow Dress (79.95 USD (was 139.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22loppist.com%22) |
| 76 | [lunafashionhouse.co.uk](https://lunafashionhouse.co.uk/) | high | UK | niche store | 1028 | 2026-08-31 | Ruffle Maxi Dress Elegant Summer Dress (39.95 GBP (was 80.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22lunafashionhouse.co.uk%22) |
| 77 | [lyrx.shop](https://lyrx.shop/) | high | US | single-product or small brand | 3 | 2026-09-19 | Tiny Brew Coffee Mug (19.99 USD (was 49.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22lyrx.shop%22) |
| 78 | [madebyashleybennett.com](https://madebyashleybennett.com/) | high | US | niche store | 1177 | 2026-07-02 | Women's Two-Piece Suit / Long-sleeve blazer and Trousers (89.95 USD (was 299.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22madebyashleybennett.com%22) |
| 79 | [madebybellablu.com](https://madebybellablu.com/) | high | US | general store (many products) | 1800 | 2026-06-26 | Women's Orthopedic Loafers with Cushioned Footbed and Ergono (49.95 USD (was 169.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22madebybellablu.com%22) |
| 80 | [madsandfreja-copenhagen.com](https://madsandfreja-copenhagen.com/) | high | DK | general store (many products) | 1690 | 2026-08-11 | NordicAura / Væglampe Moderne - LED Dæmpbar Glas (421.95 DKK (was 688.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22madsandfreja-copenhagen.com%22) |
| 81 | [maison-avent.com](https://maison-avent.com/) | high | FR | niche store | 109 | 2025-12-09 | Calendrier de l'Avent Champagne 2026 – Édition Limitée (49.95 EUR (was 125.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22maison-avent.com%22) |
| 82 | [maison-verdelle.com](https://maison-verdelle.com/) | high | US | niche store | 273 | 2026-06-22 | Plunge grain finish – A-line dress (59.95 USD (was 89.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22maison-verdelle.com%22) |
| 83 | [maisonstraver.co](https://maisonstraver.co/) | high | US | niche store | 508 | 2026-08-03 | Women's Corset Mini Dress – Square Neck Bodycon Party Dress (65.95 USD (was 109.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22maisonstraver.co%22) |
| 84 | [maisonvivienne-paris.fr](https://maisonvivienne-paris.fr/) | high | FR | niche store | 1317 | 2026-06-25 | Kamberly / Veste utilitaire à volants brodée de fleurs au st (19.95 EUR (was 39.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22maisonvivienne-paris.fr%22) |
| 85 | [mardenbylondon.com](https://mardenbylondon.com/) | high | UK | fashion boutique (local-shop story) | 798 | 2026-10-04 | Camille – Poncho jumper (44.95 GBP (was 112.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22mardenbylondon.com%22) |
| 86 | [margaretskingsbeach.com](https://margaretskingsbeach.com/) | high | AU | maker-story home & garden | 673 | 2026-09-14 | Marta / Hand-Quilted Basket (54.95 AUD (was 110.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22margaretskingsbeach.com%22) |
| 87 | [marlowmarketco.com](https://marlowmarketco.com/) | high | US | maker-story home & garden | 177 | 2026-07-22 | Amos's Hand-Carved Wood Spirit Birdhouse (39.95 USD (was 79.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22marlowmarketco.com%22) |
| 88 | [maryandmaesleather.com](https://maryandmaesleather.com/) | high | US | fashion boutique (local-shop story) | 200 | 2026-10-05 | LAURA / ELEGANT SHOULDER BAG (Buy 1, Get 1 Free) (64.95 USD (was 330.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22maryandmaesleather.com%22) |
| 89 | [mathilde-munchen.de](https://mathilde-munchen.de/) | high | DE/AT | general store (many products) | 2102 | 2026-09-02 | Fließendes langes Kleid – chic und bequem (39.95 EUR (was 135.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22mathilde-munchen.de%22) |
| 90 | [meiling-bags.com](https://meiling-bags.com/) | high | SG | general store (many products) | 2032 | 2026-07-08 | Caterina / Woven comfort sandals | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22meiling-bags.com%22) |
| 91 | [michaelclairevancouver.com](https://michaelclairevancouver.com/) | high | CA | fashion boutique (local-shop story) | 561 | 2026-09-03 | Kymberleigh / Orthopedic Sneakers (74.95 CAD (was 199.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22michaelclairevancouver.com%22) |
| 92 | [muelermode.com](https://muelermode.com/) | high | FR | general store (many products) | 2249 | 2026-08-12 | Turquoise baby float with removable canopy (59.95 EUR (was 119.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22muelermode.com%22) |
| 93 | [muserelleglasgow.com](https://muserelleglasgow.com/) | high | UK | niche store | 1420 | 2026-10-15 | AERO COURT TrainerS (64.95 GBP (was 324.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22muserelleglasgow.com%22) |
| 94 | [nalisom.com](https://nalisom.com/) | high | UK | niche store | 156 | 2026-08-17 | Arsenal FC 2026/27 Home Kit kids (39.99 GBP) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22nalisom.com%22) |
| 95 | [nathaliebernard.com](https://nathaliebernard.com/) | high | FR | niche store | 607 | 2026-09-09 | Audrey / Escarpins à Lacets (49.95 EUR (was 125.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22nathaliebernard.com%22) |
| 96 | [olamil.co](https://olamil.co/) | high | US | niche store | 842 | 2026-09-30 | Hoka Bondi 9 Sneakers (119.95 USD (was 179.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22olamil.co%22) |
| 97 | [orthovelfootwear.com](https://orthovelfootwear.com/) | high | US | niche store | 962 | 2026-08-31 | Orthora Pro – 12-Hour Shift Shoes for All-Day Foot, Knee & B (69.95 USD (was 234.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22orthovelfootwear.com%22) |
| 98 | [outdoorhaven.dk](https://outdoorhaven.dk/) | high | DK | niche store | 942 | 2025-12-17 | Gelforede cykelunderbukser - mænd og kvinder (249.95 DKK) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22outdoorhaven.dk%22) |
| 99 | [redlifelights.com](https://redlifelights.com/) | high | US | niche store | 38 | 2026-07-03 | RedLife Pro Belt (529.20 USD) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22redlifelights.com%22) |
| 100 | [rubyandjuly.store](https://rubyandjuly.store/) | high | US | fashion boutique (local-shop story) | 1418 | 2026-07-20 | Charlotte / Women’s Orthopedic Pointed Toe Slip On Loafers (69.95 USD (was 239.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22rubyandjuly.store%22) |
| 101 | [sableau.com](https://sableau.com/) | high | EU (English) | niche store | 155 | 2026-09-06 | Sableau Gats Sneakers (99.95 EUR (was 249.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22sableau.com%22) |
| 102 | [shopenarabeauty.com](https://shopenarabeauty.com/) | high | US | single-product or small brand | 4 | 2026-09-11 | Lumi Loot Glow Haul Buckets – LED Light-Up Halloween Candy B (29.99 USD (was 59.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22shopenarabeauty.com%22) |
| 103 | [sleepbysanti.co](https://sleepbysanti.co/) | high | US | niche store | 49 | 2026-07-13 | Amorgos Fine Velvet Bedding Set (329.95 USD) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22sleepbysanti.co%22) |
| 104 | [solvena-clothing.com](https://solvena-clothing.com/) | high | AU | fashion boutique (local-shop story) | 979 | 2026-04-06 | Nikie / All-Day Comfort Arch Support Sneakers (69.95 AUD (was 140.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22solvena-clothing.com%22) |
| 105 | [steinberg-munchen.com](https://steinberg-munchen.com/) | high | DE/AT | fashion boutique (local-shop story) | 250 | 2026-04-08 | Connor / Zweiteiler für Herren mit Sakko und Weste (129.95 EUR (was 260.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22steinberg-munchen.com%22) |
| 106 | [susanamy-jewelry.com](https://susanamy-jewelry.com/) | high | US | fashion boutique (local-shop story) | 1650 | 2026-06-09 | Blue Opal Drop Sparkling Necklace (1.00 USD (was 99.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22susanamy-jewelry.com%22) |
| 107 | [sydneyambrose.co](https://sydneyambrose.co/) | high | AU | maker-story home & garden | 8338 | 2026-05-07 | Handmade Waldorf Cuddly Doll (48.95 AUD (was 141.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22sydneyambrose.co%22) |
| 108 | [thetailoredgents.com](https://thetailoredgents.com/) | high | US | niche store | 290 | 2026-10-14 | Frontier Leather Boots – Durable Men’s Classic Outdoor Footw (158.95 USD (was 264.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22thetailoredgents.com%22) |
| 109 | [toomuchtoday.com](https://toomuchtoday.com/) | high | US | niche store | 563 | 2026-04-20 | Cotton Crew Neck Tee (24.90 USD (was 39.90)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22toomuchtoday.com%22) |
| 110 | [trycure.org](https://trycure.org/) | high | US | supplement / wellness funnel | 66 | 2026-08-10 | TryCure® Korean Silk Peptide Botox Serum (49.99 USD) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22trycure.org%22) |
| 111 | [tryfloralabs.com](https://tryfloralabs.com/) | high | NZ | supplement / wellness funnel | 3 | 2026-06-25 | Inner Youth Collagen Powder Mango Passion - 450g (46.25 NZD (was 89.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22tryfloralabs.com%22) |
| 112 | [tryvenalia.com](https://tryvenalia.com/) | high | UK | supplement / wellness funnel | 3 | 2026-09-14 | Diosmin & Hesperidin Capsules / Natural Piles Support (39.99 GBP (was 64.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22tryvenalia.com%22) |
| 113 | [us.lounelle.com](https://us.lounelle.com/) | high | EU (English) | fashion boutique (local-shop story) | 2178 | 2026-08-04 | Square neck burgundy velvet dress (45.90 EUR) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22us.lounelle.com%22) |
| 114 | [valamera.com](https://valamera.com/) | high | US | niche store | 287 | 2026-09-25 | Norway Men Winter Jacket – Warm, Durable & Timeless Winterwe (74.99 USD (was 160.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22valamera.com%22) |
| 115 | [velunira.nl](https://velunira.nl/) | high | NL | single-product or small brand | 10 | 2026-10-29 | Keukengerei-set van acaciahout (44.99 EUR (was 199.90)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22velunira.nl%22) |
| 116 | [veras-copper.net](https://veras-copper.net/) | high | US | niche store | 127 | 2026-08-15 | Vera's Anti-Tarnish Paste | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22veras-copper.net%22) |
| 117 | [verlimo-shop.com](https://verlimo-shop.com/) | high | DE/AT | general store (many products) | 5595 | 2026-08-14 | AirVibe™ / Kühlt & reinigt deine Luft in Minuten! (149.95 EUR (was 300.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22verlimo-shop.com%22) |
| 118 | [vigewell.com](https://vigewell.com/) | high | US | niche store | 54 | 2026-06-12 | 2 in 1 colour changing foundation stick (39.99 USD) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22vigewell.com%22) |
| 119 | [wardrobe-of-london.com](https://wardrobe-of-london.com/) | high | UK | fashion boutique (local-shop story) | 162 | 2026-08-21 | Adjustable Strap Leather Mules for Women (69.95 GBP (was 139.95)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22wardrobe-of-london.com%22) |
| 120 | [xclusivejerseys.com](https://xclusivejerseys.com/) | high | EU (English) | general store (many products) | 1967 | 2026-06-30 | Brazil Jesus Christ Pink Jersey Special Edition 2026 (39.99 EUR (was 45.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22xclusivejerseys.com%22) |
| 121 | [copperandcanyon.com](https://copperandcanyon.com/) | medium |  | niche store |  |  | Ruth's Copper Bracelet (44.99 USD (was 229.99; its products.json gives cents)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22copperandcanyon.com%22) |
| 122 | [divaniofficialglobal.com](https://divaniofficialglobal.com/) | medium | US | supplement / wellness funnel | 14 |  | ASTAXANTHIN - 12MG (29.99 USD (was 59.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22divaniofficialglobal.com%22) |
| 123 | [elle-zurich.com](https://elle-zurich.com/) | medium | CH | fashion boutique (local-shop story) | 911 |  | Lebendiges und Bequemes Sommerkleid (39.95 CHF (was 79.90)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22elle-zurich.com%22) |
| 124 | [ellis-adelaide.com](https://ellis-adelaide.com/) | medium | AU | fashion boutique (local-shop story) | 4416 |  | Classic Whisky Advent Calendar 2026 (46.99 AUD (was 79.99)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22ellis-adelaide.com%22) |
| 125 | [evoria.online](https://evoria.online/) | medium |  | niche store |  |  |  | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22evoria.online%22) |
| 126 | [getpelvica.com](https://getpelvica.com/) | medium | US | single-product or small brand | 4 |  | 360° Sculpt Brief™ Postpartum (19.99 USD) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22getpelvica.com%22) |
| 127 | [heathersokanagan.com](https://heathersokanagan.com/) | medium | CA | maker-story home & garden | 257 |  | Marta / Hand-Quilted Basket (54.95 CAD (was 110.00)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22heathersokanagan.com%22) |
| 128 | [lunirel.com](https://lunirel.com/) | medium | UK | general store (many products) | 12875 |  | Women's Orthopedic Trainers: Everyday Comfort & Pain Relief (32.80 GBP (was 56.80)) | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22lunirel.com%22) |
| 129 | [slimade.store](https://slimade.store/) | medium |  | niche store |  |  |  | 0 | [search](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_exact_phrase&q=%22slimade.store%22) |

Had Lasso, but closed or unreachable on 2026-11-01 (8): veldmanutrecht.com, hoffmann-salzburg.com, lumide.store, maison-alina.com, manto-de-fe.com, nordholmkobenhavn.com, oelaro.com, sallysstowe.com.

Left Lasso (6: the script is still on the page, the checkout subdomain is gone or another provider): asterleigh.com, eleanorsavannah.com, equestrianuniverse.com, portdouglasboutique.com, senvira.shop, themountcoastalboutique.nz.

## 7. A weekly method (built in, off by default)

Everything below runs as `winner-hunter/lasso.mjs` (workflow **Lasso stores**, see the README). Without any account
it costs nothing.

1. **Find** (urlscan.io, free): for each of these searches, every 2-day window of the last 30 days (a window with more
   than 100 results is split, so nothing is cut off):
   - `filename:"lasso-script-v4.min.js"`, `filename:"lasso-script-v2.min.js"`, `filename:"lasso-script.min.js"`
   - `domain:lassocheckout.com` (also finds the customer portals: `account.<store>` → `<store>`)
   - `page.domain:checkout.* AND page.title:"Secure Checkout"` (checkout pages: `checkout.<store>` → `<store>`)
   - plus the domains a scan was sent on from (sister stores), and every store saved before (to see who left).
2. **Check** each store live: the home page (script tag, language, title), `checkout.<store>/checkout` (Lasso's markers),
   `/meta.json` (name, country, currency, product count) and the Storefront API's `BEST_SELLING` order (top 5, prices).
   high = both signs, medium = one, low = script left but checkout gone. Also the domain the checkout sits on, once.
3. **Ads** (optional, `ads = on`): the public Ad Library, logged out, in the runner's Chrome: the domain in the store's
   market outside the EU, as words (that also matches an ad's link), then as one exact phrase when the words found none
   of the store's ads; only the store's own active ads go into `world_ads`, with keyword `lasso: <store>`. The next World Hunter run turns them into products in the 🌍 Inbox under its usual rules.
   EU/UK stores: their domains can go into Winner Hunter's keyword box (Meta API, EU reach).
4. **Keep**: D1 table `lasso_stores` (first seen, last seen with Lasso, best sellers), and a CSV artifact.

Switch it on: Actions → Lasso stores → Run workflow, or the repository variable `LASSO_STORES` = `on` for every Monday.
A run takes about 75 urlscan searches and 4 requests per store.

**To go from ~130 to ~1,300 stores:** sign up at WhoisFreaks (free 500 credits), download the reverse-CNAME CSV of
`1a28dfb57b1e1efc.vercel-dns-016.com` (160 credits) and `lasso-customer-portal.pages.dev` (5 credits), then
`LASSO_EXTRA_FILE=that.csv node winner-hunter/lasso.mjs` (with the D1 secrets, or it only writes the CSV). The
checker throws out the non-Lasso Vercel apps. Or StoreLeads Pro ($250/month) for its 1,316 "Lasso Cart" stores
with install dates. A free urlscan key (`URLSCAN_API_KEY`) gives more searches a day.

**Board ideas (not built):** a "Lasso" tag on Inbox cards whose store is in `lasso_stores` (the store pays for upsells
and runs paid traffic: a signal, like the store best seller), and a weekly "new Lasso stores" list sorted by the day
they joined Lasso.

## 8. Caveats

- **Copy the product, not the story.** The "local family boutique" stores invent a local shop, a family and often a
  closing-down sale. In the EU that is a misleading commercial practice (Unfair Commercial Practices Directive), and
  such stores draw complaints and chargebacks. The products themselves (orthopedic footwear, quilted baskets) are the
  useful part.
- Supplements, cosmetics, perfume and anything with a medical claim (glucose meters, red-light therapy, "vein" capsules)
  need EU paperwork: Winner Hunter's board leaves them out on purpose. They are in the list as signals only.
- Football kits of real clubs and nations: trademark and counterfeit risk.
- Meta ad counts were read logged out (Ad Library, all countries, 2026-11-01). Some stores buy traffic outside Meta.
  Page counts are for the page that runs most of the store's ads; a store can have several pages.
- Review counts came from product-page markup where present (26 stores); reviews in this niche are often imported.
- Stores churn fast: 8 of the Lasso stores urlscan saw in October were already closed, unreachable or gone a few weeks
  later.
- This repository is public, and this file and the CSV are public with it.

## Sources

- Lasso: https://lassocommerce.com/ (pricing, FAQ), https://lassocommerce.com/subprocessor-appendix,
  https://lassocommerce.com/terms-conditions, https://www.linkedin.com/company/lassocheckout,
  https://www.trustpilot.com/review/lassocheckout.com
- Whop's Lasso guide (login wall; search-engine snippets only): https://docs.whop.com/third-party-integrations/lasso
- urlscan.io search API: https://urlscan.io/api/v1/search/?q=filename:%22lasso-script-v4.min.js%22
- Certificates: https://crt.sh/?q=%25.lassocheckout.com
- Reverse CNAME: https://whoisfreaks.com/tools/dns/reverse/lookup/cname/1a28dfb57b1e1efc.vercel-dns-016.com and
  https://whoisfreaks.com/tools/dns/reverse/lookup/cname/lasso-customer-portal.pages.dev
- StoreLeads technology list ("Lasso Cart", 1,316): https://storeleads.app/help/faq/list-of-supported-technologies
- Prices: https://whoisfreaks.com/pricing/api-plans, https://storeleads.app/#pricing, https://publicwww.com/prices.html,
  https://www.nerdydata.com/pricing, https://builtwith.com/plans, https://www.wappalyzer.com/pricing/,
  https://netlas.io/pricing/, https://urlscan.io/pricing/
- DuckDuckGo Tracker Radar (`domains/US/lassocheckout.com.json`): https://github.com/duckduckgo/tracker-radar
- Meta Ad Library (public, logged out): https://www.facebook.com/ads/library/
