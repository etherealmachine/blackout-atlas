// Blackout Atlas — game logic. No build step; plain ES module.

const ROUNDS = 5;
const DAILY_EVENTS = 4; // + 1 place
const HINT_PENALTY = 0.2; // each extra paragraph removes 20% of the round's max
const MAX_PART = 5000;
const YEAR_MIN = -3000;
const YEAR_MAX = 2025;
const DEFAULT_YEAR = 1500;

// slider position (0..1000) <-> year, piecewise-linear so recent centuries get more room
const SLIDER_KNOTS = [[0, -3000], [100, -500], [225, 1], [350, 1000], [600, 1800], [780, 1900], [1000, 2025]];

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  pool: [],
  mode: 'daily',
  rounds: [],
  idx: 0,
  revealed: 1,
  guess: null,
  year: DEFAULT_YEAR,
  results: [],
  locked: false,
};

// ------------------------------------------------------------------ map ---

// Esri World Street Map: English place names worldwide, no API key needed.
// (OpenStreetMap's own tiles label everything in the local language/script.)
// Dark mode is handled with a CSS filter on the tile pane.
const map = L.map('map', { worldCopyJump: true, minZoom: 1, zoomSnap: 0.5 }).setView([28, 10], 2);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 18,
  attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, OSM',
}).addTo(map);

const pinIcon = (cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}"></div>`, iconSize: [18, 18], iconAnchor: [9, 22] });
let guessMarker = null;
let answerLayer = L.layerGroup().addTo(map);

map.on('click', (e) => {
  if (state.locked) return;
  const ll = e.latlng.wrap();
  state.guess = ll;
  if (!guessMarker) guessMarker = L.marker(ll, { icon: pinIcon('guess'), keyboard: false }).addTo(map);
  else guessMarker.setLatLng(ll);
  $('map-hint').classList.add('hide');
  $('submit-btn').disabled = false;
});

// ------------------------------------------------------------- utilities ---

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const fmtYear = (y) => (y < 0 ? `${-y} BC` : y === 0 ? '1' : String(y));

function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function sliderToYear(p) {
  for (let i = 1; i < SLIDER_KNOTS.length; i++) {
    const [p0, y0] = SLIDER_KNOTS[i - 1], [p1, y1] = SLIDER_KNOTS[i];
    if (p <= p1) return Math.round(y0 + ((p - p0) / (p1 - p0)) * (y1 - y0));
  }
  return YEAR_MAX;
}
function yearToSlider(y) {
  for (let i = 1; i < SLIDER_KNOTS.length; i++) {
    const [p0, y0] = SLIDER_KNOTS[i - 1], [p1, y1] = SLIDER_KNOTS[i];
    if (y <= y1) return p0 + ((y - y0) / (y1 - y0)) * (p1 - p0);
  }
  return 1000;
}
function parseYear(s) {
  const t = s.trim().toUpperCase().replace(/\./g, '').replace(/\s+/g, ' ');
  let m = /^(-?\d{1,4})$/.exec(t);
  if (m) return +m[1];
  m = /^(\d{1,4}) ?(BC|BCE)$/.exec(t);
  if (m) return -m[1];
  m = /^(?:(\d{1,4}) ?(?:AD|CE)|(?:AD|CE) ?(\d{1,4}))$/.exec(t);
  if (m) return +(m[1] || m[2]);
  return null;
}

// --------------------------------------------------------------- scoring ---

function distanceScore(km) {
  if (km <= 25) return MAX_PART;
  return MAX_PART * Math.exp(-(km - 25) / 1500);
}
// Tolerance grows with age: being 50 years off for 400 BC is far better than for 1950.
function timeScore(guess, actual) {
  const diff = Math.abs(guess - actual);
  if (diff === 0) return MAX_PART;
  const k = Math.max(12, (YEAR_MAX - actual) / 10);
  return MAX_PART * Math.exp(-diff / k);
}
const multiplier = (revealed) => Math.max(0.2, 1 - HINT_PENALTY * (revealed - 1));

// ------------------------------------------------------------- rendering ---

