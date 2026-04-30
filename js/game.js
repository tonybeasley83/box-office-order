const TMDB_KEY  = '29c284fc9104323f8648b188b7c53f26';
const TMDB      = 'https://api.themoviedb.org/3';
const TMDB_IMG  = 'https://image.tmdb.org/t/p';
const LS_KEY    = 'boxofficeorder_v3';
const MAX_PTS   = 15;  // 5 films × 3 pts max each

// ── State ──────────────────────────────────────────────────────────────
// slots[i]  = movieIdx placed in rank slot i (null = empty)
// pool      = movieIdx[] of unplaced films
// locked[i] = true once slot i is confirmed correct
// history   = per-attempt result rows: each row is 5 values: true/false/null
//             true = correct this attempt, false = wrong, null = already locked
const state = {
  weekend:    null,
  movies:     [],
  slots:      [null, null, null, null, null],
  pool:       [],
  locked:     [false, false, false, false, false],
  attempt:    1,
  totalScore: 0,
  history:    [],
  phase:      'playing',   // 'playing' | 'complete'
};

// ── Scoring ────────────────────────────────────────────────────────────
// Attempt 1 = 3 pts each  →  max 15
// Attempt 2 = 2 pts each  →  max 10 for remaining
// Attempt 3 = 1 pt  each  →  max  5 for remaining
// Attempt 4+ = 0 pts (puzzle still completable)
function ptsFor(attempt) { return Math.max(0, 4 - attempt); }

// ── Entry ──────────────────────────────────────────────────────────────

async function init() {
  try {
    const resp = await fetch('./data/weekends.json');
    if (!resp.ok) throw new Error('fetch failed');
    const data = await resp.json();
    if (!data.weekends?.length) { showError(); return; }

    const today = todayKey();
    const idx   = dateHash(today) % data.weekends.length;
    state.weekend = data.weekends[idx];

    const saved = loadSave();
    if (saved?.dateKey === today && saved?.weekendId === state.weekend.id) {
      state.movies     = saved.movies;
      state.slots      = saved.slots;
      state.history    = saved.history;
      state.totalScore = saved.totalScore;
      state.locked     = [true, true, true, true, true];
      state.pool       = [];
      state.phase      = 'complete';
      showResults();
      return;
    }

    state.movies = await fetchMovies(state.weekend.films);
    state.pool   = shuffle([0, 1, 2, 3, 4]);
    showGame();

  } catch (err) {
    console.error(err);
    showError();
  }
}

// ── Date helpers ───────────────────────────────────────────────────────

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function dateHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33 ^ str.charCodeAt(i)) >>> 0;
  return h;
}

// ── TMDB ───────────────────────────────────────────────────────────────

async function fetchMovies(films) {
  const raw = await Promise.all(films.map(fetchOne));
  raw.sort((a, b) => a.rank - b.rank);
  return raw;
}

async function fetchOne(film) {
  try {
    let id = film.tmdbId ?? null;
    if (!id) id = await tmdbSearch(film.title, film.year);
    if (!id) return fallback(film);

    const r = await fetch(`${TMDB}/movie/${id}?api_key=${TMDB_KEY}&append_to_response=credits`);
    if (!r.ok) return fallback(film);
    const d = await r.json();

    const director = d.credits?.crew?.find(c => c.job === 'Director');
    return {
      rank:         film.rank,
      weekendGross: film.weekendGross,
      title:        d.title        || film.title,
      tagline:      d.tagline      || '',
      releaseDate:  d.release_date || '',
      studio:       d.production_companies?.[0]?.name || '',
      director:     director?.name || '',
      cast:         (d.credits?.cast ?? []).slice(0, 3).map(a => a.name),
      posterPath:   d.poster_path  || null,
    };
  } catch { return fallback(film); }
}

async function tmdbSearch(title, year) {
  try {
    const r = await fetch(
      `${TMDB}/search/movie?api_key=${TMDB_KEY}&query=${encodeURIComponent(title)}&year=${year}&include_adult=false`
    );
    if (!r.ok) return null;
    return (await r.json()).results?.[0]?.id ?? null;
  } catch { return null; }
}

function fallback(film) {
  return { rank: film.rank, weekendGross: film.weekendGross, title: film.title,
           tagline: '', releaseDate: film.year ? `${film.year}-01-01` : '',
           studio: '', director: '', cast: [], posterPath: null };
}

