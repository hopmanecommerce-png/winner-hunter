# Winner Hunter v2

Four times a day it looks in the public **Meta Ad Library** in the markets outside the EU (`world.mjs`). The EU hunt described below has only run by hand since 1 Nov 2026. It looks in the **Meta Ad Library** for active ads from **Shopify stores**, keeps only the ads
that pass four hard rules (see below) in **one database** (Cloudflare D1). You see them on **one
live board** on your phone. Then you make ads for the top products.

```
GitHub Actions (4x a day, outside the EU)  →  Cloudflare D1 (the database)  →  Board (Cloudflare Worker, with PIN)
```

## Jev's answers (Outside EU tab)

After every hunt `world-check.mjs` asks Jev (TypeSafe) about each new product, once, from its name, type, shop and photo. The card shows its category and tags such as "People take 99%"; the **Jev** filter and the CSV have the same data. Nothing is hidden or ranked by it. It needs the GitHub secret `TYPESAFE_API_KEY`; without a key or a balance the products stay on the board without answers. About 0.01 cents a product.

## What you see on the board

- Only ads that pass **all four hard rules** (no points, no score): **Shopify store**, advertiser has **75+ active ads**,
  ad live **7 to 42 days**, **500+ EU reach per day**. Anything else is never saved and never shown. Not on the EU board
  either: supplements, food and drink, cosmetics, perfume, products with a medical claim and pet medicine (they need EU
  paperwork; words in `lib/world.mjs` screenEU, so some slip through: Reject handles those).
- **Inbox** (start screen): every product you have not decided on, one at a time, best first. **✗ Reject**, **★ Keep**
  or **✓ Approved** (buttons, swipe left/right, or keys R / D). Each one leaves the inbox; **Undo** brings it back.
  When none are left: **🎉 Inbox zero**. "New today" = found in the last 24 hours.
  The Inbox card shows only the data and one link: **Open in Facebook Ad Library**.
- **📝 Note** (under the Inbox card, key N): write about the ad, the competitor or the product. It saves as you type and
  stays with the product. Your notes on other products of the same store or advertiser show below it.
- **Why?** After each choice: tap a reason (Too expensive, Not my niche, Bad store… or Wow product, My niche…).
  The board **learns**: niches you like go up in the Inbox, niches you reject go down,
  "Bad store" takes that store out of the Inbox, "Too expensive" (twice) ranks expensive products lower.
- **🧠**: what the board learned, your notes, and a box to tell the board something. Everything is in the D1
  table `feedback`; ask Claude "learn from my Winner Hunter feedback" to turn it into better keywords and rules.
- **🚀 Launch** (next to 🧠): launch an approved product today. Start a launch card from any product you approved (✓, or
  Approved on the TikTok tab). On top, the decision in one card: margin per order, break-even ROAS, how long its ads
  run, store size and risk flags, with **Go** / **No go**. Under it the checklist: sourcing, margin (worked out as you
  type; VAT 21% and payment fees 3% unless you fill in your own), compliance, competitors and ads, store, creatives,
  launch (budget, kill and scale rule). It saves as you type (D1 table `launches`). **📌 Pin** marks the product you
  launch now, one at a time; a No go loses the pin.
- **Browse**: everything that passes, most reach per day first, with search, sort and filters. **★**: your kept products.
  **✓**: every product you approved, the last one first, with the day you approved it (also after it ages out of
  the rules). The ✓ count jumps each time you tap **✓ Approved**.
- **🏆 Store best seller**: proof that a product sells. Once a day (after the hunt) every board product gets its rank in
  its own store's best-seller list (Shopify's sales order, top 50) and how it moved in a week: "#2 best seller in its
  store · ↑3 in 8d". The Inbox puts sellers first (× 1.5 in the store's top 10, × 1.2 in its top 50); Browse can sort
  by it. No line = the store gives no list (headless shop); "Not in its store's top 50" = checked, not selling much.
