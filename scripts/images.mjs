// Card pictures for cards TCGplayer has none for (owner's request, Nov 2026: some cards showed no picture).
// The app shows a card's TCGplayer product picture (tcgplayer-cdn.tcgplayer.com, by product id); about 6,000
// products have none (tcgcsv's imageCount 0: Japanese Mirror Holofoil / Master Ball printings, 2020 reprints,
// World Championship decks…), and Chinese cards have no product at all. For those, in this order:
//   1. another TCGplayer product of the same card that has a picture (same set and number, or same name and
//      number elsewhere; Magic and Yu-Gi-Oh! also by name alone): `ip` = that product's id. No new host.
//   2. Magic: Scryfall's picture by TCGplayer id (api.scryfall.com/cards/tcgplayer/<id>; pictures on
//      cards.scryfall.io, which Scryfall lets apps show).
//   3. Pokémon: pokemontcg.io's data repo on GitHub (English, pictures on images.pokemontcg.io), then TCGdex
//      (api.tcgdex.net, English and Japanese, pictures on assets.tcgdex.net), by set and number, name to confirm;
//      then the official card databases and a Simplified Chinese dataset (scripts/official-pictures.mjs: Chinese and
//      Japanese cards no card API has; owner's decision, Nov 2026).
//   4. Yu-Gi-Oh!: YGOPRODeck's picture by card name (db.ygoprodeck.com/api/v7/cardinfo.php); scripts/hosted-pictures.mjs
//      copies it to the data site (YGOPRODeck asks that its pictures be hosted, not shown from its server).
// Big pictures get small copies on the data site too (scripts/hosted-pictures.mjs, after this step).
// A card TCGplayer has no picture for gets `ni: 1` (so the app doesn't ask TCGplayer for it), and `ip` or `img`.
// What the outside sources answered is kept in pictures.json (published with the data), so a night asks them only
// about cards it hasn't seen lately; a source that's down keeps last night's answers. pictures.json's `left` lists
// the cards still without a picture.
import fs from 'node:fs';
import path from 'node:path';
import { officialSources } from './official-pictures.mjs';

const UA = { 'User-Agent': 'kms-collection-data-build' };
const TCGCSV = 'https://tcgcsv.com/tcgplayer';
const POKEMON_CATEGORIES = { en: 3, ja: 85 };
const RECHECK_DAYS = 7;          // free card APIs: a miss is asked again after a week
const RECHECK_OFFICIAL_DAYS = 30; // the official databases (scripts/official-pictures.mjs): after a month
const CACHE_VERSION = 4;          // a new version forgets the old misses (sources were added)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(url, headers, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: Object.assign({}, UA, headers || {}) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(url + ' answered ' + res.status);
      return await res.json();
    } catch (e) { if (i >= tries) throw e; await sleep(3000 * (i + 1)); }
  }
}
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } }));
}
// "Shauna - 185/171 (Mirror Holofoil) [Staff]" → "shauna"
function baseName(n) {
  return String(n || '').replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\s+-\s+.*$/, '')
    .toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
// "015/165" → "15", "15_A" / "15A" → "15a"
function numKey(n) { return String(n || '').split('/')[0].toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^0+(?=\d)/, ''); }
function words(s) { return new Set(baseName(s).split(' ').filter((w) => w.length > 1 && !/^(pokemon|the|and|of|set|cards?)$/.test(w))); }

// Products collected from tcgcsv: id → { cat, g, no, name, ic }
export function productCollector() {
  const products = new Map();
  return {
    products,
    add(category, groupId, results) {
      (results || []).forEach((p) => {
        const no = ((p.extendedData || []).find((e) => e.name === 'Number') || {}).value || '';
        products.set(String(p.productId), { cat: category, g: groupId, no: String(no), name: p.name, ic: p.imageCount });
      });
    }
  };
}

async function tcgcsvCategory(collector, category) {
  const groups = ((await json(TCGCSV + '/' + category + '/groups')) || {}).results || [];
  if (!groups.length) throw new Error('no groups');
  let failed = 0;
  await pool(groups, 3, async (g) => {
    try { const d = await json(TCGCSV + '/' + category + '/' + g.groupId + '/products'); collector.add(category, g.groupId, d && d.results); }
    catch (e) { failed++; }
  });
  if (failed > groups.length / 10) throw new Error(failed + ' of ' + groups.length + ' groups failed');
}

