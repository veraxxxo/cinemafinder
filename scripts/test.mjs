#!/usr/bin/env node
// Офлайн-проверка логики парсинга и сшивки на синтетических фикстурах.
// Сеть не нужна: `node scripts/test.mjs`.

import assert from 'node:assert/strict';
import { fromHtml, fromJsonLd, fromState, normalizeTitle, movieKey } from './sources/kinoafisha.mjs';
import { normName, nameTokens, timeToMinutes, jsonLd, embeddedState, stripTags } from './lib/util.mjs';
import { msk as kudagoMsk, price as kudagoPrice, format as kudagoFormat } from './sources/kudago.mjs';

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('\nutil');

test('normName сносит тип, кавычки и адресный хвост', () => {
  assert.equal(normName('Кинотеатр «Октябрь» (Новый Арбат, 24)'), 'октябрь');
  assert.equal(normName('КАРО 11 Октябрь'), 'каро 11 октябрь');
  assert.equal(normName('Формула Кино на Кутузовском'), 'формула на кутузовском');
});

test('nameTokens выкидывает стоп-слова и короткие куски', () => {
  const t = nameTokens('Синема Парк в ТРЦ Ривьера');
  assert.ok(t.has('синема') && t.has('парк') && t.has('ривьера'));
  assert.ok(!t.has('трц') && !t.has('в'));
});

test('ночные сеансы уезжают за 24 часа', () => {
  assert.equal(timeToMinutes('10:30'), 630);
  assert.equal(timeToMinutes('23:59'), 1439);
  assert.equal(timeToMinutes('00:40'), 24 * 60 + 40);
  assert.equal(timeToMinutes('05:15'), 29 * 60 + 15);
  assert.equal(timeToMinutes('чепуха'), null);
});

test('stripTags вычищает скрипты и мнемоники', () => {
  assert.equal(stripTags('<p>Кино<script>alert(1)</script>&nbsp;&amp;&nbsp;чай</p>'), 'Кино & чай');
});

test('jsonLd переживает битый блок', () => {
  const html =
    '<script type="application/ld+json">{ битое }</script>' +
    '<script type="application/ld+json">{"@type":"Movie","name":"Ок"}</script>';
  const found = jsonLd(html);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'Ок');
});

console.log('\nпарсер: уровень «состояние SPA»');

