/*
 * Momentum on the board: is a product's demand growing, steady or falling, how long its ads survive, how many other
 * stores sell the same item, and how crowded that makes it. momentum.mjs (a GitHub Actions job, once a day) works it out
 * from the board's own data and stores a summary per product in D1 table `momentum` (migrations/0018_momentum.sql). The
 * board reads those summaries in one small query (a few rows, not one per product) when it reads its tables, and ranks
 * with them: the Inbox × the momentum factor, and a "Momentum" sort. Nothing here writes to D1.
 *   GET /api/momentum?scope=world|eu    { weights, run, counts, rising }: the Momentum panel (from the board in memory)
 *   GET /api/momentum?scope=tiktok      { weights, run, items: { <TikTok id>: card } }: the TikTok tab's rows
 *   GET /momentum.js                    momentumKit as a script: the board draws the rows with the same scoring
 * app.mjs checks the PIN cookie first. A product without a summary (before the first run) ranks and shows as before.
 */

/**
 * Everything the board works out from a summary, in one function that uses nothing from outside itself: the Worker
 * ranks with it, and /momentum.js sends its source to the browser, so the cards show the same numbers the ranking used.
 */
export function momentumKit() {
  // How much each signal counts in the momentum score, from −1 (falling hard) to +1 (rising hard). A product only has
  // some of them (TikTok has no ads, the EU board no TikTok sales): the weights of the ones it has are shared out.
  const WEIGHTS = {
    ads: 0.35, // ads running for the product, now against about a week ago
    reach: 0.35, // EU reach a day of its best ad, now against about a week ago (EU board)
    rank: 0.25, // its rank in its store's best-seller list, now against about a week ago
    sold: 0.5, // TikTok: units sold a day lately, against its lifetime sales (and speeding up or slowing down)
    trends: 0.25, // Google searches, the last 4 weeks against the 4 before (shortlisted products, with SERPAPI_KEY)
    fresh: 0.15, // the share of its ads started in the last 14 days: the advertiser keeps making new ones
    creators: 0.15, // TikTok: creators with videos on it, now against about a week ago
    shop: 0.1, // the store's active ads, now against about a week ago
    markets: 0.1, // markets its ads run in, now against about a week ago (outside the EU)
  };
  const NAMES = { ads: 'Ads', reach: 'EU reach', rank: 'Best-seller rank', sold: 'Sales speed', trends: 'Google searches', fresh: 'New ads',
    creators: 'Creators', shop: 'Store ads', markets: 'Markets' };
  const RISING = 0.15; // a score from +0.15 up is rising, from −0.15 down falling, in between steady
  const SPAN = 0.3; // the ranking: × (1 + 0.3 × score), so × 0.7 (falling hard) to × 1.3 (rising hard); stopped: × 0.7
  // Other stores selling the same item: 2+ is busy, 5+ crowded; 2+ of them new in 14 days is busy at least (a rush).
  const CROWD = { busy: 2, crowded: 5, rush: 2 };
  const CROWD_X = [1, 0.9, 0.75]; // the ranking × this when open, busy, crowded
  const LABEL = { up: 'Rising', flat: 'Steady', down: 'Falling', new: 'No trend yet', stopped: 'Stopped' };
  const ARROW = { up: '↑', flat: '→', down: '↓', new: '', stopped: '×' };

  const round = (x, d) => {
    const f = 10 ** d;
    const r = Math.round(x * f) / f;
    return r === 0 ? 0 : r; // never -0
  };
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const signed = (x) => (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(2);
  const num = (x) => typeof x === 'number' && Number.isFinite(x);

  /**
   * The score of a summary: { m (−1…1), label (up, flat, down, new, stopped), used: the signals that counted }. New ads
   * alone say little: a product needs one real trend (a week of numbers, a best-seller move, TikTok sales or searches).
   */
  function scoreOf(mo) {
    if (!mo) return null;
    if (mo.stop) return { m: -1, label: 'stopped', used: [] };
    const c = mo.c || {};
    const used = Object.keys(WEIGHTS).filter((k) => num(c[k]));
    if (!used.some((k) => k !== 'fresh')) return { m: 0, label: 'new', used: [] };
    const w = used.reduce((s, k) => s + WEIGHTS[k], 0);
    const m = round(used.reduce((s, k) => s + WEIGHTS[k] * clamp(c[k], -1, 1), 0) / w, 2);
    return { m, label: m >= RISING ? 'up' : m <= -RISING ? 'down' : 'flat', used };
  }

  /** How crowded: 0 open, 1 busy (getting crowded), 2 crowded. r: other stores selling it, rn: of which new in 14 days. */
  function crowdOf(mo) {
    const r = (mo && num(mo.r) && mo.r) || 0;
    const rn = (mo && num(mo.rn) && mo.rn) || 0;
    return r >= CROWD.crowded ? 2 : r >= CROWD.busy || rn >= CROWD.rush ? 1 : 0;
  }

  /** The ranking factor and why: { x, why: [{ text, x }] }. 1 without a summary, so the order stays as it was. */
  function factorOf(mo) {
    if (!mo) return { x: 1, why: [] };
    const s = scoreOf(mo);
    const level = crowdOf(mo);
    const why = [];
    let x = 1;
    if (s.label !== 'new') {
      const mx = round(1 + SPAN * s.m, 3);
      x *= mx;
      why.push({ text: `${LABEL[s.label]} ${signed(s.m)}`, x: mx });
    }
    if (level) {
      x *= CROWD_X[level];
      why.push({ text: level === 2 ? 'Crowded' : 'Getting crowded', x: CROWD_X[level] });
    }
    return { x: round(x, 3), why };
  }

  /** A summary as the board gets it: the summary plus its score (m), label (l), crowding (cl) and ranking factor (x, why). */
  function cardOf(mo) {
    if (!mo || typeof mo !== 'object') return null;
    const s = scoreOf(mo);
    const f = factorOf(mo);
    return Object.assign({}, mo, { m: s.m, l: s.label, used: s.used, cl: crowdOf(mo), x: f.x, why: f.why });
  }

  // ---- The browser's part: sparklines, the card rows, the panel. Only called there (install).
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const fmt = (n) => (n == null ? '–' : Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : Math.abs(n) >= 1e4 ? Math.round(n / 1e3) + 'K' : Math.abs(n) >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(Math.round(n)));
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayText = (d) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '';
  };

  /**
   * A sparkline as inline SVG (no style attributes: the board's CSP blocks them). values: one a day, oldest first, null
   * for a day without a number: the line goes straight through it, at its place in time. invert: lower is better (a
   * best-seller rank), so up still means better.
   */
  function spark(values, { w = 56, h = 16, invert = false } = {}) {
    const all = Array.isArray(values) ? values : [];
    const have = all.map((v, i) => [i, v]).filter((p) => num(p[1]));
    if (have.length < 2) return '';
    let lo = Math.min(...have.map((p) => p[1]));
    let hi = Math.max(...have.map((p) => p[1]));
    if (hi === lo) { lo -= 1; hi += 1; }
    const n = Math.max(all.length - 1, 1);
    const xy = ([i, v]) => {
      const k = (v - lo) / (hi - lo);
      return [round(1.5 + (i / n) * (w - 3), 1), round(1.5 + (invert ? k : 1 - k) * (h - 3), 1)];
    };
    const pts = have.map(xy);
    const last = pts[pts.length - 1];
    return `<svg class="msp" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${last[0]}" cy="${last[1]}" r="2" fill="currentColor"/></svg>`;
  }

  /** The main move in words: "ads 4 → 9 in 7d", "rank #12 → #5 in 7d", "≈320 sold a day". */
  function moveText(mo) {
    const d = Array.isArray(mo.d) ? mo.d : null;
    const days = d && num(d[2]) ? ` in ${d[2]}d` : '';
    if (mo.sm === 'sold') return num(mo.v) ? `≈${fmt(mo.v)} sold a day` : '';
    if (!d) return '';
    const [from, to] = d;
    if (mo.sm === 'rank') {
      const r = (x) => (num(x) && x > 0 ? '#' + x : 'not top 50');
      return `rank ${r(from)} → ${r(to)}${days}`;
    }
    const what = { ads: 'ads', shop: 'store ads', reach: 'reach/day', markets: 'markets', creators: 'creators' }[mo.sm] || mo.sm;
    return num(from) && num(to) ? `${what} ${fmt(from)} → ${fmt(to)}${days}` : '';
  }

  const rivalsText = (mo, short) => {
    if (!num(mo.r) || mo.r <= 0) return '';
    const tt = num(mo.rt) && mo.rt > 0 ? mo.rt : 0;
    const shops = tt && mo.r - tt > 0 ? `${tt} TikTok ${tt === 1 ? 'shop' : 'shops'} + ${mo.r - tt} ${mo.r - tt === 1 ? 'store' : 'stores'}`
      : tt ? `${tt} other TikTok ${tt === 1 ? 'shop' : 'shops'}` : `${mo.r} other ${mo.r === 1 ? 'store' : 'stores'}`;
    const fresh = num(mo.rn) && mo.rn > 0 ? ` (${mo.rn} new in 14d)` : '';
    return short ? `${shops}${fresh}` : `${shops} sell the same or a similar item${fresh}`;
  };
  // Ads survived: its longest-running ad, from Meta's start date to the last time the hunt saw it still running. A hint,
  // not proof (some advertisers leave ads switched on): shown, not in the score.
  const survivedText = (mo, long) => (!num(mo.sv) || mo.sv <= 0 ? ''
    : long ? `Ads survived ${mo.sv} days: its longest-running ad, from its start to the last time it was seen${num(mo.sl) && mo.sl > 1 ? ` · ${mo.sl} of its ads ran 30+ days` : ''}. A hint, not proof: some advertisers leave ads on`
      : `Ads survived ${mo.sv}d`);
  const scoreTip = (mo) => {
    const used = mo.used || scoreOf(mo).used;
    if (mo.l === 'stopped') return 'Stopped: its ads were not found in the last scans';
    if (!used.length && mo.same) return `No new numbers since ${dayText(mo.same)}: the EU hunt only runs by hand`;
    if (!used.length) return `Tracking since ${dayText(mo.f) || 'today'}: a trend shows after 3 or more days of numbers`;
    return `Momentum ${signed(mo.m)}: ` + used.map((k) => `${NAMES[k]} ${signed(round(clamp(mo.c[k], -1, 1), 2))} × ${WEIGHTS[k]}`).join(' · ');
  };

  /** The row on a card (EU and outside the EU): a = the board's card data, a.mo its summary. '' without one. */
  function row(a, inbox) {
    const mo = a && a.mo;
    if (!mo || !mo.l) return '';
    if (inbox) return block(mo, !!a.ranked);
    return compact(mo, spark(mo.s, { invert: mo.sm === 'rank' }), survivedText(mo));
  }
  /** A card's row: label, sparkline, the move, the crowding pill; under it ads survived and rivals. Too new: only those. */
  function compact(mo, line, surv) {
    const crowd = mo.cl ? `<span class="mcr c${mo.cl}" title="${esc((mo.cl === 2 ? 'Crowded: ' : 'Getting crowded: ') + rivalsText(mo, false))}">${mo.cl === 2 ? `Crowded · ${esc(mo.r)}` : `${esc(mo.r)} ${mo.r === 1 ? 'rival' : 'rivals'}`}</span>` : '';
    const line2 = [surv, !mo.cl && num(mo.r) && mo.r > 0 ? rivalsText(mo, true) : ''].filter(Boolean).join(' · ');
    if (mo.l === 'new') return crowd || line2 ? `<div class="mo new" title="${esc(scoreTip(mo))}"><div class="mo1">${crowd}${line2 ? `<span class="mot">${esc(line2)}</span>` : ''}</div></div>` : '';
    return `<div class="mo ${esc(mo.l)}" title="${esc(scoreTip(mo))}"><div class="mo1"><b class="mol">${ARROW[mo.l] || ''} ${esc(LABEL[mo.l] || '')}</b>${line}<span class="mot">${esc(moveText(mo))}</span>${crowd}</div>${line2 ? `<div class="mo2">${esc(line2)}</div>` : ''}</div>`;
  }

  /**
   * The Inbox card's block: the score and why, the ranking factor, ads survived, rivals, Google searches, since when.
   * ranked: the card already has the Inbox's own rank line (app.mjs ranked(), with momentum's factor in it): not twice.
   */
  function block(mo, ranked = false) {
    const lines = [];
    const trendless = mo.l === 'new';
    const score = trendless || mo.l === 'stopped' ? '' : ` ${signed(mo.m)}`;
    lines.push(`<div class="mo1"><b class="mol">${ARROW[mo.l] ? ARROW[mo.l] + ' ' : ''}${esc(LABEL[mo.l] || '')}${esc(score)}</b>${trendless ? '' : spark(mo.s, { w: 88, h: 22, invert: mo.sm === 'rank' }) + `<span class="mot">${esc(moveText(mo))}</span>`}</div>`);
    lines.push(`<div class="mo2">${esc(scoreTip(mo))}</div>`);
    if (mo.why && mo.why.length && !ranked) lines.push(`<div class="mo2">Ranks it × ${esc(mo.x)} in the Inbox: ${esc(mo.why.map((w) => `${w.text} × ${w.x}`).join(' · '))}</div>`);
    const surv = survivedText(mo, true);
    if (surv) lines.push(`<div class="mo2">${esc(surv)}</div>`);
    if (num(mo.r) && mo.r > 0) {
      const names = (Array.isArray(mo.rs) ? mo.rs : []).slice(0, 3).join(', ');
      const warn = mo.cl === 2 ? 'Crowded: ' : mo.cl === 1 ? 'Getting crowded: ' : '';
      lines.push(`<div class="mo2 mcrw c${mo.cl || 0}">${esc(warn + rivalsText(mo, false))}${names ? ': ' + esc(names) : ''}</div>`);
    } else if (num(mo.r)) lines.push('<div class="mo2">No other store seen selling it</div>');
    if (Array.isArray(mo.rr) && num(mo.rr[0]) && num(mo.rr[1]) && mo.rr[1] > mo.rr[0]) lines.push(`<div class="mo2 mcrw c1">Rivals ${esc(mo.rr[0])} → ${esc(mo.rr[1])} in ${esc(mo.rr[2])}d</div>`);
    if (num(mo.pc) && Math.abs(mo.pc) >= 5) lines.push(`<div class="mo2">Price ${mo.pc > 0 ? '+' : '−'}${esc(Math.abs(mo.pc))}% in 14d${mo.pc <= -15 ? ': a price war?' : ''}</div>`);
    const g = mo.g;
    if (g && g.q && g.none) lines.push(`<div class="mo2 mog"><span>Too few Google searches for “${esc(g.q)}”${g.geo ? ' in ' + esc(g.geo) : ''} to measure</span></div>`);
    else if (g && g.q) {
      const ch = num(g.ch) ? `${g.ch > 0 ? '+' : g.ch < 0 ? '−' : '±'}${Math.abs(g.ch)}% in 4 weeks` : 'no change measured';
      const yoy = num(g.yoy) ? ` · ${g.yoy > 0 ? '+' : g.yoy < 0 ? '−' : '±'}${Math.abs(g.yoy)}% on a year ago` : '';
      const pk = num(g.pk) ? ` · peaks in ${MONTHS[g.pk - 1]}${num(g.now) && g.now < 50 ? ` (now ${g.now}% of the peak)` : ''}` : '';
      lines.push(`<div class="mo2 mog">${spark(g.s, { w: 56, h: 14 })}<span>Google searches for “${esc(g.q)}”${g.geo ? ' in ' + esc(g.geo) : ''}: ${esc(ch + yoy + pk)}</span></div>`);
    }
    if (mo.f && !trendless) lines.push(`<div class="mo2 mof">Tracking since ${esc(dayText(mo.f))} (${esc(mo.h || 1)} ${mo.h === 1 ? 'day' : 'days'} of numbers)</div>`);
    return `<div class="mo mob ${esc(mo.l)}" aria-label="Momentum">${lines.join('')}</div>`;
  }

  /** The TikTok tab: the row on a TikTok card (items: the summaries by TikTok id). */
  let ITEMS = {};
  function ttRow(a) {
    const mo = a && ITEMS[a.id];
    if (!mo || !mo.l) return '';
    return compact(mo, spark(mo.s), '');
  }
  /** The TikTok tab's Momentum sort: the ranking factor (1 without a summary). */
  const ttFactor = (a) => (a && ITEMS[a.id] && num(ITEMS[a.id].x) ? ITEMS[a.id].x : 1);

  const CSS = `
  .mo { display: grid; gap: 2px; min-width: 0; font: 400 12px/1.35 var(--sans); color: var(--muted); }
  .mo1 { display: flex; align-items: center; gap: 4px 8px; flex-wrap: wrap; min-width: 0; }
  .mo b.mol { font-weight: 500; color: var(--ink); white-space: nowrap; }
  .mo.up b.mol, .mo.up .msp { color: var(--win); }
  .mo.down b.mol, .mo.down .msp, .mo.stopped b.mol { color: var(--bad); }
  .mo.flat .msp, .mo.new .msp { color: var(--muted); }
  .mo .msp { display: inline-block; flex: none; vertical-align: middle; }
  .mo .mot { min-width: 0; overflow-wrap: anywhere; }
  .mo .mo2 { overflow-wrap: anywhere; }
  .mo .mcr { flex: none; padding: 1px 6px; border-radius: 4px; border: 1px solid rgba(217, 164, 65, .5); color: var(--acc); font-weight: 500; white-space: nowrap; }
  .mo .mcr.c2 { border-color: rgba(229, 72, 77, .55); color: var(--bad); }
  .mo .mcrw.c1 { color: var(--acc); }
  .mo .mcrw.c2 { color: var(--bad); }
  .mob { border-top: 1px solid var(--line); padding-top: 8px; gap: 4px; }
  .mob .mo1 { font-size: 14px; }
  .mo .mog { display: flex; align-items: center; gap: 8px; }
  .mo .mog .msp { color: var(--acc); }
  .mo .mof { color: var(--faint); }
  .mopanel .mopw { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  .mopanel .mopw td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  .mopanel .mopw td:last-child { text-align: right; font-family: var(--num); white-space: nowrap; }
  .mopanel ol { margin: 8px 0 0; padding-left: 20px; display: grid; gap: 4px; font-size: 13px; }
  .mopanel ol small { color: var(--muted); }
  `;

  /** The panel above the products: how many rise, fall and are crowded, the weights, the top risers, the last run. */
  function panelHtml(j) {
    const c = j.counts || {};
    const rows = Object.keys(WEIGHTS).map((k) => `<tr><td>${esc(NAMES[k])}</td><td>× ${esc(WEIGHTS[k])}</td></tr>`).join('');
    const top = (j.rising || []).map((x) => `<li>${esc(x.title)} <small>${esc(signed(x.m))}${x.move ? ' · ' + esc(x.move) : ''}</small></li>`).join('');
    const run = j.run && j.run.at ? `Numbers from ${esc(dayText(String(j.run.at).slice(0, 10)))}, ${esc(j.run.days || 0)} ${j.run.days === 1 ? 'day' : 'days'} of history.` : 'The momentum job has not run yet.';
    return `<p class="jbnote">${run} A score from −1 to +1 per product, from the signals it has (their weights shared out): rising from +${RISING}, falling from −${RISING}. The Inbox and the Momentum sort rank by × (1 + ${SPAN} × score), × ${CROWD_X[1]} when getting crowded (${CROWD.busy}+ other stores, or ${CROWD.rush}+ new ones in 14 days) and × ${CROWD_X[2]} when crowded (${CROWD.crowded}+). Without numbers yet a product ranks as before.</p>
      <table class="mopw" aria-label="Weights"><tbody>${rows}</tbody></table>
      ${top ? `<div class="jbg"><h3>Rising most (${esc(c.up || 0)})</h3><ol>${top}</ol></div>` : ''}`;
  }
  const panelSummary = (j) => {
    const c = j.counts || {};
    return [`${c.up || 0} rising`, `${c.down || 0} falling`, `${c.crowded || 0} crowded`, c.stopped ? `${c.stopped} stopped` : '', c.new ? `${c.new} no trend yet` : ''].filter(Boolean).join(' · ');
  };

  /** In the browser: the styles (with the page's nonce: the CSP allows nothing else), the TikTok rows and the panel. */
  function install() {
    const me = document.currentScript;
    const style = document.createElement('style');
    style.nonce = (me && me.nonce) || '';
    style.textContent = CSS;
    document.head.append(style);
    const changed = () => dispatchEvent(new CustomEvent('momentum'));
    const scope = () => {
      const on = document.querySelector('[data-scope][aria-pressed="true"]');
      return on ? on.dataset.scope : 'world';
    };
    const get = async (s) => {
      const res = await fetch('/api/momentum?scope=' + encodeURIComponent(s), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    };
    let tt = null;
    let asked = '';
    const refresh = async () => {
      const s = scope();
      if (s === 'tiktok') {
        if (!tt) tt = get('tiktok').then((j) => { ITEMS = j.items || {}; changed(); }, () => { tt = null; });
        return;
      }
      if (asked === s) return;
      asked = s;
      const box = document.getElementById('mobox');
      try {
        const j = await get(s);
        if (!box || scope() !== s) return;
        const c = j.counts || {};
        const any = (c.up || 0) + (c.flat || 0) + (c.down || 0) + (c.new || 0) + (c.stopped || 0) > 0; // products with a summary
        box.hidden = !any;
        if (!any) return;
        document.getElementById('moboxN').textContent = panelSummary(j);
        document.getElementById('mobody').innerHTML = panelHtml(j);
      } catch (e) {
        asked = ''; // the panel is extra: the board works without it
      }
    };
    document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-scope]')) setTimeout(refresh, 0); });
    refresh();
    changed(); // the cards drawn before this script ran get their rows now
  }

  return { WEIGHTS, NAMES, RISING, SPAN, CROWD, CROWD_X, LABEL, scoreOf, crowdOf, factorOf, cardOf, spark, row, block, ttRow, ttFactor,
    moveText, panelHtml, install, setItems: (x) => { ITEMS = x || {}; } };
}

