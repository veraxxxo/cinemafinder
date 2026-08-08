// Ручной источник: data/manual-schedule.csv.
//
// То, что робот не смог достать (антибот, редизайн, блокировка), можно
// дописать руками — и оно попадёт на карту наравне с распарсенным.
// Координаты берутся по адресу из той же строки, поэтому зал не обязан
// быть в OpenStreetMap.
//
// Формат: кинотеатр;адрес;фильм;дата;время;цена;зал

import { readFile } from 'node:fs/promises';

export const id = 'manual';
export const title = 'Занесено вручную';

const slug = (s) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '-').replace(/^-|-$/g, '');

export async function fetchDates(dates) {
  let text;
  try {
    text = await readFile(new URL('../../data/manual-schedule.csv', import.meta.url), 'utf8');
  } catch {
    return { shows: [], layer: null };
  }

  const wanted = new Set(dates);
  const shows = [];
  let skipped = 0;

  for (const line of text.split('\n')) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;

    const [cinemaName, cinemaAddress, movieTitle, date, time, price, hall] = row.split(';');
    if (!cinemaName || !movieTitle || !date || !/^\d{1,2}:\d{2}$/.test(time || '')) continue;

    // Прошедшие даты не выкидываем молча — пишем, сколько отсеяли.
    if (!wanted.has(date)) {
      skipped++;
      continue;
    }

    shows.push({
      date,
      time,
      cinemaName: cinemaName.trim(),
      cinemaAddress: (cinemaAddress || '').trim(),
      movieTitle: movieTitle.trim(),
      price: Number(price) || null,
      hall: (hall || '').trim(),
      url: '',
    });
  }

  if (skipped) console.log(`[${id}] вне запрошенных дат: ${skipped} строк`);
  console.log(`[${id}] сеансов: ${shows.length}`);
  return { shows, layer: shows.length ? 'файл' : null };
}

export const normalizeTitle = (t) => String(t).trim();
export const movieKey = (t) => slug(normalizeTitle(t));
