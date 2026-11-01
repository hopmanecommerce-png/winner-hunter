/*
 * The AI read on the board: under each card, collapsed, "AI read · experimental": what a cheap Claude model makes of the
 * product (ai-check.mjs fills D1 table ai_checks). Hidden first: closed until you open it, so you decide on your own
 * first, and never used to sort, filter or hide. ai-eval.mjs measures how often it agrees with you; opening it is
 * noted (opened_at), so the eval can keep blind decisions apart from those made after a look.
 *   GET  /api/ai?ids=<ad id>,<ad id>…   { reads: { <ad id>: read }, eval }: the reads of the cards shown (up to 90)
 *   POST /api/ai {id, opened: true}      you opened the AI read of that card's product (the first time is kept)
 *   GET  /ai.js                          aiBoard() as a script: adds the AI read to the cards of the board
 * app.mjs checks the PIN cookie, the origin and the JSON before any of this runs. All SQL is parameterized.
 */
import { validate, flagsOf } from './ai-schema.mjs';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_IDS = 90; // D1 takes up to 100 bound values a query
/** The product key of a board row (a winners or world_products row from app.mjs snapshot()): the same as launch.mjs keyOf. */
export const keyOfRow = (r) => (r.world ? String(r.gk) : 'eu|' + r.gk);
const jsonOf = (s, or) => {
  try {
    return JSON.parse(s || '') ?? or;
  } catch (e) {
    return or;
  }
};
const num = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));

/** One ai_checks row for a card, checked again (validate), or null. A flagged read keeps low confidence. */
export function readOut(row) {
  const v = row && row.verdict ? validate(jsonOf(row.verdict, null)) : { ok: false };
  if (!v.ok) return null;
  const flags = flagsOf(row.flags);
  return { ...v.value, confidence: flags.includes('injection') ? 'low' : v.value.confidence, flags, model: String(row.answer_model || row.model || ''), at: String(row.checked_at || ''),
    updating: row.status === 'pending' };
}

/** ai-eval.mjs's last report, as the card shows it: no product names. */
export function evalOut(s) {
  const r = s ? jsonOf(s.value, null) : null;
  if (!r || typeof r !== 'object' || !Number.isFinite(Number(r.n))) return null;
  const b = r.blind || {};
  return { n: Number(r.n), accuracy: num(r.accuracy), kappa: num(r.kappa), auc: num(r.auc), threshold: num(r.threshold), blind: { n: num(b.n) || 0, accuracy: num(b.accuracy) }, at: String(r.at || '') };
}

/** GET /api/ai. deps.rows(): the board's rows (app.mjs snapshot): which product each card's ad belongs to. */
export async function aiList(env, idsParam, deps) {
  const ids = [...new Set(String(idsParam || '').split(','))].filter((x) => ID.test(x)).slice(0, MAX_IDS);
  if (!ids.length) return { reads: {}, eval: null };
  const want = new Set(ids);
  const keyOf = new Map();
  for (const r of await deps.rows()) if (want.has(r.ad_id)) keyOf.set(r.ad_id, keyOfRow(r));
  const keys = [...new Set(keyOf.values())];
  let rows = [];
  let evalRow = null;
  try {
    [rows, evalRow] = await Promise.all([
      keys.length ? env.DB.prepare(`SELECT product_key, status, model, answer_model, fit, confidence, verdict, flags, checked_at FROM ai_checks WHERE product_key IN (${keys.map(() => '?').join(', ')})`).bind(...keys).all().then((r) => r.results || []) : [],
      env.DB.prepare("SELECT value FROM state WHERE key = 'ai_eval'").first(),
    ]);
  } catch (e) {
    return { reads: {}, eval: null }; // no table yet: the board works as before, without AI reads
  }
  const byKey = new Map(rows.map((r) => [r.product_key, readOut(r)]));
  const reads = {};
  for (const [id, k] of keyOf) if (byKey.get(k)) reads[id] = { ...byKey.get(k), key: k };
  return { reads, eval: evalOut(evalRow) };
}

/** POST /api/ai {id, opened: true}: the first time you open that product's AI read. Returns { status, body }. */
export async function aiPost(env, j, now, deps) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { status: 400, body: { error: 'Bad JSON' } };
  const id = String(j.id || '');
  if (!ID.test(id)) return { status: 400, body: { error: 'Bad id' } };
  if (j.opened !== true) return { status: 400, body: { error: 'Nothing to save' } };
  const me = (await deps.rows()).find((r) => r.ad_id === id);
  if (!me) return { status: 404, body: { error: 'Unknown ad' } };
  const key = keyOfRow(me);
  const out = await env.DB.prepare('UPDATE ai_checks SET opened_at = COALESCE(opened_at, ?) WHERE product_key = ?').bind(new Date(now).toISOString(), key).run();
  if (!out.meta || !out.meta.changes) return { status: 404, body: { error: 'No AI read for this product' } };
  return { status: 200, body: { ok: true, key } };
}