const KIT = momentumKit();
export const { WEIGHTS, RISING, SPAN, CROWD, CROWD_X, scoreOf, crowdOf, factorOf, cardOf } = KIT;
/** GET /momentum.js: the kit's source, run once in the board as window.MOMENTUM. */
export const MOMENTUM_JS = `'use strict';\nwindow.MOMENTUM = (${momentumKit})();\nwindow.MOMENTUM.install();\n`;

// ---------------------------------------------------------------------------
// Reading the summaries: a few rows (board:NN or tiktok:NN), whatever the number of products
// ---------------------------------------------------------------------------

/** The rows of one scope: 'board' (EU and outside the EU) or 'tiktok'. A range on the key: the primary key's index. */
export const PARTS_SQL = 'SELECT key, body FROM momentum WHERE key >= ?1 AND key < ?2';
export const RUN_SQL = "SELECT body, updated_at FROM momentum WHERE key = 'run'";

/**
 * The summaries of a scope from D1: Map product key → summary. No table yet (a test link before the merge): none, the
 * board works as before. Any other error fails the read, so it is not kept for 15 minutes. A broken part is skipped.
 */
export async function readMomentum(DB, scope = 'board') {
  const s = scope === 'tiktok' ? 'tiktok' : 'board';
  let rows = [];
  try {
    rows = (await DB.prepare(PARTS_SQL).bind(s + ':', s + ';').all()).results || [];
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return new Map();
    throw e;
  }
  const out = new Map();
  for (const r of rows.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    let j = null;
    try {
      j = JSON.parse(r.body || '{}');
    } catch (e) {
      j = null;
    }
    const items = j && j.p && typeof j.p === 'object' ? j.p : {};
    for (const [k, v] of Object.entries(items)) if (v && typeof v === 'object') out.set(k, v);
  }
  return out;
}

