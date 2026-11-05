// 🎯 Audience on the board (worker/src/audience.mjs): the card as HTML, the same in the Worker and in the browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceHtml, audienceLine, AUDIENCE_JS, AUDIENCE_CSS, audienceKit } from '../worker/src/audience.mjs';
import { buildCard } from '../lib/audience-card.mjs';
import { readFbAd } from '../lib/audience-collect.mjs';
import { baselineOf } from '../lib/audience-meta.mjs';

const EVIL = '<script>alert(1)</script>"\'';
const ad = readFbAd({ adArchiveID: '123456789', pageName: `Shop ${EVIL}`, startDate: 1758500000, snapshot: { body: `STOP ${EVIL}\nmore`, link_url: 'https://shop.example/p' },
  aaa_info: { gender_audience: 'All', age_audience: { min: 18, max: 65 }, age_country_gender_reach_breakdown: [{ country: 'IE', age_gender_breakdowns: [{ age_range: '25-34', female: 60, male: 40, unknown: 0 }, { age_range: '35-44', female: 30, male: 20, unknown: 0 }] }] } });
const voice = [
  { src: 'reddit', kind: 'comment', text: `The bowl is slimy and gross every day ${EVIL}`, likes: 4, url: 'javascript:alert(1)', on: 'water fountain thread' },
  { src: 'tiktok', kind: 'comment', text: 'My dog is scared of it and will not drink from it', likes: 9, url: 'https://www.tiktok.com/@x/video/1' },
  { src: 'youtube', kind: 'comment', text: 'Finally my dog drinks from it, love it so much', likes: 2, url: 'https://www.youtube.com/watch?v=abc' },
];
const card = buildCard({ pick: { id: 'p<1>', name: `Fountain ${EVIL}`, main: 'Pets', markets: ['AU'] }, phrase: { phrase: 'dog water fountain', how: 'given' },
  collected: { ads: [ad], voice, pulls: [], credits: 3 }, baseline: baselineOf([ad]), now: Date.parse('2026-11-05T06:00:00Z') });

test('audienceHtml: every text escaped, https links only, no inline style, bars as <meter>', () => {
  const h = audienceHtml(card, { open: true });
  assert.ok(!h.includes('<script>'), 'no script tag from the data');
  assert.ok(h.includes('&lt;script&gt;'), 'shown as text');
  assert.ok(!/href="javascript:/i.test(h), 'no javascript: link');
  assert.ok(!/\sstyle=/i.test(h), 'no inline style (CSP)');
  assert.ok(h.includes('<meter'), 'reach bars');
  assert.ok(h.includes('data-au="p&lt;1&gt;"'));
  for (const s of ['Who to sell it to', 'Who the competitor ads reach', 'The problem, in their words', 'Doubts and how to answer them', 'Five hooks', 'Meta targeting for the first test', 'Facts and gaps']) assert.ok(h.includes(s), s);
  assert.ok(h.includes('<details class="au-d" open>'));
  assert.ok(audienceHtml(card).includes('<details class="au-d">'));
  assert.match(h, /never our reviews/);
});

test('audienceHtml: no card, a broken card', () => {
  assert.match(audienceHtml(null), /No audience card yet/);
  assert.match(audienceHtml({ id: 'x' }), /No audience card yet/);
  assert.equal(audienceLine(null), '');
  assert.equal(audienceLine(card), card.one_line);
});

test('AUDIENCE_JS: the browser runs the same kit and renders the same HTML', () => {
  const window = {};
  new Function('window', AUDIENCE_JS)(window);
  assert.equal(window.AUDIENCE.html(card, { open: true }), audienceHtml(card, { open: true }));
  assert.equal(typeof audienceKit().safeUrl, 'function');
  assert.equal(audienceKit().safeUrl('http://x.example'), '');
  assert.ok(!/style=/.test(AUDIENCE_CSS) && AUDIENCE_CSS.includes('.au-hook'));
});