// ── Helpers ────────────────────────────────────────────────────────────

function weeksOut(releaseDate, weekendId) {
  if (!releaseDate || !weekendId) return '';
  const days = Math.round(
    (new Date(weekendId + 'T12:00:00Z') - new Date(releaseDate + 'T12:00:00Z')) / 86400000
  );
  if (days < 0)  return '';
  if (days < 7)  return 'Opening Weekend';
  return `Week ${Math.floor(days / 7) + 1}`;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.every((v, i) => v === i) ? shuffle(arr) : a;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function posterUrl(path, size) { return path ? `${TMDB_IMG}/${size}${path}` : null; }

function fmtGross(n) {
  if (!n) return '';
  if (n >= 1e8) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e6) return '$' + Math.round(n / 1e6) + 'M';
  return '$' + n.toLocaleString();
}

// ── UI state ───────────────────────────────────────────────────────────

function setVisible(id) {
  ['loading','game','results','error-state'].forEach(x =>
    document.getElementById(x).classList[x === id ? 'remove' : 'add']('hidden')
  );
}
function showError() { setVisible('error-state'); }

function showGame() {
  setVisible('game');
  document.getElementById('weekend-date').textContent = state.weekend.label;

  // Build 5 static slot containers once
  const col = document.getElementById('slots-col');
  col.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const s = document.createElement('div');
    s.className = 'slot';
    s.dataset.slotIdx = i;
    col.appendChild(s);
  }

  updateAttemptBar();
  render();
  setupDnd();
  setupTouch();
  document.getElementById('submit-btn').addEventListener('click', submitGuess);
}

function showResults() {
  setVisible('results');
  document.getElementById('results-date').textContent = state.weekend.label;

  // Perfect-score label
  const numEl = document.getElementById('score-num');
  numEl.textContent = state.totalScore;
  numEl.classList.toggle('perfect', state.totalScore === MAX_PTS);

  renderAttemptHistory();
  renderResultRows();

  const shareBtn = document.getElementById('share-btn');
  shareBtn.replaceWith(shareBtn.cloneNode(true));
  document.getElementById('share-btn').addEventListener('click', share);
}

// ── Render ─────────────────────────────────────────────────────────────

function render() {
  renderSlots();
  renderPool();
  updateSubmitState();
}

function renderSlots() {
  for (let i = 0; i < 5; i++) {
    const slotEl   = document.querySelector(`.slot[data-slot-idx="${i}"]`);
    const movieIdx = state.slots[i];
    const isLocked = state.locked[i];

    slotEl.innerHTML = `<div class="slot-num">#${i + 1}</div>`;

    if (isLocked) {
      slotEl.classList.add('filled', 'locked');
      const movie = state.movies[movieIdx];
      const src   = posterUrl(movie.posterPath, 'w45');
      const filled = document.createElement('div');
      filled.className = 'slot-filled';   // not draggable
      filled.innerHTML = `
        ${src ? `<img src="${src}" class="slot-poster" alt="" loading="lazy">`
              : `<div class="slot-poster-empty"></div>`}
        <span class="slot-title">${esc(movie.title)}</span>
      `;
      slotEl.appendChild(filled);
      const check = document.createElement('span');
      check.className = 'slot-check';
      check.textContent = '✓';
      slotEl.appendChild(check);

    } else if (movieIdx !== null) {
      slotEl.classList.add('filled');
      slotEl.classList.remove('locked');
      const movie = state.movies[movieIdx];
      const src   = posterUrl(movie.posterPath, 'w45');
      const filled = document.createElement('div');
      filled.className = 'slot-filled';
      filled.setAttribute('draggable', 'true');
      filled.dataset.srcSlot  = i;
      filled.dataset.movieIdx = movieIdx;
      filled.innerHTML = `
        ${src ? `<img src="${src}" class="slot-poster" alt="" loading="lazy">`
              : `<div class="slot-poster-empty"></div>`}
        <span class="slot-title">${esc(movie.title)}</span>
      `;
      slotEl.appendChild(filled);
      const removeBtn = document.createElement('button');
      removeBtn.className = 'slot-remove';
      removeBtn.dataset.slotIdx = i;
      removeBtn.setAttribute('aria-label', 'Remove film');
      removeBtn.textContent = '×';
      slotEl.appendChild(removeBtn);

    } else {
      slotEl.classList.remove('filled', 'locked');
      slotEl.insertAdjacentHTML('beforeend', `<div class="slot-placeholder">Drop a film here</div>`);
    }
  }
}

