#!/usr/bin/env node
// Собирает список кинотеатров Москвы в data/cinemas.json.
//
// Два источника, и это принципиально:
//   1. data/cinemas-seed.csv — выверенный вручную перечень площадок. Он
//      определяет, что на карте обязано быть, но координат в нём нет.
//   2. OpenStreetMap через Overpass — координаты и адреса.
//
// Площадки из перечня, которых в OSM не нашлось, геокодируются по названию;
// результат кэшируется в data/geocode.json, чтобы каждый запуск не дёргал
// геокодер заново. Кинотеатры, найденные только в OSM, тоже остаются — так
// список получается не уже ни одного из источников.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { UA } from './lib/util.mjs';
import { bestMatch, normalize } from './lib/match.mjs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Рамка вокруг Москвы с запасом: в перечне есть Реутов, Подольск,
// Красногорск, Пушкино и Зеленоград — формально это уже область.
const BBOX = '55.30,36.70,56.20,38.20';

const QUERY = `
[out:json][timeout:90];
(
  node(${BBOX})["amenity"="cinema"];
  way(${BBOX})["amenity"="cinema"];
  relation(${BBOX})["amenity"="cinema"];
  node(${BBOX})["building"="cinema"];
  way(${BBOX})["building"="cinema"];
);
out center tags;
`;

const REQUEST_TIMEOUT = 100000;
const dataUrl = (f) => new URL(`../data/${f}`, import.meta.url);

// ── OpenStreetMap ────────────────────────────────────────────────────────────

async function overpass() {
  let lastErr;
  for (const url of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt) await new Promise((r) => setTimeout(r, 10000));
        console.log(`[cinemas] Overpass: ${url}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: QUERY }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const text = await res.text();
        if (!text.trimStart().startsWith('{')) {
          throw new Error(`ответ не JSON: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
        }
        return JSON.parse(text);
      } catch (err) {
        console.warn(`[cinemas] ${url} не ответил: ${err.message}`);
        lastErr = err;
      }
    }
  }
  throw lastErr;
}

// Под amenity=cinema попадают аттракционы «5D/7D» в ТЦ — это кабинки
// с креслами, сеансов у них не бывает.
const ATTRACTION = /(^|\W)(\d{1,2}\s*[-–]?\s*d\b|аттракцион|кинокабин)/i;

const isAttraction = (name, tags) =>
  tags.attraction || tags['cinema:type'] === 'attraction'
    ? true
    : ATTRACTION.test(name) && !/^(3\s*d|imax)/i.test(name);

function toCinema(el) {
  const t = el.tags || {};
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  if (lat == null || lon == null) return null;

  const name = t['name:ru'] || t.name || t.brand || t.operator;
  if (!name || isAttraction(name, t)) return null;

  return {
    id: `${el.type[0]}${el.id}`,
    name,
    brand: t.brand || t.operator || '',
    lat: +lat.toFixed(6),
    lon: +lon.toFixed(6),
    address: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(', ') || t['addr:full'] || '',
    website: t.website || t['contact:website'] || '',
    phone: t.phone || t['contact:phone'] || '',
    source: 'osm',
  };
}

// ── Геокодирование площадок, которых нет в OSM ───────────────────────────────

const SUBURBS = /(реутов|подольск|красногорск|пушкино|зеленоград|химки|мытищи|люберцы|одинцово)/i;

/** Варианты запроса: от точного к более общему. */
function geocodeQueries(name) {
  const city = SUBURBS.test(name) ? '' : ', Москва';
  const bare = name.replace(/\(.*?\)/g, '').trim();
  return [
    `кинотеатр ${bare}${city}`,
    `${bare}${city}`,
    `${bare.split(/\s+/).slice(-2).join(' ')}${city}`,
  ];
}

