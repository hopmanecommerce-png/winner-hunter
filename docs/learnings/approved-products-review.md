# Approved products review (2026-11-01)

The data audit went through an export of the **36 products Connor had approved** on the board. 30 of them came from the EU tab; where the other 6 came from wasn't captured. Products are written P1, P2, … using the export's own numbers (the session wrote #1, #2, …).

## Headline

- **21 of the 36** are in a restricted category (9) or need the buyer to pick a size (12). The two lists don't overlap.
- **At least 26 of the 36** appear in at least one finding. The lists of unidentified products (17) and stale snapshots (8) weren't captured, so the real number may be higher.
- **All 9 restricted approvals came from the EU tab**, which had no category screen.

## Problems by type

| Problem | Products | Count | The review's advice | Board change since |
|---|---|---|---|---|
| Restricted category: supplement, food, pet health, perfume, essential oils, hair and skin cosmetics, health-claim device | P10, P13, P17, P20, P24, P26, P28, P29, P33 | 9 | Reject them | [#27] screens the EU path; [#28] (open) keeps people/animals ≥ 0.5 out of the EU Inbox |
| Buyer must pick a size | P3, P7, P8, P9, P12, P14, P16, P19, P21, P27, P30, P35 | 12 | Reject or park | [#28] (open) ranks sizing ×0.5 in the Inbox |
| Same product approved twice (a jacket: same `valkental.myshopify.com` store and product path) | P16, P35 | 1 pair | Group by myshopify domain plus handle | [#28] (open) groups by product page |
| Product not identified: no product, price or rank, and the title is ad copy | 17 of the 30 EU approvals (list not captured) | 17 | Flag "product not identified" | [#28] (open) adds the tag |
| Wrong product matched | P23 (the ad copy doesn't match the product), P29 (an upsell page) | 2 | Use `sameThing()` | [#27] fixes the matching |
| Huge catalogue, only one ad for the product (stores with 302–2,389 products) | P1, P23, P32, P34 | 4 | Ask for 5+ copies or a top-50 rank when a store has 250+ products | [#28] (open) adds a "Big catalogue" tag |
| Measured at 5 days, yet passes and tops the reach sort (278,104 ÷ 55,621 = 5) | P32 | 1 | Require a measured age of 7+ | [#28] (open) |
| Now fails the 7–42-day rule | P9, P16, P22, P33, P34, P35 | 6 | Re-check them before use | — |
| Snapshot 2 weeks old (measured only on 2026-10-17) but shown as current; 5 of them still pass | 8 rows (list not captured) | 8 | Show when it was last measured | [#28] (open) shows the measured date |
| Shop-ad count capped at 500 but shown as exact | 13 rows (list not captured) | 13 | Show "500+" | [#27] stores the flag; the board doesn't show it yet |
| Trustpilot checked only on language subdomains | P9, P16, P35 | 3 | Also try the root domain | Open |
| Came in through an accidental keyword match | P28, P34 ("tas"); P27, P29 ("kleid"); P33 ("robe"); 3 lingerie items ("lingerie", not captured) | 8 | Undo them and reject with "Not my niche", or learn by Jev category | [#28] (open) learns by Jev category |

## Product by product

Only products named in a captured finding are listed. A product left out here can still be on one of the lists that weren't captured.

| Product | Issues |
|---|---|
| P1 | Huge catalogue, 1 ad |
| P3 | Sizing |
| P7 | Sizing |
| P8 | Sizing |
| P9 | Sizing · fails 7–42 days now · Trustpilot subdomain only |
| P10 | Restricted |
| P12 | Sizing |
| P13 | Restricted |
| P14 | Sizing |
| P16 (jacket) | Sizing · same product as P35 · fails 7–42 days now · Trustpilot subdomain only |
| P17 (Jev: animals) | Restricted |
| P19 | Sizing |
| P20 | Restricted |
| P21 | Sizing |
| P22 | Fails 7–42 days now |
| P23 | Wrong product matched · huge catalogue, 1 ad |
| P24 | Restricted |
| P26 | Restricted |
| P27 (bra) | Sizing · accidental keyword "kleid" |
| P28 (supplement; Jev: people) | Restricted · accidental keyword "tas" |
| P29 (coffee; Jev: people) | Restricted · wrong match (an upsell page) · accidental keyword "kleid" |
| P30 | Sizing |
| P32 | Measured at 5 days · huge catalogue, 1 ad |
| P33 (hair care) | Restricted · fails 7–42 days now · accidental keyword "robe" |
| P34 (egg cooker) | Huge catalogue, 1 ad · fails 7–42 days now · accidental keyword "tas" |
| P35 (jacket) | Sizing · same product as P16 · fails 7–42 days now · Trustpilot subdomain only |

## Why the pipeline let them through

### G1: the EU tab had no category screen (medium)
- The EU rules were only Shopify, 75+ ads, 7–42 days and 500+ reach (`score.mjs:2-4, :135-164`).
- The world tab at least dropped supplements, food, drink and gymwear by name (`lib/world.mjs:132-156`; for example 'mushroom coffee' at `:141`).
- Jev had already flagged P28 and P29 as people and P17 as animals, but Jev hid nothing (`README.md:13`).
- **Suggested:** hide EU rows with Jev people or animals ≥ 0.5 from the Inbox, and show skin, restricted or medical ≥ 0.5 as a red tag.
- **Since:** [#27] added `screenEU()` for supplements, food and drink, cosmetics, perfume, medical claims and pet health. It works from word lists, so some products slip through (Reject handles those); gymwear and pet food stay on the EU board. [#28] (open) keeps EU products that people or animals take (≥ 0.5) out of the Inbox, and gives Hard to ship, Medical claim and Cosmetics ≥ 0.5 a red tag.

### G2: approving taught the Inbox the search keyword (low)
- Every ✓ wrote the ad's search keyword to `feedback` (`app.mjs:941-943`). `tasteOf` counted it as a good vote (`app.mjs:412`) and weighted the keyword by (good + 1) ÷ (bad + 1), up to 3× (`app.mjs:419`). The Inbox sorted by rpd × that weight (`app.mjs:497-498`).
- Several keywords matched by accident: the supplement (P28) and the egg cooker (P34) came via "tas", the bra (P27) and the coffee (P29) via "kleid", the hair care (P33) via "robe", and three lingerie items via "lingerie". Leaving them approved pushes more of the same up the Inbox. The real weights also depend on rejections, which weren't in the export.
- **Suggested:** undo them and reject with "Not my niche", which counts double (`app.mjs:411`); or learn by Jev category instead of search keyword.
- **Since:** [#28] (open) learns by Jev's main category, and only "Not my niche" counts against a niche. A niche's weight is its approval rate relative to the overall rate, clamped to 0.3–3.

### Other causes

| Cause | Effect on the approvals | Status |
|---|---|---|
| The EU product match took the store search's first hit | P23 and P29 matched to the wrong page | Fixed [#27] |
| Age extrapolated from old snapshots; a measured age under 7 days allowed | 8 stale rows; P32 at 5 days topped the reach sort | [#28] (open) |
| Products identified by title | P16 and P35 approved separately | [#28] (open) |
| The 500 cap shown as an exact count | 13 rows at exactly 500 | Partly: [#27] stores the flag |

## What to do with the current approvals

From the review:
1. Reject the 9 restricted products.
2. Reject or park the 12 that need sizing.
3. Re-check the 6 that now fail the 7–42-day rule before using them.
4. P16 and P35 are the same jacket. Once [#28] merges they become one card, and the latest decision counts.
5. For the accidental-keyword approvals, the review advised undoing them and rejecting with "Not my niche". That advice was written for keyword learning, which [#28] replaces with Jev-category learning. See Q9 in [next-steps.md](next-steps.md#open-questions-for-connor).

[#27]: https://github.com/hopmanecommerce-png/winner-hunter/pull/27
[#28]: https://github.com/hopmanecommerce-png/winner-hunter/pull/28
