// Загрузка страниц настоящим Chromium.
//
// kinoafisha отвечает 403 на обычные HTTP-запросы: фильтр смотрит не только
// на адрес, но и на то, как клиент здоровается (TLS, заголовки, порядок
// полей). Полноценный браузер проходит там, где не проходит fetch, и заодно
// отдаёт разметку уже после выполнения скриптов.
//
// Playwright лежит в devDependencies: боевые скрипты работают и без него,
// просто откатываются на прокси.

import { UA } from './util.mjs';

let browser = null;
let chromium = null;

async function ensure() {
  if (browser) return browser;
  ({ chromium } = await import('playwright'));
  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  return browser;
}

/** Доступен ли браузер вообще — чтобы решать, идти через него или через прокси. */
export async function browserAvailable() {
  try {
    await ensure();
    return true;
  } catch (err) {
    console.warn(`[browser] недоступен: ${err.message}`);
    return false;
  }
}

/**
 * Открывает страницу и возвращает разметку после рендера.
 * Картинки и шрифты режем — они ничего не дают, но тормозят загрузку.
 */
export async function fetchPage(url, { timeout = 60000, waitFor = null } = {}) {
  const b = await ensure();
  const ctx = await b.newContext({
    userAgent: UA,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
  });

  await ctx.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(type)) return route.abort();
    return route.continue();
  });

  const page = await ctx.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const status = res?.status() ?? 0;

    if (waitFor) {
      // Расписание часто дорисовывается скриптом уже после загрузки.
      //
      // `state: 'attached'` здесь принципиально. По умолчанию Playwright ждёт
      // ещё и видимости, а сеансы на будущие даты лежат в свёрнутых блоках:
      // в DOM элемент есть и разбирается прекрасно, но видимым не станет.
      // В прогоне 09.08 каждая страница второго дня стоила из-за этого ровно
      // 15 секунд таймаута — при том что данные с неё снимались полностью.
      await page.waitForSelector(waitFor, { state: 'attached', timeout: 8000 }).catch(() => {});
    }

    const html = await page.content();
    return { status, html };
  } finally {
    await ctx.close();
  }
}

export async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
