/*
 * From mentions to problems (problems-process.mjs), with cheap deterministic methods only: the same mentions and the
 * same query bank always give the same problems, ids included.
 *   const out = processMentions(rows, { bank, now });   → { problems, clusters, fields, stats }
 * 1. Each mention: its language, a country guess, the patterns and signals in its own text, and its topic words
 *    (problem-text.mjs: no stop words, no complaint words, so "so annoying" never glues two problems together). A
 *    comment also gets the words of its post's title, at half weight: "same problem here!" under a video about dog
 *    hair is about dog hair.
 * 2. Only mentions whose own text states a problem or asks for a fix count ("relevant"). Copies count once: the same
 *    long text twice (crossposts, bots), or the same person saying almost the same thing again.
 * 3. Words and word pairs weighted by how rare they are (tf-idf), compared by cosine: each mention joins the group it is
 *    most like (at least `threshold`), or starts one; then groups that are alike merge (`mergeThreshold`).
 * 4. A group of at least `minMentions` is a problem: its title, one line, life area, quotes with links, languages,
 *    countries, platforms, first and last post, mentions, people, engagement, trend, intensity and willingness to pay.
 * 5. A problem keeps the id of the problem most of its mentions were in before, so your decision on it stays.
 * No products anywhere: a problem record only describes what people say is wrong.
 */
import { createHash } from 'node:crypto';
import { complaintWords, detectLang, fold, guessCountry, jaccard, makeMatcher, problemSentence, relevantOf, shingles, stem, textHash, topicTerms, words } from './problem-text.mjs';

export const OPTS = { threshold: 0.3, mergeThreshold: 0.5, minMentions: 2, quotes: 8, features: 40 };
const DAY = 864e5;
const sha = (s) => createHash('sha256').update(s).digest('hex');
const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const count = (xs) => {
  const m = {};
  for (const x of xs) if (x) m[x] = (m[x] || 0) + 1;
  return m;
};
const top = (m) => Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
const engagementOf = (m) => (Number(m.score) || 0) + (Number(m.replies) || 0);

/** stem → life area, from every area's keywords in every language. */
function areaIndex(bank) {
  const idx = new Map();
  for (const [area, a] of Object.entries(bank.areas)) {
    for (const [lang, list] of Object.entries(a.keywords)) {
      for (const k of list) for (const w of words(k)) {
        const s = stem(w, lang);
        if (s.length >= 3 && !idx.has(s)) idx.set(s, area);
      }
    }
  }
  return idx;
}

/** A mention, ready to group: its own text and context, language, country, signals, topic words. */
export function prepare(rows, bank) {
  const match = makeMatcher(bank);
  const skip = complaintWords(bank);
  const areas = areaIndex(bank);
  const surface = new Map();
  const out = rows.map((r) => {
    const comment = r.kind === 'comment';
    const own = comment ? String(r.body || '') : [r.title, r.body].filter(Boolean).join('\n');
    const lang = detectLang(own, r.lang || '');
    const sig = match(own);
    const kinds = new Set(sig.kinds);
    const relevant = relevantOf(sig, r.kind);
    const terms = topicTerms(own, lang, skip, surface);
    const context = comment ? topicTerms(r.title || '', detectLang(r.title || '', lang), skip, surface) : [];
    let area = r.area || '';
    if (!area) {
      const votes = count(terms.concat(context).map((t) => areas.get(t)));
      area = (top(votes) || [''])[0];
    }
    return {
      ...r, own, lang, country: guessCountry(`${own} ${r.title || ''}`, lang, r.community, bank.countries), sig, kinds, relevant, terms, context, area,
      eng: engagementOf(r), exclaim: (own.match(/!/g) || []).length, caps: (own.match(/\b[A-ZÄÖÜ]{3,}\b/g) || []).length,
    };
  });
  return { mentions: out, surface, match };
}

/**
 * Copies count once. Returns Map dup id → the id of the mention it copies: the same long text (12+ words) anywhere, or
 * the same person (author_hash) with almost the same text (shingles 85% alike). The one kept: most engagement, then
 * the lowest id.
 */