- **Trustpilot** (second row in the stats block): the store's TrustScore and number of reviews from its own Trustpilot
  page (trustpilot.com/review/<domain>), checked every 3 days for every store, also when the ad links to the home
  page. Trustpilot's website has a bot check: the runner's Chrome passes it once a run and its token opens the pages.
  No page there: a real Trustpilot widget on the store still counts (a page on another domain); else "Not on
  Trustpilot". "Badge only" / "No Trustpilot on the store": only the store was checked (no token that run).
- Per product: photo, price/discount, a ✓ per rule (active ads, days live, reach per day), ads for this product,
  the store's product count, shop. **▶** and a tap on the card open the ad in the Facebook Ad Library (new tab); the shop name links to the product (or the store), **1688 ↗** searches 1688. The in-board ad viewer (`/api/ad/:id`, `ad-prefetch.yml`) is off: the board no longer uses it, the Worker only answers it with `AD_VIEWER = "on"` (wrangler.toml), and the deploy no longer gives the Worker a Meta token. A token an older deploy left there is never used; remove it once: `cd winner-hunter/worker && npx wrangler secret delete META_TOKEN`.
- **✓ Approved** moves a product to **✓**; **✗ Reject** (not for me) hides it; **Undo** brings it back.
- **CSV** downloads what you are looking at.
- A "store photo" label means: photo from the shop's page, not the product photo of the ad.

## Set up (once)

Add these 4 secrets in GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | What |
|---|---|
| `META_TOKEN` | Meta access token for the Ad Library API. Optional extra: `META_TOKEN_2`, `META_TOKEN_3` (other Meta apps, used when one hits its hourly limit). |
| `CF_API_TOKEN` | Cloudflare API token. Make it at dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token, with **Account → D1 → Edit** and **Account → Workers Scripts → Edit**. |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID (Cloudflare dashboard → Workers & Pages, right side). |
| `BOARD_PIN` | The PIN for the board. Use 6+ digits. |
| `CF_D1_TOKEN` | Optional, better: a second Cloudflare token with only **Account → D1 → Edit**. The hunts (World Hunter, Winner Hunter, Jev check, Ad prefetch) then use it instead of `CF_API_TOKEN`, so the jobs that open Facebook and shops hold no token that can change the board. |

Then, in **Actions**:

1. **Deploy board** → Run workflow. It runs the tests first (**Tests**, also on every pull request): a red test stops the deploy. At the end it prints the board link (`https://winner-hunter-clean.<your-name>.workers.dev`; while the repository is public the `<your-name>` part shows as `***`).
2. **World Hunter** (markets outside the EU) runs by itself four times a day. **Winner Hunter** (the EU) and **Ad prefetch** are off since 1 Nov 2026 and only run when you start them by hand (Run workflow).

The workflows must be on the main branch for "Run workflow" and the scheduled runs to appear.
The database tables are made automatically (`worker/migrations/*.sql`). A test link from a branch (**Preview board**) changes
nothing in the database except the decisions you make on it: new tables only come with the merge.

### Undo a migration

Before it makes the tables, every run notes D1's Time Travel bookmark in its log ("D1 restore point"). To put the database
back as it was then: `cd winner-hunter/worker && npx wrangler d1 time-travel restore winner-hunter-clean --bookmark=<bookmark>`.
Without a bookmark: `--timestamp=<Unix time or RFC3339>`. The free plan goes back 7 days, the paid plan 30.

### This repository is public

Anyone can read its Actions logs and summaries. New runs keep the board's address out of them (the deploy and the test
link show `***` for your workers.dev name); older runs may still show it: delete those (Actions → the run → ⋯ → Delete
workflow run). The PIN keeps the board closed either way. GitHub also turns scheduled workflows off after 60 days without
activity in a public repository: the 🌍 tab then shows "No scan outside the EU in 24 hours". Turn it back on: Actions →
World Hunter → Enable workflow (any commit also resets the 60 days).

## How an EU run works (started by hand)

- It takes the next keywords from `keywords.txt`, 2 at a time, starting where the last run stopped.
- After every batch the ads that pass the four rules are saved in D1, and the place in the list is saved too.
  So a stop never loses more than one batch.
- It stops after `minutes` (default 300), or when Meta says "hourly limit" on every token (then the next run goes on).
- Meta, D1 or a shop not answering is a warning (yellow), not a crash. A shop that does not answer (busy, down, a bot
  wall) is unknown, not "not Shopify": its ads are not saved yet and that batch is searched again next run (once).