function renderPool() {
  const col = document.getElementById('pool-col');
  col.innerHTML = '';
  state.pool.forEach(movieIdx => col.appendChild(makeFilmCard(state.movies[movieIdx], movieIdx)));
}

function makeFilmCard(movie, movieIdx) {
  const card = document.createElement('div');
  card.className = 'film-card';
  card.setAttribute('draggable', 'true');
  card.dataset.movieIdx = movieIdx;

  const src  = posterUrl(movie.posterPath, 'w92');
  const year = movie.releaseDate ? new Date(movie.releaseDate + 'T12:00:00Z').getFullYear() : '';
  const week = weeksOut(movie.releaseDate, state.weekend.id);

  card.innerHTML = `
    <div class="film-poster-wrap">
      ${src ? `<img src="${src}" class="film-poster" alt="${esc(movie.title)} poster" loading="lazy">`
            : `<div class="film-poster-empty">🎬</div>`}
    </div>
    <div class="film-info">
      <div class="film-title">
        ${esc(movie.title)}${year ? ` <span class="film-year">(${year})</span>` : ''}
      </div>
      ${week ? `<span class="film-week">${week}</span>` : ''}
      ${movie.tagline   ? `<div class="film-tagline">&ldquo;${esc(movie.tagline)}&rdquo;</div>` : ''}
      ${(movie.studio || movie.director) ? `
        <div class="film-meta">
          ${movie.studio   ? `<span class="film-studio">${esc(movie.studio)}</span>`   : ''}
          ${movie.director ? `<span class="film-director">${esc(movie.director)}</span>` : ''}
        </div>` : ''}
      ${movie.cast.length ? `<div class="film-cast">${esc(movie.cast.join(' · '))}</div>` : ''}
    </div>
  `;
  return card;
}

function updateSubmitState() {
  const allPlaced = state.pool.length === 0;
  document.getElementById('submit-btn').disabled = !allPlaced;
  const hint = document.getElementById('submit-hint');
  if (hint) hint.style.visibility = allPlaced ? 'hidden' : 'visible';
}

function updateAttemptBar() {
  document.getElementById('attempt-label').textContent = `ATTEMPT ${state.attempt}`;
  document.getElementById('score-running').textContent =
    state.totalScore > 0 ? `${state.totalScore} / ${MAX_PTS} pts` : `${MAX_PTS} pts available`;
}

// ── Drop logic ─────────────────────────────────────────────────────────

function handleDrop(srcPayload, dstSlotIdx) {
  if (dstSlotIdx == null) return;
  if (state.locked[dstSlotIdx]) return;  // cannot place into a locked slot

  if (srcPayload.type === 'pool') {
    const { movieIdx } = srcPayload;
    const poolPos = state.pool.indexOf(movieIdx);
    if (poolPos < 0) return;
    state.pool.splice(poolPos, 1);
    if (state.slots[dstSlotIdx] !== null) state.pool.push(state.slots[dstSlotIdx]);
    state.slots[dstSlotIdx] = movieIdx;

  } else {  // type === 'slot'
    const { slotIdx: srcSlot } = srcPayload;
    if (srcSlot === dstSlotIdx) return;
    if (state.locked[srcSlot]) return;
    [state.slots[srcSlot], state.slots[dstSlotIdx]] =
      [state.slots[dstSlotIdx], state.slots[srcSlot]];
  }

  render();
}

function removeFromSlot(slotIdx) {
  if (state.locked[slotIdx]) return;
  const movieIdx = state.slots[slotIdx];
  if (movieIdx === null) return;
  state.pool.push(movieIdx);
  state.slots[slotIdx] = null;
  render();
}

// ── Submit / evaluate ──────────────────────────────────────────────────

function submitGuess() {
  if (state.pool.length > 0) return;  // guard
  evaluateAttempt();
}

