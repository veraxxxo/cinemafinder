// Источник расписания: kinoafisha.info.
//
// Сайт отвечает 403 на прямые HTTP-запросы с адресов дата-центров, но
// настоящий Chromium пускает: в Actions страницы берёт именно он, прокси
// остаются последним запасным вариантом в общей цепочке загрузки.
//
// Разметка, снятая с живой страницы:
//   <a href="…/cinema/…">Название</a>   — заголовок блока кинотеатра
//   <div class="session …">
//     <span class="session_time">19:30</span>
//     <span class="session_price">от 450 ₽</span>
//   </div>
//
// Расписание берём со страниц отдельных фильмов: на каждой перечислены все
// залы города с временами. Раньше первым шло общее расписание города
// (/russia/msk/schedule/) — один запрос на день вместо десятков, — но этой
// страницы больше нет: и браузер, и прямой запрос получают на ней 404.
// Держать её в цепочке значило дарить каждому прогону ~4 минуты на заведомо
// безнадёжные повторы через прокси, поэтому она убрана.

import { loadPage } from '../lib/fetcher.mjs';
import { enabled as llmEnabled, extractShows } from '../lib/llm-extract.mjs';
import {
  contentOf, cinemaBlocks, sessionsIn, stripTags,
} from '../../parse-showtimes.js';

export const id = 'kinoafisha';
export const title = 'Кино Афиша';

const BASE = 'https://www.kinoafisha.info';
const CITY = 'russia/msk';

/** Сколько страниц фильмов тянуть максимум за прогон. */
const MOVIE_LIMIT = Number(process.env.KA_MOVIE_LIMIT || 30);

/** Сколько страниц грузить одновременно: каждая — отдельная вкладка Chromium. */
const CONCURRENCY = Number(process.env.KA_CONCURRENCY || 4);

const slug = (s) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '-').replace(/^-|-$/g, '');

// Селектор по вхождению класса, а не по точному совпадению: разметка вокруг
// времени у сайта отличается от страницы к странице, и точный класс ловит не
// везде. Ждать при этом надо появления в DOM, а не видимости, — см. коммент
// про `state: 'attached'` в lib/browser.mjs.
const page = (url, label) =>
  loadPage(url, { expect: /session_time|\/cinema\//, waitFor: '[class*="session_time"]', label });

/** Выполняет задачи пачками по `limit` штук, сохраняя порядок результатов. */
async function pool(items, limit, run) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

// Ссылка на кинотеатр несёт город: /russia/msk/cinema/… против /russia/spb/… .
// Это оказалось не теорией: в прогоне 09.08 в московское расписание попали
// «Мираж Синема в ТРК Европолис», «в ТРК MARi» и «Отрадное» — петербургская
// сеть в петербургских ТРК, 102 сеанса. Прежняя сшивка это прятала, сажая их
// на московскую точку «Мираж».
const CITY_IN_URL = /\/russia\/([a-z-]+)\//;

let urlSampleShown = false;

/** Город из ссылки на кинотеатр; '?' — если по ссылке город не определить. */
export const cityOfCinemaUrl = (url) => CITY_IN_URL.exec(url || '')?.[1] || '?';

/** Разбирает страницу одного фильма: блоки залов и времена внутри них. */
async function oneMovie(movie, date) {
  const content = contentOf(await page(`${movie.url}?date=${date}`, `${movie.title} ${date}`));
  const shows = [];
  const cities = new Map();

  for (const block of cinemaBlocks(content)) {
    // Один образец ссылки за прогон: по нему видно, несёт ли разметка город
    // вообще. Без этого фильтр по городу нельзя ни проверить, ни опровергнуть.
    if (!urlSampleShown) {
      urlSampleShown = true;
      console.log(`[${id}] образец ссылки на зал: ${block.url}`);
    }
    const city = cityOfCinemaUrl(block.url);
    cities.set(city, (cities.get(city) || 0) + 1);
    // Город берём только по явному признаку: ссылка без /russia/<город>/
    // может быть относительной, и выкидывать такие вслепую нельзя.
    if (city !== '?' && city !== 'msk') continue;

    for (const s of sessionsIn(block.chunk)) {
      shows.push({
        date,
        time: s.time,
        price: s.price,
        cinemaName: block.name,
        movieTitle: movie.title,
        url: movie.url,
      });
    }
  }

  const foreign = [...cities].filter(([c]) => c !== 'msk' && c !== '?');
  if (foreign.length) {
    console.warn(
      `[${id}]   ${movie.title}: отброшены залы других городов — ` +
        foreign.map(([c, n]) => `${c}:${n}`).join(', '),
    );
  }

  // Страница пришла живая и увесистая, а разбор пуст — так выглядит смена
  // вёрстки. Тогда за дело берётся модель, если ключ выдан.
  if (!shows.length && content.length > 40000 && llmEnabled()) {
    const guessed = await extractShows(content, {
      date,
      hint: `Это страница фильма «${movie.title}»: список кинотеатров и времён сеансов.`,
    });
    if (guessed.length) {
      console.log(`[${id}]   ${movie.title}: ${guessed.length} разобрала модель`);
      return guessed.map((g) => ({ ...g, movieTitle: movie.title, url: movie.url }));
    }
  }
  return shows;
}

/** Страница фильма — на ней перечислены все залы города с сеансами. */
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
    console.warn(`[${id}] беру первые ${MOVIE_LIMIT} из ${movies.length} — на остальные не хватит времени прогона`);
  }

  const batches = await pool(movies.slice(0, MOVIE_LIMIT), CONCURRENCY, async (movie) => {
    try {
      const got = await oneMovie(movie, date);
      console.log(`[${id}]   ${movie.title}: ${got.length}`);
      return got;
    } catch (err) {
      console.warn(`[${id}]   ${movie.title}: ${err.message}`);
      return [];
    }
  });
  return batches.flat();
}

export async function fetchDates(dates) {
  const all = [];
  let layer = null;

  for (const date of dates) {
    const shows = await fromMoviePages(date);
    if (shows.length) layer = layer || 'страницы фильмов';
    all.push(...shows);

    // Дальше сегодняшнего дня страницы фильмов тянуть слишком долго.
    if (!shows.length) break;
  }

  // Браузер здесь не закрываем: он общий, и следующим источникам он ещё нужен.
  // Закрытие — один раз в fetch-schedule.mjs, когда отработали все.
  return { shows: all, layer };
}

export const normalizeTitle = (t) =>
  stripTags(t)
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/^\d+\.\s*/, '')
    .replace(/\s*[—-]\s*расписание.*$/i, '')
    .trim();

export const movieKey = (t) => slug(normalizeTitle(t));
