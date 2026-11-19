#!/usr/bin/env node
/**
 * Blackout Atlas — challenge generator.
 *
 * Pulls well-known events and places from Wikidata (things with coordinates,
 * and a date for events), fetches their English Wikipedia article text, picks
 * a few paragraphs, and redacts every reference to the location (and, for
 * events, every year/century) so the paragraphs can be used as clues.
 *
 * Usage:
 *   node scripts/generate.mjs                       # 70 events + 30 places -> data/challenges.json
 *   node scripts/generate.mjs --events 40 --places 20 --seed 7 --append
 *   node scripts/generate.mjs --only Q48314,Q193573  # (re)build specific Wikidata items
 *
 * Options:
 *   --events N        number of event challenges (default 70)
 *   --places N        number of place-only challenges (default 30)
 *   --seed S          random seed for candidate sampling (default 1)
 *   --out FILE        output file (default data/challenges.json)
 *   --append          keep existing challenges in FILE and add new ones
 *   --only Q1,Q2      only build these Wikidata ids (implies --append)
 *   --rebuild         re-process every challenge already in FILE (after changing redaction rules)
 *   --pool N          how many of the most-linked items per class to sample from (default 80)
 *
 * Requires Node 18+ (global fetch). No npm dependencies.
 * Items listed in scripts/exclude.txt are never used.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, 'scripts', '.cache');
const UA = 'BlackoutAtlas-ChallengeGenerator/1.0 (open-source browser geography game; low-volume batch script)';

// ---------------------------------------------------------------- config ---

// weight = relative share of the requested event/place count
const EVENT_CLASSES = [
  { id: 'Q178561', label: 'Battle', weight: 18 },
  { id: 'Q188055', label: 'Siege', weight: 6 },
  { id: 'Q7944', label: 'Earthquake', weight: 7 },
  { id: 'Q7692360', label: 'Volcanic eruption', weight: 2 },
  { id: 'Q8065', label: 'Natural disaster', weight: 3 },
  { id: 'Q3839081', label: 'Disaster', weight: 4 },
  { id: 'Q168983', label: 'Fire', weight: 2 },
  { id: 'Q8068', label: 'Flood', weight: 2 },
  { id: 'Q744913', label: 'Aviation accident', weight: 3 },
  { id: 'Q1078765', label: 'Railway accident', weight: 1 },
  { id: 'Q179057', label: 'Explosion', weight: 2 },
  { id: 'Q2223653', label: 'Attack', weight: 3 },
  { id: 'Q3199915', label: 'Massacre', weight: 3 },
  { id: 'Q124757', label: 'Riot', weight: 3 },
  { id: 'Q273120', label: 'Protest', weight: 3 },
  { id: 'Q45382', label: "Coup d'état", weight: 3 },
  { id: 'Q3882219', label: 'Assassination', weight: 3 },
  { id: 'Q131569', label: 'Treaty', weight: 3 },
  { id: 'Q2001676', label: 'Military offensive', weight: 2 },
  { id: 'Q13418847', label: 'Historical event', weight: 2 },
];

const PLACE_CLASSES = [
  { id: 'Q839954', label: 'Archaeological site', weight: 6 },
  { id: 'WHS', label: 'World Heritage Site', weight: 5, minSitelinks: 40 },
  { id: 'Q23413', label: 'Castle', weight: 3 },
  { id: 'Q2977', label: 'Cathedral', weight: 2 },
  { id: 'Q16560', label: 'Palace', weight: 2 },
  { id: 'Q46169', label: 'National park', weight: 4 },
  { id: 'Q23442', label: 'Island', weight: 4, minSitelinks: 40 },
  { id: 'Q8502', label: 'Mountain', weight: 3, minSitelinks: 40 },
  { id: 'Q23397', label: 'Lake', weight: 3, minSitelinks: 40 },
  { id: 'Q34038', label: 'Waterfall', weight: 2 },
];

// Location-ish properties whose names get redacted
const LOCATION_PROPS = ['P17', 'P131', 'P276', 'P706', 'P206', 'P1376', 'P30'];
const NO_TOKENIZE_PROPS = new Set(['P30', 'P206']); // only redact these as whole phrases

// Words that are never redacted on their own (they still go when part of a full matched phrase)
const STOPWORDS = new Set(`
a an the of in on at to and or for by with from upon de del della di du la le les los las el da do dos das van von der den het y e et
battle battles siege sieges war wars campaign attack attacks massacre massacres bombing bombings earthquake earthquakes eruption fire great flood floods
riot riots revolt revolution rebellion uprising protest protests coup assassination treaty peace accord accords agreement convention congress
disaster crash crashes accident explosion incident affair offensive operation crisis strike tsunami hurricane typhoon cyclone storm
city town village county district province region state states republic kingdom empire federation union united federal democratic people's peoples
municipality borough parish prefecture oblast krai governorate department canton commune shire territory territories autonomous community land lands
north south east west northern southern eastern western central upper lower greater new old saint st san santa são sao santo mount mountain mountains mt
lake river sea ocean bay gulf island islands isle isles peninsula valley desert coast cape point harbour harbor port fort castle palace cathedral church
temple abbey park national world heritage site ruins ancient city's capital area metropolitan special administrative
january february march april may june july august september october november december
first second third fourth fifth sixth seventh eighth ninth tenth
air flight airlines airways express international
`.trim().split(/\s+/));

// bibliography-style lines: "Surname, First. Title..." or anything with ISBN/pp./Press
const CITATION = /ISBN|\bpp?\.\s?\d|University Press|^\p{Lu}[\p{L}'’-]+, \p{Lu}[\p{L}.]*(?: (?:and )?\p{Lu}[\p{L}.]*)*[,.]/u;
const RECENT_KEEP_PCT = 30;
const idHash = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

const SKIP_SECTIONS = /^(see also|references|notes|external links|further reading|bibliography|sources|citations|gallery|in popular culture|popular culture|footnotes|literature|works cited|explanatory notes|in fiction|in film|media|filmography|cultural references|in the media|notes and references)$/i;

// ------------------------------------------------------------- utilities ---

const args = parseArgs(process.argv.slice(2));
const NUM_EVENTS = Number(args.events ?? 70);
const NUM_PLACES = Number(args.places ?? 30);
const SEED = Number(args.seed ?? 1);
const POOL = Number(args.pool ?? 80);
const OUT = path.resolve(ROOT, args.out ?? 'data/challenges.json');
const ONLY = args.only ? String(args.only).split(',').map((s) => s.trim()).filter(Boolean) : null;
const REBUILD = Boolean(args.rebuild);
const APPEND = Boolean(args.append || ONLY || REBUILD);
const FORCE = Boolean(ONLY || REBUILD); // explicitly requested items skip the recency thinning

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (argv[i + 1] && !argv[i + 1].startsWith('--')) o[k] = argv[++i];
    else o[k] = true;
  }
  return o;
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cached(key, fn) {
  const file = path.join(CACHE_DIR, key.replace(/[^a-z0-9_.-]/gi, '_') + '.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {}
  const v = await fn();
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(v));
  return v;
}

// Polite pacing: at most one request per host every MIN_GAP ms, and honour Retry-After.
const MIN_GAP = { 'www.wikidata.org': 1200, 'query.wikidata.org': 2000, 'en.wikipedia.org': 1200 };
const lastHit = {};
async function getJSON(url, tries = 10) {
  const host = new URL(url).host;
  for (let i = 0; i < tries; i++) {
    const wait = (lastHit[host] || 0) + (MIN_GAP[host] || 500) - Date.now();
    if (wait > 0) await sleep(wait);
    lastHit[host] = Date.now();
    let r;
    try {
      r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(45000) });
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      if (i === tries - 1) throw new Error('HTTP ' + r.status);
      const retryAfter = Number(r.headers.get('retry-after')) || 5 * (i + 1);
      process.stdout.write(`  (rate limited by ${host}, waiting ${retryAfter}s)\n`);
      await sleep(retryAfter * 1000);
      continue;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    return await r.json();
  }
}

const sparql = (q) => getJSON('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q));

// -------------------------------------------------------------- wikidata ---

async function candidatesFor(cls, kind) {
  const minSl = cls.minSitelinks ?? 15;
  const typeClause = cls.id === 'WHS' ? '?item wdt:P1435 wd:Q9259 .' : `?item wdt:P31 wd:${cls.id} .`;
  const coordClause = kind === 'event'
    ? '{ ?item wdt:P625 [] } UNION { ?item wdt:P276/wdt:P625 [] }'
    : '?item wdt:P625 [] .';
  const dateClause = kind === 'event' ? '{ ?item wdt:P585 [] } UNION { ?item wdt:P580 [] }' : '';
  const q = `SELECT DISTINCT ?item ?sl WHERE {
    ${typeClause}
    ?item wikibase:sitelinks ?sl . FILTER(?sl >= ${minSl})
    ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
    ${coordClause}
    ${dateClause}
  } ORDER BY DESC(?sl) LIMIT ${POOL}`;
  const res = await cached(`sparql_${kind}_${cls.id}_${minSl}_${POOL}`, () => sparql(q));
  return res.results.bindings.map((b) => b.item.value.split('/').pop());
}

const entityCache = new Map();
async function getEntities(ids) {
  const need = [...new Set(ids)].filter((id) => !entityCache.has(id));
  for (let i = 0; i < need.length; i += 50) {
    const batch = need.slice(i, i + 50);
    const res = await cached('ent_' + batch.join('_').slice(0, 180) + '_' + batch.length, () =>
      getJSON('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|aliases|claims|sitelinks&languages=en&sitefilter=enwiki&ids=' + batch.join('|')));
    for (const [id, ent] of Object.entries(res.entities || {})) entityCache.set(id, slimEntity(ent));
    await sleep(150);
  }
  return ids.map((id) => entityCache.get(id)).filter(Boolean);
}

// keep only what we need (country entities are huge)
function slimEntity(ent) {
  const claims = {};
  for (const p of [...LOCATION_PROPS, 'P625', 'P585', 'P580', 'P1549', 'P31', 'P1448', 'P1705']) {
    if (ent.claims?.[p]) claims[p] = ent.claims[p].filter((c) => c.rank !== 'deprecated').map((c) => c.mainsnak?.datavalue?.value).filter((v) => v != null);
  }
  return {
    id: ent.id,
    label: ent.labels?.en?.value,
    aliases: (ent.aliases?.en || []).map((a) => a.value),
    enwiki: ent.sitelinks?.enwiki?.title,
    claims,
  };
}

const ids = (ent, p) => (ent.claims[p] || []).map((v) => v.id).filter(Boolean);

function getCoord(ent) {
  const c = (ent.claims.P625 || []).find((v) => !v.globe || v.globe.endsWith('/Q2'));
  return c ? { lat: +c.latitude.toFixed(4), lng: +c.longitude.toFixed(4) } : null;
}

function getDate(ent) {
  for (const p of ['P585', 'P580']) {
    for (const v of ent.claims[p] || []) {
      if (!v.time || v.precision < 9) continue;
      const m = /^([+-])(\d+)-(\d\d)-(\d\d)/.exec(v.time);
      if (!m) continue;
      const year = (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10);
      const date = v.precision >= 11 ? `${m[3]}-${m[4]}` : v.precision === 10 ? m[3] : null;
      return { year, monthDay: date };
    }
  }
  return null;
}

// Collect every name that could give the location away.
async function redactionTerms(ent) {
  const phrases = new Set();
  const tokenSources = new Set();
  const addNames = (e, tokenize) => {
    const names = [e.label, ...e.aliases, e.enwiki?.replace(/\s*\(.*?\)\s*/g, '')];
    for (const v of e.claims.P1549 || []) if (v.language === 'en') names.push(v.text);
    for (const p of ['P1448', 'P1705']) for (const v of e.claims[p] || []) if (v.text) names.push(v.text);
    for (const n of names) {
      if (!n || n.length < 2) continue;
      // skip all-lowercase aliases (usually generic descriptions) except demonyms
      if (n === n.toLowerCase()) continue;
      phrases.add(n);
      if (tokenize) tokenSources.add(n);
    }
  };
  addNames(ent, true);

  // related location entities, walking P131 up to three levels
  let frontier = LOCATION_PROPS.flatMap((p) => ids(ent, p).map((id) => ({ id, p })));
  const seen = new Set([ent.id]);
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const fresh = frontier.filter((f) => !seen.has(f.id));
    fresh.forEach((f) => seen.add(f.id));
    const ents = await getEntities(fresh.map((f) => f.id));
    const next = [];
    for (const e of ents) {
      const via = fresh.find((f) => f.id === e.id)?.p;
      // countries/continents: tokenizing "United Kingdom of Great Britain..." aliases is noisy
      addNames(e, !NO_TOKENIZE_PROPS.has(via) && via !== 'P17');
      if (via !== 'P30') {
        for (const id of ids(e, 'P131')) next.push({ id, p: 'P131' });
        for (const id of ids(e, 'P17')) next.push({ id, p: 'P17' });
      }
    }
    frontier = next;
  }

  const tokens = new Set();
  for (const s of tokenSources) {
    for (const t of s.split(/[\s,/()–—-]+/)) {
      const w = t.replace(/^['’"]+|['’".]+$/g, '');
      if (w.length < 3 || !/^\p{Lu}/u.test(w) || /^\d/.test(w)) continue;
      if (STOPWORDS.has(w.toLowerCase())) continue;
      tokens.add(w);
    }
  }
  // drop phrases that are entirely stopwords ("The City", "Central")
  const out = [...phrases, ...tokens].filter((p) => p.split(/\s+/).some((w) => !STOPWORDS.has(w.toLowerCase())));
  const withVariants = new Set();
  for (const p of out) {
    withVariants.add(p);
    const plain = p.normalize('NFD').replace(/\p{M}/gu, '');
    if (plain !== p) withVariants.add(plain);
  }
  return [...withVariants].sort((a, b) => b.length - a.length);
}

// --------------------------------------------------------------- wikipedia ---

async function articleText(title) {
  const res = await cached('wp_' + title, async () => {
    await sleep(120);
    return getJSON('https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=' + encodeURIComponent(title));
  });
  return res.query?.pages?.[0]?.extract || '';
}

function paragraphs(text) {
  const out = [];
  let section = '';
  let sectionIndex = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = /^(=+)\s*(.*?)\s*\1$/.exec(line);
    if (h) {
      if (h[1].length === 2) { section = h[2]; sectionIndex++; }
      continue;
    }
    if (SKIP_SECTIONS.test(section)) continue;
    if (/^\p{Ll}/u.test(line)) continue; // fragment left over from stripped markup
    out.push({ text: cleanText(line), section, sectionIndex });
  }
  return out;
}

