# Learnings: 2026-11-01 audit and research sessions

What the Winner Hunter audit, fix and research sessions on **1 November 2026** found, what got merged, and what is left. Written for Connor (the owner) and for future Claude sessions that pick up the work.

## Summary

On 1 November 2026, five read-only audits (hunt code, board, ops, data, tests) went through Winner Hunter and produced 57 ranked findings, 7 of them High. The data audit also reviewed the 36 approved products: 21 of them are in a restricted category or need the buyer to pick a size. Behind this were two pipeline gaps: the EU tab had no category screen, and every approval taught the Inbox its search keyword. By the end of the day, [#25] (CI/CD and ops safety), [#27] (hunt pipeline fixes) and [#26] (a new 🚀 Launch view) were merged. [#28] (board fixes, including the High PIN-lockout finding) was still open. Three research sessions covered AI and data upgrades, new data sources, and EU sourcing and shipping. The AI research ranks a decision log, a landed-cost and break-even gate, and a compliance badge as the best upgrades for the effort. Both the AI and the data-source research put Trustpilot scraping at the top of the terms-of-service risks. The sourcing research's 7-day plan, from approved product to first shipped order, takes 10–14 days in practice around Singles' Day.

## Files

| File | What's in it |
|---|---|
| [audit-findings.md](audit-findings.md) | All 57 findings by area (code, board, ops, data, tests): severity, file refs, suggested fix, and which PR fixed it |
| [approved-products-review.md](approved-products-review.md) | What was wrong with the 36 approved products, product by product, and why the pipeline let them through |
| [ai-and-data-upgrades.md](ai-and-data-upgrades.md) | LLM research: top 10 upgrades by impact for the effort, build order, costs, risks |
| [data-sources.md](data-sources.md) | Data-source research: roadmap, terms-of-service risks, weak signals, payment and compliance risks |
| [sourcing-and-shipping.md](sourcing-and-shipping.md) | Suppliers, EU customs/VAT and compliance checks, the 7-day plan, questions for suppliers |
| [next-steps.md](next-steps.md) | Ranked backlog (today / this week / later) and open questions for Connor |

## Changelog: 2026-11-01

| Merged (UTC) | PR | Tests in the PR |
|---|---|---|
| 12:50 | [#25] CI/CD and ops: safe previews, tested deploys, guarded hunts outside the EU | 168/168, 0 skipped |
| 12:53 | [#27] Hunt pipeline: 11 audit fixes | 170/170, 0 skipped |
| 12:57 | [#26] Board: 🚀 Launch view, launch card, checklist and go/no-go | 165/165, 0 skipped |
| open | [#28] Board: fix the audit findings | 171 pass in the description; 223 pass, 0 fail, 0 skipped on its latest commit (88dfc23) |

### [#25] CI/CD and ops safety (merged)
- Previews only upload a test version: no migrations, hunt or store signals against the live D1. Only `winner-hunter/worker/**` and the workflow itself trigger them.
- `world.mjs` uses the run id as a fencing token, so two overlapping runs can no longer empty the board, and rows that are already inactive aren't rewritten.
- A failed `wrangler deploy` now goes red (`set -o pipefail`, and the step fails when no `workers.dev` address is printed).
- New `tests.yml` runs `npm test` on every pull request. Deploy `needs: test`, and a skipped test fails the step. Actions are pinned to commit SHAs.
- The hunts use `CF_D1_TOKEN` when it exists. `migrate.mjs` records a D1 Time Travel bookmark before migrating (README: "Undo a migration").
- The board cache is keyed on a new `world_data` state: two table reads per run instead of a re-read after every progress save.
- `WORLD_MINUTES` is capped at 135 (the job timeout is 180). A Shopify 429 storm now turns the run yellow.
- The deploy no longer puts `META_TOKEN` into the Worker. `/api/ad/:id` returns 404 unless `AD_VIEWER = "on"`. Logs hide the `workers.dev` subdomain.

### [#27] Hunt pipeline fixes (merged)
- The EU product match uses `sameThing()`. Re-checks update saved winners (UPDATE only).
- Store checks reuse `checkStore`: they try `www.`, treat 403/5xx as no answer, mark an unknown store pending, and hold the cursor once.
- Meta errors turn the run yellow, or red when no competitor was counted. Rate-limit codes are checked before `is_transient`.
- A best-seller timeout keeps the old rank. The token state is merged per token. TikTok ids must be strings.
- New EU category screen `screenEU()`. 70 clothing, beauty, pain and sale-angle keywords moved to `keywords-optin.txt`.
- The test fakes now answer in pages and for every age window, the fake D1 enforces the 100-parameter limit, and the hunt takes its own clock. Records get an `active_ads_capped` flag.

### [#26] 🚀 Launch view (merged)
- Pick an approved product and get a launch card: margin per order, break-even ROAS, how long its ads run, store size, risk flags, **Go / No go**.
- Under it, a 7-step checklist: sourcing, margin, compliance, competitors and ads, store, creatives, launch. 📌 Pin marks the one product being launched.
- New table `launches` (migration `0015_launch.sql`, with a partial unique index for the pin). The logic lives in `worker/src/launch.mjs` (`launchKit()`), and the browser runs the same code via `/launch.js`.
- Before the build, the "feature" session wrote the spec and checked it on a prototype. The baseline was 151/151 with e2e. The migration was idempotent, and the index refused a second pin. The worked margin example was checked. All 8 proposed tests passed, and the only existing assertion it broke was the table list in `test/d1.test.mjs:105`. A launch e2e passed at iPhone size.

### [#28] Board audit fixes (open, not merged)
- PIN tries are counted atomically (`pin_tries` table, migration `0014_pin_tries.sql`), per /64 and per network. Login fails closed on D1 errors. The cookie is keyed by a server key plus the PIN.
- The ad age comes from `ad_start_date`, the measured age must be 7+, and cards show when the figures were measured.
- Jev risks lower the Inbox rank. EU products people or pets take leave the Inbox.
- Learning is by Jev category. "Too expensive" has one limit per currency (`0015_feedback_currency.sql`).
- The best-seller boost is relative to store size, and products are grouped by product page. New tags: "Product not identified" and "Big catalogue". Smaller bugs fixed.
- A later commit (88dfc23) makes [#26]'s launch cards follow the product-page grouping. New EU cards are keyed `eu|<store.com/products/handle>`. Cards saved under the old advertiser + title key are still found, and no rows are rewritten (no migration).
- After it merges, every phone logs in once more.

Earlier on 2026-11-01, #17–#24 were also merged (among them the D1 read fixes #20–#21 and the TikTok tab #23–#24). They came before the audit fixes and aren't covered here.

## Sessions behind these notes

| Session | What it did | Led to |
|---|---|---|
| code | Read-only audit of the hunt pipeline | 10 findings, 9 fixed in [#27], 1 in [#28] |
| board | Read-only audit of the board Worker and UI | 10 findings, all in [#28]; `/api/ad` gated in [#25] |
| ops | Read-only audit of CI/CD, workflows and D1 cost | 11 findings, fixed or partly fixed in [#25]; one in [#27] |
| data | Review of the 36 approved products and the pipeline behind them | 12 findings: [#27], [#28], owner actions |
| tests | Read-only audit of the test suite, fakes and ranking | 14 findings: [#25], [#27], [#28]; 2 open |
| feature | Spec and prototype for the launch view | Built in [#26] |
| research-llm | AI and data upgrades | Report; no PR |
| datasources2 | Data sources | Report; no PR (changed nothing, no calls to the live board) |
| research-sourcing | EU sourcing and shipping | Report; no PR |

## Reading these notes

- **Not captured.** The terminal captures were cut off at the top, so the start of each session is missing. The full reports stayed in each session's scratchpad and weren't committed.
- **Fix status** comes from the descriptions of #25–#28, because the session logs don't say which PR fixed what. A few still-open items were spot-checked on `main` on 2026-11-01.
- **File refs** are relative to the app folder `winner-hunter/`. Workflows are in `.github/workflows/`. Line numbers are from the code as audited (before #25–#28), so they will drift.
- **Products** from the approvals review are written P1, P2, … (the review's own numbers), so they don't clash with PR numbers.

## Terms

| Term | Meaning |
|---|---|
| EU tab | Products from the EU Meta Ad Library hunt (`run.mjs`, `lib/meta.mjs`) |
| Outside-EU tab (🌍, "world") | Products from the hunt in markets outside the EU (`world.mjs`) |
| TikTok tab | Imported TikTok products (`tiktok-import.mjs`) |
| Inbox | Undecided products, one at a time, best first: ✗ Reject or ✓ Approved, then a "Why?" reason |
| 🧠 | What the board learned from your decisions (D1 table `feedback`) |
| Jev | The classifier `world-check.mjs` asks about each new product (TypeSafe, per the README). It answers with a category and trait scores such as people, animals, sizing, medical |
| rpd | Reach per day, the Inbox's base sort |
| Hard rules (EU) | Shopify store, 75+ active ads, ad live 7–42 days, 500+ reach per day (`lib/score.mjs`) |
| D1 | Cloudflare D1, the database. The board is a Cloudflare Worker behind a PIN |

[#25]: https://github.com/hopmanecommerce-png/winner-hunter/pull/25
[#26]: https://github.com/hopmanecommerce-png/winner-hunter/pull/26
[#27]: https://github.com/hopmanecommerce-png/winner-hunter/pull/27
[#28]: https://github.com/hopmanecommerce-png/winner-hunter/pull/28
