'use strict';

// Settings live in localStorage on this device only (never in the repo).
// sessionStorage would be wiped whenever Android closes the PWA.
const KEY_GIST = 'iomw.gistId';
const KEY_TOKEN = 'iomw.token';
const KEY_CACHE = 'iomw.lastData';
const KEY_HISTORY = 'iomw.lastHistory';
const STALE_MINUTES = 120;
const AURORAWATCH_URL = 'https://aurorawatch-api.lancs.ac.uk/0.2/status/current-status.xml';
const KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null || v === '' ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const state = { data: null, history: null, aurora: null, auroraAt: 0, dayKey: null };

// ---------- Helpers ----------
const ICONS = {
  'sunny': '☀️', 'clear': '☀️', 'sunny-spells': '🌤️', 'sunny-intervals': '🌤️',
  'white-cloud': '☁️', 'grey-cloud': '☁️', 'cloudy': '☁️',
  'light-rain-showers': '🌦️', 'rain-showers': '🌦️', 'heavy-rain-showers': '🌧️',
  'becoming-rain': '🌧️', 'light-rain': '🌧️', 'rain': '🌧️', 'heavy-rain': '🌧️', 'drizzle': '🌧️',
  'sleet': '🌨️', 'snow': '❄️', 'hail': '🌨️', 'fog': '🌫️', 'mist': '🌫️',
  'thunder': '⛈️', 'thunderstorm': '⛈️', 'clear-night': '🌙',
  'clear-sky': '☀️', 'clear-sky-night': '🌙',
};
function iconFor(name = '', night = false) {
  const icon = dayIcon(name);
  if (!night) return icon;
  return { '☀️': '🌙', '🌤️': '☁️', '🌦️': '🌧️' }[icon] || icon;
}
function dayIcon(name) {
  const n = name.toLowerCase();
  if (ICONS[n]) return ICONS[n];
  if (n.includes('night') && n.includes('clear')) return '🌙';
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
const prettyIcon = (name = '') => name.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const isOvercast = (name = '') => /cloud|rain|drizzle|fog|mist|sleet|snow|thunder|shower/.test(name) && !/sunny|clear/.test(name);

const COMPASS = { north: 'N', south: 'S', east: 'E', west: 'W' };
const compass = (dir = '') => dir.split('-').map((p) => COMPASS[p.toLowerCase()] || '').join('') || dir;

const pad = (n) => String(n).padStart(2, '0');
const localDateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseLocal = (s) => (s ? new Date(s) : null);
const atTime = (dateKey, hhmm) => (hhmm ? new Date(`${dateKey}T${hhmm}:00`) : null);
const fmtTime = (d) => (d ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '–');
const fmtDay = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtWhen = (d) => (!d || isNaN(d) ? '' : localDateKey(d) === localDateKey() ? `${fmtTime(d)} today` : `${fmtTime(d)} ${fmtDay(d)}`);
function fmtDuration(ms, seconds = false) {
  const s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return seconds ? `${h}h ${pad(m)}m ${pad(sec)}s` : `${h}h ${pad(m)}m`;
  return seconds ? `${m}m ${pad(sec)}s` : `${m}m`;
}
function relDay(d, allDay) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((that - today) / 864e5);
  if (diff <= 0) return allDay || d.getHours() >= 17 ? 'Tonight' : 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff < 7) return `in ${diff} days`;
  return `in ${Math.round(diff / 7)} wk${diff >= 14 ? 's' : ''}`;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) e.append(c);
  return e;
}

// ---------- Derived "today" info ----------
function todayInfo(now = new Date()) {
  const data = state.data;
  const days = (data && data.days) || [];
  const key = localDateKey(now);
  const idx = Math.max(0, days.findIndex((d) => d.date === key));
  const today = days[idx];
  const next = days[idx + 1];
  const astro = Astro.sunTimes(now);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const astroTomorrow = Astro.sunTimes(tomorrow);
  const sunrise = (today && today.date === key && atTime(key, today.sunrise)) || astro.sunrise;
  const sunset = (today && today.date === key && atTime(key, today.sunset)) || astro.sunset;
  const nextSunrise = (next && atTime(next.date, next.sunrise)) || astroTomorrow.sunrise;
  return { today, days, idx, astro, astroTomorrow, sunrise, sunset, nextSunrise };
}

