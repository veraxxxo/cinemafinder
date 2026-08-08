#!/usr/bin/env node
// Диагностика источников: что реально отдают страницы афиш.
// Запускается вручную (workflow «Probe sources») — по его логам чинятся парсеры.

import { get, jsonLd, embeddedState, stripTags, mskDate } from './lib/util.mjs';

const date = mskDate(0);

const K = 'https://kudago.com/public-api/v1.4';
const from = Math.floor(Date.parse(`${date}T00:00:00+03:00`) / 1000);
const to = from + 5 * 86400;

const CANDIDATES = (process.env.PROBE_URLS || '').trim()
  ? process.env.PROBE_URLS.trim().split(/\s+/)
  : [
      // KudaGo: единственный источник, который пустил нас с IP дата-центра.
      `${K}/movie-showings/?location=msk&page_size=3&actual_since=${from}&actual_until=${to}`,
      `${K}/movieshowings/?location=msk&page_size=3`,
      `${K}/movies/?location=msk&page_size=3&fields=id,title,running_time,genres`,
      `${K}/places/?location=msk&categories=cinema&page_size=3&fields=id,title,address,coords,subway`,
      `${K}/places/?location=msk&categories=cinema&page_size=1&fields=id,title`,
      // Живые, но пока не разобранные.
      `https://cinema5.ru/moskva`,
      `https://www.kinoafisha.info/russia/msk/schedule/`,
    ];

for (const url of CANDIDATES) {
  console.log('\n' + '═'.repeat(78));
  console.log('→', url);
  try {
    const res = await get(url, { retries: 1, timeout: 40000 });
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    console.log(`   HTTP ${res.status} | ${ct} | ${(body.length / 1024).toFixed(1)} KB`);

    if (ct.includes('json')) {
      console.log('   JSON:', JSON.stringify(JSON.parse(body)).slice(0, 900));
      continue;
    }

    console.log('   <title>:', stripTags((/<title>([\s\S]*?)<\/title>/i.exec(body) || [])[1] || '—'));

    const state = embeddedState(body);
    console.log('   SPA-состояние:', state ? `есть, ключи: ${Object.keys(state).join(', ')}` : 'нет');

    const ld = jsonLd(body);
    console.log('   JSON-LD блоков:', ld.length, ld.map((n) => n['@type']).filter(Boolean).join(', '));

    const counts = {
      'ссылок /cinema/': (body.match(/href="[^"]*\/cinema\//g) || []).length,
      'ссылок /movie(s)/': (body.match(/href="[^"]*\/movies?\//g) || []).length,
      'похоже на время HH:MM': (body.match(/>\s*[0-2]?\d:[0-5]\d\s*</g) || []).length,
      'ScreeningEvent': (body.match(/ScreeningEvent/g) || []).length,
    };
    console.log('   ' + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' | '));

    // Пара примеров классов вокруг времени — подсказка для селекторов.
    const sample = [...body.matchAll(/(<[a-z]+[^>]{0,160}>)\s*([0-2]?\d:[0-5]\d)\s*</g)].slice(0, 4);
    for (const s of sample) console.log('   пример:', s[1].slice(0, 150), '→', s[2]);
  } catch (err) {
    console.log('   ОШИБКА:', err.message);
  }
}
