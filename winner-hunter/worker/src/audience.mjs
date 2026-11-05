/*
 * 🎯 Audience on the board: one audience card (lib/audience-card.mjs buildCard) as HTML, for the "Today's winners" tab and
 * any product sheet. A kit that uses nothing from outside itself, like risk.mjs: the Worker renders with it and /audience.js
 * sends the same source to the board (window.AUDIENCE), so both show the very same card.
 *   AUDIENCE.html(card, { open })   the card as a <section class="au">: who, reach, problem, triggers, doubts, words, hooks,
 *                                   Meta targeting, facts and gaps. Every text is escaped; links are https only.
 *   AUDIENCE.line(card)             the audience in one line (the digest's "For …")
 * No inline styles (the board's Content Security Policy): classes only, styled by AUDIENCE_CSS, and <meter> for bars.
 * Card quotes are other people's public comments about other brands' products: shown as research, never as our reviews.
 */
export function audienceKit() {
  const MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => MAP[c]);
  const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : '');
  const link = (u, t) => (safeUrl(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(t)}</a>` : esc(t));
  const cut = (s, n) => {
    const a = Array.from(String(s == null ? '' : s));
    return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join('');
  };
  const arr = (x) => (Array.isArray(x) ? x : []);
  const quote = (x) => (x && x.text ? `<q>${esc(cut(x.text, 200))}</q> <span class="au-src">${link(x.url, x.src || 'source')}${x.date ? ` · ${esc(x.date)}` : ''}${x.likes ? ` · ${esc(x.likes)} likes` : ''}</span>` : '');
  const tag = (t) => `<span class="au-tag au-${esc(t)}">${esc(t)}</span>`;
  const sec = (title, body, cls = '') => (body ? `<div class="au-sec${cls ? ' ' + cls : ''}"><h4>${esc(title)}</h4>${body}</div>` : '');

  function line(card) {
    return card ? String(card.one_line || '') : '';
  }

  function reachHtml(r) {
    if (!r) return '<p class="au-none">No EU reach data for this product.</p>';
    const rows = arr(r.ages).map((a) => `<tr><td>${esc(a.band)}</td><td><meter min="0" max="100" value="${esc(a.share)}">${esc(a.share)}%</meter></td><td>${esc(a.share)}%</td><td>${a.index == null ? '' : esc(a.index)}</td></tr>`).join('');
    return `<p>${tag('fact')} ${esc(r.women)}% women · ${esc(r.men)}% men${r.span ? ` · ${esc(r.span.label)} hold ${esc(r.span.share)}%` : ''} · ${esc(r.ads)} ad(s), ${esc(Number(r.reach || 0).toLocaleString('en'))} people reached. Reached is not bought.</p>` +
      `<table class="au-reach"><thead><tr><th>Age</th><th></th><th>Share</th><th>Index</th></tr></thead><tbody>${rows}</tbody></table>` +
      (arr(r.countries).length ? `<p class="au-small">Top countries: ${arr(r.countries).map((c) => `${esc(c.cc)} ${esc(c.share)}%`).join(', ')}</p>` : '');
  }

  function personasHtml(list) {
    return arr(list).map((p) => `<div class="au-persona"><b>${esc(p.label)}</b><ul>` +
      `<li>Gender: ${esc(p.gender)}</li><li>Ages: ${esc(p.ages)}</li>` +
      `<li>Countries: ${esc(arr(p.countries && p.countries.launch).join(', '))}${p.countries && arr(p.countries.eu_reach).length ? ` (competitors reach ${arr(p.countries.eu_reach).map((c) => `${esc(c.cc)} ${esc(c.share)}%`).join(', ')})` : ''}</li>` +
      (arr(p.situation).length ? `<li>Situation: ${arr(p.situation).map((s) => `${esc(s.label)} (${esc(s.n)})`).join(', ')}</li>` : '') +
      (arr(p.wants).length ? `<li>Wants: ${arr(p.wants).map((w) => esc(w.label)).join('; ')}</li>` : '') +
      (arr(p.fears).length ? `<li>Fears: ${arr(p.fears).map((w) => esc(w.label)).join('; ')}</li>` : '') +
      arr(p.evidence).map((e) => `<li>${tag(e.tag)} ${esc(e.text)}${e.quote ? ` ${quote(e.quote)}` : ''}</li>`).join('') + '</ul></div>').join('');
  }

  const themeList = (list, withAnswer) => (arr(list).length ? '<ul>' + arr(list).map((t) => `<li><b>${esc(t.label)}</b> ${tag('count')} ${esc(t.n)}${withAnswer && t.answer ? `<div class="au-answer">Answer: ${esc(t.answer)}</div>` : ''}${arr(t.quotes)[0] ? `<div>${quote(t.quotes[0])}</div>` : ''}</li>`).join('') + '</ul>' : '');

  function anglesHtml(list) {
    if (!arr(list).length) return '';
    return '<ol class="au-angles">' + arr(list).map((a) => `<li${a.first_test ? ' class="au-first"' : ''}><div class="au-hook">${esc(a.hook)}</div>` +
      `<div class="au-small">${esc(a.angle)}${a.first_test ? ' · first test' : ''}${a.needs_proof ? ' · needs proof' : ''}${a.jev_p != null ? ` · Jev ${esc(Math.round(a.jev_p * 100))}%` : ''}</div>` +
      `<div class="au-small">Show: ${esc(a.proof)}</div>` +
      (arr(a.based_on).filter((x) => x && x.url).length ? `<div class="au-small">Based on: ${arr(a.based_on).filter((x) => x && x.url).map((x) => link(x.url, x.src)).join(', ')}</div>` : '') + '</li>').join('') + '</ol>';
  }

  function targetingHtml(t) {
    if (!t || !t.control) return '';
    const c = t.control;
    const s = t.suggestions || {};
    const rows = arr(t.countries).map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(x.currency)}</td><td>${x.cpm_usd == null ? 'n/a' : '$' + esc(x.cpm_usd)}</td><td>${esc(x.tax)}</td></tr>`).join('');
    return `<p><b>Broad (control):</b> ${esc(c.countries.join(', '))}, age ${esc(c.age)}, ${esc(c.gender)}, ${esc(c.audience)}, ${esc(c.placements)}.</p><p class="au-small">${esc(c.why)}</p>` +
      (s.age || s.gender ? `<p><b>Advantage+ suggestions:</b> ${esc([s.age && 'age ' + s.age, s.gender && 'gender ' + s.gender].filter(Boolean).join('; '))}</p>` : '') +
      (t.interests && arr(t.interests.names).length ? `<p><b>Optional interests</b> ${tag('unverified')}: ${esc(t.interests.names.join(', '))}. ${esc(t.interests.when)}.</p>` : '') +
      (rows ? `<table class="au-mk"><thead><tr><th>Market</th><th>Currency</th><th>CPM</th><th>Tax</th></tr></thead><tbody>${rows}</tbody></table>` : '') +
      `<p class="au-small">${esc(t.bench_source || '')}</p>`;
  }

  /** The card as HTML. open: the details start open. A card that is null or broken gives a short "no card" line. */
  function html(card, { open = false } = {}) {
    if (!card || typeof card !== 'object' || !card.data) return '<section class="au au-empty"><p>No audience card yet.</p></section>';
    const d = card.data;
    const words = card.words && arr(card.words.phrases).length ? '<p class="au-chips">' + arr(card.words.phrases).map((w) => `<span class="au-chip">${esc(w.phrase)} <i>${esc(w.n)}</i></span>`).join(' ') + '</p>' : '';
    const avoid = card.words && arr(card.words.avoid).length ? '<ul class="au-small">' + arr(card.words.avoid).map((a) => `<li>${a.word ? `"${esc(a.word)}": ` : ''}${esc(a.label)}</li>`).join('') + '</ul>' : '';
    const comps = arr(card.competitors).length ? '<ul>' + arr(card.competitors).map((c) => `<li>${link(c.url, c.page || 'ad')}: <q>${esc(cut(c.hook, 140))}</q> <span class="au-small">${esc(c.angle_label || '')}${c.days != null ? ` · ${esc(c.days)} days` : ''}</span></li>`).join('') + '</ul>' : '';
    return `<section class="au" data-au="${esc(card.id)}">` +
      `<p class="au-line">🎯 ${esc(card.one_line_long || card.one_line)}</p>` +
      `<details class="au-d"${open ? ' open' : ''}><summary>Audience card · ${esc(d.statements)} statements · ${esc(d.ads_with_reach)} ad(s) with EU reach · ${esc(d.labelled_by)}</summary>` +
      sec('Who to sell it to', personasHtml(card.personas)) +
      sec('Who the competitor ads reach (Meta EU data)', reachHtml(card.reach)) +
      sec('The problem, in their words', `<p>${esc(card.problem && card.problem.line)}</p>${themeList(card.problem && card.problem.themes)}`) +
      sec('Buying triggers', themeList(card.triggers)) +
      sec('Doubts and how to answer them', themeList(card.objections, true)) +
      sec('Customer words', words + (avoid ? `<p class="au-small">Not to use:</p>${avoid}` : '')) +
      sec('Five hooks (drafts, our words)', anglesHtml(card.angles)) +
      sec('Meta targeting for the first test', targetingHtml(card.targeting)) +
      sec('What competitors say', comps) +
      sec('Facts and gaps', '<ul class="au-small">' + arr(card.facts).map((f) => `<li>${tag('fact')} ${esc(f)}</li>`).join('') + arr(card.assumptions).map((f) => `<li>${tag('assumption')} ${esc(f)}</li>`).join('') +
        arr(card.gaps).map((g) => `<li>${tag('gap')} ${esc(g)}</li>`).join('') + '</ul>') +
      `<p class="au-small">Built ${esc(String(card.built_at || '').slice(0, 16).replace('T', ' '))} UTC · ${esc(d.credits)} credits · ${esc(d.pulls_cached)} cached pulls. Quotes are public comments about other products: research only, never our reviews.</p>` +
      '</details></section>';
  }

  return { html, line, esc, safeUrl };
}