function skyPhase(now, info) {
  const { astro, sunrise, sunset } = info;
  if (now < astro.dawn || now > astro.dusk) return 'night';
  if (now < new Date(sunrise.valueOf() + 40 * 6e4)) return 'dawn';
  if (now > new Date(sunset.valueOf() - 50 * 6e4)) return 'dusk';
  return 'day';
}

function auroraScore() {
  const a = state.aurora;
  if (!a) return 0;
  const aw = { green: 0, yellow: 1, amber: 2, red: 3 }[a.status] ?? 0;
  const kp = a.kpMax == null ? 0 : a.kpMax >= 6 ? 3 : a.kpMax >= 5 ? 2 : a.kpMax >= 4 ? 1 : 0;
  return Math.max(aw, kp);
}

// ---------- Rendering ----------
function render() {
  const data = state.data;
  if (!data) return;
  const now = new Date();
  const info = todayInfo(now);
  const { today } = info;
  if (!today) { setStatus('No forecast data yet.'); return; }
  state.dayKey = localDateKey(now);

  $('today-date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  renderWarnings(data.warnings || []);
  renderHero(data, info, now);
  renderSky(now, info);
  renderSun(now, info);
  renderMoon(now);
  renderAurora();
  renderInsights(data, info, now);
  renderForecast(today);
  renderHistory(state.history);
  renderEvents(now);
  renderDays(info);
  renderMeta(data);
  renderFreshness();
}

function renderWarnings(warnings) {
  $('warnings').replaceChildren(...warnings.map((x) => {
    const body = el('div', { class: 'w-body' },
      ...(x.details || []).map((p) => el('p', { text: p })),
      x.areas ? el('p', {}, el('strong', { text: 'Areas: ' }), x.areas) : null,
      el('p', { class: 'faint', text: [x.issued && `Issued ${fmtWhen(parseLocal(x.issued))}`, x.forecaster && `by ${x.forecaster}`].filter(Boolean).join(' ') }));
    return el('details', { class: `glass warning ${x.level}` },
      el('summary', {},
        el('div', {}, el('span', { class: 'w-badge', text: x.level }), el('span', { class: 'w-title', text: (x.heading || '').replace(/^\w+ weather warning\.\s*/i, '') || x.heading })),
        el('div', { class: 'faint small', text: x.dates }),
        el('div', { class: 'w-more', text: 'Details' })),
      body);
  }));
}

function renderHero(data, info, now) {
  const { today } = info;
  const c = data.current;
  const night = now < info.sunrise || now > info.sunset;
  const hasNow = c && c.temp != null && c.temp !== '';
  $('hero-label').textContent = hasNow ? 'Now at Ronaldsway' : 'Today';
  $('hero-temp').textContent = `${hasNow ? c.temp : today.maxTemp}°`;
  $('hero-cond').textContent = hasNow && c.conditions ? c.conditions : prettyIcon(today.icon);
  $('hero-hilo').textContent = `High ${today.maxTemp}° · Low ${today.minTemp}° · ${compass(today.windDirection)} ${today.windSpeed} mph`;
  $('hero-icon').textContent = iconFor(today.icon, night);
  $('hero').hidden = false;
}

function renderSky(now, info) {
  const phase = skyPhase(now, info);
  const overcast = isOvercast(info.today && info.today.icon);
  document.body.className = `sky-${phase}${overcast ? ' overcast' : ''}${phase === 'night' && auroraScore() >= 2 ? ' aurora-on' : ''}`;
  const colors = { night: '#050a1c', dawn: '#1d2b5c', day: overcast ? '#3c5674' : '#1c5fb8', dusk: '#1a1d4d' };
  document.querySelector('meta[name="theme-color"]').setAttribute('content', colors[phase]);
}

function renderSun(now, info) {
  const { sunrise, sunset, nextSunrise, astro, astroTomorrow } = info;
  let label, target, t;
  if (now < sunrise) { label = 'Sunrise in'; target = sunrise; t = 0; }
  else if (now < sunset) { label = 'Sunset in'; target = sunset; t = (now - sunrise) / (sunset - sunrise); }
  else { label = 'Sunrise in'; target = nextSunrise; t = 1; }
  $('cd-label').textContent = label;
  $('cd-value').textContent = fmtDuration(target - now, true);

  const x = 160 - 140 * Math.cos(Math.PI * t), y = 112 - 96 * Math.sin(Math.PI * t);
  $('arc-done').setAttribute('d', t > 0 ? `M20 112 A140 96 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}` : '');
  const sun = $('arc-sun');
  sun.setAttribute('cx', x.toFixed(1)); sun.setAttribute('cy', y.toFixed(1));
  sun.style.opacity = t <= 0 || t >= 1 ? '.35' : '1';

  $('t-sunrise').textContent = fmtTime(sunrise);
  $('t-sunset').textContent = fmtTime(sunset);
  $('t-golden').textContent = fmtTime(astro.goldenStart);
  $('t-dusk').textContent = fmtTime(astro.dusk);

  const len = sunset - sunrise;
  const delta = (astroTomorrow.sunset - astroTomorrow.sunrise) - (astro.sunset - astro.sunrise);
  const dm = Math.round(Math.abs(delta) / 1000);
  const deltaTxt = dm < 30 ? 'same tomorrow' : `${dm >= 60 ? Math.floor(dm / 60) + 'm ' : ''}${dm % 60}s ${delta < 0 ? 'shorter' : 'longer'} tomorrow`;
  $('daylen').textContent = `${fmtDuration(len)} daylight · ${deltaTxt}`;
  $('sun-card').hidden = false;
}

function moonPath(fraction, waxing) {
  if (fraction < 0.01) return '';
  const rx = (48 * Math.abs(1 - 2 * fraction)).toFixed(2);
  const limb = waxing ? 1 : 0;
  const term = fraction < 0.5 ? (waxing ? 0 : 1) : (waxing ? 1 : 0);
  return `M50 2 A48 48 0 0 ${limb} 50 98 A${rx} 48 0 0 ${term} 50 2Z`;
}

function renderMoon(now) {
  const m = Astro.moonIllumination(now);
  const p = Astro.phaseName(m.phase);
  $('moon-lit').setAttribute('d', moonPath(m.fraction, m.phase < 0.5));
  $('moon-name').textContent = p.name;
  const up = Astro.moonAltitude(now) > 0;
  $('moon-illum').textContent = `${Math.round(m.fraction * 100)}% lit${up ? ' · up now' : ''}`;
  const t = Astro.moonTimes(now);
  const parts = [];
  if (t.rise) parts.push(`Rises ${fmtTime(t.rise)}`);
  if (t.set) parts.push(`Sets ${fmtTime(t.set)}`);
  $('moon-times').textContent = parts.join(' · ') || 'No rise or set today';
  const full = Astro.nextPhase(0.5, now), nm = Astro.nextPhase(0, now);
  const short = (d) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  $('moon-next').textContent = [full && `Full ${short(full)}`, nm && `New ${short(nm)}`]
    .filter(Boolean).sort((a, b) => (a.startsWith('Full') ? full - nm : nm - full)).join(' · ');
}

function renderAurora() {
  const a = state.aurora;
  const lvl = $('aurora-level');
  if (!a) {
    lvl.className = 'aurora-level'; lvl.textContent = navigator.onLine === false ? 'Offline' : 'Checking…';
    $('aurora-text').textContent = ''; $('aurora-kp').textContent = '';
    return;
  }
  if (a.error) {
    lvl.className = 'aurora-level'; lvl.textContent = 'Unavailable';
    $('aurora-text').textContent = 'Couldn\'t reach AuroraWatch UK or NOAA.'; $('aurora-kp').textContent = '';
    return;
  }
  const score = auroraScore();
  const levels = [
    ['al-green', 'Quiet', 'Aurora unlikely tonight.'],
    ['al-yellow', 'Minor', 'Maybe on camera, low on the northern horizon from a dark spot.'],
    ['al-amber', 'Possible', 'Could be visible to the eye. Find a dark, north-facing spot.'],
    ['al-red', 'Likely', 'Good chance of a visible aurora. Get away from lights and look north.'],
  ];
  const [cls, name, text] = levels[score];
  lvl.className = `aurora-level ${cls}`;
  lvl.textContent = name;
  $('aurora-text').textContent = text;
  $('aurora-kp').textContent = [a.kpMax != null && `Kp up to ${a.kpMax.toFixed(1)} next 24h`, a.status && `AuroraWatch: ${a.status}`]
    .filter(Boolean).join(' · ');
}

function renderInsights(data, info, now) {
  const { today } = info;
  const chips = [];
  for (const w of data.warnings || []) {
    const what = (w.heading || '').split(':').pop().trim();
    chips.push({ text: `⚠️ ${w.level[0].toUpperCase() + w.level.slice(1)} warning${what ? ': ' + what : ''}`, hot: true });
  }
  const min = parseFloat(today.minTemp), max = parseFloat(today.maxTemp), wind = parseFloat(today.windSpeed);
  const rainMax = Math.max(0, ...String(today.rainfall || '').split(/[^\d.]+/).map(Number).filter((n) => !isNaN(n)));
  if (min <= 0) chips.push({ text: '🧊 Frost likely' }); else if (min <= 2) chips.push({ text: '🥶 Chilly night' });
  if (max >= 20) chips.push({ text: '😎 Warm one' });
  if (wind >= 30) chips.push({ text: '🌬️ Very windy' }); else if (wind >= 20) chips.push({ text: '💨 Breezy' });
  if (rainMax >= 10) chips.push({ text: '☔ Wet day, take a coat' });
  else if (rainMax >= 3) chips.push({ text: '🌦️ Showers about' });
  else if (today.rainfall === '0') chips.push({ text: '👍 Staying dry' });
  if (/sunny/.test(today.icon)) chips.push({ text: '☀️ Some sunshine' });

  const moon = Astro.moonIllumination(now);
  const events = Astro.upcomingEvents(2, now);
  const tonight = events.filter((e) => localDateKey(e.date) === localDateKey(now) || (e.date - now > 0 && e.date - now < 18 * 36e5));
  for (const e of tonight) {
    if (e.title.includes('Moon') && e.icon === '🌕') chips.push({ text: e.supermoon ? '🌕 Supermoon tonight' : '🌕 Full moon tonight', hot: true });
    if (e.shower) chips.push({ text: `🌠 ${e.title} tonight`, hot: true });
  }
  if (auroraScore() >= 2) chips.push({ text: '🌌 Aurora possible tonight', hot: true });
  const clearish = !isOvercast(today.icon) || /sunny/.test(today.icon);
  if (clearish && rainMax < 1 && moon.fraction < 0.35) chips.push({ text: '✨ Good stargazing tonight' });

  $('insights').replaceChildren(...chips.slice(0, 7).map((c) => el('li', { class: c.hot ? 'hot' : '', text: c.text })));
}

function renderForecast(today) {
  $('forecast-text').replaceChildren(...(today.forecast || []).map((p) => el('p', { text: p })));
  const rows = [
    ['Wind', today.windComments],
    ['Visibility', today.visibility],
    ['Rain', [today.rainfall && `${today.rainfall} mm`, today.rainComments].filter(Boolean).join(' – ')],
  ].filter(([, v]) => v);
  $('details').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  $('forecast').hidden = false;
}

// ---------- History (from history.json, recorded on node1) ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
const fmtT = (v) => `${Number.isInteger(v) ? v : v.toFixed(1)}°`;

function renderHistory(h) {
  const card = $('history');
  if (!h || !h.hours) { card.hidden = true; return; }
  card.hidden = false;
  const now = Date.now(), from = now - 24 * 36e5;
  const pts = h.hours.map((p) => ({ t: new Date(p.t).valueOf(), v: p.temp })).filter((p) => p.t >= from - 36e5 && p.v != null);
  const since = h.since ? new Date(h.since) : null;
  $('h-sub').textContent = since ? `tracking since ${fmtDay(since)}` : '';

  const chart = $('h-chart'), tip = $('h-tip');
  const enough = pts.length >= 3;
  chart.style.display = enough ? '' : 'none';
  $('h-empty').hidden = enough;
  $('h-empty').textContent = 'Collecting readings – the chart fills in over the next few hours.';
  chart.replaceChildren(svg('desc', { id: 'h-desc' }));
  tip.hidden = true;

  if (enough) {
    // Layout: plot area inside a 320x150 viewBox.
    const L = 26, R = 304, T = 16, B = 124;
    const vs = pts.map((p) => p.v);
    let lo = Math.floor(Math.min(...vs)) - 1, hi = Math.ceil(Math.max(...vs)) + 1;
    const step = [1, 2, 5, 10].find((s) => (hi - lo) / s <= 4) || 10;
    lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const x = (t) => L + ((t - from) / (now - from)) * (R - L);
    const y = (v) => B - ((v - lo) / (hi - lo)) * (B - T);

    const defs = svg('defs');
    const grad = svg('linearGradient', { id: 'hArea', x1: 0, x2: 0, y1: 0, y2: 1 });
    grad.append(svg('stop', { offset: 0, 'stop-color': '#8fd3ff', 'stop-opacity': '.28' }), svg('stop', { offset: 1, 'stop-color': '#8fd3ff', 'stop-opacity': '0' }));
    defs.append(grad);
    chart.append(defs);

    for (let v = lo; v <= hi; v += step) {
      chart.append(svg('line', { class: 'grid', x1: L, x2: R, y1: y(v), y2: y(v) }), svg('text', { class: 'axis', x: L - 5, y: y(v) + 3, 'text-anchor': 'end' }, `${v}°`));
    }
    // X labels every 6 hours on the local clock.
    const tick = new Date(from); tick.setMinutes(0, 0, 0); tick.setHours(Math.ceil(tick.getHours() / 6) * 6);
    for (let t = tick.valueOf(); t <= now; t += 6 * 36e5) {
      chart.append(svg('text', { class: 'axis', x: x(t), y: B + 14, 'text-anchor': 'middle' }, fmtTime(new Date(t))));
    }

    // Line and soft area, broken where readings are more than 2 hours apart.
    const vis = pts.filter((p) => p.t >= from);
    let d = '', area = '', seg = [];
    const flush = () => {
      if (seg.length > 1) {
        d += seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
        area += `M${x(seg[0].t).toFixed(1)} ${B}` + seg.map((p) => `L${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('') + `L${x(seg[seg.length - 1].t).toFixed(1)} ${B}Z`;
      }
      seg = [];
    };
    vis.forEach((p, i) => { if (i && p.t - vis[i - 1].t > 2 * 36e5) flush(); seg.push(p); });
    flush();
    chart.append(svg('path', { class: 'area', d: area }), svg('path', { class: 'line', d }));

    // Direct labels: low, high and latest only.
    const lowP = vis.reduce((a, b) => (b.v < a.v ? b : a)), highP = vis.reduce((a, b) => (b.v > a.v ? b : a)), last = vis[vis.length - 1];
    const label = (p, text, above) => {
      const px = Math.min(Math.max(x(p.t), L + 14), R - 14);
      chart.append(svg('circle', { class: 'mark', cx: x(p.t), cy: y(p.v), r: 4 }),
        svg('text', { class: 'lbl', x: px, y: y(p.v) + (above ? -9 : 17), 'text-anchor': 'middle' }, text));
    };
    if (highP !== last) label(highP, fmtT(highP.v), true);
    if (lowP !== last && lowP !== highP) label(lowP, fmtT(lowP.v), false);
    // Put the latest label on the side away from the incoming line.
    const prev = vis[vis.length - 2];
    label(last, fmtT(last.v), prev ? prev.v <= last.v : last.v < (lo + hi) / 2);
    $('h-desc').textContent = `Temperature over the last 24 hours: low ${fmtT(lowP.v)}, high ${fmtT(highP.v)}, latest ${fmtT(last.v)}.`;

    // Crosshair + tooltip, snapping to the nearest reading.
    const cross = svg('line', { class: 'cross', y1: T - 6, y2: B, visibility: 'hidden' });
    const dot = svg('circle', { class: 'mark', r: 5, visibility: 'hidden' });
    const hit = svg('rect', { x: L, y: 0, width: R - L, height: B + 4, fill: 'transparent' });
    chart.append(cross, dot, hit);
    const move = (ev) => {
      const box = chart.getBoundingClientRect();
      const vx = ((ev.clientX - box.left) / box.width) * 320;
      const p = vis.reduce((a, b) => (Math.abs(x(b.t) - vx) < Math.abs(x(a.t) - vx) ? b : a));
      cross.setAttribute('x1', x(p.t)); cross.setAttribute('x2', x(p.t)); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.v)); dot.setAttribute('visibility', 'visible');
      tip.replaceChildren(el('strong', { text: fmtT(p.v) }), fmtTime(new Date(p.t)));
      tip.style.left = `${Math.min(Math.max((x(p.t) / 320) * 100, 14), 86)}%`;
      tip.hidden = false;
    };
    const leave = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
    hit.addEventListener('pointercancel', leave);
  }

  // Records since tracking started.
  const r = h.records || {};
  const when = (s) => { const d = new Date(s); return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${fmtTime(d)}`; };
  const recs = [];
  if (r.coldest) recs.push(`🥶 Coldest ${fmtT(r.coldest.temp)} · ${when(r.coldest.at)}`);
  if (r.warmest) recs.push(`🌡️ Warmest ${fmtT(r.warmest.temp)} · ${when(r.warmest.at)}`);
  if (r.windiest) recs.push(`💨 Windiest ${Math.round(r.windiest.mph)} mph · ${when(r.windiest.at)}`);
  if (r.warningsIssued) recs.push(`⚠️ ${r.warningsIssued} warning${r.warningsIssued === 1 ? '' : 's'} recorded`);
  $('h-records').replaceChildren(...recs.map((t) => el('li', { text: t })));

  // Observed vs forecast, newest first.
  const days = (h.days || []).slice().reverse();
  $('h-days').replaceChildren(...days.map((d) => {
    const date = new Date(d.date + 'T12:00:00');
    const isToday = d.date === localDateKey();
    const dayCell = el('td', { text: isToday ? 'Today' : date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) });
    for (const w of d.warnings || []) dayCell.append(el('span', { class: `w-dot ${w}`, title: `${w} warning` }));
    return el('tr', {},
      dayCell,
      el('td', { text: `${fmtT(d.min)} – ${fmtT(d.max)}${isToday ? ' so far' : ''}` }),
      el('td', { class: 'fc', text: d.forecastMax != null ? `${fmtT(d.forecastMin)} – ${fmtT(d.forecastMax)}` : '–' }));
  }));
  $('h-days-wrap').hidden = days.length === 0;

  // Accessible table of the hourly readings (the chart's data).
  $('h-rows').replaceChildren(...pts.slice().reverse().map((p) =>
    el('tr', {}, el('td', { text: `${fmtDay(new Date(p.t))} ${fmtTime(new Date(p.t))}` }), el('td', { text: fmtT(p.v) }))));
}

function renderEvents(now) {
  const events = Astro.upcomingEvents(60, now).filter((e) => e.date >= new Date(now.valueOf() - 12 * 36e5)).slice(0, 6);
  $('events-list').replaceChildren(...events.map((e) => {
    const hot = e.great || e.supermoon || e.title.includes('eclipse');
    const when = e.allDay ? fmtDay(e.date) : `${fmtDay(e.date)}, ${fmtTime(e.date)}`;
    return el('li', { class: hot ? 'hot' : '' },
      el('span', { class: 'e-icon', text: e.icon, 'aria-hidden': 'true' }),
      el('div', {},
        el('div', {}, el('span', { class: 'e-title', text: e.title }), el('span', { class: 'e-when', text: relDay(e.date, e.allDay) })),
        el('div', { class: 'e-detail', text: `${when} · ${e.detail}` })));
  }));
  $('events').hidden = events.length === 0;
}

function renderDays(info) {
  const rest = info.days.slice(info.idx + 1);
  $('days-list').replaceChildren(...rest.map((d) => {
    const date = new Date(d.date + 'T12:00:00');
    return el('li', { title: (d.forecast || [])[0] || '' },
      el('span', { text: date.toLocaleDateString('en-GB', { weekday: 'short' }) }),
      el('span', { class: 'd-icon', text: iconFor(d.icon), 'aria-hidden': 'true' }),
      el('span', { class: 'd-sum', text: `${compass(d.windDirection)} ${d.windSpeed} mph${d.warning ? ' · ⚠ ' + d.warning : ''}` }),
      el('span', { class: 'd-temp' }, `${d.maxTemp}° `, el('span', { text: `${d.minTemp}°` })));
  }));
  $('days').hidden = rest.length === 0;
}

function renderMeta(data) {
  const issued = parseLocal(data.issuedOn);
  const fetched = data.fetchedAt ? new Date(data.fetchedAt) : null;
  const stale = fetched && (Date.now() - fetched) / 6e4 > STALE_MINUTES;
  $('meta').replaceChildren(
    el('span', { text: `Forecast issued ${fmtWhen(issued)}${data.forecaster ? ' by ' + data.forecaster : ''}.` }), el('br'),
    el('span', { class: stale ? 'stale' : '', text: `Checked ${fmtWhen(fetched)}${stale ? ' (out of date)' : ''}.` }), el('br'),
    el('a', { href: 'https://weather.gov.im', target: '_blank', rel: 'noopener', text: 'Ronaldsway Met Office' }), ' · ',
    el('a', { href: 'https://aurorawatch.lancs.ac.uk/', target: '_blank', rel: 'noopener', text: 'AuroraWatch UK' }), ' · ',
    el('a', { href: 'https://www.swpc.noaa.gov/', target: '_blank', rel: 'noopener', text: 'NOAA SWPC' }));
}

// How long ago the GitHub Action last updated the gist (it runs every 30 min).
function renderFreshness() {
  const f = $('freshness');
  const fetched = state.data && state.data.fetchedAt ? new Date(state.data.fetchedAt) : null;
  if (!fetched || isNaN(fetched)) { f.hidden = true; return; }
  const mins = Math.max(0, Math.round((Date.now() - fetched) / 6e4));
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago`
    : mins < 48 * 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m ago` : `${Math.round(mins / 1440)} days ago`;
  f.className = `freshness${mins > STALE_MINUTES ? ' f-red' : mins > 45 ? ' f-amber' : ''}`;
  f.textContent = `Updated ${ago}${mins > STALE_MINUTES ? ', check the Action' : ''}`;
  f.title = `Scraper last ran ${fmtWhen(fetched)}`;
  f.hidden = false;
}

function setStatus(msg) { $('status').textContent = msg || ''; $('status').hidden = !msg; }

// ---------- Live tick (countdown, sky, midnight rollover) ----------
let tickCount = 0;
function tick() {
  if (!state.data || document.hidden) return;
  const now = new Date();
  if (localDateKey(now) !== state.dayKey) { render(); return; }
  const info = todayInfo(now);
  renderSun(now, info);
  if (++tickCount % 60 === 0) { renderSky(now, info); renderHero(state.data, info, now); renderMoon(now); renderFreshness(); }
}

// ---------- Data ----------
async function fetchData() {
  if (location.hash === '#demo') {
    const [w, h] = await Promise.all(['sample-weather.json', 'sample-history.json'].map((f) => fetch(f, { cache: 'no-store' }).then((r) => r.json())));
    return { data: w, history: h };
  }
  const gistId = store.get(KEY_GIST);
  if (!gistId) throw Object.assign(new Error('Not set up'), { setup: true });
  const token = store.get(KEY_TOKEN);
  if (!token) return fetchRaw(gistId);

  // With a token: use the API (5,000 requests/hour per token).
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };
  const r = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}`, { headers, cache: 'no-store' });
  if (r.status === 404) throw new Error('Gist not found – check the ID in settings.');
  if (r.status === 403 || r.status === 429) throw new Error('GitHub rate limit hit – try again later or add a token.');
  if (!r.ok) throw new Error(`GitHub returned ${r.status}`);
  const gist = await r.json();
  const file = gist.files && gist.files['weather.json'];
  if (!file) throw new Error('weather.json not found in gist.');
  const read = async (f) => (f.truncated ? (await fetch(f.raw_url, { cache: 'no-store' })).text() : f.content);
  const data = JSON.parse(await read(file));
  if (!data.days) throw new Error('Gist has no weather data yet – has the Action run?');
  // history.json is written by node1; it's optional (the GitHub Action backup doesn't write it).
  let history = null;
  const hf = gist.files['history.json'];
  if (hf) { try { history = JSON.parse(await read(hf)); } catch {} }
  return { data, history };
}

// Without a token: read the files from gist.githubusercontent.com. Unlike the API
// (60 requests/hour shared by everything on your connection) this has no rate limit.
// GitHub caches it for up to 5 minutes, which is fine for data updated every 15.
async function fetchRaw(gistId) {
  const url = (file) => `https://gist.githubusercontent.com/raw/${encodeURIComponent(gistId)}/${file}`;
  const [w, h] = await Promise.all([
    fetch(url('weather.json'), { cache: 'no-store' }),
    fetch(url('history.json'), { cache: 'no-store' }).catch(() => null),
  ]);
  if (w.status === 404) throw new Error('Gist not found – check the ID in settings.');
  if (!w.ok) throw new Error(`GitHub returned ${w.status}`);
  const data = await w.json();
  if (!data.days) throw new Error('Gist has no weather data yet – has the scraper run?');
  let history = null;
  if (h && h.ok) { try { history = await h.json(); } catch {} }
  return { data, history };
}

async function loadAurora() {
  if (Date.now() - state.auroraAt < 10 * 6e4 && state.aurora && !state.aurora.error) return;
  const [aw, kp] = await Promise.allSettled([
    fetch(AURORAWATCH_URL, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); }),
    fetch(KP_URL, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }),
  ]);
  const a = { status: null, kpMax: null };
  if (aw.status === 'fulfilled') {
    const m = aw.value.match(/status_id="(\w+)"/);
    if (m) a.status = m[1].toLowerCase();
  }
  if (kp.status === 'fulfilled' && Array.isArray(kp.value)) {
    // Newer format: objects; older format: header row then arrays.
    const rows = Array.isArray(kp.value[0]) ? kp.value.slice(1).map((r) => ({ time_tag: r[0], kp: r[1] })) : kp.value;
    const now = Date.now();
    const vals = rows
      .map((r) => ({ t: Date.parse(String(r.time_tag).replace(' ', 'T') + (/Z$/.test(r.time_tag) ? '' : 'Z')), kp: parseFloat(r.kp) }))
      .filter((r) => !isNaN(r.kp) && r.t >= now - 3 * 36e5 && r.t <= now + 24 * 36e5)
      .map((r) => r.kp);
    if (vals.length) a.kpMax = Math.max(...vals);
  }
  if (!a.status && a.kpMax == null) a.error = true; else state.auroraAt = Date.now();
  state.aurora = a;
}