test('достаёт сеансы из __NEXT_DATA__', () => {
  const state = {
    props: {
      pageProps: {
        schedule: [
          { time: '19:30', cinemaName: 'Октябрь', cinemaId: 5, movieName: 'Дюна', movieId: 9, price: 550, url: '/t/1' },
          { time: '22:10', cinema: { id: 7, name: 'Художественный' }, movie: { title: 'Солярис' }, hall: 'IMAX' },
          { time: 'не время', cinemaName: 'Мусор', movieName: 'Мусор' },
        ],
      },
    },
  };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script>`;
  const shows = fromState(html, '2026-08-08');

  assert.equal(shows.length, 2, 'узел без валидного времени должен отсеяться');
  assert.deepEqual(
    shows.map((s) => [s.cinemaName, s.movieTitle, s.time]),
    [['Октябрь', 'Дюна', '19:30'], ['Художественный', 'Солярис', '22:10']],
  );
  assert.equal(shows[0].url, 'https://www.kinoafisha.info/t/1', 'относительная ссылка достраивается');
  assert.equal(shows[0].price, 550);
  assert.equal(shows[1].hall, 'IMAX');
});

test('embeddedState не падает на странице без состояния', () => {
  assert.equal(embeddedState('<html><body>ничего</body></html>'), null);
  assert.deepEqual(fromState('<html></html>', '2026-08-08'), []);
});

console.log('\nпарсер: уровень «JSON-LD»');

test('читает ScreeningEvent', () => {
  const html = `<script type="application/ld+json">${JSON.stringify([
    {
      '@type': 'ScreeningEvent',
      startDate: '2026-08-08T21:15:00+03:00',
      location: { '@type': 'MovieTheater', name: 'Каро 11 Октябрь' },
      workPresented: { '@type': 'Movie', name: 'Интерстеллар' },
      videoFormat: 'IMAX',
      offers: { price: '700', url: 'https://buy.example/1' },
    },
    { '@type': 'ScreeningEvent', startDate: 'кривая дата', location: { name: 'X' } },
  ])}</script>`;

  const shows = fromJsonLd(html, '2026-08-08');
  assert.equal(shows.length, 1);
  assert.equal(shows[0].time, '21:15');
  assert.equal(shows[0].date, '2026-08-08');
  assert.equal(shows[0].cinemaName, 'Каро 11 Октябрь');
  assert.equal(shows[0].movieTitle, 'Интерстеллар');
  assert.equal(shows[0].price, 700);
  assert.equal(shows[0].hall, 'IMAX');
});

console.log('\nпарсер: уровень «HTML»');

test('разбирает блоки кинотеатр → фильм → времена', () => {
  const html = `
    <div class="page">
      <a href="/russia/msk/cinema/1234/"><span>КАРО 11 Октябрь</span></a>
      <div>
        <a href="/russia/msk/movies/8379477/">Дюна: Часть третья</a>
        <div class="t"><span>12:20</span><span>15:40</span><span>15:40</span></div>
        <a href="/russia/msk/movies/555/">Солярис</a>
        <div class="t"><span>19:05</span><span>23:50</span></div>
      </div>
      <a href="/russia/msk/cinema/99/"><span>Художественный</span></a>
      <div>
        <a href="/russia/msk/movies/555/">Солярис</a>
        <div class="t"><span>20:00</span></div>
      </div>
    </div>`;

  const shows = fromHtml(html, '2026-08-08');

  // 2 (дубль 15:40 схлопнут) + 2 + 1
  assert.equal(shows.length, 5, `ожидалось 5 сеансов, вышло ${shows.length}`);

  const oct = shows.filter((s) => s.cinemaName === 'КАРО 11 Октябрь');
  assert.equal(oct.length, 4);
  assert.equal(oct[0].cinemaId, '1234');
  assert.equal(oct[0].movieId, '8379477');
  assert.deepEqual(
    oct.filter((s) => s.movieTitle.startsWith('Дюна')).map((s) => s.time).sort(),
    ['12:20', '15:40'],
    'одинаковые времена внутри одного фильма не дублируются',
  );

  const hud = shows.filter((s) => s.cinemaName === 'Художественный');
  assert.equal(hud.length, 1, 'сеансы не должны перетекать в соседний кинотеатр');
  assert.equal(hud[0].time, '20:00');
});

test('не выдумывает сеансы на пустой странице', () => {
  assert.deepEqual(fromHtml('<html><body><p>13:37</p></body></html>', '2026-08-08'), []);
});

console.log('\nнормализация названий фильмов');

test('срезает год и порядковый номер, ключ стабилен', () => {
  assert.equal(normalizeTitle('  Дюна: Часть третья (2026) '), 'Дюна: Часть третья');
  assert.equal(normalizeTitle('12. Солярис'), 'Солярис');
  assert.equal(movieKey('Дюна: Часть третья (2026)'), movieKey('Дюна: Часть третья'));
  assert.equal(movieKey('Ёжик в тумане'), 'ежик-в-тумане');
});

console.log('\nисточник KudaGo');

test('сеанс в момент UTC переводится в московские дату и время', () => {
  assert.deepEqual(kudagoMsk(Date.parse('2026-08-08T15:00:00+03:00') / 1000), {
    date: '2026-08-08',
    time: '15:00',
  });
  // 22:30 UTC 8-го = 01:30 МСК уже 9-го — дата обязана съехать
  assert.deepEqual(kudagoMsk(Date.parse('2026-08-08T22:30:00Z') / 1000), {
    date: '2026-08-09',
    time: '01:30',
  });
});

test('цена вытаскивается из строки «800 руб.»', () => {
  assert.equal(kudagoPrice('800 руб.'), 800);
  assert.equal(kudagoPrice('от 1 200 руб.'), 1200);
  assert.equal(kudagoPrice(null), null);
  assert.equal(kudagoPrice('бесплатно'), null);
});

test('формат зала собирается из флагов', () => {
  assert.equal(kudagoFormat({ imax: true, three_d: true }), 'IMAX · 3D');
  assert.equal(kudagoFormat({ original_language: true }), 'ориг. язык');
  assert.equal(kudagoFormat({}), '');
});

console.log('\nсшивка «афиша ↔ OpenStreetMap»');

// Повторяет три прохода из fetch-schedule.mjs.
function makeMatcher(cinemas) {
  const exact = new Map();
  for (const c of cinemas) {
    const k = normName(c.name);
    if (k && !exact.has(k)) exact.set(k, c);
  }
  const idx = cinemas.map((c) => ({ c, tokens: nameTokens(c.name) }));

  return (raw) => {
    const key = normName(raw);
    let hit = exact.get(key) || null;
    if (!hit && key) {
      for (const [k, c] of exact) {
        if (k.length > 3 && (k.includes(key) || key.includes(k))) { hit = c; break; }
      }
    }
    if (!hit) {
      const want = nameTokens(raw);
      let best = null, bestScore = 0;
      for (const { c, tokens } of idx) {
        let shared = 0;
        for (const t of want) if (tokens.has(t)) shared++;
        const score = shared / Math.max(1, Math.min(want.size, tokens.size));
        if (shared && score > bestScore) { bestScore = score; best = c; }
      }
      if (bestScore >= 0.6) hit = best;
    }
    return hit;
  };
}

test('находит совпадения при разном написании', () => {
  const osm = [
    { id: 'n1', name: 'Октябрь' },
    { id: 'n2', name: 'Художественный' },
    { id: 'n3', name: 'Формула Кино Европейский' },
    { id: 'n4', name: 'Пять звёзд на Павелецкой' },
  ];
  const match = makeMatcher(osm);

  assert.equal(match('Октябрь')?.id, 'n1', 'точное совпадение');
  assert.equal(match('Кинотеатр «Художественный»')?.id, 'n2', 'тип и кавычки не мешают');
  assert.equal(match('КАРО 11 Октябрь')?.id, 'n1', 'сетевой префикс не мешает');
  assert.equal(match('Формула Кино Европейский')?.id, 'n3');
  assert.equal(match('Пять звезд на Павелецкой')?.id, 'n4', 'е/ё считаются одинаковыми');
});

test('не притягивает за уши посторонние названия', () => {
  const match = makeMatcher([{ id: 'n1', name: 'Октябрь' }, { id: 'n2', name: 'Художественный' }]);
  assert.equal(match('Ашан Марьино'), null);
  assert.equal(match('Каро Вегас Кунцево'), null);
});

console.log(`\n${passed} проверок пройдено${process.exitCode ? ' — есть падения' : ''}\n`);
