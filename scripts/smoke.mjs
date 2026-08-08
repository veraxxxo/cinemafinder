#!/usr/bin/env node
// Прогон интерфейса в настоящем браузере: страница поднимается на локальном
// сервере, данные подменяются фикстурой, дальше кликаем фильтры и сверяем,
// что список и счётчики пересчитались.
//
//   node scripts/smoke.mjs            — как есть
//   node scripts/smoke.mjs --shot out.png  — ещё и скриншот
//
// Требует @playwright/test. Не входит в обычный `npm test`: тому сеть не нужна,
// а этому нужен браузер.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

// ── Фикстура: два кинотеатра, три фильма, разнесённые по времени сеансы ──────

const CINEMAS = {
  count: 2,
  items: [
    { id: 'n1', name: 'Октябрь', lat: 55.7522, lon: 37.5896, address: 'Новый Арбат, 24', website: '' },
    { id: 'n2', name: 'Художественный', lat: 55.7469, lon: 37.5936, address: 'Арбатская пл., 14', website: '' },
  ],
};

const SCHEDULE = {
  updated: '2026-08-08T09:00:00.000Z',
  sources: [{ id: 'test', title: 'Фикстура' }],
  dates: ['2026-08-08', '2026-08-09'],
  stats: { shows: 6, movies: 3, cinemas: 2 },
  movies: [
    { id: 'duna', title: 'Дюна', count: 3 },
    { id: 'solaris', title: 'Солярис', count: 2 },
    { id: 'stalker', title: 'Сталкер', count: 1 },
  ],
  extraCinemas: [],
  shows: [
    { c: 'n1', m: 'duna', d: '2026-08-08', t: '10:00' },
    { c: 'n1', m: 'duna', d: '2026-08-08', t: '19:30' },
    { c: 'n1', m: 'solaris', d: '2026-08-08', t: '22:00' },
    { c: 'n2', m: 'solaris', d: '2026-08-08', t: '11:15' },
    { c: 'n2', m: 'stalker', d: '2026-08-08', t: '00:40' }, // ночной — это ещё 8-е
    { c: 'n1', m: 'duna', d: '2026-08-09', t: '18:00' },
  ],
};

// ── Сервер ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(req.url.split('?')[0]);

  if (path === '/data/cinemas.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(CINEMAS));
  }
  if (path === '/data/schedule.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(SCHEDULE));
  }

  const file = join(ROOT, normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── Проверки ─────────────────────────────────────────────────────────────────

let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      получено ${JSON.stringify(actual)}, ждали ${JSON.stringify(expected)}`}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(base, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.querySelectorAll('#results li').length > 0, { timeout: 15000 });

const names = () => page.$$eval('#results .name', (els) => els.map((e) => e.textContent));
const times = () => page.$$eval('#results .times b', (els) => els.map((e) => e.textContent));
const summary = () => page.$eval('#summary', (e) => e.textContent.replace(/\s+/g, ' ').trim());

console.log('\nстарт');
check('оба кинотеатра в списке', (await names()).sort(), ['Октябрь', 'Художественный']);
check('сводка за сегодня', await summary(), '2 кинотеатров · 5 сеансов · 3 фильмов');

// По умолчанию показываются все площадки, даже без сеансов, — иначе при
// редком расписании карта выглядит пустой. Дальше проверяем сам фильтр,
// поэтому включаем «только с сеансами» явно.
check('галка «только с сеансами» снята по умолчанию',
  await page.$eval('#only-with-shows', (e) => e.checked), false);
await page.check('#only-with-shows');
await page.waitForTimeout(120);

console.log('\nфильтр по времени: вечер');
await page.click('#time-presets button[data-from="1080"]');
await page.waitForTimeout(120);
check('остался только Октябрь', await names(), ['Октябрь']);
check('вечерние сеансы', (await times()).sort(), ['19:30', '22:00']);

console.log('\nфильтр по времени: ночь');
await page.click('#time-presets button[data-from="1380"]');
await page.waitForTimeout(120);
check('ночной 00:40 отнесён к вечеру 8-го', await names(), ['Художественный']);
check('время ночного сеанса', await times(), ['00:40']);

console.log('\nсброс и фильтр по фильму');
await page.click('#reset');
await page.waitForTimeout(120);
check('сброс не трогает «только с сеансами»',
  await page.$eval('#only-with-shows', (e) => e.checked), true);
await page.click('#movie-input');
await page.fill('#movie-input', 'соля');
await page.waitForTimeout(150);
check('подсказка нашла Солярис', await page.$$eval('#movie-suggest li span', (e) => e.map((x) => x.textContent)), ['Солярис']);

await page.click('#movie-suggest li');
await page.waitForTimeout(150);
check('выбранный фильм показан тегом', await page.$$eval('.tag span', (e) => e.map((x) => x.textContent)), ['Солярис']);
check('только площадки с Солярисом', (await names()).sort(), ['Октябрь', 'Художественный']);
check('сводка по одному фильму', await summary(), '2 кинотеатров · 2 сеансов · 1 фильмов');

console.log('\nпоиск по кинотеатру');
await page.fill('#cinema-input', 'художест');
await page.waitForTimeout(300);
check('поиск сузил до одного', await names(), ['Художественный']);

console.log('\nненайденный фильм объясняется, а не молчит');
await page.fill('#movie-input', 'одиссея');
await page.waitForTimeout(200);
check('подсказка сообщает, что фильма нет',
  await page.$$eval('#movie-suggest li.nores', (e) => e.length), 1);
await page.fill('#movie-input', '');

console.log('\nпереключение даты');
await page.click('#reset');
await page.fill('#cinema-input', '');
await page.waitForTimeout(200);
await page.click('#dates button:nth-child(2)');
await page.waitForTimeout(150);
check('на завтра только один сеанс', await summary(), '1 кинотеатров · 1 сеансов · 1 фильмов');

const shot = process.argv.indexOf('--shot');
if (shot > -1) {
  await page.click('#reset');
  await page.waitForTimeout(200);
  await page.screenshot({ path: process.argv[shot + 1] || 'smoke.png', fullPage: false });
  console.log(`\nскриншот: ${process.argv[shot + 1] || 'smoke.png'}`);
}

if (errors.length) {
  // Leaflet тянется с CDN: без сети он не загрузится, и это ожидаемо —
  // приложение обязано пережить это и показать список.
  const real = errors.filter((e) => !/Leaflet|\bL\b is not defined/.test(e));
  for (const e of real) console.log(`  ✗ ошибка на странице: ${e}`);
  failed += real.length;
}

await browser.close();
server.close();

console.log(failed ? `\n${failed} проверок упало\n` : '\nВсе проверки интерфейса пройдены\n');
process.exit(failed ? 1 : 0);