async function geocode(name) {
  for (const q of geocodeQueries(name)) {
    try {
      const url =
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
        `&format=json&limit=1&countrycodes=ru&viewbox=36.7,56.2,38.2,55.3&bounded=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'cinemafinder/1.0 (github.com/veraxxxo/cinemafinder)' },
        signal: AbortSignal.timeout(30000),
      });
      // Правила Nominatim — не чаще запроса в секунду.
      await new Promise((r) => setTimeout(r, 1200));
      if (!res.ok) {
        console.warn(`[geo] «${q}»: HTTP ${res.status}`);
        continue;
      }
      const hits = await res.json();
      if (hits[0]) {
        return {
          lat: +Number(hits[0].lat).toFixed(6),
          lon: +Number(hits[0].lon).toFixed(6),
          via: q,
          display: hits[0].display_name,
        };
      }
    } catch (err) {
      console.warn(`[geo] «${q}»: ${err.message}`);
    }
  }
  return null;
}

// ── Сборка ───────────────────────────────────────────────────────────────────

const seedCsv = await readFile(dataUrl('cinemas-seed.csv'), 'utf8');
const seed = seedCsv
  .trim()
  .split('\n')
  .slice(1)
  .map((line) => {
    const [name, site] = line.split(';');
    return { name: name?.trim(), site: site?.trim() || '' };
  })
  .filter((s) => s.name);

console.log(`[cinemas] В перечне площадок: ${seed.length}`);

const osm = (await overpass()).elements.map(toCinema).filter(Boolean);
console.log(`[cinemas] Из OpenStreetMap: ${osm.length}`);

let cache = {};
try {
  cache = JSON.parse(await readFile(dataUrl('geocode.json'), 'utf8'));
} catch {
  /* кэша ещё нет */
}

const out = [];
const usedOsm = new Set();
const unresolved = [];
let fromOsm = 0;
let fromCache = 0;
let fromGeo = 0;

for (const s of seed) {
  const hit = bestMatch(s.name, osm.filter((o) => !usedOsm.has(o.id)));

  if (hit) {
    usedOsm.add(hit.item.id);
    fromOsm++;
    out.push({
      ...hit.item,
      name: s.name,            // каноническое имя из перечня
      osmName: hit.item.name,  // как называется в OSM — для отладки
      website: s.site ? `https://${s.site}` : hit.item.website,
      source: 'seed+osm',
    });
    continue;
  }

  const cached = cache[s.name];
  if (cached?.lat) {
    fromCache++;
    out.push({
      id: `s${normalize(s.name).replace(/\s/g, '-')}`,
      name: s.name,
      lat: cached.lat,
      lon: cached.lon,
      address: cached.display || '',
      website: s.site ? `https://${s.site}` : '',
      brand: '',
      source: 'seed+geo',
    });
    continue;
  }

  const geo = await geocode(s.name);
  if (geo) {
    fromGeo++;
    cache[s.name] = { ...geo, at: new Date().toISOString() };
    out.push({
      id: `s${normalize(s.name).replace(/\s/g, '-')}`,
      name: s.name,
      lat: geo.lat,
      lon: geo.lon,
      address: geo.display || '',
      website: s.site ? `https://${s.site}` : '',
      brand: '',
      source: 'seed+geo',
    });
    console.log(`[geo] ${s.name} → ${geo.lat}, ${geo.lon} (по запросу «${geo.via}»)`);
  } else {
    unresolved.push(s.name);
  }
}

// Кинотеатры, найденные только в OSM, тоже нужны — перечень не претендует
// на полноту, он лишь гарантирует минимум.
for (const o of osm) {
  if (usedOsm.has(o.id)) continue;
  if (bestMatch(o.name, out)) continue; // уже есть под другим именем
  out.push(o);
}

out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

console.log(
  `\n[cinemas] Перечень: ${fromOsm} нашлись в OSM, ${fromCache} из кэша координат, ` +
    `${fromGeo} геокодировано, ${unresolved.length} без координат`,
);
if (unresolved.length) console.log(`[cinemas] Без координат: ${unresolved.join(' | ')}`);
console.log(`[cinemas] Итого площадок: ${out.length} (из них только в OSM: ${out.filter((c) => c.source === 'osm').length})`);

if (out.length < 50) {
  throw new Error(`Подозрительно мало кинотеатров (${out.length}) — не перезаписываю данные`);
}

await mkdir(dataUrl(''), { recursive: true });
await writeFile(
  dataUrl('cinemas.json'),
  JSON.stringify(
    {
      updated: new Date().toISOString(),
      source: 'data/cinemas-seed.csv + OpenStreetMap (Overpass) + Nominatim',
      count: out.length,
      seedTotal: seed.length,
      unresolved,
      items: out,
    },
    null,
    1,
  ),
);
await writeFile(dataUrl('geocode.json'), JSON.stringify(cache, null, 1));

console.log(`[cinemas] Сохранено ${out.length} кинотеатров`);
