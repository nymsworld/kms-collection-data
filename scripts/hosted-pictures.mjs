// Our own copies of card pictures, served from the data site (owner's request, Nov 2026: set pages downloaded
// 200-300 KB per card from the official card sites). After scripts/images.mjs picks each card's picture:
//   - a big picture (official Pokémon sites, the Chinese dataset on jsDelivr, pokemontcg.io's PNGs) gets a small
//     copy, 250 px wide WebP (~15-20 KB), at /pictures/s/<hash>.webp: `img` = the copy, `il` = the original
//     (the card window's big picture);
//   - a Yu-Gi-Oh! picture from YGOPRODeck (it asks that its pictures be hosted, never shown from its server) is
//     copied as it is to /pictures/ygo/<file>; if the copy fails the card has no picture.
// Each copy is made once: the workflow keeps .cache/pictures between nights (actions/cache), and a copy missing from
// it is taken from last night's site before the original is downloaded again. Needs `sharp` (the workflow installs
// it); without it the originals are kept as they are.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(REPO, '.cache', 'pictures');
const SEED = path.join(REPO, 'pictures');   // Yu-Gi-Oh! pictures downloaded by hand before this step existed
export const DATA_SITE = 'https://kms-collection-data.pages.dev';
const BIG = /^https:\/\/(www\.pokemon-card\.com|asia\.pokemon-card\.com|cdn\.jsdelivr\.net|images\.pokemontcg\.io)\//;
const YGO = /^https:\/\/images\.ygoprodeck\.com\/images\/cards_small\/(\d+\.jpg)$/;
const WIDTH = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kms-collection-data-build)' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(url + ' answered ' + res.status);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) { if (i >= 2) return null; await sleep(3000 * (i + 1)); }
  }
}
// One download at a time per site (the same manners as official-pictures.mjs)
const queues = {};
function politeDownload(url) {
  const host = new URL(url).host;
  const run = async () => { try { return await download(url); } finally { await sleep(host === 'kms-collection-data.pages.dev' ? 0 : 300); } };
  const p = (queues[host] || Promise.resolve()).then(run, run);
  queues[host] = p.catch(() => {});
  return p;
}

export async function hostPictures(sets, outRoot) {
  let sharp = null;
  try { sharp = (await import('sharp')).default; } catch (e) { console.warn('  hosted pictures: sharp is not installed, originals kept'); }
  fs.mkdirSync(CACHE, { recursive: true });
  fs.rmSync(path.join(outRoot, 'pictures'), { recursive: true, force: true });
  // Every picture to copy: name → { from: original URL, cards }
  const jobs = new Map();
  for (const s of sets) {
    for (const c of s.cards) {
      if (!c.img) continue;
      let name = null;
      const y = YGO.exec(c.img);
      if (y) name = 'ygo/' + y[1];
      else if (BIG.test(c.img) && sharp) name = 's/' + crypto.createHash('sha1').update(c.img).digest('hex').slice(0, 20) + '.webp';
      if (!name) continue;
      if (!jobs.has(name)) jobs.set(name, { from: c.img, cards: [] });
      jobs.get(name).cards.push(c);
    }
  }
  const counts = { cached: 0, lastNight: 0, made: 0, failed: 0 };
  const list = [...jobs];
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < list.length) {
      const [name, job] = list[next++];
      const file = path.join(CACHE, name);
      let ok = fs.existsSync(file);
      if (ok) counts.cached++;
      // Pictures saved in the repo by hand (Yu-Gi-Oh!, before this step)
      if (!ok && name.startsWith('ygo/') && fs.existsSync(path.join(SEED, name))) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(path.join(SEED, name), file);
        ok = true; counts.cached++;
      }
      if (!ok) {
        const old = await politeDownload(DATA_SITE + '/pictures/' + name);
        if (old && old.length > 500) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, old); ok = true; counts.lastNight++; }
      }
      if (!ok) {
        const orig = await politeDownload(job.from);
        try {
          if (orig) {
            const out = name.startsWith('ygo/') ? orig
              : await sharp(orig).resize({ width: WIDTH, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, out);
            ok = true; counts.made++;
          }
        } catch (e) { /* not a picture */ }
      }
      if (!ok) counts.failed++;
      for (const c of job.cards) {
        if (ok) {
          if (!name.startsWith('ygo/')) c.il = job.from;
          c.img = DATA_SITE + '/pictures/' + name;
        } else if (name.startsWith('ygo/')) c.img = '';   // never shown from YGOPRODeck's server
      }
      if (ok) {
        fs.mkdirSync(path.dirname(path.join(outRoot, 'pictures', name)), { recursive: true });
        fs.copyFileSync(file, path.join(outRoot, 'pictures', name));
      }
    }
  }));
  console.log('Hosted pictures: ' + jobs.size + ' (' + counts.cached + ' kept, ' + counts.lastNight + ' from last night\'s site, ' +
    counts.made + ' new, ' + counts.failed + ' failed)');
}