let loading = false, lastLoad = 0;
async function load() {
  if (loading) return;
  loading = true;
  lastLoad = Date.now();
  $('refresh').classList.add('spin');
  try {
    const [res] = await Promise.allSettled([fetchData(), loadAurora()]);
    if (res.status === 'rejected') throw res.reason;
    state.data = res.value.data;
    store.set(KEY_CACHE, JSON.stringify(res.value.data));
    if (res.value.history) { state.history = res.value.history; store.set(KEY_HISTORY, JSON.stringify(res.value.history)); }
    setStatus('');
  } catch (e) {
    if (e.setup) { showSetup(false); setStatus(''); }
    else setStatus(navigator.onLine === false ? 'Offline – showing last saved forecast.' : e.message);
  } finally {
    render();
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
  // One-off setup link: https://weather.luckins.im/#gist=<id>
  const m = location.hash.match(/^#gist=([\w-]+)$/);
  if (m) { store.set(KEY_GIST, m[1]); history.replaceState(null, '', location.pathname); }

  $('setup-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const raw = $('gist-id').value.trim(); // bare ID or full gist URL
    store.set(KEY_GIST, raw.split('/').filter(Boolean).pop());
    store.set(KEY_TOKEN, $('gh-token').value.trim());
    $('setup').hidden = true;
    load();
  });
  $('setup-cancel').addEventListener('click', () => { $('setup').hidden = true; });
  $('setup-clear').addEventListener('click', () => {
    [KEY_GIST, KEY_TOKEN, KEY_CACHE, KEY_HISTORY].forEach((k) => store.set(k, null));
    location.reload();
  });
  $('settings-btn').addEventListener('click', () => showSetup(true));
  $('refresh').addEventListener('click', () => { state.auroraAt = 0; load(); });
  // Refresh when you come back to the app, but not more than once every 2 minutes.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastLoad > 2 * 6e4) load();
  });

  const cached = store.get(KEY_CACHE);
  if (cached && location.hash !== '#demo') {
    try { state.history = JSON.parse(store.get(KEY_HISTORY) || 'null'); } catch {}
    try { state.data = JSON.parse(cached); render(); } catch {}
  }
  load();
  setInterval(tick, 1000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
