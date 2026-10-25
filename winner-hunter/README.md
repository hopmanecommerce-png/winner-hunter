# Winner Hunter v2

Every night it looks in the **Meta Ad Library** for active ads from **Shopify stores**, keeps only the ads
that pass four hard rules (see below) in **one database** (Cloudflare D1). You see them on **one
live board** on your phone. Then you make ads for the top products.

```
GitHub Actions (every night)  →  Cloudflare D1 (the database)  →  Board (Cloudflare Worker, with PIN)
```

## What you see on the board

- Only ads that pass **all four hard rules** (no points, no score): **Shopify store**, advertiser has **75+ active ads**,
  ad live **7 to 42 days**, **500+ EU reach per day**. Anything else is never saved and never shown.
- **Inbox** (start screen): every product you have not decided on, one at a time, best first. **✗ Reject**, **★ Keep**
  or **✓ Made ad** (buttons, swipe left/right, or keys R / K / D). Each one leaves the inbox; **Undo** brings it back.
  When none are left: **🎉 Inbox zero**. "New today" = found in the last 24 hours.
  The Inbox card shows only the data and one link: **Open in Facebook Ad Library**.
- **📝 Note** (under the Inbox card, key N): write about the ad, the competitor or the product. It saves as you type and
  stays with the product. Your notes on other products of the same store or advertiser show below it.
- **Why?** After each choice: tap a reason (Too expensive, Not my niche, Bad store… or Wow product, My niche…).
  The board **learns**: niches you like go up in the Inbox, niches you reject go down,
  "Bad store" takes that store out of the Inbox, "Too expensive" (twice) ranks expensive products lower.
- **🧠**: what the board learned, your notes, and a box to tell the board something. Everything is in the D1
  table `feedback`; ask Claude "learn from my Winner Hunter feedback" to turn it into better keywords and rules.
- **Browse**: everything that passes, most reach per day first, with search, sort and filters. **★**: your kept products.
  **✓**: every product you made an ad for, the last one first, with the day you made it (also after it ages out of
  the rules). The ✓ count jumps each time you tap **✓ Made ad**.
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
  the store's product count, shop. **▶ Bekijk ad** opens the ad itself (video, images, text, button) on the board, at once: `ad-prefetch.yml` opens every board ad ahead of time (every 8 hours and after each hunt).
  Tap a card for more: ad text, checklist and the buttons **Ad ↗ · Product ↗ · Store ↗ · Search 1688 ↗**.
- **✓ Made ad** moves a product to **✓**; **✗ Reject** (not for me) hides it; **Undo** brings it back.
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

Then, in **Actions**:

1. **Deploy board** → Run workflow. At the end it prints the board link (`https://winner-hunter-clean.<your-name>.workers.dev`).
2. **Winner Hunter** runs by itself every night (~03:00). You can also start it by hand (Run workflow).

The workflows must be on the main branch for "Run workflow" and the nightly run to appear.
The database tables are made automatically (`worker/migrations/*.sql`).

## How a night works

- It takes the next keywords from `keywords.txt`, 2 at a time, starting where the last run stopped.
- After every batch the ads that pass the four rules are saved in D1, and the place in the list is saved too.
  So a stop never loses more than one batch.
- It stops after `minutes` (default 300), or when Meta says "hourly limit" on every token (then the next night goes on).
- Meta, D1 or a shop not answering is a warning (yellow), not a crash.
- The run ends **red** (after saving everything it found) when: 0 ads were checked, winners were found but a batch
  could not be saved in D1, a Meta token is invalid/expired or expires within 7 days, or Meta blocked every token
  before the first batch finished. Turn on GitHub notifications for failed workflow runs (GitHub app → Settings →
  Notifications → Actions) to get a push on your phone.
- The board shows a red banner for a failed run, no run in 36 hours or a Meta token expiring within 7 days,
  and a yellow one for a run with warnings.
- The summary of each run is on its page in Actions, and on the board ("Last run …").

Change the keywords: edit `keywords.txt` (one per line, `#` = comment).
Other countries: add a repository variable `HUNT_COUNTRIES` (default `NL,BE,DE,FR,AT,ES,IT,IE,DK,SE,PL`).

## Files

```
run.mjs          nightly run (batches, cursor, time budget)
bestsellers.mjs  store signals for the board's products: best-seller rank + Trustpilot (after the hunt; lib/bestsellers.mjs, lib/trust.mjs)
migrate.mjs      creates the D1 tables (safe to run every time)
import.mjs       one-time import of the old winners
keywords.txt     the search words
lib/             score.mjs (the four rules) · meta.mjs (Ad Library search) · d1.mjs (database) · storephoto.mjs · record.mjs
worker/          the board: src/app.mjs (API + PIN) · src/board.html (page) · wrangler.toml · migrations/
test/            npm test (node --test); test/board.e2e.test.mjs opens the board in Chromium at iPhone size
```

Test locally: `cd winner-hunter && npm test` (Node 22+).
