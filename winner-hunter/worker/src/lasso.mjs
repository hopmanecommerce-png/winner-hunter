/*
 * Lasso checkout on the board (docs/research/lasso-stores.md): the products sold by a store that uses Lasso's hosted
 * checkout (lassocommerce.com). A block of its own, as the AI read: app.mjs reads the stores with the winners and runs its
 * views through lassoView (?lasso=1 on /api/ads and /export.csv); /lasso.js puts the "Lasso checkout" chip with its count
 * on the board, and a "Lasso" tag on those products' cards.
 * The stores are D1's lasso_stores (0019): the research list of 2026-11-01 (0080) and every store the weekly discovery
 * (lasso.mjs, workflow "Lasso stores") finds or checks again later. A store counts while its confidence is high or medium;
 * one that left Lasso (low, or '' after a check) does not. A store the job saves shows on the board at the next read of
 * the tables (after a hunt saves, or within 15 minutes). A store the discovery found has a source and a found_at (0081):
 * the chip shows "+N new" for the live ones found in the last NEW_DAYS days, the card's tag says when.
 *   registrable(hostOrUrl)   → 'store.com': lowercase, no www, the registrable domain ('' when there is none)
 *   lassoIndex(rows)         → Map registrable domain → { store, sure, at, found, src } of the stores on Lasso now, with their aliases
 *   readLasso(DB)            → that index from D1 (empty without the table)
 *   readLassoNew(DB, now)    → the stores the discovery found in the last NEW_DAYS days: { n, by, stores, days } (null: no column yet)
 *   attachLasso(rows, index) → each product's r.lasso: its store's entry, or null
 *   lassoBoard(list)         → the board (products() in app.mjs) with only Lasso stores' products
 *   lassoView(p, list, view) → view(p, list); with ?lasso=1 only Lasso stores' products; .lasso: how many this view holds
 *   lassoCard(r)             → for the card and the CSV: { store, sure, at } (+ found, src when the discovery found it) or null
 *   LASSO_JS                 → /lasso.js
 */

// Suffixes under which a name can be registered, as in the Public Suffix List (publicsuffix.org): the two-label country
// ones a store is likely to use, and hosts that give every shop its own subdomain (x.myshopify.com is a shop of its own,
// never "myshopify.com"). A suffix that is not here counts as one label (store.com, store.de, store.co).
const SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'id.au', 'asn.au', 'co.nz', 'net.nz', 'org.nz', 'geek.nz', 'gen.nz', 'kiwi.nz',
  'co.za', 'org.za', 'net.za', 'web.za', 'co.jp', 'ne.jp', 'or.jp', 'gr.jp', 'co.kr', 'or.kr', 'ne.kr',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'co.il', 'org.il', 'net.il', 'co.ae', 'net.ae', 'org.ae',
  'com.br', 'net.br', 'org.br', 'com.mx', 'org.mx', 'com.ar', 'com.co', 'com.pe', 'com.uy', 'com.ec', 'com.ve',
  'com.sg', 'net.sg', 'org.sg', 'com.my', 'net.my', 'org.my', 'com.hk', 'net.hk', 'org.hk', 'com.tw', 'net.tw', 'org.tw',
  'com.cn', 'net.cn', 'org.cn', 'com.ph', 'com.vn', 'co.th', 'in.th', 'co.id', 'web.id', 'my.id', 'com.pk', 'com.bd',
  'com.tr', 'net.tr', 'org.tr', 'com.sa', 'com.eg', 'com.ng', 'co.ke', 'com.qa', 'com.kw',
  'com.pl', 'net.pl', 'org.pl', 'com.es', 'org.es', 'nom.es', 'com.pt', 'com.gr', 'com.cy', 'com.mt', 'com.fr', 'asso.fr',
  'co.at', 'or.at', 'co.hu', 'com.ua', 'com.ro', 'com.hr', 'co.rs',
  'myshopify.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'github.io', 'gitlab.io', 'herokuapp.com',
  'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'onrender.com', 'fly.dev',
  'wixsite.com', 'webflow.io', 'framer.website', 'framer.app', 'carrd.co', 'square.site', 'mybigcommerce.com',
  'myshopline.com', 'weebly.com', 'wordpress.com', 'blogspot.com', 'squarespace.com', 'godaddysites.com', 'mystrikingly.com',
]);