export function duplicates(mentions) {
  const dup = new Map();
  const order = [...mentions].sort((a, b) => b.eng - a.eng || (a.id < b.id ? -1 : 1));
  const byText = new Map();
  for (const m of order) {
    if (words(m.own).length < 12) continue;
    const h = textHash(m.own);
    if (byText.has(h)) dup.set(m.id, byText.get(h));
    else byText.set(h, m.id);
  }
  const byAuthor = new Map();
  for (const m of order) {
    if (!m.author_hash || dup.has(m.id)) continue;
    const mine = byAuthor.get(m.author_hash) || [];
    const sh = shingles(m.own);
    const same = mine.find((x) => jaccard(x.sh, sh) >= 0.85);
    if (same) dup.set(m.id, same.id);
    else mine.push({ id: m.id, sh });
    byAuthor.set(m.author_hash, mine);
  }
  return dup;
}

/**
 * tf-idf vectors (Map feature → weight, unit length, the `keep` strongest): words, word pairs and the context words
 * (half weight). A feature only one mention has is left out: it can link nothing, and a long post full of such words
 * would otherwise look unlike every short comment about the same thing.
 */
export function vectors(mentions, keep = OPTS.features) {
  const raw = mentions.map((m) => {
    const f = new Map();
    const add = (k, w) => f.set(k, (f.get(k) || 0) + w);
    for (const t of m.terms) add(t, 1);
    for (let i = 0; i + 1 < m.terms.length; i++) if (m.terms[i] !== m.terms[i + 1]) add(`${m.terms[i]}|${m.terms[i + 1]}`, 1);
    for (const t of m.context) if (!m.terms.includes(t)) add(t, 0.5);
    return f;
  });
  const df = new Map();
  for (const f of raw) for (const k of f.keys()) df.set(k, (df.get(k) || 0) + 1);
  const n = raw.length || 1;
  return raw.map((f) => {
    const v = [...f].filter(([k]) => df.get(k) >= 2).map(([k, tf]) => [k, (tf >= 1 ? 1 + Math.log(tf) : tf) * Math.log(1 + n / df.get(k))])
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, keep);
    const norm = Math.sqrt(v.reduce((s, [, w]) => s + w * w, 0)) || 1;
    return new Map(v.map(([k, w]) => [k, w / norm]));
  });
}

const dot = (a, b) => {
  let s = 0;
  const [x, y] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, w] of x) {
    const u = y.get(k);
    if (u) s += w * u;
  }
  return s;
};
const unit = (m) => {
  const norm = Math.sqrt([...m.values()].reduce((s, w) => s + w * w, 0)) || 1;
  return new Map([...m].map(([k, w]) => [k, w / norm]));
};
/** Features two vectors share: one shared word ("dog") never makes two complaints one problem. */
const shared = (a, b) => {
  let n = 0;
  const [x, y] = a.size <= b.size ? [a, b] : [b, a];
  for (const k of x.keys()) if (y.has(k)) n++;
  return n;
};
const MIN_SHARED = 2;
const strongest = (v, n) => [...v].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k]) => k);

/**
 * Groups mentions (with their vectors) by cosine to each group's centre: biggest engagement first, each joins the most
 * alike group at `threshold` or more, else starts one. Then a merge pass over the groups at `mergeThreshold`.
 * Returns groups { members: [index], centroid: Map }.
 */
