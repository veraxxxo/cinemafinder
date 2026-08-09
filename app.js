/* CinemaFinder — карта кинотеатров Москвы с фильтрами по фильму и времени. */
'use strict';

import { fetchDay } from './live.js';
import { bestMatch } from './match.js';

const MOSCOW = [55.7522, 37.6156];
const $ = (id) => document.getElementById(id);

// Подложки карты. Плитки Яндекса подключать нельзя — это против их условий,
// а JS API требует ключа с привязкой к домену.
//
// Язык подписей задаётся самой подложкой, не нами: стандартные тайлы
// OpenStreetMap подписывают объекты на местном языке (в Москве — по-русски),
// а Carto почти везде латиницей. Поэтому по умолчанию — OSM.
const OSM = '&copy; OpenStreetMap';
const CARTO = `${OSM}, &copy; CARTO`;
const BASEMAPS = {
  'Русские названия': { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', by: OSM },
  'Светлая (латиницей)': { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', by: CARTO },
  'Бледная (латиницей)': { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', by: CARTO },
  'Спутник': {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    by: '&copy; Esri',
  },
  'Тёмная (латиницей)': { url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', by: CARTO },
};
const DEFAULT_BASEMAP = 'Русские названия';

// Сеансы после полуночи относятся к предыдущему вечеру: 00:40 → 24:40.
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h < 6 ? h + 24 : h) * 60 + m;
};
// Значения за 24:00 — это ночь следующих суток; помечаем плюсом, чтобы
// «05:45» не читалось как утро того же дня.
const fromMin = (v) => {
  const hhmm = `${String(Math.floor(v / 60) % 24).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  return v >= 1440 ? `${hhmm}⁺` : hhmm;
};

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').trim();

/** Сегодняшняя дата по Москве — карта про московские кинотеатры. */
const mskToday = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000 + 3 * 3600000).toISOString().slice(0, 10);

const state = {
  cinemas: [],
  cinemaById: new Map(),
  movies: [],
  movieById: new Map(),
  shows: [],
  dates: [],
  date: null,
  pickedMovies: new Set(),
  from: 360,
  to: 1799,
  cinemaQuery: '',
  onlyWithShows: false,
  me: null,
};

let map, cluster;
const markers = new Map();

// ── Данные ───────────────────────────────────────────────────────────────────

async function loadJson(path) {
  const res = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/** Запасной путь: если снимка нет, тянем кинотеатры прямо из OpenStreetMap. */
async function cinemasFromOverpass() {
  const query = `[out:json][timeout:90];rel(102269);map_to_area->.a;
    (node(area.a)["amenity"="cinema"];way(area.a)["amenity"="cinema"];);out center tags;`;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
  });
  const json = await res.json();
  return json.elements
    .map((e) => {
      const lat = e.lat ?? e.center?.lat;
      const lon = e.lon ?? e.center?.lon;
      const name = e.tags?.['name:ru'] || e.tags?.name;
      if (lat == null || !name) return null;
      return {
        id: `${e.type[0]}${e.id}`, name, lat, lon,
        address: [e.tags['addr:street'], e.tags['addr:housenumber']].filter(Boolean).join(', '),
        website: e.tags.website || '', brand: e.tags.brand || '',
      };
    })
    .filter(Boolean);
}

async function load() {
  let schedule = null;
  try {
    schedule = await loadJson('data/schedule.json');
  } catch {
    /* расписания ещё нет — покажем только карту кинотеатров */
  }

  let cinemas;
  try {
    cinemas = (await loadJson('data/cinemas.json')).items;
  } catch {
    $('updated').textContent = 'тяну кинотеатры из OpenStreetMap…';
    cinemas = await cinemasFromOverpass();
  }

  // Площадки, которых нет в OpenStreetMap, но которые пришли с координатами
  // от источника расписания.
  if (schedule?.extraCinemas?.length) {
    const known = new Set(cinemas.map((c) => c.id));
    cinemas = cinemas.concat(schedule.extraCinemas.filter((c) => !known.has(c.id)));
  }

  state.cinemas = cinemas;
  state.cinemaById = new Map(cinemas.map((c) => [c.id, c]));

  if (schedule) {
    state.movies = schedule.movies || [];
    state.movieById = new Map(state.movies.map((m) => [m.id, m]));
    state.shows = (schedule.shows || []).map((s) => ({ ...s, min: toMin(s.t) }));
    state.dates = schedule.dates || [];
    // Открываемся на сегодня, если такие данные есть; иначе на ближайшей
    // будущей дате, а если всё в прошлом — на последней собранной.
    const today = mskToday();
    state.date =
      state.dates.find((d) => d === today) ||
      state.dates.find((d) => d > today) ||
      state.dates.at(-1) ||
      null;
    $('src-list').textContent = (schedule.sources || []).map((s) => s.title).join(', ') || '—';

    const when = new Date(schedule.updated);
    const stale = !state.dates.includes(mskToday());
    $('updated').innerHTML =
      `${cinemas.length} кинотеатров · ${schedule.stats?.shows ?? 0} сеансов · ` +
      `обновлено ${when.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` +
      (stale ? ' · <b class="stale">данные за прошлый день</b>' : '');
  } else {
    state.onlyWithShows = false;
    $('only-with-shows').checked = false;
    $('updated').textContent = `${cinemas.length} кинотеатров · расписание ещё не собрано`;
  }
}

// ── Фильтрация ───────────────────────────────────────────────────────────────

function showsForDate() {
  if (!state.date) return [];
  return state.shows.filter((s) => s.d === state.date);
}

/** Возвращает Map<cinemaId, сеансы[]> после применения всех фильтров. */
function filtered() {
  const byCinema = new Map();
  const q = norm(state.cinemaQuery);

  for (const s of showsForDate()) {
    if (s.min < state.from || s.min > state.to) continue;
    if (state.pickedMovies.size && !state.pickedMovies.has(s.m)) continue;
    if (!byCinema.has(s.c)) byCinema.set(s.c, []);
    byCinema.get(s.c).push(s);
  }

  const result = new Map();
  for (const c of state.cinemas) {
    if (q && !norm(`${c.name} ${c.address} ${c.brand}`).includes(q)) continue;
    const shows = byCinema.get(c.id) || [];
    if (state.onlyWithShows && !shows.length) continue;
    shows.sort((a, b) => a.min - b.min);
    result.set(c.id, shows);
  }
  return result;
}

const dist = (a, b) => {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

// ── Отрисовка ────────────────────────────────────────────────────────────────

function popupHtml(cinema, shows) {
  const byMovie = new Map();
  for (const s of shows) {
    if (!byMovie.has(s.m)) byMovie.set(s.m, []);
    byMovie.get(s.m).push(s);
  }

  const films = [...byMovie.entries()]
    .map(([mid, list]) => {
      const title = state.movieById.get(mid)?.title || mid;
      const times = list
        .map((s) => {
          const label = `${s.t}${s.hall ? ` · ${s.hall}` : ''}${s.price ? ` · ${s.price}₽` : ''}`;
          return s.url
            ? `<a href="${s.url}" target="_blank" rel="noopener">${label}</a>`
            : `<b>${label}</b>`;
        })
        .join('');
      return `<div class="film"><div>${title}</div><div class="times">${times}</div></div>`;
    })
    .join('');

  const route = `<a href="https://yandex.ru/maps/?rtext=~${cinema.lat},${cinema.lon}&rtt=mt" target="_blank" rel="noopener">маршрут</a>`;
  const site = cinema.website
    ? ` · <a href="${cinema.website}" target="_blank" rel="noopener">сайт</a>`
    : '';

  // Полного открытого источника сеансов по Москве нет, поэтому даём прямой
  // переход в афишу по названию — там расписание всегда полное.
  const q = encodeURIComponent(cinema.name);
  const afisha =
    `<div class="addr">Полное расписание: ` +
    `<a href="https://afisha.yandex.ru/moscow/search?text=${q}" target="_blank" rel="noopener">Яндекс&nbsp;Афиша</a> · ` +
    `<a href="https://www.kinoafisha.info/search/?text=${q}" target="_blank" rel="noopener">Кино&nbsp;Афиша</a></div>`;

  // Часть площадок геокодер нашёл только как район, а не как здание: булавка
  // стоит в центре района. Обещать в этом случае точный адрес нельзя.
  const approx = cinema.approx
    ? '<div class="addr">Точка примерная: адрес зала не найден, показан центр района.</div>'
    : '';

  return (
    `<h3>${cinema.name}</h3>` +
    `<div class="addr">${cinema.address || 'адрес не указан'} · ${route}${site}</div>` +
    approx +
    (films || '<div class="addr">Сеансов по текущему фильтру нет.</div>') +
    afisha
  );
}

function pinIcon(count) {
  // Зелёный кружок с числом — здесь идёт то, что выбрано фильтром.
  const size = count ? 30 : 20;
  return L.divIcon({
    html: `<div class="pin${count ? ' has' : ' dim'}">${count || ''}</div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function render() {
  const result = filtered();

  // карта (может отсутствовать, если Leaflet не загрузился — см. main)
  if (cluster) {
    cluster.clearLayers();
    markers.clear();
    const layers = [];
    for (const [cid, shows] of result) {
      const c = state.cinemaById.get(cid);
      const marker = L.marker([c.lat, c.lon], {
        icon: pinIcon(shows.length),
        showCount: shows.length,
      }).bindPopup(() => popupHtml(c, shows), { maxWidth: 320 });
      markers.set(cid, marker);
      layers.push(marker);
    }
    cluster.addLayers(layers);
  }

  // список: рядом со мной — по расстоянию, иначе — где больше сеансов
  const list = [...result.entries()];
  list.sort(([aId, aShows], [bId, bShows]) => {
    const a = state.cinemaById.get(aId);
    const b = state.cinemaById.get(bId);
    if (state.me) return dist(state.me, a) - dist(state.me, b);
    return bShows.length - aShows.length || a.name.localeCompare(b.name, 'ru');
  });

  const ul = $('results');
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = '<li class="empty">Ничего не нашлось.<br>Смягчи фильтры или выбери другую дату.</li>';
  }

  for (const [cid, shows] of list.slice(0, 300)) {
    const c = state.cinemaById.get(cid);
    const li = document.createElement('li');
    const far = state.me ? ` · ${dist(state.me, c).toFixed(1)} км` : '';
    const titles = [...new Set(shows.map((s) => state.movieById.get(s.m)?.title || s.m))];
    const where = [c.address, c.brand].filter(Boolean).join(' · ') || 'Москва';

    li.innerHTML =
      `<div class="name">${c.name}</div>` +
      `<div class="meta">${where}${far}` +
      (shows.length
        ? ` · <b>${shows.length}</b> сеансов · ${titles.length} фильм(ов)`
        : ' · сеансов нет в данных') +
      `</div>` +
      (shows.length
        ? `<div class="times">${shows.slice(0, 14).map((s) => `<b>${s.t}</b>`).join('')}` +
          (shows.length > 14 ? `<b>+${shows.length - 14}</b>` : '') + `</div>`
        : '');

    li.onclick = () => {
      if (!map) return;
      map.setView([c.lat, c.lon], 15);
      const m = markers.get(cid);
      if (m) cluster.zoomToShowLayer(m, () => m.openPopup());
      if (window.innerWidth <= 820) $('panel').classList.remove('open');
    };
    ul.appendChild(li);
  }

  const totalShows = [...result.values()].reduce((n, s) => n + s.length, 0);
  const films = new Set([...result.values()].flat().map((s) => s.m)).size;
  const withShows = [...result.values()].filter((s) => s.length).length;
  $('summary').innerHTML =
    `<b>${result.size}</b> кинотеатров` +
    (totalShows
      ? ` · <b>${withShows}</b> с сеансами · <b>${totalShows}</b> сеансов · <b>${films}</b> фильмов`
      : ' · расписание для них ещё не собрано');
}

// ── Управление ───────────────────────────────────────────────────────────────

function buildDateChips() {
  const box = $('dates');
  box.innerHTML = '';
  if (!state.dates.length) { box.innerHTML = '<span class="meta">расписание не загружено</span>'; return; }

  const today = mskToday();
  const tomorrow = mskToday(1);

  for (const d of state.dates) {
    const dt = new Date(d + 'T12:00:00');
    const b = document.createElement('button');
    // Подпись считается от настоящей даты, а не от позиции в списке: иначе
    // на устаревших данных первая дата называлась «сегодня» и врала.
    const label =
      d === today ? 'сегодня' :
      d === tomorrow ? 'завтра' :
      d < today ? 'прошло' :
      dt.toLocaleDateString('ru-RU', { weekday: 'short' });
    b.innerHTML = `${label}<span>${dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>`;
    b.classList.toggle('past', d < today);
    b.classList.toggle('on', d === state.date);
    b.onclick = () => {
      state.date = d;
      [...box.children].forEach((el) => el.classList.toggle('on', el === b));
      render();
    };
    box.appendChild(b);
  }

  // Данных на сегодня может не быть вовсе — об этом надо сказать прямо.
  if (!state.dates.includes(today)) {
    const note = document.createElement('span');
    note.className = 'stale';
    note.textContent = 'на сегодня данных нет — нажми «Обновить сеансы»';
    box.appendChild(note);
  }
}

function renderTags() {
  const box = $('movie-tags');
  box.innerHTML = '';
  for (const id of state.pickedMovies) {
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.innerHTML = `<span>${state.movieById.get(id)?.title || id}</span><b>×</b>`;
    tag.querySelector('b').onclick = () => { state.pickedMovies.delete(id); renderTags(); render(); };
    box.appendChild(tag);
  }
}

function setupMovieSearch() {
  const input = $('movie-input');
  const list = $('movie-suggest');
  let cursor = -1;

  const options = () => {
    const q = norm(input.value);
    const onDate = new Set(showsForDate().map((s) => s.m));
    return state.movies
      .filter((m) => onDate.has(m.id) && !state.pickedMovies.has(m.id) && (!q || norm(m.title).includes(q)))
      .slice(0, 40);
  };

  const draw = () => {
    const opts = options();
    list.innerHTML = '';
    cursor = -1;

    if (!opts.length) {
      // Молчаливо прятать список нельзя: пользователь видит, что ввод ничего
      // не меняет, и считает это поломкой. Объясняем, почему пусто.
      if (input.value.trim()) {
        const li = document.createElement('li');
        li.className = 'nores';
        li.textContent = `«${input.value.trim()}» нет в собранном расписании`;
        list.appendChild(li);
        list.hidden = false;
      } else {
        list.hidden = true;
      }
      return;
    }

    for (const m of opts) {
      const li = document.createElement('li');
      const n = showsForDate().filter((s) => s.m === m.id).length;
      li.innerHTML = `<span>${m.title}</span><i>${n}</i>`;
      li.onmousedown = (e) => { e.preventDefault(); pick(m.id); };
      list.appendChild(li);
    }
    list.hidden = false;
  };

  const pick = (id) => {
    state.pickedMovies.add(id);
    input.value = '';
    list.hidden = true;
    renderTags();
    render();
  };

  input.addEventListener('focus', draw);
  input.addEventListener('input', draw);
  input.addEventListener('blur', () => setTimeout(() => (list.hidden = true), 120));
  input.addEventListener('keydown', (e) => {
    const items = [...list.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      cursor = Math.max(0, Math.min(items.length - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((el, i) => el.classList.toggle('active', i === cursor));
      items[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[cursor >= 0 ? cursor : 0]?.dispatchEvent(new MouseEvent('mousedown'));
    } else if (e.key === 'Escape') {
      list.hidden = true;
    }
  });
}

function syncTime() {
  const a = $('time-from'), b = $('time-to');
  if (+a.value > +b.value) {
    if (document.activeElement === a) b.value = a.value; else a.value = b.value;
  }
  state.from = +a.value;
  state.to = +b.value;
  $('time-label').textContent = `${fromMin(state.from)} — ${fromMin(state.to)}`;
}

function setupControls() {
  const markPreset = (btn) =>
    [...$('time-presets').children].forEach((b) => b.classList.toggle('on', b === btn));

  for (const el of [$('time-from'), $('time-to')]) {
    el.addEventListener('input', () => { syncTime(); markPreset(null); render(); });
  }

  $('time-presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    let from, to;
    if (b.dataset.preset === 'now') {
      const msk = new Date(Date.now() + (new Date().getTimezoneOffset() + 180) * 60000);
      from = Math.max(360, msk.getHours() * 60 + msk.getMinutes());
      to = 1799;
    } else {
      from = +b.dataset.from;
      to = +b.dataset.to;
    }
    $('time-from').value = from;
    $('time-to').value = to;
    syncTime();
    markPreset(b);
    render();
  });

  let t;
  $('cinema-input').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.cinemaQuery = e.target.value; render(); }, 180);
  });

  $('only-with-shows').addEventListener('change', (e) => {
    state.onlyWithShows = e.target.checked;
    render();
  });

  $('geo').addEventListener('click', () => {
    if (!navigator.geolocation) return alert('Геолокация недоступна');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        if (map) {
          L.circleMarker([state.me.lat, state.me.lon], {
            radius: 7, color: '#3fb950', fillColor: '#3fb950', fillOpacity: .9,
          }).addTo(map).bindPopup('Вы здесь');
          map.setView([state.me.lat, state.me.lon], 13);
        }
        render();
      },
      () => alert('Не удалось определить местоположение'),
    );
  });

  $('reset').addEventListener('click', () => {
    state.pickedMovies.clear();
    state.cinemaQuery = '';
    $('cinema-input').value = '';
    $('time-from').value = 360;
    $('time-to').value = 1785;
    // Дата тоже часть фильтра — возвращаем на сегодня.
    if (state.dates.length) {
      const today = mskToday();
      state.date = state.dates.find((d) => d === today) || state.dates[0];
      const i = state.dates.indexOf(state.date);
      [...$('dates').children].forEach((el, k) => el.classList?.toggle('on', k === i));
    }
    syncTime();
    markPreset($('time-presets').firstElementChild);
    renderTags();
    render();
  });

  $('toggle-panel').addEventListener('click', () => $('panel').classList.toggle('open'));

  $('refresh').addEventListener('click', refreshFromAfisha);
}

