// Pictures from the official card databases and a public Simplified Chinese dataset, for the Pokémon cards no free
// card API has (owner's decision, Nov 2026: "scrape what we need to, it's not for profit"). Used by scripts/images.mjs
// only for cards with no picture yet, and what they answer is kept in pictures.json, so each card is looked up once
// (misses again after a month). Gentle: one request at a time per site, ~0.4 s apart.
//   - Traditional Chinese: asia.pokemon-card.com/tw card search (by expansion code, number from each card's page)
//   - Simplified Chinese: duanxr/PTCG-CHS-Datasets on GitHub (non-commercial use; pictures through cdn.jsdelivr.net)
//   - Japanese: www.pokemon-card.com card search (cards from 2006 on; a set's folder found by its code, and checked
//     with the Pokémon's Japanese names from PokéAPI's data when there are several), its full-size pictures
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; kms-collection-data-build)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One request at a time per site
const queues = {};
function polite(url) {
  const host = new URL(url).host;
  const run = async () => {
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: UA });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(url + ' answered ' + res.status);
        return await res.text();
      } catch (e) { if (i >= 2) throw e; await sleep(5000 * (i + 1)); }
      finally { await sleep(400); }
    }
  };
  const p = (queues[host] || Promise.resolve()).then(run, run);
  queues[host] = p.catch(() => {});
  return p;
}
function numKey(n) { return String(n || '').split('/')[0].toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^0+(?=\d)/, ''); }
const html = (s) => String(s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export function officialSources() {
  // A source that fails throws for every card it was asked about, so images.mjs doesn't keep "no picture" for them
  const cache = {};
  const once = (key, fn) => (cache[key] = cache[key] || fn().catch((e) => { console.warn('  pictures: ' + key + ': ' + e.message); return { failed: e }; }));
  const ok = async (p) => { const v = await p; if (v && v.failed) throw v.failed; return v; };

  // ---- Traditional Chinese: number → picture for one expansion code ----
  const TW = 'https://asia.pokemon-card.com';
  const twSet = (code) => once('tw:' + code, async () => {
    const list = TW + '/tw/card-search/list/?expansionCodes=' + encodeURIComponent(code);
    const first = await polite(list);
    const pages = +((/共\s*(\d+)\s*頁/.exec(first || '') || [])[1] || 0);
    const cards = [];   // [detail id, picture]
    const read = (page) => { const re = /href="\/tw\/card-search\/detail\/(\d+)\/"[\s\S]*?data-original="([^"]+)"/g; let m; while ((m = re.exec(page))) cards.push([m[1], m[2]]); };
    read(first || '');
    for (let p = 2; p <= pages; p++) read((await polite(list + '&pageNo=' + p)) || '');
    const byNo = {};
    for (const [id, img] of cards) {
      const page = (await polite(TW + '/tw/card-search/detail/' + id + '/')) || '';
      const no = html((/<span class="collectorNumber">([\s\S]*?)<\/span>/.exec(page) || [])[1]);
      if (no && !byNo[numKey(no)]) byNo[numKey(no)] = img;
    }
    return byNo;
  });

  // ---- Simplified Chinese: "CBB5C|0102/07" → picture ----
  const CHS = 'https://raw.githubusercontent.com/duanxr/PTCG-CHS-Datasets/main/ptcg_chs_infos.json';
  const chs = () => once('chs', async () => {
    const data = JSON.parse(await polite(CHS));
    const out = {};
    (data.collections || []).forEach((col) => (col.cards || []).forEach((c) => {
      const code = String(c.commodityCode || col.commodityCode || '').toUpperCase();
      const no = String((c.details && c.details.collectionNumber) || '').replace(/\s+/g, '').toLowerCase();
      if (code && no && c.image) out[code + '|' + no] = out[code + '|' + no] || 'https://cdn.jsdelivr.net/gh/duanxr/PTCG-CHS-Datasets@main/' + c.image;
    }));
    return out;
  });

  // ---- Japanese ----
  const JP = 'https://www.pokemon-card.com';
  // Every card in the database: folder → [[card id, name, picture path]]
  const jpIndex = () => once('jp', async () => {
    const folders = {};
    for (let page = 1, max = 1; page <= max; page++) {
      const d = JSON.parse(await polite(JP + '/card-search/resultAPI.php?keyword=&regulation_sidebar_form=all&page=' + page));
      max = Math.min(d.maxPage || 1, 2000);
      (d.cardList || []).forEach((c) => {
        const m = /\/large\/([^/]+)\//.exec(c.cardThumbFile || '');
        if (m) (folders[m[1]] = folders[m[1]] || []).push([c.cardID, c.cardNameAltText, c.cardThumbFile]);
      });
    }
    return folders;
  });
  // A folder's cards with their numbers
  // Full-size pictures: the small "thumb" ones are missing for many cards, even within a folder
  const jpFolder = (folder) => once('jpf:' + folder, async () => {
    const out = [];
    const cards = (await ok(jpIndex()))[folder] || [];
    for (const [id, name, file] of cards) {
      const page = (await polite(JP + '/card-search/details.php/card/' + id + '/regu/all')) || '';
      const no = html((/<div class="subtext[^"]*">([\s\S]*?)<\/div>/.exec(page) || [])[1]);
      out.push({ no: numKey(no), name, img: JP + file });
    }
    return out;
  });
  // English → Japanese (katakana) Pokémon names, longest first
  const species = () => once('species', async () => {
    const rows = (await polite('https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv')).split('\n').map((l) => l.split(','));
    const en = {}, ja = {};
    rows.forEach((r) => { if (r[1] === '9') en[r[0]] = r[2]; if (r[1] === '1') ja[r[0]] = r[2]; });
    return Object.keys(en).filter((id) => ja[id]).map((id) => [en[id].toLowerCase(), ja[id]]).sort((a, b) => b[0].length - a[0].length);
  });
  // Our set's folder: named by its code; when several (HeartGold / SoulSilver Collection are both L1), the one where
  // most of our Pokémon have their Japanese name at their number
  const jpSetFolder = (set) => once('jps:' + set.lang + '|' + set.name, async () => {
    const code = String(set.code || '').toLowerCase();
    if (!code) return null;
    const folders = Object.keys((await ok(jpIndex())) || {}).filter((f) => f.toLowerCase() === code || f.toLowerCase().startsWith(code + '-'));
    if (!folders.length) return null;
    const names = (await ok(species())) || [];
    let best = null, bestScore = 0;
    for (const f of folders) {
      const cards = await ok(jpFolder(f));
      const byNo = {};
      cards.forEach((c) => { byNo[c.no] = c; });
      let score = 0;
      set.cards.forEach((c) => {
        const hit = byNo[numKey(c.no)];
        const n = String(c.n || '').toLowerCase();
        const sp = hit && names.find(([e]) => new RegExp('(^|[^a-z])' + e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(n));
        if (sp && hit.name.includes(sp[1])) score++;
      });
      if (score > bestScore) { best = f; bestScore = score; }
    }
    if (!best) return null;
    const byNo = {};
    (await ok(jpFolder(best))).forEach((c) => { if (c.no && !byNo[c.no]) byNo[c.no] = c.img; });
    return byNo;
  });

  async function find(set, card) {
    const no = numKey(card.no);
    if (set.lang === 'zh-tw') {
      const code = set.code || (/^zhtw-(.+)-[^-]+$/.exec(card.id) || [])[1];
      return (code && no && ((await ok(twSet(code))) || {})[no]) || '';
    }
    if (set.lang === 'zh-cn') {
      const code = String(set.code || (/^zhcn-([^-]+)-/.exec(card.id) || [])[1] || '').toUpperCase();
      return ((await ok(chs())) || {})[code + '|' + String(card.no || '').replace(/\s+/g, '').toLowerCase()] || '';
    }
    if (set.lang === 'ja') return (no && ((await ok(jpSetFolder(set))) || {})[no]) || '';
    return '';
  }
  return { find };
}
