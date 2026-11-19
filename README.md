# Blackout Atlas

A geography-and-history guessing game: **Redactle meets TimeGuessr.**

Each round shows a paragraph from a Wikipedia article about a place or an event, with every
mention of the location blacked out (and, for events, every year). Drop a pin on the map, pick
the year, and score up to 10,000 points per round. Stuck? Reveal another paragraph, which lowers
the most you can score that round.

Static HTML/CSS/JS with no build step, so it runs on GitHub Pages for free.

## Play locally

The game loads `data/challenges.json` with `fetch`, so open it through a local web server
rather than by double-clicking `index.html`:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repository, open **Settings → Pages**, set **Source** to *Deploy from a branch*, pick `main` and `/ (root)`, and save.
3. The site appears at `https://<user>.github.io/<repo>/` within a minute or two.

(`.nojekyll` is included so Pages serves the files as they are.)

## Scoring

| Part | Max | Formula |
|---|---|---|
| Distance | 5,000 | full marks within 25 km, then `5000 · e^(−(km−25)/1500)` |
| Year | 5,000 | `5000 · e^(−Δyears / k)`, where `k = max(12, (2025 − year)/10)`, so older events are more forgiving |
| Place-only rounds | 10,000 | distance score × 2 |
| Extra paragraphs | | each extra paragraph cuts the round's total by 20% (×0.8, ×0.6) |

**Daily** mode gives everyone the same 5 rounds each day (4 events and 1 place, chosen with a
date-seeded shuffle). **Practice** mode deals 5 random rounds and avoids ones you've already seen.

## Content: generating challenges

`scripts/generate.mjs` (Node 18+, no dependencies) builds `data/challenges.json`:

1. Asks **Wikidata** for well-known items of chosen classes (battles, sieges, earthquakes, coups,
   treaties, … and archaeological sites, castles, islands, national parks, World Heritage Sites, …)
   that have coordinates and an English Wikipedia article. Events also need a date to at least the year.
2. Fetches the article's plain text from the **Wikipedia API**.
3. Builds a redaction list from the item's own names and aliases, plus the names, aliases and
   demonyms of its country, administrative areas (three levels up), location, terrain feature,
   nearby water and continent. Distinctive words from these names are redacted on their own too
   ("Gettysburg" from "Battle of Gettysburg"), but generic words like *Battle*, *River* or *North* are not.
4. For events, it also redacts years, decades, centuries and `BC`/`AD` dates.
5. Picks up to three paragraphs: two body paragraphs that mention the subject, then the lead
   paragraph as the final, easiest clue. Paragraphs where the main name still shows through,
   or where more than 22% of the text would be blacked out, are skipped.

```bash
node scripts/generate.mjs                          # 70 events + 30 places (overwrites)
node scripts/generate.mjs --events 50 --places 20 --seed 2 --append   # add 70 more
node scripts/generate.mjs --only Q48314,Q193573    # add or rebuild specific Wikidata items
node scripts/generate.mjs --rebuild                # re-run redaction on every existing challenge
node scripts/review.mjs                            # proofread: print every challenge as players see it
node scripts/review.mjs --leaks                    # only ones where a title word may still be visible
```

Category mix and per-class weights are at the top of the script (`EVENT_CLASSES`, `PLACE_CLASSES`).
Wikidata's most-linked events lean heavily toward the last 25 years, so the script keeps only about 30%
of post-2000 events (`RECENT_KEEP_PCT`). Items named with `--only` are always kept.

Add a Wikidata id to `scripts/exclude.txt` to ban a weak challenge, then delete it from the
JSON (or regenerate). API responses are cached in `scripts/.cache/` (git-ignored), so reruns are fast
and easy on Wikimedia's servers. The script throttles itself and backs off when rate-limited, so a fresh
run of 100 takes roughly 30–40 minutes. Most of that is waiting out Wikidata's limits.

### Challenge format

```jsonc
{
  "id": "Q31953",                 // Wikidata id
  "title": "Battle of Hastings",
  "url": "https://en.wikipedia.org/wiki/Battle_of_Hastings",
  "kind": "event",                // or "place"
  "category": "Battle",
  "lat": 50.9113, "lng": 0.4875,
  "year": 1066,                   // null for places; negative = BC
  "date": "10-14",                // month-day if known
  "clues": [ { "text": "…", "redactions": [[start, end], …] } ]
}
```

Hand-written challenges in the same format work too. Redaction ranges are character offsets into `text`.

## Credits

Passages come from Wikipedia under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/);
every round links back to its source article. Data comes from Wikidata (CC0). Map tiles are
© Esri and its data partners (World Street Map), and maps are drawn with [Leaflet](https://leafletjs.com/).
