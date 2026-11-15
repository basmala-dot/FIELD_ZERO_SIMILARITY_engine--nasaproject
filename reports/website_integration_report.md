# FIELD//ZERO website integration report

## Architecture (one data interface)
`data-loader.js` (unchanged) loads `site_manifest.json` and the datasets -> `similarity-engine.js` (unchanged) `analyzeLoaded()` scores all Earth cells in the browser (about 2 s) -> `app.js` publishes `window.FZ = {data, analysis, rows, portfolio, gaps}` -> `map.js` (FZMap), `charts.js` (FZCharts) and `mission-intelligence.js` (FieldZeroIntel) read only from it. The 33 MB similarity GeoJSON files in `outputs/` are not fetched by the site; the engine's output is reproduced live (verified equal to `top_candidates.json`: top Mars score 98.72).

## Files
Created: `website/index.html`, `website/style.css`, `website/js/{map,charts,mission-intelligence,app}.js`, `outputs/mission_portfolio.json`, `outputs/evidence_gaps.json`, `scripts/run_intelligence.js`, `scripts/smoke_test_dom.js`, three reports.
Modified: none. Original datasets, loader, engine and manifest are untouched.

## Run
Open the **project root** (the folder containing `Data/` and `website/`) as the VS Code workspace, right-click `website/index.html`, Open with Live Server. Needs internet for Leaflet, Chart.js, fonts and OSM tiles (CDN). Alternative: `python -m http.server 8000` in the project root, then open `http://localhost:8000/website/`. Do not open the file by double-click.

## Coordinate systems
Earth: WGS84 lon/lat on EPSG:3857 tiles. Mars and Moon: `L.CRS.Simple`, metres from each site's centre, computed from the body-native lon/lat in the GeoJSON with an equirectangular projection (R = 3396.19 km Mars, 1737.4 km Moon). No basemap tiles exist for these two. Mars/Moon are references, so they have terrain layers but no similarity layer.

## Tests actually run (all in this build environment)
`node scripts/run_intelligence.js` (real data): 13 checks passed: engine output matches stored top candidate; portfolios reproducible; 5 sites; min separation 5.76 km (Mars) and 3.55 km (Moon) >= 2 km; scores and coordinates equal engine/CSV values; T2M detected as absent; no gap claims source access.
`node scripts/smoke_test_dom.js` (jsdom 31 + real Leaflet 1.9.4 and Chart.js 4.4.1 + node-canvas, served locally): 38 checks passed: all chapters populate; 8 charts drawn; chart values equal source data (A, D) and histograms sum to 100 % (B, E1); E2 contributions sum to candidate scores; Earth map 7544 cells on EPSG:3857; Mars 3780 and Moon 3186 cells on CRS.Simple without tile layers; every layer option; body switching; candidate selection, show-on-map, pin/compare; portfolio sliders, target, map markers; export buttons; no console errors other than blocked tile requests (sandbox has no internet), which triggered the missing-tile notice.

## Not tested
A real browser (no layout, pixel, CSS-breakpoint or visual check; responsive design is written but unverified), real OSM tile loading, Google Fonts rendering, file downloads actually saving, print/PDF output, accessibility audit, performance on low-end devices.

## Known limitations
- PapaParse is not used: the existing loader already parses CSV, and a second parser would duplicate it.
- Earth map shows every 3rd cell (7544 of 68,944) for speed; Mars/Moon use the project's decimated GeoJSON.
- Distribution charts use the decimated GeoJSON samples.
- Page load reads about 8 MB of CSV and scores on the main thread (about 2 s).
- Visual identity delivered: palette, type, contour backdrop, orbit hero, loading animation, chapter rail. Planetary illustrations and hand-drawn details are minimal (one hero SVG); page transitions are smooth scrolling only.
- Portfolio search is limited to the top-3000 scored cells.
