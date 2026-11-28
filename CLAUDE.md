# KMS Collection data: notes for future changes

Public repo (owner's choice, Nov 2026: public repos get free Actions minutes) holding only the card data build for
KMS Collection (the app is the private repo `nymsworld/kms-collection`). No secrets or private code here: the
workflow's Cloudflare token comes from the repo's Actions secrets (`CLOUDFLARE_API_TOKEN`, Pages-only;
`CLOUDFLARE_ACCOUNT_ID`). Never add a `pull_request` trigger (forks' runs must never see the secrets).

- `scripts/build-data.mjs`: everything about the data (its top comment lists the files). Games are the `GAMES`
  table: Pokémon from Card.api's prices.json; Magic, Yu-Gi-Oh! (and One Piece / Lorcana when turned on, the owner's
  plan) from tcgcsv's TCGplayer categories. Sealed products are in each set's file (`sd: 1`, after the cards).
  IDs follow Card.api's (`tcg-<product>`, `-foil`, `-1st-edition`, `-reverse`) so KMS staff prices line up.
- Pokémon sets fixed up after reading (owner's reports, Nov 2026): `mergeSameName` joins a set listed twice under
  one name apart from accents and punctuation (TCGplayer's "Pokemon GO" / "Pokémon GO", "Shining Fates Shiny Vault" /
  "Shining Fates: Shiny Vault"; same language and date; letters of every script count, so Chinese names don't collide), `mergeSplitSets` one named two ways
  ("Scarlet & Violet" / "… Base Set"), and `mcdonaldsEra` puts McDonald's promos in the era of their year (their
  "M14"-style codes otherwise read as Mega Evolution).
- `.github/workflows/build-data.yml`: nightly at 10:45 UTC, deploys `out/` to the Pages project
  `kms-collection-data`. A failing source fails the run: the live data stays on the last good night.
- Local test: `node scripts/build-data.mjs --card-api ../Card.api --games pokemon` (any subset of games).