function cleanText(s) {
  return s
    .replace(/\(\s*(?:[;,]\s*)*\)/g, '') // "( ; )" leftovers from stripped pronunciations
    .replace(/\(\s*[;,]\s*/g, '(')
    .replace(/\s*[;,]\s*\)/g, ')')
    .replace(/\{\\displaystyle[^}]*\}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}

function truncateSentences(s, max) {
  if (s.length <= max) return s;
  const sentences = s.match(/[^.!?]+(?:[.!?]+["'”’)]*|$)\s*/g) || [s];
  let out = '';
  for (const sent of sentences) {
    if ((out + sent).length > max && out) break;
    out += sent;
  }
  return out.trim();
}

// -------------------------------------------------------------- redaction ---

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const L = '[\\p{L}\\p{N}]';

const YEAR_PATTERNS = [
  /\b(?:AD|CE|BC|BCE)\s?\d{1,4}\b/g,
  /\b\d{1,4}\s?(?:AD|CE|BC|BCE|B\.C\.|A\.D\.)(?![\p{L}])/gu,
  /\b\d{1,2}(?:st|nd|rd|th)[\s-](?:century|centuries|millennium)\b/gi,
  /\b(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-first)[\s-](?:century|centuries|millennium)\b/gi,
  /\b(?:1[0-9]|20)\d0s\b/g,
  /['’]\d0s\b/g,
  /(?<![\d,.])\b(?:[5-9]\d{2}|1\d{3}|20[0-2]\d)\b(?![.,]\d)(?!\s?(?:km|mi|m|ft|kg|tonnes|tons|people|men|soldiers|troops|killed|dead|casualties|deaths|metres|meters|feet|miles|square|%))/g,
];

function redact(text, terms, isEvent) {
  const ranges = [];
  for (const t of terms) {
    const re = new RegExp(`(?<!${L})${esc(t)}(?:['’]s)?(?!${L})`, 'gu');
    for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  }
  if (isEvent) {
    for (const re of YEAR_PATTERNS) for (const m of text.matchAll(re)) ranges.push([m.index, m.index + m[0].length]);
  }
  // merge overlaps, then split into per-word bars (word lengths are part of the fun)
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  const words = [];
  for (const [s, e] of merged) {
    const re = /\S+/g;
    const seg = text.slice(s, e);
    for (const m of seg.matchAll(re)) words.push([s + m.index, s + m.index + m[0].length]);
  }
  return words;
}

function redactedRatio(text, ranges) {
  return ranges.reduce((n, [s, e]) => n + (e - s), 0) / text.length;
}

// Does the main name still show through anywhere (case-insensitive)?
function leaks(text, ranges, names) {
  let masked = text;
  for (const [s, e] of ranges) masked = masked.slice(0, s) + '#'.repeat(e - s) + masked.slice(e);
  const lower = masked.toLowerCase();
  return names.some((n) => n && n.length >= 4 && lower.includes(n.toLowerCase()));
}

// ---------------------------------------------------------------- builder ---

async function buildChallenge(ent, cls, kind) {
  if (!ent.enwiki) return { skip: 'no enwiki' };
  let coord = getCoord(ent);
  if (!coord && kind === 'event') {
    const locs = await getEntities(ids(ent, 'P276'));
    coord = locs.map(getCoord).find(Boolean) || null;
  }
  if (!coord) return { skip: 'no coordinates' };

  let date = null;
  if (kind === 'event') {
    date = getDate(ent);
    if (!date) return { skip: 'no year-precision date' };
    if (date.year > 2024) return { skip: 'too recent' };
    // Wikidata's most-linked events skew heavily toward the last 25 years; keep only ~30% of those
    if (date.year >= 2000 && !FORCE && idHash(ent.id) % 100 >= RECENT_KEEP_PCT) return { skip: 'recent (thinned)' };
  }

  const terms = await redactionTerms(ent);
  const text = await articleText(ent.enwiki);
  if (text.length < 1500) return { skip: 'article too short' };
  const paras = paragraphs(text);
  const isEvent = kind === 'event';
  const coreNames = [ent.label, ent.enwiki.replace(/\s*\(.*?\)\s*/g, '')];

  const evaluated = paras.map((p, i) => {
    const t = i === 0 ? truncateSentences(p.text, 900) : p.text;
    const r = redact(t, terms, isEvent);
    return { ...p, i, text: t, ranges: r, ratio: redactedRatio(t, r), leak: leaks(t, r, coreNames) };
  }).filter((p) => !p.leak && p.ratio < 0.22 && p.text.split(/\s+/).length >= 40 && !/may refer to|^This article/.test(p.text) && !CITATION.test(p.text));

  const lead = evaluated.find((p) => p.sectionIndex === 0);
  const body = evaluated
    .filter((p) => p.sectionIndex > 0 && p.text.length <= 1100)
    .map((p) => ({ ...p, score: Math.min(p.ranges.length, 5) + (p.sectionIndex <= 3 ? 1.5 : 0) + rand() }))
    .sort((a, b) => b.score - a.score);

  // need at least one paragraph that actually mentions the redacted subject
  const picks = body.filter((p) => p.ranges.length > 0).slice(0, 2);
  if (lead) picks.push(lead);
  if (picks.length < 2) return { skip: 'not enough usable paragraphs' };
  if (!picks.some((p) => p.ranges.length > 0)) return { skip: 'no redactions at all' };

  return {
    challenge: {
      id: ent.id,
      title: ent.enwiki,
      url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(ent.enwiki.replace(/ /g, '_')),
      kind,
      category: cls.label,
      lat: coord.lat,
      lng: coord.lng,
      year: date ? date.year : null,
      date: date?.monthDay ?? null,
      clues: picks.map((p) => ({ text: p.text, redactions: p.ranges })),
    },
  };
}

function quotas(classes, total) {
  const sum = classes.reduce((n, c) => n + c.weight, 0);
  const q = classes.map((c) => Math.floor((c.weight / sum) * total));
  let rest = total - q.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i = (i + 1) % q.length, rest--) q[i]++;
  return q;
}

async function main() {
  let existing = [];
  if (APPEND) {
    try { existing = JSON.parse(await fs.readFile(OUT, 'utf8')).challenges || []; } catch {}
  }
  let exclude = new Set();
  try {
    exclude = new Set((await fs.readFile(path.join(ROOT, 'scripts', 'exclude.txt'), 'utf8')).split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
  } catch {}
  const used = new Set([...existing.map((c) => c.id), ...exclude]);
  const results = [];
  const log = (...a) => console.log(...a);

  const prior = new Map(existing.map((c) => [c.id, c]));
  const targets = REBUILD ? existing.map((c) => c.id) : ONLY;
  if (targets) {
    const ents = await getEntities(targets);
    for (const ent of ents) {
      const isEvent = Boolean(getDate(ent));
      const cls = { label: isEvent ? 'Event' : 'Place' };
      const instanceOf = ids(ent, 'P31');
      const known = [...EVENT_CLASSES, ...PLACE_CLASSES].find((c) => instanceOf.includes(c.id));
      if (known) cls.label = known.label;
      if (prior.has(ent.id)) cls.label = prior.get(ent.id).category;
      const kind = prior.get(ent.id)?.kind ?? (isEvent ? 'event' : 'place');
      const r = await buildChallenge(ent, cls, kind);
      log(`${ent.id} ${ent.enwiki}: ${r.skip ? 'SKIP ' + r.skip : 'ok'}`);
      existing = existing.filter((c) => c.id !== ent.id);
      if (r.challenge) results.push(r.challenge);
    }
  } else {
    for (const [kind, classes, total] of [['event', EVENT_CLASSES, NUM_EVENTS], ['place', PLACE_CLASSES, NUM_PLACES]]) {
      const q = quotas(classes, total);
      for (const [ci, cls] of classes.entries()) {
        let want = q[ci];
        if (!want) continue;
        const cands = shuffle((await candidatesFor(cls, kind)).filter((id) => !used.has(id)));
        log(`\n[${kind}] ${cls.label}: want ${want}, ${cands.length} candidates`);
        for (let i = 0; i < cands.length && want > 0; i += 10) {
          const ents = await getEntities(cands.slice(i, i + 10));
          for (const ent of ents) {
            if (want <= 0 || used.has(ent.id)) continue;
            try {
              const r = await buildChallenge(ent, cls, kind);
              if (r.skip) { log(`  - ${ent.enwiki || ent.id}: ${r.skip}`); continue; }
              used.add(ent.id);
              results.push(r.challenge);
              want--;
              log(`  + ${r.challenge.title} (${r.challenge.year ?? 'place'})`);
            } catch (e) {
              log(`  ! ${ent.id}: ${e.message}`);
            }
          }
        }
      }
    }
  }

  const all = [...existing, ...results];
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify({ version: 1, generated: new Date().toISOString().slice(0, 10), count: all.length, challenges: all }, null, 1));
  log(`\nWrote ${all.length} challenges (${results.length} new) to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