/**
 * The board's side, sent as source text (/ai.js), so it uses nothing from outside itself. It watches the card grid:
 * new cards get their reads from /api/ai (the next Inbox products too), and each card with a read gets a closed
 * <details> at the bottom. A tap inside it never opens the ad (the card's own tap), and opening it is sent once.
 */
export function aiBoard() {
  const grid = document.getElementById('grid');
  if (!grid || window.AI_READ) return;
  const me = document.currentScript || document.getElementById('aikit');
  const css = document.createElement('style');
  if (me && me.nonce) css.setAttribute('nonce', me.nonce);
  css.textContent = `
  .airead { container-type: inline-size; margin-top: 4px; border: 1px solid var(--line); border-radius: 10px; background: var(--card2); cursor: auto; min-width: 0; }
  .airead > summary { list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; min-height: 36px; padding: 8px 10px; cursor: pointer; font: 600 11px/1.2 var(--mono); color: var(--muted); -webkit-user-select: none; user-select: none; }
  .airead > summary::-webkit-details-marker { display: none; }
  .airead > summary::before { content: '▸'; color: var(--faint); transition: transform .2s; }
  .airead[open] > summary::before { transform: rotate(90deg); }
  .airead .ait { white-space: nowrap; }
  .airead .aix { margin-left: auto; padding: 2px 6px; border-radius: 6px; border: 1px solid rgba(217, 164, 65, .45); color: var(--acc); font-size: 10px; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
  .airead .aib { padding: 0 10px 10px; display: grid; gap: 8px; font-size: 12px; line-height: 1.4; color: var(--muted); }
  .airead .aitop { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; }
  .airead .aifit { font-size: 22px; font-weight: 600; color: var(--ink); font-variant-numeric: tabular-nums; }
  .airead .aitop span { font: 500 11px var(--mono); }
  .airead .c-high { color: var(--win); }
  .airead .c-low { color: var(--amb); }
  .airead p { margin: 0; overflow-wrap: anywhere; }
  .airead .aiwhat { color: var(--ink); }
  .airead .aiwhat b { font-weight: 600; }
  .airead dl { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 10px; }
  .airead dt { font: 500 11px/1.6 var(--mono); color: var(--faint); }
  .airead dd { margin: 0; color: var(--ink); overflow-wrap: anywhere; }
  .airead ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; }
  .airead li { position: relative; padding-left: 16px; color: var(--ink); overflow-wrap: anywhere; }
  .airead li::before { position: absolute; left: 0; font: 600 12px var(--mono); }
  .airead li.pro::before { content: '+'; color: var(--win); }
  .airead li.con::before { content: '\\2212'; color: var(--bad); }
  .airead .aiwarn { color: var(--amb); font-weight: 600; }
  .airead .ainote { font: 500 11px/1.45 var(--mono); color: var(--faint); }
  /* A narrow card (two columns on a phone): the tag wraps under the title, each label sits above its text. */
  @container (max-width: 240px) {
    .airead .aix { margin-left: 0; padding: 0; border: 0; letter-spacing: 0; text-transform: none; }
    .airead dl { grid-template-columns: minmax(0, 1fr); gap: 0; }
    .airead dt { margin-top: 4px; }
  }
  `;
  document.head.appendChild(css);

  const A = { reads: new Map(), open: new Set(), sent: new Set(), want: new Set(), eval: null, timer: 0, busy: false };
  window.AI_READ = A;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pct = (x) => Math.round(Number(x) * 100) + '%';
  const LEVEL = { none: 'none', low: 'low', medium: 'medium', high: 'high', unknown: 'unknown' };
  const day = (iso) => {
    const d = new Date(iso);
    return Number.isFinite(+d) ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  };
  const modelName = (m) => {
    const x = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(String(m || ''));
    return x ? `Claude ${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? '.' + x[3] : ''}` : String(m || 'AI');
  };
  function evalLine() {
    const e = A.eval;
    if (!e || !e.n) return 'Not measured against your decisions yet.';
    if (e.n < 20) return `Too few of your decisions to measure it yet (${e.n}).`;
    const b = e.blind && e.blind.n >= 20 ? e.blind : null;
    return `Agrees with ${b ? 'your blind' : 'your'} decisions ${pct(b ? b.accuracy : e.accuracy)} of the time (${b ? b.n : e.n} decisions${e.kappa == null ? '' : `, kappa ${e.kappa.toFixed(2)}`}).`;
  }
  function html(r) {
    const row = (label, value) => (value ? `<dt>${esc(label)}</dt><dd>${value}</dd>` : '');
    const claims = r.claims && r.claims.length ? `: ${r.claims.map((c) => '“' + esc(c) + '”').join(', ')}` : '';
    return `<summary><span class="ait">AI read</span><span class="aix">experimental</span></summary>
      <div class="aib">
        <div class="aitop"><b class="aifit">${esc(r.fit)}</b><span>fit of 100</span><span class="c-${esc(r.confidence)}">· ${esc(r.confidence)} confidence</span>${r.updating ? '<span>· updating</span>' : ''}</div>
        <p class="aiwhat"><b>${esc(r.product)}</b> · ${esc(r.niche)}</p>
        <dl>${row('Hook', esc(r.angle))}${row('Buyer', esc(r.customer))}${row('Wow', esc(LEVEL[r.wow] || r.wow))}
          ${row('Saturation', esc(LEVEL[r.saturation] || r.saturation) + (r.saturation_hint ? ': ' + esc(r.saturation_hint) : ''))}
          ${row('Claims risk', esc(LEVEL[r.claims_risk] || r.claims_risk) + claims)}</dl>
        ${(r.pros || []).length || (r.cons || []).length ? `<ul>${(r.pros || []).map((x) => `<li class="pro">${esc(x)}</li>`).join('')}${(r.cons || []).map((x) => `<li class="con">${esc(x)}</li>`).join('')}</ul>` : ''}
        ${(r.flags || []).includes('injection') ? '<p class="aiwarn">⚠ The product data tried to give the AI instructions. Read this with care.</p>' : ''}
        <p class="ainote">${esc(modelName(r.model))}${r.at ? ' · ' + esc(day(r.at)) : ''} · ${esc(evalLine())} Experimental: it can be wrong, and nothing is sorted or hidden by it.</p>
      </div>`;
  }
  function mount(card, r) {
    const bd = card.querySelector('.bd');
    if (!bd || bd.querySelector(':scope > .airead')) return;
    const d = document.createElement('details');
    d.className = 'airead';
    d.dataset.id = card.dataset.id;
    d.innerHTML = html(r);
    if (A.open.has(r.key)) d.open = true; // open before a re-render of the cards: open again
    bd.appendChild(d);
  }
  function scan() {
    for (const card of grid.querySelectorAll('.card[data-id]')) {
      const id = card.dataset.id;
      if (A.reads.has(id)) {
        if (A.reads.get(id)) mount(card, A.reads.get(id));
      } else A.want.add(id);
    }
    try {
      // The board's list (ADS in board.html): the next Inbox products, so their reads are there when they come up.
      if (typeof ADS !== 'undefined' && Array.isArray(ADS)) for (const a of ADS.slice(0, 40)) if (a && a.id && !A.reads.has(a.id)) A.want.add(a.id);
    } catch (e) {
      // the cards alone are enough
    }
    if (A.want.size && !A.timer) A.timer = setTimeout(load, 50);
  }
  async function load() {
    A.timer = 0;
    if (A.busy) {
      A.timer = setTimeout(load, 200);
      return;
    }
    const ids = [...A.want].slice(0, 90);
    for (const id of ids) A.want.delete(id);
    if (!ids.length) return;
    A.busy = true;
    try {
      const res = await fetch('/api/ai?ids=' + encodeURIComponent(ids.join(',')), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const j = res.ok ? await res.json() : {};
      if (j.eval !== undefined) A.eval = j.eval;
      for (const id of ids) A.reads.set(id, (j.reads && j.reads[id]) || null);
    } catch (e) {
      for (const id of ids) A.reads.set(id, null); // no AI read on these cards for now; the board works as before
    } finally {
      A.busy = false;
    }
    scan();
  }
  // A tap or Enter inside the AI read only opens or closes it: never the ad (the card's tap) or the Inbox's keys.
  grid.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.airead')) e.stopPropagation(); }, true);
  grid.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.closest && e.target.closest('.airead')) e.stopPropagation(); }, true);
  grid.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d || !d.classList || !d.classList.contains('airead')) return;
    const r = A.reads.get(d.dataset.id);
    if (!r) return;
    if (!d.open) {
      A.open.delete(r.key);
      return;
    }
    A.open.add(r.key);
    if (A.sent.has(r.key)) return;
    A.sent.add(r.key);
    fetch('/api/ai', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: d.dataset.id, opened: true }) })
      .catch(() => A.sent.delete(r.key));
  }, true);
  new MutationObserver(scan).observe(grid, { childList: true });
  scan();
}

/** GET /ai.js: aiBoard's source, run once by the board after its own script. */
export const AI_JS = `'use strict';\n(${aiBoard})();\n`;
