# Finding new Lasso stores every week: which methods work

Research for Winner Hunter, 2026-11-02, one day after the first Lasso report (`lasso-stores.md`, 143 stores). Every
method below was run on real data on 2026-11-02 and every store it gave was checked live the same way: the store page,
then `checkout.<store>/checkout` (`lib/lasso.mjs` `checkLassoStore`). **Lasso now** = Lasso's script on the store page
and/or Lasso's checkout app on its checkout address (the board's "Lasso checkout" filter counts both). **New** = not one of
the 143 research stores and not one of their aliases. **Live** = the shop is open (not closed by Shopify, not a password
page, not gone). The verified list is `docs/research/lasso-discovery-2026-11-02.csv` (271 stores, 180 live).

## In short

- **Reverse DNS is the big source.** A Lasso checkout is a DNS record `checkout.<store>` → CNAME
  `1a28dfb57b1e1efc.vercel-dns-016.com`. Of the hostnames that point there, **82 to 86 % serve Lasso's checkout app
  now** (WhoisFreaks sample 188 of 224, OTX 79 of 92, Mnemonic 23 of 28; the rest are mostly gone). WhoisFreaks counts
  **3,153** such hostnames: about 2,650 Lasso checkouts, about 1,900 of them open shops (61 % of the sample), well over
  StoreLeads' 1,316.
- **Two free reverse-DNS sources need no account:** AlienVault OTX and Mnemonic's passive DNS. Together: 114 domains,
  97 on Lasso now, **92 new**, 52 of them live shops. They go into the weekly job.
- **The full list (3,153 hostnames) needs a WhoisFreaks account.** Without one, its pages show 7 hostnames of every
  100: that sample alone gave **173 new Lasso stores (122 live)**. The job cannot use WhoisFreaks without a new secret, so
  the 115 live stores only that sample found are in `winner-hunter/lasso-extra.txt`, which the job checks and imports.
- **urlscan.io stays the source of the freshest stores** (14 of its stores joined Lasso in the last 30 days), but its
  existing five searches only re-find the research list (1 new). Searching for **Whop's pixel** (`domain:t.whop.tw`,
  which Lasso stores load) adds 6 new stores, Lasso's second script (`subscriptions-script.js`) 2 more.
- **Ad landing pages hold few Lasso stores: about 1 in 100.** 541 stores from active Meta ads gave 5 Lasso stores (all
  new). The board's own keywords: 3 of 390; keywords of products Lasso stores sell: 2 of 151; "family boutique" and
  "closing-down sale" ads: 0 of 102. Checking the stores already on the board is free, so the job does it; paid ad
  searches through Scrape Creators are capped (50 credits ≈ $0.09 a week).
- **Nothing at all** came from: Lasso's own site (no customers, case studies or logos), web search, certificate
  transparency (no search across domains), Google's advertiser search (it matches names from the start only), Lasso
  stores' Facebook pages (0 sister domains in 29 pages) and the exact titles of their best sellers (not in the search index).
- **Corrections to the first report:** the second Vercel address (`e4e52b5c1254e1d1.vercel-dns-016.com`) is **not**
  Lasso (0 of 147: peptide and supplement shops on another checkout); Lasso stores can integrate without
  `lasso-script` on the store page (inline code, or `shopify-scripts/subscriptions-script.js`); and a urlscan search by
  the script's hash finds fewer scans than by its name (49 against 330: the file changes during the month).

## 1. What was tested, and what it gave

All on 2026-11-02. "Checked": distinct store domains checked live.

