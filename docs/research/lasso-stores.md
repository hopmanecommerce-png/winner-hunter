# Lasso checkout stores: how to find them, and what they sell

Research for Winner Hunter, done on 2026-11-01. Every store in the list was fetched that day. The full list is in
[`lasso-stores.csv`](lasso-stores.csv) (one row per store). The weekly method is in section 6, and the optional script
in the repo (`winner-hunter/lasso.mjs`) is described in section 7.

## 1. Summary

- **What Lasso is.** Lasso ([lassocommerce.com](https://lassocommerce.com/), formerly LassoCart) replaces the Shopify
  checkout with its own checkout on the store's own subdomain (`checkout.<store>`). It does payment orchestration
  (Whop, Stripe, Adyen, NMI and more), upsells, order bumps and post-purchase offers. Its blog is written for
  **high-risk merchants**: rolling reserves, chargebacks, "when Stripe goes down". Whop's docs (since removed)
  described it as the checkout that connects a Shopify store to Whop's payments.
- **How to find the stores.** There is one fingerprint that is close to perfect: Lasso's dashboard tells every store
  to add the DNS record `checkout` **CNAME `1a28dfb57b1e1efc.vercel-dns-016.com`**. Free passive DNS (AlienVault OTX)
  lists the hosts that point there. The second free source is urlscan.io search for pages that loaded Lasso
  (`domain:lassocheckout.com`, `filename:"lasso-script-v4.min.js"`). Both work without a key or account.
- **What I found.** **177 live Shopify stores** use Lasso. 151 are high confidence (Lasso's script is on
  the store) and 26 are medium (their `checkout.<store>` serves Lasso's checkout but the script is no longer on the
  home page). They are spread over 186 domains, because one store can run on up to 6 domains. Another
  **59 stores** used Lasso and are already closed: Shopify answers "Store unavailable", or the domain is gone.
- **Who uses Lasso.** Mostly story-driven direct-response stores:
  - **"Local boutique" story stores**: 59 stores by name, plus 32 similar fashion stores. They
    sell fashion, shoes, jewellery and bags, and the name pretends a family shop in a city ("Mathilde München",
    "Ella & Rose Melbourne", "Margaret's Kings Beach"). Many claim "since 1994" or a retirement or closing-down sale,
    yet their first product is from 2026.
  - **"Free + shipping" closing sales**: 10 stores list every product at $0 in Shopify ("Just cover shipping",
    "Every bag is free in the closing sale"). The money is taken in Lasso's checkout: shipping, "insurance", order
    bumps and upsells. This is the "free + shipping" funnel, and Lasso is what makes it possible on Shopify.
  - **"Elderly artisan" products** (23 stores): "Geoff's Handmade Bronze Bird Bath", "Wanda's Ghost
    Lantern", hand-quilted bags.
  - **One-product and small DTC brands** (19 stores): tanning or collagen gummies, hair serums, a smartwatch,
    a mop, red-light belts.
  - **39 stores are registered in the Netherlands**, more than in any country except the US. They are run from
    Amsterdam, Utrecht, Deventer, Arnhem, Woerden, Hengelo and other NL towns, and almost all of them sell abroad (AU,
    CA, US, UK, DE). Lasso is popular in the Dutch story-store scene: these are your direct peers.
- **Is it a winner signal?** Yes, but a noisy one. Lasso costs $149–199 a month plus 1% of sales, so a store on Lasso
  is usually one that spends on ads and expects volume. But most stores are only weeks old (median first product: 2026-08-04),
  and 25% of the stores seen since December are already dead. Read it as "this product is being pushed hard right now",
  then check the ads (section 5).
- **Cost.** Everything used here is free. Paid tools (PublicWWW, BuiltWith, Wappalyzer, urlscan Pro, SecurityTrails)
  would add some coverage. None of them knows "Lasso" as a technology, so none can list these stores for you
  (section 4).

## 2. What Lasso is, and why these stores use it

| | |
|---|---|
| Company | Lasso Inc. Marketing site lassocommerce.com (old: lassocart.com); app `dashboard.lassocheckout.com`; checkout `checkout.lassocheckout.com` (Vercel); API `api.lassocheckout.com` (Cloudflare, then AWS) |
| Product | "Checkout as a Service": a visual checkout builder, payment orchestration (smart routing and failover over 20+ processors, "400+ payment methods"), upsells, downsells, order bumps, subscriptions, fraud and chargeback tools (RDR, CDRN, Ethoca), analytics |
| Payments | Stripe, **Whop**, Adyen, NMI (the routing split on its home page). The checkout loads Whop Elements (`cdn.whop.com/elements/amber/elements.js`); the storefront script loads the Whop pixel (`t.whop.tw/s.js`) |
| Price | Growth **$149/month billed yearly, or $199 month to month**, per store, plus **1% per transaction**. Enterprise: custom, for over $5M a month |
| Whop | Whop's docs had a page "Lasso" under third-party integrations (`docs.whop.com/third-party-integrations/lasso`). On 2026-11-01 it answers "page not found", and the Wayback Machine could not be reached from here. A search engine's copy of the page said: Lasso connects Shopify to Whop's payments; you pass Whop KYC; payouts are T+3 business days; disputes are handled in Whop; Shopify Payments can be switched off, while Shopify still does products and fulfilment; you add a DNS record for a `checkout` subdomain |
| Who it is for | Its blog (28 posts): "Best Payment Gateways for High-Risk eCommerce Industries", "How Rolling Reserves Work for High-Risk Merchants", "When Stripe Goes Down", "Chargebacks". The dashboard's checkout templates even load images from Checkout Champ, the funnel checkout of direct-response sellers |

**Why a store uses it.** Story stores and fast-moving one-product stores get many disputes. Shopify Payments then holds
their money or closes their account. Lasso lets them take card payments through Whop and other processors, keep the
Shopify front end, and add order bumps inside the checkout (on Shopify that needs Plus) and one-click upsells after
the payment.

## 3. Fingerprints (exact strings, checked 2026-11-01)

### On the store (Shopify theme)

```html
<script
  src="https://checkout.<store>/shopify-scripts/lasso-script-v4.min.js"
  data-store-id="6ac7f4c0e29cff51b574d558"
  data-checkout-url="checkout.<store>/checkout"
  defer>
</script>
```

- Script files seen on live stores: `lasso-script-v4.min.js` (110 stores), `lasso-script-v2.min.js` / `-v2.js`
  (26), `lasso-script.min.js` (5), `language-script.js`, `elevate-script(.min).js`,
  `subscriptions-script.js`. The oldest form is `https://dashboard.lassocheckout.com/shopify-scripts/lasso-cart.js` with
  `data-api-url="https://livebackend.lassocheckout.com:3000/api"`. Lasso's own host also serves them:
  `https://checkout.lassocheckout.com/shopify-scripts/lasso-script-v4.min.js` with
  `data-api-url="https://api.lassocheckout.com/api"` (Lasso's demo store `shop.lassocheckout.com` uses this).
- `data-store-id` is a 24-hex id (a MongoDB ObjectId), one per Lasso store.
- Theme names often say it: `Shopify.theme = {"name":"Lasso"…}`, `"LASSO | shrine-theme-…"`, `"Verlimo Lasso Whop"`
  (40 stores). A theme can be a copy, so this alone proves nothing.
- Pasted code instead of the tag (rare): `window.__LASSO_GUARD__`, `lasso_sid`, `__lasso_token__`, `window.proceedToCheckout()`.
  Some themes also carry their own glue code for Lasso: `lassoArmed()`, `[data-lasso-patched]`,
  `window.__lassoGuardToLasso`, `snippets/lasso-checkout-guard.liquid`.
- JavaScript globals: `window.__SHOPIFY_CART_LISTENER__`, `window.proceedToCheckout`, `window.__LASSO_FETCHING_CURRENCY__`,
  `window.posthog.lasso`, `window.whop`, `window.IntentWave`.
- Cookie: `lasso_sid` on `.<root domain>`, `SameSite=Lax`, 30 minutes.
- localStorage / sessionStorage: `lasso_sid`, `lasso_fbclid`, `lasso_fbclid_ts`, `lasso_fwd_params`, `lasso_ph_distinct_id`,
  `lasso_ph_session_id`, `lasso_iw_anonymous_id`, `__lasso_whop_pixel_config__:<store id>`,
  `__lasso_intentwave_config__:<store id>`, `shopify_country`, `shopify_language`, `shopify_currency`;
  `__lasso_token__`, `__lasso_cart_snapshot__` (session).
- Network calls: `POST https://api.lassocheckout.com/api/cart-sessions/sync-cart`, `GET …/cart-sessions/get-session-simple`,
  `…/cart-sessions/check-status`, `…/cart-sessions/whop-pixel-config?store_id=<id>`,
  `…/integrations/intentwave/pixel-config?store_id=<id>`; PostHog through `<checkout host>/ph`; `https://t.whop.tw/s.js`.
- DOM: `[data-lasso-checkout]`, `[data-lasso-atc="true"]`, `#lasso-whop-pixel-script`, `#lasso-intentwave-script`.
- The checkout button goes to `https://checkout.<store>/checkout?sid=<session>` (or `?token=…&storeId=<id>`), plus the
  ad click ids (`fbclid`, `ttclid`, `gclid`, `utm_*`).
- Shopify's `/meta.json` of these stores shows `"shopify_pay_enabled_card_brands":[]` (Shopify Payments off). That is
  common elsewhere too, so it only supports the other signs.

### DNS

| Host | Record | Since |
|---|---|---|
| `checkout.<store>` | CNAME **`1a28dfb57b1e1efc.vercel-dns-016.com.`**: the exact value Lasso's onboarding ("Go live checklist") shows | Feb 2026 |
| `checkout.<store>` (older stores) | CNAME `a94813196ce765c4.vercel-dns-016.com.` | Nov 2025 – Mar 2026 |
| `account.<store>`, `portal.…`, `billing.…`, `subscriptions.…` | CNAME `lasso-customer-portal.pages.dev.`: Lasso's subscription customer portal | |
| Lasso itself | `checkout.lassocheckout.com` → Vercel; `api.lassocheckout.com` → Cloudflare; `payments.lassocheckout.com` → Stripe hosted checkout; `hooks.lassocheckout.com` → hkdk.events | |

### The checkout page (`checkout.<store>/`)

- `<title>Secure Checkout</title>`, served by Vercel.
- The boot code: `localStorage.getItem('lasso_theme_hint')` and `document.body.classList.add('lasso-dark-boot')`.
  These two strings are unique to Lasso and are what the script checks.
- A React app (`/assets/main-*.js`) that sends `X-Lasso-Page-Id` and `X-Lasso-Session-Id` headers. Its endpoints show
  what the checkout does: `/checkout/optimizers/payment-page/live/v2` (order bump on the payment page),
  `/cart-sessions/post-purchase` and `/cart-sessions/confirm-post-purchase` (one-click upsells after payment),
  `/checkout/confirmation-pages/live`, `/checkout/post-purchase-surveys/live`.
- No "Powered by Lasso" footer: the checkout is white-label.

## 4. Every route I tried, and what it is worth

| Route | Free / paid | What I searched | Result |
|---|---|---|---|
| **AlienVault OTX passive DNS** | Free, no key (an anonymous call; a free account gives more) | `GET https://otx.alienvault.com/api/v1/indicators/hostname/1a28dfb57b1e1efc.vercel-dns-016.com/passive_dns` and the same for `a94813196ce765c4.vercel-dns-016.com` | **100 checkout hosts**, first seen Dec 2025 – Oct 2026. The best source: every store that set up its checkout domain, also stores nobody scanned. Of these stores, 49 are live on Lasso, 48 closed and 3 left Lasso |
| **urlscan.io search** | Free without a key (low rate limit). A free account gives an API key; paid plans start at about $416/month billed yearly | `domain:lassocheckout.com` (337 scans in the last 30 days), `filename:"lasso-script-v4.min.js"`, `filename:"lasso-script-v2.min.js"`, `filename:"lasso-script.min.js"`, `page.title:"Secure Checkout" AND page.server:Vercel`, and the sha256 of the current checkout bundle (`hash:…`) | **132 of the live stores**: live stores that someone (often a security scanner that follows ads) scanned in the last month. Free search only reaches back about 30 days, so run it weekly |
| DuckDuckGo Tracker Radar | Free (public data on GitHub, updated about monthly) | `domains/US/vercel-dns-016.com.json` → `cnames` | 4 stores, 1 of them new. Small, but costs nothing |
| crt.sh (certificate transparency) | Free | `%.lassocheckout.com`, `%.lassocommerce.com`, `%.lassocart.com` | Mapped Lasso's own setup (`checkout`, `api`, `dashboard`, `portal.shop`, `hooks`, `docs.lassocommerce.com`, …). No use for stores: a store's certificate names only the store |
| DNS lookups (DNS over HTTPS) | Free | CNAME of each checkout host | Confirms a single host; it cannot search backwards. Reverse-CNAME search needs a paid passive-DNS service (SecurityTrails, Validin, DNSlytics) |
| GitHub code search | Free | `lassocheckout`, `lasso-script-v4`, `1a28dfb57b1e1efc` | Only tracker lists (DuckDuckGo Tracker Radar and copies). No theme code |
| Web search (Google-style), Reddit, YouTube, TikTok, X | Free | "Lasso checkout", "lassocheckout.com", Whop + Lasso | Whop's (now removed) docs page, Trustpilot (1 review), GetApp and Capterra (1 review). No community threads or case studies naming stores |
| Lasso's site, blog, user guide, demo | Free | lassocommerce.com, `/resources` (28 posts), `docs.lassocommerce.com` | The User Guide is behind a login (not opened). No customer logos or case studies name a store. The demo store `shop.lassocheckout.com` shows the exact tag |
| Meta Ad Library | Free (public, logged out) | It cannot search by checkout URL: ads link to the store, not the checkout | Used per store to check for ads (section 5) |
| PublicWWW (source-code search) | Paid for real use: free shows 20 rows with snippets (account needed); $49/day, $79/week, $109/month, $199/month, $499/month | Would be `"shopify-scripts/lasso-script"` | Not used (no account). Worth one month ($109) if you want the stores that urlscan never scanned |
| BuiltWith, Wappalyzer, SimilarTech, Stackcrawler | Free lookups for one site; lists are paid (BuiltWith $295–995/month, Wappalyzer $250–850+/month) | Tech "Lasso Commerce" | None of them knows Lasso. Wappalyzer's open fingerprint set has no `lassocheckout` (its "Lasso" is a different product), and BuiltWith's lookup did not load from here. So they cannot make a Lasso list |
| Shodan, Censys | Censys: a free account with monthly credits. Shodan: a paid membership for filters (its price page did not load from here) | Body `lasso-dark-boot` | Not tested. The checkouts sit on shared Vercel IPs behind SNI, so IP scanners see them badly. OTX already gives the hosts |
| Common Crawl | Free (the index); content search needs WARC downloads or AWS Athena (paid) | `*.lassocheckout.com/*` | The index has checkout URLs with `storeId`, not store domains. Not worth the effort next to OTX and urlscan |
| Lasso's API | No | `/store/checkout-domains/admin/view-all` exists in the checkout code | Not touched: it is an admin endpoint behind a login |

## 5. The stores

All 177 stores are in [`lasso-stores.csv`](lasso-stores.csv). It has these columns:

- the store and its mirror domains
- the checkout URL and the Lasso evidence, with a confidence
- the name, where the business is registered (Shopify's `/meta.json`), the countries it ships to, language and currency
- the number of products and the store kind (one-product ≤ 3, niche ≤ 25, general)
- an archetype (a heuristic, see below)
- the top 3 best sellers (Shopify's own sales order, with shipping protection and free gifts left out) and their prices
- whether ads were found, the oldest active ad, the page names, an Ad Library link, and a sample ad
- urlscan scans in 30 days, the date of the store's first product, any story claim on its home page, and a winner
  note for the best ones

**Confidence.** *High*: Lasso's script, or its pasted code, is on the store's home page. *Medium*: the store's
`checkout.<store>` serves Lasso's checkout, but the home page has no Lasso code. The store may have stopped using it,
or it loads the script in a way a plain fetch does not see. Nothing was listed on a source alone: every store was
fetched. 6 of the 177 were not open to the public that day (a password page or no products), and one of
them is a test store; the CSV says so in their note.

**Ads.** For every store I searched the public Ad Library (all countries, active ads, logged out) twice: for its
domain and for its brand name. I counted only ads that link to the store or one of its domains. A logged-out search
shows at most about 30 ads, so "ads seen" is a lower bound. "None found" does not mean no ads: many of these stores
advertise from pages with a person's name ("Jennifer Quinn", "Sophie Fraser") and with ad text that names neither
the brand nor the domain. The CSV has the Ad Library link for every store; open it in a browser to see the page
itself.

### What the 177 stores are

| Market (from the countries the store ships to) | Stores |
|---|---|
| worldwide (13+ countries) | 49 |
| US only | 37 |
| UK (alone or with US, AU, CA) | 26 |
| AU / NZ | 20 |
| ships to NL / DE / BE / AT | 15 |
| ships to other EU (FR, ES, IT, DK, SE…) | 13 |
| other / mixed | 7 |
| unknown | 6 |
| Canada | 4 |

| Archetype (heuristic) | Stores |
|---|---|
| local-boutique story (fashion) | 58 |
| fashion / general | 32 |
| general / gadgets | 27 |
| artisan-story products | 23 |
| one-product / DTC brand | 19 |
| free + shipping (closing-sale story) | 10 |
| branded goods (check IP/counterfeit risk) | 7 |
| local-boutique story | 1 |

| Business registered in (Shopify `/meta.json`) | Stores |
|---|---|
| US | 71 |
| NL | 39 |
| HK | 24 |
| GB | 16 |
| unknown | 6 |
| SE | 3 |
| AU | 2 |
| ES | 2 |
| BE | 2 |
| CH | 2 |
| MA | 2 |
| NZ | 2 |

| Store kind (products listed) | Stores |
|---|---|
| general | 152 |
| niche | 15 |
| one-product | 8 |
| ? | 2 |

| First product created | Stores |
|---|---|
| 2026-01 to 2026-07 | 59 |
| 2026-08 to 2026-10 | 88 |
| before 2026 | 24 |

- **Ads:** 29 stores had active ads in the public Ad Library that link to the store (lower bound; see above).

**Product clusters** (in a store's top 5 best sellers):

| Product | Stores | For example |
|---|---|---|
| Orthopedic / arch-support comfort shoes | 24 | aussie-flair.com, nokmo.com, elle-charleston.com, lorenaboutique.com, vela-avenue.com … |
| Quilted bags and baskets ("hand-quilted", "artisan") | 13 | marysparksvillebeach.com, fitsclassic.com, backroad-goods.com, margaretskingsbeach.com, craft-folk.com … |
| Maxi / midi dresses | 20 | aussie-flair.com, curvebloomnashville.com, leonboutique.co, elle-charleston.com, marialina-juwelen.de … |
| Copper jewellery / bottles | 5 | copperandcanyon.com, veras-copper.net, dellacopper.com, velunira.nl, mabelcopper.com |
| Bird baths, birdhouses, bee hotels | 4 | cedarandtinco.com, craft-folk.com, havendon.store, marlowmarketco.com |
| Gummies (supplements) | 4 | bronzii.com, tryglowgummies.com, tryfloralabs.com, trybloomin.com |

### Top 15 to look at

My pick for Connor (EU first, then the US). The order weighs: ads actually running and how long, more than one
domain (rotation means spend), urlscan scans, the best-seller order, and whether the product suits your rules
(no supplements, cosmetics, food or medical claims for the EU board).

| # | Store · ships to · confidence | Best seller — price | Signals | Ads | Why look |
|---|---|---|---|---|---|
| 1 | [miraclemop-au.com](https://miraclemop-au.com) · AU NZ · high | MiracleMop Magic Cleaning Kit — 59.95 AUD | 29 ads seen, oldest 2025-01-16; 1 urlscan scan in 30 days; first product 2023-10-26 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=miraclemop-au.com) | MiracleMop cleaning kit A$59.95 plus refills (FlexiBucket, toilet wand refills = repeat orders). 29 ads link here, the oldest from 16 Jan 2025: an evergreen winner running for 21 months. Search the EU for the same mop under other names. |
| 2 | [castellacookware.com.au](https://castellacookware.com.au) · 25 countries · high | Titanium Hammered Pan + FREE LID — 139.95 AUD | 15 ads seen, oldest 2026-10-29; 1 urlscan scan in 30 days; first product 2026-02-03 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=castellacookware.com.au) | Titanium hammered pan + free lid A$139.95 (high AOV, bundles). 15 ads, all started 29 Oct 2026: a fresh push. Registered in Spain, ships to NL/DE. Non-toxic, uncoated cookware is a 2026 trend; check 'pure titanium' claims. |
| 3 | [lowellsydney.com](https://lowellsydney.com) · 41 countries · high | Hayleigh Braided Cork Orthopaedic Sandals – Double Buckles — 79.95 AUD | 25 ads seen, oldest 2026-10-24; 3 urlscan scans in 30 days; first product 2026-07-02 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=lowellsydney.com) | Braided cork 'orthopaedic' sandals A$79.95. 25 ads since 24 Oct 2026. Orthopedic and arch-support comfort shoes are in the top 5 best sellers of 24 Lasso stores (incl. DE): the biggest product cluster. In the EU say 'comfort', not 'orthopaedic' (a medical claim). |
| 4 | [sophiemilliebags.com](https://sophiemilliebags.com) · AU · high | Artisan Bag - Five Colourful Chickens — 59.95 AUD | 24 ads seen, oldest 2026-09-17; 7 urlscan scans in 30 days; first product 2026-06-23 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=sophiemilliebags.com) | Quilted 'artisan' tote bags with printed scenes (chickens, highland cow, dragon reader) A$59.95. 24 ads since 17 Sep 2026. The same designs sell on hattieandrosebags.com and jennifer-bags.com; quilted bags or baskets are in the top 5 of 13 Lasso stores: a proven product cluster. |
| 5 | [forgefjord.com](https://forgefjord.com) · ships to ? · high | Viking Thor's Hammer Mjolnir Braided Leather Bracelet Gift F — free + shipping | 29 ads seen, oldest 2026-10-30; first product 2026-08-14 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=forgefjord.com) | Viking jewellery (Mjolnir bracelet, rune necklace) 'free, just cover shipping': every product is $0 in Shopify and Lasso charges the shipping and the upsells. 29 ads, all started 30–31 Oct 2026. Cheap to source; in the EU the shipping price must be shown up front. |
| 6 | [cedarandtinco.com](https://cedarandtinco.com) · 237 countries · high | Geoff's Handmade Bronze Bird Bath — 39.95 USD | none found (open the link); 9 urlscan scans in 30 days; first product 2026-06-21 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=cedarandtinco.com) | 'Geoff's' handmade bronze bird bath $39.95 and a cat lamp $47.95: garden/gift products with an elderly-maker story. 9 urlscan scans in 30 days. Registered in Albuquerque, like backroad-goods.com and meiling-bags.com (probably one operator). Copy the product, not the story. |
| 7 | [backroad-goods.com](https://backroad-goods.com) · 28 countries · high | Wanda's Ghost Lantern — 49.00 USD | none found (open the link); 36 urlscan scans in 30 days; first product 2026-10-06 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=backroad-goods.com) | 'Wanda's Ghost Lantern' $49 (Halloween, now over), hand-quilted sheep basket $59–72, rain drum $46.50. The most-scanned Lasso store after the gummies (36 scans in 30 days); store from 6 Oct 2026. Ships to NL/DE. |
| 8 | [velunira.nl](https://velunira.nl) · BE NL · high | Keukengerei-set van acaciahout — 44.99 EUR | none found (open the link); first product 2026-10-22 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=velunira.nl) | A Dutch-language store (NL/BE only) with an acacia-wood kitchen utensil set €44.99 ('was' €199.90), a utensil holder and a copper bottle. First product 22 Oct 2026; registered in Agadir, Morocco. A direct NL competitor: watch whether its ads keep running. |
| 9 | [bergmannatelier.de](https://bergmannatelier.de) · DE · high | Ärmellose Latzhose — 59.95 EUR | none found (open the link); 1 urlscan scan in 30 days; first product 2026-09-17 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=bergmannatelier.de) | Dungarees €59.95, 'Levila' orthopaedic sandals €59.95, wrap swimsuit €39.95. Ships to DE only; run from Deventer (NL); 2,862 products. A Dutch operator in your DE market. |
| 10 | [mathilde-munchen.de](https://mathilde-munchen.de) · AT CH DE · high | Fließendes langes Kleid – chic und bequem — 39.95 EUR | none found (open the link); 3 urlscan scans in 30 days; first product 2026-06-23 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=mathilde-munchen.de) | Flowing long dresses and summer dresses €39.95 ('was' €135). Ships AT/CH/DE; registered in Avon Park, Florida while presenting as a Munich boutique: the story-store pattern. |
| 11 | [hyggehavn.com](https://hyggehavn.com) · DK · medium | Glødflamme – lanternen med den evige flamme — 275.00 DKK | 30 ads seen, oldest 2026-07-14; first product 2025-08-29 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=hyggehavn.com) | 'Glødflamme' eternal-flame lantern (275 DKK). 30 active ads link here, the oldest from 14 Jul 2026 (3.5 months running), from an advertorial page ('Tips Til Et Hyggeligt Hjem'). Gift/home product before Christmas; fits NL/DE as-is. Lasso is set up on checkout.hyggehavn.com, but the live store now uses Shopify's own checkout (medium). |
| 12 | [themountcoastalboutique.nz](https://themountcoastalboutique.nz) · NZ · high | Zamma / Relaxed V-Neck Top — 68.95 NZD | 27 ads seen, oldest 2026-10-12; first product 2026-08-21 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=themountcoastalboutique.nz) | Women's tops and dresses NZ$69–97. 27 ads since 12 Oct 2026, from a page with a person's name ('Wendy A. Morrison'). Story boutique for NZ, registered in the US. |
| 13 | [edjvntge.uk](https://edjvntge.uk) · 237 countries · high | 5 PIECE MYSTERY BOX — 82.00 GBP | 23 ads seen, oldest 2026-08-29; 2 urlscan scans in 30 days; first product 2022-04-14 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=edjvntge.uk) | Vintage clothing mystery boxes £49–82. 23 ads since 29 Aug 2026; a real store since 2022 (first product Apr 2022). The mystery-box offer converts well with an order bump. |
| 14 | [sleepbysanti.co](https://sleepbysanti.co) · US · high | Amorgos Fine Velvet Bedding Set — 329.95 USD | none found (open the link); 9 urlscan scans in 30 days; 6 domains; first product 2019-12-22 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=sleepbysanti.co) | Velvet bedding sets $299–330. One Shopify store on 6 domains (sleepbysanti.co/.com, thetranquilitybed.com, tranquilitybed.co, tranquilitybedhome.co, yilly.shop): domain rotation means heavy ad spend. US only, high AOV. |
| 15 | [craft-folk.com](https://craft-folk.com) · 41 countries · high | Maggie's Handquilted Hippie Bus Weekender — 59.00 USD | none found (open the link); 1 urlscan scan in 30 days; first product 2026-03-16 | [Ad Library](https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&media_type=all&search_type=keyword_unordered&q=craft-folk.com) | 'Maggie's' hand-quilted hippie-bus weekender $59, wild bee hotel $69, bee blossoms: garden and gift decor (spring season in the EU). Same artisan cluster as marlowmarketco.com (birdhouses). |

### Strong traction, but outside your EU rules

| Store | Best seller | Signals | Note |
|---|---|---|---|
| [tryglowgummies.com](https://tryglowgummies.com) | Glow Tanning Gummies — 48.87 NZD | 30 ads seen, oldest 2026-04-22; 75 urlscan scans in 30 days; first product 2025-01-30 | Tanning gummies. 625 active ads mention the domain, and 75 urlscan scans in 30 days: the most-advertised Lasso store. NZ-registered. |
| [trybloomin.com](https://trybloomin.com) | Bloomin - Shelajit Gummies — 49.95 USD | 29 ads seen, oldest 2026-05-21; first product 2025-10-03 | Shilajit gummies; about 2,400 ads mention the domain; advertorial pages ('Women's Wellness Review'). |
| [tryfloralabs.com](https://tryfloralabs.com) | Inner Youth Collagen Powder Mango Passion - 450g — 46.25 NZD | 30 ads seen, oldest 2026-10-26; 55 urlscan scans in 30 days; first product 2025-06-19 | Collagen + mushroom gummies; 55 urlscan scans in 30 days. |
| [vigewell.com](https://vigewell.com) | 2 in 1 colour changing foundation stick — 39.99 USD | 30 ads seen, oldest 2026-10-14; 4 urlscan scans in 30 days; first product 2026-07-03 | Colour-changing foundation stick and hair serum; 30 of 30 ads link here, from a 'Dr. … MD' page. |
| [bronzii.com](https://bronzii.com) | Bronzii™ Tanning Gummies — 59.95 USD | none found (open the link); first product 2026-04-25 | Tanning gummies, the same product as tryglowgummies.com. |
| [goda.co](https://goda.co) | Mystery Signature Scent — 39.00 USD | 10 ads seen, oldest 2026-04-03; first product 2024-03-20 | Pheromone perfume; 10 ads since 3 Apr 2026. |
| [redlifelights.com](https://redlifelights.com) | RedLife Pro Belt — 529.20 USD | none found (open the link); first product 2025-02-19 | Red-light therapy belt $529. |

### What to watch out for

- **Story claims.** 42 stores make a story claim on their home page. Examples: "after nine wonderful years,
  it's time for me to retire", "As we close our doors for retirement", "A reliable Melbourne-based brand since 1994",
  "Seit 2001 eine vertrauenswürdige Berliner Marke". Yet Shopify shows their first product from 2026, and
  `/meta.json` shows the business registered elsewhere: "Mathilde München" in Avon Park, Florida; "Elle Zürich" in
  London; "Ella & Rose Melbourne" in The Hague. In the EU, falsely claiming that you are about to stop trading is a
  banned practice in all cases (Unfair Commercial Practices Directive, Annex I point 15). False "only today" scarcity
  is banned too (point 7). **Copy the products, not the story.**
- **Brand goods.** Football jerseys (`xclusivejerseys.com`, `afufi.com`, `nalisom.com`), "Hoka Bondi 9 Sneakers"
  (`olamil.co`) and BMW parts look like counterfeit or IP risk. Skip them.
- **Medical claims.** "Non-painful glucometer" (`lampilo.com`, `elleseandco.com`), "Lymphatic drainage drops",
  "Kids height gummies": not for the EU.
- **Short lives.** 59 Lasso stores died within months (Shopify 402 or 423, or the domain is gone). A
  product's ads tell you more than the store's age.

## 6. The weekly method (by hand, about 30 minutes, free)

1. **New checkout domains.** Open
   [OTX: 1a28dfb57b1e1efc.vercel-dns-016.com](https://otx.alienvault.com/indicator/hostname/1a28dfb57b1e1efc.vercel-dns-016.com)
   → *Passive DNS*, and sort by *First seen*. Every new `checkout.<store>` is a store that just went live on Lasso.
2. **Recently scanned stores.** In urlscan.io search, run `domain:lassocheckout.com AND date:>now-7d` and
   `filename:"lasso-script-v4.min.js" AND date:>now-7d`. Look at the page domains; skip `*.myshopify.com`.
3. **Check the store.** Open `https://<store>/meta.json` for the business country, the countries it ships to and
   the product count. Then open `https://<store>/collections/all?sort_by=best-selling` for its best sellers.
   View-source and search for `shopify-scripts/lasso`. Or view-source `https://checkout.<store>/`: a "Secure
   Checkout" page with `lasso-dark-boot` in it is Lasso.
4. **Check the ads.** Open
   `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=ALL&q=<store domain>&search_type=keyword_unordered`,
   then open the page behind an ad that links to the store, for all of its ads.
5. **Into Winner Hunter.** Put the product in the Inbox flow you already use (★ / ✓ and a 🚀 launch card).

Or let the script do steps 1–3 (next section): it does all of it in about a minute, free.

## 7. The script in Winner Hunter (optional, off by default)

The pull request adds the following. Nothing runs until you start it, and the board does not change.

| File | What |
|---|---|
| `winner-hunter/lib/lasso.mjs` | The fingerprints and the checks: `lassoTag`, `lassoMarks`, `isLassoCheckout`, the sources (`otxPassiveDns`/`otxHosts`, `urlscanSearch`/`urlscanHosts`, `ddgRadar`/`ddgHosts`), the store checks (`checkStore`, `checkCheckout`, `shopMeta`, `bestSellers`, `catalogSize`) and `topProducts` (shipping protection and gifts left out) |
| `winner-hunter/lasso.mjs` | The run. It gathers candidates (OTX, urlscan for the last 30 days, DuckDuckGo, plus every store already in D1), checks each one on the store itself, saves one row per Shopify store with its top 5 best sellers, marks stores that dropped Lasso as `gone`, and keeps `first_seen`. Red when no source answered or D1 failed; yellow when one source failed or time ran out |
| `winner-hunter/worker/migrations/0016_lasso.sql` | D1 table `lasso_stores` (domain, store id, checkout host, verdict, script, name, language, currency, business country, ships to, products, kind, best sellers as JSON, sources, first / last seen) |
| `.github/workflows/lasso-stores.yml` | **Manual only** (Actions → Lasso stores → Run workflow). To make it weekly, add `schedule: - cron: '17 3 * * 1'` |
| `winner-hunter/test/lasso.test.mjs` | Tests: the tag variants, the sources, the store checks on fake stores, a full run on the in-memory D1 (dedupe, `first_seen` kept, `gone`), the run's health, the CSV, and the workflow rules |

- **Cost: €0.** No secrets are needed beyond the D1 ones the other hunts already use. `URLSCAN_API_KEY` is optional:
  a free urlscan account only raises the limits.
- **This repository is public, and so are its Actions logs.** The run therefore prints counts only, never a store
  name. The stores go to D1, behind the board's PIN. To get a file on your own computer:
  `LASSO_CSV=lasso.csv node winner-hunter/lasso.mjs` (no D1 needed).
- Tested on 2026-11-01 against the live web: 273 candidates, 177 stores verified (151 by their script, 26 by their checkout host), 8 extra domains merged, health ok, in 67 seconds.

### Into the board (the next step, not in this PR)

This follows how the board reads the other sources today. Line numbers are as of commit `8299e42`.

1. **Worker** (`worker/src/app.mjs`):
   - Add `optional(LASSO_SQL)` to `readTables` (around line 122). It reads `lasso_stores WHERE verdict != 'gone'` and
     turns each store's best sellers into board rows, the way `worldRow` does (around line 215). Use gk
     `lasso|<store>/products/<handle>` and ad_id `l<hash>` (it must match `^[A-Za-z0-9_-]{1,64}$`).
   - Add `lasso_run`'s `updated_at` to `VERSION_SQL` (around line 88), so a run refreshes the snapshot.
   - Give `products()` a list `l`, and add a scope `lasso` in `viewOf` and `countsOf`; update `worker.test.mjs:98`,
     which pins the count keys.
   - Hide, ★, ✓, notes and the "Why?" feedback then work unchanged: they key on gk and ad_id.
2. **Board** (`worker/src/board.html`): a scope button next to 🌍 / EU / TikTok. The card shows "Lasso checkout since
   <first_seen>", the ship-to flags, the business country, the store's top 5 best sellers, and links to the store,
   the product and the Ad Library search.
3. **Launch**: let `keyIn` accept `lasso|` keys (`launch.mjs`, around line 222), so a ✓ Lasso product gets a launch card.
4. **Optional, for the EU hunt**: for Lasso stores that ship to NL, DE, BE or AT, search the Ad Library API (with
   `META_TOKEN`) for their domain. That gives EU reach, so the four hard rules can run and winners land in the normal
   Inbox. Test first whether the API's `search_terms` matches a domain.

## 8. Costs

| Item | Cost |
|---|---|
| OTX passive DNS, urlscan.io search (no key, or a free account), DuckDuckGo Tracker Radar, crt.sh, DNS over HTTPS, Shopify `/meta.json` / `products.json` / Storefront API, public Meta Ad Library | **Free** |
| GitHub Actions for a weekly run (a minute or two) | Free in a public repository |
| Optional: PublicWWW for one month (source search, finds stores nobody scanned) | $109 |
| Optional: urlscan Pro saved searches with alerts | from about $416/month, billed yearly |
| Optional: a reverse-CNAME passive-DNS service (SecurityTrails / Validin / DNSlytics) | paid; the prices were not checked here |
| Not useful for this: BuiltWith ($295–995/month), Wappalyzer ($250–850+/month) | they do not detect Lasso |

## 9. Method notes and limits

- **Run on 2026-11-01**, from a cloud sandbox. Store pages were fetched with a desktop Chrome user
  agent, about 6 at a time, and only public pages and Shopify's public JSON. No logins, no paywalls, nothing behind
  a bot check.
- **Prices** come from the store's Storefront API in the visitor's currency. A store with Shopify Markets can show a
  converted price; the CSV gives the currency of each price.
- **OTX** keeps passive DNS from its sensors, not every lookup on the internet. urlscan only has what someone scanned.
  So the list is large but not complete. Together the two sources found all but one of the live stores; the last one
  came from DuckDuckGo's list.
- **Archetype** is a heuristic: city or family words in the name, possessive maker names in product titles, product
  count. Read it as a hint.
- **Mirrors**: one Shopify store, found through its `*.myshopify.com` domain, on several domains is one row. The CSV
  lists the other domains.
