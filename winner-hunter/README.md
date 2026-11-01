# Winner Hunter v2

Four times a day it looks in the public **Meta Ad Library** in the markets outside the EU (`world.mjs`). The EU hunt described below has only run by hand since 1 Nov 2026. It looks in the **Meta Ad Library** for active ads from **Shopify stores**, keeps only the ads
that pass four hard rules (see below) in **one database** (Cloudflare D1). You see them on **one
live board** on your phone. Then you make ads for the top products.

```
GitHub Actions (4x a day, outside the EU)  →  Cloudflare D1 (the database)  →  Board (Cloudflare Worker, with PIN)
```

## Jev's answers (Outside EU tab)

After every hunt `world-check.mjs` asks Jev (TypeSafe) about each new product, once, from its name, type, shop and photo. The card shows its category and tags such as "People take 99%"; the **Jev** filter and the CSV have the same data. Its risks rank a product lower in both Inboxes, and the Inbox card says why: people or pets take it × 0.3, sizing returns, a medical claim, a brand or hard to ship × 0.5 each, for children, cosmetics, electric, fragile or big × 0.8 each, never below × 0.2. An EU product people or pets take stays out of the Inbox (Browse still lists it). Hard to ship, Medical claim and Cosmetics get a red tag. It needs the GitHub secret `TYPESAFE_API_KEY`; without a key or a balance the products stay on the board without answers. About 0.01 cents a product.

## AI read (experimental)

Twice a day `ai-check.mjs` (workflow **AI check**) asks a cheap Claude model (Claude Haiku 5.5) about each board product it has
not read yet: the products outside the EU that still run, the EU's still on the board, and every product you approved or
rejected. Per product: what it is (a plain name), niche, the ads' hook, the buyer, wow factor, saturation, claims risk, and a
0-100 **fit** with reasons for and against and how sure it is. It is saved in D1 table `ai_checks`.

- **Hidden first.** Each card gets **AI read · experimental**, closed. It stays closed until you open it, so you decide on your own
  first, and nothing is sorted, filtered or hidden by it. The first time you open one is noted, so the eval can keep your blind
  decisions apart from those made after a look.
- **How good is it?** `ai-eval.mjs` compares the fit (50 or more counts as approve) with your ✓ / ✗ decisions: agreement, Cohen's
  kappa (agreement beyond chance) and AUC (does a higher fit go with your approvals), blind decisions apart, by confidence and by
  your reasons. It runs after every AI check, its result shows at the bottom of each AI read, and on your own computer
  `node winner-hunter/ai-eval.mjs --details` also lists where you and the AI disagree (never in the public Actions log): the
  products you approved and it scored low are the first ones to look at again. Your approvals are the yardstick, not proof of a
  winner, and old ones are noisy (the 1 Nov 2026 review found 21 of 36 restricted or sized): `--since 2026-11-02` counts only the
  decisions from that day on. Rule of thumb: worth a look once it agrees on 50+ blind decisions with a kappa of 0.4 or more.
- **Set up:** add the GitHub secret `ANTHROPIC_API_KEY` (console.anthropic.com → API keys), and set a monthly spend limit for that
  key's workspace in the Anthropic Console as a hard backstop. Without the secret the AI check is off and the board shows no AI
  read. Run it by hand: Actions → AI check → Run workflow. It goes through the Message Batches API (half price): a batch usually
  ends within minutes, and one still running is collected by the next run.
- **Cost:** about 0.02 cents a product. A run spends at most `max_usd` (default $0.50, counted at the worst case of every request)
  and a month at most the repository variable `AI_MONTH_USD` (default $5). Another model: repository variable `AI_MODEL`
  (for example `claude-sonnet-5-5`: more careful, 20 times the price; the caps hold either way).
- **Safe with ad copy:** titles and ad texts are written by advertisers. The model is told they are only data; they reach it as one
  escaped JSON block, one product per request; every answer must match a strict schema and is checked again; text that tries to
  instruct the AI is flagged (⚠ on the card, low confidence). Your decisions, notes and reasons are never sent, and the Actions log
  holds counts and money only.
- **Tests:** `npm test` skips the tests that need Anthropic's SDK when it is not installed. To run them all, first
  `npm install --no-save --no-package-lock playwright@1.56.1 @anthropic-ai/sdk@1.3.0` (the CI does). They use a fake API: nothing is sent.

## What you see on the board