// ── Живая подгрузка ──────────────────────────────────────────────────────────

/**
 * Тянет расписание с афиши прямо из браузера и вливает в текущие данные.
 * Сбор в GitHub Actions упирается в блокировку адресов дата-центров, а
 * обычный домашний адрес сайты пропускают — поэтому посетитель может
 * добрать актуальные сеансы сам.
 */
async function refreshFromAfisha() {
  const button = $('refresh');
  const note = $('refresh-note');
  const say = (text, cls = '') => {
    note.textContent = text;
    note.className = cls;
  };

  button.disabled = true;
  const date = state.date || new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);

  try {
    say('загружаю афишу…');
    const raw = await fetchDay(date, (p) => say(p));

    say(`разбираю ${raw.length} сеансов…`);
    const added = mergeShows(raw, date);

    if (!added.shows) {
      say('свежих сеансов не нашлось — данные и так актуальны', 'ok');
    } else {
      say(`добавлено ${added.shows} сеансов в ${added.cinemas} кинотеатрах` +
          (added.skipped ? `, ${added.skipped} залов не удалось сопоставить` : ''), 'ok');
    }

    buildDateChips();
    renderTags();
    render();
  } catch (err) {
    say(`не вышло: ${err.message}`, 'err');
  } finally {
    button.disabled = false;
  }
}