function renderText(clue, reveal) {
  const { text, redactions } = clue;
  let html = '', pos = 0;
  for (const [s, e] of redactions) {
    html += esc(text.slice(pos, s));
    const word = text.slice(s, e);
    html += reveal
      ? `<mark class="unbar">${esc(word)}</mark>`
      : `<span class="bar" style="width:${(word.length * 0.52).toFixed(2)}em" title="${word.length} characters" aria-label="redacted, ${word.length} characters"></span>`;
    pos = e;
  }
  return html + esc(text.slice(pos));
}

function renderClues(reveal = false, animateLast = false) {
  const ch = state.rounds[state.idx];
  const shown = reveal ? ch.clues.length : state.revealed;
  $('clues').innerHTML = ch.clues.slice(0, shown)
    .map((c, i) => `<p class="clue${animateLast && i === shown - 1 ? ' new' : ''}">${renderText(c, reveal)}</p>`)
    .join('');
  $('clue-count').textContent = reveal ? `${ch.clues.length} paragraphs` : `Paragraph ${state.revealed} of ${ch.clues.length}`;
  const more = $('more-btn');
  more.hidden = reveal;
  more.disabled = state.revealed >= ch.clues.length;
  $('more-cost').textContent = more.disabled ? '' : `(max → ${Math.round(multiplier(state.revealed + 1) * 100)}%)`;
}

function setYear(y, fromSlider = false) {
  y = Math.max(YEAR_MIN, Math.min(YEAR_MAX, Math.round(y)));
  if (y === 0) y = state.year < 0 ? 1 : -1;
  state.year = y;
  $('year-input').value = fmtYear(y);
  $('year-input').classList.remove('invalid');
  if (!fromSlider) $('year-slider').value = yearToSlider(y);
}

function startRound() {
  const ch = state.rounds[state.idx];
  state.revealed = 1;
  state.guess = null;
  state.locked = false;
  answerLayer.clearLayers();
  if (guessMarker) { guessMarker.remove(); guessMarker = null; }
  map.setView([28, 10], 2);

  $('round-num').textContent = state.idx + 1;
  $('round-total').textContent = state.rounds.length;
  $('total-score').textContent = fmt(state.results.reduce((n, r) => n + r.total, 0));
  $('category').textContent = ch.category;
  $('title').hidden = true;
  $('wiki-link').hidden = true;
  renderClues(false);

  const isEvent = ch.year != null;
  $('timeline').hidden = !isEvent;
  $('place-note').hidden = isEvent;
  setYear(DEFAULT_YEAR);
  $('actions').hidden = false;
  $('submit-btn').disabled = true;
  $('result').hidden = true;
  $('map-hint').classList.remove('hide');
  $('map-hint').textContent = 'Click the map to drop a pin';
  document.querySelector('.dossier').scrollTop = 0;
  requestAnimationFrame(() => map.invalidateSize());
}

