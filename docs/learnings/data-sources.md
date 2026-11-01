# Data sources (research, 2026-11-01)

This research session looked at which data sources to add. It changed, committed and pushed nothing, and made no calls to the live board. The capture starts at the roadmap's "This week" list, and everything before that list wasn't captured.

## Roadmap

### This week

| Item | Note |
|---|---|
| The CJ API for cost and shipping | CJ's search by image needs a Level 3 account (Q3) |
| Photo matching | Gives `n_stores` and exact TikTok ↔ Meta matches |
| The extra Meta fields and ad survival | The LLM research also lists "the free Meta API fields" (~1 h) |
| Daily price and sold-count history | The LLM research plans a `world_trend` history table |
| SerpApi Lens and trend lookups for shortlisted products | About 1,000 calls a month, $25–75 (Q5) |
| The extra Jev questions and an EUIPO API key | |
| The launches table and form | [#26] added a `launches` table and a launch card on 2026-11-01 |
| Stop scraping Trustpilot pages | The highest terms-of-service risk below (Q7) |

### Later
- Merchant Center best sellers (Q6).
- Store tech across every store.
- Keepa, for products Amazon prices against.
- Google Ads Transparency.
- YouTube Shorts.
- The TikTok Commercial Content API, if you qualify.
- Tuning the weights after 30 or more launches.

## Risks

### Terms of service, highest exposure first

| | Source | Risk |
|---|---|---|
| a | Trustpilot page scraping | The terms ban it outright |
| b | The TikTok scraper | Especially if it runs logged in |
| c | Logged-out Meta Ad Library scraping | Favourable US case law, but Meta can still block you, and EU rules may differ (unverified) |
| d | Shopify public JSON | Public data; just respect rate limits |
| e | Vendor APIs (SerpApi, DataForSEO) | The scraping risk sits with the vendor |

The LLM research rated what the board collects today separately: Trustpilot high, Shopify best-seller calls medium-high, logged-out Ad Library medium ([ai-and-data-upgrades.md](ai-and-data-upgrades.md#risks-and-open-questions-from-the-research)).

### Late entry
Products with the most proof are often already crowded. Momentum, crowding and the price check are there to balance that.

### Single signals are weak
- Ad age alone means little, because advertisers often leave ads switched on.
- Sales-value estimates from tools can be far off.
- TikTok sold counts can mix countries.
- Meta publishes reach only for the EU and UK, and never spend for shop ads.

### Payments
- Visa's 1.5% limit on fraud plus disputes.
- Shopify holding back part of your payouts.
- Frozen funds from Schedule A lawsuits.

### Compliance
- The EU responsible-person rule.
- VAT or GST inside the margin.
- The rules per market already in `worker/src/market-rules.mjs`.

## Open questions

This session asked Connor seven questions. They are Q1–Q7 in [next-steps.md](next-steps.md#open-questions-for-connor).

[#26]: https://github.com/hopmanecommerce-png/winner-hunter/pull/26
