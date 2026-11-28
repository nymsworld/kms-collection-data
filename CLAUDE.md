# KMS Collection data: notes for future changes

Public repo (owner's choice, Nov 2026: public repos get free Actions minutes) holding only the card data build for
KMS Collection (the app is the private repo `nymsworld/kms-collection`). No secrets or private code here: the
workflow's Cloudflare token comes from the repo's Actions secrets (`CLOUDFLARE_API_TOKEN`, Pages-only;
`CLOUDFLARE_ACCOUNT_ID`). Never add a `pull_request` trigger (forks' runs must never see the secrets).

- `scripts/build-data.mjs`: everything about the data (its top comment lists the files). Games are the `GAMES`
  table: Pokémon from Card.api's prices.json; Magic, Yu-Gi-Oh! (and One Piece / Lorcana when turned on, the owner's
  plan) from tcgcsv's TCGplayer categories. Sealed products are in each set's file (`sd: 1`, after the cards).
  IDs follow Card.api's (`tcg-<product>`, `-foil`, `-1st-edition`, `-reverse`) so KMS staff prices line up.
- Pokémon sets fixed up after reading (owner's reports, Nov 2026), in this order:
  - Card.api lists many English sets twice: the card API's half (dated, its series = the era) and TCGplayer's
    (undated). `mergeSameName` joins names equal apart from accents and punctuation ("Pokemon GO" / "Pokémon GO";
    letters of every script count, so Chinese names don't collide), `mergeSplitSets` one name inside the other on the
    same date ("Scarlet & Violet" / "… Base Set"), `mergeNamedTwice` the rest: the `EN_SAME_SET` table (base sets,
    every Black Star promo series, trainer kits, Classic / Radiant Collection), "XY - X" / "SM - X" → "X", "Power
    Keepers" + "EX Power Keepers" → "EX Power Keepers", "Macdonald's Collection YYYY" → "McDonald's Promos YYYY",
    Japanese "M-P Promotional Cards" → "M-P Promos", and Chinese-named few-card halves into the English-named set with
    the same code and total. `joinSets` keeps the biggest half's key and drops a card already there (same ID, same
    product + printing + number, or no product and same number + name).
  - `attachSubsets`: "Set: Piece" / "Set (…)" (Shiny Vault, Radiant Collection, Base Set (Shadowless)) takes its
    set's date and era, so it's listed next to it. Subsets stay their own lists (as TCGplayer and the card API have them).
  - `pokemonEra`: McDonald's by year (`mcdonaldsEra`); English: the card API's series (`API_SERIES` maps its odd ones:
    Call of Legends → HGSS, "Trainer kits" / "McDonald's Collection" → by name), else the name's prefix (`NAME_ERAS`),
    else a code with a digit, else the date (`ERA_STARTS`); other languages: era names / "X-P" promos by name, else
    the code (`ERAS`, case-sensitive and anchored: "MCAP", "MG", "SAMPLE" aren't eras) if it fits the date, else the
    date. Japanese TCGplayer groups without a code keep their date (they're real release dates) unless re-listed in
    the last 180 days. "Promos, decks & more" (no era) is for products of no one era: league/prize/championship
    cards, Battle Academy, Trick or Trade, misc products, Japanese promo grab-bags.
  - `dropPatternReverses` (Ascended Heroes: a Poké Ball / Energy Symbol pattern card's "-reverse" twin is the same
    card) and `dropSameProduct` (one card under the card API's ID and TCGplayer's in one set; keeps the staff-priced,
    else non-sealed, else `tcg-` one).
  - Every ID or set key dropped that way is in sets.json `moved` ({ cards: {old: kept}, sets: {oldKey: newKey} },
    carried over from last night's build while the old one stays gone) so the app can remap saved copies / folders.
  - English dates and eras: the card API, else pokemontcg.io's set list, else last night's sets.json (the card API
    doesn't answer from every network: local runs use the fallbacks).
- `scripts/images.mjs` (owner's request, Nov 2026: cards with no picture): TCGplayer products with no picture
  (tcgcsv `imageCount` 0; Pokémon's products are read from tcgcsv for this) get `ni: 1` plus `ip` (another printing's
  product with a picture: same set + number, same name + number, Magic / Yu-Gi-Oh! also name alone) or `img` from
  Scryfall (Magic, by TCGplayer id), pokemontcg.io's data repo / TCGdex (Pokémon, set + number). Outside answers are
  cached in the published `pictures.json` (misses re-asked weekly). The catalog's last column `picture` = '' (own
  product), a product id, a URL or '-'. Then (owner's decision, Nov 2026: "scrape what we need to, it's not for
  profit") `scripts/official-pictures.mjs`: Traditional Chinese from asia.pokemon-card.com/tw, Simplified Chinese
  from the GitHub dataset duanxr/PTCG-CHS-Datasets (via cdn.jsdelivr.net), Japanese from www.pokemon-card.com (cards
  from 2006 on; full-size pictures, its thumbs are patchy). One request at a time per site; misses re-asked monthly. Yu-Gi-Oh!: YGOPRODeck's
  picture by card name (cardinfo.php, nightly for cards not looked up that week). Never TCGplayer's site. The app's
  privacy page lists every picture host: add new ones.
- `scripts/hosted-pictures.mjs` (owner's request, Nov 2026): big pictures (official Pokémon sites, the jsDelivr dataset,
  pokemontcg.io PNGs; 165-300 KB) get a 250 px WebP copy (~15-20 KB) on the data site at `/pictures/s/<sha1>.webp`
  (`img` = copy, `il` = original for the card window); YGOPRODeck's are copied as they are to `/pictures/ygo/` and
  never shown from its server (YGOPRODeck asks for that). Copies are kept between nights in `.cache/pictures` by
  actions/cache (a missing one is taken from the live site, else made again); needs `sharp` (the workflow installs
  it; `npm install --no-save --no-package-lock sharp@0.35.5` locally, without it originals are kept). `pictures/ygo/`
  in the repo = the first hand-downloaded copies (seed).
- `scripts/cond-ratios.mjs` (owner's request, Nov 28, 2026; never scrape TCGplayer): `pricing.json` `condRatios`, the
  typical condition / Near Mint ratio (median, 1.5 IQR outliers dropped) learned from every card with real condition
  prices (`cm`), by NM band (<$5, 5-20, 20-50, 50-200, 200+) x game x set age (vintage <2003, older <2017, modern) x
  rarity group; a group is published per condition only with 12+ cards, and the app (kms-collection
  `web/js/pricing.js` `learnedRatio`, same groups: keep them the same) walks `lookup` from finest to coarsest.
  `check` = a 20% held-out test against the old flat percents (printed in the build log). The cards with `cm` are
  Card.api's JustTCG choice (shop stock and cards over $50), mostly Pokémon.
- `.github/workflows/build-data.yml`: nightly at 10:45 UTC, deploys `out/` to the Pages project
  `kms-collection-data`. A failing source fails the run: the live data stays on the last good night.
- Local test: `node scripts/build-data.mjs --card-api ../Card.api --games pokemon` (any subset of games).
