<#
.SYNOPSIS
  Scrapes weather.gov.im and produces a tidy weather.json.

.DESCRIPTION
  - 5 day forecast comes from the JSON feed the site's own widget uses:
      https://weather.gov.im/_api/listings/5-day-weather-forecast
  - Current conditions and weather warnings are scraped from the homepage HTML.

  If GIST_ID and GIST_TOKEN environment variables are set, the result is
  written to weather.json in that gist. Otherwise it is written to -OutFile.

.EXAMPLE
  pwsh ./scripts/scrape.ps1 -OutFile ./weather.json
#>
param(
  [string]$OutFile = "weather.json",
  [string]$HomeHtmlFile,   # optional: parse a saved homepage instead of fetching (testing)
  [string]$FeedJsonFile    # optional: parse a saved feed instead of fetching (testing)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Base = 'https://weather.gov.im'
# The site sits behind a WAF that rejects non-browser user agents.
$Headers = @{
  'User-Agent'      = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
  'Accept-Language' = 'en-GB,en;q=0.9'
}

function Get-Remote([string]$Url, [string]$Accept) {
  $h = $Headers.Clone(); $h['Accept'] = $Accept
  for ($i = 1; $i -le 3; $i++) {
    try {
      $r = Invoke-WebRequest -Uri $Url -Headers $h -TimeoutSec 30
      $body = $r.Content
      if ($body -is [byte[]]) { $body = [Text.Encoding]::UTF8.GetString($body) }
      if ($body -match 'Request Rejected') { throw "WAF rejected request to $Url" }
      return $body
    } catch {
      if ($i -eq 3) { throw }
      Write-Warning "Attempt $i for $Url failed: $($_.Exception.Message). Retrying..."
      Start-Sleep -Seconds (5 * $i)
    }
  }
}

function ConvertFrom-Html([string]$Html) {
  if (-not $Html) { return '' }
  $t = $Html -replace '(?i)<br\s*/?>', ' ' -replace '<[^>]+>', ''
  $t = [System.Net.WebUtility]::HtmlDecode($t)
  return ($t -replace '[\s ]+', ' ').Trim()
}

function Get-Paragraphs([string]$Html) {
  [regex]::Matches($Html, '(?is)<p[^>]*>(.*?)</p>') |
    ForEach-Object { ConvertFrom-Html $_.Groups[1].Value } |
    Where-Object { $_ }
}

function Get-Match([string]$Text, [string]$Pattern) {
  $m = [regex]::Match($Text, $Pattern, 'IgnoreCase, Singleline')
  if ($m.Success) { return (ConvertFrom-Html $m.Groups[1].Value) } else { return $null }
}

# ---------- Fetch ----------
$feedRaw = if ($FeedJsonFile) { Get-Content -Raw $FeedJsonFile } else { Get-Remote "$Base/_api/listings/5-day-weather-forecast" 'application/json' }
$homeHtml = if ($HomeHtmlFile) { Get-Content -Raw -Encoding utf8 $HomeHtmlFile } else { Get-Remote "$Base/" 'text/html,application/xhtml+xml' }

$feed = $feedRaw | ConvertFrom-Json
if (-not $feed.forecasts -or $feed.forecasts.Count -eq 0) { throw 'Forecast feed returned no forecasts' }

# ---------- Forecast days ----------
$days = foreach ($f in $feed.forecasts) {
  # "19-11-2026 00:00:00" -> "2026-11-19"
  $d = [datetime]::ParseExact($f.forecastDate.Substring(0, 10), 'dd-MM-yyyy', $null)
  $paras = @(Get-Paragraphs $f.forecastContent)
  [ordered]@{
    date          = $d.ToString('yyyy-MM-dd')
    icon          = $f.icon
    maxTemp       = $f.maxTemp
    minTemp       = $f.minTemp
    windDirection = $f.windDirection
    windSpeed     = $f.windSpeed
    windComments  = $f.windComments
    visibility    = $f.visibility
    rainfall      = $f.averageRainfall
    rainComments  = $f.rainfallComments
    forecast      = $paras
    warning       = $f.warnings
    sunrise       = $f.sunTimes.sunrise
    sunset        = $f.sunTimes.sunset
  }
}
$first = $feed.forecasts[0]
# "2026-11-19 11:30:00" -> "2026-11-19T11:30:00" (Isle of Man local time)
$issuedOn = ($first.issuedOn -replace ' ', 'T')

# ---------- Current conditions (homepage) ----------
$current = $null
$cw = [regex]::Match($homeHtml, '(?is)<section class="current-weather".*?</section>')
if ($cw.Success) {
  $s = $cw.Value
  $current = [ordered]@{
    location   = Get-Match $s 'current-weather__location">(.*?)</h2>'
    temp       = Get-Match $s 'current-weather__item--temperature.*?class="sr-only">\s*is\s*(-?\d+(?:\.\d+)?)'
    conditions = Get-Match $s 'Current weather conditions are:</span>\s*<span>(.*?)</span>'
    wind       = Get-Match $s 'Wind speed and direction:</span>\s*<span>(.*?)</span>'
  }
}

# ---------- Warnings (homepage) ----------
$warnings = @(
  foreach ($m in [regex]::Matches($homeHtml, '(?is)<section class="weather-alert weather-alert--(\w+)".*?</section>')) {
    $s = $m.Value
    $main = [regex]::Match($s, '(?is)weather-alert__content-main">(.*?)(?:<dl>|</div>)').Groups[1].Value
    [ordered]@{
      level      = $m.Groups[1].Value.ToLower()
      heading    = Get-Match $s 'weather-alert__introduction">(.*?)</span>'
      dates      = Get-Match $s 'weather-alert__introduction-dates">(.*?)</span>'
      details    = @(Get-Paragraphs $main)
      areas      = Get-Match $s '<dt>\s*Areas likely to be affected\s*</dt>\s*<dd>(.*?)</dd>'
      forecaster = Get-Match $s '<dt>\s*Forecaster\s*</dt>\s*<dd>(.*?)</dd>'
      issued     = Get-Match $s '<dt>\s*Issued\s*</dt>\s*<dd>\s*<time datetime="([^"]+)"'
      from       = Get-Match $s '<dt>\s*From\s*</dt>\s*<dd>\s*<time datetime="([^"]+)"'
      to         = Get-Match $s '<dt>\s*To\s*</dt>\s*<dd>\s*<time datetime="([^"]+)"'
    }
  }
)

$result = [ordered]@{
  fetchedAt  = [datetime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
  issuedOn   = $issuedOn
  forecaster = $first.forecasterName
  source     = $Base
  current    = $current
  warnings   = $warnings
  days       = @($days)
}
$json = $result | ConvertTo-Json -Depth 10

# ---------- Output ----------
if ($env:GIST_ID -and $env:GIST_TOKEN) {
  $body = @{ files = @{ 'weather.json' = @{ content = $json } } } | ConvertTo-Json -Depth 5
  Invoke-RestMethod -Method Patch -Uri "https://api.github.com/gists/$($env:GIST_ID)" -Body $body `
    -ContentType 'application/json' -Headers @{
      Authorization          = "Bearer $($env:GIST_TOKEN)"
      Accept                 = 'application/vnd.github+json'
      'X-GitHub-Api-Version' = '2022-11-28'
    } | Out-Null
  Write-Host "Updated gist $($env:GIST_ID): issued $issuedOn, $($warnings.Count) warning(s), current $($current.temp)C"
} else {
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutFile, (Get-Location).Path), $json)
  Write-Host "Wrote $OutFile"
}