/** The last run of the momentum job ({ at, days, ... }) or null. */
export async function momentumRun(DB) {
  try {
    const r = await DB.prepare(RUN_SQL).first();
    return r ? Object.assign(JSON.parse(r.body || '{}') || {}, { updated_at: r.updated_at }) : null;
  } catch (e) {
    return null;
  }
}

/**
 * The keys a board row's summary can be under: a world row 'world|<product page>'; an EU row 'eu|' + its advertiser +
 * title key (the job's), which is gk on the board, or jk where the board groups EU ads by their product page.
 */
export const momentumKeys = (w) => (w.world || String(w.gk || '').startsWith('world|') ? [String(w.gk)] : ['eu|' + w.gk, ...(w.jk ? ['eu|' + w.jk] : [])]);

/** Puts each row's summary on it (w.mo), from readMomentum's map. Rows without one get none. */
export function attachMomentum(rows, map) {
  if (!map || !map.size) return rows;
  for (const w of rows) {
    for (const k of momentumKeys(w)) {
      const mo = map.get(k);
      if (mo) {
        w.mo = mo;
        break;
      }
    }
  }
  return rows;
}

// The ranking factor, worked out once per summary (the summaries stay in memory with the board's tables).
const FACTOR = new WeakMap();
const NONE = Object.freeze({ x: 1, why: Object.freeze([]) });
/** A board row's ranking factor and why ({ x, why: [{ text, x }] }, as app.mjs ranked() takes it): × 1 without a summary. */
export function momentumFactor(r) {
  const mo = r && r.mo;
  if (!mo) return NONE;
  let f = FACTOR.get(mo);
  if (!f) FACTOR.set(mo, (f = factorOf(mo)));
  return f;
}
/** A board row's ranking factor alone: 1 without a summary. */
export const momentumX = (r) => momentumFactor(r).x;
/** The Momentum sort: the biggest ranking factor first (rising and not crowded), then the view's own order. */
export const byMomentum = (then) => (a, b) => momentumX(b) - momentumX(a) || then(a, b);

