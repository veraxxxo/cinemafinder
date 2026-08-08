// Источник расписания: открытое API KudaGo (без ключа).
//
// Проверено из GitHub Actions: единственный источник, который не режет IP
// дата-центров. Отдаёт сеансы ссылками на id фильма и площадки, поэтому
// справочники подтягиваем отдельно и склеиваем.
//
//   /movie-showings/ → { movie:{id}, place:{id}, datetime, price, imax, ... }
//   /movies/         → { id, title, running_time, genres }
//   /places/         → { id, title, address, coords{lat,lon} }
//
// У площадок KudaGo есть свои координаты — они уходят дальше как подсказка,
// так что сеанс не теряется, даже если в OpenStreetMap такого места нет.

import { getJson } from '../lib/util.mjs';

export const id = 'kudago';
export const title = 'KudaGo';
const API = 'https://kudago.com/public-api/v1.4';
const PAGE = 100;

const slug = (s) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '-').replace(/^-|-$/g, '');

/** Момент времени → дата и время по Москве. */
export function msk(unix) {
  const d = new Date(unix * 1000 + 3 * 3600000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/** Постранично собирает список; на исчерпании KudaGo отвечает 404. */
async function collect(path, params) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const qs = new URLSearchParams({ ...params, page_size: PAGE, page });
    let data;
    try {
      data = await getJson(`${API}${path}?${qs}`, { retries: 2 });
    } catch (err) {
      if (/HTTP 404/.test(err.message)) break; // страниц больше нет
      throw err;
    }
    out.push(...(data.results || []));
    if (!data.next) break;
  }
  return out;
}

/** Справочник по id: KudaGo принимает ids=1,2,3 списком. */
async function lookup(path, ids, fields) {
  const map = new Map();
  const all = [...new Set(ids)].filter(Boolean);
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    const items = await collect(path, { ids: chunk.join(','), fields });
    for (const it of items) map.set(it.id, it);
  }
  return map;
}

/** Формат зала из флагов сеанса. */
export function format(s) {
  const flags = [];
  if (s.imax) flags.push('IMAX');
  if (s.four_dx) flags.push('4DX');
  if (s.three_d) flags.push('3D');
  if (s.original_language) flags.push('ориг. язык');
  return flags.join(' · ');
}

/** «800 руб.» → 800 */
export const price = (p) => {
  const m = /(\d[\d\s]*)/.exec(String(p ?? ''));
  return m ? Number(m[1].replace(/\s/g, '')) || null : null;
};

export async function fetchDates(dates) {
  const since = Math.floor(Date.parse(`${dates[0]}T00:00:00+03:00`) / 1000);
  const until = Math.floor(Date.parse(`${dates.at(-1)}T23:59:59+03:00`) / 1000);

  const showings = await collect('/movie-showings/', {
    location: 'msk',
    actual_since: since,
    actual_until: until,
    fields: 'id,movie,place,datetime,price,three_d,imax,four_dx,original_language',
  });
  console.log(`[${id}] сеансов от API: ${showings.length}`);
  if (!showings.length) return { shows: [], layer: null };

  const [movies, places] = await Promise.all([
    lookup('/movies/', showings.map((s) => s.movie?.id), 'id,title,running_time,genres'),
    lookup('/places/', showings.map((s) => s.place?.id), 'id,title,address,coords,site_url'),
  ]);
  console.log(`[${id}] справочники: фильмов ${movies.size}, площадок ${places.size}`);

  const wanted = new Set(dates);
  const shows = [];

  for (const s of showings) {
    const movie = movies.get(s.movie?.id);
    const place = places.get(s.place?.id);
    if (!movie?.title || !place?.title) continue;

    const { date, time } = msk(s.datetime);
    if (!wanted.has(date)) continue;

    shows.push({
      date,
      time,
      cinemaName: place.title,
      cinemaAddress: place.address || '',
      cinemaCoords: place.coords?.lat ? { lat: place.coords.lat, lon: place.coords.lon } : null,
      cinemaUrl: place.site_url || '',
      movieTitle: movie.title,
      duration: movie.running_time || null,
      genres: (movie.genres || []).map((g) => g.name),
      hall: format(s),
      price: price(s.price),
      url: `https://kudago.com/msk/movie/${s.movie.id}/`,
    });
  }

  return { shows, layer: 'api' };
}

export const normalizeTitle = (t) => String(t).replace(/\s*\(\d{4}\)\s*$/, '').trim();
export const movieKey = (t) => slug(normalizeTitle(t));