export function cluster(mentions, vecs, { threshold = OPTS.threshold, mergeThreshold = OPTS.mergeThreshold } = {}) {
  const order = mentions.map((m, i) => i).filter((i) => vecs[i].size).sort((a, b) => mentions[b].eng - mentions[a].eng || (mentions[a].id < mentions[b].id ? -1 : 1));
  const groups = [];
  const index = new Map(); // feature → group numbers
  const indexGroup = (g, gi) => { for (const k of strongest(g.centroid, 12)) { if (!index.has(k)) index.set(k, new Set()); index.get(k).add(gi); } };
  for (const i of order) {
    const v = vecs[i];
    const cands = new Set();
    for (const k of strongest(v, 6)) for (const gi of index.get(k) || []) cands.add(gi);
    let best = -1;
    let bestSim = 0;
    for (const gi of [...cands].sort((a, b) => a - b)) {
      if (shared(v, groups[gi].centroid) < MIN_SHARED) continue;
      const sim = dot(v, groups[gi].unit);
      if (sim > bestSim + 1e-12) { best = gi; bestSim = sim; }
    }
    if (best >= 0 && bestSim >= threshold) {
      const g = groups[best];
      g.members.push(i);
      for (const [k, w] of v) g.centroid.set(k, (g.centroid.get(k) || 0) + w);
      g.unit = unit(g.centroid);
      indexGroup(g, best);
    } else {
      const g = { members: [i], centroid: new Map(v) };
      g.unit = unit(g.centroid);
      groups.push(g);
      indexGroup(g, groups.length - 1);
    }
  }
  // Merge: the biggest groups first; a group that is alike enough goes into the bigger one.
  const alive = groups.map(() => true);
  const bySize = groups.map((g, gi) => gi).sort((a, b) => groups[b].members.length - groups[a].members.length || a - b);
  for (const gi of bySize) {
    if (!alive[gi]) continue;
    const g = groups[gi];
    const cands = new Set();
    for (const k of strongest(g.unit, 8)) for (const gj of index.get(k) || []) if (gj !== gi && alive[gj]) cands.add(gj);
    for (const gj of [...cands].sort((a, b) => a - b)) {
      if (shared(g.centroid, groups[gj].centroid) < MIN_SHARED || dot(g.unit, groups[gj].unit) < mergeThreshold) continue;
      const h = groups[gj];
      g.members.push(...h.members);
      for (const [k, w] of h.centroid) g.centroid.set(k, (g.centroid.get(k) || 0) + w);
      g.unit = unit(g.centroid);
      alive[gj] = false;
    }
  }
  return groups.filter((g, gi) => alive[gi]).map((g) => ({ members: g.members.sort((a, b) => a - b), centroid: g.unit }));
}

// ---------------------------------------------------------------------------
// One problem from a group
// ---------------------------------------------------------------------------

/** Mentions a month for the last 12 months: [['2025-11', 0], …, ['2026-10', 4]]. */
export function monthly(dates, now) {
  const end = new Date(now);
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const n = count(dates.map((d) => String(d).slice(0, 7)));
  return months.map((m) => [m, n[m] || 0]);
}

/**
 * Trend: mentions of the last 90 days against the 90 days before. With enough mentions overall (30+ in both windows)
 * each window is taken as a share of all mentions found then, because searches find recent posts more easily than old
 * ones; with fewer, the plain counts. new: the first post is from the last 60 days.
 */
export function trendOf(dates, now, base = { recent: 0, prior: 0 }) {
  const t = dates.map((d) => Date.parse(d)).filter(Number.isFinite);
  const recent = t.filter((x) => x >= now - 90 * DAY).length;
  const prior = t.filter((x) => x >= now - 180 * DAY && x < now - 90 * DAY).length;
  const growth = base.recent >= 30 && base.prior >= 30
    ? ((recent + 1) / (base.recent + 1)) / ((prior + 1) / (base.prior + 1))
    : (recent + 1) / (prior + 1);
  const first = t.length ? Math.min(...t) : NaN;
  const trend = Number.isFinite(first) && first >= now - 60 * DAY && t.length >= 2 ? 'new'
    : growth >= 1.5 && recent >= 3 ? 'rising'
      : growth <= 0.67 && prior >= 3 ? 'falling' : 'steady';
  return { trend, growth: round(growth, 2), recent, prior };
}

/**
 * Intensity 0-100: half how upset the words are (signals.intensity, "!!", WORDS IN CAPITALS), 0.3 engagement (log: 1,000
 * likes and replies a mention is the top), 0.2 how many mention it (log: 100 mentions is the top).
 */
export function intensityOf(members) {
  if (!members.length) return 0;
  const emo = members.reduce((s, m) => s + Math.min(1, (m.sig.intensity + (m.exclaim >= 2 ? 0.5 : 0) + (m.caps >= 2 ? 0.5 : 0)) / 2), 0) / members.length;
  const eng = Math.min(1, members.reduce((s, m) => s + Math.log10(1 + m.eng), 0) / members.length / 3);
  const vol = Math.min(1, Math.log10(1 + members.length) / 2);
  return Math.round(100 * (0.5 * emo + 0.3 * eng + 0.2 * vol));
}

/**
 * Willingness to pay 0-100, from what people say: "I would pay" (1), looking for a solution or asking for a fix (0.4),
 * "I tried X and Y" (0.3), per mention at most 1, over the mentions (at least 3, so one post is never 100).
 */
