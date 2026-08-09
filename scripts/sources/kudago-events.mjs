// Источник событий: открытое API KudaGo (без ключа).
//
// Почему именно оно. Яндекс Афиша с адреса дата-центра отдаёт оболочку без
// карточек, kinomax — заглушку «Верификация». KudaGo единственный, кто нас ни
// разу не отбил, и вдобавок отдаёт координаты площадки прямо в ответе —
// геокодер не нужен, событие сразу встаёт на карту.
//
// Что берём: концерты, спектакли, выставки, фестивали, вечеринки, квесты,
// детское — всё, что есть в /event-categories/.

import { get } from '../lib/util.mjs';

export const id = 'kudago-events';
export const title = 'KudaGo (события)';

const API = 'https://kudago.com/public-api/v1.4';
const PAGE = 100;

/** Сколько страниц максимум — предохранитель от бесконечной прокрутки. */
const MAX_PAGES = Number(process.env.EVENTS_MAX_PAGES || 40);

const FIELDS = ['id', 'title', 'place', 'dates', 'price', 'categories', 'site_url', 'is_free'].join(',');

const tsOf = (date, endOfDay = false) =>
  Math.floor(Date.parse(`${date}T${endOfDay ? '23:59:59' : '00:00:00'}+03:00`) / 1000);

/** Момент UTC → московские дата и время. */
export function msk(ts) {
  const d = new Date((ts + 3 * 3600) * 1000);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}

/** «от 500 руб.» → 500; «бесплатно» и пустое → null. */
export function price(text) {
  if (!text) return null;
  const m = /\d[\d\s]*/.exec(String(text).replace(/ /g, ' '));
  return m ? Number(m[0].replace(/\s/g, '')) || null : null;
}

/**
 * Раскладывает интервал события по запрошенным датам.
 *
 * У KudaGo одна запись в `dates` может покрывать месяцы (выставка идёт всё
 * лето), а может быть одним вечером. Карте нужны конкретные дни, поэтому
 * интервал пересекается с окном сбора и режется по дням.
 *
 * `start_time` бывает пустым — это событие «весь день» (выставка, экспозиция).
 * Такие не выбрасываем: время у них null, а фильтр времени их пропускает.
 */
export function occurrencesOf(dateEntry, wantedDates) {
  const out = [];
  const startTs = dateEntry.start;
  const endTs = dateEntry.end ?? dateEntry.start;
  if (!Number.isFinite(startTs)) return out;

  // KudaGo обозначает «постоянно» огромными значениями — обрезаем окном.
  for (const date of wantedDates) {
    const dayFrom = tsOf(date);
    const dayTo = tsOf(date, true);
    if (endTs < dayFrom || startTs > dayTo) continue;

    // Время берём, только если событие в этот день действительно начинается.
    const startsToday = startTs >= dayFrom && startTs <= dayTo;
    const time = startsToday && dateEntry.start_time ? dateEntry.start_time.slice(0, 5) : null;
    out.push({ date, time });
  }
  return out;
}

async function fetchJson(url) {
  const res = await get(url, { retries: 2, timeout: 40000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

/** Справочник категорий: slug → человеческое название. */
export async function categories() {
  const list = await fetchJson(`${API}/event-categories/`);
  return new Map(list.map((c) => [c.slug, c.name]));
}

/**
 * События за окно дат. Возвращает
 * { places: Map, events: [], occurrences: [], skipped: {noPlace, noCoords} }.
 */
export async function fetchDates(dates) {
  const from = tsOf(dates[0]);
  const to = tsOf(dates.at(-1), true);

  const places = new Map();
  const events = [];
  const occurrences = [];
  const skipped = { noPlace: 0, noCoords: 0, noDates: 0 };

  let url =
    `${API}/events/?location=msk&page_size=${PAGE}&expand=place&fields=${FIELDS}` +
    `&actual_since=${from}&actual_until=${to}&order_by=-rank`;

  for (let page = 0; url && page < MAX_PAGES; page++) {
    const data = await fetchJson(url);
    const batch = data.results || [];

    for (const e of batch) {
      const place = e.place;
      if (!place) {
        // Событие без площадки (онлайн, «весь город») на карту не поставить.
        skipped.noPlace++;
        continue;
      }
      const lat = place.coords?.lat;
      const lon = place.coords?.lon;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        skipped.noCoords++;
        continue;
      }

      const slots = [];
      for (const d of e.dates || []) slots.push(...occurrencesOf(d, dates));
      if (!slots.length) {
        skipped.noDates++;
        continue;
      }

      const pid = `k${place.id}`;
      if (!places.has(pid)) {
        places.set(pid, {
          id: pid,
          name: place.title || 'без названия',
          lat: +Number(lat).toFixed(6),
          lon: +Number(lon).toFixed(6),
          address: place.address || '',
          site: place.site_url || '',
        });
      }

      const eid = `e${e.id}`;
      events.push({
        id: eid,
        title: e.title || 'без названия',
        cats: e.categories || [],
        price: e.is_free ? 0 : price(e.price),
        url: e.site_url || '',
      });
      for (const s of slots) occurrences.push({ p: pid, e: eid, d: s.date, t: s.time });
    }

    url = data.next || null;
    if (!batch.length) break;
  }

  return { places, events, occurrences, skipped };
}