function evaluateAttempt() {
  const pts = ptsFor(state.attempt);
  const row = [];

  for (let i = 0; i < 5; i++) {
    if (state.locked[i]) { row.push(null); continue; }

    const placed  = state.slots[i];
    const correct = placed === i;
    row.push(correct);

    if (correct) {
      state.locked[i]   = true;
      state.totalScore += pts;
    } else {
      if (placed !== null) { state.pool.push(placed); }
      state.slots[i] = null;
    }
  }

  state.history.push(row);
  state.attempt++;

  if (state.locked.every(Boolean)) {
    state.phase = 'complete';
    saveSave({
      dateKey:    todayKey(),
      weekendId:  state.weekend.id,
      movies:     state.movies,
      slots:      state.slots,
      history:    state.history,
      totalScore: state.totalScore,
    });
    showResults();
  } else {
    render();
    updateAttemptBar();
  }
}

// ── HTML5 Drag-and-Drop ────────────────────────────────────────────────

let dndPayload = null;

function setupDnd() {
  const layout = document.getElementById('game-layout');

  layout.addEventListener('dragstart', e => {
    const card   = e.target.closest('.film-card');
    const filled = e.target.closest('.slot-filled[draggable]');
    if (card) {
      dndPayload = { type: 'pool', movieIdx: +card.dataset.movieIdx };
      card.classList.add('dragging');
    } else if (filled && !state.locked[+filled.dataset.srcSlot]) {
      dndPayload = { type: 'slot', slotIdx: +filled.dataset.srcSlot };
      filled.classList.add('dragging');
    } else { return; }
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(dndPayload));
  });

  layout.addEventListener('dragend', () => {
    dndPayload = null;
    layout.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'));
    layout.querySelectorAll('.slot.drag-over').forEach(el => el.classList.remove('drag-over'));
  });

  layout.addEventListener('dragover', e => {
    const slot = e.target.closest('.slot');
    if (!slot || state.locked[+slot.dataset.slotIdx]) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    layout.querySelectorAll('.slot.drag-over').forEach(el => el.classList.remove('drag-over'));
    slot.classList.add('drag-over');
  });

  layout.addEventListener('dragleave', e => {
    const slot = e.target.closest('.slot');
    if (slot && !slot.contains(e.relatedTarget)) slot.classList.remove('drag-over');
  });

  layout.addEventListener('drop', e => {
    e.preventDefault();
    const slot = e.target.closest('.slot');
    if (!slot || !dndPayload) return;
    slot.classList.remove('drag-over');
    handleDrop(dndPayload, +slot.dataset.slotIdx);
    dndPayload = null;
  });

  // X button: event delegation on slots column
  document.getElementById('slots-col').addEventListener('click', e => {
    const btn = e.target.closest('.slot-remove');
    if (btn) removeFromSlot(+btn.dataset.slotIdx);
  });
}

// ── Touch drag ─────────────────────────────────────────────────────────

let touchDrag  = null;
let touchReady = false;

function setupTouch() {
  if (touchReady) return;
  touchReady = true;
  const layout = document.getElementById('game-layout');
  layout.addEventListener('touchstart', onTouchStart, { passive: false });
  layout.addEventListener('touchmove',  onTouchMove,  { passive: false });
  layout.addEventListener('touchend',   onTouchEnd,   { passive: false });
}

function onTouchStart(e) {
  if (e.target.closest('.slot-remove')) return;
  const card   = e.target.closest('.film-card');
  const filled = e.target.closest('.slot-filled');
  const src    = card || filled;
  if (!src) return;
  if (filled && state.locked[+filled.dataset.srcSlot]) return;

  e.preventDefault();
  const t0   = e.touches[0];
  const rect = src.getBoundingClientRect();
  const payload = card
    ? { type: 'pool', movieIdx: +card.dataset.movieIdx }
    : { type: 'slot', slotIdx:  +filled.dataset.srcSlot };

  const ghost = src.cloneNode(true);
  Object.assign(ghost.style, {
    position: 'fixed', top: rect.top + 'px', left: rect.left + 'px',
    width: rect.width + 'px', zIndex: '1000', pointerEvents: 'none',
    opacity: '0.9', boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
    transform: 'scale(1.03)', transition: 'none', margin: '0',
  });
  document.body.appendChild(ghost);
  src.classList.add('dragging');
  touchDrag = { payload, ghost, src, offsetY: t0.clientY - rect.top, targetSlotIdx: null };
}

