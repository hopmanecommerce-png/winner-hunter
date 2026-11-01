# Audit findings (2026-11-01)

Five read-only audits ran on 1 November 2026, and each ended with a ranked table of findings. This file has all 57 of them, by area, with their status after the day's PRs.

**Status** (taken from the descriptions of #25–#28):

| Label | Meaning |
|---|---|
| Fixed [#25] / Fixed [#27] | Merged on 2026-11-01 |
| [#28] (open) | Fix written, but #28 wasn't merged when this was written |
| Partly | Some of it landed; the note says what's left |
| Owner | Needs Connor, not code |
| Open | Not addressed by #25–#28 |

File refs are relative to `winner-hunter/`. `app.mjs` and `board.html` are in `worker/src/`, and workflows are in `.github/workflows/`. Line numbers are from the audited code and will drift.

## At a glance

| Area | Findings | High | Medium | Low | Fixed (merged) | In #28 (open) | Partly | Owner | Open |
|---|---|---|---|---|---|---|---|---|---|
| [Code](#code) | 10 | 0 | 5 | 5 | 9 | 1 | 0 | 0 | 0 |
| [Board](#board) | 10 | 1 | 5 | 4 | 0 | 10 | 0 | 0 | 0 |
| [Ops](#ops) | 11 | 2 | 3 | 6 | 9 | 0 | 2 | 0 | 0 |
| [Data](#data) | 12 | 1 | 7 | 4 | 1 | 5 | 4 | 1 | 1 |
| [Tests](#tests) | 14 | 3 | 7 | 4 | 4 | 5 | 3 | 0 | 2 |
| **Total** | **57** | **7** | **27** | **23** | **23** | **21** | **9** | **1** | **3** |

### Same issue, found by more than one audit

| Issue | Found as | Status |
|---|---|---|
| EU product match takes the store search's first hit | Code 1, Data 7, Tests 1 | Fixed [#27] |
| Saved winners not updated when a re-check fails; stale passes shown for up to 35 days | Code 4, Data 5, Tests 2 | Fixed [#27]; measured age shown in [#28] |
| Store errors (429/5xx/403/timeout) count as "not Shopify" | Code 2, Tests 4 | Fixed [#27] |
| Branch pushes hit the production D1; no test gate | Ops 1, Ops 4, Tests 3 | Fixed [#25] |
| PIN lockout bypassed | Board 1, Tests 5 | [#28] (open) |
| Token-check state overwritten by the other run | Code 8, Ops 9 | Fixed [#27] |
| No category gate on the EU path | Data 1, Tests 6 | Fixed [#27]; Inbox part in [#28] |
| Price learning mixes currencies | Board 5, Tests 8 | [#28] (open) |
| Product identified by title, so duplicates | Data 3, Tests 11 | [#28] (open) |
| Ad age wrong (one day short; 5-day measurements pass) | Code 6, Data 6 | [#28] (open) |
| Learning from search keywords; niche weight | Data 9, Tests 9 | [#28] (open) |
| `test/world.test.mjs:243` can't fail | Code 10, Tests 12 | Fixed [#27] |
| `/api/ad` live and `META_TOKEN` in the Worker | Board note, Ops 10 | Fixed [#25] (route gated) |

## Code

Mostly the hunt pipeline: `lib/meta.mjs` and `run.mjs` (EU hunt), `world.mjs`, best sellers, the TikTok import.

| # | Sev | Finding | Where | Suggested fix | Status |
|---|---|---|---|---|---|
| 1 | Medium | EU product lookup keeps the store search's first hit: wrong product on the card, and a second winner dropped as a duplicate | `lib/meta.mjs:252-254, 401-402` | Add the `sameThing` check from `lib/world.mjs:272` | Fixed [#27] |
| 2 | Medium | EU Shopify check treats a 429, or any answer from the bare domain, as "not Shopify"; `www.` is not tried | `lib/meta.mjs:222-239` | Reuse world's `checkStore`; unknown → pending plus a warning | Fixed [#27] |
| 3 | Medium | Failed Meta searches and counts are only logged; the run ends green with 0 winners | `lib/meta.mjs:291-294, 362-365`; `run.mjs:188-203` | Report skipped; red when no count succeeded | Fixed [#27]: yellow on Meta errors, red when no competitor was counted |
| 4 | Medium | Saved winners that fail a re-check are never updated; the board shows stale passes for up to 35 days | `lib/meta.mjs:400`; `run.mjs:151`; `worker/src/app.mjs:38-40` | Update existing rows with the fresh failing facts | Fixed [#27] (UPDATE-only re-check). Left: a winner whose store left Shopify can't be dropped this way; stopped ads still age out as before |
| 5 | Medium (conditional) | Rate-limit errors flagged `is_transient` are retried 4× and the page size is halved | `lib/meta.mjs:142-149` | Check rate-limit codes first | Fixed [#27] |
| 6 | Low | Board age can be one day short, so a 43-day ad passes | `worker/src/app.mjs:39, 345` | Compute age from `ad_start_date` | [#28] (open) |
| 7 | Low | One best-seller timeout wipes the rank for the rest of the day | `lib/bestsellers.mjs:62-65`; `bestsellers.mjs:112-139` | Treat timeout/5xx like a 429 | Fixed [#27]. A DNS failure or refused connection still counts as "no list" |
| 8 | Low | The world run overwrites the EU token check (`META_TOKEN_2/3`) | `world.mjs:356-363`; `run.mjs:113-116` | Separate keys, or merge per token | Fixed [#27] |
| 9 | Low | Numeric TikTok ids are rounded and two products merge into one | `lib/tiktok.mjs:21` | Require string ids, reject duplicates | Fixed [#27] |
| 10 | Low | A test assertion cannot fail for the stopped ad | `test/world.test.mjs:243` | Two separate `=== 0` assertions | Fixed [#27] |

Checked and found OK:
- **D1 limits.** Statements bind at most 2 parameters, and bound JSON is capped at 1.5 MB per chunk (`lib/d1.mjs:33-48`), under D1's 2 MB value limit. The auditor took D1's limits from memory and didn't re-check them online.
- **Cursors.** `run.mjs` saves a batch before it moves `keyword_cursor`, and searches cut-short batches again. `world.mjs` moves `world_cursor` back to the first refused keyword.
- **Upserts.** The winners upsert keeps the earliest `first_seen` and never lets older data overwrite newer.
- **Tests.** The 11 non-browser test files passed, 144/144 on Node 22.23. The browser tests weren't run, because the board page loads Google Fonts (an external request). Since [#25], CI runs every browser test and fails on a skipped one.
- Findings 1–9 each had a repro script (fake network, in-memory SQLite) in that session's scratchpad. They weren't committed.

## Board

The board Worker and UI (`worker/src/app.mjs`, `worker/src/board.html`). The capture cut off this table's fix column; [#28] describes the fixes it made.

| # | Sev | Finding | Where | Status |
|---|---|---|---|---|
| 1 | High | PIN lockout bypassed: race condition, exact-IP key, fails open on D1 errors | `app.mjs:850-874, :676` | [#28] (open) |
| 2 | Medium | Each wrong PIN scans all of `state`; about 3,200 requests use up D1's daily reads and take the board down | `app.mjs:869` | [#28] (open) |
| 3 | Medium | "Why?" reasons are saved to the note row when the note save commits last, and silently lost | `app.mjs:988-990`; `board.html:1347-1363` | [#28] (open) |
| 4 | Medium | Niche and price learning are never applied to the Outside-EU Inbox, though 🧠 says they are | `app.mjs:464, :473` | [#28] (open) |
| 5 | Medium | The "Too expensive" threshold mixes currencies and is shown in € | `app.mjs:417-428, :943`; `board.html:1498` | [#28] (open) |
| 6 | Medium | A brief D1 error on optional tables is cached as empty for up to 15 minutes (empty tab, 404 on approve) | `app.mjs:121, :101-115` | [#28] (open) |
| 7 | Low | The banner shows only the last of several problems | `board.html:1534`; `app.mjs:724, :733` | [#28] (open) |
| 8 | Low | The cookie is signed with a key from the PIN alone: offline PIN recovery, no way to revoke | `app.mjs:618-631, :1092` | [#28] (open) |
| 9 | Low | 🧠 uses only the newest 5,000 feedback rows; old store blocks can't be undone | `app.mjs:1051` vs `:377` | [#28] (open) |
| 10 | Low | Prototype keys pass `in`/bracket allow-lists (`?sort=__proto__` gives 500) | `app.mjs:995, :1059, :507` | [#28] (open) |

Smaller notes:

| Note | Where | Status |
|---|---|---|
| The README is out of date: it describes ★ Keep and a ★ list, but the board only has Reject and Approved, and deliberately keeps starred products in the Inbox | `README.md:19-20, :30`; `board.html:659-662`; `app.mjs:526`; `test/worker.test.mjs:252` | Open. The README still says ★ Keep on `main` and on #28's branch |
| `/api/ad/:id` is still deployed. It starts Browser Run and writes to D1 on a GET, though the board no longer uses it. The Lax cookie is sent on cross-site navigations, so a link clicked elsewhere can spend Browser Run minutes. Suggested: remove the route and the binding | `app.mjs:1128-1135`; `adview.mjs:293-321`; `wrangler.toml:25-26` | Partly: [#25] returns 404 unless `AD_VIEWER = "on"`; the route and binding are still there |
| The TikTok list stops at 5,000 rows (`LIMIT 5000`). Imports only add rows, so past 5,000 the tab count and "Approved & rejected" quietly stop at 5,000 | `worker/src/tiktok.mjs:8`; `board.html:1810` | Open. #24 listed 2,435 products, so there is headroom for now |

Checked and found OK:
- **Spreadsheet formula injection** (the opening of this item wasn't captured). Cells that aren't strings are numbers, or Jev answers limited to numbers and fixed option lists (`lib/jev.mjs:154-171`). No formula reaches a cell without the prefix. Covered by `test/worker.test.mjs:404-426`.
- **XSS and HTML injection.** Every dynamic value in `board.html` goes through `esc()` (`:704`) or `safe()` (`:705`, https:// only, escaped). The Trustpilot link is rebuilt from a validated domain (`:805-808`). `window.open` only gets URLs checked by `safe()` (`:1691`, `:1709`). The nonce-only CSP (`app.mjs:643`) is a second layer.
- **SQL injection.** All values are bound parameters. Dynamic SQL is built only from fixed fragments (`app.mjs:691, :930, :939, :1002`), and sorts come from fixed maps.
- **Inbox paging, counts and undo.** The Inbox reloads from offset 0 and skips products decided on the phone (`board.html:1607`); the server ignores the offset there (`app.mjs:495-499`). Counts use the same filters as the views (`app.mjs:530-542`). Undo waits for the decision to save (`board.html:1450, :1678-1682`). Each `/api/hide` is one D1 batch (`app.mjs:945`).
- **Re-hunts and migrations.** The winners upsert keeps the earliest `first_seen` (`lib/d1.mjs:24-28`). The world upsert keeps `ad_id` and `first_seen` (`world.mjs:64`). The TikTok import never writes `decision` (`lib/tiktok.mjs:8-11`). World `ad_id`s carry a `w` prefix (`lib/world.mjs:356`), so they can't collide with EU ids. The migrations are safe to re-run (`lib/d1.mjs:129-141`).

## Ops

CI/CD workflows, deploy safety and D1 cost.

| # | Sev | Finding | Where | Suggested fix | Status |
|---|---|---|---|---|---|
| 1 | High | Branch pushes run migrations, a hunt and best sellers against the production D1. A cancelled preview strands `world_run` (red banner after 3 hours). Overlapping runs can deactivate every product | `preview-board.yml:8-16, 23-24, 35, 43-69`; `world.mjs:99-104, 331-332` | Separate preview D1 or drop those steps; D1 lease; signal handler | Fixed [#25]: previews only upload a test version; the run id is a fencing token. Not done: a separate preview D1 (only Connor can create one) and a lease (the fencing token covers it) |
| 2 | High | A failed `wrangler deploy` ends green (no pipefail before `tee`), with the schema already migrated | `deploy-board.yml:57-63` | `set -o pipefail`; fail on an empty URL | Fixed [#25] |
| 3 | Medium | Unpinned `npx wrangler@4` runs with the account-wide Cloudflare token and every secret in its environment | `deploy-board.yml:26-33, 61, 72, 81`; `preview-board.yml:83` | Pin wrangler in the lockfile; scope secrets to steps; pin actions to SHAs; D1-only token for the hunts | Partly [#25]: actions pinned to SHAs; hunts use `CF_D1_TOKEN` when it exists. Left: wrangler isn't pinned (suggested later as a lockfile devDependency); Connor creates `CF_D1_TOKEN` |
| 4 | Medium | No workflow runs the tests; merges deploy straight to production | `.github/workflows/*`; `deploy-board.yml:7-13` | Test job; deploy `needs: test` | Fixed [#25]. A skipped test fails too |
| 5 | Medium | Every hunt progress write invalidates the board's five-table cache | `app.mjs:86-122`; `world.mjs:171-176` | Key the cache on a data version written at step 7 and at job end | Fixed [#25] (`world_data` state) |
| 6 | Low | World minutes can be up to 300 against a 180-minute job timeout | `world-hunter.yml:13, 37`; `world.mjs:374` | Cap at about 135 or raise the timeout | Fixed [#25] (capped at 135) |
| 7 | Low | The deactivate UPDATE rewrites every inactive row on every run | `world.mjs:332` | Add `active = 1 AND` | Fixed [#25] |
| 8 | Low | World health ignores Shopify rate-limit storms | `world.mjs:340-343`; `lib/world.mjs:194` | Health rule on stores and items answered | Fixed [#25]: yellow when Shopify still answers 429 to over half of 20+ store requests |
| 9 | Low | World runs overwrite the EU run's three-token expiry state; `run.mjs` doesn't clean whitespace from tokens | `world.mjs:355-366`; `run.mjs:112-116, 214` | Separate or merged keys; clean tokens once | Fixed [#27] |
| 10 | Low | `META_TOKEN` still in the Worker; `/api/ad` live; rotated tokens never reach the Worker | `deploy-board.yml:74-81`; `app.mjs:1128-1135` | Delete the secret or gate the route | Fixed [#25]: the deploy no longer sets it, and the route is gated. Owner: delete the old Worker secret |
| 11 | Low | Public repo: board URLs in public summaries; schedules switch off after 60 idle days | `deploy-board.yml:87-88`; `preview-board.yml:91-93` | Don't print the URLs; external staleness check | Partly [#25]: logs hide the subdomain; the 60-day pause is documented, not worked around. Owner: old run logs that show the address |

Other ops notes:
- **Deploy order is right.** Migrations run before deploy (`deploy-board.yml:50-51` before `:57-63`).
- **No rollback step.** The audit suggested recording a D1 Time Travel bookmark before migrating. Done in [#25]: `migrate.mjs` logs a "D1 restore point", and the README has "Undo a migration".
- **Bounded work.** At most 400 store-search guesses per run (`world.mjs:27`). No unbounded loops: `allRows` stops on a short page (`world.mjs:67-75`); `graph()` retries are bounded by attempts, `maxWaitMs` and the number of tokens (`meta.mjs:100-178`); every pool checks its deadline.
- **Migration 0012 holds up.** The title-lookup UPDATE uses `world_ads_store_title`, and the unlinked-ads query uses `world_ads_product`. `allRows` pages by rowid. `TODO_SQL` scans `world_ads` once per run, as commit `50b3918` (#20) intended. No per-row scans remain.
- **Still open.** About 7 linear scans of `world_ads` per run, which grow with the table.

## Data

The approved products and the pipeline gaps behind them. For product-by-product detail, the pipeline gaps G1 and G2, and what to do with the current approvals, see [approved-products-review.md](approved-products-review.md). C1–C7 are code changes the data session proposed; their full text wasn't captured.

| # | Sev | Finding (evidence) | Code / rule | Suggested fix | Status |
|---|---|---|---|---|---|
| 1 | High | 9 restricted-category products approved: supplement, food, pet health, perfume, essential oils, hair and skin cosmetics, health-claim device (P10, P13, P17, P20, P24, P26, P28, P29, P33) | No category screen on the EU tab (`score.mjs:2-4`); Jev flags shown but not enforced (`README.md:13`) | Reject them; hide Jev people/animals ≥ 0.5 from the EU Inbox (G1) | Partly: [#27] screens the EU path; [#28] (open) takes people/animals ≥ 0.5 out of the EU Inbox. Owner: reject the 9 |
| 2 | Medium | 12 approvals need the buyer to pick a size (P3, P7, P8, P9, P12, P14, P16, P19, P21, P27, P30, P35) | Connor's own rubric | Reject or park; tag Jev sizing ≥ 0.5 | Partly: [#28] (open) ranks sizing ×0.5 and shows why. Owner: reject or park the 12 |
| 3 | Medium | The same jacket was approved twice (P16 and P35: same `valkental.myshopify.com` store, same product path) | `app.mjs:37, :164` | Group by myshopify domain plus handle (C1) | [#28] (open): groups by product page |
| 4 | Medium | 17 of 30 EU approvals have no product, price or rank; the title is ad copy (the list is in C3, not captured) | `meta.mjs:441, :446` | Flag "product not identified" (C3) | [#28] (open): adds the tag |
| 5 | Medium | The board shows 2-week-old snapshots as current (8 rows measured only on 2026-10-17; 5 of them still pass) | `app.mjs:39, :345`; `board.html:983` | Show when it was last measured; stop extrapolating (C4) | [#28] (open): shows the measured age and its date |
| 6 | Medium | A row measured at 5 days passes and tops the reach sort (P32: 278,104 ÷ 55,621 = 5) | `app.mjs:345-348` (checked by running it) | Require a measured age of 7+ (C2) | [#28] (open) |
| 7 | Medium | The EU product match is the store search's first hit (P23's copy doesn't match the product; P29 is an upsell page) | `meta.mjs:252-254` | Use `sameThing()` (C5) | Fixed [#27] |
| 8 | Medium | Huge catalogues with one ad for the product (P1, P23, P32, P34: 302–2,389 products, 1 ad each) | — | Ask for 5+ copies or a top-50 rank when a store has 250+ products | Partly: [#28] (open) tags "Big catalogue, N ads" (250+ products, under 5 copies); it isn't a gate |
| 9 | Low | Approvals teach the Inbox accidental keywords ("tas", "kleid", "robe", "lingerie") | `app.mjs:412, :419, :497-498` | Reject with "Not my niche" (G2) | [#28] (open): learns by Jev category instead of keyword |
| 10 | Low | 6 approvals now fail the 7–42-day rule (P9, P16, P22, P33, P34, P35) | `README.md:17-18, :31-32` | Re-check them before use | Owner |
| 11 | Low | The shop-ad count stops at 500 but is shown as exact (13 rows at exactly 500) | `meta.mjs:45, :383, :451`; `board.html:1037` | Show "500+" (C6) | Partly: [#27] stores `active_ads_capped`; the board doesn't show "500+" yet |
| 12 | Low | Trustpilot is only checked on language subdomains (P9, P16, P35) | `bestsellers.mjs:61-62`; `trust.mjs:79` | Also try the root domain (C7) | Open |

## Tests

The test suite, the fakes and the ranking logic.

| # | Sev | Finding | Where | Suggested fix | Status |
|---|---|---|---|---|---|
| 1 | High | The EU product is the store search's first hit: the wrong product is shown and real winners are deduped away; the fake only matches exact titles | `lib/meta.mjs:252-255, :401`; `test/helpers/fake-meta.mjs:66` | `sameThing` check (as `lib/world.mjs:272`); a fake that always answers, plus a test | Fixed [#27] |
| 2 | High | The board shows ads as live winners up to 35 days after last sighting; failing re-checks are thrown away; a test asserts it | `run.mjs:151`; `worker/src/app.mjs:345-348`; `board.html:1038`; `test/worker.test.mjs:696` | Write re-seen failures (update-only); cap the age guess; liveness refresh | Partly: re-checks fixed in [#27]; the measured age shows in [#28] (open). Stopped ads still age out as before |
| 3 | High | No workflow runs the tests; deploys go out untested; branch pushes run branch code against the live D1 (the comment says otherwise) | `deploy-board.yml:8-61`; `preview-board.yml:35, :53-69`; `world.mjs:332` | Test job with `needs:`; a separate D1 for previews | Fixed [#25]. A separate preview D1 is left to Connor |
| 4 | Medium | A store's 429, 5xx, 403 or timeout counts as "not Shopify"; `www.` is not tried; the cursor moves on | `lib/meta.mjs:233-239`; `lib/score.mjs:142`; `run.mjs:165-168` | Reuse `checkStore`; unknown → pending; hold the cursor | Fixed [#27] |
| 5 | Medium | The PIN lockout is bypassed by parallel requests (200 of 200 evaluated) | `worker/src/app.mjs:853-868` | Count the attempt atomically before comparing the PIN | [#28] (open) |
| 6 | Medium | The EU path has no category gate, Jev's risk answers are unused, and the keywords hunt clothing, cosmetics and pain relief | `run.mjs:151`; `app.mjs:498`; `keywords.txt:44-63, :184-211` | Classify gate plus a Jev risk factor in the Inbox | Partly: [#27] adds the EU screen and moves 70 keywords to `keywords-optin.txt`; the risk factor is in [#28] (open). `KEYWORDS_OPTIN` isn't wired into `winner-hunter.yml` yet |
| 7 | Medium | The gate and the ranking measure the advertiser's size and spend, not the product's traction; product-level scaling is ignored | `lib/score.mjs:146-148`; `app.mjs:498`; `lib/meta.mjs:319` | Product-ads rule as an alternative; age-weighted ranking; competitor count | Open |
| 8 | Medium | Price learning ignores currency; products without a price are exempt | `app.mjs:417-428, :942-943`; `migrations/0005_feedback.sql:14` | Currency column; one threshold per currency | [#28] (open) |
| 9 | Medium | The niche weight sinks every niche you look at a lot | `app.mjs:412-419` | Rate relative to the overall approval rate; count only "Not my niche" | [#28] (open) |
| 10 | Medium | The best-seller boost gives ×1.5 to any product in a store with 10 or fewer products; a test asserts it | `app.mjs:315-318, :307`; `test/bestsellers.test.mjs:43, :141` | Normalise by the store's product count | [#28] (open) |
| 11 | Low | A product is identified by title, not by its product page | `app.mjs:37, :923` | Key by `productKey(product_url)` | [#28] (open). The SQL key stays advertiser + title |
| 12 | Low | Assertions that check nothing, or a removed feature | `test/world.test.mjs:243`; `test/worker.test.mjs:238-257` | Split into real checks or remove; fix the README | Partly: line 243 fixed in [#27]; the ★ Keep test and README text are still there |
| 13 | Low | The fakes have no paging or 500 cap, test only one age window, have no 100-parameter limit, and `late()` uses the real clock | `fake-meta.mjs:51-57`; `sqlite-d1.mjs:26-36`; `lib/meta.mjs:55-56` | Model each of these in the fakes | Fixed [#27] |
| 14 | Low | The discount is worked out against the highest compare-at price (not checked against a live store) | `lib/meta.mjs:259` | Pair minimums, or read the product JSON | Open |

Proposals from the tests session:
- **(a)** Not captured.
- **(b) Risk factor in the Inbox** (`app.mjs:497-498`), from `r.jev`, with a floor of 0.2 and the reason shown on the card: ×0.3 for products people or pets take; ×0.5 each for sizing, medical, brand and restricted; ×0.8 each for kids, skin, electric, fragile and bulky. Built this way in [#28] (open).
- **(c) Opt-in keywords.** Move `keywords.txt:155-170` and `:184-211` to an opt-in list, as `keywords-world.txt:3` already does for its exclusions. Done in [#27] (`keywords-optin.txt`, searched only with `KEYWORDS_OPTIN=1`).

[#25]: https://github.com/hopmanecommerce-png/winner-hunter/pull/25
[#27]: https://github.com/hopmanecommerce-png/winner-hunter/pull/27
[#28]: https://github.com/hopmanecommerce-png/winner-hunter/pull/28
