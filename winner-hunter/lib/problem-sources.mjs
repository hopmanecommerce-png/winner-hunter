/*
 * Where the Problem Database finds posts: the Scrape Creators API (https://docs.scrapecreators.com, header x-api-key,
 * 1 credit per request on every endpoint used here). docs/problem-db/README.md has what each endpoint gives and costs.
 *   const sc = scrapeCreators({ key, maxCredits: 100 });   a client that never sends request number 101
 *   const json = await sc.get('/v1/reddit/search', { query: '"is there a way to" dog' });
 *   SOURCES.reddit.search(item) → { path, params };  SOURCES.reddit.parseSearch(json, item) → posts and comments
 * Every parser turns the platform's answer into one shape, a mention:
 *   { id: 'reddit:t3_abc', platform, kind: 'post' | 'comment', parent_id, url, community, title, body, score, replies,
 *     created_at (ISO or ''), author (only hashed before it is saved), rank (how popular, to pick what to open) }
 * A field the answer lacks is left empty, never guessed; an item without an id, a text or a link of that platform is
 * dropped (counted in `dropped`), so a changed answer shows up as dropped items in the run summary instead of bad rows.
 */
import { plainText, textHash } from './problem-text.mjs';

export const API = 'https://api.scrapecreators.com';
export const MAX_RUN_CREDITS = 5000; // a run never asks for more, whatever the setting says

const num = (x) => {
  const n = typeof x === 'string' ? Number(x.replace(/[, ]/g, '')) : Number(x);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
/** An ISO time from unix seconds, milliseconds or a date string; '' when there is none. */
export function isoOf(x) {
  if (x == null || x === '') return '';
  let t;
  if (typeof x === 'number' || /^\d{9,13}$/.test(String(x))) {
    const n = Number(x);
    t = n > 1e11 ? n : n * 1000;
  } else t = Date.parse(String(x));
  return Number.isFinite(t) && t > Date.UTC(2004, 0, 1) && t < Date.now() + 2 * 864e5 ? new Date(t).toISOString() : '';
}
const hostOf = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' ? x.hostname.toLowerCase().replace(/^(www|m|old|new)\./, '') : '';
  } catch (e) {
    return '';
  }
};
const DOMAINS = {
  reddit: ['reddit.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com', 'youtu.be'],
  threads: ['threads.com', 'threads.net'],
  twitter: ['x.com', 'twitter.com'],
  bluesky: ['bsky.app'],
};
/** An https link on the platform's own site, else ''. */
export function platformUrl(platform, u, sites = []) {
  const h = hostOf(u);
  const ok = (DOMAINS[platform] || sites).some((d) => h === d || h.endsWith('.' + d));
  return ok ? String(u).slice(0, 500) : '';
}
const textOf = (s, max) => {
  const t = plainText(s, max);
  return /^\[(deleted|removed)\]$/i.test(t) ? '' : t;
};

