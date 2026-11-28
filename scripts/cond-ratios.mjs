// Learned condition prices (owner's request, Nov 2026): what a card in a worse condition typically sells for, as a
// share of its Near Mint market price, learned from the cards that do have TCGplayer condition prices (Card.api's
// weekly JustTCG run, the cards' `cm`; only ~1,600 cards). The app (kms-collection web/js/pricing.js, `learnedRatio`)
// uses these for every other card instead of a flat percent, labeled "Estimate". Published in pricing.json as
// `condRatios`: a small table, not per-card numbers.
//
// Groups: NM price band x game x age (set date) x rarity group. A group is published for a condition only with at
// least MIN_SAMPLES cards; the app walks LOOKUP from the finest group to the coarsest and takes the first one there
// (the app's copy of bandOf / ageOf / rarityGroup / LOOKUP must stay the same as these).
// Each group's ratio is the median after dropping outliers (outside 1.5 IQR of the group's quartiles).
// `check`: 20% of the cards (by ID hash) held out, ratios learned on the rest, and the estimate's error on the held-out
// cards against the flat percent the app used before (median and mean absolute error, as a share of the real price).

export const CONDITIONS = ['LP', 'MP', 'HP', 'DMG'];
export const FLAT = { LP: 0.85, MP: 0.70, HP: 0.50, DMG: 0.30 };   // the app's old flat percents (pricing.js CONDITIONS)
const BANDS = [5, 20, 50, 200];          // NM price band upper bounds: <$5, $5-20, $20-50, $50-200, $200+
const AGES = [['vintage', '2003-01-01'], ['older', '2017-01-01'], ['modern', null]];
const MIN_SAMPLES = 12;
// Finest first: band|game|age|rarity, '*' = any
const LOOKUP = [[1, 1, 1, 1], [1, 1, 1, 0], [1, 1, 0, 1], [1, 1, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0]];

export function bandOf(nm) { const i = BANDS.findIndex((b) => nm < b); return String(i < 0 ? BANDS.length : i); }
export function ageOf(date) {
  if (!date) return null;
  return AGES.find(([, before]) => !before || date < before)[0];
}
export function rarityGroup(r) {
  r = String(r || '').toLowerCase().replace(/\s*reverse holo$/, '').trim();
  if (/promo/.test(r)) return 'promo';
  if (!r || /^(common|uncommon|c|u|land|token|short print)$/.test(r)) return 'common';
  if (/^(rare|holo rare|rare holo|r|super rare)$/.test(r)) return 'rare';
  return 'high';
}
function keysOf(s) {
  const parts = [s.band, s.game, s.age, s.rar];
  return LOOKUP.filter((use) => use[2] === 0 || s.age).map((use) => parts.map((p, i) => (use[i] ? p : '*')).join('|'));
}

function median(a) {
  const x = a.slice().sort((p, q) => p - q), m = x.length >> 1;
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}
function quantile(x, q) { const i = (x.length - 1) * q, lo = Math.floor(i); return x[lo] + (x[Math.ceil(i)] - x[lo]) * (i - lo); }
function robustMedian(a) {
  const x = a.slice().sort((p, q) => p - q);
  if (x.length >= 8) {
    const q1 = quantile(x, 0.25), q3 = quantile(x, 0.75), k = 1.5 * (q3 - q1);
    const kept = x.filter((v) => v >= q1 - k && v <= q3 + k);
    if (kept.length) return median(kept);
  }
  return median(x);
}
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// One row per card with a NM market price and condition prices
export function samplesOf(sets) {
  const out = [];
  for (const s of sets) {
    for (const c of s.cards) {
      if (!c.cm || c.sd || !(c.m > 0)) continue;
      const ratios = {};
      for (const k of CONDITIONS) {
        const v = c.cm[k];
        // A price far above NM is a stale or mismatched entry, a near-zero one a typo
        if (typeof v === 'number' && v > 0 && v / c.m <= 1.25 && v / c.m >= 0.01) ratios[k] = Math.min(1, v / c.m);
      }
      if (!Object.keys(ratios).length) continue;
      out.push({ id: c.id, nm: c.m, cm: c.cm, ratios, band: bandOf(c.m), game: s.game, age: ageOf(s.date), rar: rarityGroup(c.r) });
    }
  }
  return out;
}

function learn(samples) {
  const groups = {};
  for (const s of samples) {
    for (const key of keysOf(s)) {
      const g = groups[key] || (groups[key] = {});
      for (const k in s.ratios) (g[k] || (g[k] = [])).push(s.ratios[k]);
    }
  }
  const table = {};
  for (const key of Object.keys(groups).sort()) {
    const row = {};
    for (const k of CONDITIONS) {
      const a = groups[key][k];
      if (a && a.length >= MIN_SAMPLES) row[k] = [Math.round(robustMedian(a) * 1000) / 1000, a.length];
    }
    if (Object.keys(row).length) table[key] = row;
  }
  return table;
}
export function lookup(table, s, k) {
  for (const key of keysOf(s)) if (table[key] && table[key][k]) return table[key][k][0];
  return null;
}

function errors(pairs) {
  const e = pairs.map(([est, real]) => Math.abs(est - real) / real);
  const r = (v) => Math.round(v * 1000) / 10;
  return { median: r(median(e)), mean: r(e.reduce((a, b) => a + b, 0) / e.length) };
}
function check(samples) {
  const test = samples.filter((s) => hash(s.id) % 5 === 0), train = samples.filter((s) => hash(s.id) % 5 !== 0);
  const table = learn(train);
  const out = { trained: train.length, tested: test.length, byCondition: {} };
  for (const k of CONDITIONS) {
    const learned = [], flat = [];
    for (const s of test) {
      const real = s.cm[k];
      if (!(s.ratios[k] > 0)) continue;
      const ratio = lookup(table, s, k);
      learned.push([s.nm * (ratio == null ? FLAT[k] : ratio), real]);
      flat.push([s.nm * FLAT[k], real]);
    }
    if (learned.length) out.byCondition[k] = { cards: learned.length, learned: errors(learned), flat: errors(flat) };
  }
  return out;
}

// The pricing.json `condRatios` value
export function conditionRatios(sets, builtAt) {
  const samples = samplesOf(sets);
  return {
    builtAt, samples: samples.length, min: MIN_SAMPLES, bands: BANDS, ages: AGES, conditions: CONDITIONS,
    lookup: LOOKUP, table: learn(samples), check: check(samples)
  };
}
