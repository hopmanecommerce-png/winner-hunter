# Problem Database

It starts from problems, not products. It searches public posts and comments where people complain or ask for a
fix, keeps the ones that state a problem, and groups near-identical complaints into one **problem**. Each problem has a
title, one line, a life area, quotes with links, counts, a trend, an intensity and a willingness-to-pay signal. Products
come later: every problem has an empty `matched_products` list for that step. Nothing here searches for products or
suggests one.

```
problem-queries.json → problems-collect.mjs → D1 problem_mentions → problems-process.mjs → D1 problems → board: Problems tab
   (query bank)        (Scrape Creators API,     (posts and comments)   (dedupe, language,          (+ /api/problems,
                        hard credit cap)                                 grouping, scores; Claude     CSV and JSON export)
                                                                         step optional)
```

The workflow is **Actions → Problem Hunter** (`.github/workflows/problem-hunter.yml`). It is off by default: it only
runs when started by hand, and every run has a credit cap.

## Research (2026-11-01)

### The "creator scraper" API is Scrape Creators

The repository has no code for it yet. The TikTok tab is fed by `tiktok-import.mjs` from a file made outside the
repository, and `docs/learnings` (PR #29, Q2) still asks what that scraper outputs. The description (TikTok,
Instagram, YouTube, Reddit, X; paid per credit) matches **Scrape Creators** (scrapecreators.com). This build uses it
under the secret `SCRAPECREATORS_API_KEY`. The facts below are from its docs and `openapi.json`, read on 2026-11-01.
There was no key in this session, so no call was made.

- `https://api.scrapecreators.com`, header `x-api-key`, GET with query parameters.
- **1 credit per request** on every endpoint used here. Twitter search costs 1 credit even when it finds nothing; an
  empty TikTok comment page costs 0. The answer's body reports `credits_remaining` and `credits_charged`; there is no
  header for it. `GET /v1/account/credit-balance` returns the balance.
- **Price**: one-time packs, no subscription. Free: 100 credits. Freelance: $47 for 25,000 ($0.0019 a credit).
  Business: $497 for 500,000 ($0.001). The site says credits never expire, but the terms (2026-06-29) say they "may
  expire or be discontinued".
- **No rate limit** is enforced (the docs suggest staying under 500 requests at once). Status codes: 401 wrong key,
  402 out of credits, 403 blocked by the platform, 404, 500.
- **Terms**: you are responsible for each platform's own terms; "endpoints may stop working at any time". Answers go
  into a shared cache, which an account owner can switch off under API Keys.

| Platform | Keyword search | Comments | What you get | Used here |
|---|---|---|---|---|
| Reddit | `/v1/reddit/search` (whole site), `/v1/reddit/subreddit/search` (one subreddit: posts **and** matching comments) | `/v1/reddit/post/comments` (no sort, about 20 top-level comments a page, plus replies) | title, text, score, comment count, date, subreddit, link | **yes** (60% of credits) |
| YouTube | `/v1/youtube/search` (videos and Shorts) | `/v1/youtube/video/comments?order=top` (about 1,000 top comments at most) | title, views; comment text, likes, replies. Comment dates are estimates from "9 days ago" | **yes** (20%) |
| TikTok | `/v1/tiktok/search/keyword` (can repeat results) | `/v1/tiktok/video/comments` | caption, likes, comments, plays; comment text, likes | **yes** (20%) |
| X / Twitter | `/v1/twitter/search/posts`, through Google, not X's own search: incomplete and late | none (only a reply count) | text, likes, replies, date | optional: `twitter` |
| Threads | `/v1/threads/search`: at most 10 posts, no pages | per post only | text, likes, replies; no link field (built from user and code) | optional: `threads` |
| Bluesky | not in Scrape Creators, but Bluesky's own `app.bsky.feed.searchPosts` is free, with a language filter | – | text, likes, replies, language | optional: `bluesky` (free, no key) |
| Instagram | `/v2/instagram/reels/search`, through Google, best effort | `/v2/instagram/post/comments` (about 90% succeed; 15 credits with replies) | captions, comments | no: captions sell, comments are costly |
| Facebook groups | none: `/v1/facebook/group/posts` takes one public group's link, 3 posts a page | per post | post text, reactions | **no**: no keyword search, public groups only, Meta's terms |
| Pinterest | `/v1/pinterest/search` | none | pin title and description, no counts | no: ideas, not complaints |
| Google | `/v1/google/search` (title, link, snippet; up to page 11) | – | a question's title on Quora or gutefrage.net is often a problem | not built: `site:` support is undocumented |
| Amazon reviews, Trustpilot, Quora | **not offered** | – | – | – |

