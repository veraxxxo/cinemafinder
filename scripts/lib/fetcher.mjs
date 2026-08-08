// Загрузка страниц с несколькими путями отхода.
//
// Сайты афиш по-разному отбивают роботов: kinoafisha отдаёт 403 на обычные
// запросы, kinomax показывает страницу-заглушку «Верификация». Один способ
// загрузки поэтому ненадёжен, и вместо него — цепочка:
//
//   1. настоящий Chromium — проходит проверки, которые смотрят на TLS,
//      заголовки и исполнение скриптов;
//   2. прямой запрос — работает с обычного адреса (локальный запуск);
//   3. открытые прокси по очереди — медленно, но переживает блокировку по IP.
//
// Удачно загруженные страницы кладутся в кэш: если прогон оборвётся на
// середине, следующий не начнёт с нуля.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getText, stripTags } from './util.mjs';
import { browserAvailable, fetchPage, closeBrowser } from './browser.mjs';

const PROXIES = [
  (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  (u) => `https://r.jina.ai/${u}`,
];

const CACHE_DIR = new URL('../../data/cache/', import.meta.url);
const CACHE_TTL = Number(process.env.CACHE_TTL_MIN || 180) * 60000;

const key = (url) => createHash('sha1').update(url).digest('hex').slice(0, 16);

async function fromCache(url) {
  if (process.env.NO_CACHE) return null;
  try {
    const raw = await readFile(new URL(`${key(url)}.json`, CACHE_DIR), 'utf8');
    const { at, html } = JSON.parse(raw);
    if (Date.now() - at < CACHE_TTL) return html;
  } catch {
    /* в кэше нет */
  }
  return null;
}

async function toCache(url, html) {
  if (process.env.NO_CACHE) return;
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(new URL(`${key(url)}.json`, CACHE_DIR), JSON.stringify({ at: Date.now(), url, html }));
  } catch (err) {
    console.warn(`[fetch] кэш не записался: ${err.message}`);
  }
}

/** Признаки того, что вместо страницы пришла заглушка антибота. */
export function looksBlocked(html, { expect } = {}) {
  if (!html || html.length < 2048) return 'слишком короткий ответ';
  const title = stripTags((/<title>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  if (/верификац|проверка браузера|один момент|just a moment|attention required/i.test(title)) {
    return `заглушка «${title}»`;
  }
  if (expect && !expect.test(html)) return 'нет ожидаемой разметки';
  return null;
}

let browserOk = null;
let proxyOrder = [...PROXIES.keys()];

/**
 * Забирает страницу, перебирая способы, пока не получится живая разметка.
 * `expect` — регулярка, по которой отличаем настоящую страницу от заглушки.
 */
export async function loadPage(url, { expect = null, waitFor = null, label = '' } = {}) {
  const cached = await fromCache(url);
  if (cached) {
    console.log(`[fetch] ${label || url}: из кэша`);
    return cached;
  }

  const attempts = [];

  if (browserOk !== false) {
    attempts.push(['Chromium', async () => {
      if (browserOk === null) browserOk = await browserAvailable();
      if (!browserOk) throw new Error('браузер недоступен');
      const { status, html } = await fetchPage(url, { waitFor });
      if (status !== 200) throw new Error(`HTTP ${status}`);
      return html;
    }]);
  }

  attempts.push(['напрямую', () => getText(url, { retries: 0, timeout: 30000 })]);

  // Прокси перебираем по кругу, начиная с того, что сработал в прошлый раз.
  for (const i of proxyOrder) {
    attempts.push([`прокси #${i + 1}`, () => getText(PROXIES[i](url), { retries: 1, timeout: 90000 })]);
  }

  for (const [how, run] of attempts) {
    try {
      const html = await run();
      const bad = looksBlocked(html, { expect });
      if (bad) {
        console.warn(`[fetch] ${label || url}: ${how} — ${bad}`);
        continue;
      }
      console.log(`[fetch] ${label || url}: ${how} — ${(html.length / 1024).toFixed(0)} КБ`);
      const idx = attempts.findIndex(([h]) => h === how);
      if (how.startsWith('прокси')) {
        // Удачный прокси — вперёд очереди для следующих страниц.
        const n = Number(how.split('#')[1]) - 1;
        proxyOrder = [n, ...proxyOrder.filter((x) => x !== n)];
      }
      void idx;
      await toCache(url, html);
      return html;
    } catch (err) {
      console.warn(`[fetch] ${label || url}: ${how} — ${err.message}`);
    }
  }

  throw new Error(`не удалось загрузить ${url} ни одним способом`);
}

export const finish = closeBrowser;