// ---- Outside sources ----
// YGOPRODeck: every card once a night (only when a Yu-Gi-Oh! card is looked up), its small picture by name.
// "Token: Joey and Red-Eyes Black Dragon" is the token's own card; YGOPRODeck lists some tokens by name.
let ygoCards = null;
async function ygoprodeck(name) {
  if (!ygoCards) {
    ygoCards = json('https://db.ygoprodeck.com/api/v7/cardinfo.php').then((d) => {
      const byName = {};
      ((d && d.data) || []).forEach((c) => { const k = baseName(c.name); if (!byName[k]) byName[k] = c; });
      return byName;
    });
  }
  const byName = await ygoCards;
  const c = byName[baseName(name)] || byName[baseName(String(name).replace(/^Token:\s*/i, ''))];
  const img = c && c.card_images && c.card_images[0] && c.card_images[0].image_url_small;
  return /^https:\/\/images\.ygoprodeck\.com\/images\/cards_small\/\d+\.jpg$/.test(img || '') ? img : '';
}
async function scryfall(productId) {
  const c = await json('https://api.scryfall.com/cards/tcgplayer/' + productId, { Accept: 'application/json' }, 2);
  await sleep(120);   // Scryfall asks for 50-100 ms between requests
  if (!c) return '';
  const uris = c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris);
  return uris && uris.small ? uris.small.replace(/\?.*$/, '') : '';
}