### Other sources: cheap and legitimate?

| Source | Search by keyword | Price, limits | Verdict |
|---|---|---|---|
| Reddit's own API | `/search`, `/r/{sub}/search`; comments per post | 100 requests a minute. Since the Responsible Builder Policy (Nov 2025) you need Reddit's approval, and written approval for commercial use; the public `.json` pages closed in 2026 | only through the vendor, or after approval |
| YouTube Data API v3 | `search.list` (100 calls a day of its own since 1 Jun 2026), `commentThreads.list` (1 unit, one video at a time) | free | fine for a live look, but its policy forbids aggregating and keeping unauthorised data over 30 days: not for this database |
| X API | recent search (7 days), 100 posts a request | pay per use: $0.005 a post read, $20 starting credit, no free tier | possible later (about $5 per 1,000 posts) |
| TikTok Research API | yes, with comments | academic and non-profit researchers only | **not possible** for a business. The Commercial Content API is ads only |
| Bluesky | `searchPosts` with `lang=nl` / `de` | free, 3,000 requests per 5 minutes per address; sometimes 403 to cloud servers | **built**, optional |
| Stack Exchange (diy, pets, parenting, gardening, lifehacks, cooking) | `/search/advanced` | free: 300 a day without a key, 10,000 with a free key; content is CC BY-SA (credit the author) | good next source (not built) |
| Lemmy: feddit.org (German), feddit.nl (Dutch) | `/api/v3/search` | free, no login; small | possible later for NL/DE |
| Hacker News (Algolia) | yes | free | no: a tech audience, few household problems |
| Mastodon | only logged in, only posts whose authors opted in | – | no (mastodon.social also bans scraping) |
| Quora | no API; robots.txt and terms block bots | via a search-results API: SerpApi $25 per 1,000, DataForSEO about $3 per 1,000 `site:` pages | later, through Google results only |
| gutefrage.net, Tweakers | no API, bot walls | via Google results | later, through Google results only |
| Pinterest API v5 | only your own pins (partner search is a closed beta) | – | **not possible** |
| Facebook groups | none: the Groups API was removed on 22 Apr 2024. Meta's Content Library is for researchers only | – | **not possible** |
| Amazon 1–3★ reviews | PA-API is replaced by the Creators API, which returns no reviews; review pages on .de and .nl need a login | vendors: Oxylabs about $0.50 per 1,000 results, ScraperAPI about $2.45 per 1,000, Apify from $3 per 1,000 reviews | **not now**: it starts from a product, and the terms forbid it. Fits the later matching step (complaints about competing products) |
| Trustpilot | its terms (v8.0, from 1 Oct 2026) forbid scraping and mining; its API covers only your own business; the Data Solutions API has a waitlist | – | **no** |
| Google Autocomplete and "People also ask" (DataForSEO) | yes | $0.0006 a request | cheap real Dutch and German phrasing, no personal data: a good later addition |

### Recommended plan and monthly budget

1. **Buy the Freelance pack** ($47, 25,000 credits; the free 100 credits are enough to try it first).
2. **Run 1, a dry run**: it shows what the next run would search and cost; it calls nothing and writes nothing.
3. **Run 2, `max_credits` 20**: check the run's summary (found, kept, dropped, credits). A run turns red when ten
   searches are answered but not one item can be read: the parsers follow the vendor's documented examples, and this
   run proves them on real answers.
4. **Then 100 credits a run**, about 33 searches, each with two comment pages: about $0.19 a run. Rough guess for one
   run: 1,000–2,500 posts and comments read, of which 15–30% state a problem.
5. **Daily, when you want it**: set `PROBLEMS_SCHEDULE` = `on` and `PROBLEMS_MONTHLY_CREDITS` = `3500`. That is about
   3,000 credits a month, **about $5.70 a month**; the pack lasts about 8 months. Twice the searches is about $11.40.
6. **Claude** (optional, `ANTHROPIC_API_KEY`): Claude Opus 5.5 by default, capped at $0.50 a run. A run names about 60
   problems in 5 calls; on the sample it took 1 call. With `PROBLEMS_CLAUDE_MODEL` = `claude-haiku-5-5` it costs about
   a fortieth. A problem whose quotes did not change keeps its name and is not sent again.

