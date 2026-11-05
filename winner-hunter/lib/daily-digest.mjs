/*
 * The daily digest: the day's picks in under 25 lines of plain English (Markdown), and the same as CSV. The board link is
 * written as {{BOARD}}: the VPS (scripts/fetch-daily-digest.mjs) and the board fill in the address, so it is never in the
 * public repository or its Actions logs.
 *
 *   Winners for Thu 6 Nov 2026: 7 picks
 *   1. CalmBed calming dog bed: score 71, ads 64 days, #2 in its store. Audience: dog owners with anxious dogs, NO/SE.
 *      Margin €21, break-even CPA €21 (est.). Blocker: Sizes. {{BOARD}}/#today/<id>
 */
import { toCsv } from './csv.mjs';

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'Thu 6 Nov 2026' for '2026-11-06'. */
export function dayLabel(day) {
  const d = new Date(String(day) + 'T12:00:00Z');
  return Number.isNaN(d.getTime()) ? String(day) : `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/** The day in Asia/Bangkok (UTC+7, no daylight saving) for a time. */
export const bangkokDay = (t = Date.now()) => new Date(new Date(t).getTime() + 7 * 3600e3).toISOString().slice(0, 10);

const clean = (s, n = 140) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const euro = (x) => (x == null || !Number.isFinite(Number(x)) ? null : '€' + Math.round(Number(x)));

/** The one-line audience of a pick: wh-audience's card, else Jev's guess at the buyer, else a plain "not prepared". */
export function audienceLine(p) {
  if (p.audience && p.audience.one_line) return clean(p.audience.one_line, 110);
  if (p.jev_audience) return clean(p.jev_audience, 110) + ' (Jev, estimate)';
  return 'not prepared yet';
}
/** The pick's margin and break-even CPA: wh-validate's sheet first, else the score's own unit economics. */
export function moneyOf(p) {
  const s = p.sheet || {};
  const margin = s.margin_eur ?? (p.econ ? p.econ.margin_eur : null);
  const cpa = s.breakeven_cpa_eur ?? (p.econ ? p.econ.breakeven_cpa_eur : null);
  const est = s.margin_eur != null ? !!s.estimate : !!(p.econ && p.econ.supplier === 'est');
  return { margin, cpa, est };
}
/** The pick's main blocker: wh-validate's sheet, else the first risk flag or return risk, else 'none found'. */
export function blockerOf(p) {
  if (p.sheet && p.sheet.main_blocker) return clean(p.sheet.main_blocker, 70);
  const r = p.risk || {};
  const first = (r.flags || []).find((f) => !/^Ad numbers/.test(f)) || (r.returns || [])[0] || '';
  return first ? clean(first.replace(/^Docs: /, 'needs papers: ').replace(/^Returns: /, ''), 70) : 'none found';
}

/** The digest as Markdown. run: { day, picks, message, failed: { stage, error } | null, asOf }. */
export function digestMd({ day, picks = [], message = '', failed = null, asOf = '' }) {
  const n = picks.length;
  const out = [`Winners for ${dayLabel(day)}: ${n} pick${n === 1 ? '' : 's'}${asOf ? ` (data to ${asOf})` : ''}`];
  picks.slice(0, 10).forEach((p, i) => {
    const { margin, cpa, est } = moneyOf(p);
    const money = margin != null ? `Margin ${euro(margin)}, break-even CPA ${euro(cpa)}${est ? ' (est.)' : ''}.` : 'Margin unknown (no price).';
    out.push(`${i + 1}. ${clean(p.name, 70)}: score ${p.score}, ${clean(p.why, 120)}. Audience: ${audienceLine(p)}. ${money} Blocker: ${blockerOf(p)}. {{BOARD}}/#today/${p.id}`);
  });
  if (failed) out.push(`The run failed at ${clean(failed.stage, 30)}: ${clean(failed.error, 160)}.`);
  if (message) out.push(clean(message, 200));
  if (!n && !failed && !message) out.push('No product passed the quality bar today.');
  out.push('Tap Keep, Reject or Launch test on the board: the score learns from it.');
  return out.slice(0, 25).join('\n') + '\n';
}

export const CSV_COLS = ['day', 'pick', 'name', 'score', 'level', 'category', 'source', 'price_eur', 'margin_eur', 'breakeven_cpa_eur', 'supplier_price', 'main_blocker', 'audience', 'why', 'product_url', 'ad_library', 'board'];
/** The digest as CSV, one row per pick. */
export function digestCsv({ day, picks = [] }) {
  return toCsv(picks.map((p, i) => {
    const { margin, cpa, est } = moneyOf(p);
    return { day, pick: i + 1, name: p.name, score: p.score, level: p.level, category: p.category || '', source: p.src, price_eur: p.econ ? p.econ.price_eur : '', margin_eur: margin ?? '',
      breakeven_cpa_eur: cpa ?? '', supplier_price: est ? 'estimate' : 'yours', main_blocker: blockerOf(p), audience: audienceLine(p), why: p.why,
      product_url: (p.links && p.links.product_url) || '', ad_library: (p.links && p.links.ad_library) || '', board: `{{BOARD}}/#today/${p.id}` };
  }), CSV_COLS);
}

/** The digest with the board's address filled in (the VPS and the board do this; no address: the links are left out). */
export function withBoard(text, board) {
  const b = String(board || '').replace(/\/+$/, '');
  return b ? String(text).split('{{BOARD}}').join(b) : String(text).replace(/ ?\{\{BOARD\}\}\/#today\/[a-z0-9-]+/g, '').replace(/,\{\{BOARD\}\}[^\n,]*/g, ',');
}