- Only ads that pass **all four hard rules** (no points, no score): **Shopify store**, advertiser has **75+ active ads**,
  ad live **7 to 42 days** (7+ when it was measured, at most 42 today counted from the day it started), **500+ EU reach
  per day**. Anything else is never saved and never shown. One product = one product page: the same product under two
  titles or two advertisers is one card and one decision. Not on the EU board
  either: supplements, food and drink, cosmetics, perfume, products with a medical claim and pet medicine (they need EU
  paperwork; words in `lib/world.mjs` screenEU, so some slip through: Reject handles those).
- **Inbox** (start screen): every product you have not decided on, one at a time, best first. **✗ Reject**, **★ Keep**
  or **✓ Approved** (buttons, swipe left/right, or keys R / D). Each one leaves the inbox; **Undo** brings it back.
  When none are left: **🎉 Inbox zero**. "New today" = found in the last 24 hours.
  The Inbox card shows only the data and one link: **Open in Facebook Ad Library**.
- **📝 Note** (under the Inbox card, key N): write about the ad, the competitor or the product. It saves as you type and
  stays with the product. Your notes on other products of the same store or advertiser show below it.
- **Why?** After each choice: tap a reason (Too expensive, Not my niche, Bad store… or Wow product, My niche…).
  The board **learns** (both Inboxes): a niche is Jev's category of a product; one you approve more often than usual
  goes up, one you mark "Not my niche" goes down (a no for another reason says nothing about the niche). "Bad store"
  takes that store out of the Inbox. "Too expensive" twice in one currency ranks that currency's products from the
  cheaper price up at half; a product without a price ranks at × 0.75 while there is a limit for it.
- **🧠**: what the board learned, your notes, and a box to tell the board something. Everything is in the D1
  table `feedback`; ask Claude "learn from my Winner Hunter feedback" to turn it into better keywords and rules.
- **🚀 Launch** (next to 🧠): launch an approved product today. Start a launch card from any product you approved (✓, or
  Approved on the TikTok tab). On top, the decision in one card: margin per order, break-even ROAS, how long its ads
  run, store size and risk flags, with **Go** / **No go**. Under it the checklist: sourcing, margin (worked out as you
  type; VAT 21% and payment fees 3% unless you fill in your own), compliance, competitors and ads, store, creatives,
  launch (budget, kill and scale rule). It saves as you type (D1 table `launches`). **📌 Pin** marks the product you
  launch now, one at a time; a No go loses the pin. One card per product, as the board groups it (an EU product by its
  product page). A card started before that keeps its old advertiser + title key in D1 and is still that product's card.
- **Browse**: everything that passes, most reach per day first, with search, sort and filters. **★**: your kept products.
  **✓**: every product you approved, the last one first, with the day you approved it (also after it ages out of
  the rules). The ✓ count jumps each time you tap **✓ Approved**.
- **🏆 Store best seller**: proof that a product sells. Once a day (after the hunt) every board product gets its rank in
  its own store's best-seller list (Shopify's sales order, top 50) and how it moved in a week: "#2 best seller in its
  store · ↑3 in 8d". The Inbox puts sellers first (× 1.5 in the store's top 10 and top 2% of its products, × 1.2 in its top 50
  and top 10%; nothing while the store's size is unknown); Browse can sort
  by it. No line = the store gives no list (headless shop); "Not in its store's top 50" = checked, not selling much.
- **📈 Momentum** (a row on every card, a block on the Inbox card, a panel above the products): is it **rising, steady or
  falling**, with a sparkline of its last 14 days, how long its **ads survived**, how many **other stores sell the same
  item** (by its words, the supplier's photo or a photo that looks the same) and whether that makes it **crowded**. The
  Inbox ranks × the momentum factor (rising × up to 1.3, falling × down to 0.7, crowded × 0.75) and every sort menu has
  **Momentum**; the weights are in the panel. Worked out once a day by `momentum.mjs` (see "Momentum" below).
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
- "Measured 17 Sep": the card's figures (reach, ads, copies, days live) are from then, more than 2 days ago (the EU hunt
  only runs by hand). "Product not identified": no product page, price or rank was found, the title is the ad's own
  words. "Big catalogue, 1 ad": a store of 250+ products with fewer than 5 copies of this ad.

## 🔎 Sourcing (on a launch card)

Under the decision on a 🚀 launch card, **🔎 Sourcing** takes the product to a supplier you trust, at a cost you know
(`worker/src/sourcing.mjs`, D1 tables `product_sourcing` and `product_suppliers`). It saves as you go.

