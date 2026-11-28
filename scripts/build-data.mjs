// Builds KMS Collection's card data (out/data/) for every game in GAMES, nightly on GitHub (this repo is public, so
// its Actions minutes are free) and published to Cloudflare Pages (project kms-collection-data). The app
// (nymsworld/kms-collection, private) reads it from there.
//
//   sets.json              every set of every game: key, game, name, language, era, date, card count; `moved`: card
//                          IDs and set keys joined into others ({ cards: {old: kept}, sets: {oldKey: newKey} })
//   sets/<key>.json        one set's cards and sealed products, with pictures, prices and condition prices
//   catalog-<game>.json    every card of a game in a compact table (search, folder rules, the card camera);
//                          catalog.json = Pokémon's, for app builds from before games were added
//   pricing.json           KMS's price rules (Card.api price_rules.json) and when condition prices were fetched
//   artists.json           the illustrator of each card, kept so a night the card API is down keeps last night's
//   pictures.json          pictures for cards TCGplayer has none for, and what outside sources answered (scripts/images.mjs)
//
// Usage: node scripts/build-data.mjs [--card-api <folder or URL>] [--out out/data] [--previous <URL>] [--games a,b]
//   --card-api defaults to Card.api on GitHub; a local folder (../Card.api) is faster for testing.
//   --games: only these games (e.g. --games pokemon for a quick test).
//
// Sources (all public, allowed): Card.api (Pokémon prices, set names, pictures, condition prices, KMS price rules,
// the Magic cards and sealed KMS lists), the card API Card.api uses (api.carddex.dev: Pokémon artists, English
// release dates and eras), tcgcsv.com (TCGplayer's sets, products and market prices for the other games, and set
// release dates; its own rule: a User-Agent and no hammering, so a few requests at a time).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { productCollector, addCardPictures, catalogPicture, writePictures } from './images.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const CARD_API = opt('--card-api', 'https://raw.githubusercontent.com/nymsworld/Card.api/main');
const OUT = path.resolve(ROOT, opt('--out', 'out/data'));
const PREVIOUS = opt('--previous', 'https://kms-collection-data.pages.dev');
const ONLY = opt('--games', null) ? opt('--games').split(',') : null;
const CARDDEX = 'https://api.carddex.dev/compat/pokemontcg/v2';
const TCGCSV = 'https://tcgcsv.com/tcgplayer';
const UA = { 'User-Agent': 'kms-collection-data-build' };

// The games. source 'card-api' = Card.api's prices.json (Pokémon, priced by the KMS pipeline); 'tcgcsv' = TCGplayer's
// whole catalog for that category from tcgcsv.com. To add One Piece or Lorcana, set `on: true` (owner's plan).
const GAMES = [
  { id: 'pokemon', name: 'Pokémon', source: 'card-api', on: true },
  { id: 'magic', name: 'Magic: The Gathering', source: 'tcgcsv', category: 1, prefix: 'mtg', on: true, cardApiFile: 'prices_magic.json' },
  { id: 'yugioh', name: 'Yu-Gi-Oh!', source: 'tcgcsv', category: 2, prefix: 'ygo', on: true, cardApiFile: 'prices_yugioh.json' },
  { id: 'onepiece', name: 'One Piece', source: 'tcgcsv', category: 68, prefix: 'op', on: false },
  { id: 'lorcana', name: 'Disney Lorcana', source: 'tcgcsv', category: 71, prefix: 'lor', on: false }
];
const MAGIC_RARITY = { M: 'Mythic', R: 'Rare', U: 'Uncommon', C: 'Common', L: 'Land', S: 'Special', T: 'Token', P: 'Promo' };

async function getText(url, timeoutMs = 120000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: UA });
  if (!res.ok) throw new Error(url + ' answered ' + res.status);
  return res.text();
}
async function getJson(url, tries = 4) {
  for (let i = 0; ; i++) {
    try { return JSON.parse(await getText(url, 60000)); }
    catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 4000 * (i + 1))); }
  }
}
async function cardApiFile(name, fallback) {
  try {
    if (/^https?:/.test(CARD_API)) return JSON.parse(await getText(CARD_API + '/' + name + '?v=' + Date.now()));
    return JSON.parse(fs.readFileSync(path.join(CARD_API, name), 'utf8'));
  } catch (e) {
    if (fallback !== undefined) { console.warn('  ' + name + ': ' + e.message + ' (skipped)'); return fallback; }
    throw e;
  }
}
function norm(s) { return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ''); }
function numKey(n) { return String(n || '').replace(/^0+(?=\d)/, '').toLowerCase(); }
function slug(s) { return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'set'; }
// A few requests at a time (tcgcsv's rule: be gentle)
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---- Pokémon (Card.api) ----
const LANGS = [
  [/^Pokémon$/, 'en'], [/\(Japanese\)/, 'ja'], [/\(Traditional Chinese\)/, 'zh-tw'],
  [/\(Simplified Chinese\)/, 'zh-cn'], [/\(Korean\)/, 'ko']
];
function pokemonLang(card) {
  const game = card.game || 'Pokémon';
  if (!/^Pokémon/.test(game)) return null;
  for (const [re, code] of LANGS) if (re.test(game)) return code;
  return null;
}
// Eras, from a set code (TCGplayer's "SV01: …" prefix, a Japanese "M6a", a Chinese setCode). English sets get
// their era from the card API when it answers; this is the fallback and the only source for other languages.
// Case matters (owner's report, Nov 2026: misc products showed under Mega Evolution): Japanese Sword & Shield decks
// are "sA"…"sP" (Chinese "SN", "SLD"… are told apart by date, see pokemonEra), "MCAP" (Miscellaneous Cards &
// Products) and "MG" (2013's Mewtwo vs Genesect kit) aren't Mega Evolution, "SAMPLE" (e-Reader) isn't Sword & Shield.
const ERAS = [
  [/^(ME\d*[a-z]?|MEP|MEE|MEM|MEZ|M\d+[a-z]?|m\d[A-Z]|MBG|MBD|MC|MF|MP\d*|mG|M-P)$/, 'Mega Evolution'],
  [/^(SV|SVP|sv)/i, 'Scarlet & Violet'],
  [/^(SM|SMP)/i, 'Sun & Moon'], [/^(SWSH\d*|S\d+[a-zA-Z]*|S-P|SP\d+|s[A-Z][A-Za-z]?|S[A-Z]{1,2}|SC\d[A-Za-z]?)$/, 'Sword & Shield'],
  [/^(XY|CP\d)/i, 'XY'],
  [/^(BW|BKW|EBB)/i, 'Black & White'], [/^(HGSS|HS|L\d|LL|L-P)/i, 'HeartGold & SoulSilver'], [/^(PL|Pt|DPt)/, 'Platinum'],
  [/^(DP)/i, 'Diamond & Pearl'], [/^(PCG|ADV|EX)/, 'EX'], [/^(E\d|e\d)/, 'E-Card']
];
function eraOf(code) { for (const [re, era] of ERAS) if (re.test(code || '')) return era; return null; }
// When each era began (its first product), English and Japanese (the Chinese and Korean sets carry Japanese dates):
// a set with a date and no era from its code is in the era of its date, and a code's era that is years off its date
// (Japanese "SI" Southern Island 1999, "SC" Shiny Collection 2013) gives way to the date's
const ERA_STARTS = {
  en: [['2025-09-26', 'Mega Evolution'], ['2023-03-31', 'Scarlet & Violet'], ['2019-11-15', 'Sword & Shield'],
    ['2017-02-03', 'Sun & Moon'], ['2013-10-12', 'XY'], ['2011-04-25', 'Black & White'], ['2010-02-10', 'HeartGold & SoulSilver'],
    ['2009-02-11', 'Platinum'], ['2007-05-01', 'Diamond & Pearl'], ['2003-07-01', 'EX'], ['2002-09-15', 'E-Card'],
    ['2000-12-16', 'Neo'], ['2000-08-14', 'Gym'], ['1999-01-01', 'Base']],
  ja: [['2025-08-01', 'Mega Evolution'], ['2023-01-01', 'Scarlet & Violet'], ['2019-11-01', 'Sword & Shield'],
    ['2016-12-01', 'Sun & Moon'], ['2013-11-01', 'XY'], ['2010-12-01', 'Black & White'], ['2009-07-10', 'HeartGold & SoulSilver'],
    ['2008-09-01', 'Platinum'], ['2006-09-01', 'Diamond & Pearl'], ['2003-01-01', 'EX'], ['2001-12-01', 'E-Card'],
    ['2000-02-01', 'Neo'], ['1996-01-01', 'Base']]
};
function eraOfDate(date, lang) {
  if (!date) return null;
  const hit = ERA_STARTS[lang === 'en' ? 'en' : 'ja'].find(([from]) => date >= from);
  return hit ? hit[1] : null;
}
// Is this date within an era's years (from a quarter before it began to a year after the next began)?
function dateFitsEra(date, era, lang) {
  if (!date) return true;
  const list = ERA_STARTS[lang === 'en' ? 'en' : 'ja'], i = list.findIndex(([, e]) => e === era);
  if (i < 0) return true;
  const from = new Date(list[i][0]); from.setMonth(from.getMonth() - 3);
  const to = i > 0 ? new Date(list[i - 1][0]) : null; if (to) to.setFullYear(to.getFullYear() + 1);
  const d = new Date(date);
  return d >= from && (!to || d < to);
}
function codeOf(groupName) { const m = /^([A-Za-z0-9.-]{1,12}):\s/.exec(groupName || ''); return m ? m[1] : null; }
function stripCode(groupName) { return String(groupName || '').replace(/^[A-Za-z0-9.-]{1,12}:\s*/, ''); }

