/*
 * Audience engine: who competitor ads reach, from Meta's own EU transparency numbers (lib/audience-collect.mjs readFbAd).
 *
 * For an ad shown in the EU, Meta publishes how many people it reached per country, age band and gender. Most shops run
 * broad targeting (all genders, 18–65+), so the split is what Meta's delivery found for the product: a strong hint of who
 * responds. It is reach, not purchases, and cheap age bands and countries get more reach for the same money. The index
 * compares the product with every ad the engine has read (the baseline): 100 = like the average ad, 130 = 30% more.
 */

export const BANDS = ['18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
const SEXES = ['F', 'M', 'U'];
const round1 = (x) => Math.round(x * 10) / 10;

/** One ad's reach as shares (0–1) per cell 'F|25-34', per band, per sex and per country. Null without reach data. */
export function sharesOf(ad) {
  const cells = (ad && ad.reach && ad.reach.cells) || {};
  const total = Object.values(cells).reduce((a, b) => a + b, 0);
  if (!total) return null;
  const s = { total, cells: {}, bands: {}, sexes: { F: 0, M: 0, U: 0 }, countries: {} };
  for (const [k, v] of Object.entries(cells)) {
    const [sex, band] = k.split('|');
    s.cells[k] = v / total;
    s.bands[band] = (s.bands[band] || 0) + v / total;
    if (SEXES.includes(sex)) s.sexes[sex] += v / total;
  }
  const cc = (ad.reach && ad.reach.byCountry) || {};
  const ct = Object.values(cc).reduce((a, b) => a + b, 0);
  for (const [k, v] of Object.entries(cc)) if (ct) s.countries[k] = v / ct;
  return s;
}

/** The baseline: the average split over many ads, each ad counting once (one huge ad must not set the norm). */
export function baselineOf(ads) {
  const list = (ads || []).map(sharesOf).filter(Boolean);
  const b = { n: list.length, cells: {}, bands: {}, sexes: { F: 0, M: 0, U: 0 } };
  if (!list.length) return b;
  for (const s of list) {
    for (const [k, v] of Object.entries(s.cells)) b.cells[k] = (b.cells[k] || 0) + v / list.length;
    for (const [k, v] of Object.entries(s.bands)) b.bands[k] = (b.bands[k] || 0) + v / list.length;
    for (const k of SEXES) b.sexes[k] += s.sexes[k] / list.length;
  }
  return b;
}

/** The smallest run of neighbouring age bands that holds at least `share` of the reach, e.g. '25-54'. */
export function ageSpan(bands, share = 0.6) {
  let best = null;
  for (let i = 0; i < BANDS.length; i++) {
    let sum = 0;
    for (let j = i; j < BANDS.length; j++) {
      sum += bands[BANDS[j]] || 0;
      if (sum >= share) {
        const len = j - i;
        if (!best || len < best.len || (len === best.len && sum > best.sum)) best = { i, j, len, sum };
        break;
      }
    }
  }
  if (!best) return null;
  const lo = BANDS[best.i].split('-')[0];
  const hi = BANDS[best.j] === '65+' ? '65+' : BANDS[best.j].split('-')[1];
  return { from: Number(lo), to: hi === '65+' ? 65 : Number(hi), label: hi === '65+' ? `${lo}+` : `${lo}-${hi}`, share: round1(best.sum * 100) };
}

/**
 * The product's audience from its ads (reach-weighted: who the ads reached in total) against the baseline.
 * Returns null without reach data, else { ads, reach, women, men, unknown (%), ages: [{ band, share, index }],
 * cells (top 4: { sex, band, share, index }), span, skew ('women' | 'men' | ''), countries: [{ cc, share }], targeting }.
 */
export function demographics(ads, baseline) {
  const withData = (ads || []).filter((a) => sharesOf(a));
  if (!withData.length) return null;
  const sum = {};
  const cc = {};
  let total = 0;
  for (const a of withData) {
    for (const [k, v] of Object.entries(a.reach.cells)) {
      sum[k] = (sum[k] || 0) + v;
      total += v;
    }
    for (const [k, v] of Object.entries(a.reach.byCountry || {})) cc[k] = (cc[k] || 0) + v;
  }
  const merged = sharesOf({ reach: { cells: sum, byCountry: cc } });
  const base = baseline && baseline.n ? baseline : null;
  const idx = (v, b) => (b ? Math.round((v / b) * 100) : null);
  const ages = BANDS.map((band) => ({ band, share: round1((merged.bands[band] || 0) * 100), index: base ? idx(merged.bands[band] || 0, base.bands[band]) : null }));
  const cells = Object.entries(merged.cells).filter(([k]) => !k.startsWith('U|'))
    .map(([k, v]) => ({ sex: k[0], band: k.slice(2), share: round1(v * 100), index: base ? idx(v, base.cells[k]) : null }))
    .sort((a, b) => b.share - a.share).slice(0, 4);
  const women = round1(merged.sexes.F * 100);
  const men = round1(merged.sexes.M * 100);
  const known = women + men || 1;
  const skew = women / known >= 0.6 ? 'women' : men / known >= 0.6 ? 'men' : '';
  const countries = Object.entries(merged.countries).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => ({ cc: k, share: round1(v * 100) }));
  const set = withData.map((a) => a.targeting || {});
  const broadAge = set.every((t) => !t.ages || ((t.ages.min || 18) <= 18 && (!t.ages.max || t.ages.max >= 65)));
  const broadSex = set.every((t) => !t.gender || /^all$/i.test(t.gender));
  return {
    ads: withData.length, reach: total, women, men, unknown: round1(merged.sexes.U * 100), skew, ages, cells, span: ageSpan(merged.bands),
    countries, baseline: base ? base.n : 0,
    sexIndex: base ? { F: idx(merged.sexes.F, base.sexes.F), M: idx(merged.sexes.M, base.sexes.M) } : null,
    targeting: { broadAge, broadSex, gender: [...new Set(set.map((t) => t.gender).filter(Boolean))], ages: set.map((t) => t.ages).filter(Boolean),
      countries: [...new Set(set.flatMap((t) => t.locations || []))].length },
  };
}

/** A short human line: "53% women · 25-54 hold 66% · top IE 14%, GR 13%". */
export function demoLine(d) {
  if (!d) return 'no EU reach data';
  const parts = [`${d.women}% women, ${d.men}% men`];
  if (d.span) parts.push(`ages ${d.span.label} hold ${d.span.share}% of reach`);
  if (d.countries.length) parts.push('top ' + d.countries.slice(0, 3).map((c) => `${c.cc} ${c.share}%`).join(', '));
  return parts.join(' · ');
}
