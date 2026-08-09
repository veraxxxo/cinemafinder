#!/usr/bin/env node
// Собирает расписание сеансов и сшивает его с кинотеатрами из OpenStreetMap.
// Результат — data/schedule.json.
//
// Площадка сеанса ищется среди кинотеатров OSM по названию. Если совпадения
// нет, но источник дал координаты, площадка едет в extraCinemas — сеанс не
// теряется и всё равно попадает на карту.

import { readFile, writeFile } from 'node:fs/promises';
import * as kudago from './sources/kudago.mjs';
import * as manual from './sources/manual.mjs';
import * as kinoafisha from './sources/kinoafisha.mjs';
import * as kinomax from './sources/kinomax.mjs';
import { mskDate, normName } from './lib/util.mjs';
import { geocode, save as saveGeocode } from './lib/geocode.mjs';
import { finish as closeFetcher } from './lib/fetcher.mjs';
import { makeCinemaMatcher } from './lib/stitch.mjs';

// kinoafisha отдаёт 403 на IP дата-центров: из Actions молча пропускается,
// но локально (с домашнего адреса) добирает то, чего нет в KudaGo.
const SOURCES = [manual, kinoafisha, kinomax, kudago];
const DAYS = Number(process.env.DAYS || 5);

const cinemasFile = new URL('../data/cinemas.json', import.meta.url);
const outFile = new URL('../data/schedule.json', import.meta.url);

const cinemas = JSON.parse(await readFile(cinemasFile, 'utf8')).items;

// ── Сопоставление названий ───────────────────────────────────────────────────

const matchCinema = makeCinemaMatcher(cinemas);

// Куда какие названия легли — чтобы склейку было видно сразу, а не через
// три дня по странному распределению сеансов на карте.
const landedOn = new Map();

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

// Chromium держит процесс живым: пока он открыт, node не завершится, и джоба
// упирается в таймаут уже после того, как всё собрано и записано. Закрываем
// здесь — когда отработали все источники, и ровно один раз.
await closeFetcher();

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
      s.cinemaApprox = Boolean(found.approx);
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
        // Нашлось как район, а не как здание: булавка стоит в центре района.
        approx: s.cinemaApprox || undefined,
      });
    }
    cinema = extraCinemas.get(id);
  }

  if (!cinema) {
    unmatched.set(s.cinemaName, (unmatched.get(s.cinemaName) || 0) + 1);
    continue;
  }

  if (!landedOn.has(cinema.id)) landedOn.set(cinema.id, new Set());
  landedOn.get(cinema.id).add(s.cinemaName);

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

// Одна точка на карте, несколько разных названий из афиши — почти всегда
// ошибка сшивки: сеансы соседних залов сети сваливаются в одну булавку.
const glued = [...landedOn.entries()].filter(([, names]) => names.size > 1);
if (glued.length) {
  const byId = new Map([...cinemas, ...extraCinemas.values()].map((c) => [c.id, c]));
  console.warn(`[schedule] На одну точку легло несколько названий (${glued.length}):`);
  for (const [cid, names] of glued.sort((a, b) => b[1].size - a[1].size).slice(0, 15)) {
    console.warn(`   ${byId.get(cid)?.name || cid} ← ${[...names].join(' | ')}`);
  }
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
