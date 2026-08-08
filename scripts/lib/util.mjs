// Общие утилиты для парсеров.

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch с повторами и экспоненциальной паузой. */
export async function get(url, { retries = 3, timeout = 45000, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1000 * 2 ** attempt);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'ru-RU,ru;q=0.9',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          ...headers,
        },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`GET ${url} failed: ${lastErr?.message}`);
}

export const getText = (url, opts) => get(url, opts).then((r) => r.text());
export const getJson = (url, opts) => get(url, opts).then((r) => r.json());

/**
 * Приводит название кинотеатра к сравнимому виду: убирает кавычки, тип
 * («кинотеатр», «к/т»), сеть-префикс и адресный хвост в скобках.
 */
const TYPE_WORDS = new Set([
  'кинотеатр', 'кинотеатры', 'кино', 'киноцентр', 'киноклуб',
  'мультиплекс', 'cinema', 'cinemas', 'kino',
]);

export function normName(s = '') {
  // Порядок важен: `\b` в JS работает только по ASCII, поэтому убирать слова
  // регуляркой по границам нельзя — сначала режем на токены, потом фильтруем.
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\(.*?\)/g, ' ')
    .replace(/к\s*\/\s*т/g, ' ')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !TYPE_WORDS.has(w))
    .join(' ');
}

/** Ключевые слова названия без сетевого префикса — для нечёткого сопоставления. */
export function nameTokens(s = '') {
  const stop = new Set(['тц', 'трц', 'трк', 'мега', 'на', 'в', 'и', 'the']);
  return new Set(normName(s).split(' ').filter((t) => t.length > 2 && !stop.has(t)));
}

/** Расстояние между точками в метрах. */
export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Достаёт все JSON-LD блоки со страницы. */
export function jsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      /* битый блок — пропускаем */
    }
  }
  return out;
}

/** Достаёт состояние SPA: __NEXT_DATA__, __NUXT__, window.__INITIAL_STATE__. */
export function embeddedState(html) {
  const patterns = [
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    /window\.__INITIAL_STATE__\s*=\s*({[\s\S]*?});?\s*<\/script>/i,
    /window\.__NUXT__\s*=\s*({[\s\S]*?});?\s*<\/script>/i,
    /window\.__DATA__\s*=\s*({[\s\S]*?});?\s*<\/script>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try {
      return JSON.parse(m[1]);
    } catch {
      /* не JSON — пробуем следующий */
    }
  }
  return null;
}

export const stripTags = (html = '') =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** Рекурсивно ищет в объекте узлы, для которых предикат вернул true. */
export function deepFind(node, predicate, acc = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return acc;
  seen.add(node);
  if (predicate(node)) acc.push(node);
  for (const v of Array.isArray(node) ? node : Object.values(node)) {
    if (v && typeof v === 'object') deepFind(v, predicate, acc, seen);
  }
  return acc;
}

/** Дата в YYYY-MM-DD по московскому времени. */
export function mskDate(offsetDays = 0) {
  const now = new Date(Date.now() + offsetDays * 86400000 + 3 * 3600000);
  return now.toISOString().slice(0, 10);
}

/** Минуты от полуночи; сеансы после полуночи считаются как 24:xx+. */
export function timeToMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  let h = +m[1];
  const min = +m[2];
  if (h < 6) h += 24; // ночной сеанс относится к предыдущему дню
  return h * 60 + min;
}
