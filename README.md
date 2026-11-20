# weather.luckins.im

A small PWA showing today's Isle of Man weather from the Ronaldsway Met Office
(weather.gov.im): today's forecast, when it was issued, sunrise and sunset, current
conditions at the airport, and any weather warnings.

On top of the Met Office data, the app adds:

- **Sun:** a live countdown to sunrise or sunset, a sun-position arc, golden hour,
  when it gets dark, and how much day length changes tomorrow.
- **Moon:** the current phase (drawn to match), percentage lit, moonrise and
  moonset, and the next full and new moon. Calculated on the device in
  `docs/astro.js`.
- **Aurora:** live status from AuroraWatch UK, plus NOAA's Kp forecast for the
  next 24 hours. The phone fetches both directly, since they allow browser
  requests.
- **Sky calendar:** meteor shower peaks (with how bright the moon will be),
  full moons and supermoons, new moons, equinoxes, solstices, clock changes
  and eclipses. One-off events like eclipses are listed in `SPECIAL` in
  `astro.js`.
- **Sky background:** shifts between night, dawn, day and dusk using the real
  sun position, dims for overcast days, and glows green at night when an
  aurora is possible.

## How it works

```
GitHub Action (every 30 min)              GitHub Pages (docs/)
  scripts/scrape.ps1                        index.html + app.js (PWA)
   ├─ GET /_api/listings/5-day-weather-forecast   (JSON feed)    │
   ├─ GET /  (homepage: current conditions + warnings)           │
   └─ PATCH gist → weather.json ───────────────► GET api.github.com/gists/<id>
```

weather.gov.im has no CORS headers, so a browser can't fetch it directly. The
Action does the scraping on GitHub's servers and writes the result to a gist.
GitHub's API does allow CORS, so the PWA reads the gist from your phone.

- The **gist token** only lives in a repository secret and on the home server.
  It never goes in the code or on your phone.

### Home server (main scraper) and weather history

A home Ubuntu server (node1) is the main scraper. The GitHub Action is now an
hourly backup.

- **Every 15 minutes** cron runs `~/weather-scrape.sh`. It pulls this repo, runs
  `scrape.ps1` to a local file, then runs `scripts/history.py`. That script
  records the reading in SQLite (`~/.local/share/iom-weather/history.db`) and
  updates the gist's `weather.json` and `history.json` in a single request. If
  the history step fails, the wrapper falls back to publishing the weather on
  its own.
- **Secrets** live in `~/.config/iom-weather/env` (chmod 600).
- **The log** is `~/.local/state/iom-weather.log`, trimmed nightly.
- **`history.json`** holds the last 48 hours of readings, 14 days of observed vs
  forecast, and records (coldest, warmest, windiest). The app shows it as the
  "Last 24 hours" card.
- **`history.py`** uses only the Python standard library. Use `--dry-run` to
  print the summary without touching the gist.
- The **phone** only needs the gist ID. It's stored in `localStorage` on first
  launch. The app reads the files from `gist.githubusercontent.com/raw/<id>/…`,
  which has no rate limit and is cached by GitHub for up to 5 minutes. The API,
  by contrast, allows 60 requests an hour, shared by everything on your
  connection. The optional token field switches back to the API.

## Setup

1. **Create the gist.** At https://gist.github.com, create a *secret* gist with
   one file called `weather.json` containing `{}`. Copy its ID: the long hex
   string in the URL.
2. **Create a token.** Create a fine-grained personal access token with
   *Account permissions → Gists: Read and write*. A classic token with the
   `gist` scope also works.
3. **Create the repo.** Push this folder to a new GitHub repo. Then go to
   *Settings → Secrets and variables → Actions* and add two secrets:
   - `GIST_ID`: the gist ID
   - `GIST_TOKEN`: the token
4. **Run the Action once.** Go to *Actions → Scrape weather.gov.im → Run
   workflow* and check that it goes green. After that it runs on its own every
   30 minutes.
5. **Turn on GitHub Pages.** Go to *Settings → Pages → Deploy from a branch*,
   choose `main` and `/docs`, and set the custom domain to `weather.luckins.im`
   (`docs/CNAME` already contains it). Tick *Enforce HTTPS* once it's available.
6. **Add DNS.** Add a `CNAME` record: `weather` → `<your-github-username>.github.io`.
7. **Set up your phone.** Open `https://weather.luckins.im/#gist=<GIST_ID>` once
   in Chrome. The ID is saved and removed from the URL. Then use *⋮ → Add to
   Home screen / Install app*. You can also enter the ID with the ⚙ button.

## Local testing

```powershell
pwsh ./scripts/scrape.ps1 -OutFile docs/sample-weather.json   # scrape to a file
pwsh ./scripts/serve.ps1                                       # http://localhost:8080/#demo
```

`#demo` loads `docs/sample-weather.json` instead of the gist.

## Notes

- If you use a private repo, the Action uses about 1,500 of your 2,000 free
  Actions minutes per month. Use a public repo, or change the cron in
  `.github/workflows/scrape.yml` to run hourly.
- weather.gov.im sits behind a WAF that rejects non-browser user agents, so the
  scraper sends a browser user agent. If the Action starts failing with "WAF
  rejected request", the site has started blocking GitHub's IP addresses.
- When the site changes its markup, the homepage parts (current conditions and
  warnings) are the bits most likely to break. They're regexes on class names
  in `scripts/scrape.ps1`.
