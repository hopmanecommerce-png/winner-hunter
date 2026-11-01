# AI and data upgrades (LLM research, 2026-11-01)

This research session looked at where LLMs and new data would improve Winner Hunter most for the effort. Its output was a report; no PR came from it. The capture starts at the end of section 3, so sections 1–3 are missing. The full report (`reports/Winner Hunter AI and data upgrades.md` and `research_notes/`) stayed in that session's scratchpad and wasn't committed.

One cost line survived from section 3: **about $0.4–1.5 a month at 1,000 products on Haiku 5.5 batches**. Which item it belongs to wasn't captured.

## Top 10 by impact for the effort

| Rank | Upgrade | Effort | Running cost | After today's PRs |
|---|---|---|---|---|
| 1 | Decision log with a soft Undo | ~2 h | $0 | Not in #25–#28 |
| 2 | Landed-cost and break-even-ROAS gate | ~2 h | not captured | No gate yet. [#26]'s 🚀 launch card works out break-even ROAS and max CPA from numbers you type in |
| 3 | Block / Docs / OK compliance badge from Jev's traits plus an EN/NL/DE keyword list | ~2 h; ~1 day with Safety Gate and EUIPO | not captured | No badge yet. [#28] (open) adds red tags for Hard to ship, Medical claim, Cosmetics |
| 4 | Supplier match and automatic cost: 1688 image search, Haiku check, CJ freight | 1–2 days | $6–20/month | Not in #25–#28 |
| 5 | Daily history table and the "still running" label | half a day | not captured | Not in #25–#28 |
| 6 | The free Meta API fields | ~1 h | free | Not in #25–#28 |
| 7 | AI extraction layer `ai-check.mjs`, running hidden | 1–2 days | under $5/month | Not in #25–#28 |
| 8 | Review complaint mining on the shortlist, replacing Trustpilot scraping | ~1 day | ~$45/month | Not in #25–#28 |
| 9 | Trend veto and Amazon demand check | half a day each | not captured | Not in #25–#28 |
| 10 | TikTok EU ad data and automatic TikTok Shop counts | not captured | not captured | Not in #25–#28 |

## Build order (from the research)

### Today (each under 2 hours)
- A `decision_context` table that stores the card's facts, position and ranker. Undo sets `undone_at` instead of deleting.
  - The research named it migration 0014, but 0014 and 0015 are already taken: `0014_tiktok_more` and `0015_launch` on `main`, plus `0014_pin_tries` and `0015_feedback_currency` in #28. `migrate.mjs` runs every `.sql` file in name order, so use 0016 or later.
- A read-only count of your decisions and your approval rate.
- `lib/landed.mjs` with a test, and a break-even line on the card. Related: [#26] already has margin helpers in `worker/src/launch.mjs`.
- `worker/src/eu-rules.mjs` for the compliance badge.
- Jev thresholds at 0.7 / 0.3, with "unsure" in between.
- The Meta fields in `lib/meta.mjs` and at `world.mjs:287`.
- Applications for TikTok's ad API, the EUIPO API and a CJ key, plus an Anthropic spend limit.
- Connor hand-checks 50 products against Jev's factual traits.

### This week
- `ai-check.mjs` with `lib/ai-schema.mjs`, a validator and injection tests, running hidden.
- The `world_trend` history table.
- The supplier pipeline.
- A weekly Safety Gate import and EUIPO trademark check.
- Review themes.
- A weekly `ai-eval.mjs` scoring job.
- The trend veto.
- Jev vs Clef on the 209-product set already used to test Jev.

## Risks and open questions (from the research)

- **Labels.** Connor's decision count and approval rate are unknown (the session didn't query D1). They decide whether validation takes weeks or months. An approval is a proxy, not proof of a winner.
- **Legal exposure of what the board collects today:**

  | What | Risk | Why (as captured) |
  |---|---|---|
  | Trustpilot scraping past its bot check | High | Trustpilot's terms of 1 Oct 2026 ban it, and reviewer names are personal data |
  | Shopify best-seller calls | Medium-high | not captured |
  | Logged-out Ad Library scraping | Medium | not captured |

- **Connor's obligations.** Under the EU product safety regulation, Connor is the importer of the 1688 goods. The new Product Liability Directive applies to products sold after 9 Dec 2026. No model can check a certificate.
- **Gaps.** Landed cost for the non-EU markets the World hunt targets wasn't researched. CJ's quota for an account with no CJ spend is unknown. The official 1688 API likely needs a Chinese business licence.
- **Weaker sources.** A few papers are marked as not re-verified, and Clef's and Motion's figures are vendor data.

## Related proposals from the audits

- **Jev risk factor in the Inbox** (tests proposal (b)): built in [#28] (open).
- **Learn by Jev category instead of search keyword** (data gap G2): built in [#28] (open).
- **Rank by product traction, not advertiser size** (tests finding 7): open. Suggested: a product-ads rule as an alternative, age-weighted ranking, and a competitor count.

[#26]: https://github.com/hopmanecommerce-png/winner-hunter/pull/26
[#28]: https://github.com/hopmanecommerce-png/winner-hunter/pull/28
