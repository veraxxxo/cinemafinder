#!/usr/bin/env node
// Собирает расписание сеансов на ближайшие дни и сшивает его с кинотеатрами
// из OpenStreetMap. Результат — data/schedule.json.

import { readFile, writeFile } from 'node:fs/promises';
import * as kinoafisha from './sources/kinoafisha.mjs';
import { mskDate, normName, nameTokens } from './lib/util.mjs';

const SOURCES = [kinoafisha];
const DAYS = Number(process.env.DAYS || 5);

const cinemasFile = new URL('../data/cinemas.json', import.meta.url);
const outFile = new URL('../data/schedule.json', import.meta.url);

const cinemas = JSON.parse(await readFile(cinemasFile, 'utf8')).items;

// ── Сопоставление названий кинотеатров ───────────────────────────────────────
// Афиша и OSM называют одни и те же места по-разному («КАРО 11 Октябрь» /
// «Октябрь»). Сначала точное совпадение нормализованных строк, затем — по
// пересечению значимых слов.

const exact = new Map();
for (const c of cinemas) {
  const key = normName(c.name);
  if (key && !exact.has(key)) exact.set(key, c);
}
const tokenIndex = cinemas.map((c) => ({ c, tokens: nameTokens(c.name) }));

const matchCache = new Map();

function matchCinema(rawName) {
  if (matchCache.has(rawName)) return matchCache.get(rawName);

  const key = normName(rawName);
  let hit = exact.get(key) || null;

  if (!hit && key) {
    // подстрока в обе стороны
    for (const [k, c] of exact) {
      if (k.length > 3 && (k.includes(key) || key.includes(k))) {
        hit = c;
        break;
      }
    }
  }

  if (!hit) {
    const want = nameTokens(rawName);
    let best = null;
    let bestScore = 0;
    for (const { c, tokens } of tokenIndex) {
      let shared = 0;
      for (const t of want) if (tokens.has(t)) shared++;
      const score = shared / Math.max(1, Math.min(want.size, tokens.size));
      if (shared && score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (bestScore >= 0.6) hit = best;
  }

  matchCache.set(rawName, hit);
  return hit;
}

// ── Сбор ─────────────────────────────────────────────────────────────────────

const dates = Array.from({ length: DAYS }, (_, i) => mskDate(i));
const rawShows = [];
const layers = {};

for (const source of SOURCES) {
  for (const date of dates) {
    try {
      const { shows, layer } = await source.fetchDate(date);
      for (const s of shows) rawShows.push({ ...s, source: source.id });
      if (layer) layers[`${source.id}:${date}`] = layer;
    } catch (err) {
      console.warn(`[schedule] ${source.id} ${date}: ${err.message}`);
    }
  }
}

console.log(`[schedule] Сырых сеансов: ${rawShows.length}`);

// ── Нормализация ─────────────────────────────────────────────────────────────

const movies = new Map();
const shows = [];
const unmatched = new Map();
const seen = new Set();

for (const s of rawShows) {
  const cinema = matchCinema(s.cinemaName);
  if (!cinema) {
    unmatched.set(s.cinemaName, (unmatched.get(s.cinemaName) || 0) + 1);
    continue;
  }

  const source = SOURCES.find((x) => x.id === s.source) || kinoafisha;
  const title = source.normalizeTitle(s.movieTitle);
  const mid = source.movieKey(title);
  if (!title || !mid) continue;

  if (!movies.has(mid)) movies.set(mid, { id: mid, title, count: 0 });

  const dedupeKey = `${cinema.id}|${mid}|${s.date}|${s.time}|${s.hall}`;
  if (seen.has(dedupeKey)) continue;
  seen.add(dedupeKey);

  movies.get(mid).count++;
  shows.push({
    c: cinema.id,
    m: mid,
    d: s.date,
    t: s.time,
    hall: s.hall || undefined,
    price: s.price || undefined,
    url: s.url || undefined,
  });
}

shows.sort((a, b) => a.d.localeCompare(b.d) || a.t.localeCompare(b.t));

const top = [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
if (top.length) {
  console.warn(`[schedule] Не сопоставлено с OSM (${unmatched.size} названий):`);
  for (const [name, n] of top) console.warn(`   ${n.toString().padStart(4)}  ${name}`);
}

const payload = {
  updated: new Date().toISOString(),
  sources: SOURCES.map((s) => ({ id: s.id, title: s.title })),
  layers,
  dates: [...new Set(shows.map((s) => s.d))].sort(),
  stats: {
    shows: shows.length,
    movies: movies.size,
    cinemas: new Set(shows.map((s) => s.c)).size,
    unmatchedNames: unmatched.size,
  },
  movies: [...movies.values()].sort((a, b) => b.count - a.count),
  shows,
};

// Не затираем рабочие данные пустым результатом (сайт мог лечь).
let previous = null;
try {
  previous = JSON.parse(await readFile(outFile, 'utf8'));
} catch {
  /* первого файла ещё нет */
}

if (!shows.length && previous?.shows?.length) {
  console.error('[schedule] Пустой результат — оставляю прежнее расписание');
  process.exitCode = 1;
} else {
  await writeFile(outFile, JSON.stringify(payload, null, 0));
  console.log(
    `[schedule] Сохранено: ${shows.length} сеансов, ${movies.size} фильмов, ` +
      `${payload.stats.cinemas} кинотеатров, даты ${payload.dates.join(', ') || '—'}`,
  );
  if (!shows.length) process.exitCode = 1;
}
