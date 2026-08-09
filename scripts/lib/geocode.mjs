// Превращение адресов в координаты, с кэшем на диске.
//
// Кэш обязателен: у Nominatim строгие правила (не чаще запроса в секунду),
// а площадки от прогона к прогону одни и те же. Файл data/geocode.json
// коммитится, поэтому повторные запуски геокодер вообще не трогают.

import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../../data/geocode.json', import.meta.url);
const UA = 'cinemafinder/1.0 (github.com/veraxxxo/cinemafinder)';

// Типы ответа Nominatim, которые означают «это район, а не здание».
const APPROX_KINDS = new Set([
  'suburb', 'quarter', 'neighbourhood', 'city_district', 'district',
  'borough', 'residential', 'place', 'boundary',
]);

// Города-спутники в перечне есть, а значит «Москва» к ним дописывать нельзя.
const SUBURBS = /(реутов|подольск|красногорск|пушкино|зеленоград|химки|мытищи|люберцы|одинцово|балашиха|котельники|видное)/i;

let cache = null;
let dirty = false;

async function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

export async function save() {
  if (!dirty || !cache) return;
  await writeFile(FILE, JSON.stringify(cache, null, 1));
  dirty = false;
}

// Слова сети и служебные обороты: по ним площадку не найти, а мешают они
// сильно. Запрос «Мираж Синема в ТРК «Европолис»» Nominatim не понимает,
// «Европолис» находит сразу. На этом терялись 102 сеанса в прогоне 09.08.
const CHAIN_PREFIX =
  /^(мираж\s+синема|формула\s+кино|синема\s+парк|синема\s+стар|пять\s+звёзд|пять\s+звезд|алмаз\s+синема|каро|киномакс|люксор|москино|киноград)\s*/i;
// Без \b: в JavaScript граница слова не работает с кириллицей, и оборот
// «в ТРК» оставался в запросе.
const FILLER = /(^|\s)(в|на)\s+(трк|трц|тц|тд|мега)(\s+|$)/gi;

/** Варианты запроса: точный адрес → название целиком → его опознаваемые куски. */
function queries({ name, address }) {
  const city = SUBURBS.test(`${name} ${address}`) ? '' : ', Москва';
  const bare = (name || '').replace(/\(.*?\)/g, '').trim();
  const out = [];

  if (address) out.push(address.includes('Москва') ? address : `${address}${city}`);
  if (bare) out.push(`кинотеатр ${bare}${city}`, `${bare}${city}`);

  // Название торгового центра в кавычках — самый надёжный ориентир:
  // «Мираж Синема в ТРК «Европолис»» → «Европолис».
  const quoted = /[«"']([^«»"']{3,40})[»"']/.exec(bare)?.[1]?.trim();
  if (quoted) out.push(`ТРЦ ${quoted}${city}`, `${quoted}${city}`);

  // Остаток названия без сети и без «в ТРК»: «Мираж Синема Отрадное» →
  // «Отрадное». Точность районная, но это лучше, чем потерять площадку.
  const tail = bare
    .replace(CHAIN_PREFIX, '')
    .replace(FILLER, ' ')
    .replace(/[«»"']/g, '')
    // «Киномакс-Релакс Пушкино» после снятия сети начинается с дефиса.
    .replace(/^[\s\-–—:,.]+/, '')
    .trim();
  if (tail && tail.toLowerCase() !== bare.toLowerCase()) {
    out.push(`кинотеатр ${tail}${city}`, `${tail}${city}`);
  }

  return [...new Set(out.filter(Boolean))];
}

export const _queries = queries;

/**
 * Ищет координаты по названию и адресу. Возвращает {lat, lon, via} или null.
 * Результат — включая неудачу — запоминается, чтобы не спрашивать дважды.
 */
export async function geocode({ name, address = '' }) {
  const store = await load();
  const key = `${name}|${address}`.trim();

  if (key in store) {
    const hit = store[key];
    // Кэш вечный, и записи, сделанные до появления флага approx, его не несут.
    // Достраиваем по описанию: иначе пометка «точка примерная» не появится
    // ровно там, где она и понадобилась.
    if (hit && hit.approx === undefined) {
      hit.approx = /^(район|квартал|микрорайон|поселение|округ)\s/i.test(hit.display || '');
      dirty = true;
    }
    return hit;
  }

  for (const q of queries({ name, address })) {
    try {
      const url =
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
        `&format=json&limit=1&countrycodes=ru&viewbox=36.7,56.2,38.2,55.3&bounded=1`;
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
      await new Promise((r) => setTimeout(r, 1200)); // правила Nominatim
      if (!res.ok) {
        console.warn(`[geo] «${q}»: HTTP ${res.status}`);
        continue;
      }
      const hits = await res.json();
      if (hits[0]) {
        const found = {
          lat: +Number(hits[0].lat).toFixed(6),
          lon: +Number(hits[0].lon).toFixed(6),
          via: q,
          display: hits[0].display_name,
          // Район или квартал вместо здания: «Мираж Синема Отрадное» нашёлся
          // как «район Отрадное», и булавка встала в его центр. Пусть карта
          // говорит об этом честно, а не изображает точный адрес.
          approx: APPROX_KINDS.has(hits[0].type) || APPROX_KINDS.has(hits[0].class),
        };
        store[key] = found;
        dirty = true;
        return found;
      }
    } catch (err) {
      console.warn(`[geo] «${q}»: ${err.message}`);
    }
  }

  // Отрицательный ответ тоже кэшируем — иначе каждый прогон будет ломиться
  // за одними и теми же безнадёжными названиями.
  store[key] = null;
  dirty = true;
  return null;
}
