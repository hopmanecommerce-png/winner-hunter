/*
 * 🧭 Pipeline: every approved product from Approved to Launched, one stage after the other, with the sourcing step made
 * effortless: a request pack whose every field is ready to copy into a sourcing agent's form, a field for the 1688 link you
 * find yourself, and target markets outside the EU with what matters per country (countries.mjs).
 * Stages: Approved → Request ready → Link found → Supplier confirmed → Sample ordered → Sample approved → Test ads →
 * Launched (scale or kill). Each has what to do next and who does it, the day it came in, and your note.
 * Built on what is there, never next to it:
 *   - The pipeline lives on the product's 🚀 launch card (launch.mjs): a product without one gets it when you first act on
 *     it here (as Start does). "Sample ordered" and "Test ads" are the card's own ticks (Sourcing → Sample ordered, Launch →
 *     Test campaign set up): moving the stage sets or clears them. A No go on the card takes the product off the pipeline.
 *   - The 1688 links are 🔎 Sourcing's supplier candidates (sourcing.mjs, product_suppliers), added, priced and chosen
 *     through its own code, so the chosen one lands in its landed-cost comparison and in the launch card's numbers.
 *   - The target price comes from the launch card's margin (marginInputs / marginOf), never from a made-up number.
 *   - The compliance and risk radar (risk.mjs) gives each product its Block / Docs / OK, why, and the documents to ask the
 *     supplier for: they go into the request pack.
 * Tables: migrations/0074_pipeline.sql (pipeline_items, pipeline_history, pipeline_settings).
 *   GET  /api/pipeline                               { items, settings, countries, all_countries }: every approved product
 *   POST /api/pipeline {key, stage, note?}           move it to a stage (forward or back)
 *   POST /api/pipeline {key, outcome: 'scale' | 'kill' | ''}  at Launched: your decision
 *   POST /api/pipeline {key, note: {stage, text}}    your note on a stage
 *   POST /api/pipeline {key, markets: [cc] | null}   its target markets (null: the suggested ones)
 *   POST /api/pipeline {key, pack: {…}}              the request pack's own fields (English title, variants, …)
 *   POST /api/pipeline {key, zh}                     Chinese search words (Sourcing's own field)
 *   POST /api/pipeline {key, links: {paste}}         1688 links (or what the app shares): candidates in Sourcing, at most 5
 *   POST /api/pipeline {key, link: {id, set | remove}}  a link's price, currency, MOQ, notes; or remove it
 *   POST /api/pipeline {key, choose: id | null}      the source you go with (Sourcing's choose: the launch card follows)
 *   POST /api/pipeline {key, drop: true | false}     off the pipeline (No go on the launch card), or back
 *   POST /api/pipeline {key, copied: true}           the pack was copied: Approved moves on to Request ready
 *   POST /api/pipeline {key, start: true}            only its launch card (for 🚀 Launch card on a product without one)
 *   POST /api/pipeline {settings: {markets, template}}  the countries in the list, the agent form it opens on
 *   GET  /api/pipeline/image?key=…                   the product photo as a file to upload in an agent's form
 *   GET  /pipeline.js                                pipelineKit as a script (window.PIPELINE), as /launch.js
 * key: a launch card's key ('eu|…', 'world|…', 'google|…', 'tiktok|…') or an approved product's key on the board. app.mjs checks the
 * PIN cookie, the origin and the JSON before any of this runs. All SQL is parameterized; the only names put into SQL text
 * come from fixed lists (STAGES).
 */
import { cleanStep, launchList, launchOut, launchPost, launchIndex, cardProduct, LIST_SQL, marginInputs, marginOf } from './launch.mjs';
import { sourcingGet, sourcingPost, cleanUrl, platformOf, fromPaste, PLATFORMS, fxOf, ranked } from './sourcing.mjs';
import { COUNTRIES, DEFAULT_MARKETS, ALL_COUNTRIES, countryFacts } from './countries.mjs';
import { verdict as riskVerdict, fromFacts as riskFacts, keyOf as riskKey, riskChecks } from './risk.mjs';

/**
 * Everything the pipeline works out, in one function that uses nothing from outside itself but its two arguments: the
 * sourcing kit S (sourcingKit: link clean-up, share text, rates) and the launch kit L (launchKit: the margin). The Worker
 * calls it with the modules' own, and /pipeline.js runs it in the board with window.SOURCING and window.LAUNCH, so the
 * browser runs the same tested code while you type.
 */
