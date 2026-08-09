/* Принадлежность кинотеатра к сети. Общий код для сбора данных и для карты,
   поэтому без импортов и обращений к файловой системе.

   Поле brand из OpenStreetMap для этого не годится: оно заполнено у 14 точек
   из 161 и вразнобой — «КАРО», «Каро Фильм», «Сеть кинотеатров "Синема Стар"».
   Поэтому сеть опознаётся по названию, а brand идёт как подсказка.

   Сетью считается любой узнаваемый бренд, даже если точка на карте одна:
   «Москино Искра» — это Москино, и фильтр по сети обязан её находить. */

const norm = (s = '') => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();

/**
 * Ключевые слова сети. Границы задаются пробелами, а не \b: в JavaScript
 * граница слова определена через ASCII, и `\bкаро\b` не совпадает ни с чем.
 * Мы уже дважды на этом обжигались — здесь сравнение идёт по строке,
 * дополненной пробелами с обоих концов.
 *
 * Порядок важен: более длинные и специфичные бренды идут первыми, иначе
 * «Синема Стар» и «Синема Парк» неразличимы, а «Киномакс XL» съедается
 * «Киномаксом».
 */
export const CHAINS = [
  { id: 'sinema-star', name: 'Синема Стар', words: ['синема стар', 'cinema star'] },
  { id: 'sinema-park', name: 'Синема Парк', words: ['синема парк', 'cinema park'] },
  { id: 'formula', name: 'Формула Кино', words: ['формула кино', 'формула'] },
  { id: 'karo', name: 'КАРО', words: ['каро', 'karo'] },
  { id: 'kinomax', name: 'Киномакс', words: ['киномакс', 'kinomax'] },
  { id: 'luxor', name: 'Люксор', words: ['люксор', 'luxor'] },
  { id: 'almaz', name: 'Алмаз Синема', words: ['алмаз'] },
  { id: 'mirage', name: 'Мираж Синема', words: ['мираж'] },
  { id: 'moskino', name: 'Москино', words: ['москино', 'moskino'] },
  { id: 'five-stars', name: 'Пять звёзд', words: ['пять звезд'] },
  { id: 'kinostar', name: 'KinoStar', words: ['kinostar'] },
  { id: 'okko', name: 'Кино Окко', words: ['окко', 'okko'] },
  { id: 'prime', name: 'Prime Cinema', words: ['prime cinema', 'прайм синема'] },
  { id: 'silver', name: 'Silver Cinema', words: ['silver cinema'] },
];

const hasWord = (padded, word) => padded.includes(` ${word} `);

/**
 * Сеть площадки: {id, name} либо null для одиночного кинотеатра.
 * brand берётся вторым источником, если по названию не нашли.
 */
export function chainOf(name = '', brand = '') {
  for (const src of [name, brand]) {
    const padded = ` ${norm(src)} `;
    if (!padded.trim()) continue;
    for (const c of CHAINS) {
      if (c.words.some((w) => hasWord(padded, w))) return { id: c.id, name: c.name };
    }
  }
  return null;
}

/** Сети со счётчиком точек, по убыванию. Одиночные площадки идут отдельно. */
export function chainIndex(cinemas) {
  const byId = new Map();
  let loners = 0;

  for (const c of cinemas) {
    const hit = chainOf(c.name, c.brand);
    if (!hit) {
      loners++;
      continue;
    }
    if (!byId.has(hit.id)) byId.set(hit.id, { ...hit, count: 0 });
    byId.get(hit.id).count++;
  }

  return {
    chains: [...byId.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    loners,
  };
}
