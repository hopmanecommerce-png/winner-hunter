# 🧭 Pipeline: from Approved to Launched

One view on the board that takes every approved product to a launch, one stage after the other. The sourcing step is made
effortless: for every product the board already has each field of a sourcing-agent request ready to copy, you paste the
1688 link you found yourself, and the pipeline moves on. Target markets are countries outside the EU, each with what
matters for sourcing and launching there.

Code: `winner-hunter/worker/src/pipeline.mjs` (stages, links, request pack, API), `winner-hunter/worker/src/countries.mjs`
(the countries), the `🧭` blocks in `winner-hunter/worker/src/board.html`, and migration
`winner-hunter/worker/migrations/0074_pipeline.sql`. Tests: `winner-hunter/test/pipeline.test.mjs` and
`winner-hunter/test/pipeline.e2e.test.mjs`.

## The stages

| # | Stage | What to do next | Who | Moves on by itself when | On the 🚀 launch card |
|---|---|---|---|---|---|
| 1 | **Approved** | Check the request pack (English title, photo, variants, target markets) and copy it into your agent's form | You | | |
| 2 | **Request ready** | Send it to your agent, or search 1688 yourself with the Chinese words; paste the 1688 link here | You and your agent | You tap **Copy all** on an Approved product | |
| 3 | **Link found** | Fill in the price and MOQ of each link (the agent's quote or the page), then choose the best one | Your agent quotes, you fill in | You paste a link | The link is a 🔎 Sourcing supplier |
| 4 | **Supplier confirmed** | Order 1–2 samples through your agent | You | You **Choose** a link with a price | Its cost, link, MOQ in the Sourcing step: the margin follows |
| 5 | **Sample ordered** | The agent checks the sample (photos, function video, measurements) and sends it; test it | Your agent | | Ticks **Sample ordered** (Sourcing step) |
| 6 | **Sample approved** | Product page, creatives and the test campaign: open the launch card | You | | |
| 7 | **Test ads** | Run the test for 3–5 days by the launch card's kill and scale rules | You | | Ticks **Test campaign set up** (Launch step) |
| 8 | **Launched** | Tap **Scale** or **Kill** | You | | |

- Every product has the day it came into its stage, the days it has been there, and **your note per stage**. The history
  lists every move: by you, or by what you did (a link pasted, a supplier chosen, the request copied).
- **Forward and back**: the ▶ and ◀ buttons on a card, the eight bars on top of a product (tap any stage), or on a desktop
  **drag a card** onto another column or onto a stage chip. Moving back before "Sample ordered" or "Test ads" clears that
  tick on the launch card again: the stage and the tick are the same fact.
- **The data says**: when the launch card or 🔎 Sourcing already shows a later stage (a supplier link added there, a
  supplier chosen there, "Sample ordered" ticked, "Full test on arrival" ticked, "Test campaign set up" ticked), the
  product shows a one-tap **Move there**. The board never moves a product on just by being opened.
- **No go** takes a product off the pipeline: it is the launch card's No go (also set from the 🚀 view). The **No go** chip
  lists them; **Restore** brings one back where it was.
- Filters: a **stage** (chips with counts), a **target market**, and **stuck** (3, 7 or 14+ days in its stage). A card
  that waits 7 days or more has an amber edge.

## How you use it, step by step

1. Approve products as always (✓ in the Inbox or on the Google tab, or Approved on the TikTok tab). Each one shows up in **🧭 Pipeline** (the
   button with three columns, next to 🚀 on the view bar), in **Approved**, the longest waiting first.
2. Tap a product. Open **Sourcing request**. Check the English title (a Dutch, German or French title gets a "translate
   it" link), fill in the **variants** you see on their page, and anything it **must have**. Quantities default to 2 samples
   and a test order of 50.
3. Pick your agent's form: **Agent form** (Pandabuy, Sugargoo, CNFans, Wegobuy, Superbuy, Hoobuy, ACBuy and most others),
   **Kungfubuy** (Product Link, Product Image, Country, Remark) or **Free text** (one message for WhatsApp, WeChat or
   e-mail), in English or 中文. Every field has its own **Copy** button, in the form's order; **Copy all** copies them all.
   **Download photo** saves the photo for the form's upload (see "The photo" below).
4. Paste it into the agent's site and send it. (Copy all on an Approved product moves it to Request ready.)
5. Search 1688 yourself (the Chinese words are in the pack) or wait for your agent. Paste the **1688 link** under
   **1688 links**: the link, or the whole text the 1688 app shares. It moves to **Link found**.
6. Fill in each link's **price**, **currency** and **MOQ** (and notes), then **Choose** the one you go with: it moves to
   **Supplier confirmed**, and its cost goes into 🔎 Sourcing's comparison and the launch card's margin.
7. Order samples: tap **Sample ordered ▶**. When the sample is good: **Sample approved ▶**, then build the store and
   creatives on the 🚀 launch card (the **🚀 Launch card** link opens it), and **Test ads ▶** when the campaign runs.
8. After the test: **Launched ▶**, then **Scale** or **Kill**.

## The request pack

| Field | Where it comes from |
|---|---|
| Product title (English) | The product's title, cleaned: no ™ ® ©, emoji, 【tags】, "\| colour" or "– shop" tail, sale words. Your own English title wins. |
| Chinese name (1688) | Your words in 🔎 Sourcing (the same field); else the hunt's words from `lib/1688-terms.json`; else a guess from the English words (marked "guessed": check it). |
| Product Link | The supplier link you chose, else the first 1688 link (else another supplier link), else the competitor's product page (then the remark asks the agent to find it on 1688). |
| Image URL / Product Image | The product photo the board has (`image_url`), as a link and as a file. |
| Colour / size | What you fill in (the board cannot read the variants of their page). |
| Quantity | Samples and the test order (defaults 2 and 50). |
| Target price | "Under ¥X per unit (€Y)": the most one unit may cost so an order still leaves a margin. From the launch card's numbers: its selling price (else the competitor's price, when it is in € or $), VAT and payment fees (21% and 3% unless you set your own), its shipping, and your target CPA; without a target CPA it keeps a break-even ROAS of 3 (the launch card's "thin margin" line). Converted at the product's own ¥ rate from 🔎 Sourcing (¥8.3 for €1 by default). No selling price, or a price in another currency: it says so instead of guessing. |
| Country | The target markets (Kungfubuy: one country per request, and it says which others need their own). |
| Shipping | A fast tracked line (special line or express) to those countries, with a tracking number; for a battery product, a line that takes batteries. |
| Remark | The ready-made remark in English or Chinese: same product from a factory, MOQ, price at 1/10/50 pcs, sample price, material, certificates, lead time, shipping time to the countries, packaging, no logo or custom logo, the target price and the quantities. |
| Questions | The same, as a short numbered list (a battery product adds the UN38.3 report and MSDS). |
| Documents to ask for | The papers the 🛡 risk radar (`risk.mjs`) asks the supplier for, in English and Chinese: CE declaration and test reports for electric products, UN38.3 and MSDS for batteries, EN 71 for toys, food-contact papers, the label. In the agent form and the free-text message. |

"Still missing" under the pack says what is not there yet (a photo, a link, target markets, a selling price, Chinese words).

### The photo

**Download photo** saves the product's own photo (the Worker fetches the photo link the board already has; it never takes a
link from the page). Agents' forms take gif, jpg or png up to 3 MB: such a photo is saved as it is; a bigger one, or a WebP
or AVIF, is made a JPG under 3 MB in your browser (smaller, then lower quality, until it fits), and the board says how big it
was and what it saved. **Copy photo link** copies the link instead.

## 1688 links

- Paste a link or the text the 1688 app shares; several links at once work (one per line). Up to **5 links** per product
  here; 🔎 Sourcing compares more.
- Every link is **cleaned to the offer's own address** and its **offer id** shown: `detail.1688.com/offer/<id>.html`,
  `m.1688.com/offer/<id>.html`, `…/offerdetail.html?offerId=<id>`, `http://` or no `https://` at all, tracking (`spm`,
  `tracelog`, …) dropped. A **shop** link, a **search** page or a **share link** (`qr.1688.com/s/…`) is kept but marked:
  the product's own link is better. **AliExpress** (`/item/<id>.html`, `/i/<id>.html`, `a.aliexpress.com/_…`) and
  **Alibaba** (`/product-detail/…_<id>.html`, `m.alibaba.com/product/<id>/…`) links count as other suppliers; Taobao and
  Tmall item links are cleaned too.
- From share text the **price** (and its currency), **MOQ**, rating, repeat buyers and factory or trader come along. A share
  code without a link (`￥AbC123￥`) cannot be opened: the board says to use the app's **Share → Copy link**.
- The links are 🔎 Sourcing's supplier candidates (table `product_suppliers`), added, priced and chosen through its own code:
  the same link twice is refused, and **Choose** is Sourcing's choose. Nothing ever scrapes 1688 or logs in: you paste.

## Target markets outside the EU

- Each product has its own markets (multi-select). Until you pick, it uses the **suggested** ones (dashed): the countries
  where it already runs ads (outside the EU; TikTok: its Meta ads in the US, AU and NZ), else the first four of your list.
  "Runs ads in" shows where its ads run (EU products: their EU countries).
- **Countries** (next to the filters) sets the list for the whole board. The default: US, UK, Canada, Australia, New Zealand,
  Switzerland, Norway, UAE, Saudi Arabia, Singapore, Malaysia, Japan, South Korea, Israel, South Africa, Mexico, Brazil,
  Chile, Türkiye. Jersey, Hong Kong, Macao, Taiwan and Liechtenstein can be switched on.
- Per country: currency and language; **shipping from China** in business days; **plug and voltage** (highlighted for an
  electric product); tax, customs and de minimis; pricing and returns rules; and the **restrictions** (blockers, safety,
  claims, labels). Each item says how far it was checked (**fact**, **estimate** or **unverified**) and links its source.
  The rules come from `worker/src/market-rules.mjs` (researched 2026-10-31) for the 17 countries it has; the UK, Saudi Arabia,
  South Africa, Mexico, Brazil, Chile and Türkiye have their own items in `countries.mjs` (researched 2026-11-01; their
  low-value import rules changed often in 2024–2026, so most are estimates). Shipping ranges marked estimate are a carrier's
  published times (YunExpress); the others are rough ranges for a tracked line, from no carrier table: ask your agent.
  General research, not legal or tax advice.

## What is stored where

| Table | What |
|---|---|
| `pipeline_items` (new) | Per product (the launch card's `product_key`): stage, `stage_at`, outcome (scale/kill), markets (JSON, NULL = suggested), the pack's own fields (JSON), a note per stage (JSON) |
| `pipeline_history` (new) | Every move: from, to, note, by whom or what, when |
| `pipeline_settings` (new) | Board-wide: the countries in the list, the agent form the pack opens on |
| `launches` (🚀) | The pipeline lives on the product's launch card. A product without one gets it on your first change here (as 🚀 Start does: it becomes the launch pin when nothing else is). The two ticks and the No go are the card's own. |
| `product_suppliers`, `product_sourcing` (🔎) | The links and the chosen one; the Chinese words (`zh`) and the ¥ rate |

The migration only has `CREATE … IF NOT EXISTS`: safe to run again and again, and it changes no row of another table. The
deploy after the merge runs it. Before that (a test link), the view still lists the products; a change says the tables come
with the deploy. Everything saves as you type, one save after the other, like the launch card.

### API (the Worker, behind the PIN cookie like every other route)

- `GET /api/pipeline`: `{ items, settings, countries, all_countries, stages }`.
- `POST /api/pipeline` with `{ key, … }`: `stage` (+ `note`), `outcome` (`scale`, `kill`, `''`), `note: { stage, text }`,
  `markets` (list or `null`), `pack`, `zh`, `links: { paste }`, `link: { id, set | remove }`, `choose` (id or `null`),
  `drop` (`true`/`false`), `copied: true`, `start: true`; or `{ settings: { markets, template } }`. A change that cannot be
  saved never starts a launch card.
- `GET /api/pipeline/image?key=…`: the product photo as a file. `GET /pipeline.js`: the kit the board runs
  (`window.PIPELINE`), the same code the Worker uses.

## How to add a country

1. In `winner-hunter/worker/src/countries.mjs`, add one line to `COUNTRIES`: name, Chinese name (for the agent texts),
   currency, language, plug types and voltage (IEC World Plugs), and the shipping range
   `[min, max, status, line, source]` (status `estimate` only with a carrier's published table as the source; else
   `unverified` with no source).
2. Its rules: if `market-rules.mjs` has the country, nothing to do. Otherwise add an entry to `EXTRA_RULES` with a `short`
   line and at least a `tax` and a `customs` item (`{ k, label, text, status, source }`, every item with an https source).
3. To have it in the default list for everyone, add it to `DEFAULT_MARKETS`; or switch it on under **Countries** on the board.
4. Run `npm test`: the country test checks every country has its facts, an estimate has its source, and every rule item a
   status and an https source.

## How to add an agent template

1. In `pipelineKit()` (`winner-hunter/worker/src/pipeline.mjs`), add an entry to `TEMPLATES`: `label`, `hint` and the list
   of `fields` in the form's order. The fields there: `link`, `title`, `zh`, `image_url`, `image` (a file to download),
   `variants`, `qty`, `price`, `country` (every market), `country1` (the first, for a one-country form), `shipping`,
   `remark`, `questions`, `message` (the whole free text).
2. A field the form needs that is not in that list: add it to the map in `fieldsOf()` (label, value, note), from what
   `packOf()` gives.
3. Add the template to the exact-text test in `winner-hunter/test/pipeline.test.mjs`. The board shows it as a new button at
   once (the template buttons come from `TEMPLATES`).

## Compliance: the risk radar, and a hook per country

- **The risk radar** (`winner-hunter/worker/src/risk.mjs`, PR #40) is reused as it is: every product in the pipeline
  carries the radar's own verdict (Block, Docs or OK, with your radar check on it), its reasons under **Target markets**,
  and its documents in the request pack. A ⛔ Block shows on the product's card. The radar reads EU rules for a store that
  ships from 1688; the papers it asks for are what most markets want as well.
- **Per country**: `countryFacts(cc, { compliance })` in `countries.mjs` takes a list of restricted categories for one
  market (`[{ k, label, text, status, source }]`) and lists it first under that country's restrictions. Market-specific
  restriction data (say, US CPSC rules for children's products) can be passed as `deps.compliance`
  (`{ US: [...], GB: [...] }`) in the Pipeline block of `winner-hunter/worker/src/app.mjs`: `pipelineGet` hands each
  country its list. Until then the per-country restrictions come from `market-rules.mjs` and `countries.mjs`.

## What you need to set

Nothing, and nothing paid: no new secret, no API key, no subscription. The migration runs with the deploy after the merge.
CJ stays optional, as in 🔎 Sourcing.
