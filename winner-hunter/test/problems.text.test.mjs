// The Problem Database's text tools (lib/problem-text.mjs) and query bank (problem-queries.json, lib/problem-bank.mjs):
// folding, patterns with "...", language and country guesses, topic words, dedupe hashes; the bank's checks and plans.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { BANK_FILE, KINDS, PRODUCT_WORDS, interleave, loadBank, pairs, planFor, roundRobin, searchTexts, validateBank } from '../lib/problem-bank.mjs';
import { authorHash, compilePhrase, complaintWords, detectLang, fold, guessCountry, hasPhrase, jaccard, makeMatcher, plainText, problemSentence, relevantOf, searchPhrase, shingles, stem, textHash, topicTerms, words } from '../lib/problem-text.mjs';
import { SOURCES } from '../lib/problem-sources.mjs';

const bank = loadBank();
const fresh = () => JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));

test('fold: lower case, no accents, no apostrophes, marks become spaces; patterns and posts fold alike', () => {
  assert.strictEqual(fold("Gibt es eine Lösung für's Sofa? Straße!"), 'gibt es eine losung furs sofa strasse');
  assert.strictEqual(fold("I've tried EVERYTHING… can't stand it"), 'ive tried everything cant stand it');
  assert.strictEqual(fold("ik heb er zo'n hekel aan"), 'ik heb er zon hekel aan');
  assert.deepStrictEqual(words('  '), []);
  assert.strictEqual(plainText('See [this](https://x.test/a) and https://y.test/b, @someone said &amp; ** done **'), 'See this and said & done');
});

test('patterns: words in order, "..." stands for up to six words, anywhere in the text', () => {
  const p = compilePhrase('weet iemand hoe ik ... kan oplossen');
  assert.deepStrictEqual(p, [['weet', 'iemand', 'hoe', 'ik'], ['kan', 'oplossen']]);
  assert.ok(hasPhrase(words('Hoi! Weet iemand hoe ik de stank van de kattenbak kan oplossen?'), p));
  assert.ok(!hasPhrase(words('weet iemand hoe ik dit en dat en zo en nog veel meer dingen kan oplossen'), p), 'more than six words between: no');
  assert.ok(!hasPhrase(words('kan oplossen weet iemand hoe ik'), p), 'the order counts');
  assert.ok(hasPhrase(words('Nervt total.'), compilePhrase('nervt')));
  assert.ok(!hasPhrase(words('unnervt'), compilePhrase('nervt')), 'whole words only');
  assert.strictEqual(searchPhrase('weet iemand hoe ik ... kan oplossen'), 'weet iemand hoe ik');
  assert.strictEqual(searchPhrase('is there a way to'), 'is there a way to');
});

test('the matcher finds complaint patterns and signals in every language, and says what is relevant', () => {
  const m = makeMatcher(bank);
  const en = m('Is there a way to stop my dog shedding? I have tried everything, I would pay anything!');
  assert.deepStrictEqual(en.patterns, ['en:is there a way to']);
  assert.deepStrictEqual(en.kinds, ['need']);
  assert.ok(en.pay >= 1 && en.tried >= 1);
  const nl = m("Ik heb er zo'n hekel aan dat de kattenbak stinkt, niks helpt");
  assert.ok(nl.patterns.includes("nl:ik heb er zo'n hekel aan") && nl.patterns.includes('nl:niks helpt'));
  const de = m('Mein Hund haart so extrem, gibt es eine Lösung für das Sofa? Nervt total.');
  assert.ok(de.patterns.includes('de:nervt') && de.patterns.includes('de:gibt es eine Lösung für'));
  assert.ok(de.intensity >= 1);
  const agree = m('same here 😩');
  assert.strictEqual(agree.agree, 1);
  assert.ok(relevantOf(agree, 'comment') && !relevantOf(agree, 'post'), '"same here" counts under a post, not as a post');
  assert.ok(!relevantOf(m('My new couch arrived today, love it'), 'post'));
  // Complaint words never become topic words: "so annoying" does not glue two problems together.
  const skip = complaintWords(bank);
  for (const w of ['annoying', 'hate', 'nervt', 'hekel', 'tried']) assert.ok(skip.has(w), w);
  assert.ok(!skip.has('dog') && !skip.has('kattenbak'));
});

test('language: en, nl, de from the short words only one of them uses; the query language decides close calls', () => {
  assert.strictEqual(detectLang('Is there a way to keep dog hair off the couch?'), 'en');
  assert.strictEqual(detectLang('Weet iemand hoe ik de stank van de kattenbak kan oplossen?'), 'nl');
  assert.strictEqual(detectLang('Gibt es eine Lösung für das Kondenswasser am Fenster? Ich lüfte schon jeden Tag.'), 'de');
  assert.strictEqual(detectLang('lol 😂'), '');
  assert.strictEqual(detectLang('lol 😂', 'nl'), 'nl', 'no words at all: the query language');
  assert.strictEqual(detectLang('kattenbak stank', 'nl'), 'nl');
  assert.strictEqual(detectLang('Hundehaare überall'), 'de', 'umlauts count for German');
});

