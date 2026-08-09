#!/usr/bin/env node
// Собирает события Москвы (концерты, спектакли, выставки, фестивали, квесты)
// в data/events.json — отдельный слой карты рядом с киносеансами.
//
// Источник — KudaGo: единственный, кто пускает нас с адреса дата-центра, и
// вдобавок отдаёт координаты площадки прямо в ответе. Остальные кандидаты с
// этого адреса закрыты: Timepad 403, afisha.ru «Один момент...», Яндекс
// Афиша — оболочка без карточек. Их добирает сбор с домашнего адреса.
//
// Формат файла намеренно повторяет schedule.json: те же поля дат и площадок,
// чтобы карта фильтровала события тем же кодом, что и сеансы.

import { writeFile, readFile } from 'node:fs/promises';
import * as kudago from './sources/kudago-events.mjs';
import { mskDate } from './lib/util.mjs';

const DAYS = Number(process.env.EVENT_DAYS || process.env.DAYS || 7);
const outFile = new URL('../data/events.json', import.meta.url);

const dates = Array.from({ length: DAYS }, (_, i) => mskDate(i));
console.log(`[events] Даты: ${dates[0]} … ${dates.at(-1)} (${dates.length})`);

let catNames = new Map();
try {
  catNames = await kudago.categories();
  console.log(`[events] категорий в справочнике: ${catNames.size}`);
} catch (err) {
  console.warn(`[events] справочник категорий не открылся: ${err.message}`);
}

let collected;
try {
  collected = await kudago.fetchDates(dates);
} catch (err) {
  console.error(`[events] сбор упал: ${err.message}`);
  process.exit(1);
}

const { places, events, occurrences, skipped } = collected;

// Одно и то же событие приходит на нескольких страницах выдачи — схлопываем.
const eventById = new Map();
for (const e of events) if (!eventById.has(e.id)) eventById.set(e.id, e);

const seen = new Set();
const slots = [];
for (const o of occurrences) {
  const key = `${o.p}|${o.e}|${o.d}|${o.t ?? ''}`;
  if (seen.has(key)) continue;
  seen.add(key);
  slots.push(o);
}
slots.sort((a, b) => a.d.localeCompare(b.d) || (a.t || '').localeCompare(b.t || ''));

// Счётчики по категориям — для чипсов фильтра.
const catCount = new Map();
for (const o of slots) {
  for (const c of eventById.get(o.e)?.cats || []) {
    catCount.set(c, (catCount.get(c) || 0) + 1);
  }
}
const categories = [...catCount.entries()]
  .map(([slug, count]) => ({ id: slug, name: catNames.get(slug) || slug, count }))
  .sort((a, b) => b.count - a.count);

const payload = {
  updated: new Date().toISOString(),
  source: { id: kudago.id, title: kudago.title },
  dates,
  stats: {
    events: eventById.size,
    slots: slots.length,
    places: places.size,
    categories: categories.length,
  },
  categories,
  places: [...places.values()],
  events: [...eventById.values()],
  slots,
};

console.log(
  `[events] пропущено: без площадки ${skipped.noPlace}, ` +
    `без координат ${skipped.noCoords}, вне окна дат ${skipped.noDates}`,
);
console.log(`[events] топ категорий: ${categories.slice(0, 8).map((c) => `${c.name}(${c.count})`).join(', ')}`);

// Не затираем рабочий файл пустым результатом — источник мог лечь.
let previous = null;
try {
  previous = JSON.parse(await readFile(outFile, 'utf8'));
} catch {
  /* первого файла ещё нет */
}

if (!slots.length && previous?.slots?.length) {
  console.error('[events] пустой результат — оставляю прежние события');
  process.exitCode = 1;
} else {
  await writeFile(outFile, JSON.stringify(payload));
  console.log(
    `[events] Сохранено: ${slots.length} показов, ${eventById.size} событий, ` +
      `${places.size} площадок, ${categories.length} категорий`,
  );
}