- **Find it**: search links by name on 1688 (with the Chinese words you set; "translate the name" helps), AliExpress,
  Alibaba and CJ, and by photo on Google Lens and Yandex (they take the product photo's link). 1688, AliExpress and
  Alibaba only search a photo in their own app: save the photo, then tap the camera there.
- **Suppliers**: paste a link, or the text the 1688 or AliExpress app shares (price, MOQ, rating, repeat buyers and
  factory come along), then fill in the rest: price and currency, shipping to NL, MOQ, rating, factory or trader, repeat
  buyers (1688: 回头率), packed weight, days to the customer, notes. They are listed by what one order costs at the
  customer's door: the unit, its shipping and the EU import fees on a parcel from China (€3 duty from 1 Jul 2026 and
  €2 handling per item line from 1 Nov 2026: €5; none from EU stock), in euros at ¥8.3 and $1.16 for €1 unless you set
  your own rate. Flags say what to look at: a trader, few repeat buyers, a rating under 4.5, MOQ above 50, slow, no
  shipping cost yet.
- **Choose** puts the supplier's cost in euros, its link, shipping, MOQ and lead time in the card's Sourcing step: the
  margin and break-even ROAS on top follow at once (a COGS you typed in the Margin step still counts first). A new price
  or rate for the chosen one: the card follows. Choose another, remove it or choose none: the card keeps its numbers.
- **Vet the supplier** and **Sample order**: two checklists of ten, from the sourcing research (an unedited video with
  today's date, the CE/RoHS/REACH report, battery papers, packed size, defects, safe payment; samples from the top two,
  the agent's QC, a competitor's unit, labels, line quotes, the €3 + €2 and your IOSS in writing).
- **First message**: to an agent (find it on 1688, samples and QC, line quotes, the €3 + €2 and your IOSS) or to a
  supplier (the questions to ask before you pay), in English or Chinese, with your name and test quantity. **Copy**.