/**
 * A host or address as the domain a business registers: lowercase, without www. (or www2.), a subdomain dropped
 * (us.store.com → store.com, shop.store.co.uk → store.co.uk), a shop on a platform kept whole (x.myshopify.com).
 * '' for anything that is not a domain name (an IP address, localhost, a suffix on its own).
 */
export function registrable(x) {
  let s = String(x ?? '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s; // a bare host, maybe with a path
  let h;
  try {
    h = new URL(s).hostname; // lowercase, punycode, without the port
  } catch (e) {
    return '';
  }
  h = h.replace(/\.+$/, '').replace(/^www\d?\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) || /^\d+(\.\d+)+$/.test(h) || SUFFIXES.has(h)) return '';
  const labels = h.split('.');
  for (let i = 1; i < labels.length - 1; i++) if (SUFFIXES.has(labels.slice(i).join('.'))) return labels.slice(i - 1).join('.');
  return labels.slice(-2).join('.');
}

const ON = { high: true, medium: false }; // on Lasso now: sure (its script and checkout found), or likely (one of the two)

/**
 * The stores on Lasso now, by registrable domain: { store (as lasso_stores has it), sure, at (the day it was checked) }.
 * A store's aliases (its other domains, from the research) find it too; a store's own domain comes before another
 * store's alias, and a sure store before a likely one.
 */
export function lassoIndex(rows) {
  const index = new Map();
  const on = (rows || []).filter((r) => r && Object.hasOwn(ON, r.confidence) && registrable(r.store));
  const add = (k, e) => {
    const was = index.get(k);
    if (k && (!was || (e.sure && !was.sure && was.own === e.own))) index.set(k, e);
  };
  const entry = (r, own) => ({ store: String(r.store).toLowerCase(), sure: ON[r.confidence], at: String(r.checked_at || '').slice(0, 10),
    found: String(r.found_at || '').slice(0, 10), src: String(r.source || ''), own });
  for (const r of on) add(registrable(r.store), entry(r, true));
  for (const r of on) for (const d of String(r.aliases || '').split(/[\s,;]+/)) add(registrable(d), entry(r, false));
  return index;
}

// The columns, newest migration first: a database without 0081 (no found_at, source) or 0080 (no aliases) still works (a
// test link uses the live database before a merge).
const COLUMNS = ['store, confidence, aliases, checked_at, found_at, source', 'store, confidence, aliases, checked_at', 'store, confidence, checked_at'];

/** The index of the Lasso stores in D1. No table yet: empty. Any other D1 error is thrown (app.mjs reads again). */
export async function readLasso(DB) {
  for (const cols of COLUMNS) {
    try {
      const r = await DB.prepare(`SELECT ${cols} FROM lasso_stores WHERE confidence IN ('high', 'medium') ORDER BY store`).all();
      return lassoIndex((r && r.results) || []);
    } catch (e) {
      const msg = String(e && e.message);
      if (/no such table/i.test(msg)) return new Map();
      if (!/no such column/i.test(msg)) throw e;
    }
  }
  return new Map();
}

export const NEW_DAYS = 7; // "this week" on the chip: the live Lasso stores found in the last 7 days
const NEW_SQL = `SELECT store, source FROM lasso_stores WHERE found_at >= ?1 AND live = 1 AND confidence IN ('high', 'medium')
ORDER BY found_at DESC, store LIMIT 1000`;

/**
 * The live Lasso stores the weekly discovery found in the last NEW_DAYS days: { n, by: { source: n }, stores: the newest 8,
 * days }. null when D1 has no found_at yet (before 0081) or does not answer: the chip then shows no "new" (never an error
 * for the board).
 */