export function wtpOf(members) {
  const s = { pay: 0, seeking: 0, tried: 0 };
  let sum = 0;
  for (const m of members) {
    const pay = m.sig.pay > 0;
    const seeking = m.sig.seeking > 0 || m.kinds.has('need') || m.kinds.has('question');
    const tried = m.sig.tried > 0;
    s.pay += pay;
    s.seeking += seeking;
    s.tried += tried;
    sum += Math.min(1, (pay ? 1 : 0) + (seeking ? 0.4 : 0) + (tried ? 0.3 : 0));
  }
  return { wtp: Math.round((100 * sum) / Math.max(3, members.length)), signals: s };
}

/** The words of a feature as most often written: 'dog|hair' → 'dog hair'. */
const surfaceOf = (surface, k) => k.split('|').map((s) => {
  const m = surface.get(s);
  return m ? [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0] : s;
}).join(' ');

/** The top words of a group: a word pair counts a third more, and a word is never listed twice (alone or in a pair). */
export function keywordsOf(centroid, surface, n = 6) {
  const out = [];
  const used = new Set();
  const w = ([k, x]) => (k.includes('|') ? x * 1.34 : x);
  const ranked = [...centroid].sort((a, b) => w(b) - w(a) || (a[0] < b[0] ? -1 : 1));
  for (const [k] of ranked) {
    if (out.length >= n) break;
    const parts = k.split('|');
    if (parts.some((p) => used.has(p))) continue;
    out.push(surfaceOf(surface, k));
    for (const p of parts) used.add(p);
  }
  return out;
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s);
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The problem record of a group. members: the mentions it counts (no copies). ctx: { now, surface, match, base, sample,
 * vecs (Map mention id → vector) }.
 */
export function problemOf(members, centroid, ctx) {
  const { now, surface } = ctx;
  const dates = members.map((m) => m.created_at).filter(Boolean);
  const when = dates.length ? dates : members.map((m) => m.first_seen).filter(Boolean);
  const sorted = [...when].sort();
  const keywords = keywordsOf(centroid, surface);
  // The mention that says it best: most like the centre, with a pattern in its own words, and engagement.
  const fit = (m) => (ctx.vecs.get(m.id) ? dot(ctx.vecs.get(m.id), centroid) : 0) * (1 + Math.log10(1 + m.eng)) * (m.sig.patterns.length ? 1.3 : 1);
  const ranked = [...members].sort((a, b) => fit(b) - fit(a) || (a.id < b.id ? -1 : 1));
  const rep = ranked[0];
  // Its one line: the sentence with most of the problem's words in it (a pattern counts too), so "Is there a way to
  // stop it?" loses to "Black mold in shower grout keeps coming back".
  const core = new Set([...centroid].sort((a, b) => b[1] - a[1]).slice(0, 8).flatMap(([k]) => k.split('|')));
  const lang = rep.lang || 'en';
  const sentenceScore = (s) => new Set(words(s).map((x) => stem(x, lang)).filter((x) => core.has(x))).size * 2 + (ctx.match(s).patterns.length ? 1 : 0);
  // Quotes: the best first, a different platform each turn while there are several.
  const byPlatform = new Map();
  for (const m of ranked) byPlatform.set(m.platform, (byPlatform.get(m.platform) || []).concat(m));
  const picks = [];
  for (let i = 0; picks.length < (ctx.quotes || OPTS.quotes) && i < members.length; i++) {
    for (const ms of byPlatform.values()) if (ms[i] && picks.length < (ctx.quotes || OPTS.quotes)) picks.push(ms[i]);
  }
  const { trend, growth } = trendOf(dates, now, ctx.base);
  const { wtp, signals } = wtpOf(members);
  const langs = count(members.map((m) => m.lang));
  const countries = count(members.map((m) => m.country));
  const areas = count(members.map((m) => m.area));
  const authors = new Set(members.map((m) => m.author_hash).filter(Boolean)).size;
  const title = keywords.length ? clip(keywords.slice(0, 3).map(cap1).join(' · '), 80) : problemSentence(rep.own, sentenceScore, 80);
  const quoteIds = picks.map((m) => m.id);
  return {
    id: '', title, statement: problemSentence(rep.own, sentenceScore, 200), area: (top(areas) || [''])[0],
    lang: (top(langs) || [''])[0], langs, country: (top(countries) || [''])[0], countries, platforms: count(members.map((m) => m.platform)),
    mentions: members.length, authors, engagement: members.reduce((s, m) => s + m.eng, 0),
    first_seen: sorted[0] || '', last_seen: sorted[sorted.length - 1] || '', trend, growth, monthly: monthly(dates, now),
    intensity: intensityOf(members), wtp, wtp_signals: signals, keywords,
    quotes: picks.map((m) => ({ id: m.id, text: clip(m.own, 280), url: m.url, platform: m.platform, lang: m.lang, at: m.created_at || '', score: m.eng })),
    flags: [], named_by: 'rules', llm_key: sha('k|' + quoteIds.join(',')).slice(0, 16), sample: members.some((m) => Number(m.sample) === 1),
    member_ids: members.map((m) => m.id),
  };
}