function submitGuess() {
  if (!state.guess || state.locked) return;
  state.locked = true;
  const ch = state.rounds[state.idx];
  const answer = L.latLng(ch.lat, ch.lng);
  const km = haversineKm(state.guess, answer);
  const isEvent = ch.year != null;
  const distPts = distanceScore(km) * (isEvent ? 1 : 2);
  const yearPts = isEvent ? timeScore(state.year, ch.year) : 0;
  const mult = multiplier(state.revealed);
  const total = Math.round((distPts + yearPts) * mult);
  const result = {
    id: ch.id, title: ch.title, url: ch.url, km: Math.round(km),
    distPts: Math.round(distPts), yearPts: Math.round(yearPts),
    guessYear: isEvent ? state.year : null, year: ch.year, mult, total, revealed: state.revealed,
  };
  state.results.push(result);
  persist();

  // map
  L.marker(answer, { icon: pinIcon('answer'), keyboard: false }).addTo(answerLayer)
    .bindTooltip(esc(ch.title), { direction: 'top', offset: [0, -20] });
  // draw the line along the shorter way round
  let gLng = state.guess.lng;
  if (gLng - ch.lng > 180) gLng -= 360; else if (ch.lng - gLng > 180) gLng += 360;
  const g = L.latLng(state.guess.lat, gLng);
  guessMarker.setLatLng(g);
  L.polyline([g, answer], { color: '#c2410c', weight: 2, dashArray: '6 6' }).addTo(answerLayer);
  map.fitBounds(L.latLngBounds([g, answer]), { padding: [60, 60], maxZoom: 7 });
  $('map-hint').textContent = `${ch.title}`;
  $('map-hint').classList.remove('hide');

  // dossier
  $('title').textContent = ch.title;
  $('title').hidden = false;
  $('wiki-link').href = ch.url;
  $('wiki-link').hidden = false;
  renderClues(true);

  // result panel
  $('actions').hidden = true;
  $('timeline').hidden = true;
  $('place-note').hidden = true;
  $('r-dist').textContent = km < 1 ? '< 1 km' : `${fmt(km)} km`;
  $('r-dist-pts').textContent = `${fmt(distPts)} pts${isEvent ? '' : ' (×2)'}`;
  $('r-time-box').hidden = !isEvent;
  if (isEvent) {
    const diff = Math.abs(state.year - ch.year);
    $('r-year').textContent = fmtYear(ch.year);
    $('r-year-pts').textContent = diff === 0 ? `spot on · ${fmt(yearPts)} pts` : `you said ${fmtYear(state.year)} · ${fmt(yearPts)} pts`;
  }
  $('r-total').textContent = fmt(total);
  $('r-mult').textContent = mult < 1 ? `×${mult.toFixed(1)} for ${state.revealed} paragraphs` : 'no extra paragraphs';
  $('next-btn').textContent = state.idx + 1 < state.rounds.length ? 'Next round →' : 'See results →';
  $('result').hidden = false;
  $('total-score').textContent = fmt(state.results.reduce((n, r) => n + r.total, 0));
  requestAnimationFrame(() => map.invalidateSize());
  // (no auto-focus on Next: the Enter that submitted would also "click" it on keyup)
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

function nextRound() {
  if (!state.locked) return; // guard against double-advance
  if (state.idx + 1 < state.rounds.length) {
    state.idx++;
    startRound();
  } else {
    showSummary();
  }
}

const emoji = (r) => (r.total >= 8000 ? '🟩' : r.total >= 5000 ? '🟨' : r.total >= 2000 ? '🟧' : '🟥');

function showSummary() {
  const total = state.results.reduce((n, r) => n + r.total, 0);
  $('s-total').textContent = fmt(total);
  $('s-max').textContent = fmt(state.rounds.length * MAX_PART * 2);
  $('s-rounds').innerHTML = state.results.map((r) => `
    <li><span>${emoji(r)}</span><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>
    <span class="pts">${fmt(r.km)} km${r.year != null ? ` · ${r.guessYear === r.year ? 'exact' : `${fmt(Math.abs(r.guessYear - r.year))} yr off`}` : ''} · ${fmt(r.total)}</span></li>`).join('');
  $('s-note').textContent = state.mode === 'daily' ? 'A new daily set unlocks at midnight (local time).' : '';
  $('summary').showModal();
}

function shareText() {
  const total = state.results.reduce((n, r) => n + r.total, 0);
  const label = state.mode === 'daily' ? `Daily ${todayKey()}` : 'Practice';
  const lines = state.results.map((r) => `${emoji(r)} ${fmt(r.km)} km${r.year != null ? ` · ${Math.abs(r.guessYear - r.year)}y` : ''}`);
  return `Blackout Atlas — ${label}\n${fmt(total)} / ${fmt(state.rounds.length * 10000)}\n${lines.join('\n')}\n${location.origin}${location.pathname}`;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---------------------------------------------------------------- games ---

function dailyRounds() {
  const rand = rng(hashString('blackout-atlas:' + todayKey()));
  const events = shuffle(state.pool.filter((c) => c.year != null), rand);
  const places = shuffle(state.pool.filter((c) => c.year == null), rand);
  const picks = [...events.slice(0, DAILY_EVENTS), ...places.slice(0, ROUNDS - DAILY_EVENTS)];
  return shuffle(picks, rand);
}

function practiceRounds() {
  const seen = new Set(store.get('ba:seen', []));
  let fresh = state.pool.filter((c) => !seen.has(c.id));
  if (fresh.length < ROUNDS) { store.set('ba:seen', []); fresh = state.pool; }
  return shuffle(fresh).slice(0, ROUNDS);
}

function persist() {
  if (state.mode === 'daily') store.set('ba:daily:' + todayKey(), state.results);
  const seen = store.get('ba:seen', []);
  const id = state.rounds[state.idx].id;
  if (!seen.includes(id)) store.set('ba:seen', [...seen, id].slice(-400));
}

function newGame(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  if ($('summary').open) $('summary').close();
  state.results = [];
  state.idx = 0;
  if (mode === 'daily') {
    state.rounds = dailyRounds();
    const saved = store.get('ba:daily:' + todayKey(), []);
    // resume a partly-played daily (results are kept so the set can't be replayed for a better score)
    if (Array.isArray(saved) && saved.length && saved.every((r, i) => r.id === state.rounds[i]?.id)) {
      state.results = saved;
      state.idx = saved.length;
      if (state.idx >= state.rounds.length) {
        state.idx = state.rounds.length - 1;
        startRound();
        state.locked = true;
        $('submit-btn').disabled = true;
        $('total-score').textContent = fmt(state.results.reduce((n, r) => n + r.total, 0));
        showSummary();
        return;
      }
    }
  } else {
    state.rounds = practiceRounds();
  }
  startRound();
}

// --------------------------------------------------------------- wiring ---

$('submit-btn').addEventListener('click', submitGuess);
$('next-btn').addEventListener('click', nextRound);
$('more-btn').addEventListener('click', () => {
  const ch = state.rounds[state.idx];
  if (state.locked || state.revealed >= ch.clues.length) return;
  state.revealed++;
  renderClues(false, true);
  const last = $('clues').lastElementChild;
  last?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('year-slider').addEventListener('input', (e) => setYear(sliderToYear(+e.target.value), true));
$('year-input').addEventListener('change', (e) => {
  const y = parseYear(e.target.value);
  if (y == null) { e.target.classList.add('invalid'); return; }
  setYear(y);
});
$('year-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.target.blur(); }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    setYear(state.year + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1));
  }
});
document.querySelectorAll('.nudge').forEach((b) => b.addEventListener('click', () => {
  let y = state.year + Number(b.dataset.d);
  if (state.year > 0 && y <= 0) y -= 1; else if (state.year < 0 && y >= 0) y += 1; // no year 0
  setYear(y);
}));
document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => newGame(b.dataset.mode)));
$('again-btn').addEventListener('click', () => newGame('practice'));
$('share-btn').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(shareText()); toast('Copied to clipboard'); }
  catch { toast('Could not copy — select and copy manually'); }
});
$('help-btn').addEventListener('click', () => $('help').showModal());
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.repeat || document.querySelector('dialog[open]')) return;
  // let focused buttons, links and the year box handle their own Enter
  if (e.target.closest?.('button, a, input, textarea, select')) return;
  e.preventDefault();
  if (!state.locked && state.guess) submitGuess();
  else if (state.locked && !$('result').hidden) nextRound();
});
window.addEventListener('resize', () => map.invalidateSize());

// ---------------------------------------------------------------- boot ---

(async function boot() {
  try {
    const res = await fetch('data/challenges.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    state.pool = data.challenges.filter((c) => c.clues?.length && Number.isFinite(c.lat));
    if (state.pool.length < ROUNDS) throw new Error('not enough challenges');
  } catch (e) {
    $('clues').innerHTML = `<p class="error">Couldn't load data/challenges.json (${esc(String(e.message || e))}). If you opened this file directly, serve the folder over HTTP instead — see README.</p>`;
    return;
  }
  if (!store.get('ba:seenHelp', false)) { $('help').showModal(); store.set('ba:seenHelp', true); }
  newGame('daily');
})();
