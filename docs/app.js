'use strict';

// Settings live in localStorage on this device only (never in the repo).
// sessionStorage would be wiped whenever Android closes the PWA.
const KEY_GIST = 'iomw.gistId';
const KEY_TOKEN = 'iomw.token';
const KEY_CACHE = 'iomw.lastData';
const STALE_MINUTES = 120;

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null || v === '' ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const ICONS = {
  'sunny': '☀️', 'clear': '☀️', 'sunny-spells': '🌤️', 'sunny-intervals': '🌤️',
  'white-cloud': '☁️', 'grey-cloud': '☁️', 'cloudy': '☁️',
  'light-rain-showers': '🌦️', 'rain-showers': '🌦️', 'heavy-rain-showers': '🌧️',
  'becoming-rain': '🌧️', 'light-rain': '🌧️', 'rain': '🌧️', 'heavy-rain': '🌧️', 'drizzle': '🌧️',
  'sleet': '🌨️', 'snow': '❄️', 'hail': '🌨️', 'fog': '🌫️', 'mist': '🌫️',
  'thunder': '⛈️', 'thunderstorm': '⛈️', 'clear-night': '🌙',
};
function iconFor(name = '') {
  if (ICONS[name]) return ICONS[name];
  const n = name.toLowerCase();
  if (n.includes('thunder')) return '⛈️';
  if (n.includes('snow')) return '❄️';
  if (n.includes('sleet') || n.includes('hail')) return '🌨️';
  if (n.includes('fog') || n.includes('mist')) return '🌫️';
  if (n.includes('shower')) return '🌦️';
  if (n.includes('rain') || n.includes('drizzle')) return '🌧️';
  if (n.includes('sun')) return '🌤️';
  if (n.includes('cloud')) return '☁️';
  return '🌡️';
}

const COMPASS = { north: 'N', south: 'S', east: 'E', west: 'W' };
const compass = (dir = '') => dir.split('-').map((p) => COMPASS[p.toLowerCase()] || '').join('') || dir;

const localDateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseLocal = (s) => (s ? new Date(s) : null); // "2026-11-19T11:30:00" -> local time
const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtWhen = (d) => {
  if (!d || isNaN(d)) return '';
  return localDateKey(d) === localDateKey() ? `${fmtTime(d)} today` : `${fmtTime(d)} ${fmtDay(d)}`;
};

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

// ---------- Rendering ----------
function render(data) {
  const days = data.days || [];
  const todayKey = localDateKey();
  const today = days.find((d) => d.date === todayKey) || days[0];
  if (!today) { setStatus('No forecast data yet.'); return; }

  $('today-date').textContent = new Date(today.date + 'T12:00:00')
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  // Warnings
  const w = $('warnings');
  w.replaceChildren(...(data.warnings || []).map((x) => {
    const body = el('div', { class: 'w-body' },
      ...(x.details || []).map((p) => el('p', { text: p })),
      x.areas ? el('p', {}, el('strong', { text: 'Areas: ' }), x.areas) : null,
      el('p', { class: 'muted', text: [
        x.issued && `Issued ${fmtWhen(parseLocal(x.issued))}`,
        x.forecaster && `by ${x.forecaster}`,
      ].filter(Boolean).join(' ') }),
    );
    return el('details', { class: `card warning ${x.level}` },
      el('summary', {},
        el('div', {}, el('span', { class: 'w-badge', text: x.level }), el('span', { class: 'w-title', text: x.heading })),
        el('div', { class: 'muted', text: x.dates }),
        el('div', { class: 'w-more', text: 'Show details' })),
      body);
  }));

  // Hero
  $('hero-icon').textContent = iconFor(today.icon);
  $('hero-max').textContent = `${today.maxTemp}°`;
  $('hero-min').textContent = `/ ${today.minTemp}°`;
  $('hero-summary').textContent = `Wind ${compass(today.windDirection)} ${today.windSpeed} mph`;
  const c = data.current;
  $('now').replaceChildren(c && c.temp != null
    ? el('span', {}, el('span', { class: 'muted', text: 'Now at the airport: ' }),
        el('strong', { text: `${c.temp}°C` }), `, ${[c.conditions, c.wind].filter(Boolean).join(', ')}`)
    : '');
  $('now').hidden = !(c && c.temp != null);
  $('sunrise').textContent = today.sunrise || '–';
  $('sunset').textContent = today.sunset || '–';
  $('hero').hidden = false;

  // Forecast text + details
  $('forecast-text').replaceChildren(...(today.forecast || []).map((p) => el('p', { text: p })));
  const rows = [
    ['Wind', today.windComments],
    ['Visibility', today.visibility],
    ['Rain', [today.rainfall && `${today.rainfall} mm`, today.rainComments].filter(Boolean).join(' – ')],
  ].filter(([, v]) => v);
  $('details').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  $('forecast').hidden = false;

  // Next days
  const rest = days.filter((d) => d.date > today.date);
  $('days-list').replaceChildren(...rest.map((d) => {
    const date = new Date(d.date + 'T12:00:00');
    const first = (d.forecast || [])[0] || '';
    return el('li', { title: first },
      el('span', { text: date.toLocaleDateString('en-GB', { weekday: 'short' }) }),
      el('span', { class: 'd-icon', text: iconFor(d.icon), 'aria-hidden': 'true' }),
      el('span', { class: 'd-sum', text: `${compass(d.windDirection)} ${d.windSpeed} mph${d.warning ? ' · ⚠ ' + d.warning : ''}` }),
      el('span', { class: 'd-temp', text: `${d.maxTemp}° / ${d.minTemp}°` }));
  }));
  $('days').hidden = rest.length === 0;

  // Meta
  const issued = parseLocal(data.issuedOn);
  const fetched = data.fetchedAt ? new Date(data.fetchedAt) : null;
  const stale = fetched && (Date.now() - fetched) / 60000 > STALE_MINUTES;
  $('meta').replaceChildren(
    el('span', { text: `Forecast issued ${fmtWhen(issued)}${data.forecaster ? ' by ' + data.forecaster : ''}.` }),
    el('br'),
    el('span', { class: stale ? 'stale' : '', text: `Checked ${fmtWhen(fetched)}${stale ? ' (out of date)' : ''}.` }),
    el('br'),
    el('a', { href: 'https://weather.gov.im', target: '_blank', rel: 'noopener', text: 'Source: Ronaldsway Met Office' }));
}