export async function readLassoNew(DB, now = Date.now()) {
  try {
    const r = await DB.prepare(NEW_SQL).bind(new Date(now - NEW_DAYS * 864e5).toISOString()).all();
    const rows = (r && r.results) || [];
    const by = {};
    for (const x of rows) by[x.source || 'other'] = (by[x.source || 'other'] || 0) + 1;
    return { n: rows.length, by, stores: rows.slice(0, 8).map((x) => x.store), days: NEW_DAYS };
  } catch (e) {
    if (!/no such (table|column)/i.test(String(e && e.message))) console.error(e);
    return null;
  }
}

/** Each product's r.lasso: the Lasso store its store's domain belongs to, or null. */
export function attachLasso(rows, index) {
  for (const r of rows) r.lasso = (index && index.size && index.get(registrable(r.store_url || r.product_url))) || null;
  return rows;
}

const isLasso = (r) => !!r.lasso;
/** The board with only the products of Lasso stores: every list a view reads (EU, outside the EU, Google, ★ and ✓). */
export function lassoBoard(list) {
  return Object.assign({}, list, { v: list.v.filter(isLasso), k: list.k.filter(isLasso), w: (list.w || []).filter(isLasso), gl: (list.gl || []).filter(isLasso) });
}

/**
 * One view of the board (view: viewOf in app.mjs) with ?lasso=1: only Lasso stores' products. q.lasso: how many products
 * this view holds that a Lasso store sells, with every other filter as asked (the chip's count). count false: not
 * worked out (the CSV).
 */
export function lassoView(p, list, view, { count = true } = {}) {
  const on = p.get('lasso') === '1';
  const only = on || count ? lassoBoard(list) : null;
  const q = view(p, on ? only : list);
  if (count) q.lasso = on ? q.total : view(p, only).total;
  return q;
}

/** For the card (toAd in app.mjs) and the CSV. found and src only for a store the weekly discovery found. */
export function lassoCard(r) {
  if (!r || !r.lasso) return null;
  const { store, sure, at, found, src } = r.lasso;
  return found ? { store, sure, at, found, src } : { store, sure, at };
}

/**
 * The board's side, sent as source text (/lasso.js), run once after the board's own script (it uses the board's st, ADS,
 * DONE and load). Two chips, one state (st.lasso, which params() in board.html sends): Browse has it among its filters;
 * the Inbox, which has no filter row, where Browse has its search. Its count: the server's (j.lasso of /api/ads, through
 * LASSO.header in the board's header()), less the Lasso products decided in the Inbox since. "+N new" on the chip: the
 * live Lasso stores the weekly discovery found in the last 7 days (j.lasso_new), its title says by which source and
 * names the newest. A "Lasso" tag goes on each card of a Lasso store as the cards come.
 */
