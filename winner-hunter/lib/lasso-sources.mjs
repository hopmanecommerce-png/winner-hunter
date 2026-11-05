/*
 * The Lasso discovery's sources next to urlscan (lib/lasso.mjs), as tested on 2026-11-02 (docs/research/lasso-discovery.md).
 * Each gives store domains; lasso.mjs checks every one live, so a source may be noisy but never decides.
 *
 *   DNS_TARGETS                            Lasso's checkout CNAME and its customer portal's address
 *   await reverseDns(target, opts)         → { hosts: [{ host, via, first }], failed: ['otx', …], errors }: who points at it
 *   await boardStores(db, sqls, { now })   → ['store.com', …]: the shops on the board's tables
 *   parseKeywords(text)                    → the keywords of lasso-keywords.txt
 *   adsClient({ key, cap, … })             Scrape Creators' Meta Ad Library search, under a hard credit cap
 *   landingDomains(answer)                 → { domains, ads }: the store domains a search's ads link to
 *
 * Pure: fetch and sleep are passed in. Nothing here throws, except boardStores on a D1 error that is not a missing table,
 * and adsClient's GoogleApiError (lib/google-ads.mjs: e.stop for the key, no credits, the cap).
 */
import { scrapeCreators } from './google-ads.mjs';
import { domainsIn } from './lasso.mjs';
import { NON_STORE } from './score.mjs';

// The checkout CNAME (84 % of the hostnames pointing there serve Lasso's checkout app; 2026-11-02) and the address of
// Lasso's customer portals (account.<store>, subscriptions.<store> …). The second Vercel address of the first report,
// e4e52b5c1254e1d1.vercel-dns-016.com, is another company's (0 of 147 hostnames on Lasso).
export const DNS_TARGETS = ['1a28dfb57b1e1efc.vercel-dns-016.com', 'lasso-customer-portal.pages.dev'];
export const OTX = 'https://otx.alienvault.com/api/v1/indicators/hostname/';
export const MNEMONIC = 'https://api.mnemonic.no/pdns/v3/';
const MNEMONIC_PAGE = 1000;
const MNEMONIC_PAGES = 5;
const DAY = 864e5;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hostName = (s) => String(s ?? '').trim().toLowerCase().replace(/\.$/, '');
// OTX gives its times without a zone ("2026-10-20T10:00:00"); they are UTC. JavaScript reads such a time as local time, so it
// is read as UTC here (else a machine in another time zone saves another first-seen time).
const ZONELESS = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const iso = (v) => {
  const s = String(v ?? '').trim();
  const t = typeof v === 'number' ? v : Date.parse(ZONELESS.test(s) ? s.replace(' ', 'T') + 'Z' : s);
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : '';
};

/** One JSON answer, asked up to `tries` times (pauseMs × the try between them). A 4xx other than 429 is not asked again. */
async function getJson(doFetch, url, { tries, sleep, pauseMs, timeout }) {
  let error = '';
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await doFetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
      const j = res.ok ? await res.json().catch(() => null) : null;
      if (j && typeof j === 'object') return { json: j };
      error = res.ok ? 'not JSON' : 'HTTP ' + res.status;
      if (!res.ok && res.status < 500 && res.status !== 429) break;
    } catch (e) {
      error = e.name === 'TimeoutError' ? 'timeout' : 'network';
    }
    if (attempt < tries) await sleep(pauseMs * attempt);
  }
  return { error };
}

/**
 * Who points at a DNS target, from two passive-DNS services that need no account: AlienVault OTX (slow and often 504:
 * asked up to 4 times, 15, 30 and 45 seconds apart) and Mnemonic (pages of 1,000). Only CNAME records whose answer is the
 * target count. → { hosts: [{ host, via: ['otx', 'mnemonic'], first (the earliest first-seen, ISO, or '') }], failed:
 * the services that gave no answer, errors: { service: why } }
 */
