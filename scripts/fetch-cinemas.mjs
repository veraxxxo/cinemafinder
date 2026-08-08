#!/usr/bin/env node
// Забирает все кинотеатры Москвы из OpenStreetMap через Overpass API
// и складывает в data/cinemas.json.

import { writeFile, mkdir } from 'node:fs/promises';
import { UA } from './lib/util.mjs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// relation 102269 — Москва (включая ТиНАО). Берём и точки, и здания.
const QUERY = `
[out:json][timeout:180];
rel(102269); map_to_area -> .msk;
(
  node(area.msk)["amenity"="cinema"];
  way(area.msk)["amenity"="cinema"];
  relation(area.msk)["amenity"="cinema"];
);
out center tags;
`;

async function overpass() {
  let lastErr;
  for (const url of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt) await new Promise((r) => setTimeout(r, 15000));
        console.log(`[cinemas] Overpass: ${url}`);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ data: QUERY }),
          signal: AbortSignal.timeout(190000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const text = await res.text();
        // Перегруженный Overpass отвечает 200 и HTML-страницей с ошибкой.
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

function buildAddress(t) {
  const parts = [
    t['addr:street'],
    t['addr:housenumber'],
  ].filter(Boolean);
  const street = parts.join(', ');
  return street || t['addr:full'] || '';
}

// В OSM под amenity=cinema попадают и аттракционы «5D/7D/9D» в ТЦ — это
// кабинки с креслами, а не кинотеатры, и сеансов у них не бывает.
const ATTRACTION = /(^|\W)(\d{1,2}\s*[-–]?\s*d\b|аттракцион|кинокабин)/i;

function isAttraction(name, tags) {
  if (tags.attraction || tags['cinema:type'] === 'attraction') return true;
  return ATTRACTION.test(name) && !/^(3\s*d|imax)/i.test(name);
}

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
    address: buildAddress(t),
    website: t.website || t['contact:website'] || '',
    phone: t.phone || t['contact:phone'] || '',
    screens: t.screen ? +t.screen : null,
    opening_hours: t.opening_hours || '',
  };
}

/** Убирает дубли: одна и та же точка бывает и нодой, и зданием. */
function dedupe(list) {
  const out = [];
  for (const c of list) {
    const dup = out.find(
      (o) =>
        o.name.toLowerCase() === c.name.toLowerCase() &&
        Math.abs(o.lat - c.lat) < 0.0025 &&
        Math.abs(o.lon - c.lon) < 0.0045,
    );
    if (!dup) {
      out.push(c);
      continue;
    }
    // оставляем запись с более полными данными
    if (Object.values(c).filter(Boolean).length > Object.values(dup).filter(Boolean).length) {
      out[out.indexOf(dup)] = c;
    }
  }
  return out;
}

const data = await overpass();
const cinemas = dedupe(
  (data.elements || []).map(toCinema).filter(Boolean),
).sort((a, b) => a.name.localeCompare(b.name, 'ru'));

if (cinemas.length < 50) {
  throw new Error(`Подозрительно мало кинотеатров (${cinemas.length}) — не перезаписываю данные`);
}

await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../data/cinemas.json', import.meta.url),
  JSON.stringify({ updated: new Date().toISOString(), source: 'OpenStreetMap / Overpass API', count: cinemas.length, items: cinemas }, null, 1),
);

console.log(`[cinemas] Сохранено ${cinemas.length} кинотеатров`);
