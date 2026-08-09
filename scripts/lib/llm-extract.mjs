// Запасной разбор страницы через LLM.
//
// Регулярки привязаны к вёрстке: сайт её переделает — и сбор молча вернёт
// ноль. Тогда за дело берётся модель: ей отдают кусок разметки и просят
// вернуть сеансы структурой. Это дороже и медленнее, поэтому включается
// только там, где обычный разбор ничего не нашёл на явно загруженной
// странице.
//
// Без ключа GROQ_API_KEY модуль молча выключен — сбор работает как раньше.

const API = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Страница афиши весит под мегабайт, а у бесплатного тарифа лимит токенов
// в минуту. Поэтому в модель уходит только вырезанный кусок с сеансами.
const MAX_CHARS = Number(process.env.LLM_MAX_CHARS || 24000);

export const enabled = () => Boolean(process.env.GROQ_API_KEY);

/** Оставляет от страницы только то, что похоже на расписание. */
export function trimForModel(html) {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ');

  // Берём окрестности первого времени: там же лежат названия залов.
  const first = /[0-2]?\d:[0-5]\d/.exec(text);
  if (!first) return text.slice(0, MAX_CHARS);
  const from = Math.max(0, first.index - 4000);
  return text.slice(from, from + MAX_CHARS);
}

/**
 * Просит модель вытащить сеансы. Возвращает массив
 * {cinemaName, movieTitle, time, price} или пустой массив.
 */
export async function extractShows(html, { date, hint = '' } = {}) {
  if (!enabled()) return [];

  const body = {
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Ты разбираешь HTML афиши кинотеатров. Возвращай строго JSON вида ' +
          '{"shows":[{"cinemaName":"","movieTitle":"","time":"ЧЧ:ММ","price":null}]}. ' +
          'Ничего не выдумывай: если в разметке сеансов нет, верни пустой список.',
      },
      {
        role: 'user',
        content: `Дата: ${date}. ${hint}\n\nРазметка:\n${trimForModel(html)}`,
      },
    ],
  };

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      console.warn(`[llm] HTTP ${res.status} — ${(await res.text()).slice(0, 200)}`);
      return [];
    }

    const data = await res.json();
    const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    const shows = Array.isArray(parsed.shows) ? parsed.shows : [];

    // Модель может ошибиться в формате — пропускаем только валидное.
    const clean = shows.filter(
      (s) => s?.cinemaName && s?.movieTitle && /^\d{1,2}:\d{2}$/.test(String(s.time || '')),
    );
    console.log(`[llm] вернула ${shows.length} записей, годных ${clean.length}`);
    return clean.map((s) => ({
      date,
      time: s.time,
      cinemaName: String(s.cinemaName).trim(),
      movieTitle: String(s.movieTitle).trim(),
      price: Number(s.price) || null,
    }));
  } catch (err) {
    console.warn(`[llm] ${err.message}`);
    return [];
  }
}
