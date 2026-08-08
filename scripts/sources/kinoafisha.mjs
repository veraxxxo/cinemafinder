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

import { getText, stripTags } from '../lib/util.mjs';
import { browserAvailable, fetchPage, closeBrowser } from '../lib/browser.mjs';

export const id = 'kinoafisha';
export const title = 'Кино Афиша';

const BASE = 'https://www.kinoafisha.info';
const CITY = 'russia/msk';
const PROXY = 'https://api.allorigins.win/raw?url=';

/** Сколько страниц фильмов тянуть максимум — прокси бесплатный и медленный. */
const MOVIE_LIMIT = Number(process.env.KA_MOVIE_LIMIT || 30);

const slug = (s) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '-').replace(/^-|-$/g, '');

// Способ загрузки выбирается один раз: настоящий браузер, если он есть,
// иначе открытый прокси. Прямые запросы сайт отбивает по 403.
let mode = null;

async function pickMode() {
  if (mode) return mode;
  if (process.env.KA_DIRECT) return (mode = 'direct');

  if (await browserAvailable()) {
    try {
      const { status } = await fetchPage(`${BASE}/${CITY}/movies/`);
      if (status === 200) {
        console.log(`[${id}] загрузка через Chromium — сайт пустил браузер`);
        return (mode = 'browser');
      }
      console.warn(`[${id}] браузер получил HTTP ${status}, перехожу на прокси`);
    } catch (err) {
      console.warn(`[${id}] браузер не смог открыть сайт: ${err.message}`);
    }
  }
  console.log(`[${id}] загрузка через прокси`);
  return (mode = 'proxy');
}

async function page(url) {
  const how = await pickMode();
  if (how === 'browser') {
    const { status, html } = await fetchPage(url, { waitFor: '.session_time' });
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return html;
  }
  const target = how === 'direct' ? url : PROXY + encodeURIComponent(url);
  return getText(target, { retries: 2, timeout: 90000 });
}

/** Убирает всё, что не является видимой разметкой: там те же имена классов. */
export const contentOf = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(?:head|header|nav|footer)[\s\S]*?<\/(?:head|header|nav|footer)>/gi, '');

/** Сеансы внутри куска разметки: время и, если есть, цена. */
export function sessionsIn(chunk) {
  const out = [];
  for (const m of chunk.matchAll(
    /<span[^>]*class="[^"]*session_time[^"]*"[^>]*>\s*([0-2]?\d:[0-5]\d)\s*<\/span>([\s\S]{0,220}?)(?=<span[^>]*class="[^"]*session_time|$)/g,
  )) {
    const priceText = /session_price[^>]*>([^<]*)</.exec(m[2] || '');
    const price = priceText ? Number((/\d[\d\s]*/.exec(priceText[1]) || [''])[0].replace(/\s/g, '')) : null;
    out.push({ time: m[1], price: price || null });
  }
  return out;
}

/**
 * Разбивает страницу на блоки «кинотеатр → его сеансы».
 * Заголовком блока считается ссылка на страницу кинотеатра.
 */
export function cinemaBlocks(content) {
  const anchors = [
    ...content.matchAll(/<a[^>]+href="([^"]*\/cinema\/[^"]*)"[^>]*>([\s\S]{0,240}?)<\/a>/g),
  ];
  const blocks = [];
  for (let i = 0; i < anchors.length; i++) {
    const name = stripTags(anchors[i][2]);
    if (!name || name.length > 90) continue;
    const start = anchors[i].index + anchors[i][0].length;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : content.length;
    blocks.push({ name, url: anchors[i][1], chunk: content.slice(start, end) });
  }
  return blocks;
}

/** Стратегия 1: общее расписание города за дату. */
async function fromCitySchedule(date) {
  const urls = [`${BASE}/${CITY}/schedule/?date=${date}`, `${BASE}/${CITY}/schedule/`];
  for (const url of urls) {
    let content;
    try {
      content = contentOf(await page(url));
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
  }
  return [];
}

/** Список фильмов в прокате: ссылки вида /movies/<id>/ с названиями. */
async function moviesInRelease() {
  const content = contentOf(await page(`${BASE}/${CITY}/movies/`));
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
      const content = contentOf(await page(`${movie.url}?date=${date}`));
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

  await closeBrowser();
  return { shows: all, layer: layer && `${layer} (${mode || 'прокси'})` };
}

export const normalizeTitle = (t) =>
  stripTags(t)
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s*[—-]\s*расписание.*$/i, '')
    .trim();

export const movieKey = (t) => slug(normalizeTitle(t));
