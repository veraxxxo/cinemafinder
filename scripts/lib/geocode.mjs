// Превращение адресов в координаты, с кэшем на диске.
//
// Кэш обязателен: у Nominatim строгие правила (не чаще запроса в секунду),
// а площадки от прогона к прогону одни и те же. Файл data/geocode.json
// коммитится, поэтому повторные запуски геокодер вообще не трогают.

import { readFile, writeFile } from 'node:fs/promises';

const FILE = new URL('../../data/geocode.json', import.meta.url);
const UA = 'cinemafinder/1.0 (github.com/veraxxxo/cinemafinder)';

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

/** Варианты запроса: сначала точный адрес, потом название площадки. */
function queries({ name, address }) {
  const city = SUBURBS.test(`${name} ${address}`) ? '' : ', Москва';
  const bare = (name || '').replace(/\(.*?\)/g, '').trim();
  const out = [];
  if (address) out.push(address.includes('Москва') ? address : `${address}${city}`);
  if (bare) out.push(`кинотеатр ${bare}${city}`, `${bare}${city}`);
  return [...new Set(out.filter(Boolean))];
}

/**
 * Ищет координаты по названию и адресу. Возвращает {lat, lon, via} или null.
 * Результат — включая неудачу — запоминается, чтобы не спрашивать дважды.
 */
export async function geocode({ name, address = '' }) {
  const store = await load();
  const key = `${name}|${address}`.trim();

  if (key in store) return store[key];

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
