# KMS Collection data: notes for future changes

Public repo (owner's choice, Nov 2026: public repos get free Actions minutes) holding only the card data build for
KMS Collection (the app is the private repo `nymsworld/kms-collection`). No secrets or private code here: the
workflow's Cloudflare token comes from the repo's Actions secrets (`CLOUDFLARE_API_TOKEN`, Pages-only;
`CLOUDFLARE_ACCOUNT_ID`). Never add a `pull_request` trigger (forks' runs must never see the secrets).

- `scripts/build-data.mjs`: everything about the data (its top comment lists the files). Games are the `GAMES`
  table: Pokémon from Card.api's prices.json; Magic, Yu-Gi-Oh! (and One Piece / Lorcana when turned on, the owner's
  plan) from tcgcsv's TCGplayer categories. Sealed products are in each set's file (`sd: 1`, after the cards).
  IDs follow Card.api's (`tcg-<product>`, `-foil`, `-1st-edition`, `-reverse`) so KMS staff prices line up.
<<<<<<< Updated upstream
- Pokémon sets fixed up after reading (owner's reports, Nov 2026): `mergeSameName` joins a set listed twice under
  one name apart from accents and punctuation (TCGplayer's "Pokemon GO" / "Pokémon GO", "Shining Fates Shiny Vault" /
  "Shining Fates: Shiny Vault"; same language and date; letters of every script count, so Chinese names don't collide), `mergeSplitSets` one named two ways
  ("Scarlet & Violet" / "… Base Set"), and `mcdonaldsEra` puts McDonald's promos in the era of their year (their
  "M14"-style codes otherwise read as Mega Evolution).
- `scripts/images.mjs` (owner's request, Nov 2026: cards with no picture): TCGplayer products with no picture
  (tcgcsv `imageCount` 0; Pokémon's products are read from tcgcsv for this) get `ni: 1` plus `ip` (another printing's
  product with a picture: same set + number, same name + number, Magic / Yu-Gi-Oh! also name alone) or `img` from
  Scryfall (Magic, by TCGplayer id), pokemontcg.io's data repo / TCGdex (Pokémon, set + number). Outside answers are
  cached in the published `pictures.json` (misses re-asked weekly). The catalog's last column `picture` = '' (own
  product), a product id, a URL or '-'. Not used: YGOPRODeck (asks to self-host its pictures) and scraping the
  official Chinese card database; the app's privacy page lists every picture host, so add any new one there.
=======
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
>>>>>>> Stashed changes
- `.github/workflows/build-data.yml`: nightly at 10:45 UTC, deploys `out/` to the Pages project
  `kms-collection-data`. A failing source fails the run: the live data stays on the last good night.
- Local test: `node scripts/build-data.mjs --card-api ../Card.api --games pokemon` (any subset of games).
