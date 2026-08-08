#!/usr/bin/env node
// Дамп структуры страницы: показывает разметку вокруг найденных сеансов,
// чтобы писать парсер по фактам, а не по догадкам.
//
//   PROBE_PAGE=<url> node scripts/probe-html.mjs
//
// Страница берётся через открытый прокси: kinoafisha отдаёт 403 на прямые
// запросы с адресов дата-центров, но через прокси отвечает нормально.

import { getText, stripTags } from './lib/util.mjs';

const PROXY = 'https://api.allorigins.win/raw?url=';
const target = process.env.PROBE_PAGE || 'https://www.kinoafisha.info/russia/msk/schedule/';

console.log('→', target);
const html = await getText(PROXY + encodeURIComponent(target), { retries: 2, timeout: 90000 });
console.log(`   ${(html.length / 1024).toFixed(1)} КБ | <title>: ${stripTags((/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '—')}`);

const count = (re) => (html.match(re) || []).length;
console.log(`   ссылок /cinema/: ${count(/href="[^"]*\/cinema\/[^"]*"/g)}`);
console.log(`   ссылок /movies/: ${count(/href="[^"]*\/movies?\/[^"]*"/g)}`);
console.log(`   session_time: ${count(/session_time/g)}`);
console.log(`   data-атрибутов с id: ${count(/data-(?:cinema|movie|session)[-_]?id="/gi)}`);

// Какие классы обрамляют сеансы — по ним и строится парсер.
const classes = {};
for (const m of html.matchAll(/class="([^"]{0,120})"[^>]{0,200}>\s*[0-2]?\d:[0-5]\d\s*</g)) {
  classes[m[1]] = (classes[m[1]] || 0) + 1;
}
console.log('\nклассы у элементов с временем:');
for (const [c, n] of Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`   ${String(n).padStart(4)}  ${c}`);
}

// Кусок вокруг первой ссылки на кинотеатр: видно, как связаны название,
// адрес и блок сеансов.
const first = /href="([^"]*\/cinema\/[^"]*)"/.exec(html);
if (first) {
  const i = html.indexOf(first[0]);
  console.log('\n─── разметка вокруг первого кинотеатра ' + '─'.repeat(30));
  console.log(html.slice(Math.max(0, i - 900), i + 2600).replace(/\n\s*/g, ' ').replace(/> </g, '>\n<'));
}

// И вокруг первого времени — там же обычно лежит ссылка на покупку и зал.
const t = /session_time/.exec(html) || /[^>]>\s*[0-2]?\d:[0-5]\d\s*</.exec(html);
if (t) {
  const i = html.indexOf(t[0]);
  console.log('\n─── разметка вокруг первого сеанса ' + '─'.repeat(34));
  console.log(html.slice(Math.max(0, i - 1200), i + 1200).replace(/\n\s*/g, ' ').replace(/> </g, '>\n<'));
}
