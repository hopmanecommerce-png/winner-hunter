# Google Ads Transparency Center hunt

The Google hunt (`winner-hunter/google.mjs`) finds products that Shopify stores advertise on Google: Search, Shopping, YouTube
and Display. It reads Google's ad library, the [Ads Transparency Center](https://adstransparency.google.com), through the
paid Scrape Creators API. It checks every product with the board's rules wherever Google's data allows it. The board shows the
products under **Google**.

Status (2026-11-01): built and tested against the vendor's documentation and fixtures. No live call was made, because the build
session had no API key. The first real run should be a dry run (see [Turning it on](#turning-it-on)). The list of
[things to verify on that run](#verify-on-the-first-live-run) says what the documentation does not settle.

There was no Scrape Creators code or secret in this repository before (all branches searched). The secret is new:
`SCRAPECREATORS_API_KEY`.

## The API

Source: the vendor's docs and OpenAPI spec ([docs.scrapecreators.com](https://docs.scrapecreators.com), `openapi.json`, read
2026-11-01) and its [pricing](https://scrapecreators.com/#pricing).

- **Base URL:** `https://api.scrapecreators.com`. **Authentication:** the header `x-api-key`. The key never goes in a URL.
- **Price:** 1 credit is 1 request for these endpoints. The packs are 100 free credits, **$47 for 25,000** ($1.88 per 1,000),
  and $497 for 500,000 ($0.99 per 1,000). Credits never expire. Each answer says what it cost (`credits_charged`) and what
  is left (`credits_remaining`).
- **Rate limits:** the vendor says there are none, and recommends staying below 500 requests at once. The hunt sends at
  most 3 at once.
- **Errors:** 400 bad parameters, 401 a wrong key, 402 no credits left, 403 the source blocks it, 404 not found, 500 try
  again. The client stops the run on 401 and 402. It reads a 404 as "nothing found", and asks again twice after a 429 or a 5xx.
  Three calls in a row that fail (after those tries) mean the vendor is down: the run stops and says so.
- **Lost answers:** a timeout or a cut connection may come after the vendor did the work and billed it. Such a try counts as
  spent, so the cap holds against the bill. It is asked again once.
- **Cache:** an ad's details cost 0 credits when the vendor has a copy younger than `cache_max_age` (the hunt asks for 7 days).
- **Login-only ads** are not available: the vendor reads the public Transparency Center.

### The three endpoints

| Endpoint | Parameters | What comes back | Credits |
|---|---|---|---|
| `GET /v1/google/adLibrary/advertisers/search` | `query` (required), `region` (2 letters, default US) | `advertisers[]`: `name`, `advertiser_id` (AR…), `region`, `number_of_ads_estimate`. `websites[]`: `domain` | 1 |
| `GET /v1/google/company/ads` | `domain` or `advertiser_id`, `topic` (all / political), `region` (default anywhere), `start_date` / `end_date` (YYYY-MM-DD: ads shown then), `platform` (google_search, google_shopping, youtube, google_maps, google_play), `format` (text, image, video), `get_ad_details` (true costs 25), `cursor` | `ads[]`: `advertiserId`, `creativeId` (CR…), `format`, `adUrl`, `advertiserName`, `imageUrl`, `firstShown`, `lastShown`. Also `cursor` (the next page) and `number_of_ads_estimate` | 1 a page |
| `GET /v1/google/ad` | `url` (the ad's Transparency Center link, required), `cache_max_age` (1d, 3d, 7d, 14d, 30d) | `advertiserId`, `creativeId`, `format`, `firstShown`, `lastShown`, `overallImpressions` {`min`, `max`}, `creativeRegions[]` {`regionCode`, `regionName`}, `regionStats[]` {`regionCode`, `firstShown`, `lastShown`, `impressions` {`lower`, `upper`}, `platformImpressions[]`}, `variations[]` {`destinationUrl`, `headline`, `description`, `allText` (OCR), `imageUrl`}. Political ads only: `spend`, `targeting` | 1, 0 cached |

**Pagination:** pass the answer's `cursor` back for the next page. The page size is not documented; the vendor's example page
holds 15 ads. **Dates** are ISO strings. The vendor warns that `firstShown` can be empty in `/v1/google/ad` when the list has
it: the hunt keeps the list's date. It also warns that "the return types might not all be 100% the same", so every field is
read defensively. An odd or missing field is unknown, never a pass.

The vendor's own example answers are in `winner-hunter/test/fixtures/google/vendor-*.json`, copied verbatim. The parser
tests run on them.

### What Google does not give

- **No keyword search of ads.** Google's library, and so this API, finds advertisers by name and shops by domain only. A
  keyword therefore finds advertisers and shop domains whose names contain it.
- **No landing page.** `destinationUrl` is the domain the ad shows (`shop.gop.com` in the vendor's example), sometimes with a
  path. The product page then comes from the store's own search with the ad's headline, as the Meta EU hunt does with an ad's
  link title.
- **No reach.** Google publishes impression *ranges*, and only for some ads: political ads, and per country for ads shown
  in the EU (the Digital Services Act). Impressions count showings, not people.
- **No "active" flag.** Only first shown and last shown.
- **No count of active ads.** Only `number_of_ads_estimate`, Google's rounded estimate for the filters you set.
- **No spend or targeting** except for political ads. No clicks or click-through rate, nothing about results.

## Our rules on Google's data

Every rule on a Google card carries a mark:

- **✓ exact:** the same rule on the same kind of fact as on Meta.
- **≈ approximated:** the closest fact Google gives. The card's text says which one.
- **? not checked:** Google gives nothing to check it with. This is never shown as a pass.
- **✗ failed:** the product is never saved. A saved product that fails when checked again leaves the board.

| Our rule | On Meta | On Google | Mark |
|---|---|---|---|
| **1. Shopify store** | The ad's shop domain → `meta.json` and Shopify's headers (`lib/world.mjs` `checkStore`) | The ad's `destinationUrl` domain, or the domain the hunt searched → the same `checkStore`. A store that does not answer is unknown (asked again next run), never "not Shopify". Marketplaces and big brands (`NON_STORE`) fail. | **✓ exact** |
| **2. Advertiser 75+ active ads** | Meta's count of the page's active ads | `number_of_ads_estimate` of `/v1/google/company/ads` with `start_date` / `end_date` set to the last 3 days: Google's estimate of the advertiser's (or domain's) ads shown in that window. If Google gives no estimate, the ads counted on the pages read are a lower bound (75+ counted passes, and fewer than 75 fails once every page was read). No count at all: not saved, asked again. | **≈ approximated** |
| **3. Ad live 7–42 days** | `ad_delivery_start_time` → days today, and the ad is active | `firstShown` → whole days today (7 to 42). "Still running" means `lastShown` in the last 3 days, and the list only asks for ads shown in those days. An ad shown last 3+ days ago fails ("Stopped"). No `firstShown` anywhere: not saved. | **✓ exact** (Google's own dates). "Running" is approximated by "shown in the last 3 days". |
| **4. 500+ EU reach a day** | `eu_total_reach` ÷ days live | The EU countries' `regionStats[].impressions` added up, ÷ days live. The lower bound at 500+ a day passes. The upper bound below 500 fails. A range in between is unknown. Impressions are showings, not people (reach ≤ impressions), so a pass is looser than Meta's rule. Google's total (`overallImpressions`) can only **fail** the rule: under 500 a day in total is under 500 in the EU. It never passes it. **No EU range: not checked**, and the card says so. That includes an ad Google lists only outside the EU ("Shown outside the EU only"). | **≈ approximated** when Google publishes EU ranges, **? not checked** otherwise |

A product is saved when no rule fails and rules 1–3 are known. Rule 4 may be "not checked":

- **winner:** all four rules pass, exactly or approximately. The card shows "4/4 rules".
- **partial:** the reach rule is not checked. The card shows "3/4 rules · ✓ ≈ ✓ ?". The tab's **All 4 rules** filter
  hides these. Expect most Google products here: Google publishes ranges for few ordinary ads (see [Verify](#verify-on-the-first-live-run)).

### The other checks, as on the other tabs

| Check | How | Mark |
|---|---|---|
| Restricted categories (supplements, food and drink, cosmetics, perfume, medical claims, pet health, not a product) | `lib/world.mjs` `screenEU` on the product's title, the ad's headline and the product type. Such products are never saved. | ✓ exact |
| Jev's risk flags (people or pets take it, medical claim, sizing, brand, hard to ship, …) | `world-check.mjs` asks Jev about each Google product (saved as `google|<product page>` in `world_checks`). The Inbox ranks it with the same `riskOf` factors. As on the EU board, a product people or pets take stays out of the Inbox. A product page Jev already answered for outside the EU uses that answer. | ✓ exact |
| Best-seller boost, Trustpilot | `bestsellers.mjs` includes the Google products: the rank in the store's top 50, and Trustpilot | ✓ exact |
| Price, photo, product page | The store's `/products/<handle>.json` (`lib/world.mjs` `fetchProduct`) | ✓ exact |
| One card per product page | `lib/bestsellers.mjs` `productKey` (the domain without www, the handle, no locale or query): the board's own key | ✓ exact |
| Your decisions and learning | ✓ Approved / ✗ Reject, notes, Why?, 🧠 and 🚀 use the same tables as every product (`hidden`, `stars`, `feedback`, `launches`). A "Bad store" from the Google tab blocks that shop everywhere. | ✓ the same |

### Equivalents for reach: the proof on a Google card

Google gives no reach, so a Google card shows six plain facts, as the 🌍 tab does outside the EU. They rank the Inbox; none
of them counts as a pass of the reach rule.

| Proof | Why |
|---|---|
| **Also on Meta:** the same product page (strongest) or its shop is on the Meta board, EU or outside the EU | A shop that pays for the same product on two networks is selling it |
| **Also on TikTok:** its shop is on the TikTok tab (the domain the TikTok shop's Meta ads go to); "product" when the titles also match | TikTok's sold counts are real sales |
| **3+ Google ads for this product** (different creatives, all ad formats) | A shop makes more versions of an ad that works (Meta's "copies") |
| **Shown in 2+ countries** | It is rolled out beyond one test market |
| **In its store's top 50** best sellers | Proof of sales from the store itself |
| **100+ Trustpilot reviews** | An established store |

The card also says **Not on Meta** when neither the product page nor its shop is on the Meta board, and a Meta card says
**Also on Google** when its product page or shop is on the Google tab.

Considered and left out:

- Ad count, number of countries or copies as a *pass* of the reach rule. They measure scale, not reach, and the board would
  then show a ✓ for a rule nobody checked.
- `platformImpressions`: a split of impressions by platform. It adds nothing to the reach check.
- `spend` and `targeting`: political ads only.

## How the hunt searches, and what it costs

1. **Typed shops or advertisers** (`GOOGLE_DOMAINS`, the workflow's "domains" box).
2. **Shops already on the board** (`GOOGLE_BOARD_DOMAINS`, 10 a run by default): the EU Meta board, outside the EU, and the
   TikTok tab. These find the cross-network products.
3. **The next keywords of `keywords.txt`** (`keywords-optin.txt` too with `KEYWORDS_OPTIN=1`), in every `GOOGLE_REGIONS`
   region (NL, DE, FR by default). The cursor is in D1 state `google_cursor` and only moves past finished keywords.

Per advertiser or domain:

1. A shop domain is checked for Shopify first, for free. Not Shopify: no credits.
2. Its ads shown in the last 3 days: 1 credit a page, at most `GOOGLE_PAGES` (2) pages. Under 75 ads: stop.
3. Up to `GOOGLE_DETAILS` (4) ads in the 7–42-day window, image ads (Shopping, Display) first, then the oldest: 1 credit each.

Gates that save credits:

- An advertiser whose search estimate is under 75 is never looked at.
- An advertiser or domain looked at is not looked at again for 3 days (D1 `google_targets`).
- An ad's details are kept for a week (D1 `google_ads`).
- Ads that are too young, too old or stopped are never paid for.
- Two advertisers selling the same ad never pay for it twice.

**Hard cap:** `GOOGLE_CREDITS` (300 by default, at most 5,000). The client never sends a call that could pass it, also when
calls run at the same moment, and a try whose answer was lost counts as spent. A run that hits the cap saves what it found
and stops cleanly, and the next run goes on.

**Resuming:** the keyword cursor only moves past a keyword whose searches all answered and whose advertisers were all looked
at. A failed search ends the run's keywords there, so that keyword is searched again next run. Why a run stopped is in its
status, shown on the tab:
- `done`;
- `cap` (the plan: it goes on next run);
- `time`;
- `search` (a search failed);
- `outage` (the vendor failed 3 calls in a row);
- `no-credits` (402: buy credits);
- `key` (401).

**Cost per run** (the $47 pack, $1.88 per 1,000 credits):

| Run | Credits | Cost |
|---|---|---|
| The sample run in the tests (2 keywords × 2 regions, 7 advertisers/domains, 6 ads read) | 16–17 | $0.03 |
| Default cap | ≤ 300 | ≤ $0.56 (≤ $0.30 at the $497 pack) |
| Daily schedule at the default cap | ≤ 9,000 a month | ≤ $17 a month |

Roughly: 1 credit a keyword per region, plus 2–6 credits per advertiser that passes the 75+ gate. A run of 300 credits covers
about 10–25 keywords in 3 regions, depending on how many big advertisers they find.

## Turning it on

1. Get an API key at [app.scrapecreators.com](https://app.scrapecreators.com) and buy credits (the $47 pack is plenty).
2. Add the GitHub secret **`SCRAPECREATORS_API_KEY`**: Settings → Secrets and variables → Actions → New repository secret.
   `CF_API_TOKEN` (or `CF_D1_TOKEN`) and `CF_ACCOUNT_ID` are already there for the other hunts. `TYPESAFE_API_KEY` is
   optional (Jev's answers).
3. Merge this PR. A workflow only appears under Actions from the main branch. Deploying the board makes the tables
   (`0021_google_ads.sql`) and puts the Google tab online.
4. **First a dry run:** Actions → **Google Hunter** → Run workflow, tick **Dry run**, credits **50**. The summary lists the
   products with their rule marks. A dry run only reads D1: it does not even make the tables, and saves nothing.
5. Then a real run (no tick). The products show under **Google** on the board.
6. **Optional schedule:** add the repository *variable* **`GOOGLE_HUNT` = `on`** (Settings → Secrets and variables →
   Actions → Variables). It then runs every day at 04:41 UTC. Without it, or with any other value, the schedule stays off.
   Also optional: `GOOGLE_CREDITS` (the daily cap) and `GOOGLE_REGIONS` (e.g. `NL,DE,FR,BE`).

To turn it off again: delete the variable `GOOGLE_HUNT`, or set it to `off`.

### Settings

| Setting | Default | What |
|---|---|---|
| `GOOGLE_CREDITS` | 300 | Hard cap of credits per run (1–5,000) |
| `GOOGLE_DRY_RUN` | off | `1`: search and check, save nothing, print the products |
| `GOOGLE_REGIONS` | NL,DE,FR | Regions of the advertiser search (each keyword costs 1 credit per region) |
| `GOOGLE_KEYWORDS` | – | Only these keywords (`a \| b`); the cursor stays |
| `GOOGLE_DOMAINS` | – | Also these shops or advertiser ids (`store.com \| AR0123…`) |
| `GOOGLE_BOARD_DOMAINS` | 10 | Shops from the other tabs per run (0: none) |
| `GOOGLE_DETAILS` | 4 | Ads read per advertiser |
| `GOOGLE_PAGES` | 2 | Pages of ads per advertiser |
| `GOOGLE_MINUTES` | 60 | Time budget (at most 120) |

Without a key you can still see a run: `node winner-hunter/google.mjs --fixtures` runs on the SAMPLE DATA of the tests (no
key, no credits, nothing saved, and every line says SAMPLE DATA).

## Data

| D1 | What |
|---|---|
| `google_products` | The board's Google tab: one row per product page, with its rules (`rules`: JSON with `state` and `how` per rule), verdict, countries, formats, dates, impressions range and Google ids. `ad_id` (`g` + the creative id) never changes, so decisions stay with the product. |
| `google_ads` | Ads whose details were read (not paid for again within a week) |
| `google_targets` | Advertisers and domains looked at (not again within 3 days) |
| `google_stores` | The Shopify check per store (14 days) |
| state `google_run` | The last run: credits spent, products, health. Shown on the tab, red when it failed. |
| state `google_cursor` | The next keyword |
| state `google_data` | Changes when the board's table changed: the board reads its tables again |

The migration only adds tables (`CREATE TABLE IF NOT EXISTS`) and is safe to run again and again. A product goes off the
tab (`active` 0) when its ad is older than 42 days today, when it was not checked for 30 days, or when a check fails a rule.
That also takes it out of the store signals. Your ✓ and notes stay. Rows nobody decided on and not seen for 60 days are removed.

**Links on the board** are made from checked ids (AR… / CR…), never copied from an answer:

- ▶ and a tap on the card open the ad: `adstransparency.google.com/advertiser/<AR>/creative/<CR>`.
- **Advertiser ↗** opens the advertiser's page: `adstransparency.google.com/advertiser/<AR>`.

## Verify on the first live run

The documentation leaves these open. The hunt keeps what it needs to answer them: `google_targets.estimate`, and the
`rules` text of each product.

1. **Does `number_of_ads_estimate` follow `start_date` / `end_date`?** The rule assumes it counts the ads shown in the last
   3 days. If it turns out to count all ads ever, rule 2 is looser than intended. Then the count of the pages read is the
   better fact (raise `GOOGLE_PAGES`).
2. **Are impression ranges published for ordinary (non-political) ads shown in the EU?** Only EU ranges can pass rule 4.
   If Google never publishes them for these ads, rule 4 is "not checked" on every card, and the proof decides.
3. **Is `destinationUrl` a domain or a full link?** The vendor's example shows a domain. A link to a product page skips the
   store search.
4. **How large is a page of ads?** Example: 15. More per page means fewer credits per advertiser.
5. **Advertiser search per region:** does `number_of_ads_estimate` there count that region only? The hunt uses it as a free
   first gate (under 75: skipped).

## Sample data

`winner-hunter/test/fixtures/google/`:

- `vendor-*.json` are the vendor's own documented example answers, copied verbatim. They are real data the vendor published,
  used only to test the parsing.
- `sample.json` is **SAMPLE DATA**, made up for the hunt tests. It has no real advertiser or shop: domains end in
  `.example`, ids are `AR1000…` / `CR1000…`, and every advertiser name starts with "SAMPLE".