export const { html: audienceHtml, line: audienceLine } = audienceKit();

/** GET /audience.js: the kit's source, run once in the board as window.AUDIENCE. */
export const AUDIENCE_JS = `'use strict';\nwindow.AUDIENCE = (${audienceKit})();\n`;

/** The card's styles, for the board's own <style nonce> block (no inline styles are allowed). */
export const AUDIENCE_CSS = `.au{margin:.5rem 0;font-size:.92rem}.au-line{margin:.25rem 0;font-weight:600}.au-d summary{cursor:pointer;opacity:.85}
.au-sec{margin:.6rem 0}.au-sec h4{margin:.3rem 0;font-size:.9rem}.au-sec ul,.au-sec ol{margin:.2rem 0 .2rem 1.1rem;padding:0}
.au-small{font-size:.8rem;opacity:.8}.au-src{font-size:.75rem;opacity:.7}.au q{font-style:italic}
.au-tag{display:inline-block;font-size:.7rem;padding:0 .3rem;border:1px solid currentColor;border-radius:.3rem;opacity:.75}
.au-chips{display:flex;flex-wrap:wrap;gap:.3rem}.au-chip{border:1px solid currentColor;border-radius:1rem;padding:0 .5rem;font-size:.8rem}.au-chip i{opacity:.6;font-style:normal}
.au-hook{font-weight:600}.au-first .au-hook::after{content:" ★"}.au-answer{font-size:.82rem}
.au-reach,.au-mk{border-collapse:collapse;font-size:.8rem;max-width:100%}.au-reach td,.au-reach th,.au-mk td,.au-mk th{padding:.1rem .4rem;text-align:left}
.au-reach meter{width:6rem}.au-persona{margin:.3rem 0}.au-none{opacity:.7}`;