export function lassoKit() {
  const grid = document.getElementById('grid');
  const opts = document.getElementById('opts');
  if (!grid || !opts || window.LASSO || typeof st === 'undefined') return;
  const me = document.currentScript || document.getElementById('lakit');
  const css = document.createElement('style');
  if (me && me.nonce) css.setAttribute('nonce', me.nonce);
  css.textContent = `
  .lchip small { margin-left: 4px; font-size: 11px; font-weight: 500; opacity: .75; }
  .lchip .lnew { margin-left: 6px; padding: 2px 5px; border: 1px solid currentColor; border-radius: 6px; font: 600 10px/1 var(--mono); color: var(--win); }
  .lchip .lnew[hidden] { display: none; }
  .lchip[aria-pressed="true"] .lnew { color: inherit; }
  body:not(.inbox) .lchip.lin { display: none; }
  `;
  document.head.appendChild(css);

  const L = { n: null, ids: new Set(), base: new Set(), fresh: null };
  window.LASSO = L;
  const list = () => (typeof ADS !== 'undefined' && Array.isArray(ADS) ? ADS : []);
  // The server's count, less the Lasso products decided in the Inbox since it came (the Inbox decides without asking again).
  function count() {
    if (L.n == null) return null;
    let n = L.n;
    if (st.view === 'inbox' && typeof DONE !== 'undefined') for (const id of L.ids) if (DONE.has(id) && !L.base.has(id)) n--;
    return Math.max(0, n);
  }
  // "+N new": the live Lasso stores the weekly discovery found in the last days, with what found them and the last run.
  function fresh() {
    const f = L.fresh;
    if (!f || !(f.n > 0)) return null;
    const by = Object.entries(f.by || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    const names = (f.stores || []).join(', ') + (f.n > (f.stores || []).length ? ', …' : '');
    const run = f.run && f.run.at ? ` Last run ${String(f.run.at).slice(0, 10)}${f.run.health && f.run.health !== 'ok' ? ` (${f.run.health})` : ''}.` : '';
    return { text: `+${f.n.toLocaleString('en-US')} new`,
      title: `${f.n} Lasso store${f.n === 1 ? '' : 's'} found by the weekly discovery in the last ${f.days || 7} days${by ? ` (${by})` : ''}: ${names}.${run}` };
  }
  const chips = [];
  function paint() {
    const n = count();
    const f = fresh();
    for (const b of chips) {
      b.setAttribute('aria-pressed', String(!!st.lasso));
      b.querySelector('small').textContent = n == null ? '' : n.toLocaleString('en-US');
      const s = b.querySelector('.lnew');
      s.hidden = !f;
      s.textContent = f ? f.text : '';
      if (f) s.title = f.title;
      else s.removeAttribute('title');
    }
  }
  function chip(where) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip lchip ' + where;
    b.title = 'Only products from stores that use the Lasso checkout (lassocommerce.com)';
    const news = document.createElement('span');
    news.className = 'lnew';
    news.hidden = true;
    b.append('Lasso checkout', document.createElement('small'), news);
    b.addEventListener('click', () => {
      st.lasso = !st.lasso;
      const csv = document.getElementById('csv'); // the CSV link follows the chip at once, not only when the answer is drawn (render())
      if (csv) csv.href = '/export.csv?' + params().toString();
      paint();
      load();
    });
    chips.push(b);
    return b;
  }
  opts.insertBefore(chip('lbr'), opts.querySelector('[data-f="hidden"]')); // Browse: before "Approved & rejected"
  const search = document.getElementById('allrow');
  if (search && search.parentNode) search.after(chip('lin'));

  /** From the board's header(j): the count for this view. Products decided here that the server still counted are taken off. */
  L.header = (j) => {
    L.n = j && typeof j.lasso === 'number' ? j.lasso : null;
    L.fresh = j && j.lasso_new && typeof j.lasso_new === 'object' ? j.lasso_new : null;
    L.ids = new Set((j && Array.isArray(j.ads) ? j.ads : []).filter((a) => a && a.lasso).map((a) => a.id));
    L.base = new Set(st.view === 'inbox' && typeof DONE !== 'undefined' ? [...L.ids].filter((id) => DONE.has(id)) : []);
    if (L.n != null) L.n = Math.max(0, L.n - L.base.size);
    paint();
  };

  function tag(x) {
    const s = document.createElement('span');
    s.className = 'tag lasso';
    s.textContent = 'Lasso';
    s.title = `${x.store} uses the Lasso checkout (lassocommerce.com): ${x.sure ? 'sure, its Lasso script and checkout were found' : 'likely, its Lasso script or checkout was found'}${x.at ? ', checked ' + x.at : ''}`
      + (x.found ? `, found by the weekly discovery on ${x.found}${x.src ? ` (${x.src})` : ''}` : '');
    return s;
  }
  function scan() {
    const by = new Map(list().map((a) => [a && a.id, a]));
    for (const card of grid.querySelectorAll(':scope > .card[data-id]')) {
      const a = by.get(card.dataset.id);
      if (!a || !a.lasso || card.querySelector('.tag.lasso')) continue;
      let box = card.querySelector('.badges') || card.querySelector('.bd > .tags');
      const bd = card.querySelector('.bd');
      if (!box && bd) {
        box = document.createElement('div');
        box.className = 'tags';
        bd.prepend(box);
      }
      if (box) box.append(tag(a.lasso));
    }
    paint(); // a decision in the Inbox draws the next card: the count follows
  }
  new MutationObserver(scan).observe(grid, { childList: true });
  scan();
  if (list().length) load(); // the board's first answer came before this script: once more, for the count
}

/** GET /lasso.js: lassoKit's source, run once by the board after its own script. */
export const LASSO_JS = `'use strict';\n(${lassoKit})();\n`;
