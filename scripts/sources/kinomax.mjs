// Источник расписания: kinomax.ru.
//
// Сайт закрыт антибот-заглушкой «Верификация», поэтому страницы идут через
// общую цепочку загрузки (браузер → напрямую → прокси).
//
// Адреса устроены просто: /films/<id>/<YYYY-MM-DD> — страница фильма на дату,
// где перечислены залы сети и времена сеансов.

import { stripTags } from '../lib/util.mjs';
import { loadPage } from '../lib/fetcher.mjs';

export const id = 'kinomax';
export const title = 'Киномакс';
const BASE = 'https://kinomax.ru';

const MOVIE_LIMIT = Number(process.env.KM_MOVIE_LIMIT || 20);

const slug = (s) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '-').replace(/^-|-$/g, '');

const contentOf = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(?:head|header|nav|footer)[\s\S]*?<\/(?:head|header|nav|footer)>/gi, '');

/** Все времена вида ЧЧ:ММ, лежащие внутри отдельных элементов. */
function timesIn(chunk) {
  return [...new Set([...chunk.matchAll(/>\s*([0-2]?\d:[0-5]\d)\s*</g)].map((m) => m[1]))];
}

/** Блоки «кинотеатр → его сеансы»: заголовком считается ссылка на зал. */
function cinemaBlocks(content) {
  const anchors = [
    ...content.matchAll(/<a[^>]+href="([^"]*\/(?:cinema|kinoteatr|theatre)[^"]*)"[^>]*>([\s\S]{0,200}?)<\/a>/gi),
  ];
  const out = [];
  for (let i = 0; i < anchors.length; i++) {
    const name = stripTags(anchors[i][2]);
    if (!name || name.length > 90) continue;
    const start = anchors[i].index + anchors[i][0].length;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : content.length;
    out.push({ name, chunk: content.slice(start, end) });
  }
  return out;
}

/** Фильмы в прокате: ссылки /films/<id>/ с названиями. */
async function movies() {
  const html = await loadPage(`${BASE}/films`, {
    expect: /\/films\/\d+/,
    waitFor: 'a[href*="/films/"]',
    label: 'киномакс: фильмы',
  });
  const seen = new Map();
  for (const m of contentOf(html).matchAll(/<a[^>]+href="([^"]*\/films\/(\d+)[^"]*)"[^>]*>([\s\S]{0,160}?)<\/a>/g)) {
    const name = stripTags(m[3]);
    if (!name || name.length > 140 || seen.has(m[2])) continue;
    seen.set(m[2], { id: m[2], title: name });
  }
  return [...seen.values()];
}

export async function fetchDates(dates) {
  let list;
  try {
    list = await movies();
  } catch (err) {
    console.warn(`[${id}] список фильмов не открылся: ${err.message}`);
    return { shows: [], layer: null };
  }
  console.log(`[${id}] фильмов: ${list.length}`);
  if (list.length > MOVIE_LIMIT) {
    console.warn(`[${id}] беру первые ${MOVIE_LIMIT} из ${list.length}`);
  }

  const shows = [];
  for (const date of dates) {
    let onDate = 0;
    for (const movie of list.slice(0, MOVIE_LIMIT)) {
      const url = `${BASE}/films/${movie.id}/${date}`;
      try {
        const content = contentOf(await loadPage(url, { waitFor: null, label: `${movie.title} ${date}` }));
        for (const block of cinemaBlocks(content)) {
          for (const time of timesIn(block.chunk)) {
            shows.push({
              date,
              time,
              cinemaName: block.name,
              movieTitle: movie.title,
              price: null,
              url,
            });
            onDate++;
          }
        }
      } catch (err) {
        console.warn(`[${id}] ${movie.title} ${date}: ${err.message}`);
      }
    }
    console.log(`[${id}] ${date}: ${onDate} сеансов`);
    if (!onDate) break; // дальше по датам смысла нет
  }

  return { shows, layer: shows.length ? 'страницы фильмов' : null };
}

export const normalizeTitle = (t) => stripTags(t).replace(/\s*\(\d{4}\)\s*$/, '').trim();
export const movieKey = (t) => slug(normalizeTitle(t));
