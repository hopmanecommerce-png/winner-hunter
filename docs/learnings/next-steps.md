# Next steps (as of 2026-11-01)

A ranked backlog built from the audit findings, the "left out" lists in the PRs, and the research sessions' build orders. **Ranking:** the open High-severity risk first, then cleaning up the data the board learns from and starting a launch, then the research sessions' own impact-for-effort order, then small follow-ups. Effort and cost figures are the sessions' estimates.

**Sources:** [audit] [audit-findings.md](audit-findings.md) · [products] [approved-products-review.md](approved-products-review.md) · [LLM] [ai-and-data-upgrades.md](ai-and-data-upgrades.md) · [data sources] [data-sources.md](data-sources.md) · [sourcing] [sourcing-and-shipping.md](sourcing-and-shipping.md) · a PR number means that PR's description.

## Today

1. **Review and merge [#28].** It holds the fixes for 21 findings, including the High PIN-lockout bypass, which stays live until #28 is merged. After merging:
   - every phone logs in once more;
   - use a PIN of 6+ digits (8+ is better);
   - if old preview versions of the board are still reachable, delete them in Cloudflare (they may still serve the old code against the live D1, and the old code accepts PIN-only cookies);
   - its two migrations run before the deploy; don't deploy this Worker by hand without them. [#28]
2. **Clean up the approvals.** Reject the 9 restricted products, reject or park the 12 that need sizing, and re-check the 6 that now fail the 7–42-day rule. [products]
3. **Pick the first product and start D0 of the 7-day plan**, using the 🚀 Launch view from [#26] for the checklist. Needs Q1. [sourcing]
4. **Apply for TikTok's ad API, the EUIPO API and a CJ key, and set an Anthropic spend limit.** [LLM]
5. **Owner clean-up from [#25]:** delete the old `META_TOKEN` Worker secret (unused since the route was gated); create a D1-only `CF_D1_TOKEN`, so the hunts don't hold a token that can deploy the Worker; delete old Actions run logs that show the board address. [#25]
6. **Decision log with a soft Undo** (a `decision_context` table, where Undo sets `undone_at`) **plus a read-only count of decisions and approval rate.** LLM #1: ~2 h, $0. The count answers Q8. Use migration number 0016 or later (0014 and 0015 are taken). [LLM]
7. **Landed cost:** `lib/landed.mjs` with a test, and a break-even line on the board card. LLM #2: ~2 h. [#26]'s margin helpers in `worker/src/launch.mjs` cover similar maths. [LLM]
8. **Compliance badge** (Block / Docs / OK) in `worker/src/eu-rules.mjs`, from Jev's traits plus an EN/NL/DE keyword list. LLM #3: ~2 h, or ~1 day with Safety Gate and EUIPO. [LLM]
9. **The free Meta API fields** in `lib/meta.mjs` and at `world.mjs:287`. LLM #6: ~1 h. [LLM]
10. **Jev thresholds at 0.7 / 0.3 with "unsure" in between**, and Connor hand-checks 50 products against Jev's factual traits. [LLM]
11. **Wire the opt-in keywords:** add `KEYWORDS_OPTIN: ${{ vars.HUNT_KEYWORDS_OPTIN }}` to the env of `winner-hunter.yml`. Until then, opt-in keywords can be typed into the workflow's keywords box. [#27]
12. **Show "500+" on the board:** read `d.active_ads_capped` in `toAd`. These are the same files as #28, so do it after #28 merges. [#27; audit: data 11]

## This week

1. **Stop scraping Trustpilot pages**, and replace them with review complaint mining on the shortlist (LLM #8: ~1 day, ~$45/month). Both research sessions rank Trustpilot scraping as the highest terms-of-service risk. Needs Q7. Data finding 12 (Trustpilot root domain) only matters if the scraping stays. [data sources; LLM]
2. **Supplier pipeline:** the CJ API for cost and shipping; 1688 image search, a Haiku check and CJ freight (LLM #4: 1–2 days, $6–20/month). Needs Q3. [LLM; data sources]
3. **History:** the `world_trend` table, daily price and sold-count history, and the "still running" label (LLM #5: half a day). [LLM; data sources]
4. **AI layer:** `ai-check.mjs` with `lib/ai-schema.mjs`, a validator and injection tests, running hidden (LLM #7: 1–2 days, under $5/month); then a weekly `ai-eval.mjs` scoring job. [LLM]
5. **Compliance data:** a weekly Safety Gate import and EUIPO trademark check; the extra Jev questions and an EUIPO API key. [LLM; data sources]
6. **Photo matching** for `n_stores` and exact TikTok ↔ Meta matches. [data sources]
7. **The extra Meta fields and ad survival.** [data sources]
8. **Trends:** SerpApi Lens and trend lookups for shortlisted products (~1,000 calls a month, $25–75; needs Q5), and the trend veto (LLM #9: half a day). [data sources; LLM]
9. **Jev vs Clef** on the 209-product set already used to test Jev. [LLM]
10. **Launches table and form:** check what [#26] already covers before building more. [data sources]
11. **Small open audit items:** the README still describes ★ Keep, and `test/worker.test.mjs` still tests it (board note, tests 12); the TikTok list's `LIMIT 5000` (board note; #24 listed 2,435 products); the discount worked out against the highest compare-at price (tests 14). [audit]

## Later

1. **Rank by product traction, not advertiser size:** a product-ads rule as an alternative, age-weighted ranking, a competitor count. [audit: tests 7]
2. **Tune the weights after 30 or more launches.** [data sources]
3. **Merchant Center best sellers** (needs Q6). [data sources]
4. **TikTok:** EU ad data and automatic TikTok Shop counts (LLM #10); the Commercial Content API, if you qualify. [LLM; data sources]
5. **Amazon:** the demand check (LLM #9: half a day); Keepa for products Amazon prices against. [LLM; data sources]
6. **More sources:** Google Ads Transparency, YouTube Shorts, store tech across every store. [data sources]
7. **Landed cost for the non-EU markets** the World hunt targets (not researched yet). [LLM]
8. **Infrastructure:**
   - A separate preview D1 (only Connor can create it; see Q12). [#25]
   - wrangler as a lockfile-managed devDependency instead of `npx wrangler@4`. [#25]
   - checkout and setup-node on their Node 24 majors (the pinned v4.4.0 commits target the deprecated Node 20). [#25]
   - About 7 linear scans of `world_ads` per run, which grow with the table. [audit: ops]
   - The SQL views (`PREFETCH_SQL`, Jev's `EU_TODO_SQL`) still group by advertiser + title; changing the SQL key needs `world-check.mjs` changes too. [#28]
   - A saved winner whose store left Shopify can't be dropped until the board reads `verdict`. [#27]
   - Remove the gated `/api/ad/:id` route and its Browser Run binding. [audit: board note]

## Open questions for Connor

| # | Question | Unblocks | From |
|---|---|---|---|
| Q1 | Which market do you launch in today? | Today #3 | data sources |
| Q2 | What exactly does your scraper output? Per-video posting dates, comment text, sold counts per market (UK and the EU countries)? Is it logged in? | Terms-of-service risk (b); the TikTok items | data sources |
| Q3 | Which supplier route will you use? CJ's search by image needs a Level 3 account. | This week #2 | data sources |
| Q4 | What are your price range and maximum cost per sale? What counts as a winning test for you, for example how much spend and which ROAS? | Landed-cost and break-even thresholds | data sources |
| Q5 | Are you OK paying $25–75 a month for SerpApi? | This week #8 | data sources |
| Q6 | Do you have a Google Merchant Center account? | Later #3 | data sources |
| Q7 | Can the code stop scraping Trustpilot pages? | This week #1 | data sources |
| Q8 | How many decisions are in D1, and what is your approval rate? | Whether validating the AI layer takes weeks or months | LLM |
| Q9 | Once #28 moves learning to Jev categories, do you still want to undo the accidental-keyword approvals (P27, P28, P29, P33, P34 and 3 lingerie items) and reject them with "Not my niche"? | Today #2 | products; #28 |
| Q10 | Should EU products that people or pets take also leave Browse? #28 keeps them there, with their tag. | — | #28 |
| Q11 | Do you sell only in €? The launch card works in € (VAT 21% and fees 3% by default) and has no currency picker. | Launch view | #26 |
| Q12 | Do you want a separate preview D1? Previews still bind the live D1 for the board's own buttons. | Later #8 | #25 |

## Known unknowns

- The code audit took D1's limits from memory and didn't re-check them online.
- Whether EU rules on logged-out Ad Library scraping differ (unverified).
- [#25]'s deploy and migrate paths weren't run against real Cloudflare (no credentials in that session).
- Whether old preview versions are still reachable and serving old code ([#28], not verified).
- Landed cost for the non-EU markets; CJ's quota for an account with no CJ spend; whether the official 1688 API needs a Chinese business licence.
- A few papers in the LLM research weren't re-verified, and Clef's and Motion's figures are vendor data.
- Everything marked "not captured" in these notes.

[#25]: https://github.com/hopmanecommerce-png/winner-hunter/pull/25
[#26]: https://github.com/hopmanecommerce-png/winner-hunter/pull/26
[#27]: https://github.com/hopmanecommerce-png/winner-hunter/pull/27
[#28]: https://github.com/hopmanecommerce-png/winner-hunter/pull/28