/** For the card (toAd): the summary with its score, label, crowding and factor, or null. */
export const momentumCard = (r) => (r && r.mo ? cardOf(r.mo) : null);

// ---------------------------------------------------------------------------
// GET /api/momentum
// ---------------------------------------------------------------------------

/**
 * scope tiktok: every TikTok summary as a card, by TikTok id. scope world | eu: the panel over the open products of
 * that tab (not approved or rejected): how many rise, fall and are crowded, and the five rising most.
 * deps.board(): the board in memory (products().v / .w, app.mjs), deps.toAd: the board's card data.
 */
export async function momentumApi(env, scope, deps) {
  const base = { weights: WEIGHTS, rising_from: RISING, span: SPAN, crowd: CROWD, crowd_x: CROWD_X };
  if (scope === 'tiktok') {
    const [map, run] = await Promise.all([readMomentum(env.DB, 'tiktok'), momentumRun(env.DB)]);
    const items = {};
    for (const [k, mo] of map) if (k.startsWith('tiktok|')) items[k.slice(7)] = cardOf(mo);
    return { ...base, run, items };
  }
  const [b, run] = await Promise.all([deps.board(), momentumRun(env.DB)]);
  const open = (scope === 'eu' ? b.v : b.w).filter((r) => r.hid === 0);
  const counts = { up: 0, flat: 0, down: 0, new: 0, stopped: 0, busy: 0, crowded: 0, none: 0 };
  const cards = [];
  for (const r of open) {
    const c = momentumCard(r);
    if (!c) { counts.none++; continue; }
    counts[c.l]++;
    if (c.cl === 1) counts.busy++;
    if (c.cl === 2) counts.crowded++;
    if (c.l === 'up') cards.push([r, c]);
  }
  cards.sort((x, y) => y[1].m - x[1].m || y[1].x - x[1].x || (x[0].ad_id < y[0].ad_id ? -1 : 1));
  const rising = cards.slice(0, 5).map(([r, c]) => {
    const a = deps.toAd(r);
    return { id: a.id, title: String(a.title || '').slice(0, 120), m: c.m, x: c.x, move: KIT.moveText(c) };
  });
  return { ...base, run, scope: scope === 'eu' ? 'eu' : 'world', counts, rising };
}