export function pipelineKit(S, L) {
  const STAGES = [
    { k: 'approved', todo: 'Check and copy the request', label: 'Approved', long: 'Approved', who: 'You', next: 'Check the request pack: English title, photo, variants and target markets. Then copy it into your agent’s form.' },
    { k: 'request', todo: 'Send it; find the 1688 link', label: 'Request ready', long: 'Sourcing request ready', who: 'You and your agent', next: 'Send the request to your agent, or search 1688 yourself with the Chinese words. Paste the 1688 link here when you have it.' },
    { k: 'link', todo: 'Price and MOQ, then choose', label: 'Link found', long: 'Link found (1688 link pasted)', who: 'Your agent quotes, you fill in', next: 'Fill in the price and MOQ of each link (the agent’s quote or the page), then choose the best one.' },
    { k: 'supplier', todo: 'Order 1–2 samples', label: 'Supplier confirmed', long: 'Supplier and price confirmed', who: 'You', next: 'Order 1–2 samples through your agent (🔎 Sourcing has the sample order list).' },
    { k: 'sample', todo: 'QC and test the sample', label: 'Sample ordered', long: 'Sample ordered', who: 'Your agent', next: 'The agent checks the sample (photos, a function video, measurements) and sends it. Test it when it arrives.' },
    { k: 'sample_ok', todo: 'Page, creatives, campaign', label: 'Sample approved', long: 'Sample approved', who: 'You', next: 'Product page, creatives and the test campaign: open the 🚀 launch card.' },
    { k: 'ads', todo: 'Kill or scale by the rules', label: 'Test ads', long: 'Test ads running', who: 'You', next: 'Run the test for 3–5 days by the launch card’s kill and scale rules.' },
    { k: 'launched', todo: 'Scale or kill', label: 'Launched', long: 'Launched: scale or kill', who: 'You', next: 'Scale it (budget up) or kill it.' },
  ];
  const STAGE_KEYS = STAGES.map((s) => s.k);
  const stageIndex = (k) => STAGE_KEYS.indexOf(k);
  const stageOf = (k) => STAGES[stageIndex(k)] || null;
  const MAX_LINKS = 5;
  const MAX = { note: 1000, paste: 2000, zh: 100 };
  // The request pack's own fields, saved as you type. t: text or int; def: what an empty field means.
  const PACK = [
    { k: 'title_en', t: 'text', label: 'Product title in English', max: 150 },
    { k: 'variants', t: 'text', label: 'Variants: colours, sizes', max: 300 },
    { k: 'features', t: 'text', label: 'Must have', max: 500 },
    { k: 'quality', t: 'text', label: 'Quality requirements', max: 500 },
    { k: 'sample_qty', t: 'int', label: 'Samples', def: 2, max: 20 },
    { k: 'test_qty', t: 'int', label: 'Test order (units)', def: 50, max: 100000 },
  ];
  const QUALITY = 'Same as the photo and the product page: same size, material and function. No damage, a sturdy box. No logo or brand on the product or the box.';

  const round = (x, d) => {
    const f = 10 ** d;
    const r = Math.round(x * f) / f;
    return r === 0 ? 0 : r; // never -0
  };
  const cleanText = (x, n, lines) => String(x ?? '').replace(lines ? /[\u0000-\u0009\u000b-\u001f\u007f]+/g : /[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
  const intOf = (x) => {
    const s = typeof x === 'number' ? String(x) : String(x ?? '').trim();
    return /^\d{1,7}$/.test(s) ? Number(s) : NaN;
  };
  const CJK = /[㐀-鿿]/;

  /** The pack's fields as saved: only the fields given that are valid; '' or not valid is left out (its default counts). */
  function cleanPack(input) {
    const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const out = {};
    for (const f of PACK) {
      const x = i[f.k];
      if (x == null || x === '') continue;
      if (f.t === 'int') {
        const n = intOf(x);
        if (n >= 1 && n <= f.max) out[f.k] = n;
      } else {
        const s = cleanText(x, f.max, true);
        if (s) out[f.k] = s;
      }
    }
    return out;
  }
  /** The pack fields that cannot be saved as typed (a quantity that is no whole number in range): their keys. */
  const badPack = (input) => PACK.filter((f) => f.t === 'int' && input && input[f.k] != null && String(input[f.k]).trim() !== '' && cleanPack({ [f.k]: input[f.k] })[f.k] === undefined).map((f) => f.k);

  // Links -------------------------------------------------------------------------------------------------------------
  // The shop and short-link hosts of 1688 (no offer of its own), and its search pages.
  const SHOP_1688 = /^(?:shop\d*|winport|shop\.m)\.|^[a-z0-9-]+\.1688\.com$/;
  const NOT_SHOP = /^(?:www|detail|m|detail\.m|s|qr|p4psearch|air|work|login|re|page|show|i)\.1688\.com$/;
  /**
   * A pasted link as the pipeline shows it: { url (cleaned: the offer's own address, no tracking), platform ('1688',
   * 'aliexpress', 'alibaba', 'taobao', 'tmall', 'cj', 'other'), label, kind ('offer': a product; 'shop'; 'short': a share
   * link that opens the product; 'search': a search page, not a product; 'page': anything else), id (the offer id), note }
   * or null when it is not a web link. Sourcing's cleanUrl does the clean-up; a few formats it leaves are added here.
   */
  function linkOf(raw) {
    let s = cleanText(raw, MAX.paste).replace(/\s+/g, '');
    // AliExpress's newer /i/<id>.html and Taobao / Tmall item pages: their own address, without the tracking.
    s = s.replace(/^(https?:\/\/)?((?:[a-z]{2,3}|www|m)\.)?aliexpress\.(com|us|ru)\/i\/(\d{5,20})\.html\S*$/i, 'https://www.aliexpress.com/item/$4.html');
    const tb = /^(?:https?:\/\/)?(item\.taobao\.com|detail\.tmall\.com|detail\.tmall\.hk)\/item\.htm\?(?:\S*&)?id=(\d{5,20})(?:[&#]\S*)?$/i.exec(s);
    if (tb) s = `https://${tb[1].toLowerCase()}/item.htm?id=${tb[2]}`;
    const url = S.cleanUrl(s);
    if (!url) return null;
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    const p = S.platformOf(url);
    const out = { url, platform: p, label: (S.PLATFORMS[p] || S.PLATFORMS.other).label, kind: 'page', id: '', note: '' };
    let m;
    if (p === '1688') {
      if ((m = /\/offer\/(\d{5,20})\.html$/.exec(u.pathname))) Object.assign(out, { kind: 'offer', id: m[1] });
      else if (h === 'qr.1688.com' || /^\/s\//.test(u.pathname)) Object.assign(out, { kind: 'short', note: 'A share link: it opens the product. Open it once and paste the offer page’s link, so the offer id shows.' });
      else if (h === 's.1688.com' || h === 'p4psearch.1688.com' || /offer_search|\/selloffer\//.test(u.pathname)) Object.assign(out, { kind: 'search', note: 'A search page, not a product: open the product and copy its link.' });
      else if (SHOP_1688.test(h) && !NOT_SHOP.test(h)) Object.assign(out, { kind: 'shop', note: 'A shop, not one product: fine to keep, but the product’s own link is better.' });
    } else if (p === 'aliexpress') {
      if ((m = /^\/item\/(\d{5,20})\.html$/.exec(u.pathname))) Object.assign(out, { kind: 'offer', id: m[1] });
      else if (/^(a|s\.click)\.aliexpress\./.test(h)) Object.assign(out, { kind: 'short', note: 'A share link: it opens the product.' });
      else if (/^\/store\//.test(u.pathname)) Object.assign(out, { kind: 'shop' });
      else if (/^\/(wholesale|w\/)/.test(u.pathname)) Object.assign(out, { kind: 'search', note: 'A search page, not a product: open the product and copy its link.' });
    } else if (p === 'alibaba') {
      if ((m = /_(\d{5,20})\.html$/.exec(u.pathname) || /^\/product\/(\d{5,20})(?:[/.]|$)/.exec(u.pathname))) Object.assign(out, { kind: 'offer', id: m[1] });
      else if (/\/trade\/search|\/showroom\//.test(u.pathname)) Object.assign(out, { kind: 'search', note: 'A search page, not a product: open the product and copy its link.' });
    } else if (p === 'cj') {
      if (/\/product\//.test(u.pathname)) out.kind = 'offer';
    } else if (/(^|\.)(taobao\.com|tmall\.com|tmall\.hk|tb\.cn)$/.test(h)) {
      out.platform = /tmall/.test(h) ? 'tmall' : 'taobao';
      out.label = /tmall/.test(h) ? 'Tmall' : 'Taobao';
      if ((m = /^\/item\.htm$/.test(u.pathname) && /^(\d{5,20})$/.exec(u.searchParams.get('id') || ''))) Object.assign(out, { kind: 'offer', id: m[1] });
      else if (/(^|\.)tb\.cn$/.test(h)) Object.assign(out, { kind: 'short', note: 'A share link: it opens the product.' });
    }
    return out;
  }
  /** Something that looks like a share token without a link ("￥AbC123￥", 淘口令 / 复制这条信息): the app shared no link. */
  const tokenOnly = (t) => /[¥￥€$]\s*[A-Za-z0-9]{6,}\s*[¥￥€$]|口令|复制这条|打开【?(1688|淘宝|天猫)/.test(t);
  /**
   * The links in pasted text, one per web link, each with what the text around it says (price, MOQ, name: S.fromPaste):
   * [{ ...linkOf, text, price, currency, moq, title }]. The same offer twice is one link. A line with one link keeps its
   * text; a line with several links gives each link alone.
   */
  function linksIn(text) {
    const t = cleanText(text, MAX.paste, true);
    const out = [];
    const seen = new Set();
    for (const lineText of t.split(/\n+/)) {
      const found = lineText.match(/(?:https?:\/\/|(?:^|\s)(?:[a-z0-9-]+\.)+(?:com|cn|us|ru|hk)\/)[^\s"'<>，。、；）)\]】]+/gi) || [];
      for (const raw of found) {
        const l = linkOf(raw.trim());
        if (!l || seen.has(l.url)) continue;
        seen.add(l.url);
        const said = found.length === 1 ? S.fromPaste(lineText) : {};
        out.push(Object.assign(l, { text: found.length === 1 ? lineText : l.url, price: said.unit_price ?? null, currency: said.unit_price != null ? said.currency : null, moq: said.moq ?? null, title: said.title || '' }));
      }
    }
    return out;
  }
  /** Why nothing in a paste could be added, in words for the board. */
  function noLinkWhy(text) {
    const t = String(text || '');
    if (tokenOnly(t)) return 'No link in it, only the app’s share code: in the app tap Share → Copy link, and paste that.';
    return 'No link in what you pasted: paste the product page’s address (detail.1688.com/offer/…).';
  }

  // The product's name and Chinese words -----------------------------------------------------------------------------------
  const PROMO = '(?:\\d{1,3}\\s?%\\s?off|sale|hot sale|mega sale|flash sale|free shipping|free delivery|today only|limited (?:time|stock|offer)|buy \\d+ get \\d+(?: free)?|best ?seller|new arrival|new|last day|clearance)';
  const PROMO_HEAD = new RegExp(`^(?:${PROMO}(?![a-z0-9])\\s*[:!|\\-–—]*\\s*)+`, 'i');
  const PROMO_TAIL = new RegExp(`(?:(?:^|\\s+|\\s*[:!|\\-–—]+\\s*)${PROMO})+$`, 'i');
  /**
   * A product title cleaned for an agent: no ™ ® ©, emoji, 【tags】 or [tags], no "| colour" or "– shop" tail, no sale words
   * at the start or the end; at most 120 characters, cut at a word.
   */
  function cleanTitle(t) {
    let s = String(t ?? '').replace(/[™®©℠]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ');
    s = s.replace(/【[^】]*】|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    const head = s.split(/\s+[|｜–—]\s+|\s+-\s+/)[0];
    if (head.length >= 3) s = head;
    for (let i = 0; i < 3; i++) s = s.replace(PROMO_HEAD, '').replace(PROMO_TAIL, '').trim();
    s = s.replace(/^[\s,.;:!|\-–—]+|[\s,;:!|\-–—]+$/g, '');
    if (s.length > 120) s = s.slice(0, 121).replace(/\s+\S*$/, '');
    return s;
  }
  // Common words of Dutch, German and French titles (the EU board's languages): such a title wants an English one.
  const notEnglish = (t) => /\b(met|voor|van|het|een|en de|und|für|mit|der|die|das|pour|avec|les|des|sans|chaud|kussen|kissen|oreiller)\b/i.test(String(t || ''));
  // English words → Chinese 1688 search words, for a first guess when nobody has set any. The hunt's own words (from
  // lib/1688-terms.json, per title and per search word) and the words you type in Sourcing come first.
  const ZH_NOUNS = 'posture corrector=姿势矫正器;back brace=护腰;knee brace=护膝;brace=护具;neck pillow=颈枕;knee pillow=膝盖枕;pillow=枕头;sleep mask=睡眠眼罩;eye mask=眼罩;'
    + 'weighted blanket=重力毯;blanket=毯子;pet hair remover=宠物除毛器;lint remover=毛球修剪器;cat brush=猫梳;dog brush=狗梳;pet brush=宠物梳;dog bed=狗窝;cat bed=猫窝;pet bed=宠物窝;'
    + 'cooling mat=冰垫;litter box=猫砂盆;scratcher=猫抓板;leash=牵引绳;collar=项圈;harness=胸背带;pet feeder=宠物喂食器;water fountain=饮水机;sunset lamp=日落灯;night light=小夜灯;lamp=灯;'
    + 'phone holder=手机支架;phone case=手机壳;car seat cover=汽车座套;seat cover=座套;foot massager=足部按摩器;neck massager=颈部按摩器;massage gun=筋膜枪;massager=按摩器;mouthpiece=牙套;'
    + 'water bottle=水杯;ice roller=冰敷滚轮;face roller=美容滚轮;blender=榨汁机;back stretcher=腰椎拉伸器;hair straightener=直发器;hair dryer=吹风机;projector=投影仪;sleep sack=睡袋;'
    + 'dress=连衣裙;leggings=打底裤;bra=文胸;hoodie=连帽卫衣;sneakers=运动鞋;slippers=拖鞋;shoes=鞋;backpack=背包;wallet=钱包;bag=包;watch=手表;necklace=项链;earrings=耳环;bracelet=手链;ring=戒指;'
    + 'organizer=收纳盒;storage box=收纳盒;shelf=置物架;mop=拖把;vacuum=吸尘器;humidifier=加湿器;diffuser=香薰机;fan=风扇;heater=取暖器;knife sharpener=磨刀器;knife=刀;cutting board=砧板;'
    + 'lunch box=饭盒;toothbrush=牙刷;shower head=花洒;mirror=镜子;towel=毛巾;yoga mat=瑜伽垫;resistance bands=弹力带;dumbbell=哑铃;jump rope=跳绳;earbuds=蓝牙耳机;headphones=耳机;'
    + 'power bank=充电宝;charger=充电器;tripod=三脚架;camera=摄像头;toy=玩具;umbrella=雨伞;sunglasses=太阳镜;hat=帽子;cap=棒球帽;scarf=围巾;socks=袜子;gloves=手套;insoles=鞋垫;cushion=坐垫;'
    + 'mat=垫子;brush=刷子;roller=滚筒;spray=喷雾;bottle=瓶子';
  const ZH_MODS = 'heated=加热;electric=电动;cordless=无线;wireless=无线;portable=便携式;mini=迷你;smart=智能;magnetic=磁吸;waterproof=防水;foldable=折叠;adjustable=可调节;rechargeable=充电式;'
    + 'usb=USB;led=LED;silk=真丝;linen=亚麻;cotton=纯棉;leather=皮革;bamboo=竹;silicone=硅胶;stainless steel=不锈钢;wooden=木质;baby=婴儿;kids=儿童;women=女士;men=男士;car=汽车;'
    + 'self-cleaning=自清洁;shiatsu=指压;orthopedic=矫形;ergonomic=人体工学;facial=面部;summer=夏季;winter=冬季;automatic=自动;anti-slip=防滑;anti-snoring=止鼾;memory foam=记忆棉;cooling=凉感;'
    + 'pet=宠物;dog=狗;cat=猫;kitchen=厨房;bathroom=浴室;travel=旅行;outdoor=户外';
  const dict = (s, noun) => s.split(';').map((x) => x.split('=')).map(([en, zh]) => ({ en, zh, noun }));
  const ZH_WORDS = dict(ZH_NOUNS, true).concat(dict(ZH_MODS, false)).sort((a, b) => b.en.length - a.en.length);
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** Chinese search words guessed from an English title, or '' (no product word known). In the order of the title. */
  function zhGuess(title) {
    let t = ` ${String(title || '').toLowerCase().replace(/[^a-z0-9' -]+/g, ' ').replace(/\s+/g, ' ')} `;
    const hits = [];
    let noun = false;
    for (const w of ZH_WORDS) {
      const re = new RegExp(` ${reEsc(w.en)}(?:s|es)? `);
      const m = re.exec(t);
      if (!m) continue;
      hits.push({ at: m.index, zh: w.zh });
      noun = noun || w.noun;
      t = t.slice(0, m.index) + ' ' + '#'.repeat(m[0].length - 2) + ' ' + t.slice(m.index + m[0].length);
    }
    if (!noun) return '';
    const seen = new Set();
    return hits.sort((a, b) => a.at - b.at).map((x) => x.zh).filter((z) => !seen.has(z) && seen.add(z)).slice(0, 6).join(' ');
  }
  /** The Chinese words for 1688: yours (Sourcing), else the hunt's (lib/1688-terms.json), else a guess. { zh, from }. */
  function zhOf(it, title) {
    const own = cleanText(it && it.zh, MAX.zh);
    if (own) return { zh: own, from: 'yours' };
    const hunt = cleanText(it && it.zh_hunt, MAX.zh);
    if (hunt && CJK.test(hunt)) return { zh: hunt, from: 'hunt' };
    const g = zhGuess(title);
    return g ? { zh: g, from: 'guess' } : { zh: '', from: '' };
  }

  // Money: the most one unit may cost --------------------------------------------------------------------------------------
  const fmt = (v, cur) => (cur === 'CNY' ? `¥${v >= 10 ? Math.floor(v) : round(v, 1)}` : `${{ EUR: '€', USD: '$' }[cur] || cur + ' '}${round(v, 2).toFixed(2)}`);
  /**
   * The most one unit may cost from the supplier, from the launch card's numbers (L.marginInputs: its selling price, VAT
   * and payment fees with their defaults, shipping and target CPA; COGS left out, as that is what we look for). An order
   * then still leaves a margin: with a target CPA, profit 0 at that CPA; without one, a break-even ROAS of 3 (the board's
   * "thin margin" line). Without a selling price on the card: the competitor's price, when it is in euros or dollars.
   * { known, why?, from, cur, price, be_unit (break-even before ads), max_unit, rule, ship_known, cny, usd, eur, text }.
   */
  function moneyOf(it) {
    const f = (it && it.facts) || {};
    const mi = L.marginInputs((it && it.steps) || {});
    const fx = S.fxOf(it && it.fx ? { eur_cny: it.fx.CNY, eur_usd: it.fx.USD } : null);
    const own = Number(mi.price) > 0;
    const cur = String(f.cur || '').toUpperCase();
    let eur = null;
    let from = 'launch card';
    if (own) eur = Number(mi.price);
    else if (Number(f.price) > 0 && (cur === 'EUR' || cur === 'USD')) {
      eur = cur === 'EUR' ? Number(f.price) : Number(f.price) / fx.USD;
      from = 'their price';
    }
    if (eur == null) {
      const why = Number(f.price) > 0 ? `Their price is in ${cur || 'an unknown currency'}: set your selling price in € on the launch card (Margin) for a target price.` : 'No selling price yet: set it on the launch card (Margin) for a target price.';
      return { known: false, why };
    }
    // L.marginOf with COGS 0 gives what an order leaves before the product: price − VAT − fees − shipping.
    const m = L.marginOf(Object.assign({}, mi, { price: eur, cogs: 0 }));
    const be = m.contribution;
    const cpa = mi.cpa != null && Number(mi.cpa) >= 0 ? Number(mi.cpa) : null;
    const max = round(be - (cpa != null ? cpa : eur / 3), 2);
    const out = { known: true, from, price: round(eur, 2), cur: 'EUR', be_unit: round(be, 2), max_unit: max, rule: cpa != null ? 'cpa' : 'roas3', cpa, ship_known: mi.ship != null, vat: mi.vat, fees: mi.fees, fx };
    if (max <= 0) return Object.assign(out, { known: false, why: `At ${fmt(eur, 'EUR')} an order leaves nothing for the product: raise the price on the launch card.` });
    const cny = round(max * fx.CNY, 2);
    return Object.assign(out, { eur: max, cny, usd: round(max * fx.USD, 2), cny_text: fmt(cny, 'CNY'), eur_text: fmt(max, 'EUR'), text: `Under ${fmt(cny, 'CNY')} per unit (${fmt(max, 'EUR')})` });
  }

  // The request pack -------------------------------------------------------------------------------------------------------
  const nameOf = (names, cc) => (names && names[cc] && names[cc].name) || cc;
  const zhNameOf = (names, cc) => (names && names[cc] && names[cc].zh) || cc;
  const list = (xs, and = 'and') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
  const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : '');
  const lines = (...xs) => xs.filter((x) => x != null).join('\n');
  const num = (xs) => xs.filter(Boolean).map((x, i) => `${i + 1}. ${x}`).join('\n');
  // Risks that change what you ask (Jev's blockers on the card's facts).
  const hasRisk = (f, k) => (Array.isArray(f && f.risks) ? f.risks : []).some((r) => r && r.k === k);

  /** The target markets: the ones you picked, else the suggested ones. */
  const marketsOf = (it) => (Array.isArray(it && it.markets) ? it.markets : Array.isArray(it && it.suggested) ? it.suggested : []);

  /**
   * The request pack of one product: every value ready to copy. it: a pipeline item (GET /api/pipeline); names: the
   * countries { cc: { name, zh } }. { title, title_from, zh, zh_from, page, image, ad, link, link_kind, variants, features,
   * quality, sample_qty, test_qty, markets, countries, countries_zh, money, ship_en, ship_zh, remark_en, remark_zh,
   * questions_en, questions_zh, documents_en, documents_zh (the risk radar's it.risk.ask), message_en, message_zh, missing, complete }.
   */
  function packOf(it, names) {
    const f = (it && it.facts) || {};
    const p = Object.assign({}, it && it.pack);
    const title = cleanText(p.title_en, 150) || cleanTitle((it && it.title) || f.title) || 'this product';
    const z = zhOf(it, title);
    const page = https(f.product) || https(f.store);
    const image = https(f.img);
    const links = Array.isArray(it && it.links) ? it.links : [];
    const chosen = links.find((x) => x.id === (it && it.chosen_id) && x.url);
    const found = chosen || links.find((x) => x.url && x.platform === '1688') || links.find((x) => x.url);
    const markets = marketsOf(it);
    const countries = markets.map((cc) => nameOf(names, cc));
    const countriesZh = markets.map((cc) => zhNameOf(names, cc));
    const money = moneyOf(it);
    const battery = hasRisk(f, 'electric');
    const sample = p.sample_qty || 2;
    const qty = p.test_qty || 50;
    const quality = p.quality || QUALITY;
    const to = countries.length ? list(countries) : 'my customers';
    const toZh = countriesZh.length ? countriesZh.join('、') : '我的客户所在国家';
    const shipEn = `A fast tracked line (special line or express) to ${to}, with a tracking number${battery ? '; it must take batteries' : ''}.`;
    const shipZh = `发往${toZh}：快速、可追踪的专线或快递，需提供追踪号${battery ? '；产品带电，需走可带电的线路' : ''}。`;
    const target = money.known ? `Target price: under ${money.cny_text} per unit.` : null;
    const targetZh = money.known ? `目标价：每个低于${money.cny_text}。` : null;
    // The form's link field holds the link: the remark says what to do with it.
    const ask = found ? `Please check the ${found.platform === '1688' ? '1688 ' : ''}product in the link: ${title}.` : `Please find this product on 1688 (the same as in the link): ${title}.`;
    const askZh = found ? `请核实链接里的这款${found.platform === '1688' ? '1688' : ''}产品：${z.zh || title}。` : `请在1688上找同款（与链接里的产品一致）：${z.zh || title}。`;
    const remarkEn = lines(ask, p.variants ? `Variants: ${p.variants}.` : null,
      `Please check: is this the same product, from a factory? MOQ, price at 1/10/50 pcs, sample price, material, certificates (CE, RoHS), lead time, shipping time to ${to} (fast tracked line), packaging, and the option for no logo or a custom logo.${battery ? ' It has a battery: a line that takes batteries, and the UN38.3 report.' : ''}`,
      target, `${sample} samples first, then a test order of ${qty} units.`);
    const remarkZh = lines(askZh, p.variants ? `款式：${p.variants}。` : null,
      `请帮忙确认：是否同款，是否工厂？起订量，1件/10件/50件的价格，样品价格，材质，证书（CE、RoHS），交期，发往${toZh}的时效（快速、可追踪的专线），包装，以及能否无logo或定制logo。${battery ? '产品带电：需走可带电的线路，并提供UN38.3报告。' : ''}`,
      targetZh, `先要${sample}个样品，然后试单${qty}个。`);
    const qsEn = num(['Is it the same product? Factory or trader?', 'MOQ, and the price at 1 / 10 / 50 pcs?', 'Sample price, and is it refunded on a bulk order?', 'Material, and which certificates (CE, RoHS, test reports)?',
      `Lead time, and the shipping time and cost to ${to}?`, 'Packed size and weight?', 'No logo, or my own logo (MOQ and cost)?', battery ? 'Battery: the UN38.3 report and the MSDS, and a line that takes batteries?' : '']);
    const qsZh = num(['是否同款？工厂还是贸易公司？', '起订量，以及1件/10件/50件的价格？', '样品价格？下大货时样品费可以退吗？', '材质？有哪些证书（CE、RoHS、检测报告）？', `交期？发往${toZh}的时效和运费？`, '包装后的尺寸和重量？', '可以无logo或定制logo吗（起订量和费用）？',
      battery ? '产品带电：请提供UN38.3报告和MSDS，并使用可走带电的线路。' : '']);
    // The documents the risk radar asks the supplier for (risk.mjs), when the product has its verdict.
    const docs = Array.isArray(it && it.risk && it.risk.ask) ? it.risk.ask.filter((a) => Array.isArray(a) && a[0]) : [];
    const docsEn = num(docs.map((a) => a[0]));
    const docsZh = num(docs.map((a) => a[1] || a[0]));
    const messageEn = lines('Hello! Could you source this product for me on 1688?', '', `Product: ${title}`, z.zh ? `Chinese: ${z.zh}` : null, found ? `Supplier link: ${found.url}` : null, page ? `Sold here: ${page}` : null,
      image ? `Photo: ${image}` : null, p.variants ? `Variants: ${p.variants}` : null, p.features ? `Must have: ${p.features}` : null, `Quality: ${quality}`,
      money.known ? `Target price: under ${money.cny_text} per unit (${money.eur_text}), my maximum` : null, `Quantity: ${sample} samples first, then a test order of ${qty} units`, `Ship to: ${to}, by a fast tracked line${battery ? ' that takes batteries' : ''}`,
      '', 'Please tell me:', qsEn, docs.length ? '' : null, docs.length ? 'Please also send these documents:' : null, docs.length ? docsEn : null, '', 'Thank you!');
    const messageZh = lines('您好！请帮我在1688上采购这款产品：', '', `产品：${z.zh || title}`, z.zh ? `英文名：${title}` : null, found ? `供应商链接：${found.url}` : null, page ? `国外售卖链接：${page}` : null,
      image ? `图片：${image}` : null, p.variants ? `款式：${p.variants}` : null, p.features ? `必须有：${p.features}` : null, `质量要求：${p.quality || '与图片和产品页面一致：尺寸、材质、功能相同。无破损，包装结实。产品和包装上无logo或品牌。'}`,
      money.known ? `目标价：每个低于${money.cny_text}（我的最高价）` : null, `数量：先要${sample}个样品，然后试单${qty}个`, `发往：${toZh}，快速、可追踪的专线${battery ? '（可带电）' : ''}`,
      '', '请告诉我：', qsZh, docs.length ? '' : null, docs.length ? '请同时提供以下文件：' : null, docs.length ? docsZh : null, '', '谢谢！');
    const missing = [];
    if (!image) missing.push('photo');
    if (!page && !found) missing.push('link');
    if (!markets.length) missing.push('markets');
    if (!money.known) missing.push('price');
    if (!z.zh) missing.push('zh');
    return {
      title, title_from: p.title_en ? 'yours' : 'cleaned', not_english: !p.title_en && notEnglish(title), zh: z.zh, zh_from: z.from, page, image, ad: https(f.ad), link: found ? found.url : page, link_kind: found ? 'supplier' : page ? 'page' : '',
      variants: p.variants || '', features: p.features || '', quality, sample_qty: sample, test_qty: qty, markets, countries, countries_zh: countriesZh, money,
      ship_en: shipEn, ship_zh: shipZh, remark_en: remarkEn, remark_zh: remarkZh, questions_en: qsEn, questions_zh: qsZh, documents_en: docsEn, documents_zh: docsZh, message_en: messageEn, message_zh: messageZh,
      missing, complete: !missing.some((k) => k === 'photo' || k === 'link' || k === 'markets'),
    };
  }

  // Templates: the fields of an agent's form, in its order. file: a file to download and upload, not text to copy.
  const TEMPLATES = {
    generic: { label: 'Agent form', hint: 'Pandabuy, Sugargoo, CNFans, Wegobuy, Superbuy, Hoobuy, ACBuy and most others: the fields their “DIY order” or sourcing request asks for, in that order.',
      fields: ['link', 'title', 'zh', 'image_url', 'image', 'variants', 'qty', 'price', 'country', 'shipping', 'remark', 'questions', 'documents'] },
    kungfubuy: { label: 'Kungfubuy', hint: 'Its order form (uniorder): Product Link, Product Image (gif/jpg/png, max 3 MB), Country, Remark. One country per request.',
      fields: ['link', 'image', 'country1', 'remark'] },
    text: { label: 'Free text', hint: 'One message for WhatsApp, WeChat or e-mail.', fields: ['message'] },
  };
  /**
   * The fields of a template with their values, in order: [{ k, label, value, file?, note? }]. lang: 'en' or 'zh' (the
   * remark, the questions and the message; names and links stay as they are).
   */
  function fieldsOf(pk, template, lang = 'en') {
    const t = TEMPLATES[template] || TEMPLATES.generic;
    const zh = lang === 'zh';
    const linkNote = pk.link_kind === 'supplier' ? 'The supplier link you found.' : pk.link_kind === 'page' ? 'No 1688 link yet: the shop that sells it now. Paste the 1688 link once you have it.' : 'No link yet.';
    const others = pk.countries.slice(1);
    const F = {
      link: { label: 'Product Link', value: pk.link, note: linkNote },
      title: { label: 'Product name', value: pk.title },
      zh: { label: 'Chinese name (1688)', value: pk.zh, note: pk.zh_from === 'guess' ? 'Guessed from the English words: check it, or set your own.' : '' },
      image_url: { label: 'Image URL', value: pk.image },
      image: { label: 'Product Image', value: pk.image, file: true, note: 'Download it, then upload it in the form (gif/jpg/png, max 3 MB).' },
      variants: { label: 'Colour / size', value: pk.variants, note: pk.variants ? '' : 'Fill in the variants above (as on their page).' },
      qty: { label: 'Quantity', value: `${pk.sample_qty} samples, then ${pk.test_qty} units` },
      price: { label: 'Target price', value: pk.money.known ? pk.money.text : '', note: pk.money.known ? 'Your maximum: an order still leaves a margin (from the launch card).' : pk.money.why },
      country: { label: 'Country', value: pk.countries.join(', '), note: pk.countries.length ? '' : 'Pick the target markets below.' },
      country1: { label: 'Country', value: pk.countries[0] || '', note: !pk.countries.length ? 'Pick the target markets below.' : others.length ? `One country per request: send another for ${list(others)}.` : '' },
      shipping: { label: 'Shipping', value: zh ? pk.ship_zh : pk.ship_en },
      remark: { label: 'Remark', value: zh ? pk.remark_zh : pk.remark_en },
      questions: { label: 'Questions', value: zh ? pk.questions_zh : pk.questions_en, note: 'For a chat with the agent, or a form with a second text field.' },
      documents: { label: 'Documents to ask for', value: zh ? pk.documents_zh : pk.documents_en, note: pk.documents_en ? 'From the risk radar (EU rules): the papers the supplier should send before you order.' : '' },
      message: { label: 'Message', value: zh ? pk.message_zh : pk.message_en },
    };
    return t.fields.map((k) => Object.assign({ k }, F[k]));
  }
  /** "Copy all": every text field with a value, as "Label: value" (a long value on the lines under its label). */
  function copyAllOf(fields) {
    const xs = fields.filter((x) => !x.file && x.value);
    if (xs.length === 1 && xs[0].k === 'message') return xs[0].value;
    return xs.map((x) => (/\n/.test(x.value) ? `${x.label}:\n${x.value}` : `${x.label}: ${x.value}`)).join('\n');
  }

  // Stages: what the data says, and what a move changes on the launch card ----------------------------------------------
  /**
   * What a product's own data shows, per stage: { link, supplier, sample, sample_ok, ads, launched } each null or the
   * reason. (Request ready has no data of its own: you say so, or copying the pack does.)
   */
  function evidenceOf(it) {
    const v = (k) => (it && it.steps && it.steps[k] && it.steps[k].v) || {};
    const n = (Array.isArray(it && it.links) ? it.links : []).filter((x) => x.url).length;
    return {
      link: n ? `${n} supplier link${n === 1 ? '' : 's'} pasted` : null,
      supplier: it && it.chosen_id ? 'A supplier is chosen in 🔎 Sourcing' : null,
      sample: v('sourcing').sample === true ? '“Sample ordered” is ticked on the launch card' : null,
      sample_ok: it && it.tested ? '“Full test on arrival” is ticked in 🔎 Sourcing' : null,
      ads: v('launch').campaign === true ? '“Test campaign set up” is ticked on the launch card' : null,
      launched: it && it.outcome ? `Your decision: ${it.outcome}` : null,
    };
  }
  /** The furthest stage the data shows beyond where the product is: { stage, why }, or null. */
  function suggestOf(it) {
    const e = evidenceOf(it);
    const at = stageIndex(it && it.stage);
    for (let i = STAGES.length - 1; i > Math.max(at, 0); i--) if (e[STAGES[i].k]) return { stage: STAGES[i].k, why: e[STAGES[i].k] };
    return null;
  }
  // The launch card's ticks that are these stages: moving past one sets it, moving back before it clears it.
  const TICKS = [{ stage: 'sample', step: 'sourcing', field: 'sample' }, { stage: 'ads', step: 'launch', field: 'campaign' }];
  /** The ticks a move from one stage to another changes: [{ step, field, on }]. */
  function ticksFor(from, to) {
    const a = stageIndex(from);
    const b = stageIndex(to);
    return TICKS.filter((t) => (a < stageIndex(t.stage)) !== (b < stageIndex(t.stage))).map((t) => ({ step: t.step, field: t.field, on: b >= stageIndex(t.stage) }));
  }
  /** Whole days from an ISO time to now (0 when unknown or in the future). */
  const daysIn = (iso, now) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 864e5)) : 0;
  };

  return { STAGES, STAGE_KEYS, MAX_LINKS, PACK, QUALITY, TEMPLATES, stageIndex, stageOf, cleanPack, badPack, linkOf, linksIn, noLinkWhy, tokenOnly, cleanTitle, notEnglish, zhGuess, zhOf, moneyOf, marketsOf, packOf, fieldsOf, copyAllOf, evidenceOf, suggestOf, ticksFor, daysIn };
}

const SOURCING_KIT = { cleanUrl, platformOf, fromPaste, PLATFORMS, fxOf };
const LAUNCH_KIT = { marginInputs, marginOf };
export const K = pipelineKit(SOURCING_KIT, LAUNCH_KIT);
export const { STAGES, STAGE_KEYS, MAX_LINKS, PACK, TEMPLATES, stageIndex, cleanPack, badPack, linkOf, linksIn, noLinkWhy, cleanTitle, notEnglish, zhGuess, zhOf, moneyOf, marketsOf, packOf, fieldsOf, copyAllOf, evidenceOf, suggestOf, ticksFor, daysIn } = K;
/** GET /pipeline.js: the kit's source, run once in the board as window.PIPELINE with the board's own sourcing and launch kits. */
export const PIPELINE_JS = `'use strict';\nwindow.PIPELINE = (${pipelineKit})(window.SOURCING, window.LAUNCH);\n`;

// ---------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------

const keyIn = (k) => (typeof k === 'string' && k.length <= 1000 && /^(eu|world|google|tiktok)\|./s.test(k) ? k : ''); // as launch.mjs
const idIn = (x) => (Number.isSafeInteger(Number(x)) && Number(x) > 0 && String(x).length <= 15 ? Number(x) : 0);
const numOr = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const obj = (s) => {
  try {
    const v = JSON.parse(s || '');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) {
    return {};
  }
};
const arr = (s) => {
  try {
    const v = JSON.parse(s || '');
    return Array.isArray(v) ? v : null;
  } catch (e) {
    return null;
  }
};
const iso = (now) => new Date(now).toISOString();
const bad = (error, status = 400) => ({ status, body: { error } });
const CJK = /[㐀-鿿]/;
const cleanNote = (x) => String(x ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 1000);

const ITEM_COLS = 'product_key, stage, stage_at, outcome, markets, pack, notes, created_at, updated_at';
const ITEMS_SQL = `SELECT ${ITEM_COLS} FROM pipeline_items`;
const ITEM_SQL = `SELECT ${ITEM_COLS} FROM pipeline_items WHERE product_key = ?`;
// A product's row the first time the pipeline acts on it: in Approved since it was approved (else since its card started).
const ENSURE_SQL = `INSERT INTO pipeline_items (product_key, stage, stage_at, created_at, updated_at) VALUES (?1, 'approved', ?2, ?3, ?3) ON CONFLICT(product_key) DO NOTHING`;
const HIST_COLS = 'product_key, from_stage, to_stage, note, actor, at';
const HISTS_SQL = `SELECT ${HIST_COLS} FROM pipeline_history ORDER BY id DESC LIMIT 3000`;
const HIST_SQL = `SELECT ${HIST_COLS} FROM pipeline_history WHERE product_key = ? ORDER BY id DESC LIMIT 30`;
const HIST_ADD_SQL = 'INSERT INTO pipeline_history (product_key, from_stage, to_stage, note, actor, at) VALUES (?, ?, ?, ?, ?, ?)';
const LAUNCH_ROW_SQL = 'SELECT product_key, title, facts, steps, pinned, decision, created_at, updated_at FROM launches WHERE product_key = ?';
const STEP_SQL = "UPDATE launches SET steps = json_set(CASE WHEN json_valid(steps) THEN steps ELSE '{}' END, ?, json(?)), updated_at = ? WHERE product_key = ?";
// Every product's links and sourcing row in one read each (the cards' keys only): no query per product.
const SUPS_SQL = 'SELECT id, product_key, platform, url, title, unit_price, currency, moq, rating, kind, repeat_rate, ship_price, weight_g, lead_days, origin, notes, source, created_at FROM product_suppliers WHERE product_key IN (SELECT product_key FROM launches) ORDER BY id';
const SXS_SQL = 'SELECT product_key, supplier_id, zh, eur_cny, eur_usd, checks FROM product_sourcing WHERE product_key IN (SELECT product_key FROM launches)';
const SETTINGS_SQL = 'SELECT key, value FROM pipeline_settings';
const SETTING_SQL = 'INSERT INTO pipeline_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';
const TT_SQL = "SELECT id, meta_status, meta_us, meta_au, meta_nz, sold_us FROM tiktok_products WHERE decision = 'approved'";

/** A query whose table may not be there yet (before the migration ran: a test link): no rows. */
const optional = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results || [], (e) => {
  if (/no such table/i.test(String(e && e.message))) return [];
  throw e;
});

/** The board-wide settings: the countries in the list (in order) and the agent form the pack opens on. */
function settingsOf(rows) {
  const m = new Map((rows || []).map((r) => [r.key, r.value]));
  const markets = (arr(m.get('markets')) || []).filter((cc) => Object.hasOwn(COUNTRIES, cc));
  let template = 'generic';
  try {
    const t = JSON.parse(m.get('template') || '""');
    if (Object.hasOwn(TEMPLATES, t)) template = t;
  } catch (e) {
    // the default
  }
  return { markets: markets.length ? [...new Set(markets)] : DEFAULT_MARKETS.slice(), template };
}
const marketsIn = (x) => {
  if (!Array.isArray(x) || x.length > 40) return null;
  const out = [...new Set(x.map((c) => String(c).toUpperCase()))];
  return out.every((cc) => Object.hasOwn(COUNTRIES, cc)) ? out : null;
};

/** A supplier row as a link in the pipeline (Sourcing's own shape, with the landed cost from ranked()). */
function linkRow(r) {
  return {
    id: Number(r.id), platform: Object.hasOwn(PLATFORMS, r.platform || '') ? r.platform : 'other', url: r.url || '', title: r.title || '', unit_price: numOr(r.unit_price), currency: r.currency || null,
    moq: numOr(r.moq), rating: numOr(r.rating), kind: r.kind || null, repeat_rate: numOr(r.repeat_rate), ship_price: numOr(r.ship_price), weight_g: numOr(r.weight_g), lead_days: numOr(r.lead_days),
    origin: r.origin || null, notes: r.notes || '', source: r.source === 'cj' ? 'cj' : 'manual', created_at: r.created_at || '',
  };
}
/**
 * The links of a product as the pipeline shows them: Sourcing's ranked list, each with what the pipeline reads off its link
 * (link_kind: offer, shop, short, search or page; offer_id; label). Sourcing's own fields (kind: factory or trader) stay.
 */
function linksOut(suppliers) {
  return suppliers.map((s) => {
    const l = s.url ? linkOf(s.url) : null;
    return Object.assign({}, s, { link_kind: l ? l.kind : '', offer_id: l ? l.id : '', label: l ? l.label : (PLATFORMS[s.platform] || PLATFORMS.other).label });
  });
}

/** Where a product runs ads now, from the board: [{ cc, ads?, days?, pct?, eu? }] (TikTok: its Meta ads in US, AU, NZ). */
function adMarkets(f, r, toAd) {
  if (f && f.source === 'tiktok') {
    const m = f.meta || {};
    return [['US', m.us], ['AU', m.au], ['NZ', m.nz]].filter(([, n]) => Number(n) > 0).map(([cc, n]) => ({ cc, ads: Number(n) }));
  }
  if (!r) return [];
  const a = toAd(r);
  if (a.world) return a.world.markets.map(([cc, ads, days]) => ({ cc, ads, days }));
  return (a.mk || []).map(([cc, pct]) => ({ cc, pct, eu: true }));
}
const huntZh = (r, toAd) => {
  const z = r ? String(toAd(r).zh || '') : '';
  return CJK.test(z) ? z.slice(0, 100) : '';
};
/**
 * The risk radar's verdict on a product (risk.mjs: EU rules for a store that ships from 1688), with your check on it:
 * { level: block | docs | ok, reasons (the ones that need care), ask: [[English, Chinese]] (documents for the supplier) },
 * or null. The radar is extra here: without it the pipeline works as before.
 */
function riskOf(facts, checks) {
  try {
    const x = riskFacts(facts);
    const v = riskVerdict(x, checks ? checks.get(riskKey(x)) : null);
    return { level: v.level, reasons: v.reasons.filter((r) => r.level === 'block' || r.level === 'docs').map((r) => ({ k: r.k, level: r.level, short: r.short, text: r.text })),
      ask: (v.ask || []).filter((a) => Array.isArray(a) && a[0]).map((a) => [String(a[0]), String(a[1] || a[0])]) };
  } catch (e) {
    return null;
  }
}
/** The suggested markets: where it runs ads that are in your list, else the first four of your list. */
const suggestedOf = (ads, offered) => {
  const s = ads.map((x) => x.cc).filter((cc) => offered.includes(cc));
  return s.length ? [...new Set(s)] : offered.slice(0, 4);
};

/**
 * One pipeline item. l: the launch card (launchOut) or null; facts: the card's facts or a candidate's; row: its
 * pipeline_items row or null; hist: its history (newest first); sx: { sourcing (supplier_id, zh, eur_cny, eur_usd,
 * tested), suppliers (ranked) }; extra: what the board adds (ad_markets, suggested, zh_hunt).
 */
function itemOf({ key, l, facts, row, hist, sx, extra = {} }, now) {
  const stage = row && STAGE_KEYS.includes(row.stage) ? row.stage : 'approved';
  const stageAt = (row && row.stage_at) || facts.approved_at || (l && l.created_at) || '';
  const s = (sx && sx.sourcing) || {};
  return Object.assign({
    key, card: !!l, title: (l && l.title) || facts.title || '', facts, source: facts.source || '',
    stage, stage_at: stageAt, days: daysIn(stageAt, now), outcome: row && (row.outcome === 'scale' || row.outcome === 'kill') ? row.outcome : null,
    decision: l ? l.decision : null, pinned: l ? l.pinned : false, dropped: !!(l && l.decision === 'no'),
    markets: row ? arr(row.markets) : null, pack: row ? obj(row.pack) : {}, notes: row ? obj(row.notes) : {},
    history: (hist || []).slice(0, 30).map((h) => ({ from: h.from_stage || null, to: h.to_stage, note: h.note || '', by: h.actor || 'you', at: h.at })),
    links: linksOut((sx && sx.suppliers) || []), chosen_id: numOr(s.supplier_id), zh: s.zh || '', fx: fxOf(s), tested: !!s.tested,
    steps: l ? l.steps : {}, created_at: (row && row.created_at) || '',
  }, extra);
}

/** The board's product of each launch key, its markets and the hunt's Chinese words. */
async function boardIndex(deps) {
  const b = await deps.board();
  return { idx: launchIndex(b, deps.pageKey), b };
}

/**
 * GET /api/pipeline: every approved product, each once: the launch cards (also those started before the pipeline) and the
 * approved products without one (as 🚀 Start lists them), with their stage, links, pack and markets; the settings; and the
 * facts of every country in your list. deps: as /api/launch's (board, toAd, pageKey); compliance: the hook for the
 * restricted categories per market (countries.mjs).
 */
export async function pipelineGet(env, params, now, deps) {
  const shared = boardIndex(deps);
  const memo = Object.assign({}, deps, { board: async () => (await shared).b }); // one read of the board for both
  const [cards, pick, rows, hists, sups, sxs, set, tt, { idx }, checks] = await Promise.all([
    env.DB.prepare(LIST_SQL).all().then((r) => (r.results || []).map(launchOut)),
    launchList(env, true, memo).then((r) => r.candidates || []),
    optional(env, ITEMS_SQL), optional(env, HISTS_SQL), env.DB.prepare(SUPS_SQL).all().then((r) => r.results || []), env.DB.prepare(SXS_SQL).all().then((r) => r.results || []), optional(env, SETTINGS_SQL),
    optional(env, TT_SQL), shared, riskChecks(env),
  ]);
  const settings = settingsOf(set);
  const byRow = new Map(rows.map((r) => [r.product_key, r]));
  const byHist = new Map();
  for (const h of hists) {
    if (!byHist.has(h.product_key)) byHist.set(h.product_key, []);
    byHist.get(h.product_key).push(h);
  }
  const day = iso(now).slice(0, 10);
  const bySup = new Map();
  for (const s of sups) {
    if (!bySup.has(s.product_key)) bySup.set(s.product_key, []);
    bySup.get(s.product_key).push(linkRow(s));
  }
  const bySx = new Map(sxs.map((s) => [s.product_key, s]));
  const ttMeta = new Map(tt.map((t) => [String(t.id), t]));
  const sxOf = (key) => {
    const s = bySx.get(key) || {};
    const fx = fxOf(s);
    return { sourcing: { supplier_id: s.supplier_id, zh: s.zh, eur_cny: s.eur_cny, eur_usd: s.eur_usd, tested: !!(obj(s.checks).sample || {}).tested }, suppliers: ranked(bySup.get(key) || [], fx, day) };
  };
  const boardExtra = (key, facts, r) => {
    let f = facts;
    if (facts.source === 'tiktok' && !facts.meta) { // a card started before TikTok facts held the Meta markets
      const t = ttMeta.get(key.slice('tiktok|'.length));
      if (t && t.meta_status === 'matched') f = Object.assign({}, facts, { meta: { us: t.meta_us, au: t.meta_au, nz: t.meta_nz } });
    }
    const ads = adMarkets(f, r, deps.toAd);
    return { ad_markets: ads, suggested: suggestedOf(ads.filter((x) => !x.eu), settings.markets), zh_hunt: huntZh(r, deps.toAd), risk: riskOf(f, checks) };
  };
  const items = [];
  for (const l of cards) {
    const r = l.key.startsWith('tiktok|') ? null : idx.byKey.get(cardProduct({ product_key: l.key, facts: JSON.stringify(l.facts), created_at: l.created_at }, idx));
    items.push(itemOf({ key: l.key, l, facts: l.facts, row: byRow.get(l.key), hist: byHist.get(l.key), sx: sxOf(l.key), extra: boardExtra(l.key, l.facts, r) }, now));
  }
  for (const c of pick) {
    const r = c.key.startsWith('tiktok|') ? null : idx.byKey.get(c.key);
    items.push(itemOf({ key: c.key, l: null, facts: c.facts, row: null, hist: [], sx: { sourcing: {}, suppliers: [] }, extra: boardExtra(c.key, c.facts, r) }, now));
  }
  items.sort((a, b) => stageIndex(a.stage) - stageIndex(b.stage) || (a.stage_at < b.stage_at ? -1 : a.stage_at > b.stage_at ? 1 : 0) || (a.key < b.key ? -1 : 1));
  const offered = settings.markets;
  const countries = Object.fromEntries(offered.map((cc) => [cc, countryFacts(cc, { compliance: deps.compliance ? deps.compliance[cc] : null })]));
  return { status: 200, body: { ok: true, items, settings, countries, all_countries: ALL_COUNTRIES, stages: STAGES, now: iso(now) } };
}

/**
 * One item after a change, read fresh (its card, row, history and Sourcing's panel data). The board's part (where it runs
 * ads, the suggested markets, the hunt's Chinese words, the risk radar) is not read again: the board keeps what the list gave it.
 */
async function itemNow(env, key, now, extra = {}) {
  const [card, row, hist, sx] = await Promise.all([
    env.DB.prepare(LAUNCH_ROW_SQL).bind(key).first(), env.DB.prepare(ITEM_SQL).bind(key).first(), env.DB.prepare(HIST_SQL).bind(key).all().then((r) => r.results || []),
    sourcingGet(env, new URLSearchParams({ key }), now),
  ]);
  if (!card) return bad('No launch card for this product', 404); // removed meanwhile
  const l = launchOut(card);
  const v = sx.status === 200 ? sx.body : { sourcing: {}, suppliers: [] };
  const sourcing = Object.assign({}, v.sourcing, { tested: !!(v.sourcing && v.sourcing.checks && v.sourcing.checks.sample && v.sourcing.checks.sample.tested) });
  return { status: 200, body: Object.assign({ ok: true, item: Object.assign(itemOf({ key, l, facts: l.facts, row, hist, sx: { sourcing, suppliers: v.suppliers || [] } }, now), { partial: true }) }, extra) };
}

/** The statements of a move from the row's stage to `to`: the row, the history, and the launch card ticks that are stages. */
function moveSteps(env, key, l, row, to, actor, note, at) {
  const from = row.stage;
  const out = [
    env.DB.prepare("UPDATE pipeline_items SET stage = ?1, stage_at = ?2, outcome = CASE WHEN ?1 = 'launched' THEN outcome ELSE NULL END, updated_at = ?2 WHERE product_key = ?3").bind(to, at, key),
    env.DB.prepare(HIST_ADD_SQL).bind(key, from, to, note || null, actor, at),
  ];
  const changed = {};
  for (const t of ticksFor(from, to)) {
    const cur = changed[t.step] || (l.steps && l.steps[t.step]) || {};
    const v = Object.assign({}, cur.v && typeof cur.v === 'object' ? cur.v : {});
    if (t.on) v[t.field] = true;
    else delete v[t.field];
    changed[t.step] = cleanStep(t.step, { done: cur.done === true, note: cur.note == null ? '' : String(cur.note), v });
  }
  for (const [k, step] of Object.entries(changed)) out.push(env.DB.prepare(STEP_SQL).bind('$.' + k, JSON.stringify(step), at, key));
  return out;
}

/**
 * POST /api/pipeline. A product without a launch card gets one first (launchPost's start: only an approved product, as
 * 🚀 Start; a key of an old card finds that card). Returns { status, body }; body.item: the product now (partial: the
 * board's part is not read again).
 */
/** What is wrong with a change before anything is read or written (a change that cannot be saved never starts a card), or ''. */
function checkChange(j) {
  if (j.stage != null) return STAGE_KEYS.includes(String(j.stage)) ? '' : 'Bad stage';
  if (j.outcome !== undefined) return ['scale', 'kill', '', null].includes(j.outcome) ? '' : 'Bad outcome';
  if (j.note != null && typeof j.note === 'object') return STAGE_KEYS.includes(String(j.note.stage)) ? '' : 'Bad stage';
  if (j.markets !== undefined) return j.markets === null || marketsIn(j.markets) ? '' : 'Bad markets';
  if (j.pack != null) {
    if (typeof j.pack !== 'object' || Array.isArray(j.pack)) return 'Bad pack';
    const wrong = badPack(j.pack);
    return wrong.length ? `Not a whole number in range: ${wrong.join(', ')}` : '';
  }
  if (j.zh !== undefined) return '';
  if (j.links != null) {
    const paste = String((j.links && j.links.paste) || '');
    return linksIn(paste).length ? '' : noLinkWhy(paste);
  }
  if (j.link != null) {
    const x = j.link && typeof j.link === 'object' ? j.link : {};
    if (!idIn(x.id)) return 'Bad link';
    return x.remove === true || (x.set && typeof x.set === 'object') ? '' : 'Nothing to save';
  }
  if (j.choose !== undefined) return j.choose === null || idIn(j.choose) ? '' : 'Bad link';
  if (j.drop === true || j.drop === false || j.copied === true || j.start === true) return '';
  return 'Nothing to save';
}

export async function pipelinePost(env, j, now, deps) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return bad('Bad JSON');
  const at = iso(now);
  if (j.settings != null) return saveSettings(env, j.settings, at);
  let key = keyIn(j.key);
  if (!key) return bad('Bad key');
  const wrong = checkChange(j);
  if (wrong) return bad(wrong);
  // Its row first: before the migration ran (a test link on the live database) this fails here, before anything is written
  // (app.mjs answers 503), so no launch card is started for a change that cannot be saved.
  await env.DB.prepare(ITEM_SQL).bind(key).first();
  let card = await env.DB.prepare(LAUNCH_ROW_SQL).bind(key).first();
  let started = false;
  if (!card) {
    const st = await launchPost(env, { start: key }, now, deps);
    if (st.status !== 200) return st;
    key = st.body.launch.key;
    card = await env.DB.prepare(LAUNCH_ROW_SQL).bind(key).first();
    if (!card) return bad('No launch card for this product', 404);
    started = true;
  }
  const l = launchOut(card);
  await env.DB.prepare(ENSURE_SQL).bind(key, (l.facts && l.facts.approved_at) || l.created_at || at, at).run();
  const row = await env.DB.prepare(ITEM_SQL).bind(key).first();
  const done = (extra = {}) => itemNow(env, key, now, Object.assign(started ? { started: key } : {}, extra));
  const move = async (to, actor, note) => {
    if (row.stage === to) return;
    await env.DB.batch(moveSteps(env, key, l, row, to, actor, note, at));
    row.stage = to;
  };
  const before = (k) => stageIndex(row.stage) < stageIndex(k);

  if (j.stage != null) {
    const to = String(j.stage);
    if (!STAGE_KEYS.includes(to)) return bad('Bad stage');
    await move(to, 'you', j.note == null ? '' : cleanNote(j.note));
    return done();
  }
  if (j.outcome !== undefined) {
    const o = j.outcome === 'scale' || j.outcome === 'kill' ? j.outcome : j.outcome === '' || j.outcome === null ? null : undefined;
    if (o === undefined) return bad('Bad outcome');
    if (row.stage !== 'launched') return bad('Move it to Launched first', 409);
    await env.DB.batch([
      env.DB.prepare('UPDATE pipeline_items SET outcome = ?, updated_at = ? WHERE product_key = ?').bind(o, at, key),
      env.DB.prepare(HIST_ADD_SQL).bind(key, 'launched', 'launched', o === 'scale' ? 'Scale' : o === 'kill' ? 'Kill' : 'Decision taken back', 'outcome', at),
    ]);
    return done();
  }
  if (j.note != null && typeof j.note === 'object') {
    const k = String(j.note.stage);
    if (!STAGE_KEYS.includes(k)) return bad('Bad stage');
    // One note in one statement: a note on another stage saved at the same moment is not lost. The path is a fixed key.
    await env.DB.prepare("UPDATE pipeline_items SET notes = json_set(CASE WHEN json_valid(notes) THEN notes ELSE '{}' END, ?, ?), updated_at = ? WHERE product_key = ?").bind('$.' + k, cleanNote(j.note.text), at, key).run();
    return done();
  }
  if (j.markets !== undefined) {
    const m = j.markets === null ? null : marketsIn(j.markets);
    if (j.markets !== null && !m) return bad('Bad markets');
    await env.DB.prepare('UPDATE pipeline_items SET markets = ?, updated_at = ? WHERE product_key = ?').bind(m ? JSON.stringify(m) : null, at, key).run();
    return done();
  }
  if (j.pack != null) {
    if (typeof j.pack !== 'object' || Array.isArray(j.pack)) return bad('Bad pack');
    const wrong = badPack(j.pack);
    if (wrong.length) return bad(`Not a whole number in range: ${wrong.join(', ')}`);
    await env.DB.prepare('UPDATE pipeline_items SET pack = ?, updated_at = ? WHERE product_key = ?').bind(JSON.stringify(cleanPack(j.pack)), at, key).run();
    return done();
  }
  if (j.zh !== undefined) {
    const out = await sourcingPost(env, { key, info: { zh: j.zh == null ? '' : String(j.zh) } }, now);
    return out.status === 200 ? done() : out;
  }
  if (j.links != null) {
    const paste = String((j.links && j.links.paste) || '');
    const found = linksIn(paste);
    if (!found.length) return bad(noLinkWhy(paste));
    const view = await sourcingGet(env, new URLSearchParams({ key }), now);
    const have = view.status === 200 ? view.body.suppliers.filter((s) => s.url).length : 0;
    const room = MAX_LINKS - have;
    if (room <= 0) return bad(`Already ${MAX_LINKS} links: remove one, or compare more in 🔎 Sourcing`, 409);
    const added = [];
    const skipped = [];
    for (const f of found.slice(0, room)) {
      // Sourcing adds it: its own clean-up, the price and MOQ the text says, the same link twice refused.
      const out = await sourcingPost(env, { key, add: { paste: f.text, url: f.url } }, now);
      if (out.status === 200 && out.body.added) added.push(out.body.added);
      else skipped.push({ url: f.url, error: out.body.error || 'Not added' });
    }
    if (added.length && before('link')) await move('link', 'link', `${added.length} link${added.length === 1 ? '' : 's'} pasted`);
    return done({ added, skipped, over: Math.max(0, found.length - room) });
  }
  if (j.link != null) {
    const x = j.link && typeof j.link === 'object' ? j.link : {};
    const id = idIn(x.id);
    if (!id) return bad('Bad link');
    let out;
    if (x.remove === true) out = await sourcingPost(env, { key, id, remove: true }, now);
    else if (x.set && typeof x.set === 'object') {
      const set = {};
      for (const k of ['unit_price', 'currency', 'moq', 'notes', 'title']) if (Object.hasOwn(x.set, k)) set[k] = x.set[k];
      out = await sourcingPost(env, { key, id, set }, now);
    } else return bad('Nothing to save');
    return out.status === 200 ? done(out.body.launch ? { launch: out.body.launch } : {}) : out;
  }
  if (j.choose !== undefined) {
    const id = j.choose === null ? null : idIn(j.choose);
    if (j.choose !== null && !id) return bad('Bad link');
    const out = await sourcingPost(env, { key, choose: id }, now);
    if (out.status !== 200) return out;
    if (id && before('supplier')) await move('supplier', 'choose', 'Supplier chosen');
    return done(out.body.launch ? { launch: out.body.launch } : {});
  }
  if (j.drop === true || j.drop === false) {
    const out = await launchPost(env, { key, decision: j.drop ? 'no' : '' }, now, deps);
    return out.status === 200 ? done({ launch: out.body.launch }) : out;
  }
  if (j.copied === true) {
    if (row.stage === 'approved') await move('request', 'copy', 'Request pack copied');
    return done();
  }
  if (j.start === true) return done(); // only the launch card (started above when there was none)
  return bad('Nothing to save');
}

async function saveSettings(env, s, at) {
  const x = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  const steps = [];
  if (x.markets !== undefined) {
    const m = marketsIn(x.markets);
    if (!m || !m.length) return bad('Bad markets: pick at least one country');
    steps.push(env.DB.prepare(SETTING_SQL).bind('markets', JSON.stringify(m), at));
  }
  if (x.template !== undefined) {
    if (!Object.hasOwn(TEMPLATES, String(x.template))) return bad('Bad template');
    steps.push(env.DB.prepare(SETTING_SQL).bind('template', JSON.stringify(String(x.template)), at));
  }
  if (!steps.length) return bad('Nothing to save');
  await env.DB.batch(steps);
  const settings = settingsOf((await env.DB.prepare(SETTINGS_SQL).all()).results);
  const countries = Object.fromEntries(settings.markets.map((cc) => [cc, countryFacts(cc)]));
  return { status: 200, body: { ok: true, settings, countries } };
}

// ---------------------------------------------------------------------------
// The product photo as a file: an agent's form wants an upload (Kungfubuy: gif, jpg or png, at most 3 MB)
// ---------------------------------------------------------------------------
export const MAX_IMAGE = 15 * 1024 * 1024; // what the Worker fetches at most; the board makes it fit 3 MB
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
const slugOf = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'product';

/**
 * GET /api/pipeline/image?key=…: the photo of the product with that key (a launch card's, else an approved product's on
 * the board), fetched by the Worker, so the board can save it (and make a JPG under 3 MB of it). Only the product's own
 * photo link from D1 is fetched: never a link from the request. { status, bytes, type, name } or { status, body: { error } }.
 */
export async function pipelineImage(env, params, now, deps) {
  const key = keyIn(params.get('key'));
  if (!key) return bad('Bad key');
  const card = await env.DB.prepare('SELECT facts FROM launches WHERE product_key = ?').bind(key).first();
  let facts = card ? obj(card.facts) : null;
  if (!facts) {
    const c = ((await launchList(env, true, deps)).candidates || []).find((x) => x.key === key);
    facts = c ? c.facts : null;
  }
  if (!facts) return bad('No approved product with this key', 404);
  const img = typeof facts.img === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(facts.img) ? facts.img : '';
  if (!img) return bad('This product has no photo', 404);
  let res;
  try {
    res = await (deps.fetch || globalThis.fetch)(img, { headers: { Accept: 'image/jpeg,image/png,image/gif;q=0.9,image/webp;q=0.8,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return bad('Could not fetch the photo: ' + String((e && e.message) || e).slice(0, 120), 502);
  }
  if (!res.ok) return bad(`The photo’s site answered ${res.status}`, 502);
  if (res.url && !/^https:\/\//i.test(res.url)) return bad('The photo moved to a link that is not https', 502);
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!Object.hasOwn(EXT, type)) return bad(`Not a photo the board can use (${type || 'no type'})`, 502);
  if (Number(res.headers.get('content-length')) > MAX_IMAGE) return bad('The photo is bigger than 15 MB', 413);
  const reader = res.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE) {
      reader.cancel().catch(() => {});
      return bad('The photo is bigger than 15 MB', 413);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return { status: 200, bytes, type, name: `${slugOf(facts.title)}.${EXT[type]}` };
}