async function tcgcsvGroups(category) {
  try { return (await getJson(TCGCSV + '/' + category + '/groups')).results || []; }
  catch (e) { console.warn('  tcgcsv groups ' + category + ': ' + e.message); return []; }
}

// Every English Pokémon card's artist from the card API (~20,000 cards, 250 a page, slowly: its rate limit)
async function carddexArtists() {
  const out = { byId: {}, bySetNumber: {}, sets: {} };
  try {
    const sets = JSON.parse(await getText(CARDDEX + '/sets?pageSize=250', 60000)).data || [];
    sets.forEach((s) => { out.sets[norm(s.name)] = { date: (s.releaseDate || '').replace(/\//g, '-'), series: s.series || null }; });
    for (let page = 1; page < 400; page++) {
      // Its rate limit answers 429 now and then: wait longer and ask again; if it never answers, the pages already
      // read are kept (the previous build fills in the rest)
      let data = null;
      for (let tries = 0; !data; tries++) {
        try { data = JSON.parse(await getText(CARDDEX + '/cards?page=' + page + '&pageSize=250&select=id,number,artist,set', 60000)); }
        catch (e) {
          if (tries >= 5) { console.warn('  card API: stopped at page ' + page + ': ' + e.message); break; }
          await new Promise((r) => setTimeout(r, 15000 * (tries + 1)));
        }
      }
      if (!data) break;
      const cards = data.data || [];
      cards.forEach((c) => {
        if (!c.artist) return;
        out.byId[c.id] = c.artist;
        out.bySetNumber[norm(c.set && c.set.name) + '|' + numKey(c.number)] = c.artist;
      });
      if (!cards.length || page * 250 >= (data.totalCount || 0)) break;
      await new Promise((r) => setTimeout(r, 1500));   // = REQUEST_DELAY in Card.api's update_prices.py
    }
    console.log('  card API: ' + Object.keys(out.byId).length + ' artists, ' + Object.keys(out.sets).length + ' sets');
    return out;
  } catch (e) {
    console.warn('  card API: ' + e.message + ' (artists from the previous build)');
    return Object.keys(out.sets).length || Object.keys(out.byId).length ? out : null;
  }
}
async function previousArtists() {
  try { return JSON.parse(await getText(PREVIOUS + '/data/artists.json', 60000)); } catch (e) { return {}; }
}

// ---- Set pictures (owner's request, Nov 2026: a card picture said little about a set) ----
// Each set's `img` and its kind `ik`: 'logo' (English Pokémon: pokemontcg.io's set logos), 'symbol' (Magic:
// Scryfall's set symbols, black SVGs), 'art' (Yu-Gi-Oh!: YGOPRODeck's set pictures), 'pack' (the set's own booster
// pack / box from TCGplayer, for everything else with one), or 'card' (a card, the last resort). A source that
// doesn't answer keeps last night's picture for the sets it covered.
const SET_PICTURES = {};   // filled by setPictureSources()
let PTCG_SETS = {};        // pokemontcg.io's English sets by name: { date, series }
let PREV_SETS = {};        // last night's English Pokémon sets by name: { date, series }
let PREV_BUILD = { keys: {}, moved: null };   // last night's Pokémon set keys by lang|name, and its `moved`
// Card IDs and set keys this build no longer has because their card or set was joined to another (sets.json `moved`:
// { cards: { oldId: keptId }, sets: { oldKey: newKey } }), so the app can find a copy saved under the old ID
const MOVED = { cards: {}, sets: [] };
async function setPictureSources() {
  const [ptcg, scry, ygo, prev] = await Promise.all([
    // pokemontcg.io's data repo on GitHub (newer than its API, which answered 500 from Actions, and its logos are
    // ~20 KB on images.scrydex.com against ~200 KB); the API if GitHub doesn't answer
    getText('https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master/sets/en.json', 60000).then((t) => JSON.parse(t))
      .catch((e) => {
        console.warn('  pokemontcg.io data repo: ' + e.message);
        return getJson('https://api.pokemontcg.io/v2/sets?pageSize=250&select=id,name,images', 2).then((d) => d.data || []);
      }).catch((e) => { console.warn('  pokemontcg.io sets: ' + e.message); return null; }),
    getText('https://api.scryfall.com/sets', 60000).then((t) => JSON.parse(t).data || []).catch((e) => { console.warn('  Scryfall sets: ' + e.message); return null; }),
    getText('https://db.ygoprodeck.com/api/v7/cardsets.php', 60000).then((t) => JSON.parse(t)).catch((e) => { console.warn('  YGOPRODeck sets: ' + e.message); return null; }),
    getText(PREVIOUS + '/data/sets.json', 60000).then((t) => { const d = JSON.parse(t); PREV_BUILD.moved = d.moved || null; return d.sets || []; }).catch(() => [])
  ]);
  SET_PICTURES.ptcg = ptcg && { byId: {}, byName: {} };
  // Its release dates and series too: the English sets' dates and eras on a night the card API doesn't answer
  PTCG_SETS = {};
  (ptcg || []).forEach((s) => {
    PTCG_SETS[norm(s.name)] = { date: (s.releaseDate || '').replace(/\//g, '-'), series: s.series || null };
    if (!s.images || !s.images.logo) return;
    SET_PICTURES.ptcg.byId[s.id] = s.images.logo;
    SET_PICTURES.ptcg.byName[setNameKey(s.name)] = s.images.logo;
  });
  SET_PICTURES.scry = scry && { byGroup: {}, byName: {} };
  (scry || []).forEach((s) => {
    if (!s.icon_svg_uri) return;
    const icon = s.icon_svg_uri.replace(/\?.*$/, '');
    if (s.tcgplayer_id) SET_PICTURES.scry.byGroup[s.tcgplayer_id] = icon;
    SET_PICTURES.scry.byName[setNameKey(s.name)] = SET_PICTURES.scry.byName[setNameKey(s.name)] || icon;
  });
  SET_PICTURES.ygo = ygo && {};
  (ygo || []).forEach((s) => { if (s.set_image) SET_PICTURES.ygo[setNameKey(s.set_name)] = s.set_image; });
  SET_PICTURES.prev = {};
  // Last night's English Pokémon dates and eras: the last resort when neither the card API nor pokemontcg.io answers
  PREV_SETS = {};
  prev.forEach((s) => { if (s.game === 'pokemon' && s.lang === 'en' && s.date && s.series) PREV_SETS[norm(s.name)] = { date: s.date, series: s.series }; });
  prev.forEach((s) => { if (s.game === 'pokemon') PREV_BUILD.keys[s.lang + '|' + s.name] = s.k; });
  prev.forEach((s) => { if (s.ik && s.ik !== 'card' && s.ik !== 'pack') SET_PICTURES.prev[s.k] = { img: s.img, ik: s.ik }; });
  console.log('Set pictures: ' + (ptcg ? Object.keys(SET_PICTURES.ptcg.byId).length : 'no') + ' Pokémon logos, ' +
    (scry ? Object.keys(SET_PICTURES.scry.byGroup).length : 'no') + ' Magic symbols, ' + (ygo ? Object.keys(SET_PICTURES.ygo).length : 'no') + ' Yu-Gi-Oh! sets');
}
function setNameKey(name) { return norm(String(name || '').replace(/&/g, ' and ')); }
// Our English Pokémon set names (TCGplayer's / the card API's) that pokemontcg.io names differently
const PTCG_ALIASES = {
  'sm base set': 'sm1', 'base set (shadowless)': 'base1', 'expedition': 'ecard1', 'wotc promo': 'basep',
  'sm promos': 'smp', 'xy promos': 'xyp', 'black and white promos': 'bwp', 'diamond and pearl promos': 'dpp',
  'hgss promos': 'hsp', 'sword & shield promo cards': 'swshp', 'nintendo promos': 'np', 'best of promos': 'bp',
  'classic collection': 'cel25c', 'scarlet & violet 151': 'sv3pt5', "mcdonald's 25th anniversary promos": 'mcd21', 'generations: radiant collection': 'g1', 'legendary treasures: radiant collection': 'bw11'
};
function pokemonLogo(s) {
  const p = SET_PICTURES.ptcg;
  if (!p) return null;
  // Most cards from the card API keep its IDs ("sv1-9"): the set they point to most
  const votes = {};
  s.cards.forEach((c) => { const m = /^([a-z0-9]+)-/i.exec(c.id); if (m && p.byId[m[1]]) votes[m[1]] = (votes[m[1]] || 0) + 1; });
  const top = Object.keys(votes).sort((a, b) => votes[b] - votes[a])[0];
  if (top) return p.byId[top];
  const alias = PTCG_ALIASES[s.name.toLowerCase()];
  if (alias && p.byId[alias]) return p.byId[alias];
  // By name, also without "EX " / "SM - " / "XY - " in front or "Base Set" at the end
  const names = [s.name, s.name.replace(/^(EX|SM|XY|SWSH|SV|ME)\s*-?\s+/, ''), s.name.replace(/\s+Base Set$/, ''), s.name + ' Base Set'];
  for (const n of names) { const hit = p.byName[setNameKey(n)]; if (hit) return hit; }
  return null;
}
// Scryfall's symbol by TCGplayer group; "Art Series: X" / "Promo Pack: X" and the like use X's
function magicSymbol(s) {
  const p = SET_PICTURES.scry;
  if (!p) return null;
  if (p.byGroup[s.groupId]) return p.byGroup[s.groupId];
  const names = [s.name, s.name.replace(/^[^:]+:\s*/, ''), s.name.replace(/\s*\(.*\)$/, '')];
  for (const n of names) { const hit = p.byName[setNameKey(n)]; if (hit) return hit; }
  return null;
}
// The set's own booster pack, else its booster box, else any sealed product: TCGplayer's product picture
function packPicture(cards) {
  const sealed = cards.filter((c) => c.sd && c.pr);
  const pick = sealed.find((c) => /booster pack/i.test(c.n) && !/(display|case|bundle|art|set of|\[)/i.test(c.n)) ||
    sealed.find((c) => /booster pack/i.test(c.n)) || sealed.find((c) => /booster box/i.test(c.n) && !/case/i.test(c.n)) ||
    sealed.find((c) => /booster/i.test(c.n));
  return pick ? 'https://tcgplayer-cdn.tcgplayer.com/product/' + pick.pr + '_200w.jpg' : null;
}
function cardPicture(cards) {
  const c = cards.find((x) => x.pr && !x.sd) || cards.find((x) => x.pr) || cards.find((x) => x.img);
  if (!c) return '';
  return c.pr ? 'https://tcgplayer-cdn.tcgplayer.com/product/' + c.pr + '_200w.jpg' : c.img;
}
function setPicture(s, key) {
  let img = null, ik = null;
  if (s.game === 'pokemon' && s.lang === 'en') { img = pokemonLogo(s); ik = 'logo'; }
  else if (s.game === 'magic') { img = magicSymbol(s); ik = 'symbol'; }
  else if (s.game === 'yugioh') { img = SET_PICTURES.ygo ? SET_PICTURES.ygo[setNameKey(s.name)] : null; ik = 'art'; }
  // Its source didn't answer tonight: last night's
  const sourceDown = (ik === 'logo' && !SET_PICTURES.ptcg) || (ik === 'symbol' && !SET_PICTURES.scry) || (ik === 'art' && !SET_PICTURES.ygo);
  if (!img && sourceDown && SET_PICTURES.prev && SET_PICTURES.prev[key]) return SET_PICTURES.prev[key];
  if (img) return { img, ik };
  img = packPicture(s.cards);
  return img ? { img, ik: 'pack' } : { img: cardPicture(s.cards), ik: 'card' };
}

// A card from a Card.api entry, in the set files' short field names
function fromCardApi(id, c, staff, condMarket) {
  const product = (/product\/(\d+)/.exec(c.tcgUrl || '') || [])[1] || null;
  const card = {
    id, n: c.name, no: c.number || '', t: c.printedTotal || '', r: c.rarity || '', img: c.image || '',
    m: typeof c.rawMarket === 'number' ? c.rawMarket : null, p: typeof c.price === 'number' ? c.price : null
  };
  if (c.localName) card.ln = c.localName;
  if (c.kind) card.k = c.kind;
  if (product) card.pr = product;
  if (c.conditionPricing || c.overnumbered) card.cp = 1;
  if (c.overnumbered) card.ov = 1;
  if (c.group === 'jumbo') card.jb = 1;
  if (c.sealed) { card.sd = 1; card.r = 'Sealed Product'; }
  if (c.marketAt) card.ma = c.marketAt;
  if (condMarket && condMarket[id]) card.cm = condMarket[id];
  // Staff prices without who set them (a staff member's name stays with the shop)
  if (staff && staff[id]) { const s2 = Object.assign({}, staff[id]); delete s2.by; card.sp = s2; }
  return card;
}

async function pokemon(ctx) {
  const prices = await cardApiFile('prices.json');
  const [groupsEn, groupsJa, api, prev] = await Promise.all([tcgcsvGroups(3), tcgcsvGroups(85), carddexArtists(), previousArtists()]);
  const groupInfo = { en: {}, ja: {} };
  const relisted = new Date(Date.now() - 180 * 864e5).toISOString().slice(0, 10);
  [[groupsEn, 'en'], [groupsJa, 'ja']].forEach(([groups, lang]) => groups.forEach((g) => {
    // Only real sets (named "CODE: Name") keep TCGplayer's date: English promo and miscellaneous groups get dates of
    // whenever TCGplayer last re-listed them (Burger King Promos showed as this week). Japanese groups without a
    // code ("Rulers of the Heavens", the old decks) do carry their release date, unless they were re-listed lately.
    const code = codeOf(g.name), published = (g.publishedOn || '').slice(0, 10);
    const date = code || (lang === 'ja' && published && published < relisted) ? published || null : null;
    const info = { date, code: code || g.abbreviation || null };
    groupInfo[lang][norm(g.name)] = info;
    groupInfo[lang][norm(stripCode(g.name))] = groupInfo[lang][norm(stripCode(g.name))] || info;
    // Card.api's name is sometimes the part after a colon ("Aura's Lucario" for "Movie Commemoration VS Pack:
    // Aura's Lucario", "Two Ambitions" for "Magma VS Aqua: Two Ambitions")
    const tail = norm(String(g.name).split(': ').pop());
    if (lang === 'ja') groupInfo[lang][tail] = groupInfo[lang][tail] || info;
  }));
  const sets = new Map();
  for (const id in prices) {
    const c = prices[id];
    if (!c || c.bulk) continue;
    const lang = pokemonLang(c);
    if (!lang) continue;
    const setName = c.setName || 'Unknown set';
    const key = lang + '|' + setName;
    if (!sets.has(key)) sets.set(key, { game: 'pokemon', lang, name: setName, cards: [], codes: {} });
    const s = sets.get(key);
    if (c.setCode) s.codes[c.setCode] = (s.codes[c.setCode] || 0) + 1;
    const card = fromCardApi(id, c, ctx.staff, ctx.condMarket);
    let artist = c.artist || null;
    if (!artist && lang === 'en' && api) artist = api.byId[id] || api.bySetNumber[norm(setName) + '|' + numKey(c.number)] || null;
    if (!artist) artist = prev[id] || null;
    if (artist) { card.a = artist; ctx.artists[id] = artist; }
    s.cards.push(card);
  }
  for (const s of sets.values()) {
    s.keyBase = s.lang + '-' + slug(s.name);   // Pokémon keys stay as before games were added (saved folders use them)
    const topCode = Object.keys(s.codes).sort((a, b) => s.codes[b] - s.codes[a])[0] || null;
    const g = groupInfo[s.lang === 'en' ? 'en' : 'ja'][norm(s.name)] || null;
    // The card API's set (pokemontcg.io's, else last night's, when the card API didn't answer tonight)
    const a = s.lang === 'en' ? (api && api.sets[norm(s.name)]) || PTCG_SETS[norm(s.name)] || PREV_SETS[norm(s.name)] || null : null;
    s.date = (a && a.date) || (g && g.date) || null;
    s.apiSeries = (a && a.series) || null;
    s.code = topCode || (g && g.code) || null;
    s.groupCode = (g && g.code) || null;
  }
  let list = mergeNamedTwice(mergeSplitSets(mergeSameName([...sets.values()])));
  list = attachSubsets(list);
  list.forEach((s) => { s.series = pokemonEra(s); dropPatternReverses(s); dropSameProduct(s); });
  return list;
}

// ---- Pokémon set clean-up (owner's report, Nov 2026: "Promos, decks & more" held pieces of sets from every era,
// promos were split in several lists, misc products showed under Mega Evolution, Ascended Heroes listed cards twice) ----

// A set's era: English sets the card API's series (its few odd ones mapped to the eras), McDonald's promos their
// year's, else the era its name or code says, else its date's; other languages the era of their name, code or date.
const API_SERIES = { 'Call of Legends': 'HeartGold & SoulSilver', 'HGSS': 'HeartGold & SoulSilver', 'NP': 'POP',
  'Trainer kits': null, "McDonald's Collection": null, 'Other': null };
const NAME_ERAS = [
  [/^(ME|MEP|Mega Evolution)\b/, 'Mega Evolution'], [/^(SV|SVP|SV-P|Scarlet & Violet)\b/, 'Scarlet & Violet'],
  [/^(SWSH|S-P|Sword & Shield)\b/, 'Sword & Shield'], [/^(SM|SM-P|Sun & Moon)\b/, 'Sun & Moon'], [/^(XY|XY-P)\b/, 'XY'],
  [/^(BW|BW-P|Black (&|and) White)\b/, 'Black & White'], [/^(HGSS|HS|L-P|LEGEND)\b/, 'HeartGold & SoulSilver'],
  [/^(DPt|DPt-P|Platinum)\b/, 'Platinum'], [/^(DP|DP-P|Diamond (&|and) Pearl)\b/, 'Diamond & Pearl'],
  [/^(EX|ADV|ADV-P|PCG|PCG-P)\b/, 'EX']
];
function nameEra(name) {
  const n = String(name || '').replace(/ Era Unnumbered Energies$/, '');
  for (const [re, era] of NAME_ERAS) if (re.test(n)) return era;
  return null;
}
function pokemonEra(s) {
  const mcd = mcdonaldsEra(s.name);
  if (mcd) return mcd;
  if (s.lang === 'en') {
    if (s.apiSeries && API_SERIES[s.apiSeries] !== null) return API_SERIES[s.apiSeries] || s.apiSeries;
    // English codes without a digit are mostly TCGplayer's abbreviations ("SEA", "MCAP"), not era codes
    const code = s.code && (/\d/.test(s.code) || /^(SVE|SVP|SMP|MEE|MEP|SWSH|XY)$/.test(s.code)) ? eraOf(s.code) : null;
    return nameEra(s.name) || (code && dateFitsEra(s.date, code, 'en') ? code : null) || eraOfDate(s.date, 'en');
  }
  // Japanese sets TCGplayer re-listed lately (so no date): their era by name
  if (s.lang === 'ja' && /^Vending Machine cards Series/.test(s.name)) return 'Base';
  if (s.lang === 'ja' && s.name === 'Champion Road') return 'Sun & Moon';
  const byName = / Era Unnumbered Energies$|^[A-Za-z]+-P /.test(s.name) || /^(Sun & Moon|Scarlet & Violet|Sword & Shield|XY|Black & White)$/.test(s.name)
    ? nameEra(s.name) : null;
  if (byName) return byName;
  const byCode = [s.code, s.groupCode].map(eraOf).find((e) => e && dateFitsEra(s.date, e, s.lang));
  return byCode || eraOfDate(s.date, s.lang);
}

// One English set Card.api lists under two names, the card API's (dated, with its era) and TCGplayer's (undated):
// "Sun & Moon" / "SM Base Set", "Power Keepers" / "EX Power Keepers", "Burning Shadows" / "SM - Burning Shadows",
// "SVP Black Star Promos" / "SV Black Star Promos", "Macdonald's Collection 2019" / "McDonald's Promos 2019", the card
// API's trainer kit halves / TCGplayer's kits. The name on the right is the one shown.
const EN_SAME_SET = {
  'SM Base Set': 'Sun & Moon', 'XY Base Set': 'XY', 'Black and White': 'Black & White', 'Diamond and Pearl': 'Diamond & Pearl',
  'Expedition': 'Expedition Base Set',
  'SVP Black Star Promos': 'SV Black Star Promos', 'MEP Black Star Promos': 'ME Black Star Promos', 'Mega Evolution Promo': 'ME Black Star Promos',
  'Sword & Shield Promo Cards': 'SWSH Black Star Promos', 'SM Promos': 'SM Black Star Promos', 'XY Promos': 'XY Black Star Promos',
  'Black and White Promos': 'BW Black Star Promos', 'Diamond and Pearl Promos': 'DP Black Star Promos',
  'WoTC Promo': 'Wizards Black Star Promos', 'Nintendo Promos': 'Nintendo Black Star Promos', 'Best of game': 'Best of Promos',
  'Classic Collection': 'Celebrations: Classic Collection', 'Radiant Collection': 'Legendary Treasures: Radiant Collection',
  'SM trainer Kit (Alolan Raichu)': 'SM Trainer Kit: Lycanroc & Alolan Raichu', 'SM trainer Kit (Lycanroc)': 'SM Trainer Kit: Lycanroc & Alolan Raichu',
  'BW trainer Kit (Zoroark)': 'BW Trainer Kit: Excadrill & Zoroark', 'HS trainer Kit (Gyarados)': 'HGSS Trainer Kit: Gyarados & Raichu',
  'DP trainer Kit (Lucario)': 'DP Trainer Kit: Manaphy & Lucario', 'DP trainer Kit (Manaphy)': 'DP Trainer Kit: Manaphy & Lucario',
  'EX trainer Kit 2 (Minun)': 'EX Trainer Kit 2: Plusle & Minun', 'EX trainer Kit 2 (Plusle)': 'EX Trainer Kit 2: Plusle & Minun',
  'EX trainer Kit (Latias)': 'EX Trainer Kit 1: Latias & Latios', 'EX trainer Kit (Latios)': 'EX Trainer Kit 1: Latias & Latios'
};
function sameSetAs(s, byName) {
  if (s.lang === 'en') {
    if (EN_SAME_SET[s.name]) return [EN_SAME_SET[s.name]];
    // "Macdonald's Collection 2019" → "McDonald's Promos 2019" (2021: the 25th Anniversary promos)
    const mcd = /^Macdonald's Collection (\d{4})$/i.exec(s.name);
    if (mcd) return [mcd[1] === '2021' ? "McDonald's 25th Anniversary Promos" : "McDonald's Promos " + mcd[1]];
    // "XY - Fates Collide", "SM - Burning Shadows" → the card API's name; "EX Power Keepers" (the EX sets' own names)
    // and the card API's "Power Keepers" → "EX Power Keepers"
    const bare = s.name.replace(/^(EX|XY|SM|SWSH|SV|ME)\s+-\s+/, '').replace(/^EX\s+/, '').replace(/ and /g, ' & ');
    if (bare === s.name || !byName.has(s.lang + '|' + bare)) return null;
    return /^EX\s/.test(s.name) ? [s.name.replace(/ and /g, ' & '), bare] : [bare];
  }
  // "M-P Promotional Cards" (its sealed products) and "M-P Promos" (its cards)
  const promo = /^([A-Za-z]+-P) Promotional Cards$/i.exec(s.name);
  if (promo && byName.has(s.lang + '|' + promo[1] + ' Promos')) return [promo[1] + ' Promos'];
  return null;
}
// The other languages: a set Card.api names in Chinese with only a few cards ("初階牌組100", 8 cards) next to the same
// set under its English name ("Start Deck 100"): same language, code and printed total → the English one
function localNameTwin(s, list) {
  if (s.lang === 'en' || s.date || !s.code || !/[^\x00-\x7f]/.test(s.name)) return null;
  const t = setTotal(s);
  const twins = list.filter((o) => o !== s && o.lang === s.lang && o.code === s.code && o.date && !/[^\x00-\x7f]/.test(o.name) && setTotal(o) === t);
  return twins.length === 1 ? twins[0] : null;
}
function setTotal(s) {
  const n = {};
  s.cards.forEach((c) => { const t = String(c.t || ''); if (t) n[t] = (n[t] || 0) + 1; });
  return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || null;
}
const printingOf = (id) => (String(id).match(/-(reverse|1st-edition[\w-]*|non-holo|holo|staff)$/) || [])[1] || 'base';
// Joins `parts` into one set named `name`: the key of the part with the most cards, the date and card API series of
// whichever part has them. A card already there isn't added twice: same ID, or the same TCGplayer product, printing
// and number, or (cards without a product, the card API's) the same number and printing with the same name in front
// ("Hau" / "Hau (#19) (Lycanroc Half-Deck)"). The IDs left out are listed in the build log.
function joinSets(parts, name) {
  parts.sort((a, b) => b.cards.length - a.cards.length);
  const big = parts[0];
  const ids = new Set(big.cards.map((c) => c.id));
  const byProduct = new Map(big.cards.filter((c) => c.pr).map((c) => [c.pr + '|' + printingOf(c.id) + '|' + numKey(c.no), c]));
  // The name without a kit's "(#19)" / "(Lycanroc Half-Deck)"; other tags ("(e-League) [Winner]", "(Target Promo)")
  // are other cards
  const simple = (n) => norm(String(n || '').replace(/\s*\((#\d+|[^()]*Half-Deck)\)/gi, ''));
  const byNumber = new Map(big.cards.map((c) => [numKey(c.no) + '|' + printingOf(c.id) + '|' + simple(c.n), c]));
  const dropped = [];
  for (const small of parts.slice(1)) {
    small.cards.forEach((c) => {
      if (ids.has(c.id)) return;
      const twin = (c.pr && byProduct.get(c.pr + '|' + printingOf(c.id) + '|' + numKey(c.no))) ||
        (!c.pr && c.no && byNumber.get(numKey(c.no) + '|' + printingOf(c.id) + '|' + simple(c.n)));
      if (twin) { dropped.push(c.id); MOVED.cards[c.id] = twin.id; return; }
      big.cards.push(c); ids.add(c.id);
      if (c.pr) byProduct.set(c.pr + '|' + printingOf(c.id) + '|' + numKey(c.no), c);
      byNumber.set(numKey(c.no) + '|' + printingOf(c.id) + '|' + simple(c.n), c);
    });
    Object.keys(small.codes || {}).forEach((code) => { big.codes[code] = (big.codes[code] || 0) + small.codes[code]; });
    console.log('  joined "' + small.name + '" (' + small.lang + ', ' + small.cards.length + ' cards, ' + small.keyBase + ') into "' + name + '" (' + big.keyBase + ')');
  }
  if (dropped.length) console.log('    listed twice, kept once (left out: ' + dropped.join(', ') + ')');
  const dated = parts.filter((p) => p.date).sort((a, b) => a.date.localeCompare(b.date))[0];
  big.name = name;
  big.date = big.date || (dated && dated.date) || null;
  big.apiSeries = big.apiSeries || (parts.find((p) => p.apiSeries) || {}).apiSeries || null;
  big.code = big.code || (parts.find((p) => p.code) || {}).code || null;
  big.groupCode = big.groupCode || (parts.find((p) => p.groupCode) || {}).groupCode || null;
  return big;
}
function mergeNamedTwice(list) {
  const byName = new Map(list.map((s) => [s.lang + '|' + s.name, s]));
  const groups = new Map();   // lang|shown name → its parts
  const add = (name, s) => {
    const k = s.lang + '|' + name;
    if (!groups.has(k)) groups.set(k, new Set(byName.has(k) ? [byName.get(k)] : []));
    groups.get(k).add(s);
  };
  list.forEach((s) => {
    const to = sameSetAs(s, byName);
    if (!to) return;
    add(to[0], s);
    to.slice(1).forEach((n) => add(to[0], byName.get(s.lang + '|' + n)));
  });
  list.forEach((s) => { const twin = localNameTwin(s, list); if (twin) add(twin.name, s); });
  const gone = new Set();
  for (const [k, parts] of groups) {
    const arr = [...parts].filter((p) => !gone.has(p));
    if (arr.length < 2) { if (arr.length === 1) arr[0].name = k.slice(k.indexOf('|') + 1); continue; }
    const oldKeys = arr.map((p) => PREV_BUILD.keys[p.lang + '|' + p.name]).filter(Boolean);
    const big = joinSets(arr, k.slice(k.indexOf('|') + 1));
    arr.forEach((p) => { if (p !== big) gone.add(p); });
    oldKeys.forEach((old) => MOVED.sets.push([old, big]));
  }
  return list.filter((s) => !gone.has(s));
}

// A piece of a set ("Hidden Fates: Shiny Vault", "Legendary Treasures: Radiant Collection", "Base Set (Shadowless)", the
// Japanese "Expansion Pack (No Rarity)"): its set's date (so it's listed next to it) and era. Its own date gives way:
// TCGplayer's "Generations: Radiant Collection" read as code "Generations" dated Legendary Treasures' half 2016.
function attachSubsets(list) {
  list.forEach((s) => {
    const parent = list.filter((p) => p !== s && p.lang === s.lang && p.date && (s.name.startsWith(p.name + ': ') || s.name.startsWith(p.name + ' (')))
      .sort((a, b) => b.name.length - a.name.length)[0];
    if (!parent || (s.date === parent.date && (!parent.apiSeries || s.apiSeries === parent.apiSeries))) return;
    s.date = parent.date;
    s.apiSeries = parent.apiSeries || s.apiSeries;
    s.code = s.code || parent.code;
    console.log('  "' + s.name + '" (' + s.lang + ') dated and placed with "' + parent.name + '"');
  });
  return list;
}

// The same card under two IDs in one set (Card.api has some cards both under the card API's ID and TCGplayer's:
// "swsh10-25" and "tcg-272225", Astral Radiance's Heatran V; "jp-733510" and "tcg-733510", a Japanese M-P promo): same
// TCGplayer product and printing (and number, when both have one) → one card. The one kept: the one with KMS's staff
// price, else a card over a sealed product, else TCGplayer's ID ("tcg-…", as Card.api's newer cards), else the first.
function dropSameProduct(s) {
  const groups = new Map();
  s.cards.forEach((c) => {
    if (!c.pr) return;
    const k = c.pr + '|' + printingOf(c.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  });
  const gone = new Set();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const rank = (c) => (c.sp ? 4 : 0) + (c.sd ? 0 : 2) + (/^tcg-/.test(c.id) ? 1 : 0);
    const keep = g.slice().sort((a, b) => rank(b) - rank(a))[0];
    g.forEach((c) => { if (c !== keep && (!c.no || !keep.no || numKey(c.no) === numKey(keep.no))) { gone.add(c); MOVED.cards[c.id] = keep.id; } });
  }
  if (gone.size) {
    console.log('  ' + s.name + ' (' + s.lang + '): ' + gone.size + ' cards listed twice, kept once (left out: ' + [...gone].map((c) => c.id).join(', ') + ')');
    s.cards = s.cards.filter((c) => !gone.has(c));
  }
}

// Ascended Heroes' Poké Ball / Energy Symbol Pattern cards were listed twice: the pattern card and the same product
// again as "(Reverse Holo)" at the same price (Card.api's cheap-reverse list; TCGplayer sells those products only as
// reverse holo: the pattern is the reverse holo). The pattern card stays, its "-reverse" twin goes.
function dropPatternReverses(s) {
  const byId = new Map(s.cards.map((c) => [c.id, c]));
  const out = s.cards.filter((c) => {
    if (!/-reverse$/.test(c.id)) return true;
    const base = byId.get(c.id.replace(/-reverse$/, ''));
    const twin = base && /\((?:[^()]*\bBall|[^()]*Pattern|Team Rocket|Reverse Holo(?:foil)?)\)\s*$/i.test(base.n);
    if (twin) MOVED.cards[c.id] = base.id;
    return !twin;
  });
  if (out.length < s.cards.length) {
    console.log('  ' + s.name + ' (' + s.lang + '): ' + (s.cards.length - out.length) + ' pattern cards listed twice, kept once (left out: ' +
      s.cards.filter((c) => !out.includes(c)).map((c) => c.id).join(', ') + ')');
    s.cards = out;
  }
}

// McDonald's promos by their year (owner's report, Nov 2026: they all showed under Mega Evolution, because their codes
// "M11"…"M26" look like Mega Evolution's "M1"…). The 25th Anniversary promos were 2021.
const MCD_ERAS = [[2026, 'Mega Evolution'], [2023, 'Scarlet & Violet'], [2020, 'Sword & Shield'], [2017, 'Sun & Moon'],
  [2014, 'XY'], [2011, 'Black & White']];
function mcdonaldsEra(name) {
  if (!/McDonald/i.test(name || '')) return null;
  const y = /25th Anniversary/i.test(name) ? 2021 : +((/\b(20\d\d)\b/.exec(name) || [])[1] || 0);
  const hit = y && MCD_ERAS.find(([from]) => y >= from);
  return hit ? hit[1] : null;
}

// One set listed twice under the same name with and without an accent (owner's report, Nov 2026: TCGplayer's
// "Pokemon GO" and "Pokémon GO" showed as two sets): same language, same date and the same name once accents and
// punctuation are dropped → one set, under the one with more cards (its key wins); a card already there isn't added twice.
function mergeSameName(list) {
  // Letters of every script count ("超夢ex" and "ex初階牌組" aren't the same name), only accents and punctuation don't;
  // a set with no date is never joined
  const nameKey = (n) => String(n || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
  const groups = new Map();
  list.forEach((s) => {
    if (!s.date) return;
    const k = s.lang + '|' + s.date + '|' + nameKey(s.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  });
  const gone = new Set();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => b.cards.length - a.cards.length);
    const big = g[0], have = new Set(big.cards.map((c) => c.id));
    // Shown with its accent ("Pokémon GO") whichever half had it; the key stays the bigger half's
    big.name = g.map((s) => s.name).find((n) => /[^\x00-\x7f]/.test(n)) || big.name;
    g.slice(1).forEach((small) => {
      small.cards.forEach((c) => { if (!have.has(c.id)) { big.cards.push(c); have.add(c.id); } });
      Object.keys(small.codes || {}).forEach((code) => { big.codes[code] = (big.codes[code] || 0) + small.codes[code]; });
      big.apiSeries = big.apiSeries || small.apiSeries; big.groupCode = big.groupCode || small.groupCode;
      big.code = big.code || small.code;
      gone.add(small);
      console.log('  merged "' + small.name + '" (' + small.lang + ', ' + small.cards.length + ' cards) into "' + big.name + '"');
    });
  }
  return list.filter((s) => !gone.has(s));
}

// Card.api names some sets two ways (the card API's "Scarlet & Violet" / "151", TCGplayer's "Scarlet & Violet Base
// Set" / "Scarlet & Violet 151"), each holding part of the set's cards (owner's report, Nov 2026: Scarlet & Violet
// base showed as two sets). Two sets are one when they have the same language and date, one name contains the
// other, and their cards' most common printed total is the same (so "Scarlet & Violet Energies", same day, stays
// apart). The longer (TCGplayer) name and its key win; a card already there (same product and printing) isn't added twice.
function mergeSplitSets(list) {
  const total = (s) => {
    const n = {};
    s.cards.forEach((c) => { const t = String(c.t || ''); if (t) n[t] = (n[t] || 0) + 1; });
    return Object.keys(n).sort((a, b) => n[b] - n[a])[0] || null;
  };
  const kind = (id) => (String(id).match(/-(reverse|1st-edition[\w-]*|non-holo|holo)$/) || [])[1] || 'base';
  const gone = new Set();
  const bySize = list.slice().sort((a, b) => a.name.length - b.name.length);
  for (const small of bySize) {
    if (!small.date || gone.has(small)) continue;
    const t = total(small), n = norm(small.name);
    if (!t) continue;
    const into = list.filter((big) => big !== small && !gone.has(big) && big.lang === small.lang && big.date === small.date &&
      big.name.length > small.name.length && norm(big.name).includes(n) && total(big) === t);
    if (into.length !== 1) continue;
    const big = into[0];
    const have = new Set(big.cards.map((c) => (c.pr || c.id) + '|' + kind(c.id)));
    small.cards.forEach((c) => { if (!have.has((c.pr || c.id) + '|' + kind(c.id))) big.cards.push(c); });
    big.code = big.code || small.code;
    big.apiSeries = big.apiSeries || small.apiSeries; big.groupCode = big.groupCode || small.groupCode;
    gone.add(small);
    console.log('  merged "' + small.name + '" (' + small.lang + ') into "' + big.name + '"');
  }
  return list.filter((s) => !gone.has(s));
}

// ---- Other games (tcgcsv) ----
// IDs as Card.api names them (so KMS's own entries and staff prices line up): tcg-<product> for the normal printing,
// -foil for Magic's Foil, -1st-edition for 1st Edition, any other printing -<its name>
function printingSuffix(sub) {
  const s = String(sub || '').trim().toLowerCase();
  if (!s || s === 'normal' || s === 'unlimited' || s === 'limited' || s === 'holofoil') return '';
  if (s === 'foil') return '-foil';
  if (/1st/.test(s)) return '-1st-edition';
  return '-' + slug(s);
}
function ext(p, ...names) {
  const e = (p.extendedData || []).find((x) => names.includes(x.name));
  return e ? String(e.value || '').replace(/<[^>]*>/g, '').trim() : '';
}

async function tcgcsvGame(game, ctx) {
  const groups = await tcgcsvGroups(game.category);
  if (!groups.length) throw new Error('no sets from tcgcsv');
  const kms = (await cardApiFile(game.cardApiFile || 'none.json', {})) || {};
  let done = 0;
  const sets = await pool(groups, 3, async (g) => {
    let products, prices;
    try {
      [products, prices] = await Promise.all([getJson(TCGCSV + '/' + game.category + '/' + g.groupId + '/products'),
        getJson(TCGCSV + '/' + game.category + '/' + g.groupId + '/prices')]);
    } catch (e) { console.warn('  ' + game.id + ' ' + g.name + ': ' + e.message); return null; }
    ctx.pictures.add(game.category, g.groupId, products.results);   // scripts/images.mjs
    const bySub = {};
    (prices.results || []).forEach((r) => { (bySub[r.productId] = bySub[r.productId] || []).push(r); });
    // TCGplayer's set name as it is ("Marvel: Darkhold Destiny": no code prefix to strip outside Pokémon), its code
    // the abbreviation; sets grouped by year (these games have no eras in the data)
    const date = (g.publishedOn || '').slice(0, 10) || null;
    const s = { game: game.id, lang: 'en', name: g.name, code: g.abbreviation || null, groupId: g.groupId,
      date, series: date ? date.slice(0, 4) : null, cards: [], keyBase: game.prefix + '-' + slug(g.name) };
    for (const p of products.results || []) {
      const number = ext(p, 'Number');
      const rarityCode = ext(p, 'Rarity');
      const sealed = !number && !rarityCode;
      const rarity = sealed ? 'Sealed Product' : (game.id === 'magic' ? MAGIC_RARITY[rarityCode] || rarityCode : rarityCode);
      const kind = ext(p, 'CardType', 'Card Type', 'Type');
      const rows = bySub[p.productId] && bySub[p.productId].length ? bySub[p.productId] : [{ subTypeName: 'Normal', marketPrice: null }];
      const seen = new Set();
      for (const row of rows) {
        const suffix = sealed ? '' : printingSuffix(row.subTypeName);
        const id = 'tcg-' + p.productId + suffix;
        if (seen.has(id)) continue;
        seen.add(id);
        if (kms[id]) { s.cards.push(Object.assign(fromCardApi(id, kms[id], ctx.staff, ctx.condMarket), { fromKms: 1 })); continue; }
        const market = typeof row.marketPrice === 'number' ? row.marketPrice : null;
        const sub = suffix ? ' (' + row.subTypeName + ')' : '';
        const card = { id, n: p.name + (sub && !p.name.includes(row.subTypeName) ? sub : ''), no: number, t: '', r: rarity,
          img: p.imageUrl || '', m: market, p: null, pr: String(p.productId) };
        if (sealed) card.sd = 1;
        if (kind && !sealed) card.k = kind;
        // As Card.api's mark_priced: cards over $2 are priced by condition (the KMS price's condition rules)
        if (!sealed && market != null && market > 2) card.cp = 1;
        if (ctx.staff && ctx.staff[id]) { const s2 = Object.assign({}, ctx.staff[id]); delete s2.by; card.sp = s2; }
        if (ctx.condMarket && ctx.condMarket[id]) card.cm = ctx.condMarket[id];
        s.cards.push(card);
      }
    }
    if (++done % 100 === 0) console.log('  ' + game.id + ': ' + done + ' of ' + groups.length + ' sets');
    return s.cards.length ? s : null;
  });
  return sets.filter(Boolean);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value);
  fs.writeFileSync(file, text);
  return text.length;
}
function sortCards(cards) {
  cards.sort((x, y) => {
    if (!!x.sd !== !!y.sd) return x.sd ? 1 : -1;   // sealed products after the cards
    const nx = parseInt(x.no, 10), ny = parseInt(y.no, 10);
    if (!isNaN(nx) && !isNaN(ny) && nx !== ny) return nx - ny;
    if (isNaN(nx) !== isNaN(ny)) return isNaN(nx) ? 1 : -1;
    return String(x.no).localeCompare(String(y.no), 'en', { numeric: true }) || x.n.localeCompare(y.n) || x.id.localeCompare(y.id);
  });
}

async function main() {
  console.log('Reading Card.api (' + CARD_API + ')');
  const condMarket = (await cardApiFile('condition_market.json', {})) || {};
  const condStaff = (await cardApiFile('condition_prices.json', {})) || {};
  const rules = await cardApiFile('price_rules.json', {});
  const ctx = { staff: condStaff.prices || {}, condMarket: condMarket.prices || {}, artists: {}, pictures: productCollector() };
  await setPictureSources();

  const all = [];
  const gamesOut = [];
  for (const game of GAMES) {
    if (!game.on || (ONLY && !ONLY.includes(game.id))) continue;
    console.log('Reading ' + game.name);
    // A game whose source is down fails the whole night: nothing is published, so the live data stays on last
    // night's complete copy rather than losing that game for a day
    const sets = game.source === 'card-api' ? await pokemon(ctx) : await tcgcsvGame(game, ctx);
    if (!sets.length) throw new Error(game.name + ': no sets');
    all.push(...sets);
    gamesOut.push({ id: game.id, name: game.name });
  }

  // Pictures for the cards TCGplayer has none for (scripts/images.mjs)
  const prevPictures = await getText(PREVIOUS + '/data/pictures.json', 60000).then((t) => JSON.parse(t)).catch(() => null);
  const pictures = await addCardPictures(all, ctx.pictures, prevPictures, gamesOut.map((g) => g.id));

  // Keys, totals, order
  const used = new Set();
  const list = [];
  for (const s of all) {
    let key = s.keyBase;
    for (let i = 2; used.has(key); i++) key = s.keyBase + '-' + i;
    used.add(key);
    s.key = key;
    sortCards(s.cards);
    const totals = {};
    s.cards.forEach((c) => { if (c.t) totals[c.t] = (totals[c.t] || 0) + 1; });
    const total = Object.keys(totals).sort((x, y) => totals[y] - totals[x])[0] || null;
    const sealed = s.cards.filter((c) => c.sd).length;
    const pic = setPicture(s, key);
    list.push({ k: key, game: s.game, name: s.name, lang: s.lang, series: s.series, date: s.date, code: s.code, total,
      count: s.cards.length - sealed, sealed, img: pic.img, ik: pic.ik });
  }
  list.sort((x, y) => (y.date || '').localeCompare(x.date || '') || x.name.localeCompare(y.name));

  fs.rmSync(OUT, { recursive: true, force: true });
  let bytes = 0;
  for (const s of all) {
    bytes += writeJson(path.join(OUT, 'sets', s.key + '.json'), { k: s.key, game: s.game, name: s.name, lang: s.lang, series: s.series, date: s.date,
      cards: s.cards.map((c) => { const x = Object.assign({}, c); delete x.fromKms; return x; }) });
  }
  const builtAt = new Date().toISOString();
<<<<<<< Updated upstream
  writeJson(path.join(OUT, 'sets.json'), { builtAt, games: gamesOut, sets: list });
  writePictures(path.join(OUT, 'pictures.json'), pictures);
=======
  // Joined cards and sets (see MOVED), with last night's still missing (so an old ID keeps working after one night)
  const allIds = new Set(), allKeys = new Set(list.map((s) => s.k));
  all.forEach((s) => s.cards.forEach((c) => allIds.add(c.id)));
  const moved = { cards: {}, sets: {} };
  const prevMoved = PREV_BUILD.moved || {};
  Object.assign(moved.cards, prevMoved.cards || {}, MOVED.cards);
  Object.assign(moved.sets, prevMoved.sets || {});
  MOVED.sets.forEach(([old, s]) => { if (old !== s.key) moved.sets[old] = s.key; });
  Object.keys(moved.cards).forEach((id) => { if (allIds.has(id) || !allIds.has(moved.cards[id])) delete moved.cards[id]; });
  Object.keys(moved.sets).forEach((k) => { if (allKeys.has(k) || !allKeys.has(moved.sets[k])) delete moved.sets[k]; });
  writeJson(path.join(OUT, 'sets.json'), { builtAt, games: gamesOut, sets: list, moved });
>>>>>>> Stashed changes

  // One compact table per game: string lists, then one row per card
  const setIndex = {};
  list.forEach((s, i) => { setIndex[s.k] = i; });
  let summary = [];
  for (const g of gamesOut) {
    const tables = { rarities: [], artists: [], kinds: [] }, idx = { rarities: {}, artists: {}, kinds: {} };
    const ix = (table, value) => {
      if (!value) return -1;
      if (!(value in idx[table])) { idx[table][value] = tables[table].length; tables[table].push(value); }
      return idx[table][value];
    };
    const rows = [];
    for (const s of all) {
      if (s.game !== g.id) continue;
      s.cards.forEach((c) => {
        rows.push([c.id, c.n, setIndex[s.key], c.no, c.t, ix('rarities', c.r), c.pr || '', c.m, c.p, ix('artists', c.a), ix('kinds', c.k), c.ln || '', c.sd ? 1 : 0, catalogPicture(c)]);
      });
    }
    const body = {
      builtAt, game: g.id, cols: ['id', 'name', 'set', 'number', 'total', 'rarity', 'product', 'market', 'price', 'artist', 'kind', 'localName', 'sealed', 'picture'],
      sets: list.map((s) => s.k), rarities: tables.rarities, artists: tables.artists, kinds: tables.kinds, cards: rows
    };
    const size = writeJson(path.join(OUT, 'catalog-' + g.id + '.json'), body);
    if (g.id === 'pokemon') writeJson(path.join(OUT, 'catalog.json'), body);
    const gz = zlib.gzipSync(fs.readFileSync(path.join(OUT, 'catalog-' + g.id + '.json'))).length;
    summary.push(g.id + ' ' + rows.length + ' (' + Math.round(size / 1048576 * 10) / 10 + ' MB, ' + Math.round(gz / 1024) + ' KB gzipped)');
  }
  writeJson(path.join(OUT, 'pricing.json'), { builtAt, rules: (rules.shops && rules.shops.kms) || null, conditionMarketAt: condMarket.fetchedAt || null });
  writeJson(path.join(OUT, 'artists.json'), ctx.artists);
  console.log('Wrote ' + list.length + ' sets; cards per game: ' + summary.join(', ') + '. Set files ' + Math.round(bytes / 1048576) + ' MB.');
}

main().catch((e) => { console.error(e); process.exit(1); });