The searches cover every area in all three languages in turn: the first 48 Reddit searches hit every area once in
English, Dutch and German. The full plan (about 13,700 Reddit searches, 240 per video platform) takes months to walk
through, and starts again when it ends.

### What it cannot do (honestly)

- No Facebook groups, Amazon reviews, Trustpilot or Quora (see the tables).
- **The trend** comes from the dates of the posts the searches found, and searches find recent posts more easily. With
  30 or more mentions in both windows, the trend is a problem's share of everything found then; with fewer, the plain
  counts, which lean toward "rising". YouTube comment dates are estimates.
- **Language** (English, Dutch, German) is guessed from short words; **country** from cue words (a city, a shop,
  "gemeente"), the community (r/thenetherlands) or the language. English without a cue has no country.
- **Grouping is by words**, so the same problem in two languages is two problems. The Claude step can say they are one
  and merge them.
- The parsers were built from the vendor's documented answers, not from live ones (no key here). An answer whose
  shape changed shows up as items dropped (yellow) or nothing read (red), never as bad rows.

### Privacy and terms (GDPR)

- **Stored**: a post's or comment's id on its platform, its link, its text (cut to 2,000 characters), counts and
  dates. **No usernames**: an author becomes a 16-character hash, only to count different people. The Actions logs are
  public, so they hold counts only, never a quote; a test checks this.
