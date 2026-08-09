// Источник расписания: kinoafisha.info.
//
// Сайт отвечает 403 на прямые запросы с адресов дата-центров, поэтому в
// GitHub Actions страницы берутся через открытый прокси. Локально (с обычного
// адреса) прокси не нужен — включается флагом KA_DIRECT=1.
//
// Разметка, снятая с живой страницы:
//   <a href="…/cinema/…">Название</a>   — заголовок блока кинотеатра
//   <div class="session …">
//     <span class="session_time">19:30</span>
//     <span class="session_price">от 450 ₽</span>
//   </div>
//
// Стратегии, в порядке предпочтения:
//   1. общее расписание города за дату — один запрос на день;
//   2. страницы отдельных фильмов — дороже, но переживает смену первой.

import { loadPage, finish } from '../lib/fetcher.mjs';
import { enabled as llmEnabled, extractShows } from '../lib/llm-extract.mjs';
import {
  contentOf, cinemaBlocks, sessionsIn, stripTags,
} from '../../parse-showtimes.js';

export const id = 'kinoafisha';
export const title = 'Кино Афиша';

const BASE = 'https://www.kinoafisha.info';
const CITY = 'russia/msk';
const PROXY = 'https://api.allorigins.win/raw?url=';

/** Сколько страниц фильмов тянуть максимум — прокси бесплатный и медленный. */
const MOVIE_LIMIT = Number(process.env.KA_MOVIE_LIMIT || 30);

const slug = (s) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '-').replace(/^-|-$/g, '');

const page = (url, label) =>
  loadPage(url, { expect: /session_time|\/cinema\//, waitFor: '.session_time', label });

/** Стратегия 1: общее расписание города за дату. */
async function fromCitySchedule(date) {
  const urls = [`${BASE}/${CITY}/schedule/?date=${date}`, `${BASE}/${CITY}/schedule/`];
  for (const url of urls) {
    let content;
    try {
      content = contentOf(await page(url, url));
    } catch (err) {
      console.warn(`[${id}] ${url}: ${err.message}`);
      continue;
    }

    const shows = [];
    for (const block of cinemaBlocks(content)) {
      // Внутри блока кинотеатра — ссылки на фильмы, за каждой её сеансы.
      const films = [...block.chunk.matchAll(/<a[^>]+href="([^"]*\/movies?\/[^"]*)"[^>]*>([\s\S]{0,200}?)<\/a>/g)];
      for (let i = 0; i < films.length; i++) {
        const movieTitle = stripTags(films[i][2]);
        if (!movieTitle || movieTitle.length > 140) continue;
        const from = films[i].index + films[i][0].length;
        const to = i + 1 < films.length ? films[i + 1].index : block.chunk.length;
        for (const s of sessionsIn(block.chunk.slice(from, to))) {
          shows.push({ date, time: s.time, price: s.price, cinemaName: block.name, movieTitle, url });
        }
      }
    }
    if (shows.length >= 20) {
      console.log(`[${id}] ${date}: ${shows.length} сеансов с общего расписания`);
      return shows;
    }
    console.warn(`[${id}] ${date}: общее расписание дало ${shows.length} — мало`);

    // Страница загрузилась, а разбор пуст — похоже на смену вёрстки.
    // Тогда за дело берётся модель, если ключ выдан.
    if (llmEnabled()) {
      const guessed = await extractShows(content, {
        date,
        hint: 'Это общее расписание кинотеатров города на дату.',
      });
      if (guessed.length >= 10) {
        console.log(`[${id}] ${date}: ${guessed.length} сеансов разобрала модель`);
        return guessed.map((g) => ({ ...g, url }));
      }
    }
  }
  return [];
}

/** Список фильмов в прокате: ссылки вида /movies/<id>/ с названиями. */
async function moviesInRelease() {
  const content = contentOf(await page(`${BASE}/${CITY}/movies/`, 'киноафиша: фильмы'));
  const seen = new Map();
  for (const m of content.matchAll(/<a[^>]+href="([^"]*\/movies\/(\d+)\/)"[^>]*>([\s\S]{0,160}?)<\/a>/g)) {
    const name = stripTags(m[3]);
    if (!name || name.length > 140 || seen.has(m[2])) continue;
    seen.set(m[2], { id: m[2], title: name, url: `${BASE}/${CITY}/movies/${m[2]}/` });
  }
  return [...seen.values()];
}

/** Стратегия 2: страница фильма — на ней перечислены все залы с сеансами. */
async function fromMoviePages(date) {
  let movies;
  try {
    movies = await moviesInRelease();
  } catch (err) {
    console.warn(`[${id}] список фильмов не открылся: ${err.message}`);
    return [];
  }
  console.log(`[${id}] фильмов в прокате: ${movies.length}`);
  if (movies.length > MOVIE_LIMIT) {
    console.warn(`[${id}] беру первые ${MOVIE_LIMIT} из ${movies.length} — прокси не тянет больше`);
  }

  const shows = [];
  for (const movie of movies.slice(0, MOVIE_LIMIT)) {
    try {
      const content = contentOf(await page(`${movie.url}?date=${date}`, `${movie.title} ${date}`));
      let n = 0;
      for (const block of cinemaBlocks(content)) {
        for (const s of sessionsIn(block.chunk)) {
          shows.push({
            date,
            time: s.time,
            price: s.price,
            cinemaName: block.name,
            movieTitle: movie.title,
            url: movie.url,
          });
          n++;
        }
      }
      console.log(`[${id}]   ${movie.title}: ${n}`);
    } catch (err) {
      console.warn(`[${id}]   ${movie.title}: ${err.message}`);
    }
  }
  return shows;
}

export async function fetchDates(dates) {
  const all = [];
  let layer = null;

  for (const date of dates) {
    let shows = await fromCitySchedule(date);
    if (shows.length) {
      layer = layer || 'расписание города';
    } else {
      shows = await fromMoviePages(date);
      if (shows.length) layer = layer || 'страницы фильмов';
    }
    all.push(...shows);

    // Дальше сегодняшнего дня страницы фильмов тянуть слишком долго.
    if (!shows.length) break;
  }

  await finish();
  return { shows: all, layer };
}

export const normalizeTitle = (t) =>
  stripTags(t)
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s*[—-]\s*расписание.*$/i, '')
    .trim();

export const movieKey = (t) => slug(normalizeTitle(t));