/** A mention in its one shape, or null when it lacks an id, a text or a link of its platform. */
function mention(m, sites) {
  const url = platformUrl(m.platform, m.url, sites);
  const title = textOf(m.title, 300);
  const body = textOf(m.body, m.kind === 'comment' ? 1000 : 2000);
  // A comment needs words of its own (its title is its post's); a post needs a title or a text.
  if (!m.id || !url || !(m.kind === 'comment' ? body : title || body)) return null;
  return {
    id: String(m.id).slice(0, 120), platform: m.platform, kind: m.kind, parent_id: m.parent_id ? String(m.parent_id).slice(0, 120) : '', url,
    community: String(m.community || '').slice(0, 80), title, body, score: num(m.score), replies: num(m.replies), created_at: isoOf(m.created_at),
    author: m.author ? String(m.author).slice(0, 100) : '', rank: num(m.rank) || 0, lang_hint: /^[a-z]{2}$/.test(m.lang_hint || '') ? m.lang_hint : '',
  };
}
/** Keeps the mentions that are whole, counting the rest. */
function collectItems(raw, sites) {
  const items = [];
  let dropped = 0;
  const seen = new Set();
  for (const m of raw) {
    const x = mention(m, sites);
    if (!x) dropped++;
    else if (!seen.has(x.id)) { seen.add(x.id); items.push(x); }
  }
  return { items, dropped };
}
const list = (x) => (Array.isArray(x) ? x : []);
const redditId = (id, prefix) => {
  const s = String(id || '');
  if (!s) return '';
  return /^t[13]_/.test(s) ? s : `${prefix}_${s}`;
};
const redditUrl = (p, sub) => {
  if (p.permalink) return 'https://www.reddit.com' + (String(p.permalink).startsWith('/') ? '' : '/') + p.permalink;
  if (/^https:\/\/(www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\//.test(String(p.url || ''))) return p.url;
  const id = String(p.id || '').replace(/^t3_/, '');
  return sub && id ? `https://www.reddit.com/r/${sub}/comments/${id}/` : '';
};
const subName = (s) => (s && typeof s === 'object' ? s.name || '' : s || '');

// ---------------------------------------------------------------------------
// The platforms
// ---------------------------------------------------------------------------

function redditPost(p, item) {
  const sub = subName(p.subreddit) || (item && item.sub) || '';
  const id = redditId(p.name || p.id || p.post_id, 't3');
  return {
    id: id ? 'reddit:' + id : '', platform: 'reddit', kind: 'post', url: redditUrl(p, sub), community: sub,
    title: p.title, body: p.selftext || p.body || '', score: p.score ?? p.ups ?? p.votes, replies: p.num_comments,
    created_at: p.created_at_iso || p.created_utc || p.created_at || p.created, author: p.author, rank: p.num_comments,
  };
}
function redditComment(c, post) {
  const sub = subName(c.subreddit) || (post && post.community) || '';
  const parent = c.post_id || (c.post && c.post.id) || (post && post.id && post.id.replace(/^reddit:/, '')) || '';
  const id = redditId(c.name || c.id, 't1');
  return {
    id: id ? 'reddit:' + id : '', platform: 'reddit', kind: 'comment', parent_id: parent ? 'reddit:' + redditId(parent, 't3') : '',
    url: c.permalink ? 'https://www.reddit.com' + c.permalink : c.url, community: sub,
    title: (c.post && c.post.title) || (post && post.title) || '', body: c.body, score: c.score ?? c.ups ?? c.votes, replies: c.replies && Array.isArray(c.replies.items) ? c.replies.items.length : null,
    created_at: c.created_at_iso || c.created_utc || c.created_at, author: c.author, rank: c.score ?? c.votes,
  };
}

function tiktokVideo(raw) {
  const v = (raw && (raw.aweme_info || raw.search_aweme_info)) || raw || {};
  const id = String(v.aweme_id || v.id || '');
  const user = (v.author && v.author.unique_id) || '';
  const s = v.statistics || v.stats || {};
  return {
    id: id ? 'tiktok:v_' + id : '', platform: 'tiktok', kind: 'post', url: v.url || v.share_url || (user && id ? `https://www.tiktok.com/@${user}/video/${id}` : ''),
    title: v.desc, body: '', score: s.digg_count, replies: s.comment_count, created_at: v.create_time_utc || v.create_time, author: user,
    rank: (num(s.comment_count) || 0) * 1000 + Math.min(999, Math.round((num(s.play_count) || 0) / 1e6)), lang_hint: v.desc_language,
  };
}

function youtubeVideo(v) {
  return {
    id: v.id ? 'youtube:v_' + v.id : '', platform: 'youtube', kind: 'post', url: v.url || (v.id ? `https://www.youtube.com/watch?v=${v.id}` : ''),
    title: v.title, body: v.description || '', score: v.likeCountInt ?? v.likes ?? null, replies: v.commentCountInt ?? null,
    created_at: v.publishedTime, author: v.channel && (v.channel.id || v.channel.handle), community: '', rank: v.viewCountInt,
  };
}

/** What each platform can search ('sub', 'search', 'topic': see planFor in problem-bank.mjs), and how. */
export const SOURCES = {
  reddit: {
    modes: ['sub', 'search'],
    search: (item, opts = {}) => (item.mode === 'sub'
      ? { path: '/v1/reddit/subreddit/search', params: { subreddit: item.sub, query: item.q, sort: 'relevance', timeframe: opts.timeframe || 'year' } }
      : { path: '/v1/reddit/search', params: { query: item.q, sort: 'relevance', timeframe: opts.timeframe || 'year' } }),
    parseSearch(j, item) {
      const raw = list(j && j.posts).map((p) => redditPost(p, item)).concat(list(j && j.comments).map((c) => redditComment(c, null)));
      return collectItems(raw);
    },
    comments: (post) => ({ path: '/v1/reddit/post/comments', params: { url: post.url, trim: 'true' } }),
    parseComments(j, post) {
      const raw = [];
      for (const c of list(j && j.comments)) {
        raw.push(redditComment(c, post));
        for (const r of list(c.replies && c.replies.items).slice(0, 5)) raw.push(redditComment(r, post));
      }
      return collectItems(raw);
    },
  },
  tiktok: {
    modes: ['topic'],
    search: (item) => ({ path: '/v1/tiktok/search/keyword', params: { query: item.q, sort_by: 'relevance', trim: 'true' } }),
    parseSearch: (j) => collectItems(list(j && j.search_item_list).map(tiktokVideo)),
    comments: (post) => ({ path: '/v1/tiktok/video/comments', params: { url: post.url, trim: 'true' } }),
    parseComments(j, post) {
      const raw = list(j && j.comments).map((c) => {
        const cid = c.cid || c.id || '';
        // No comment id in a short answer: the text and time make one, so the same comment is still one row.
        const id = cid ? 'tiktok:c_' + cid : c.text ? 'tiktok:h_' + textHash(`${post.id}|${c.create_time}|${c.text}`) : '';
        return {
          id, platform: 'tiktok', kind: 'comment', parent_id: post.id, url: post.url, title: post.title, body: c.text, score: c.digg_count,
          replies: c.reply_comment_total, created_at: c.create_time, author: (c.user && (c.user.unique_id || c.user.uid)) || '', lang_hint: c.comment_language, rank: c.digg_count,
        };
      });
      return collectItems(raw);
    },
  },
  youtube: {
    modes: ['topic'],
    search: (item) => ({ path: '/v1/youtube/search', params: { query: item.q, sortBy: 'relevance' } }),
    parseSearch: (j) => collectItems(list(j && j.videos).concat(list(j && j.shorts)).map(youtubeVideo)),
    comments: (post) => ({ path: '/v1/youtube/video/comments', params: { url: post.url, order: 'top' } }),
    parseComments(j, post) {
      const vid = post.id.replace(/^youtube:v_/, '');
      const raw = list(j && j.comments).map((c) => ({
        id: c.id ? 'youtube:c_' + c.id : '', platform: 'youtube', kind: 'comment', parent_id: post.id,
        // A comment has no link of its own: lc= opens the video at that comment.
        url: c.id ? `https://www.youtube.com/watch?v=${encodeURIComponent(vid)}&lc=${encodeURIComponent(c.id)}` : '', title: post.title, body: c.content,
        score: c.engagement && c.engagement.likes, replies: c.engagement && c.engagement.replies, created_at: c.publishedTime,
        author: c.author && (c.author.id || c.author.handle || c.author.name), rank: c.engagement && c.engagement.likes,
      }));
      return collectItems(raw);
    },
  },
  threads: {
    // At most 10 posts a search and no pages (docs), and no comment list here: cheap, but thin.
    modes: ['search'],
    search: (item) => ({ path: '/v1/threads/search', params: { query: item.q.replace(/"/g, '') } }),
    parseSearch: (j) => collectItems(list(j && j.posts).map((p) => {
      const user = p.user && p.user.username;
      return {
        id: p.id || p.pk ? 'threads:' + (p.id || p.pk) : '', platform: 'threads', kind: 'post', url: user && p.code ? `https://www.threads.com/@${user}/post/${p.code}` : '',
        title: '', body: p.caption && p.caption.text, score: p.like_count, replies: p.text_post_app_info && p.text_post_app_info.direct_reply_count,
        created_at: p.taken_at, author: user, rank: p.like_count,
      };
    })),
    comments: () => null,
  },
  twitter: {
    // Found through Google, not X's own search (docs): incomplete and late. 1 credit even for an empty page.
    modes: ['search'],
    search: (item) => ({ path: '/v1/twitter/search/posts', params: { query: item.q } }),
    parseSearch: (j) => collectItems(list(j && j.posts).map((p) => {
      const l = p.legacy || {};
      return {
        id: p.rest_id ? 'twitter:' + p.rest_id : '', platform: 'twitter', kind: 'post', url: p.url, title: '', body: l.full_text || l.text,
        score: l.favorite_count, replies: l.reply_count, created_at: l.created_at, author: (p.url && String(p.url).split('/')[3]) || '', rank: l.favorite_count,
      };
    })),
    comments: () => null,
  },
  bluesky: {
    // Not Scrape Creators: Bluesky's own public search (free, no key, a language filter). `free`: its calls never count as
    // credits; PROBLEM_MAX_FREE_CALLS caps them. It can answer 403 to cloud servers at busy times (docs/problem-db).
    free: true,
    base: 'https://api.bsky.app',
    modes: ['search'],
    search: (item) => ({ path: '/xrpc/app.bsky.feed.searchPosts', params: { q: item.q, lang: item.lang, limit: '50', sort: 'top' } }),
    parseSearch: (j) => collectItems(list(j && j.posts).map((p) => {
      const rkey = String(p.uri || '').split('/').pop();
      const handle = p.author && p.author.handle;
      const rec = p.record || {};
      return {
        id: p.uri ? 'bluesky:' + String(p.uri).replace(/^at:\/\//, '') : '', platform: 'bluesky', kind: 'post', url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : '',
        title: '', body: rec.text, score: p.likeCount, replies: p.replyCount, created_at: rec.createdAt || p.indexedAt, author: p.author && p.author.did, rank: p.likeCount,
        lang_hint: Array.isArray(rec.langs) ? rec.langs[0] : '',
      };
    })),
    comments: () => null,
  },
};

/** The platforms that work today. Google site: searches (Quora, gutefrage.net) are not here: see docs/problem-db. */
export const PLATFORMS = Object.keys(SOURCES);
export const DEFAULT_PLATFORMS = ['reddit', 'youtube', 'tiktok'];
export const DEFAULT_WEIGHTS = { reddit: 3, youtube: 1, tiktok: 1, threads: 1, twitter: 1, bluesky: 1 };

// ---------------------------------------------------------------------------
// The client: a hard cap on requests, so on credits
// ---------------------------------------------------------------------------

export class StopRun extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.reason = reason; // 'cap', 'no_credits', 'bad_key'
  }
}

/**
 * A Scrape Creators client that counts every request it sends, retries included, and refuses the one that would pass
 * maxCredits (StopRun 'cap'): each request costs at most 1 credit on these endpoints, so requests are an upper bound on
 * credits. 401 and 402 stop the run (bad key, out of credits). 403 (blocked by the platform), 404 and 400 answer null
 * for that item. 429, 5xx and network errors are retried twice, then answer null.
 */
export function scrapeCreators({ key, maxCredits, doFetch = globalThis.fetch, base = API, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 45000, log = () => {} } = {}) {
  const cap = Math.min(MAX_RUN_CREDITS, Math.max(0, Math.floor(Number(maxCredits) || 0)));
  const s = { sent: 0, charged: 0, remaining: null, errors: {} };
  const err = (k) => (s.errors[k] = (s.errors[k] || 0) + 1);
  async function get(path, params = {}) {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    for (let attempt = 0; attempt < 3; attempt++) {
      if (s.sent >= cap) throw new StopRun('cap', `credit cap reached (${cap})`);
      if (attempt) await sleep(attempt === 1 ? 2000 : 8000);
      s.sent++;
      let res;
      try {
        // The key only ever goes to the Scrape Creators API, never to another host (Bluesky gets no key).
        const headers = key && new URL(base).origin === API ? { 'x-api-key': key, accept: 'application/json' } : { accept: 'application/json' };
        res = await doFetch(url.href, { headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        err('network');
        log(`${path}: ${e.name === 'TimeoutError' ? 'timed out' : 'network error'}`);
        continue;
      }
      if (res.status === 401) throw new StopRun('bad_key', 'Scrape Creators says the API key is wrong (401)');
      if (res.status === 402) throw new StopRun('no_credits', 'Scrape Creators says the credits are used up (402)');
      if (res.status === 429 || res.status >= 500) { err(String(res.status)); continue; }
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || j.success === false || (j.errorStatus && j.errorStatus >= 400)) {
        err(String(res.ok ? (j && j.errorStatus) || 'bad_json' : res.status));
        if (j) s.charged += num(j.credits_charged) ?? 0;
        return null;
      }
      s.charged += num(j.credits_charged) ?? 1;
      if (num(j.credits_remaining) != null) s.remaining = num(j.credits_remaining);
      return j;
    }
    return null;
  }
  return { get, stats: () => ({ ...s, cap, errors: { ...s.errors } }) };
}
