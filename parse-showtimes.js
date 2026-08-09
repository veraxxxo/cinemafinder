/* Разбор страницы афиши. Один и тот же код работает и в Node (сбор данных
   в GitHub Actions), и в браузере (подгрузка свежих сеансов прямо на карте),
   поэтому здесь нет ни импортов, ни обращений к файловой системе. */

export const stripTags = (html = '') =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** Шапка, стили и скрипты содержат те же имена классов и сбивают разбор. */
export const contentOf = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<(?:head|header|nav|footer)[\s\S]*?<\/(?:head|header|nav|footer)>/gi, '');

/**
 * Сеансы внутри куска разметки: время и, если указана, цена.
 *
 * Опознаём по классу, а не по тегу. Прежняя версия требовала буквально
 * <span class="…session_time…">19:30</span> — и молчала, если время лежало в
 * другом теге или во вложенном элементе. Насколько это дорого стоило, видно
 * из прогона 09.08: браузер насчитал на странице 49 элементов с временами,
 * а разбор вытащил ноль.
 */
export function sessionsIn(chunk) {
  const out = [];
  const OPEN = /<[a-z]+[^>]*class="[^"]*session_time[^"]*"[^>]*>([\s\S]{0,400}?)(?=<[a-z]+[^>]*class="[^"]*session_time|$)/g;

  for (const m of chunk.matchAll(OPEN)) {
    const seg = m[1] || '';
    // Время — первое, что стоит внутри элемента; вложенную разметку снимаем.
    const time = (/([0-2]?\d:[0-5]\d)/.exec(stripTags(seg.slice(0, 160))) || [])[1];
    if (!time) continue;

    const priceText = /session_price[^>]*>([^<]*)</.exec(seg);
    const price = priceText
      ? Number((/\d[\d\s]*/.exec(priceText[1]) || [''])[0].replace(/\s/g, ''))
      : null;
    out.push({ time, price: price || null });
  }
  return out;
}

/** Блоки «кинотеатр → его сеансы»: заголовок — ссылка на страницу зала. */
export function cinemaBlocks(content) {
  const anchors = [...content.matchAll(/<a[^>]+href="([^"]*\/cinema\/[^"]*)"[^>]*>([\s\S]{0,240}?)<\/a>/g)];
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

/** Страница фильма: фильм известен заранее, на странице только залы. */
export function parseMoviePage(html, movieTitle, date) {
  const out = [];
  for (const block of cinemaBlocks(contentOf(html))) {
    for (const s of sessionsIn(block.chunk)) {
      out.push({ date, time: s.time, price: s.price, cinemaName: block.name, movieTitle });
    }
  }
  return out;
}

/** Общее расписание города: внутри зала — ссылки на фильмы, за каждой сеансы. */
export function parseCitySchedule(html, date) {
  const out = [];
  for (const block of cinemaBlocks(contentOf(html))) {
    const films = [...block.chunk.matchAll(/<a[^>]+href="([^"]*\/movies?\/[^"]*)"[^>]*>([\s\S]{0,200}?)<\/a>/g)];
    for (let i = 0; i < films.length; i++) {
      const movieTitle = stripTags(films[i][2]);
      if (!movieTitle || movieTitle.length > 140) continue;
      const from = films[i].index + films[i][0].length;
      const to = i + 1 < films.length ? films[i + 1].index : block.chunk.length;
      for (const s of sessionsIn(block.chunk.slice(from, to))) {
        out.push({ date, time: s.time, price: s.price, cinemaName: block.name, movieTitle });
      }
    }
  }
  return out;
}

/** Фильмы в прокате: ссылки /movies/<id>/ с названиями. */
export function parseMovieList(html) {
  const seen = new Map();
  for (const m of contentOf(html).matchAll(/<a[^>]+href="([^"]*\/movies\/(\d+)\/)"[^>]*>([\s\S]{0,160}?)<\/a>/g)) {
    const title = stripTags(m[3]);
    if (!title || title.length > 140 || seen.has(m[2])) continue;
    seen.set(m[2], { id: m[2], title });
  }
  return [...seen.values()];
}