/** Вливает разобранные сеансы в состояние, сопоставляя залы по названию. */
function mergeShows(raw, date) {
  const known = new Set(state.shows.map((s) => `${s.c}|${s.m}|${s.d}|${s.t}`));
  const cinemas = new Set();
  const unmatched = new Set();
  let added = 0;

  for (const r of raw) {
    const hit = bestMatch(r.cinemaName, state.cinemas);
    if (!hit) {
      unmatched.add(r.cinemaName);
      continue;
    }

    const title = r.movieTitle.replace(/\s*\(\d{4}\)\s*$/, '').trim();
    const mid = title.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!mid) continue;

    const key = `${hit.item.id}|${mid}|${date}|${r.time}`;
    if (known.has(key)) continue;
    known.add(key);

    if (!state.movieById.has(mid)) {
      const movie = { id: mid, title, count: 0 };
      state.movieById.set(mid, movie);
      state.movies.push(movie);
    }
    state.movieById.get(mid).count++;

    state.shows.push({
      c: hit.item.id, m: mid, d: date, t: r.time,
      price: r.price || undefined, min: toMin(r.time),
    });
    cinemas.add(hit.item.id);
    added++;
  }

  if (!state.dates.includes(date)) state.dates = [date, ...state.dates].sort();
  state.movies.sort((a, b) => b.count - a.count);

  if (unmatched.size) console.warn('Не сопоставлены с картой:', [...unmatched].join(' | '));
  return { shows: added, cinemas: cinemas.size, skipped: unmatched.size };
}

