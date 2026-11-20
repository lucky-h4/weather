#!/usr/bin/env python3
"""
Weather history for the IOM weather app (runs on node1 after each scrape).

1. Records the scrape in SQLite: airport observations, each forecast issue, warnings.
2. Builds history.json: the last 48 hours, the last 14 days (observed vs forecast) and records.
3. PATCHes weather.json and history.json to the gist in one request.

Usage:
  history.py WEATHER_JSON             # needs GIST_ID and GIST_TOKEN in the environment
  history.py WEATHER_JSON --dry-run   # record and print history.json, don't touch the gist
Env:
  HISTORY_DB  database path (default ~/.local/share/iom-weather/history.db)
Standard library only.
"""
import json
import os
import re
import sqlite3
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/London")
DB_PATH = os.environ.get("HISTORY_DB", os.path.expanduser("~/.local/share/iom-weather/history.db"))
HOURS = 48
DAYS = 14

SCHEMA = """
CREATE TABLE IF NOT EXISTS obs (
  ts TEXT PRIMARY KEY,          -- scrape time, UTC ISO
  temp REAL, conditions TEXT, wind_mph REAL, wind_dir TEXT
);
CREATE TABLE IF NOT EXISTS forecast (
  issued TEXT, date TEXT,        -- issued: local ISO from the Met Office; date: YYYY-MM-DD
  max REAL, min REAL, icon TEXT, wind_mph REAL, rain TEXT,
  PRIMARY KEY (issued, date)
);
CREATE TABLE IF NOT EXISTS warning (
  issued TEXT, level TEXT, heading TEXT, start TEXT, finish TEXT,
  PRIMARY KEY (issued, heading)
);
"""


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def local(ts_utc: str) -> datetime:
    return datetime.fromisoformat(ts_utc.replace("Z", "+00:00")).astimezone(TZ)


def record(db: sqlite3.Connection, w: dict) -> None:
    ts = w["fetchedAt"]
    cur = w.get("current") or {}
    m = re.match(r"\s*([\d.]+)\s*mph\s*(.*)", cur.get("wind") or "")
    db.execute(
        "INSERT OR IGNORE INTO obs VALUES (?,?,?,?,?)",
        (ts, num(cur.get("temp")), cur.get("conditions"),
         num(m.group(1)) if m else None, (m.group(2).strip() or None) if m else None),
    )
    for d in w.get("days", []):
        db.execute(
            "INSERT OR IGNORE INTO forecast VALUES (?,?,?,?,?,?,?)",
            (w.get("issuedOn"), d["date"], num(d.get("maxTemp")), num(d.get("minTemp")),
             d.get("icon"), num(d.get("windSpeed")), d.get("rainfall")),
        )
    for x in w.get("warnings", []):
        db.execute(
            "INSERT OR IGNORE INTO warning VALUES (?,?,?,?,?)",
            (x.get("issued") or ts, x.get("level"), x.get("heading"), x.get("from"), x.get("to")),
        )
    db.commit()


def summarise(db: sqlite3.Connection, now: datetime) -> dict:
    rows = [(local(ts), t, c, wm) for ts, t, c, wm in
            db.execute("SELECT ts, temp, conditions, wind_mph FROM obs ORDER BY ts")]
    temps = [(t, v) for t, v, _, _ in rows if v is not None]

    # Last 48 hours: every reading (so the chart's low/high match the records).
    # Consecutive identical temperatures are thinned, keeping the first and last of each run.
    cutoff = now - timedelta(hours=HOURS)
    recent = [(t, v) for t, v in temps if t >= cutoff]
    hours = [{"t": t.isoformat(timespec="seconds"), "temp": v} for i, (t, v) in enumerate(recent)
             if i in (0, len(recent) - 1) or not (recent[i - 1][1] == v == recent[i + 1][1])]

    # Last 14 days: observed range vs the forecast issued before noon that day.
    days = []
    first_day = (now - timedelta(days=DAYS - 1)).date()
    for i in range(DAYS):
        day = first_day + timedelta(days=i)
        obs = [(t, v) for t, v in temps if t.date() == day]
        if not obs:
            continue
        lo = min(obs, key=lambda o: o[1])
        hi = max(obs, key=lambda o: o[1])
        key = day.isoformat()
        fc = db.execute(
            "SELECT max, min, icon FROM forecast WHERE date = ? AND issued <= ? ORDER BY issued DESC LIMIT 1",
            (key, f"{key}T12:00:00"),
        ).fetchone() or db.execute(
            "SELECT max, min, icon FROM forecast WHERE date = ? ORDER BY issued LIMIT 1", (key,)
        ).fetchone()
        levels = sorted({lvl for (lvl,) in db.execute(
            "SELECT DISTINCT level FROM warning WHERE substr(start,1,10) <= ? AND substr(finish,1,10) >= ?",
            (key, key))})
        days.append({
            "date": key,
            "min": lo[1], "minAt": lo[0].strftime("%H:%M"),
            "max": hi[1], "maxAt": hi[0].strftime("%H:%M"),
            "forecastMax": fc[0] if fc else None, "forecastMin": fc[1] if fc else None,
            "icon": fc[2] if fc else None,
            "warnings": levels,
        })

    records = {}
    if temps:
        cold = min(temps, key=lambda o: o[1])
        warm = max(temps, key=lambda o: o[1])
        records["coldest"] = {"temp": cold[1], "at": cold[0].isoformat()}
        records["warmest"] = {"temp": warm[1], "at": warm[0].isoformat()}
    winds = [(t, wm) for t, _, _, wm in rows if wm is not None]
    if winds:
        windy = max(winds, key=lambda o: o[1])
        records["windiest"] = {"mph": windy[1], "at": windy[0].isoformat()}
    records["warningsIssued"] = db.execute("SELECT COUNT(*) FROM warning").fetchone()[0]

    return {
        "generatedAt": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "since": rows[0][0].isoformat() if rows else None,
        "observations": len(rows),
        "hours": hours,
        "days": days,
        "records": records,
    }


def patch_gist(files: dict) -> None:
    gist_id, token = os.environ["GIST_ID"], os.environ["GIST_TOKEN"]
    body = json.dumps({"files": {name: {"content": text} for name, text in files.items()}}).encode()
    req = urllib.request.Request(
        f"https://api.github.com/gists/{gist_id}", data=body, method="PATCH",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json",
                 "User-Agent": "iom-weather-history"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        r.read()


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    weather_path, dry = sys.argv[1], "--dry-run" in sys.argv
    with open(weather_path, encoding="utf-8") as f:
        weather_text = f.read()
    weather = json.loads(weather_text)

    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    record(db, weather)
    history = summarise(db, datetime.now(TZ))
    history_text = json.dumps(history, indent=1)

    if dry:
        print(history_text)
        return 0
    patch_gist({"weather.json": weather_text, "history.json": history_text})
    cur = weather.get("current") or {}
    print(f"Updated gist: issued {weather.get('issuedOn')}, {len(weather.get('warnings', []))} warning(s), "
          f"current {cur.get('temp')}C, history {history['observations']} obs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