| Method | How it was run | Checked | Lasso now | Live | Precision | New | New and live | Cost |
|---|---|---|---|---|---|---|---|---|
| urlscan, the five searches of `lasso.mjs` (script names v4/v2/v1, `domain:lassocheckout.com`, checkout pages) | 30 days, 2-day windows, 75 searches | 181 | 136 | 129 | 75 % | 1 | 1 | free |
| urlscan, Whop's pixel `domain:t.whop.tw` | 30 days, 19 searches (1,169 scans) | 674 | 84 | 81 | 12 % | 6 | 6 | free |
| urlscan, Whop's payment elements `domain:cdn.whop.com` | 30 days | 58 | 1 | 1 | 2 % | 1 | 1 | free |
| urlscan, `filename:"subscriptions-script.js"` / `.min.js` | 30 days | 3 | 2 | 2 | 67 % | 2 | 2 | free |
| urlscan, `filename:"lasso-favicon.png"` (Lasso's customer portals) | 30 days | 10 | 7 | 7 | 70 % | 0 | 0 | free |
| urlscan, "Secure Checkout" on Vercel, `secure.*` checkout pages | 30 days | 40 | 19 | 16 | 48 % | 0 | 0 | free |
| **Reverse CNAME, WhoisFreaks** (`1a28…vercel-dns-016.com`, logged out: 7 of every 100) | 32 pages | 224 | 188 | 137 | 84 % | **173** | **122** | the full 3,153: free account (500 credits) or $75/month |
| Reverse CNAME, WhoisFreaks, the portal address `lasso-customer-portal.pages.dev` | 1 page (7 of 95) | 7 | 6 | 5 | 86 % | 4 | 3 | as above |
| Reverse CNAME, WhoisFreaks, the second Vercel address `e4e52b5c…` | 21 pages (147 of 2,074) | 147 | **0** | 0 | 0 % | 0 | 0 | — |
| **Passive DNS, AlienVault OTX** (`/api/v1/indicators/hostname/<target>/passive_dns`) | 1 call (slow: 504s, retried) | 92 | 79 | 42 | 86 % | **76** | **39** | free, no key |
| **Passive DNS, Mnemonic** (`api.mnemonic.no/pdns/v3/<target>`) | 1 call | 28 | 23 | 18 | 82 % | **20** | **15** | free, no key |
| Meta ads: landing pages for the board's own keywords (EU, Meta's API) | 8 searches, 250 ads each | 368 | 2 | 2 | 0.5 % | 2 | 2 | free (API); 1 credit a search via Scrape Creators |
| Meta ads: landing pages for products Lasso stores sell (orthopedic shoes, quilted baskets, copper bracelets, Komforthose…) | 8 searches (EU API) | 117 | 2 | 2 | 1.7 % | 2 | 2 | as above |
| Meta ads: the same outside the EU (public Ad Library) | 16 searches, 5 answered | 56 | 1 | 1 | 1.8 % | 1 | 1 | as above |
| Meta ads: story angles ("family boutique", "closing down sale", "Räumungsverkauf", "opheffingsuitverkoop") | 6 searches (EU API) | 102 | 0 | 0 | 0 % | 0 | 0 | — |
| Facebook pages of known Lasso stores: the other domains their ads link to (Scrape Creators' "company ads") | 29 pages, public Ad Library | 0 other domains | 0 | — | — | 0 | 0 | 1 credit a page |
| Google's advertiser search (what Scrape Creators' `advertisers/search` returns): city and "boutique" names | 8 searches, public Transparency Center | 2 | 0 | — | — | 0 | 0 | 1 credit a search |
| Web search: exact best-seller titles of Lasso stores ("Marta" "Hand-Quilted Basket"…), as a stand-in for Scrape Creators' Google search | 3 searches, ~50 results | 0 stores | 0 | — | — | 0 | 0 | 1 credit a search |
| Web search: `"lassocheckout.com"`, `"lasso-script-v4.min.js"`, "Lasso checkout" + Shopify | 3 searches | 0 stores | — | — | — | 0 | 0 | — |
| Lasso's own site: sitemap (37 pages), home, old home, resources, `/customers`, `/case-studies` | all pages | 0 stores | — | — | — | 0 | 0 | — |
| Certificate transparency: crt.sh `checkout.%`, Cert Spotter | 3 broad searches (all 502), per-domain works | 0 | — | — | — | 0 | 0 | — |
| Other passive DNS without a key: rapiddns, dnsrepo, HackerTarget, VirusTotal | 1 each | 0 | — | — | — | 0 | 0 | — |

What the numbers mean:

- **Precision** is the share of checked domains on Lasso now. Reverse DNS is exact by nature (the record *is* the
  checkout); the rest of its hostnames are mostly closed stores whose checkout record is still there.
- **"Live"** matters: of the 271 new Lasso stores, 91 are not open shops (Shopify 402/423, password pages, gone). Their
  checkout record and Lasso's app are still there. The weekly job saves them (a shop can reopen) but counts only live
  stores as new.
- **Overlap is small.** OTX and the WhoisFreaks sample share 8 hostnames, Mnemonic and WhoisFreaks 1: each source sees
  another slice, so more sources = more stores.
- **The dashboard itself:** this session has no Cloudflare key, so the board's own store list could not be read. The
  stand-in is the first Meta row above: the stores the board's own keywords find. About 1 in 200 (EU) to 1 in 20 (outside
  the EU, a small sample) is on Lasso. Free to check, and every hit is a store whose products are already on the board.
