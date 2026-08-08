#!/usr/bin/env node
// Разведка полноты списка кинотеатров: сколько даёт каждый вариант запроса
// к OpenStreetMap и что могут добавить сторонние источники.
// Запускается вручную из workflow «Диагностика источников (кинотеатры)».

import { getJson, getText, stripTags, UA } from './lib/util.mjs';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const AREA = 'rel(102269); map_to_area -> .a;';

/** Варианты отбора: от текущего к всё более широким. */
const VARIANTS = {
  'amenity=cinema (текущий)': `
    (node(area.a)["amenity"="cinema"];way(area.a)["amenity"="cinema"];rel(area.a)["amenity"="cinema"];);`,
  'building=cinema': `
    (node(area.a)["building"="cinema"];way(area.a)["building"="cinema"];);`,
  'amenity | building | disused': `
    (node(area.a)["amenity"="cinema"];way(area.a)["amenity"="cinema"];rel(area.a)["amenity"="cinema"];
     node(area.a)["building"="cinema"];way(area.a)["building"="cinema"];
     node(area.a)["disused:amenity"="cinema"];way(area.a)["disused:amenity"="cinema"];);`,
  'название содержит «кино»': `
    (node(area.a)["name"~"[Кк]ино"];way(area.a)["name"~"[Кк]ино"];);`,
  'есть тег cinema:*': `
    (node(area.a)[~"^cinema"~"."];way(area.a)[~"^cinema"~"."];);`,
};

async function overpass(body) {
  let last;
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({ data: body }),
        signal: AbortSignal.timeout(120000),
      });
      const text = await res.text();
      if (!res.ok) {
        // Тело ответа — единственное место, где Overpass объясняет отказ.
        throw new Error(`HTTP ${res.status} — ${stripTags(text).slice(0, 200)}`);
      }
      if (!text.trimStart().startsWith('{')) {
        throw new Error(`ответ не JSON — ${stripTags(text).slice(0, 200)}`);
      }
      return JSON.parse(text);
    } catch (err) {
      console.log(`   [${url.split('/')[2]}] ${err.message}`);
      last = err;
    }
  }
  throw last;
}

console.log('═'.repeat(78));
console.log('OpenStreetMap: сколько объектов даёт каждый вариант');
console.log('═'.repeat(78));

const found = {};

// Overpass отвечает минутами; когда нужен только разбор сайтов, его можно
// пропустить: SKIP_OSM=1.
for (const [label, selector] of (process.env.SKIP_OSM ? [] : Object.entries(VARIANTS))) {
  try {
    const data = await overpass(`[out:json][timeout:110];${AREA}${selector}out center tags;`);
    const named = (data.elements || []).filter((e) => e.tags?.name || e.tags?.['name:ru']);
    const withCoords = named.filter((e) => (e.lat ?? e.center?.lat) != null);
    found[label] = new Set(withCoords.map((e) => (e.tags['name:ru'] || e.tags.name).trim()));
    console.log(`\n${label}`);
    console.log(`   всего объектов: ${data.elements.length} | с именем и координатами: ${withCoords.length}`);
    console.log(`   уникальных имён: ${found[label].size}`);
  } catch (err) {
    console.log(`\n${label}\n   ОШИБКА: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 4000)); // не долбим общий Overpass
}

// Что добавляют расширенные варианты сверх текущего.
const base = found['amenity=cinema (текущий)'];
if (base) {
  for (const [label, names] of Object.entries(found)) {
    if (label === 'amenity=cinema (текущий)') continue;
    const extra = [...names].filter((n) => !base.has(n));
    console.log(`\n«${label}» добавляет сверх текущего: ${extra.length}`);
    console.log('   ' + extra.slice(0, 40).join(' | '));
  }
}

console.log('\n' + '═'.repeat(78));
console.log('Сторонние источники площадок');
console.log('═'.repeat(78));

// KudaGo: у площадок есть координаты, их можно вливать напрямую.
try {
  const seen = new Map();
  for (let page = 1; page <= 10; page++) {
    const d = await getJson(
      `https://kudago.com/public-api/v1.4/places/?location=msk&categories=cinema` +
        `&page_size=100&page=${page}&fields=id,title,address,coords`,
    ).catch(() => null);
    if (!d?.results?.length) break;
    for (const p of d.results) seen.set(p.id, p);
    if (!d.next) break;
  }
  console.log(`\nKudaGo places (categories=cinema): ${seen.size}`);
  const news = [...seen.values()].filter((p) => base && ![...base].some((n) => p.title.includes(n)));
  console.log(`   которых нет в OSM по имени: ${news.length}`);
  console.log('   ' + news.slice(0, 30).map((p) => p.title).join(' | '));
} catch (err) {
  console.log(`\nKudaGo: ОШИБКА ${err.message}`);
}

