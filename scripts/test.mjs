#!/usr/bin/env node
// Офлайн-проверка логики парсинга и сшивки на синтетических фикстурах.
// Сеть не нужна: `node scripts/test.mjs`.

import assert from 'node:assert/strict';
import { normalizeTitle, movieKey, cityOfCinemaUrl } from './sources/kinoafisha.mjs';
import { cinemaBlocks, sessionsIn, contentOf } from '../parse-showtimes.js';
import { normName, nameTokens, timeToMinutes, jsonLd, embeddedState, stripTags } from './lib/util.mjs';
import { makeCinemaMatcher } from './lib/stitch.mjs';
import { _queries as geoQueries } from './lib/geocode.mjs';
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

console.log('\nпарсер kinoafisha по живой разметке');

const PAGE = `
<style>.session_time{color:#000}.session_price{font-size:10px}</style>
<header><a href="/russia/msk/cinema/">Кинотеатры</a></header>
<div class="site_content">
  <div class="showtimes_item">
    <a class="showtimes_cinemaTitle" href="https://www.kinoafisha.info/russia/msk/cinema/1234/">КАРО 11 Октябрь</a>
    <div class="sessions">
      <div class="session session-ticket">
        <span class="session_time">12:20</span><span class="session_price">от 450 \u20bd</span>
      </div>
      <div class="session">
        <span class="session_time">19:30</span><span class="session_price">от 1 200 \u20bd</span>
      </div>
    </div>
  </div>
  <div class="showtimes_item">
    <a class="showtimes_cinemaTitle" href="https://www.kinoafisha.info/russia/msk/cinema/99/">Художественный</a>
    <div class="sessions">
      <div class="session"><span class="session_time">21:15</span></div>
    </div>
  </div>
</div>`;

test('стили и шапка не мешают разбору', () => {
  const c = contentOf(PAGE);
  assert.ok(!/session_time\{/.test(c), 'таблица стилей должна быть вырезана');
  assert.ok(!/Кинотеатры<\/a>/.test(c), 'шапка сайта должна быть вырезана');
});

test('страница делится на блоки «кинотеатр → сеансы»', () => {
  const blocks = cinemaBlocks(contentOf(PAGE));
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.name), ['КАРО 11 Октябрь', 'Художественный']);

  const first = sessionsIn(blocks[0].chunk);
  assert.deepEqual(first.map((s) => s.time), ['12:20', '19:30'], 'оба сеанса первого зала');
  assert.equal(first[0].price, 450);
  assert.equal(first[1].price, 1200, 'пробел в «1 200» не должен ломать цену');

  const second = sessionsIn(blocks[1].chunk);
  assert.deepEqual(second.map((s) => s.time), ['21:15'], 'сеансы не перетекают в соседний зал');
  assert.equal(second[0].price, null, 'без цены — null, а не ноль');
});

test('время находится не только в span и не только текстом', () => {
  // Ровно то, на чём разбор терял всё: браузер видел 49 элементов с
  // временами, а старая регулярка требовала <span>…</span> без вложений.
  const alt =
    '<div class="session_time__x1">19:30</div>' +
    '<a class="session_time"><span class="tick">21:05</span></a>' +
    '<div class="session_price">от 700 \u20bd</div>';
  assert.deepEqual(sessionsIn(alt).map((s) => s.time), ['19:30', '21:05']);
  assert.equal(sessionsIn(alt)[1].price, 700, 'цена берётся из соседнего блока');
});

test('на странице без сеансов ничего не выдумывается', () => {
  assert.deepEqual(sessionsIn('<div>19:30</div>'), []);
  assert.deepEqual(cinemaBlocks('<p>пусто</p>'), []);
});

console.log('\nнормализация названий фильмов');

test('срезает год, номер и хвост «расписание»', () => {
  assert.equal(normalizeTitle('  Дюна: Часть третья (2026) '), 'Дюна: Часть третья');
  assert.equal(normalizeTitle('Одиссея — расписание в Москве'), 'Одиссея');
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

test('город определяется по ссылке на кинотеатр', () => {
  // На московской странице фильма попадались залы петербургской сети —
  // отличить их можно только по адресу ссылки, по названию никак.
  assert.equal(cityOfCinemaUrl('https://www.kinoafisha.info/russia/msk/cinema/1234/'), 'msk');
  assert.equal(cityOfCinemaUrl('https://www.kinoafisha.info/russia/spb/cinema/99/'), 'spb');
  assert.equal(cityOfCinemaUrl('/cinema/77/'), '?', 'относительная ссылка — город неизвестен');
  assert.equal(cityOfCinemaUrl(''), '?');
});

console.log('\nгеокодер');

test('пробует опознаваемые куски названия, а не только строку целиком', () => {
  // «Мираж Синема в ТРК «Европолис»» Nominatim не понимает — нужен «Европолис».
  const q = geoQueries({ name: 'Мираж Синема в ТРК «Европолис»', address: '' });
  assert.ok(q.includes('Европолис, Москва'), 'название ТРЦ берётся из кавычек');
  // Полное название пробуется первым, и «ТРК» в нём законно. Ловим ровно тот
  // огрызок, который получался, пока \b не срабатывал на кириллице.
  assert.ok(!q.includes('в ТРК Европолис, Москва'), 'оборот «в ТРК» в огрызке не остаётся');

  const p = geoQueries({ name: 'Киномакс-Релакс Пушкино', address: '' });
  assert.ok(p.includes('Релакс Пушкино'), 'дефис после имени сети не остаётся');
  assert.ok(p.every((s) => !s.includes('Москва')), 'городу-спутнику Москву не дописываем');
});

console.log('\nсшивка «афиша ↔ OpenStreetMap»');

// Матчер берётся из боевого модуля, а не пишется здесь заново: раньше тест
// держал собственную копию логики, копия разошлась с оригиналом — и проверки
// оставались зелёными при сломанной сшивке.
const makeMatcher = makeCinemaMatcher;

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

test('точка, названная одним брендом, не забирает залы сети', () => {
  // Ровно то, на чём сшивка сломалась: в OSM есть безымянные точки «Мираж»,
  // «Каро», «Люксор» — и раньше на них садились все залы соответствующей сети.
  const match = makeMatcher([
    { id: 'n1', name: 'Мираж' },
    { id: 'n2', name: 'Каро' },
    { id: 'n3', name: 'Мираж Синема Реутов' },
  ]);

  assert.equal(match('Мираж Синема Юго-Запад'), null, 'чужой зал сети не липнет к бренду');
  assert.equal(match('КАРО 8 Саларис'), null, 'номер и ТЦ не делают из бренда конкретный зал');
  assert.equal(match('Мираж')?.id, 'n1', 'само имя бренда по-прежнему находится');
  assert.equal(match('Мираж Синема Реутов')?.id, 'n3', 'настоящий зал находится по различающей части');
});

console.log(`\n${passed} проверок пройдено${process.exitCode ? ' — есть падения' : ''}\n`);