export async function reverseDns(target, { doFetch = globalThis.fetch, sleep = wait, tries = 4, pauseMs = 15000, timeout = 90000 } = {}) {
  const t = hostName(target);
  const hosts = new Map();
  const failed = [];
  const errors = {};
  const add = (h, via, first) => {
    h = hostName(h);
    if (!h || h === t) return;
    const was = hosts.get(h);
    if (!was) return void hosts.set(h, { host: h, via: [via], first });
    if (!was.via.includes(via)) was.via.push(via);
    if (first && (!was.first || first < was.first)) was.first = first;
  };

  const otx = await getJson(doFetch, `${OTX}${encodeURIComponent(t)}/passive_dns`, { tries, sleep, pauseMs, timeout });
  if (otx.error) (failed.push('otx'), (errors.otx = otx.error));
  else for (const r of Array.isArray(otx.json.passive_dns) ? otx.json.passive_dns : []) {
    if (r && String(r.record_type).toUpperCase() === 'CNAME' && hostName(r.address) === t) add(r.hostname, 'otx', iso(r.first));
  }

  for (let page = 0, offset = 0; page < MNEMONIC_PAGES; page++) {
    const mn = await getJson(doFetch, `${MNEMONIC}${encodeURIComponent(t)}?limit=${MNEMONIC_PAGE}&offset=${offset}`, { tries: 2, sleep, pauseMs: 5000, timeout: 60000 });
    if (mn.error) {
      if (!page) failed.push('mnemonic'); // a later page lost: what came is kept
      errors.mnemonic = mn.error;
      break;
    }
    const data = Array.isArray(mn.json.data) ? mn.json.data : [];
    for (const r of data) if (r && String(r.rrtype).toLowerCase() === 'cname' && hostName(r.answer) === t) add(r.query, 'mnemonic', iso(r.firstSeenTimestamp));
    offset += data.length;
    if (!data.length || offset >= Number(mn.json.count || 0)) break;
  }
  return { hosts: [...hosts.values()], failed, errors };
}

/**
 * The shops on the board's tables: sqls = [[sql, takes the date], …] (each selects a store address or domain as u). The
 * dated ones get the day `days` ago. A table that is not there yet gives none; any other D1 error is thrown.
 */
export async function boardStores(db, sqls, { now = Date.now(), days = 60 } = {}) {
  const since = new Date(now - days * DAY).toISOString();
  const out = new Set();
  for (const [sql, dated] of sqls) {
    const rows = await db.query(sql, dated ? [since] : []).catch((e) => {
      if (/no such (table|column)/i.test(String(e && e.message))) return [];
      throw e;
    });
    for (const d of domainsIn(rows.map((r) => r.u).join('\n'))) out.add(d);
  }
  return [...out];
}

/** lasso-keywords.txt: one keyword a line, # starts a comment; lowercase, the same keyword once. */
export function parseKeywords(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const k = line.replace(/#.*$/, '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

export const META_SEARCH = '/v1/facebook/adLibrary/search/ads'; // 1 credit a call (docs.scrapecreators.com, 2026-11-02)
const SOCIAL = /(^|\.)(facebook\.com|fb\.com|fb\.me|fb\.watch|instagram\.com|whatsapp\.com|wa\.me|messenger\.com|m\.me|threads\.net|linktr\.ee|bit\.ly|tinyurl\.com)$/;

/**
 * The store domains a Meta Ad Library search answer's ads link to: each ad's link, its shown caption and its cards' links.
 * Social sites, marketplaces and big brands (NON_STORE) are left out. → { domains, ads: how many ads the answer held }
 */
export function landingDomains(answer) {
  const list = answer && Array.isArray(answer.searchResults) ? answer.searchResults : [];
  const text = [];
  for (const a of list) {
    const s = (a && typeof a === 'object' && a.snapshot) || {};
    text.push(s.link_url, s.caption);
    for (const c of Array.isArray(s.cards) ? s.cards : []) if (c && typeof c === 'object') text.push(c.link_url, c.caption);
  }
  const domains = domainsIn(text.filter((x) => typeof x === 'string').join('\n')).filter((d) => !NON_STORE.test(d) && !SOCIAL.test(d));
  return { domains, ads: list.length };
}

/**
 * Scrape Creators' Meta Ad Library keyword search: active ads, all countries unless one is given, one page (about 30
 * ads) a call, 1 credit a call. cap: the most credits this run may spend (scrapeCreators: a call that could pass it is
 * never sent). search(keyword) → { domains, ads }.
 */
export function adsClient({ key, cap = 0, fetch: doFetch = globalThis.fetch, sleep = wait, timeout = 60000 } = {}) {
  const { call, stats } = scrapeCreators({ key, cap, fetch: doFetch, sleep, timeout, kinds: { meta: { path: META_SEARCH, cost: 1 } } });
  return {
    stats,
    async search(keyword, { country = '' } = {}) {
      const j = await call('meta', { query: String(keyword || '').slice(0, 100), country: /^[A-Z]{2}$/.test(country) ? country : '', status: 'ACTIVE' });
      return j ? landingDomains(j) : { domains: [], ads: 0 };
    },
  };
}