**Shared numbers**, for every part of the board that works out costs: `product_sourcing` holds, by the launch card's
`product_key`, `supplier_cost` (euros for one unit: the product only, no shipping or EU fees), `supplier_url`,
`weight_g` (one unit packed, in grams: one you type wins over a supplier's), `ship_cost` (euros, one order to NL),
`moq` and `lead_days`. `chosenSupplier(env, key)` in `worker/src/sourcing.mjs` reads them.

**CJ Dropshipping (optional)**: with a Worker secret `CJ_API_KEY`, the panel finds CJ products by photo (CJ allows that
from account Level 3; below it, by name) or by name, and gives one product's cost, packed weight, stock (the EU apart)
and cheapest freight to NL, DE and FR, from China and from CJ's EU warehouse. **Add as supplier** lists it by the route
that lands cheapest. Without the secret it is off and calls nothing. Set it once: Cloudflare dashboard → Workers &
Pages → winner-hunter-clean → Settings → Variables and Secrets → Add (type Secret, name `CJ_API_KEY`, your key from CJ:
My CJ → Authorization → API), or `cd winner-hunter/worker && npx wrangler secret put CJ_API_KEY`. Off again: delete it.
The CJ token is kept in D1 (`state` row `cj_token`) sealed with a key made from `CJ_API_KEY`: the hunts can read D1, and
a token there is no use to them.

## Set up (once)

Add these 4 secrets in GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | What |
|---|---|
| `META_TOKEN` | Meta access token for the Ad Library API. Optional extra: `META_TOKEN_2`, `META_TOKEN_3` (other Meta apps, used when one hits its hourly limit). |
| `CF_API_TOKEN` | Cloudflare API token. Make it at dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token, with **Account → D1 → Edit** and **Account → Workers Scripts → Edit**. |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID (Cloudflare dashboard → Workers & Pages, right side). |
| `BOARD_PIN` | The PIN for the board. Use 6+ digits. 10 tries per address (IPv6: per /64) and 30 per network (IPv6 /48, IPv4 /24) per 15 minutes. |
| `CF_D1_TOKEN` | Optional, better: a second Cloudflare token with only **Account → D1 → Edit**. The hunts (World Hunter, Winner Hunter, Jev check, Ad prefetch) then use it instead of `CF_API_TOKEN`, so the jobs that open Facebook and shops hold no token that can change the board. |

The login cookie is keyed by the PIN and a random key the board makes at the first login and keeps in D1 (`state` row
`cookie_key`): no one can make a cookie to try PINs, and a copied cookie does not give the PIN away. To log every phone
out: change `BOARD_PIN`, or delete that row. Optional: a Worker secret `BOARD_SECRET` (32+ random characters,
`cd winner-hunter/worker && npx wrangler secret put BOARD_SECRET`) takes the place of the key in D1.

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
momentum.mjs     once a day: each product's numbers, trend, rivals and crowding (lib/momentum.mjs; the board: worker/src/momentum.mjs)
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

## Momentum (📈)

Workflow **Momentum** (`momentum.yml`, `momentum.mjs`) runs once a day at 22:43 UTC, after the last hunt outside the EU,
and by hand (Actions → Momentum → Run workflow; a second run on a day replaces that day). It reads the board's tables and
only writes its own two.

- **Tracked**: the products outside the EU that still run, the EU board's products, every TikTok product, and every
  product you approved, starred or started a launch card for.
- **Saved**: one row a day in D1 table `momentum_daily` with every tracked product's numbers that day: ads for the
  product, the store's active ads, ads started in 14 days, markets, EU reach a day, best-seller rank, TikTok units sold
  and creators, price, rivals. Kept 120 days.
- **The score**, from −1 (falling) to +1 (rising), from the signals a product has (their weights shared out). Rising from
  +0.15, falling from −0.15; "No trend yet" until there is one; "Stopped" when its ads were no longer found.

  | Signal | Weight | |
  |---|---|---|
  | Ads | 0.35 | ads running for the product, now against about a week ago |
  | EU reach | 0.35 | EU reach a day of its best ad (EU board) |
  | Best-seller rank | 0.25 | its rank in its store's top 50 (from day 1: the store signals keep 15 days) |
  | Sales speed | 0.5 | TikTok: units sold a day between two imports against its lifetime sales; with 3 imports also faster or slower |
  | Google searches | 0.25 | the last 4 weeks against the 4 before (only with `SERPAPI_KEY`) |
  | New ads | 0.15 | share of its ads started in the last 14 days: counts only next to a real trend |
  | Creators | 0.15 | TikTok creators with videos on it |
  | Store ads | 0.1 | the store's active ads |
  | Markets | 0.1 | markets its ads run in (outside the EU) |

  The Inbox ranks × (1 + 0.3 × score), so × 0.7 to × 1.3; the **Momentum** sort ranks by that factor alone. A product
  without numbers yet ranks as before. The EU board's numbers only change when its hunt runs (by hand): its products say
  "No new numbers since …" instead of a trend.
- **Ads survived N days**: its longest-running ad, from Meta's start date to the last time the hunt saw it still running.
  A hint, not proof (some advertisers leave ads switched on), so it is shown but not in the score.
- **Rivals and crowding**: other stores selling the same or a very similar item, among every store the hunts found (also
  TikTok shops): the same words in the title, the supplier's own photo id in the photo's file name (stores importing the
  same AliExpress or 1688 listing keep it), or a photo that looks the same (a fingerprint made in the runner's Chrome, so
  also across languages). 2+ other stores, or 2+ new ones in 14 days: getting crowded (× 0.9); 5+: crowded (× 0.75). Only
  stores the board knows count (those the hunts found, and the TikTok tab's shops), so the real number is higher.
- **Google Trends** (optional): add the GitHub secret `SERPAPI_KEY` (serpapi.com). The job then asks about shortlisted
  products only (a launch card, then approved ✓, approved on the TikTok tab, starred), at most `TRENDS_MAX` a run
  (repository variable, default 3: about 90 a month, inside SerpApi's free 100; more is Q5 in docs/learnings), each again after `TRENDS_DAYS` days
  (default 14), in the product's biggest market. Without the key nothing is asked.

**D1 budget.** The board reads all summaries in one query of a few rows (one per 400 KB, not one per product) together
with its tables, so at most once per 15 minutes; the panel reads only the decisions. The job reads the board's tables
once and about 45 daily rows, and writes fewer than 10 rows a day.

**Ask D1** (the view `momentum_history` has one row per product and day; the keys are the launch cards' keys):

```sql
SELECT day, ads, shop_ads, best_seller_rank, rivals, price FROM momentum_history
WHERE product_key = 'world|store.com/products/handle' ORDER BY day;
-- eu|<page id>|<title in lower case>   tiktok|<id>
```
