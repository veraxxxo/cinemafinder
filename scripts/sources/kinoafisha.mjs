// Источник расписания: kinoafisha.info (Москва).
//
// Стратегия устойчивого парсинга — от самого надёжного к самому хрупкому:
//   1. Встроенное состояние SPA (__NEXT_DATA__ / __INITIAL_STATE__)
//   2. Разметка Schema.org (JSON-LD: Movie / ScreeningEvent)
//   3. Разбор HTML регулярками по data-атрибутам
// Если структура сайта поменяется, обычно выживает хотя бы один уровень.

import { getText, jsonLd, embeddedState, deepFind, stripTags } from '../lib/util.mjs';

export const id = 'kinoafisha';
export const title = 'Кино Афиша';
const BASE = 'https://www.kinoafisha.info';
const CITY = 'msk';

/** Страницы, с которых пробуем снять расписание на конкретную дату. */
const scheduleUrls = (date) => [
  `${BASE}/russia/${CITY}/schedule/?date=${date}`,
  `${BASE}/russia/${CITY}/schedule/`,
  `${BASE}/rasp/?city=${CITY}&date=${date}`,
  `${BASE}/${CITY}/schedule/?date=${date}`,
];

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Уровень 1: состояние SPA. */
export function fromState(html, date) {
  const state = embeddedState(html);
  if (!state) return [];

  // Ищем узлы, похожие на сеанс: есть время и ссылка на кинотеатр/фильм.
  const nodes = deepFind(
    state,
    (n) =>
      !Array.isArray(n) &&
      typeof n.time === 'string' &&
      /^\d{1,2}:\d{2}$/.test(n.time) &&
      (n.cinemaId || n.cinema || n.placeId || n.hall),
  );

  return nodes
    .map((n) => ({
      date,
      time: n.time,
      cinemaName: n.cinemaName || n.cinema?.name || n.place?.name || '',
      cinemaId: String(n.cinemaId ?? n.cinema?.id ?? n.placeId ?? ''),
      movieTitle: n.movieName || n.movie?.name || n.movie?.title || n.filmName || '',
      movieId: String(n.movieId ?? n.movie?.id ?? ''),
      hall: (typeof n.hall === 'string' ? n.hall : n.hall?.name) || n.hallName || n.format || '',
      price: Number(n.price ?? n.minPrice ?? 0) || null,
      url: n.url ? (n.url.startsWith('http') ? n.url : BASE + n.url) : '',
    }))
    .filter((s) => s.cinemaName && s.movieTitle);
}

/** Уровень 2: Schema.org ScreeningEvent. */
export function fromJsonLd(html, date) {
  const out = [];
  for (const node of jsonLd(html)) {
    const events = deepFind(node, (n) => n['@type'] === 'ScreeningEvent');
    for (const e of events) {
      const start = e.startDate || '';
      const m = /T(\d{2}:\d{2})/.exec(start);
      if (!m) continue;
      out.push({
        date: start.slice(0, 10) || date,
        time: m[1],
        cinemaName: e.location?.name || '',
        cinemaId: '',
        movieTitle: e.workPresented?.name || e.name || '',
        movieId: '',
        hall: e.videoFormat || '',
        price: Number(e.offers?.price ?? e.offers?.lowPrice ?? 0) || null,
        url: e.url || e.offers?.url || '',
      });
    }
  }
  return out.filter((s) => s.cinemaName && s.movieTitle);
}

/** Уровень 3: HTML. Блоки кинотеатров, внутри — фильмы и времена. */
export function fromHtml(html, date) {
  const out = [];

  // Кусок страницы на один кинотеатр: заголовок со ссылкой /cinema/<id>/ ...
  const cinemaRe =
    /<a[^>]+href="([^"]*\/cinema\/[^"]*?)"[^>]*>([\s\S]{0,200}?)<\/a>([\s\S]*?)(?=<a[^>]+href="[^"]*\/cinema\/|$)/gi;

  let cm;
  while ((cm = cinemaRe.exec(html))) {
    const cinemaUrl = cm[1];
    const cinemaName = stripTags(cm[2]);
    const block = cm[3];
    if (!cinemaName || cinemaName.length > 80) continue;

    // Внутри блока: ссылка на фильм, затем времена до следующей ссылки на фильм.
    const movieRe =
      /<a[^>]+href="([^"]*\/movies?\/[^"]*?)"[^>]*>([\s\S]{0,200}?)<\/a>([\s\S]*?)(?=<a[^>]+href="[^"]*\/movies?\/|$)/gi;
    let mm;
    while ((mm = movieRe.exec(block))) {
      const movieTitle = stripTags(mm[2]);
      if (!movieTitle || movieTitle.length > 120) continue;
      const times = [...mm[3].matchAll(/>\s*([0-2]?\d:[0-5]\d)\s*</g)].map((t) => t[1]);
      for (const time of new Set(times)) {
        out.push({
          date,
          time,
          cinemaName,
          cinemaId: (/\/cinema\/(\d+)/.exec(cinemaUrl) || [])[1] || '',
          movieTitle,
          movieId: (/\/movies?\/(\d+)/.exec(mm[1]) || [])[1] || '',
          hall: '',
          price: null,
          url: cinemaUrl.startsWith('http') ? cinemaUrl : BASE + cinemaUrl,
        });
      }
    }
  }
  return out;
}

/**
 * Забирает сеансы на дату. Возвращает {shows, layer} — layer говорит,
 * какой уровень парсинга сработал (видно в логах Actions).
 */
export async function fetchDate(date) {
  let lastErr;
  for (const url of scheduleUrls(date)) {
    let html;
    try {
      html = await getText(url, { retries: 1 });
    } catch (err) {
      lastErr = err;
      continue;
    }

    for (const [layer, parse] of [
      ['state', fromState],
      ['json-ld', fromJsonLd],
      ['html', fromHtml],
    ]) {
      const shows = parse(html, date);
      if (shows.length >= 10) {
        console.log(`[${id}] ${date}: ${shows.length} сеансов (${layer}) ← ${url}`);
        return { shows, layer, url };
      }
    }
    console.warn(`[${id}] ${date}: ${url} — ни один уровень парсинга не дал сеансов`);
  }
  if (lastErr) console.warn(`[${id}] ${date}: сеть — ${lastErr.message}`);
  return { shows: [], layer: null, url: null };
}

/** Общий интерфейс источника: собрать сеансы за несколько дат. */
export async function fetchDates(dates) {
  const shows = [];
  let layer = null;
  for (const date of dates) {
    const r = await fetchDate(date);
    shows.push(...r.shows);
    layer = layer || r.layer;
  }
  return { shows, layer };
}

export const normalizeTitle = (t) =>
  stripTags(t).replace(/\s*\(\d{4}\)\s*$/, '').replace(/^\d+\.\s*/, '').trim();

export const movieKey = (t) => slug(normalizeTitle(t));
