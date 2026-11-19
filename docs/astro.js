'use strict';
/*
 * Sun and moon calculations, plus a list of upcoming sky events.
 * Formulas follow the approach popularised by SunCalc (Vladimir Agafonkin, BSD-2)
 * and Astronomy Answers (aa.quae.nl). Accuracy is a minute or two, plenty for an app.
 */
const Astro = (() => {
  const { PI, sin, cos, tan, asin, atan2: atan, acos, sqrt, abs, round } = Math;
  const rad = PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397;

  // Isle of Man (roughly central, near Crosby)
  const LAT = 54.2, LNG = -4.53;

  const toJulian = (d) => d.valueOf() / dayMs - 0.5 + J1970;
  const fromJulian = (j) => new Date((j + 0.5 - J1970) * dayMs);
  const toDays = (d) => toJulian(d) - J2000;

  const rightAscension = (l, b) => atan(sin(l) * cos(e) - tan(b) * sin(e), cos(l));
  const declination = (l, b) => asin(sin(b) * cos(e) + cos(b) * sin(e) * sin(l));
  const altitude = (H, phi, dec) => asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H));
  const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
  const refraction = (h) => { if (h < 0) h = 0; return 0.0002967 / tan(h + 0.00312536 / (h + 0.08901179)); };

  const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
  const eclipticLongitude = (M) =>
    M + rad * (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M)) + rad * 102.9372 + PI;
  // Apparent solar longitude (Astronomical Almanac low-precision formula, ~0.01 degrees).
  function sunLongitude(d) {
    const L0 = rad * (280.460 + 0.9856474 * d), g = rad * (357.528 + 0.9856003 * d);
    return L0 + rad * (1.915 * sin(g) + 0.020 * sin(2 * g));
  }
  function sunCoords(d) {
    const L = sunLongitude(d);
    return { dec: declination(L, 0), ra: rightAscension(L, 0), L };
  }

  function sunAltitude(date, lat = LAT, lng = LNG) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date), c = sunCoords(d);
    return altitude(siderealTime(d, lw) - c.ra, phi, c.dec) / rad;
  }

  // ---- Sun times ----
  const J0 = 0.0009;
  const julianCycle = (d, lw) => round(d - J0 - lw / (2 * PI));
  const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * PI) + n;
  const solarTransitJ = (ds, M, L) => J2000 + ds + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
  const hourAngle = (h, phi, d) => acos((sin(h) - sin(phi) * sin(d)) / (cos(phi) * cos(d)));

  /** Sun event times for the local calendar day containing `date`. */
  function sunTimes(date, lat = LAT, lng = LNG) {
    const noonLocal = new Date(date); noonLocal.setHours(12, 0, 0, 0);
    const lw = rad * -lng, phi = rad * lat, d = toDays(noonLocal);
    const n = julianCycle(d, lw), ds = approxTransit(0, lw, n);
    const M = solarMeanAnomaly(ds), L = eclipticLongitude(M), dec = declination(L, 0);
    const Jnoon = solarTransitJ(ds, M, L);
    const at = (deg) => {
      const w = hourAngle(deg * rad, phi, dec);
      if (isNaN(w)) return [null, null];
      const Jset = solarTransitJ(approxTransit(w, lw, n), M, L);
      return [fromJulian(Jnoon - (Jset - Jnoon)), fromJulian(Jset)];
    };
    const [sunrise, sunset] = at(-0.833);
    const [dawn, dusk] = at(-6);             // civil twilight
    const [nauticalDawn, nauticalDusk] = at(-12);
    const [goldenEnd, goldenStart] = at(6);  // golden hour: sun below 6 degrees
    return { solarNoon: fromJulian(Jnoon), sunrise, sunset, dawn, dusk, nauticalDawn, nauticalDusk, goldenEnd, goldenStart };
  }

  // ---- Moon ----
  // Moon position with the main periodic terms (Meeus, low precision): ~0.3 degrees.
  function moonCoords(d) {
    const L = rad * (218.316 + 13.176396 * d), Mm = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.22935 * d);
    const D = rad * (297.8502 + 12.190749 * d), Ms = rad * (357.5291 + 0.98560028 * d);
    const l = L + rad * (6.289 * sin(Mm) + 1.274 * sin(2 * D - Mm) + 0.658 * sin(2 * D) + 0.214 * sin(2 * Mm)
      - 0.186 * sin(Ms) - 0.114 * sin(2 * F));
    const b = rad * (5.128 * sin(F) + 0.280 * sin(Mm + F) + 0.277 * sin(Mm - F) + 0.173 * sin(2 * D - F));
    const dist = 385001 - 20905 * cos(Mm) - 3699 * cos(2 * D - Mm) - 2956 * cos(2 * D) - 570 * cos(2 * Mm);
    return { ra: rightAscension(l, b), dec: declination(l, b), dist };
  }

  function moonAltitude(date, lat = LAT, lng = LNG) {
    const lw = rad * -lng, phi = rad * lat, d = toDays(date), c = moonCoords(d);
    const h = altitude(siderealTime(d, lw) - c.ra, phi, c.dec);
    return h + refraction(h);
  }

  /** fraction: 0..1 lit. phase: 0 new, .25 first quarter, .5 full, .75 last quarter. */
  function moonIllumination(date) {
    const d = toDays(date), s = sunCoords(d), m = moonCoords(d), sdist = 149598000;
    const phi = acos(sin(s.dec) * sin(m.dec) + cos(s.dec) * cos(m.dec) * cos(s.ra - m.ra));
    const inc = atan(sdist * sin(phi), m.dist - sdist * cos(phi));
    const angle = atan(cos(s.dec) * sin(s.ra - m.ra), sin(s.dec) * cos(m.dec) - cos(s.dec) * sin(m.dec) * cos(s.ra - m.ra));
    return { fraction: (1 + cos(inc)) / 2, phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / PI, distance: m.dist };
  }

  /** Moonrise / moonset during the local calendar day containing `date`. */
  function moonTimes(date, lat = LAT, lng = LNG) {
    const t = new Date(date); t.setHours(0, 0, 0, 0);
    const later = (h) => new Date(t.valueOf() + h * 36e5);
    const hc = 0.133 * rad;
    let h0 = moonAltitude(t, lat, lng) - hc, rise, set;
    for (let i = 1; i <= 24; i += 2) {
      const h1 = moonAltitude(later(i), lat, lng) - hc, h2 = moonAltitude(later(i + 1), lat, lng) - hc;
      const a = (h0 + h2) / 2 - h1, b = (h2 - h0) / 2, xe = -b / (2 * a), ye = (a * xe + b) * xe + h1;
      const disc = b * b - 4 * a * h1;
      let roots = 0, x1 = 0, x2 = 0;
      if (disc >= 0) {
        const dx = sqrt(disc) / (abs(a) * 2);
        x1 = xe - dx; x2 = xe + dx;
        if (abs(x1) <= 1) roots++;
        if (abs(x2) <= 1) roots++;
        if (x1 < -1) x1 = x2;
      }
      if (roots === 1) { if (h0 < 0) rise = i + x1; else set = i + x1; }
      else if (roots === 2) { rise = i + (ye < 0 ? x2 : x1); set = i + (ye < 0 ? x1 : x2); }
      if (rise && set) break;
      h0 = h2;
    }
    return { rise: rise ? later(rise) : null, set: set ? later(set) : null };
  }

  const PHASES = [
    [0.0333, 'New moon', '🌑'], [0.2167, 'Waxing crescent', '🌒'], [0.2833, 'First quarter', '🌓'],
    [0.4667, 'Waxing gibbous', '🌔'], [0.5333, 'Full moon', '🌕'], [0.7167, 'Waning gibbous', '🌖'],
    [0.7833, 'Last quarter', '🌗'], [0.9667, 'Waning crescent', '🌘'], [1.01, 'New moon', '🌑'],
  ];
  function phaseName(phase) { const p = PHASES.find(([max]) => phase < max); return { name: p[1], emoji: p[2] }; }

  // Find the next time the moon's phase crosses `target` (0 = new, .5 = full, .25/.75 quarters).
  function nextPhase(target, from = new Date()) {
    const diff = (t) => { let x = moonIllumination(t).phase - target; if (x < -0.5) x += 1; if (x > 0.5) x -= 1; return x; };
    let a = new Date(from), da = diff(a);
    for (let i = 0; i < 31 * 4; i++) {
      const b = new Date(a.valueOf() + 6 * 36e5), db = diff(b);
      if (da < 0 && db >= 0) {
        let lo = a, hi = b;
        for (let k = 0; k < 20; k++) { const mid = new Date((lo.valueOf() + hi.valueOf()) / 2); if (diff(mid) < 0) lo = mid; else hi = mid; }
        return hi;
      }
      a = b; da = db;
    }
    return null;
  }

  const MOON_NAMES = ['Wolf', 'Snow', 'Worm', 'Pink', 'Flower', 'Strawberry', 'Buck', 'Sturgeon', 'Harvest', "Hunter's", 'Beaver', 'Cold'];

  // Annual meteor showers: peak month/day (approximate, varies by a day year to year) and typical rate.
  const SHOWERS = [
    { name: 'Quadrantids', m: 1, d: 4, zhr: 110 }, { name: 'Lyrids', m: 4, d: 22, zhr: 18 },
    { name: 'Eta Aquariids', m: 5, d: 6, zhr: 50, note: 'low in UK skies' }, { name: 'Perseids', m: 8, d: 12, zhr: 100 },
    { name: 'Draconids', m: 10, d: 8, zhr: 10 }, { name: 'Orionids', m: 10, d: 21, zhr: 20 },
    { name: 'Leonids', m: 11, d: 17, zhr: 15 }, { name: 'Geminids', m: 12, d: 14, zhr: 150 },
    { name: 'Ursids', m: 12, d: 22, zhr: 10 },
  ];

  // One-off events. Check timings closer to the date.
  const SPECIAL = [
    { date: '2027-08-02', icon: '🌘', title: 'Partial solar eclipse', detail: 'A small bite out of the Sun, late morning. Never look directly at the Sun.' },
    { date: '2028-12-31', icon: '🌒', title: 'Total lunar eclipse', detail: 'The Moon turns coppery red. Check timings nearer the date.' },
  ];

  // Equinoxes and solstices: when the Sun's ecliptic longitude crosses a multiple of 90 degrees.
  function seasons(from, to) {
    const out = [], names = ['March equinox', 'June solstice', 'September equinox', 'December solstice'];
    const icons = ['🌱', '☀️', '🍂', '❄️'];
    const quad = (t) => Math.floor(((sunLongitude(toDays(t)) % (2 * PI)) + 2 * PI) % (2 * PI) / (PI / 2));
    let a = new Date(from), qa = quad(a);
    while (a < to) {
      const b = new Date(a.valueOf() + dayMs), qb = quad(b);
      if (qb !== qa) {
        let lo = a, hi = b;  // bisect to the minute
        for (let k = 0; k < 12; k++) { const mid = new Date((lo.valueOf() + hi.valueOf()) / 2); if (quad(mid) === qa) lo = mid; else hi = mid; }
        const detail = qb === 1 ? 'Longest day of the year' : qb === 3 ? 'Shortest day, the days start getting longer' : 'Day and night roughly equal';
        out.push({ date: hi, icon: icons[qb], title: names[qb], detail, allDay: true });
      }
      a = b; qa = qb;
    }
    return out;
  }

  // UK clocks change on the last Sunday of March and October.
  function clockChanges(from, to) {
    const out = [];
    for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
      for (const [m, title, detail] of [[2, 'Clocks go forward', 'Lighter evenings from tonight'], [9, 'Clocks go back', 'An extra hour in bed']]) {
        const d = new Date(y, m + 1, 0); d.setDate(d.getDate() - d.getDay());
        if (d >= from && d <= to) out.push({ date: d, icon: '🕐', title, detail, allDay: true });
      }
    }
    return out;
  }

  const moonLabel = (f) => f < 0.25 ? 'dark skies' : f < 0.6 ? 'some moonlight' : 'bright moon';

  /** Upcoming sky events between now and `days` ahead, soonest first. */
  function upcomingEvents(days = 60, now = new Date()) {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    const to = new Date(from.valueOf() + days * dayMs);
    const events = [];

    // Full and new moons
    let t = from;
    while (true) {
      const full = nextPhase(0.5, t);
      if (!full || full > to) break;
      const dist = moonIllumination(full).distance;
      const supermoon = dist < 362000;
      events.push({ date: full, icon: '🌕', title: `${supermoon ? 'Supermoon: ' : ''}${MOON_NAMES[full.getMonth()]} Moon`,
        detail: `Full moon ${fmtTime(full)}${supermoon ? ', bigger and brighter than usual' : ''}`, supermoon });
      t = new Date(full.valueOf() + 5 * dayMs);
    }
    t = from;
    while (true) {
      const nm = nextPhase(0, t);
      if (!nm || nm > to) break;
      events.push({ date: nm, icon: '🌑', title: 'New moon', detail: 'Darkest skies of the month, best for stargazing' });
      t = new Date(nm.valueOf() + 5 * dayMs);
    }

    // Meteor showers
    for (let y = from.getFullYear(); y <= to.getFullYear(); y++) {
      for (const s of SHOWERS) {
        const peak = new Date(y, s.m - 1, s.d, 23, 0);
        if (peak < from || peak > to) continue;
        const f = moonIllumination(peak).fraction;
        events.push({ date: peak, icon: '🌠', title: `${s.name} peak`, shower: true, allDay: true, great: s.zhr >= 50 && f < 0.6,
          detail: `Up to ~${s.zhr}/hr under perfect skies${s.note ? ', ' + s.note : ''}. Moon ${round(f * 100)}% lit, ${moonLabel(f)}.` });
      }
    }

    for (const ev of SPECIAL) {
      const d = new Date(ev.date + 'T12:00:00');
      if (d >= from && d <= to) events.push({ ...ev, date: d, allDay: true });
    }
    events.push(...seasons(from, to), ...clockChanges(from, to));
    return events.sort((a, b) => a.date - b.date);
  }

  const fmtTime = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  return { LAT, LNG, sunTimes, sunAltitude, moonAltitude: (d) => moonAltitude(d) / rad, moonIllumination, moonTimes, phaseName, nextPhase, upcomingEvents };
})();