// ── Старт ────────────────────────────────────────────────────────────────────

(async function main() {
  // Leaflet приходит с CDN. Если его заблокировали или сеть отвалилась,
  // страница не должна умирать: список и фильтры работают и без карты.
  if (typeof L === 'undefined') {
    $('map').innerHTML =
      '<div style="padding:24px;color:#8b97a6;font-size:14px">' +
      'Карту не удалось загрузить: библиотека Leaflet недоступна с CDN.<br>' +
      'Фильтры и список кинотеатров слева работают.</div>';
  } else {
    map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(MOSCOW, 11);

    const layers = {};
    for (const [title, def] of Object.entries(BASEMAPS)) {
      layers[title] = L.tileLayer(def.url, { maxZoom: 19, attribution: def.by });
    }
    // Ключ с номером: прежний выбор указывал на подложку с латиницей, и без
    // смены ключа старые посетители остались бы на ней.
    const saved = localStorage.getItem('cf-basemap-2');
    (layers[saved] || layers[DEFAULT_BASEMAP]).addTo(map);
    L.control.layers(layers, null, { position: 'topright' }).addTo(map);
    map.on('baselayerchange', (e) => localStorage.setItem('cf-basemap-2', e.name));

    cluster = L.markerClusterGroup({
      maxClusterRadius: 45,
      showCoverageOnHover: false,
      // Скопление зелёное, только если внутри есть хоть один подходящий сеанс.
      iconCreateFunction: (c) => {
        const markers = c.getAllChildMarkers();
        const shows = markers.reduce((n, m) => n + (m.options.showCount || 0), 0);
        return L.divIcon({
          html: `<div>${shows || markers.length}</div>`,
          className: `marker-cluster${shows ? '' : ' empty'}`,
          iconSize: [40, 40],
        });
      },
    }).addTo(map);
  }

  syncTime();
  setupControls();

  try {
    await load();
  } catch (err) {
    $('updated').textContent = `Ошибка загрузки: ${err.message}`;
    return;
  }

  buildDateChips();
  setupMovieSearch();
  renderTags();
  render();
})();