function onTouchMove(e) {
  if (!touchDrag) return;
  e.preventDefault();
  const t0 = e.touches[0];
  touchDrag.ghost.style.top = (t0.clientY - touchDrag.offsetY) + 'px';

  touchDrag.ghost.style.display = 'none';
  const el = document.elementFromPoint(t0.clientX, t0.clientY);
  touchDrag.ghost.style.display = '';

  document.querySelectorAll('.slot.drag-over').forEach(s => s.classList.remove('drag-over'));
  const targetSlot = el?.closest('.slot');
  if (targetSlot && !state.locked[+targetSlot.dataset.slotIdx]) {
    targetSlot.classList.add('drag-over');
    touchDrag.targetSlotIdx = +targetSlot.dataset.slotIdx;
  } else {
    touchDrag.targetSlotIdx = null;
  }
}

function onTouchEnd(e) {
  if (!touchDrag) return;
  e.preventDefault();
  touchDrag.ghost.remove();
  touchDrag.src.classList.remove('dragging');
  document.querySelectorAll('.slot.drag-over').forEach(s => s.classList.remove('drag-over'));
  const { payload, targetSlotIdx } = touchDrag;
  touchDrag = null;
  if (targetSlotIdx !== null) handleDrop(payload, targetSlotIdx);
}

// ── Results ────────────────────────────────────────────────────────────

function renderAttemptHistory() {
  const container = document.getElementById('attempt-history');
  container.innerHTML = '';

  state.history.forEach((row, idx) => {
    const attemptNum = idx + 1;
    const pts        = ptsFor(attemptNum);
    const ptsEarned  = row.filter(r => r === true).length * pts;

    const squares = row.map(r =>
      r === null ? '⬜' : r ? '🟩' : '🟥'
    ).join('');

    const div = document.createElement('div');
    div.className = 'attempt-row';
    div.innerHTML = `
      <span class="attempt-row-label">TRY ${attemptNum}</span>
      <span class="attempt-squares">${squares}</span>
      ${ptsEarned > 0
        ? `<span class="attempt-pts">+${ptsEarned} pt${ptsEarned !== 1 ? 's' : ''}</span>`
        : `<span class="attempt-pts" style="color:var(--text-muted)">+0 pts</span>`}
    `;
    container.appendChild(div);
  });
}

function renderResultRows() {
  const list = document.getElementById('results-list');
  list.innerHTML = '';

  state.movies.forEach((movie, movieIdx) => {
    const placedMovieIdx = state.slots[movieIdx];
    const ok = placedMovieIdx === movieIdx;
    const src = posterUrl(movie.posterPath, 'w92');

    const row = document.createElement('div');
    row.className = `result-row ${ok ? 'correct' : 'wrong'}`;
    row.setAttribute('role', 'listitem');

    const playerNote = !ok && placedMovieIdx != null
      ? `<div class="result-player-rank wrong-rank">
           You placed: ${esc(state.movies[placedMovieIdx]?.title ?? '?')}
         </div>`
      : '';

    row.innerHTML = `
      ${src ? `<img src="${src}" class="result-poster" alt="" loading="lazy">`
            : `<div class="result-poster-empty"></div>`}
      <div class="result-icon">${ok ? '✅' : '❌'}</div>
      <div class="result-info">
        <div class="result-rank-label">RANK #${movieIdx + 1}</div>
        <div class="result-title">${esc(movie.title)}</div>
        ${playerNote}
      </div>
      <div class="result-gross">${fmtGross(movie.weekendGross)}</div>
    `;
    list.appendChild(row);
  });
}

// ── Share ──────────────────────────────────────────────────────────────

function share() {
  const lines = [`Box Office Order – ${state.weekend.label}`];
  state.history.forEach((row, idx) => {
    const squares = row.map(r => r === null ? '⬜' : r ? '🟩' : '🟥').join('');
    lines.push(squares);
  });
  lines.push(`Score: ${state.totalScore}/${MAX_PTS}`);
  const text = lines.join('\n');
  navigator.clipboard?.writeText(text).then(showToast).catch(() => window.prompt('Copy:', text))
    ?? window.prompt('Copy:', text);
}

function showToast() {
  const t = document.getElementById('share-toast');
  t.classList.remove('hidden','fade-out');
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.classList.add('hidden'), 600); }, 1800);
}

// ── Storage ────────────────────────────────────────────────────────────

function saveSave(d) { try { localStorage.setItem(LS_KEY, JSON.stringify(d)); } catch {} }
function loadSave()  { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; } }

// ── Go ─────────────────────────────────────────────────────────────────
init();
