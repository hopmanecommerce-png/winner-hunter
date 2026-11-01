/*
 * Text tools for the Problem Database (docs/problem-db/README.md): fold a post into plain words, find the complaint and
 * need patterns of problem-queries.json in it, guess its language and country, and turn it into the words that say
 * what the problem is about (the features problems-process.mjs clusters on). Deterministic: the same text and query
 * bank always give the same answer, so a run can be tested and repeated. Runs in Node (the hashes use node:crypto).
 */
import { createHash } from 'node:crypto';

export const LANGS = ['en', 'nl', 'de'];
const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Lower case, accents off (ä → a, ß → ss), apostrophes out (can't → cant, zo'n → zon), every other mark a space.
 * Patterns and posts are folded the same way, so "Lösung" finds "losung" and "I've" finds "ive".
 */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/['’‘`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The readable text of a post: links, markdown, @handles and extra white space out. Keeps the words as written. */
export function plainText(s, max = 2000) {
  return String(s ?? '')
    .replace(/\[([^\]]{0,200})\]\((?:https?:\/\/|\/)[^)\s]*\)/g, '$1') // [text](link) → text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\s)@[\w.]{2,40}/g, '$1')
    .replace(/[*_~#>`|]+/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export const words = (s) => {
  const f = fold(s);
  return f ? f.split(' ') : [];
};

// ---------------------------------------------------------------------------
// Patterns: "is there a way to", "weet iemand hoe ik ... kan oplossen"
// ---------------------------------------------------------------------------

const GAP = 6; // words that "..." stands for, at most

/** A pattern as parts of folded words: "hoe los ik ... op" → [['hoe', 'los', 'ik'], ['op']]. */
export function compilePhrase(p) {
  return String(p).split('...').map(words).filter((w) => w.length);
}

/** Is the phrase in the words? Its parts in order, the words of a part together, at most GAP words between parts. */
export function hasPhrase(ws, parts) {
  if (!parts.length) return false;
  const at = (part, from, to) => {
    for (let i = from; i <= Math.min(to, ws.length - part.length); i++) {
      let ok = true;
      for (let j = 0; j < part.length && ok; j++) ok = ws[i + j] === part[j];
      if (ok) return i;
    }
    return -1;
  };
  for (let start = 0; start < ws.length; start++) {
    let i = at(parts[0], start, start);
    if (i < 0) continue;
    let pos = i + parts[0].length;
    let ok = true;
    for (const part of parts.slice(1)) {
      const j = at(part, pos, pos + GAP);
      if (j < 0) { ok = false; break; }
      pos = j + part.length;
    }
    if (ok) return true;
  }
  return false;
}

/** The words to search for: the longest part of the pattern ("weet iemand hoe ik ... kan oplossen" → "weet iemand hoe ik"). */
export function searchPhrase(p) {
  const parts = String(p).split('...').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
  return parts.sort((a, b) => b.length - a.length)[0] || '';
}

const SIGNALS = ['intensity', 'pay', 'seeking', 'tried', 'agree'];

/**
 * Finds the bank's patterns and signals in a text, in every language (a Dutch post can say "so annoying"). Returns a
 * function text → { patterns: ['en:is there a way to'], kinds: ['need'], intensity, pay, seeking, tried, agree }:
 * the counts are how many different signal phrases were found.
 */
export function makeMatcher(bank) {
  const pats = [];
  for (const lang of Object.keys(bank.patterns || {})) {
    for (const x of bank.patterns[lang]) pats.push({ key: `${lang}:${x.p}`, kind: x.kind, parts: compilePhrase(x.p) });
  }
  const sig = {};
  for (const s of SIGNALS) {
    sig[s] = [];
    for (const list of Object.values((bank.signals && bank.signals[s]) || {})) for (const p of list) sig[s].push(compilePhrase(p));
  }
  return (text) => {
    const ws = words(text);
    const found = pats.filter((x) => hasPhrase(ws, x.parts));
    const out = { patterns: found.map((x) => x.key), kinds: [...new Set(found.map((x) => x.kind))] };
    for (const s of SIGNALS) out[s] = sig[s].filter((parts) => hasPhrase(ws, parts)).length;
    return out;
  };
}

/**
 * Does a text state a problem or ask for a fix (sig: a makeMatcher answer)? A post: a pattern, or "I would pay",
 * "looking for a solution", "I tried". A comment also when it agrees ("same here") or is upset: its post says what about.
 */
export const relevantOf = (sig, kind) => sig.patterns.length > 0 || sig.pay > 0 || sig.seeking > 0 || sig.tried > 0 || (kind === 'comment' && (sig.agree > 0 || sig.intensity > 0));

/** Every folded word the patterns and signals use: complaint words, not topic words, so they never glue two problems together. */
export function complaintWords(bank) {
  const out = new Set();
  const add = (p) => { for (const w of words(String(p).replace(/\.\.\./g, ' '))) out.add(w); };
  for (const list of Object.values(bank.patterns || {})) for (const x of list) add(x.p);
  for (const s of Object.values(bank.signals || {})) for (const list of Object.values(s)) for (const p of list) add(p);
  return out;
}

// ---------------------------------------------------------------------------
// Language and country
// ---------------------------------------------------------------------------

// Short words only one of the three languages uses often. Words two of them share (die, is, was, of, in, an) say nothing.
const MARKERS = {
  en: 'the and it to that my you for this with have but not are be just can what how when there anyone any way get does do they them your its from at or if about would should could been has had really because'.split(' '),
  nl: 'de het een en van ik je dat niet op te met voor zijn er maar ook als om wat mijn hoe heb kan wel nog bij weet iemand geen dit naar zo ze hij hebben wordt heeft waar omdat dan al uit door jullie mij moet'.split(' '),
  de: 'der das und ist ich nicht es zu ein eine mit mein meine auf fur auch wie hat habe kann mir mich sich den dem von aber noch schon bei gibt jemand kein keine oder wenn sind wird nach uber weil dass immer hier'.split(' '),
};
const MARKER_OF = new Map();
for (const lang of LANGS) for (const w of MARKERS[lang]) MARKER_OF.set(w, (MARKER_OF.get(w) || []).concat(lang));

/**
 * en, nl, de or '' (not sure). Counts the short words only one language uses often; ä ö ü ß count for German and "ij"
 * for Dutch. Needs two more hits than the next language, unless the text is short: then the prior (the language the
 * query was in) decides between close calls.
 */
export function detectLang(text, prior = '') {
  const raw = String(text ?? '').toLowerCase();
  const score = { en: 0, nl: 0, de: 0 };
  for (const w of words(raw)) for (const lang of MARKER_OF.get(w) || []) score[lang] += 1;
  score.de += Math.min(3, (raw.match(/[äöüß]/g) || []).length);
  score.nl += Math.min(2, (raw.match(/[a-z]ij[a-z]?/g) || []).length * 0.5);
  const ranked = LANGS.map((l) => [l, score[l]]).sort((a, b) => b[1] - a[1] || LANGS.indexOf(a[0]) - LANGS.indexOf(b[0]));
  const [[best, top], [, next]] = ranked;
  if (top >= 2 && top - next >= 2) return best;
  if (top >= 1 && LANGS.includes(prior) && score[prior] >= next && score[prior] > 0) return prior;
  if (top >= 1 && top > next) return best;
  return LANGS.includes(prior) && top === 0 ? prior : '';
}

/**
 * Where a post is probably from: a cue word in it (a city, a shop, "gemeente"), else its community (r/thenetherlands),
 * else its language (Dutch → NL, German → DE). English without a cue: '' (unknown, could be anywhere).
 */
export function guessCountry(text, lang, community, countries = {}) {
  const ws = ` ${fold(text)} `;
  const comm = String(community || '').toLowerCase();
  let best = '';
  let hits = 0;
  for (const [cc, c] of Object.entries(countries)) {
    const n = (c.cues || []).filter((cue) => ws.includes(` ${fold(cue)} `)).length;
    if (n > hits) { best = cc; hits = n; }
  }
  if (best) return best;
  for (const [cc, c] of Object.entries(countries)) if ((c.communities || []).some((x) => x.toLowerCase() === comm)) return cc;
  return lang === 'nl' ? 'NL' : lang === 'de' ? 'DE' : '';
}

// ---------------------------------------------------------------------------
// Topic words: what a complaint is about
// ---------------------------------------------------------------------------

const STOP = new Set([
  // English
  ...'a an the and or but if so of to in on at by for with from up out off over into onto about as than then that this these those there here it its is are was were be been being am do does did done doing have has had having i me my mine myself you your yours we us our they them their he him his she her hers who whom whose which what when where why how all any both each few more most other some such no nor not only own same too very can could will would shall should may might must just also again ever even still yet already really actually literally basically pretty quite rather much many lot lots little bit thing things stuff something anything nothing everything someone anyone everyone people person guy guys way ways time times day days week weeks year years make makes made making get gets got getting go goes went going gone come comes came take takes took put puts keep keeps kept know knows knew think thought want wants wanted need needs needed try tries tried trying use uses used using seem seems say says said tell told look looks looked find found give gave like likes liked love loved feel feels felt let lets help helps helped please thanks thank anyone else problem problems issue issues solution solutions fix fixes fixed tip tips advice idea ideas question questions answer reddit post edit update lol omg yes yeah ok okay im ive id dont doesnt didnt cant couldnt wont wouldnt isnt arent wasnt hasnt havent thats theres whats its youre theyre one two three first last new old good bad better best worse worst big small lot every'.split(' '),
  // Dutch
  ...'de het een en of maar als dan dat dit die deze daar hier er is zijn was waren ben bent wordt worden werd heeft hebben had heb kan kunnen kon zal zou zouden moet moeten mag mogen wil willen ik jij je u hij zij ze wij we jullie mij mijn me jou jouw zijn haar ons onze hun hen wie wat waar wanneer waarom hoe welke van in op aan bij met voor naar uit door over onder tegen tot om te toe nog al ook wel niet geen niets iets alles iemand niemand iedereen heel erg zo zeer veel weinig meer minder echt gewoon eigenlijk misschien altijd nooit vaak soms keer dag week jaar tijd ding dingen manier probleem problemen oplossing oplossingen tip tips vraag hulp weet weten denk denken vind vinden doe doen deed gedaan krijg krijgen kreeg ga gaan ging komt komen kwam maak maken gemaakt zie zien zag zeg zeggen zei gebruik gebruiken geprobeerd proberen probeer graag bedankt dank alvast hoi hallo eens even toch dus want omdat zoals zonder sinds nu nou mee af terug elke elk ieder iedere alle allemaal steeds'.split(' '),
  // German (folded: fur, uber, konnen)
  ...'der die das den dem des ein eine einer einen einem und oder aber wenn dann dass weil als wie so auch noch schon nur sehr viel mehr weniger immer nie oft manchmal mal jetzt hier dort da es ist sind war waren bin bist sein wird werden wurde hat haben hatte habe kann konnen konnte soll sollte muss mussen darf will wollen mochte ich du er sie wir ihr mich mir dich dir sich uns euch mein meine meiner meinen dein deine sein seine ihr ihre unser unsere wer was wo wann warum welche welcher von zu mit fur auf aus bei nach vor uber unter gegen durch ohne um bis seit nicht kein keine keinen nichts etwas alles jemand niemand jeder man ganz echt eigentlich vielleicht wirklich einfach ding dinge sache sachen art weise problem probleme losung losungen tipp tipps frage hilfe weiss wissen denke glaube finde mache machen gemacht bekomme bekommen gehe gehen kommt kommen sehe sehen sage sagen benutze benutzen probiert versucht danke bitte hallo hey also doch halt eben mal ja nein gibt gab tag woche jahr zeit jede jeden jeder jedes alle standig'.split(' '),
]);

/** A crude stem, the same for every form of a word: dogs → dog, honden → hond, katten → kat, Hunde → hund. */
export function stem(w, lang) {
  let s = w;
  const dedouble = (x) => (/([bdfgklmnprst])\1$/.test(x) ? x.slice(0, -1) : x);
  // English keeps ll, ss and zz (fall, kiss, buzz): only running → run, stopped → stop.
  const dedoubleEn = (x) => (/([bdfgkmnprt])\1$/.test(x) ? x.slice(0, -1) : x);
  if (lang === 'en') {
    if (s.length > 4 && s.endsWith('ies')) return s.slice(0, -3) + 'y';
    if (s.length > 4 && /(sses|shes|ches|xes|zes)$/.test(s)) return s.slice(0, -2);
    if (s.length > 5 && s.endsWith('ing') && s.length - 3 >= 4) return dedoubleEn(s.slice(0, -3));
    if (s.length > 5 && s.endsWith('ed') && s.length - 2 >= 4 && !s.endsWith('eed')) return dedoubleEn(s.slice(0, -2));
    if (s.length > 3 && s.endsWith('s') && !/(ss|us|is)$/.test(s)) return s.slice(0, -1);
    return s;
  }
  if (lang === 'nl') {
    for (const suf of ['tjes', 'tje', 'jes', 'je']) if (s.length - suf.length >= 3 && s.endsWith(suf)) return s.slice(0, -suf.length);
    if (s.length > 5 && s.endsWith('en')) return dedouble(s.slice(0, -2));
    if (s.length > 4 && s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
    if (s.length > 5 && s.endsWith('e')) return s.slice(0, -1);
    return s;
  }
  if (lang === 'de') {
    for (const suf of ['ern', 'en', 'er', 'es', 'e', 'n', 's']) {
      if (s.length - suf.length >= 4 && s.endsWith(suf)) return s.slice(0, -suf.length);
    }
    return s;
  }
  return s;
}

/**
 * The words that say what a text is about, stemmed, in order: no stop words, no complaint words (`skip`, from
 * complaintWords), no numbers. surface: stem → the word as most often written, for titles.
 */
export function topicTerms(text, lang, skip = new Set(), surface = null) {
  const out = [];
  for (const w of words(text)) {
    if (w.length < 2 || /^\d+$/.test(w) || STOP.has(w) || skip.has(w)) continue;
    const s = stem(w, lang || 'en');
    if (s.length < 2 || STOP.has(s)) continue;
    out.push(s);
    if (surface) {
      const m = surface.get(s) || new Map();
      m.set(w, (m.get(w) || 0) + 1);
      surface.set(s, m);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

/** The same text (folded, first 600 characters) gives the same hash: copies, crossposts and bots count once. */
export const textHash = (s) => sha('t|' + fold(s).slice(0, 600)).slice(0, 20);

/** Who wrote it, without their name: counts different people. '' when the platform gives no author. */
export const authorHash = (platform, author) => (author ? sha(`a|${platform}|${String(author).toLowerCase()}`).slice(0, 16) : '');

/** Character shingles of the folded text, for "almost the same text". */
export function shingles(s, n = 5) {
  const f = fold(s).replace(/ /g, '_');
  const out = new Set();
  for (let i = 0; i + n <= f.length; i++) out.add(f.slice(i, i + n));
  if (!out.size && f) out.add(f);
  return out;
}

export function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const sentencesOf = (text) => String(text || '').split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 3);

/** The sentence of a text that states the problem best: the highest score(sentence), the first of equals. Cut to `max`. */
export function problemSentence(text, score = () => 0, max = 200) {
  let pick = String(text || '').trim();
  let best = -Infinity;
  for (const s of sentencesOf(text)) {
    const v = score(s);
    if (v > best) { best = v; pick = s; }
  }
  return pick.length > max ? pick.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : pick;
}