// Сайты сетей: сколько площадок перечислено и есть ли адреса.
const CHAINS = [
  ['Афиша.ру — карта кинотеатров', 'https://www.afisha.ru/msk/cinema/cinema_list/?view=map'],
  ['Афиша.ру — список кинотеатров', 'https://www.afisha.ru/msk/cinema/cinema_list/'],
  ['Формула Кино / Синема Парк', 'https://kinoteatr.ru/raspisanie-kinoteatrov/'],
  ['Кинотеатр.ру — кинотеатры Москвы', 'https://kinoteatr.ru/kinoteatry-moskvy/'],
  ['КАРО', 'https://karofilm.ru/theatres'],
  ['КАРО (api)', 'https://api.karofilm.ru/cinemas'],
  ['Москино', 'https://mos-kino.ru/'],
  ['Москино — площадки', 'https://mos-kino.ru/theatres'],
  ['Синема Стар', 'https://cinemastar.ru/cinemas'],
  ['Пять звёзд', 'https://5zvezd.ru/'],
];

for (const [name, url] of CHAINS) {
  try {
    const html = await getText(url, { retries: 1, timeout: 30000 });
    if (html.trimStart().startsWith('{') || html.trimStart().startsWith('[')) {
      console.log(`\n${name} — JSON, ${(html.length / 1024).toFixed(1)} КБ`);
      console.log('   ' + html.slice(0, 700));
      continue;
    }
    // Ищем куски, похожие на «улица …, дом …» — признак списка адресов.
    const addresses = [...html.matchAll(/(?:ул\.|улица|просп|пр-т|шоссе|наб\.|пер\.|пл\.)[^<>{}]{5,60}/gi)]
      .map((m) => stripTags(m[0]).trim());
    const uniq = [...new Set(addresses)];
    console.log(`\n${name} — HTML, ${(html.length / 1024).toFixed(1)} КБ`);
    console.log(`   адресов на странице: ${uniq.length}`);
    console.log('   ' + uniq.slice(0, 12).join(' | '));

    // Координаты — самое ценное: с ними площадку можно ставить на карту
    // без геокодера. Ищем и подписанные пары, и «широта, долгота» подряд.
    const coordPairs = [
      ...html.matchAll(/"(?:lat|latitude)"\s*:\s*"?(5[45]\.\d+)"?[\s\S]{0,80}?"(?:lon|lng|longitude)"\s*:\s*"?(3[678]\.\d+)"?/gi),
      ...html.matchAll(/\[\s*(5[45]\.\d{3,})\s*,\s*(3[678]\.\d{3,})\s*\]/g),
      ...html.matchAll(/"coordinates"\s*:\s*\[\s*(3[678]\.\d{3,})\s*,\s*(5[45]\.\d{3,})/gi),
    ];
    console.log(`   пар координат в разметке: ${coordPairs.length}`);
    if (coordPairs.length) {
      console.log('   ' + coordPairs.slice(0, 5).map((m) => `${m[1]},${m[2]}`).join(' | '));
      const i = html.indexOf(coordPairs[0][0]);
      console.log('   контекст: ' + html.slice(Math.max(0, i - 260), i + 160).replace(/\s+/g, ' '));
    }
  } catch (err) {
    console.log(`\n${name} — ОШИБКА: ${err.message}`);
  }
}

// Геокодер: адреса сетей без координат бесполезны для карты. Проверяем,
// пускает ли Nominatim запросы с IP дата-центра (у него строгие правила).
console.log('\n' + '═'.repeat(78));
console.log('Геокодирование адресов');
console.log('═'.repeat(78));
try {
  const q = encodeURIComponent('Москва, площадь Киевского Вокзала, 2');
  const r = await getJson(
    `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`,
    { headers: { 'User-Agent': 'cinemafinder/1.0 (github.com/veraxxxo/cinemafinder)' } },
  );
  console.log(`\nNominatim отвечает: ${r.length ? `${r[0].lat}, ${r[0].lon} — ${r[0].display_name}` : 'пусто'}`);
} catch (err) {
  console.log(`\nNominatim: ОШИБКА ${err.message}`);
}