- A winner already on the board that is found again and now fails a rule (fewer active ads, too little reach) gets its
  new facts, so the board drops it. Only rows already saved change: an ad that fails is still never added.
- The run ends **red** (after saving everything it found) when: 0 ads were checked, winners were found but a batch
  could not be saved in D1, a Meta token is invalid/expired or expires within 7 days, Meta blocked every token
  before the first batch finished, or not one advertiser's ads could be counted (Meta errors). Turn on GitHub
  notifications for failed workflow runs (GitHub app → Settings → Notifications → Actions) to get a push on your phone.
- The EU tab shows a red banner for a recent failed run, a hanging run or a Meta token expiring within 7 days,
  and a yellow one for a recent run with warnings.
- The Outside EU tab shows a red banner for a failed scan, no scan in 24 hours or the same Meta token problem. The
  World Hunter run also ends red when the token is invalid or expires within 7 days.
- The summary of each run is on its page in Actions, and on the board ("Last run …").

Change the keywords: edit `keywords.txt` (one per line, `#` = comment). Clothing, beauty, pain and sale-angle keywords
are in `keywords-optin.txt`: searched only when `KEYWORDS_OPTIN=1` is set for the run, or type one in the workflow's
keywords box.
Other countries: add a repository variable `HUNT_COUNTRIES` (default `NL,BE,DE,FR,AT,ES,IT,IE,DK,SE,PL`).

## Files

```
run.mjs          nightly run (batches, cursor, time budget)
bestsellers.mjs  store signals for the board's products: best-seller rank + Trustpilot (after the hunt; lib/bestsellers.mjs, lib/trust.mjs)
migrate.mjs      creates the D1 tables (safe to run every time)
import.mjs       one-time import of the old winners
keywords.txt     the search words (keywords-optin.txt: only with KEYWORDS_OPTIN=1)
lib/             score.mjs (the four rules) · meta.mjs (Ad Library search) · d1.mjs (database) · storephoto.mjs · record.mjs
worker/          the board: src/app.mjs (API + PIN) · src/board.html (page) · wrangler.toml · migrations/
test/            npm test (node --test); test/board.e2e.test.mjs opens the board in Chromium at iPhone size;
                 test/ops.test.mjs runs the workflows' deploy steps and checks the rules that keep the live board safe
```

Test locally: `cd winner-hunter && npm test` (Node 22+).

## Outside the EU

`world.mjs` (workflow `world-hunter.yml`, daily) hunts in Switzerland, Norway, Australia, New Zealand, the UAE, the US,
Canada, Singapore, Jersey, Hong Kong, Macau, Japan, South Korea, Malaysia, Taiwan, Israel and Liechtenstein. Meta's API only
shows ads that reach the EU or UK (2026-10-31: 23 of 26 local shops gave 0 ads for their own market), so it opens the **public Ad Library** in the runner's Chrome, logged
out, one country and keyword at a time (`keywords-world.txt`, each market in its own language). A logged-out visitor only
gets the first ~30 ads of a search: depth comes from many searches. The board reads D1 table `world_products`.

**There is no reach outside the EU and UK.** A product shows six proof signals instead, each a plain fact on its card:
oldest ad 30+ days, 5+ ads for the product, 2+ markets, shop with 75+ active ads in that market, in its store's top 50,
100+ Trustpilot reviews. Rules to be listed: a Shopify store, an ad running 7+ days, not a supplement, food or drink, or
gymwear, not shipping protection or a gift card (words in `lib/world.mjs`). Words miss some: Reject handles those.

`META_TOKEN` is optional here: one request per shop answers "does it run ads in the EU at all?" (the *Not in EU* tag) and gives
the EU reach of its ads where it does, the only reach figure that exists for these products. If
Facebook refuses more than 80% of the searches, the run ends red and the board's 🌍 tab says so. If Shopify still refuses
(429) more than half of the store requests after waiting, the run ends yellow: those stores and products are asked again
next run. A run searches for at most 135 minutes (`minutes`), so the job's 180 still hold the board's table, Jev and the
store signals.