test('country: a cue word, else the community, else the language; English without a cue is unknown', () => {
  const c = bank.countries;
  assert.strictEqual(guessCountry('Gekocht bij Albert Heijn, stinkt nog steeds', 'nl', '', c), 'NL');
  assert.strictEqual(guessCountry('in Wien ist das so', 'de', '', c), 'AT');
  assert.strictEqual(guessCountry('nothing', 'de', 'Finanzen', c), 'DE');
  assert.strictEqual(guessCountry('nothing here', 'nl', '', c), 'NL');
  assert.strictEqual(guessCountry('I got it at Walmart', 'en', '', c), 'US');
  assert.strictEqual(guessCountry('dog hair everywhere', 'en', 'Dogs', c), '');
});

test('topic words: stemmed, no stop words and no complaint words; the forms of a word meet', () => {
  const skip = complaintWords(bank);
  assert.deepStrictEqual(topicTerms('Is there a way to stop my dog from shedding all over the couch? I have tried everything', 'en', skip), ['dog', 'shed', 'couch']);
  assert.deepStrictEqual(topicTerms('Onze katten en de kattenbak stinken', 'nl', skip), ['kat', 'kattenbak', 'stink']);
  for (const [a, b, lang] of [['dogs', 'dog', 'en'], ['running', 'run', 'en'], ['falling', 'fall', 'en'], ['stories', 'story', 'en'], ['honden', 'hond', 'nl'], ['katten', 'kat', 'nl'], ['flesje', 'fles', 'nl'], ['hunde', 'hund', 'de'], ['pflanzen', 'pflanz', 'de']]) {
    assert.strictEqual(stem(a, lang), stem(b, lang), `${a} ~ ${b}`);
  }
  const surface = new Map();
  topicTerms('Dog hair, dog hair everywhere', 'en', skip, surface);
  assert.deepStrictEqual([...surface.get('dog')], [['dog', 2]], 'titles show the words as written');
});

test('dedupe tools: one hash per text, per person; shingles see almost the same text', () => {
  assert.strictEqual(textHash('Black mold, again!'), textHash('black   mold again'));
  assert.notStrictEqual(textHash('black mold'), textHash('white mold'));
  assert.strictEqual(authorHash('reddit', ''), '');
  assert.strictEqual(authorHash('reddit', 'Someone'), authorHash('reddit', 'someone'));
  assert.notStrictEqual(authorHash('reddit', 'someone'), authorHash('tiktok', 'someone'));
  assert.match(authorHash('reddit', 'someone'), /^[0-9a-f]{16}$/);
  // The same person posting it again with a word changed (the sample's crosspost): 85% alike or more is a copy.
  const a = shingles('Black mold in shower grout keeps coming back\nI scrub the grout with bleach every week and the black mold comes back in a few days. Is there a way to stop it for good?');
  const b = shingles('Black mold in shower grout keeps coming back\nI scrub the grout with bleach every week and the black mold comes back after a few days. Is there a way to stop it?');
  assert.ok(jaccard(a, b) >= 0.85, String(jaccard(a, b)));
  assert.ok(jaccard(a, shingles('My earbuds keep falling out when I run')) < 0.2);
  assert.strictEqual(problemSentence('Short one. This sentence has the dog hair in it! Another.', (s) => (s.includes('dog') ? 1 : 0)), 'This sentence has the dog hair in it!');
});

test('the query bank passes its own check: three languages, every area in each, no product search', () => {
  assert.deepStrictEqual(bank.languages, ['en', 'nl', 'de']);
  for (const l of bank.languages) assert.ok(bank.patterns[l].length >= 20, `${l}: ${bank.patterns[l].length} patterns`);
  const areas = Object.keys(bank.areas);
  for (const a of ['home', 'kitchen', 'cleaning', 'pets', 'baby_kids', 'sleep', 'back_neck_pain', 'car', 'travel', 'fitness', 'gardening', 'organization', 'fashion', 'tech_accessories', 'hobby', 'office']) assert.ok(areas.includes(a), a);
  // The patterns Connor asked for are all there.
  const all = Object.values(bank.patterns).flat().map((x) => fold(x.p));
  for (const p of ['I hate that', 'why is it so hard to', 'is there a way to', 'does anyone know a fix for', 'so annoying', 'wish there was', 'struggling with', "ik heb er zo'n hekel aan", 'weet iemand hoe ik ... kan oplossen', 'nervt', 'gibt es eine Lösung für']) assert.ok(all.includes(fold(p)), p);
  // The subreddits Connor named are searched.
  const subs = new Set([...Object.values(bank.areas).flatMap((a) => Object.values(a.subreddits).flat()), ...Object.values(bank.general.subreddits).flat()]);
  for (const s of ['DIY', 'HomeImprovement', 'BuyItForLife', 'CleaningTips', 'petcare', 'Dogs', 'Cats', 'ParentingHacks', 'BackPain', 'malefashionadvice', 'ABraThatFits', 'gardening', 'CampingGear', 'organization', 'lifehacks', 'mildlyinfuriating', 'thenetherlands', 'de', 'nederlands', 'Finanzen']) assert.ok(subs.has(s), s);
  for (const t of searchTexts(bank)) assert.ok(!fold(t.text).split(' ').some((w) => PRODUCT_WORDS.includes(w)), t.where);
});

