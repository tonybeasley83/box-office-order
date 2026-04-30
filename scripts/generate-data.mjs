/**
 * generate-data.mjs
 * Fetches weekend box office charts from The-Numbers.com and resolves
 * TMDB IDs, then merges results into data/weekends.json.
 *
 * Usage:
 *   node scripts/generate-data.mjs
 *
 * Optional flags:
 *   --from=YYYY   First year to include (default: 1980)
 *   --to=YYYY     Last year to include  (default: current year)
 *   --every=N     Sample every N-th Friday (default: 10)
 *   --dry-run     Print weekends without writing file
 *
 * Requires Node 18+ (built-in fetch).
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT   = path.join(__dir, '..', 'data', 'weekends.json');

const TMDB_KEY  = '29c284fc9104323f8648b188b7c53f26';
const TMDB      = 'https://api.themoviedb.org/3';
const NUMBERS   = 'https://www.the-numbers.com/box-office-chart/weekend';
const DELAY_MS  = 300;   // courtesy delay between requests
const TOP_N     = 5;

// ── CLI args ───────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('='))
);

const FROM    = parseInt(args.from  ?? 1980);
const TO      = parseInt(args.to    ?? new Date().getFullYear());
const EVERY_N = parseInt(args.every ?? 10);
const DRY_RUN = 'dry-run' in args;

// ── Helpers ────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function allFridays(fromYear, toYear) {
  const dates = [];
  const d = new Date(`${fromYear}-01-01T12:00:00Z`);
  // Advance to first Friday
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCFullYear() <= toYear) {
    dates.push(new Date(d));
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return dates;
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekendLabel(fridayDate) {
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const fri = new Date(fridayDate + 'T12:00:00Z');
  const sun = new Date(fri);
  sun.setUTCDate(fri.getUTCDate() + 2);
  const m1 = MONTHS[fri.getUTCMonth()];
  const m2 = MONTHS[sun.getUTCMonth()];
  const d1 = fri.getUTCDate();
  const d2 = sun.getUTCDate();
  const yr = fri.getUTCFullYear();
  if (m1 === m2) return `${m1} ${d1}–${d2}, ${yr}`;
  return `${m1} ${d1} – ${m2} ${d2}, ${yr}`;
}

// ── Fetch weekend chart from The Numbers ──────────────────────────────

async function fetchWeekend(dateStr) {
  const [y, m, d] = dateStr.split('-');
  const url = `${NUMBERS}/${y}/${m}/${d}`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BoxOfficeOrderBot/1.0)' },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    return parseWeekendTable(html);
  } catch {
    return null;
  }
}

function parseWeekendTable(html) {
  // The Numbers renders a <table> with rows: rank, movie, gross, ...
  // Grab all <tr> rows inside the main chart table
  const tableMatch = html.match(/<table[^>]*id="box_office_weekly_chart"[^>]*>([\s\S]*?)<\/table>/i)
    ?? html.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return null;

  const rows = [...tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  const films = [];

  for (const row of rows) {
    if (films.length >= TOP_N) break;
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c =>
      c[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').trim()
    );
    if (cells.length < 3) continue;

    const rank = parseInt(cells[0]);
    if (isNaN(rank) || rank < 1 || rank > TOP_N) continue;

    // Title cell (may be cell 2 or 3 depending on table layout)
    const titleIdx = cells.findIndex((c, i) => i > 0 && c.length > 2 && !/^\$/.test(c) && isNaN(parseInt(c)));
    if (titleIdx < 0) continue;
    const title = cells[titleIdx];

    // Gross: find first "$X,XXX,XXX" pattern
    const grossCell = cells.find(c => /^\$[\d,]+$/.test(c));
    const gross = grossCell ? parseInt(grossCell.replace(/[$,]/g, '')) : 0;

    if (title && gross > 0) {
      films.push({ rank, title, gross });
    }
  }

  return films.length >= TOP_N ? films : null;
}

// ── TMDB search ────────────────────────────────────────────────────────

async function tmdbSearch(title, year) {
  await sleep(DELAY_MS);
  try {
    const q   = encodeURIComponent(title);
    const url = `${TMDB}/search/movie?api_key=${TMDB_KEY}&query=${q}&year=${year}&include_adult=false`;
    const r   = await fetch(url);
    if (!r.ok) return null;
    const d = await r.json();
    return d.results?.[0]?.id ?? null;
  } catch { return null; }
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  // Load existing data
  let existing = { weekends: [] };
  if (fs.existsSync(OUT)) {
    existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  }
  const existingIds = new Set(existing.weekends.map(w => w.id));

  // Generate candidate Fridays
  const allFri = allFridays(FROM, TO);
  const sampled = allFri.filter((_, i) => i % EVERY_N === 0);

  console.log(`Sampling ${sampled.length} Fridays from ${FROM}–${TO} (every ${EVERY_N}th)`);

  const newWeekends = [];

  for (const fri of sampled) {
    const dateStr = fmtDate(fri);
    if (existingIds.has(dateStr)) {
      console.log(`  ${dateStr} — already exists, skipping`);
      continue;
    }

    process.stdout.write(`  ${dateStr} — fetching chart... `);
    const films = await fetchWeekend(dateStr);
    await sleep(DELAY_MS);

    if (!films) {
      console.log('no data');
      continue;
    }

    // Resolve TMDB IDs
    const year = fri.getUTCFullYear();
    const filmData = [];
    for (const f of films) {
      const tmdbId = await tmdbSearch(f.title, year);
      filmData.push({
        rank:         f.rank,
        title:        f.title,
        year,
        weekendGross: f.gross,
        ...(tmdbId ? { tmdbId } : {}),
      });
    }

    const entry = {
      id:    dateStr,
      label: weekendLabel(dateStr),
      films: filmData,
    };

    newWeekends.push(entry);
    console.log(`OK (${films.length} films, e.g. "${films[0].title}")`);
  }

  if (DRY_RUN) {
    console.log('\nDry run — not writing file. New weekends:');
    console.log(JSON.stringify(newWeekends, null, 2));
    return;
  }

  if (newWeekends.length === 0) {
    console.log('\nNothing new to add.');
    return;
  }

  // Merge and sort by date
  const merged = [...existing.weekends, ...newWeekends];
  merged.sort((a, b) => a.id.localeCompare(b.id));

  fs.writeFileSync(OUT, JSON.stringify({ weekends: merged }, null, 2), 'utf8');
  console.log(`\n✓ Added ${newWeekends.length} new weekends. Total: ${merged.length}. Saved to data/weekends.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