function setStatus(msg) { $('status').textContent = msg || ''; $('status').hidden = !msg; }

// ---------- Data ----------
async function fetchData() {
  if (location.hash === '#demo') {
    const r = await fetch('sample-weather.json', { cache: 'no-store' });
    return r.json();
  }
  const gistId = store.get(KEY_GIST);
  if (!gistId) throw Object.assign(new Error('Not set up'), { setup: true });
  const headers = { Accept: 'application/vnd.github+json' };
  const token = store.get(KEY_TOKEN);
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, { headers, cache: 'no-store' });
  if (r.status === 404) throw new Error('Gist not found – check the ID in settings.');
  if (r.status === 403 || r.status === 429) throw new Error('GitHub rate limit hit – try again later or add a token.');
  if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
  const gist = await r.json();
  const file = gist.files && gist.files['weather.json'];
  if (!file) throw new Error('weather.json not found in gist.');
  const text = file.truncated ? await (await fetch(file.raw_url, { cache: 'no-store' })).text() : file.content;
  const data = JSON.parse(text);
  if (!data.days) throw new Error('Gist has no weather data yet – has the Action run?');
  return data;
}

let loading = false;
async function load() {
  if (loading) return;
  loading = true;
  $('refresh').classList.add('spin');
  try {
    const data = await fetchData();
    store.set(KEY_CACHE, JSON.stringify(data));
    render(data);
    setStatus('');
  } catch (e) {
    if (e.setup) { showSetup(false); setStatus(''); }
    else setStatus(navigator.onLine === false ? 'Offline – showing last saved forecast.' : e.message);
  } finally {
    loading = false;
    $('refresh').classList.remove('spin');
  }
}

// ---------- Setup ----------
function showSetup(cancellable = true) {
  $('gist-id').value = store.get(KEY_GIST) || '';
  $('gh-token').value = store.get(KEY_TOKEN) || '';
  $('setup-cancel').hidden = !cancellable;
  $('setup').hidden = false;
  $('gist-id').focus();
}

function init() {
  // Allow a one-off setup link: https://weather.luckins.im/#gist=<id>
  const m = location.hash.match(/^#gist=([\w-]+)$/);
  if (m) { store.set(KEY_GIST, m[1]); history.replaceState(null, '', location.pathname); }

  $('setup-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    // Accept either a bare ID or a full gist URL.
    const raw = $('gist-id').value.trim();
    store.set(KEY_GIST, raw.split('/').filter(Boolean).pop());
    store.set(KEY_TOKEN, $('gh-token').value.trim());
    $('setup').hidden = true;
    load();
  });
  $('setup-cancel').addEventListener('click', () => { $('setup').hidden = true; });
  $('setup-clear').addEventListener('click', () => {
    [KEY_GIST, KEY_TOKEN, KEY_CACHE].forEach((k) => store.set(k, null));
    location.reload();
  });
  $('settings-btn').addEventListener('click', () => showSetup(true));
  $('refresh').addEventListener('click', load);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  const cached = store.get(KEY_CACHE);
  if (cached) { try { render(JSON.parse(cached)); } catch {} }
  load();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