// pokemontcg.io (English) and TCGdex (English, Japanese): each source's set list, then a set's cards when needed
function pokemonSources() {
  const cache = {};
  const once = (key, fn) => (cache[key] = cache[key] || fn().catch((e) => { console.warn('  pictures: ' + key + ': ' + e.message); return null; }));
  const ptcgSets = () => once('ptcg', async () => (await json('https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json')) || []);
  const ptcgCards = (id) => once('ptcg:' + id, async () => ((await json('https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/cards/en/' + id + '.json')) || [])
    .map((c) => ({ no: c.number, name: c.name, img: c.images && c.images.small })));
  const dexSets = (lang) => once('dex:' + lang, async () => (await json('https://api.tcgdex.net/v2/' + lang + '/sets')) || []);
  const dexCards = (lang, id) => once('dex:' + lang + ':' + id, async () => (((await json('https://api.tcgdex.net/v2/' + lang + '/sets/' + encodeURIComponent(id))) || {}).cards || [])
    .map((c) => ({ no: c.localId, name: c.name, img: c.image ? c.image + '/low.webp' : '' })));
  // The outside sets that may be ours: same code (Japanese), else sharing the most words of the name (English)
  function candidates(list, set, byCode) {
    if (!list) return [];
    if (byCode) return list.filter((x) => set.code && x.id.toLowerCase() === String(set.code).toLowerCase());
    const mine = words(set.name);
    return list.map((x) => { let n = 0; words(x.name).forEach((w) => { if (mine.has(w)) n++; }); return [n, x]; })
      .filter((x) => x[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, 4).map((x) => x[1]);
  }
  async function find(set, card) {
    const no = numKey(card.no), name = baseName(card.n);
    if (!no) return '';
    const tries = [];
    if (set.lang === 'en') {
      candidates(await ptcgSets(), set).forEach((x) => tries.push(() => ptcgCards(x.id)));
      candidates(await dexSets('en'), set).forEach((x) => tries.push(() => dexCards('en', x.id)));
    } else if (set.lang === 'ja') {
      candidates(await dexSets('ja'), set, true).forEach((x) => tries.push(() => dexCards('ja', x.id)));
    }
    for (const t of tries) {
      const cards = (await t()) || [];
      // Same number and the same name (Japanese TCGdex names are Japanese: the number and set code are enough)
      const hit = cards.find((c) => c.img && numKey(c.no) === no && (set.lang === 'ja' || baseName(c.name) === name));
      if (hit) return hit.img;
    }
    return '';
  }
  return { find };
}

// ---- The step ----
// sets: the build's sets ({ game, lang, name, code, cards }); collector: products of the tcgcsv games read tonight;
// previous: last night's pictures.json. Returns tonight's pictures.json.
export async function addCardPictures(sets, collector, previous, games) {
  const sameVersion = previous && previous.v === CACHE_VERSION;
  const prevExt = (previous && previous.ext) || {};
  const today = new Date().toISOString().slice(0, 10);
  // Pokémon's products (Card.api gives only their ids)
  for (const lang of Object.keys(POKEMON_CATEGORIES)) {
    if (!games.includes('pokemon')) break;
    try { await tcgcsvCategory(collector, POKEMON_CATEGORIES[lang]); }
    catch (e) { console.warn('  pictures: tcgcsv Pokémon ' + lang + ': ' + e.message + ' (last night\'s for those cards)'); }
  }
  const P = collector.products;
  // Products with a picture, by set + number, category + name + number, category + name
  const byGroupNo = new Map(), byNameNo = new Map(), byName = new Map();
  for (const [id, p] of P) {
    if (!(p.ic > 0)) continue;
    const b = baseName(p.name);
    if (p.no) {
      const k1 = p.g + '|' + p.no;
      if (!byGroupNo.has(k1)) byGroupNo.set(k1, []);
      byGroupNo.get(k1).push([b, id]);
      const k2 = p.cat + '|' + b + '|' + p.no;
      if (!byNameNo.has(k2)) byNameNo.set(k2, id);
    }
    const k3 = p.cat + '|' + b;
    if (!byName.has(k3)) byName.set(k3, id);
  }
  const twin = (p, card) => {
    const b = baseName(p.name);
    const same = p.no && (byGroupNo.get(p.g + '|' + p.no) || []).find((x) => x[0] === b);
    if (same) return same[1];
    if (p.no && byNameNo.has(p.cat + '|' + b + '|' + p.no)) return byNameNo.get(p.cat + '|' + b + '|' + p.no);
    // Magic and Yu-Gi-Oh!: a card's name is the card (Pokémon has many cards of one name)
    if (p.cat !== 3 && p.cat !== 85 && byName.has(p.cat + '|' + b)) return byName.get(p.cat + '|' + b);
    // Pokémon Trainer and Energy cards (World Championship decks, trainer kits): any printing of the same name
    if (/trainer|energy/i.test((card && card.k) || '') || /energy$/.test(b)) return byName.get(p.cat + '|' + b) || null;
    return null;
  };

  const stats = {}, ext = {}, sources = pokemonSources(), official = officialSources();
  const stat = (s, k) => { const key = s.game + ' ' + s.lang; stats[key] = stats[key] || { none: 0, twin: 0, outside: 0, left: 0 }; stats[key][k]++; };
  const outside = [];
  for (const s of sets) {
    for (const c of s.cards) {
      if (c.sd) continue;
      const p = c.pr ? P.get(String(c.pr)) : null;
      // From last night when tonight's product list didn't have it
      const prevKnown = c.pr && !p && previous && previous.noPic && previous.noPic[c.id];
      if (p ? p.ic > 0 : (c.pr ? !prevKnown : !!c.img)) continue;
      stat(s, 'none');
      if (c.pr) c.ni = 1;
      const t = p ? twin(p, c) : (prevKnown && prevKnown !== 1 ? prevKnown : null);
      if (t) { c.ip = String(t); c.img = ''; stat(s, 'twin'); continue; }
      c.img = '';
      outside.push([s, c]);
    }
  }
  // Outside sources, a few at a time; cards answered within the week keep last night's answer
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const cutoff = daysAgo(RECHECK_DAYS), cutoffOfficial = daysAgo(RECHECK_OFFICIAL_DAYS);
  let asked = 0;
  const left = {};
  await pool(outside, 4, async ([s, c]) => {
    let prev = prevExt[c.id];
    // Versions 2-3 kept Japanese "thumb" links, many of which don't exist: ask those again
    if (prev && previous.v < 4 && /\/card_images\/thumb\//.test(prev[0])) prev = null;
    const slow = s.game === 'pokemon' && s.lang !== 'en';
    let url = '', at = today, failed = false;
    if (prev && (prev[0] || (sameVersion && prev[1] >= (slow ? cutoffOfficial : cutoff)))) { url = prev[0]; at = prev[1]; }
    else {
      asked++;
      try {
        if (s.game === 'magic' && c.pr) url = await scryfall(c.pr);
        else if (s.game === 'yugioh') url = await ygoprodeck(c.n);
        else if (s.game === 'pokemon') url = (await sources.find(s, c)) || (await official.find(s, c));
      } catch (e) { failed = true; if (prev) { url = prev[0]; at = prev[1]; } }
    }
    // A source that failed tonight: no answer is kept, so tomorrow asks again
    if (!(failed && !prev)) ext[c.id] = [url, at];
    if (url) { c.img = url; stat(s, 'outside'); } else { stat(s, 'left'); left[c.id] = [s.game, s.lang, s.name, c.n, c.no]; }
  });
  const noPic = {};
  for (const s of sets) for (const c of s.cards) if (c.ni) noPic[c.id] = c.ip || 1;
  console.log('Card pictures (' + asked + ' asked outside tonight): ' + Object.keys(stats).sort().map((k) => k + ' ' + stats[k].none + ' missing, ' +
    stats[k].twin + ' from another printing, ' + stats[k].outside + ' from outside, ' + stats[k].left + ' still none').join('; '));
  // left: the cards still without a picture (game, language, set, name, number), for whoever looks next
  return { v: CACHE_VERSION, builtAt: new Date().toISOString(), stats, noPic, ext, left };
}

// The catalog's picture column: '' = the card's own product picture; a product id = that product's; a URL; '-' = none
export function catalogPicture(c) {
  if (c.ip) return c.ip;
  if (c.ni || !c.pr) return c.img || '-';
  return '';
}

export function writePictures(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
