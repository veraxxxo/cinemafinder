// Сопоставление названий кинотеатров между источниками.
//
// Сложность в том, что половина названия — это сеть («КАРО 6 Будапешт»,
// «Москино Салют»), и по ней совпадает что угодно с чем угодно. Поэтому
// слова сети отделяются от различающей части, и совпадение засчитывается
// только когда сошлась именно различающая часть.

const CHAIN_WORDS = new Set([
  'каро', 'karo', 'киномакс', 'kinomax', 'формула', 'москино', 'moskino',
  'синема', 'cinema', 'парк', 'park', 'стар', 'star', 'люксор', 'luxor',
  'пять', 'звезд', 'алмаз', 'релакс', 'мираж', 'космик',
  'кино', 'кинотеатр', 'киноцентр', 'кинозал', 'мультиплекс',
  'на', 'в', 'и', 'the', 'тц', 'трц', 'трк', 'молл', 'mall',
]);

/** Форматы зала — они не различают площадки. */
const FORMAT_WORDS = new Set(['imax', '4dx', '3d', 'vip', 'sky', 'vegas', 'xl']);

export function normalize(s = '') {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

/**
 * Слова, по которым площадку можно отличить от соседней в той же сети.
 * Числа сохраняем: «КАРО 11 Октябрь» и «35 мм» без них не опознать.
 */
export function distinctive(name) {
  return new Set(
    normalize(name)
      .split(' ')
      .filter((w) => w.length >= 2 && !CHAIN_WORDS.has(w) && !FORMAT_WORDS.has(w)),
  );
}

/** Слова сети — по ним проверяем, что не смешали разные сети. */
export function chainOf(name) {
  return new Set(normalize(name).split(' ').filter((w) => CHAIN_WORDS.has(w)));
}

/**
 * Ищет лучшее соответствие имени среди списка.
 * Возвращает {item, score} или null. score — доля совпавших различающих слов.
 */
export function bestMatch(name, items, getName = (x) => x.name, minScore = 0.5) {
  const want = distinctive(name);
  if (!want.size) return null;
  const wantChain = chainOf(name);

  let best = null;
  let bestScore = 0;

  for (const item of items) {
    const have = distinctive(getName(item));
    if (!have.size) continue;

    let shared = 0;
    for (const w of want) if (have.has(w)) shared++;
    if (!shared) continue;

    // Доля от меньшего набора: «Октябрь» должен находить «КАРО 11 Октябрь».
    const score = shared / Math.min(want.size, have.size);
    if (score < minScore) continue;

    // Разные сети с общим словом («Синема Стар Принц» и «Синема Парк Принц»)
    // — не одно и то же. Если сети известны у обоих и не пересекаются, мимо.
    const haveChain = chainOf(getName(item));
    if (wantChain.size && haveChain.size) {
      let common = 0;
      for (const w of wantChain) if (haveChain.has(w)) common++;
      if (!common) continue;
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best ? { item: best, score: bestScore } : null;
}