- **Scrape Creators was not called** (its key is only in GitHub's secrets). Its Meta search returns the same public Ad
  Library data that was tested here through Meta's API and the public site, and its Google advertiser search is the
  same search box as the public Transparency Center. The cost per search is its documented price (1 credit).

## 2. What changed about the fingerprints

- **A second Lasso script:** `https://checkout.<store>/shopify-scripts/subscriptions-script.js` (and `.min.js`), with the
  same `data-store-id` and `data-checkout-url` (seen on elevarekoreanbeauty-global.com, kittysupps.com,
  theholyfaith.com, insentials.com). `findLasso()` now reads it too.
- **Lasso without its script on the store page:** forgefjord.com runs Lasso from theme code
  (`snippets/lasso-checkout-guard.liquid`, `lassoArmed()`), others have no Lasso code on the home page, cart or product
  pages at all while `checkout.<store>/checkout` serves Lasso's app. These come out "likely" (medium), as before.
- **Whop's pixel** (`https://t.whop.tw`, `whop.track(…)`) is on Lasso store pages, also on those without the script:
  that is why urlscan's `domain:t.whop.tw` finds Lasso stores the script searches miss. Other Whop sellers load it too
  (12 % precision).
- **The checkout CNAME is Lasso's:** 84 % of the hostnames on `1a28dfb57b1e1efc.vercel-dns-016.com` serve Lasso's app.
  The first report called it "no proof" because one store pointed there with another app ("Revio"); that is the exception.
  `e4e52b5c1254e1d1.vercel-dns-016.com` is someone else's (0 of 147).
- **A store's first certificate dates its start:** `checkout.tryglowgummies.com` got its first certificate on 2026-06-26,
  the day after its Lasso store id says it joined (2026-06-25). Certificate search cannot list stores, it can only date one.
- **urlscan without a key:** 30 searches a minute per address (header `x-rate-limit-limit: 30`), 100 results a search,
  the last 30 days. The job asks one search every 2.1 seconds.

## 3. How many new stores a week

- **Stores joining Lasso**, from the join dates in the store ids of the 255 verified stores that show one: 4 to 17 a week
  since August, 8 on average. That is only the part we can see; with a universe of 2,000+ stores the real number is
  likely several times higher.
- **Which sources see new stores early** (stores that joined Lasso in the last 30 days, of the ones with a join date):
  urlscan 14 of 118, WhoisFreaks sample 15 of 103, Mnemonic 4 of 13, OTX 1 of 24, ad landing pages 0 of 0 (none showed a
  store id).
- **The built job, run once on live data** (2026-11-02, sources dns + urlscan (4 days) + extra, without D1, so nothing
  was saved): 425 domains checked, 255 on Lasso (161 sure, 94 likely), passive DNS 100 of its 114, 22 urlscan searches
  without an error, health ok. Against the research list, **172 live stores would have been new** (extra 114, dns 53,
  urlscan 5), and stores with several domains came out as one (danelora.com ← danelora.dk, weldnewyork.co ←
  weldnewyork.com).
- **What to expect from the weekly job:** the first run should add about 180 live stores (115 from `lasso-extra.txt`,
  about 55 from passive DNS, about 10 from urlscan, the rest from the board and ads). After that, an estimate: **10 to 30 a week**
  (urlscan's new scans, what OTX and Mnemonic see for the first time, about 1 % of the new stores on the board, about 1 %
  of the ad landing pages). The job's run summary and the board's indicator show the real number per source.

## 4. The weekly job (built: `winner-hunter/lasso.mjs`, workflow **Lasso stores**)

| Source (`LASSO_SOURCES`) | What it asks | Why | Cost |
|---|---|---|---|
| `dns` | OTX and Mnemonic: who points at `1a28dfb57b1e1efc.vercel-dns-016.com` and `lasso-customer-portal.pages.dev` | 85 % precision, most new stores per request | free, no key |
| `urlscan` | the five searches of the first report + `domain:t.whop.tw`, `domain:cdn.whop.com`, `filename:"subscriptions-script.js"`, `filename:"subscriptions-script.min.js"`, `filename:"lasso-favicon.png"`, last 30 days | the freshest stores | free (`URLSCAN_API_KEY` optional) |
| `board` | every shop on the board (EU winners of 60 days, outside the EU, Google, TikTok's Meta shops) not checked in 30 days, at most 300 a run | free, and every hit lights up products already on the board | free |
| `ads` | Scrape Creators' Meta Ad Library search, one page (≈30 ads) per keyword of `lasso-keywords.txt`, the next keywords each week | stores that advertise now; about 1 % are on Lasso | 1 credit a search, **hard cap `LASSO_CREDITS`, 50 by default** (≈ $0.09 at the $47 pack) |
| `extra` | `lasso-extra.txt` (the 115 live stores only the WhoisFreaks sample found), the `extra` box, `LASSO_EXTRA_FILE` | a way in for lists from elsewhere (a WhoisFreaks export) | free |

Then, every run: each candidate is checked live; the same store under another domain is merged (the board's
registrable domain, the address it redirects to, the same Lasso store id: one store with aliases); a domain checked in
the last 30 days is not checked again (`lasso_candidates`); every store saved before is checked again; a store's
checkout on another of its domains is checked once. Every store with a Lasso sign is saved; one found for the first time
gets **`source`** (the method that found it) and **`found_at`** (the day the job found it), and counts as **new** when it
is live and on Lasso now (sure or likely). The board's "Lasso checkout" filter picks it up at its next read (within 15
minutes) and its chip shows **"+N new"**: the live Lasso stores found in the last 7 days.

No AI step: the fingerprints are exact, so nothing is classified (Jev is not needed). Nothing is filtered by product type:
a store that sells digital products (northstarwellco.com sells an e-book) is saved like any other.

Not built, and why:

- **WhoisFreaks' API** (the full 3,153, 32 calls a pull) needs a new secret. One-off instead: sign up (free 500 credits),
  export the reverse-CNAME list of `1a28dfb57b1e1efc.vercel-dns-016.com`, put the hosts in `winner-hunter/lasso-extra.txt`
  (or run with `LASSO_EXTRA_FILE`). The job checks them and keeps the live ones.
- **StoreLeads** ($250/month with export), **HTTP Archive** (BigQuery, a Google Cloud key and several dollars a query),
  **PublicWWW / NerdyData** (paid source-code search): new accounts and keys.
- **Google search, Google's advertiser search and Facebook page expansion** through Scrape Creators: 0 stores in the tests.

## 5. What Connor must set

- **Nothing new to start:** the existing secrets `CF_API_TOKEN` (or `CF_D1_TOKEN`) and `CF_ACCOUNT_ID` save the stores;
  `SCRAPECREATORS_API_KEY` (already there for the Google hunt) pays for the ad searches; `URLSCAN_API_KEY` stays optional.
- **Weekly:** the repository variable `LASSO_STORES` = `on` (Settings → Secrets and variables → Actions → Variables).
  Without it the job only runs by hand (Actions → Lasso stores → Run workflow).
- **The credit cap:** the repository variable `LASSO_CREDITS` (default 50 per run; `0` = free sources only). If
  `LASSO_STORES` was already `on`, the Monday run now also spends up to 50 credits: set `LASSO_CREDITS` = `0` to keep it free.
- **Try it first:** Run workflow with **dry run** ticked: it finds and checks, saves nothing, and lists the new stores in
  the run's artifact.

## 6. Caveats

- Reverse DNS and urlscan only show what their sensors and users saw. A store nobody resolved or scanned stays unseen.
- OTX is slow and often answers 504: the job asks it again (4 tries, 15 seconds apart and more), and a miss is a warning.
- "Likely" stores (Lasso's checkout app, no Lasso code on the store page) may have switched Lasso off on the storefront
  while their checkout record stays.
- The WhoisFreaks sample was read without an account, 54 page views by hand on 2026-11-02; the job does not read
  WhoisFreaks.
- The same caveats as the first report: copy the product, not the "local family boutique" story; supplements,
  cosmetics and medical claims need EU paperwork; this repository and its lists are public.

## Sources

- urlscan.io search API (rate-limit headers): https://urlscan.io/api/v1/search/?q=domain:t.whop.tw
- AlienVault OTX passive DNS: https://otx.alienvault.com/api/v1/indicators/hostname/1a28dfb57b1e1efc.vercel-dns-016.com/passive_dns
- Mnemonic passive DNS: https://api.mnemonic.no/pdns/v3/1a28dfb57b1e1efc.vercel-dns-016.com
- WhoisFreaks reverse CNAME: https://whoisfreaks.com/tools/dns/reverse/lookup/cname/1a28dfb57b1e1efc.vercel-dns-016.com
- Meta Ad Library API (`ads_archive`) and the public Ad Library: https://www.facebook.com/ads/library/
- Google Ads Transparency Center: https://adstransparency.google.com/
- Scrape Creators API (endpoints, parameters, 1 credit a call): https://docs.scrapecreators.com/llms.txt
- Certificates: https://crt.sh/?q=checkout.tryglowgummies.com, https://api.certspotter.com/v1/issuances
- Lasso: https://lassocommerce.com/sitemap.xml
