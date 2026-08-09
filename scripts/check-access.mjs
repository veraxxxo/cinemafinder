#!/usr/bin/env node
// Проверка адреса: что с этой машины открывается, а что закрыто.
//
// Смысл в том, чтобы решать вопрос «подойдёт ли этот сервер» за минуту, а не
// гадать. Сайты афиш блокируют по стране и по диапазону адресов, и результат
// целиком зависит от того, откуда идёт запрос. С адреса GitHub Actions почти
// всё закрыто, с домашнего — почти всё открыто, про VPS заранее не скажешь.
//
//   node scripts/check-access.mjs        — быстрая проверка обычными запросами
//   node scripts/check-access.mjs --browser  — ещё и настоящим Chromium
//
// Браузер важен отдельно: киноафиша отбивает обычный запрос, но пускает
// Chromium. Поэтому «закрыто напрямую» ещё не приговор.

import { get, stripTags } from './lib/util.mjs';

const WITH_BROWSER = process.argv.includes('--browser');

const TARGETS = [
  {
    name: 'kinoafisha.info',
    url: 'https://www.kinoafisha.info/russia/msk/movies/',
    want: /\/movies\/\d+\//,
    note: 'основной источник киносеансов',
  },
  {
    name: 'kinomax.ru',
    url: 'https://kinomax.ru/films',
    want: /\/films\/\d+/,
    note: 'сеть кинотеатров, из облака недоступна',
  },
  {
    name: 'afisha.ru',
    url: 'https://www.afisha.ru/msk/schedule_concert/',
    want: /concert|\/msk\//,
    note: 'концерты и спектакли',
  },
  {
    name: 'afisha.yandex.ru',
    url: 'https://afisha.yandex.ru/moscow/events',
    want: /\/moscow\/(concert|theatre|event)/,
    note: 'полная афиша событий',
  },
  {
    name: 'api.timepad.ru',
    url: 'https://api.timepad.ru/v1/events?limit=1',
    want: /"values"|"id"/,
    note: 'события, открытое API',
  },
  {
    name: 'kudago.com',
    url: 'https://kudago.com/public-api/v1.4/event-categories/',
    want: /"slug"/,
    note: 'работает отовсюду, наш нынешний источник',
  },
];

/** Признаки страницы-заглушки вместо содержимого. */
function verdictOf(body, want) {
  const title = stripTags((/<title>([\s\S]*?)<\/title>/i.exec(body) || [])[1] || '');
  if (/верификац|проверка браузера|один момент|just a moment|attention required/i.test(title)) {
    return { ok: false, why: `антибот: «${title}»` };
  }
  if (body.length < 2048) return { ok: false, why: `подозрительно мало — ${body.length} байт` };
  if (want && !want.test(body)) return { ok: false, why: 'страница без ожидаемого содержимого' };
  return { ok: true, why: `${(body.length / 1024).toFixed(0)} КБ` };
}

const rows = [];

for (const t of TARGETS) {
  let direct;
  try {
    const res = await get(t.url, { retries: 0, timeout: 25000 });
    const body = await res.text();
    direct = res.ok ? verdictOf(body, t.want) : { ok: false, why: `HTTP ${res.status}` };
  } catch (err) {
    direct = { ok: false, why: err.message.split('\n')[0].slice(0, 60) };
  }

  let browser = null;
  if (WITH_BROWSER && !direct.ok) {
    try {
      const { fetchPage } = await import('./lib/browser.mjs');
      const { status, html } = await fetchPage(t.url, { timeout: 45000 });
      browser = status === 200 ? verdictOf(html, t.want) : { ok: false, why: `HTTP ${status}` };
    } catch (err) {
      browser = { ok: false, why: err.message.split('\n')[0].slice(0, 60) };
    }
  }

  rows.push({ ...t, direct, browser });
}

if (WITH_BROWSER) {
  const { closeBrowser } = await import('./lib/browser.mjs');
  await closeBrowser();
}

// ── Итог ─────────────────────────────────────────────────────────────────────

const mark = (v) => (v === null ? '  —  ' : v.ok ? '  ✅ ' : '  ❌ ');
console.log('\nДоступность источников с этого адреса\n');
console.log('  источник            напрямую  браузер   что именно');
console.log('  ' + '─'.repeat(74));

for (const r of rows) {
  const detail = r.browser?.ok ? r.browser.why : r.direct.ok ? r.direct.why : r.browser?.why || r.direct.why;
  console.log(
    `  ${r.name.padEnd(20)}${mark(r.direct)}    ${mark(r.browser)}   ${detail}`,
  );
}

const open = rows.filter((r) => r.direct.ok || r.browser?.ok);
console.log('\n  ' + '─'.repeat(74));
console.log(`  Открыто: ${open.length} из ${rows.length} — ${open.map((r) => r.name).join(', ') || 'ничего'}`);

if (open.length >= 4) {
  console.log('\n  Адрес подходит: собирать данные отсюда имеет смысл.\n');
} else if (open.length >= 2) {
  console.log('\n  Адрес частично подходит: часть источников закрыта.');
  console.log('  Попробуй с флагом --browser, если ещё не пробовал.\n');
} else {
  console.log('\n  С этого адреса собирать нечего — режут почти всё.\n');
}

if (!WITH_BROWSER) {
  console.log('  Подсказка: `node scripts/check-access.mjs --browser` проверит ещё и');
  console.log('  настоящим Chromium. Киноафиша отбивает обычный запрос, но пускает его.\n');
}