/**
 * Stable ids: each problem takes the id most of its mentions had before (problem_id on the rows), biggest problems
 * first, each old id once; else a new id from its oldest mention's id.
 */
export function assignIds(problems, prevOf) {
  const taken = new Set();
  const order = problems.map((p, i) => i).sort((a, b) => problems[b].mentions - problems[a].mentions || (problems[a].member_ids[0] < problems[b].member_ids[0] ? -1 : 1));
  for (const i of order) {
    const p = problems[i];
    const votes = count(p.member_ids.map((id) => prevOf.get(id)));
    const old = Object.entries(votes).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id]) => id).find((id) => !taken.has(id));
    let id = old || 'p_' + sha('p|' + [...p.member_ids].sort()[0]).slice(0, 12);
    for (let n = 2; taken.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
    taken.add(id);
    p.id = id;
  }
  return problems;
}

/**
 * Everything: rows of problem_mentions in, problems and the fields to write back on each mention out.
 * opts: { bank, now, threshold, mergeThreshold, minMentions, quotes }.
 */
export function processMentions(rows, { bank, now = Date.now(), ...o } = {}) {
  const opts = { ...OPTS, ...o };
  const { mentions, surface, match } = prepare(rows, bank);
  const relevant = mentions.filter((m) => m.relevant);
  const dup = duplicates(relevant);
  const counted = relevant.filter((m) => !dup.has(m.id));
  const vecs = vectors(counted, opts.features);
  const groups = cluster(counted, vecs, opts);
  const vecOf = new Map(counted.map((m, i) => [m.id, vecs[i]]));
  const t = counted.map((m) => Date.parse(m.created_at)).filter(Number.isFinite);
  const base = { recent: t.filter((x) => x >= now - 90 * DAY).length, prior: t.filter((x) => x >= now - 180 * DAY && x < now - 90 * DAY).length };
  const ctx = { now, surface, match, base, vecs: vecOf, quotes: opts.quotes };
  const problems = groups.filter((g) => g.members.length >= opts.minMentions).map((g) => problemOf(g.members.map((i) => counted[i]), g.centroid, ctx));
  const prevOf = new Map(rows.filter((r) => r.problem_id).map((r) => [r.id, r.problem_id]));
  assignIds(problems, prevOf);
  const problemOfMention = new Map();
  for (const p of problems) for (const id of p.member_ids) problemOfMention.set(id, p.id);
  for (const [d, of] of dup) if (problemOfMention.has(of)) problemOfMention.set(d, problemOfMention.get(of));
  const fields = mentions.map((m) => ({ id: m.id, lang: m.lang, country: m.country, relevant: m.relevant ? 1 : 0, problem_id: problemOfMention.get(m.id) || null }));
  const byId = new Map(mentions.map((m) => [m.id, m]));
  return {
    problems, fields, ctx, byId, groups: groups.map((g) => ({ ids: g.members.map((i) => counted[i].id), centroid: g.centroid })),
    stats: { mentions: rows.length, relevant: relevant.length, copies: dup.size, groups: groups.length, problems: problems.length, in_problems: problems.reduce((s, p) => s + p.mentions, 0) },
  };
}

/** A problem again from the mentions of two or more (Claude's merges): the centre of all their words. */
export function mergedProblem(ids, out) {
  const members = ids.map((id) => out.byId.get(id)).filter(Boolean);
  const c = new Map();
  for (const m of members) for (const [k, w] of out.ctx.vecs.get(m.id) || []) c.set(k, (c.get(k) || 0) + w);
  return problemOf(members, unit(c), out.ctx);
}

export { fold };
