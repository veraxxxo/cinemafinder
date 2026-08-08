/* CinemaFinder — карта кинотеатров Москвы с фильтрами по фильму и времени. */
'use strict';

const MOSCOW = [55.7522, 37.6156];
const $ = (id) => document.getElementById(id);

// Сеансы после полуночи относятся к предыдущему вечеру: 00:40 → 24:40.
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h < 6 ? h + 24 : h) * 60 + m;
};
const fromMin = (v) => `${String(Math.floor(v / 60) % 24).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;

const norm = (s) => s.toLowerCase().replace(/ё/g, 'е').trim();

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
  onlyWithShows: true,
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

  state.cinemas = cinemas;
  state.cinemaById = new Map(cinemas.map((c) => [c.id, c]));

  if (schedule) {
    state.movies = schedule.movies || [];
    state.movieById = new Map(state.movies.map((m) => [m.id, m]));
    state.shows = (schedule.shows || []).map((s) => ({ ...s, min: toMin(s.t) }));
    state.dates = schedule.dates || [];
    state.date = state.dates[0] || null;
    $('src-list').textContent = (schedule.sources || []).map((s) => s.title).join(', ') || '—';

    const when = new Date(schedule.updated);
    $('updated').textContent =
      `${cinemas.length} кинотеатров · ${schedule.stats?.shows ?? 0} сеансов · ` +
      `обновлено ${when.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
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

  const site = cinema.website
    ? `<div class="addr"><a href="${cinema.website}" target="_blank" rel="noopener">сайт кинотеатра</a></div>`
    : '';
  const route = `<a href="https://yandex.ru/maps/?rtext=~${cinema.lat},${cinema.lon}&rtt=mt" target="_blank" rel="noopener">маршрут</a>`;

  return (
    `<h3>${cinema.name}</h3>` +
    `<div class="addr">${cinema.address || 'адрес не указан'} · ${route}</div>` +
    site +
    (films || '<div class="addr">Сеансов по текущему фильтру нет.</div>')
  );
}

function pinIcon(count) {
  return L.divIcon({
    html: `<div class="pin${count ? '' : ' dim'}">${count || '·'}</div>`,
    className: '', iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

function render() {
  const result = filtered();

  // карта
  cluster.clearLayers();
  markers.clear();
  const layers = [];
  for (const [cid, shows] of result) {
    const c = state.cinemaById.get(cid);
    const marker = L.marker([c.lat, c.lon], { icon: pinIcon(shows.length) })
      .bindPopup(() => popupHtml(c, shows), { maxWidth: 320 });
    markers.set(cid, marker);
    layers.push(marker);
  }
  cluster.addLayers(layers);

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

    li.innerHTML =
      `<div class="name">${c.name}</div>` +
      `<div class="meta">${c.address || c.brand || 'Москва'}${far}` +
      (shows.length ? ` · ${shows.length} сеансов · ${titles.length} фильм(ов)` : '') +
      `</div>` +
      (shows.length
        ? `<div class="times">${shows.slice(0, 14).map((s) => `<b>${s.t}</b>`).join('')}` +
          (shows.length > 14 ? `<b>+${shows.length - 14}</b>` : '') + `</div>`
        : '');

    li.onclick = () => {
      map.setView([c.lat, c.lon], 15);
      const m = markers.get(cid);
      if (m) cluster.zoomToShowLayer(m, () => m.openPopup());
      if (window.innerWidth <= 820) $('panel').classList.remove('open');
    };
    ul.appendChild(li);
  }

  const totalShows = [...result.values()].reduce((n, s) => n + s.length, 0);
  const films = new Set([...result.values()].flat().map((s) => s.m)).size;
  $('summary').innerHTML =
    `<b>${result.size}</b> кинотеатров · <b>${totalShows}</b> сеансов · <b>${films}</b> фильмов`;
}

// ── Управление ───────────────────────────────────────────────────────────────

function buildDateChips() {
  const box = $('dates');
  box.innerHTML = '';
  if (!state.dates.length) { box.innerHTML = '<span class="meta">расписание не загружено</span>'; return; }

  for (const d of state.dates) {
    const dt = new Date(d + 'T12:00:00');
    const b = document.createElement('button');
    const today = state.dates[0] === d;
    b.innerHTML = `${today ? 'сегодня' : dt.toLocaleDateString('ru-RU', { weekday: 'short' })}` +
      `<span>${dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</span>`;
    b.classList.toggle('on', d === state.date);
    b.onclick = () => {
      state.date = d;
      [...box.children].forEach((el) => el.classList.toggle('on', el === b));
      render();
    };
    box.appendChild(b);
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
    if (!opts.length) { list.hidden = true; return; }
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
        L.circleMarker([state.me.lat, state.me.lon], {
          radius: 7, color: '#3fb950', fillColor: '#3fb950', fillOpacity: .9,
        }).addTo(map).bindPopup('Вы здесь');
        map.setView([state.me.lat, state.me.lon], 13);
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
    $('time-to').value = 1799;
    syncTime();
    markPreset($('time-presets').firstElementChild);
    renderTags();
    render();
  });

  $('toggle-panel').addEventListener('click', () => $('panel').classList.toggle('open'));
}

// ── Старт ────────────────────────────────────────────────────────────────────

(async function main() {
  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView(MOSCOW, 11);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap, &copy; CARTO',
  }).addTo(map);
  cluster = L.markerClusterGroup({ maxClusterRadius: 45, showCoverageOnHover: false }).addTo(map);

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
