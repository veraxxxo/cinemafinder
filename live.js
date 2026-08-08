/* Подгрузка свежего расписания прямо в браузере.

   Сайты афиш блокируют адреса дата-центров, где работает GitHub Actions,
   но обычный домашний адрес пропускают. Поэтому карта умеет добирать
   сеансы сама, через открытые прокси с разрешёнными CORS-заголовками.
   Это не заменяет сбор в Actions, а дополняет его: если данные устарели
   или их нет, посетитель нажимает кнопку и получает актуальные. */

import { parseCitySchedule, parseMoviePage, parseMovieList } from './parse-showtimes.js';

const BASE = 'https://www.kinoafisha.info/russia/msk';

// Прокси перебираются по очереди: бесплатные периодически отваливаются.
const PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

const BLOCKED = /верификац|проверка браузера|один момент|just a moment|attention required/i;

async function load(url, onProgress) {
  for (let i = 0; i < PROXIES.length; i++) {
    try {
      onProgress?.(`источник ${i + 1} из ${PROXIES.length}…`);
      const res = await fetch(PROXIES[i](url), { signal: AbortSignal.timeout(45000) });
      if (!res.ok) continue;
      const html = await res.text();
      // Заглушку антибота нельзя принимать за страницу: парсер разберёт
      // пустоту и отрапортует об успехе.
      if (html.length < 2048 || BLOCKED.test(html.slice(0, 4000))) continue;
      return html;
    } catch {
      /* пробуем следующий */
    }
  }
  throw new Error('ни один источник не ответил');
}

/** Расписание города на дату — один запрос, все фильмы и залы сразу. */
export async function fetchDay(date, onProgress) {
  const html = await load(`${BASE}/schedule/?date=${date}`, onProgress);
  const shows = parseCitySchedule(html, date);
  if (shows.length) return shows;
  throw new Error('на странице расписания сеансов не нашлось');
}

/** Список фильмов в прокате — для выбора конкретного. */
export async function fetchMovies(onProgress) {
  const html = await load(`${BASE}/movies/`, onProgress);
  return parseMovieList(html);
}

/** Сеансы одного фильма: на его странице перечислены все залы города. */
export async function fetchMovie(movieId, movieTitle, date, onProgress) {
  const html = await load(`${BASE}/movies/${movieId}/?date=${date}`, onProgress);
  return parseMoviePage(html, movieTitle, date);
}