- A public quote with its link is still personal data. The basis is legitimate interest (Art. 6(1)(f); a commercial
  interest can count since the EU Court's KNLTB ruling, C-621/22). Write a short legitimate-interest assessment and a
  privacy notice; Art. 14(5)(b) excuses telling each person only with safeguards like these.
- **Health complaints** (back and neck pain, sleep) are special-category data (Art. 9). The Dutch authority's
  scraping guidance (April 2025) reads the exceptions narrowly. To keep them out, set `PROBLEMS_SKIP_AREAS` =
  `back_neck_pain,sleep`.
- **Not built yet**: deleting the raw text after a while (a suggestion: 90 days, keeping the problems), and following
  deletions at the source. Do both before the database grows large.

## How it works

- **Query bank**: `winner-hunter/problem-queries.json`. It holds 76 complaint and need patterns in English, Dutch and
  German ("is there a way to", "weet iemand hoe ik ... kan oplossen", "nervt"), including every one asked for. It has
  16 life areas, each with keywords, topics and subreddits in each language, and general subreddits (r/mildlyinfuriating,
  r/thenetherlands, r/de, r/Finanzen…). It also holds the signal words that score a problem and the country cue words.
  Add lines anywhere: `test/problems.text.test.mjs` checks the file. Every area must be in each language, nothing may
  appear twice, subreddit names must be valid, and no search may contain a product word ("best", "buy", "kopen",
  "kaufen"…).
- **Collecting** (`problems-collect.mjs`):
  - Reddit searches a subreddit with a pattern ("is there a way to" in r/DIY), or the whole site with a pattern and a
    keyword (`"weet iemand hoe ik" kattenbak`). TikTok and YouTube search an area's topic ("dog hair everywhere"), and
    the complaints are in the comments.
  - For every search, the two most-discussed results get their comments read, unless that happened in the last 30 days.
  - It keeps posts and comments whose own words state a problem (a pattern, "I would pay", "I tried", or under a post:
    "same here").
  - A post or comment is one row: its platform id. Seen again, it gets its new counts.
  - Each platform has its own place in its plan (state `problem_cursor`), saved after every search.
  - The cap counts every request, retries included; the request that would pass it is never sent.
- **Processing** (`problems-process.mjs`, free):
  1. Language and country guesses.
  2. Copies count once: the same long text twice, or the same person with almost the same text.
  3. Words and word pairs, weighted by how rare they are (tf-idf; a word that occurs only once is left out). Complaint
     words never count, so "so annoying" does not glue two problems together. A comment also gets its post's title at
     half weight.
  4. Each mention joins the group it is most like, with a cosine of at least 0.3 and two shared words, or starts one;
     then alike groups merge. A group of two or more mentions is a problem.
  5. A problem keeps the id most of its mentions had before, so your decision stays with it. Same input, same output.
- **Scores**:
  - **intensity** (0–100): half how upset the words are (signal words, "!!", CAPITALS), 0.3 engagement (log scale),
    0.2 how many mention it.
  - **wtp** (0–100): per mention, "I would pay" counts 1, looking for a fix or asking how 0.4, "I tried X and Y" 0.3;
    divided by the mentions (at least 3).
  - **trend**: the last 90 days against the 90 before. Rising: ×1.5 or more and 3+ recent. Falling: ×0.67 or less.
    New: the first post is from the last 60 days.
- **Claude step** (`lib/problem-llm.mjs`, optional):
  - Problems with 3+ mentions go in batches by area. For each, Claude gives a 3–8 word title, a one-line statement,
    and whether it is a real problem, and says which problems are the same, also across languages.
  - The prompt forbids products, brands, fixes and tips, and the answer's schema has no field for them. A name that
    still mentions one is thrown away.
  - Quotes are data: no tag of ours can be closed from inside one.
  - Before each call, its worst case (all input, 8,000 tokens out, at the dearest price a fallback can be billed) must
    fit in what is left of the cap.
- **Board**: the **Problems** tab, next to TikTok. Filters: category, language, country, platform, fewest mentions,
  trend, "Would pay". Search covers titles and quotes. Sort by intensity, mentions, growth, engagement, willingness to
  pay or newest. Each problem opens to its quotes with links ("More quotes" reads up to 50). Save, ★ Star and Ignore
  are kept in `problem_decisions`; tap again to take one back. CSV and JSON export what the filters show. It is behind
  the same PIN as the rest of the board.

## Turn it on

1. **Secrets** (Settings → Secrets and variables → Actions): `SCRAPECREATORS_API_KEY`. `CF_API_TOKEN` (or
   `CF_D1_TOKEN`) and `CF_ACCOUNT_ID` are already there. Optional: `ANTHROPIC_API_KEY`.
2. **Merge**: the deploy makes the tables (migration `0040_problems.sql`, new tables only), and the board shows an
   empty Problems tab.
3. **Actions → Problem Hunter → Run workflow** with `dry_run` ticked, then with `max_credits` 20, then 100 (see the
   plan above).
4. **Daily** (optional), with repository variables (Settings → Secrets and variables → Actions → Variables):

| Variable | Default | What |
|---|---|---|
| `PROBLEMS_SCHEDULE` | (off) | `on`: one run a day at 04:41 UTC |
| `PROBLEMS_MAX_CREDITS` | 100 | the most a scheduled run spends |
| `PROBLEMS_MONTHLY_CREDITS` | (none) | the most a calendar month spends, all runs together |
| `PROBLEMS_PLATFORMS` | reddit,youtube,tiktok | also threads, twitter, bluesky |
| `PROBLEMS_SKIP_AREAS` | (none) | areas never searched, e.g. `back_neck_pain,sleep` |
| `PROBLEMS_CLAUDE` | (off) | `on`: the Claude step on scheduled runs (needs `ANTHROPIC_API_KEY`) |
| `PROBLEMS_CLAUDE_MAX_USD` | 0.50 | the most the Claude step spends a run |
| `PROBLEMS_CLAUDE_MODEL` | claude-opus-5-5 | e.g. `claude-haiku-5-5` (about a fortieth of the cost) |

Run it on your own computer: `SCRAPECREATORS_API_KEY=… PROBLEM_MAX_CREDITS=20 CF_API_TOKEN=… CF_ACCOUNT_ID=… node
winner-hunter/problems-collect.mjs`, then `node winner-hunter/problems-process.mjs`. `PROBLEM_DRY_RUN=1` spends and
writes nothing. The settings are listed at the top of both files.

## For matching products later

- **API**: `GET /api/problems?view=all&limit=200&offset=0` (then `offset=200`…) lists every problem with its id,
  statement, area, languages, countries, counts, scores, quotes with links and `matched_products`. It uses the board's
  PIN cookie (`POST /login` with the PIN). `GET /problems.json?view=all` gives all of them in one file.
- **D1**: a script in this repository can read the `problems` table with `lib/d1.mjs`, like the hunts do.
- **`matched_products`**: a JSON list, `[]` today. Processing never writes it, and keeps whatever a later step puts
  there. A suggested shape: `[{"product_key": "store.com/products/x", "title": "…", "url": "https://…", "score": 0.8,
  "why": "…", "at": "2026-…"}]`.

## Sample data

`winner-hunter/test/fixtures/problems/` holds **made-up** sample data for the tests: 48 hand-written posts and comments
in English, Dutch and German, eight problems among them, and API answers shaped like the vendor's examples. None of it
is real, and none of the links exist. Rows have `sample = 1`, and the board says so with a banner and a tag. Real runs
never read sample rows, and sample processing never touches real ones.
