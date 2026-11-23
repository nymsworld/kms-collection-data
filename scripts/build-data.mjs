// Builds KMS Collection's card data (out/data/) for every game in GAMES, nightly on GitHub (this repo is public, so
// its Actions minutes are free) and published to Cloudflare Pages (project kms-collection-data). The app
// (nymsworld/kms-collection, private) reads it from there.
//
//   sets.json              every set of every game: key, game, name, language, era, date, card count
//   sets/<key>.json        one set's cards and sealed products, with pictures, prices and condition prices
//   catalog-<game>.json    every card of a game in a compact table (search, folder rules, the card camera);
//                          catalog.json = Pokémon's, for app builds from before games were added
//   pricing.json           KMS's price rules (Card.api price_rules.json) and when condition prices were fetched
//   artists.json           the illustrator of each card, kept so a night the card API is down keeps last night's
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
const ERAS = [
  [/^(ME|M\d|MBG|MC|mG|MEP)/i, 'Mega Evolution'], [/^(SV|SVP)/i, 'Scarlet & Violet'],
  [/^(SWSH|S\d|S-P|SP\d|SI|SA|SC|SK)/i, 'Sword & Shield'], [/^(SM|SMP)/i, 'Sun & Moon'], [/^(XY|CP\d)/i, 'XY'],
  [/^(BW|BKW|EBB)/i, 'Black & White'], [/^(HGSS|HS|L\d|LL)/i, 'HeartGold & SoulSilver'], [/^(PL|Pt)/, 'Platinum'],
  [/^(DP)/i, 'Diamond & Pearl'], [/^(PCG|ADV|EX)/, 'EX'], [/^(E\d|e\d)/, 'e-Card']
];
function eraOf(code) { for (const [re, era] of ERAS) if (re.test(code || '')) return era; return null; }
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
  [[groupsEn, 'en'], [groupsJa, 'ja']].forEach(([groups, lang]) => groups.forEach((g) => {
    // Only real sets (named "CODE: Name") keep TCGplayer's date: promo and miscellaneous groups get dates of
    // whenever TCGplayer last re-listed them (Burger King Promos showed as this week)
    const code = codeOf(g.name);
    const info = { date: code ? (g.publishedOn || '').slice(0, 10) : null, code: code || g.abbreviation || null };
    groupInfo[lang][norm(g.name)] = info;
    groupInfo[lang][norm(stripCode(g.name))] = groupInfo[lang][norm(stripCode(g.name))] || info;
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
    const a = s.lang === 'en' && api ? api.sets[norm(s.name)] : null;
    s.date = (a && a.date) || (g && g.date) || null;
    s.series = (a && a.series) || eraOf(topCode) || eraOf(g && g.code) || null;
    s.code = topCode || (g && g.code) || null;
  }
  return mergeSplitSets([...sets.values()]);
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
    big.series = big.series || small.series;
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
    const bySub = {};
    (prices.results || []).forEach((r) => { (bySub[r.productId] = bySub[r.productId] || []).push(r); });
    // TCGplayer's set name as it is ("Marvel: Darkhold Destiny": no code prefix to strip outside Pokémon), its code
    // the abbreviation; sets grouped by year (these games have no eras in the data)
    const date = (g.publishedOn || '').slice(0, 10) || null;
    const s = { game: game.id, lang: 'en', name: g.name, code: g.abbreviation || null,
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
function setPicture(cards) {
  const c = cards.find((x) => x.pr && !x.sd) || cards.find((x) => x.pr) || cards.find((x) => x.img);
  if (!c) return '';
  return c.pr ? 'https://tcgplayer-cdn.tcgplayer.com/product/' + c.pr + '_200w.jpg' : c.img;
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
  const ctx = { staff: condStaff.prices || {}, condMarket: condMarket.prices || {}, artists: {} };

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
    list.push({ k: key, game: s.game, name: s.name, lang: s.lang, series: s.series, date: s.date, code: s.code, total,
      count: s.cards.length - sealed, sealed, img: setPicture(s.cards) });
  }
  list.sort((x, y) => (y.date || '').localeCompare(x.date || '') || x.name.localeCompare(y.name));

  fs.rmSync(OUT, { recursive: true, force: true });
  let bytes = 0;
  for (const s of all) {
    bytes += writeJson(path.join(OUT, 'sets', s.key + '.json'), { k: s.key, game: s.game, name: s.name, lang: s.lang, series: s.series, date: s.date,
      cards: s.cards.map((c) => { const x = Object.assign({}, c); delete x.fromKms; return x; }) });
  }
  const builtAt = new Date().toISOString();
  writeJson(path.join(OUT, 'sets.json'), { builtAt, games: gamesOut, sets: list });

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
        rows.push([c.id, c.n, setIndex[s.key], c.no, c.t, ix('rarities', c.r), c.pr || '', c.m, c.p, ix('artists', c.a), ix('kinds', c.k), c.ln || '', c.sd ? 1 : 0]);
      });
    }
    const body = {
      builtAt, game: g.id, cols: ['id', 'name', 'set', 'number', 'total', 'rarity', 'product', 'market', 'price', 'artist', 'kind', 'localName', 'sealed'],
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
