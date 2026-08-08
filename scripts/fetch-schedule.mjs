#!/usr/bin/env node
// Собирает расписание сеансов и сшивает его с кинотеатрами из OpenStreetMap.
// Результат — data/schedule.json.
//
// Площадка сеанса ищется среди кинотеатров OSM по названию. Если совпадения
// нет, но источник дал координаты, площадка едет в extraCinemas — сеанс не
// теряется и всё равно попадает на карту.

import { readFile, writeFile } from 'node:fs/promises';
import * as kudago from './sources/kudago.mjs';
import * as kinoafisha from './sources/kinoafisha.mjs';
import * as kinomax from './sources/kinomax.mjs';
import { mskDate, normName, nameTokens } from './lib/util.mjs';
import { geocode, save as saveGeocode } from './lib/geocode.mjs';

// kinoafisha отдаёт 403 на IP дата-центров: из Actions молча пропускается,
// но локально (с домашнего адреса) добирает то, чего нет в KudaGo.
const SOURCES = [kinoafisha, kinomax, kudago];
const DAYS = Number(process.env.DAYS || 5);

const cinemasFile = new URL('../data/cinemas.json', import.meta.url);
const outFile = new URL('../data/schedule.json', import.meta.url);

const cinemas = JSON.parse(await readFile(cinemasFile, 'utf8')).items;

// ── Сопоставление названий ───────────────────────────────────────────────────

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

  if (!hit && key.length > 3) {
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
console.log(`[schedule] Даты: ${dates.join(', ')}`);

const rawShows = [];
const layers = {};

for (const source of SOURCES) {
  try {
    const { shows, layer } = await source.fetchDates(dates);
    for (const s of shows) rawShows.push({ ...s, source: source.id });
    layers[source.id] = layer || 'нет данных';
    console.log(`[schedule] ${source.id}: ${shows.length} сеансов (${layer || '—'})`);
  } catch (err) {
    layers[source.id] = `ошибка: ${err.message}`;
    console.warn(`[schedule] ${source.id} упал: ${err.message}`);
  }
}

// ── Нормализация ─────────────────────────────────────────────────────────────

const movies = new Map();
const extraCinemas = new Map();
const shows = [];
const unmatched = new Map();
const seen = new Set();

for (const s of rawShows) {
  const source = SOURCES.find((x) => x.id === s.source);
  let cinema = matchCinema(s.cinemaName);

  // Пары в OSM нет — ищем координаты по адресу, а если адреса источник не
  // дал, то по самому названию. Иначе зал молча терялся бы вместе с сеансами.
  if (!cinema && !s.cinemaCoords) {
    const found = await geocode({ name: s.cinemaName, address: s.cinemaAddress || '' });
    if (found) {
      s.cinemaCoords = { lat: found.lat, lon: found.lon };
      s.cinemaAddress = s.cinemaAddress || found.display || '';
    }
  }

  if (!cinema && s.cinemaCoords) {
    // Площадки нет в OSM, но координаты известны — заводим свою запись.
    const id = `x${normName(s.cinemaName).replace(/\s/g, '-')}`;
    if (!extraCinemas.has(id)) {
      extraCinemas.set(id, {
        id,
        name: s.cinemaName,
        lat: +s.cinemaCoords.lat.toFixed(6),
        lon: +s.cinemaCoords.lon.toFixed(6),
        address: s.cinemaAddress || '',
        website: s.cinemaUrl || '',
        source: s.source,
      });
    }
    cinema = extraCinemas.get(id);
  }

  if (!cinema) {
    unmatched.set(s.cinemaName, (unmatched.get(s.cinemaName) || 0) + 1);
    continue;
  }

  const title = source.normalizeTitle(s.movieTitle);
  const mid = source.movieKey(title);
  if (!title || !mid) continue;

  if (!movies.has(mid)) {
    movies.set(mid, {
      id: mid,
      title,
      duration: s.duration || null,
      genres: s.genres || [],
      count: 0,
    });
  }

  const dedupeKey = `${cinema.id}|${mid}|${s.date}|${s.time}`;
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

await saveGeocode();

shows.sort((a, b) => a.d.localeCompare(b.d) || a.t.localeCompare(b.t));

const top = [...unmatched.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
if (top.length) {
  console.warn(`[schedule] Площадки без координат и без пары в OSM (${unmatched.size}):`);
  for (const [name, n] of top) console.warn(`   ${String(n).padStart(4)}  ${name}`);
}

const payload = {
  updated: new Date().toISOString(),
  sources: SOURCES.map((s) => ({ id: s.id, title: s.title })),
  layers,
  dates,
  stats: {
    shows: shows.length,
    movies: movies.size,
    cinemas: new Set(shows.map((s) => s.c)).size,
    extraCinemas: extraCinemas.size,
    unmatchedNames: unmatched.size,
  },
  movies: [...movies.values()].sort((a, b) => b.count - a.count),
  extraCinemas: [...extraCinemas.values()],
  shows,
};

// Не затираем рабочие данные пустым результатом (источник мог лечь).
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
  await writeFile(outFile, JSON.stringify(payload));
  console.log(
    `[schedule] Сохранено: ${shows.length} сеансов, ${movies.size} фильмов, ` +
      `${payload.stats.cinemas} площадок (из них своих ${extraCinemas.size})`,
  );
  if (!shows.length) {
    console.error('[schedule] Ни одного сеанса — источники ничего не дали');
    process.exitCode = 1;
  }
}