test('the bank check stops on the first mistake and says where', () => {
  const cases = [
    [(b) => { b.patterns.nl = b.patterns.nl.slice(0, 2); }, /patterns\.nl: at least 5 patterns/],
    [(b) => { b.patterns.en[0].kind = 'rant'; }, new RegExp(`patterns\\.en\\[0\\]: kind: one of ${KINDS.join(', ')}`)],
    [(b) => { b.patterns.de.push({ p: 'Nervt', kind: 'complaint' }); }, /"Nervt" is in the list twice/],
    [(b) => { b.patterns.en.push({ p: '... is broken', kind: 'complaint' }); }, /"\.\.\." goes between words/],
    [(b) => { delete b.areas.pets.keywords.de; }, /areas\.pets\.keywords\.de: must be a list/],
    [(b) => { b.areas.pets.topics.nl = ['x']; }, /areas\.pets\.topics\.nl: at least 2/],
    [(b) => { b.areas.pets.subreddits.en.push('r/Dogs'); }, /"r\/Dogs" is not a subreddit name/],
    [(b) => { b.areas['Bad Key'] = b.areas.pets; }, /areas\.Bad Key: the key/],
    [(b) => { b.areas.kitchen.topics.en.push('best pan to buy'); }, /searches for products \("best"\): only problems go in the searches/],
    [(b) => { b.patterns.en.push({ p: 'cheap fix for', kind: 'need' }); }, /searches for products \("cheap"\)/],
    [(b) => { delete b.signals.pay.nl; }, /signals\.pay\.nl: must be a list/],
    [(b) => { b.countries.nld = { cues: [] }; }, /countries\.nld: a two-letter country code/],
  ];
  for (const [change, why] of cases) {
    const b = fresh();
    change(b);
    assert.throws(() => validateBank(b), why);
  }
  // A product word in a pattern that is never searched (search: false) is allowed: it only scores.
  const b = fresh();
  b.patterns.en.push({ p: 'cheapest one broke', kind: 'struggle', search: false });
  assert.doesNotThrow(() => validateBank(b));
});

test('plans: every platform searches what it can, areas and languages take turns, nothing twice', () => {
  const reddit = planFor(bank, 'reddit', SOURCES.reddit.modes);
  const tiktok = planFor(bank, 'tiktok', SOURCES.tiktok.modes);
  assert.ok(reddit.every((x) => x.mode === 'sub' || x.mode === 'search'));
  assert.ok(tiktok.every((x) => x.mode === 'topic' && x.sub === ''));
  assert.strictEqual(tiktok.length, Object.values(bank.areas).reduce((n, a) => n + bank.languages.reduce((m, l) => m + a.topics[l].length, 0), 0));
  const keys = reddit.map((x) => `${x.mode}|${x.sub}|${x.q}|${x.area}|${x.lang}`);
  assert.strictEqual(new Set(keys).size, keys.length, 'no search twice');
  // The first searches already span the areas and the languages.
  const first = reddit.slice(0, 60);
  assert.ok(new Set(first.map((x) => x.area)).size >= 12, 'areas take turns');
  assert.deepStrictEqual([...new Set(first.map((x) => x.lang))].sort(), ['de', 'en', 'nl']);
  assert.ok(reddit.some((x) => x.mode === 'sub' && x.sub === 'DIY' && x.q === 'is there a way to'));
  assert.ok(reddit.some((x) => x.mode === 'search' && x.q === '"weet iemand hoe ik" kattenbak' && x.lang === 'nl' && x.area === 'pets'));
  assert.ok(reddit.some((x) => x.mode === 'sub' && x.sub === 'thenetherlands' && x.area === ''), 'general subreddits: area worked out later');
  assert.ok(!reddit.some((x) => /\.\.\./.test(x.q)), 'never "..." in a search');
  // pairs visits every (pattern, keyword) once; roundRobin and interleave take turns.
  const pr = pairs(3, 4);
  assert.strictEqual(new Set(pr.map((x) => x.join())).size, 12);
  assert.deepStrictEqual(roundRobin([[1, 2, 3], ['a'], ['x', 'y']]), [1, 'a', 'x', 2, 'y', 3]);
  assert.deepStrictEqual([...interleave({ r: 4, y: 2 }, { r: 2, y: 1 }, { r: 3 })].map((x) => x.platform + x.index), ['r3', 'r0', 'y0', 'r1', 'r2', 'y1']);
});
