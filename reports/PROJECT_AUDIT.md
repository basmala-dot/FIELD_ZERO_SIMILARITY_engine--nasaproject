# FIELD//ZERO — Project Audit

**Audit date:** 2026-11-14 · **Package:** `FIELD_ZERO_SIMILARITY.zip` · **Companion file:** `reports/data_quality_summary.json`

## How to read this report
- **VERIFIED** = I computed or read it directly from a file in the ZIP.
- **REPORTED** = stated by a project report/log, but I could not re-check it because the underlying file is not in the ZIP.
- **ASSUMPTION** = inferred, external knowledge, or not checkable from the package.

No existing file was modified or deleted. No data was generated or imputed. Only the two files in `reports/` were added.

## 1. Executive summary

The processed terrain data is internally consistent and usable. The website layer, the climate layer and the documentation are not ready.

| Area | Status |
|---|---|
| Terrain CSVs (6 files) | **Good.** Complete regular grids, no duplicates, summaries match CSVs. |
| Terrain GeoJSON (6 files) | **Usable with caveats.** Valid Points, but decimated unevenly, no metadata, and Mars/Moon coordinates are not WGS84. |
| Earth climate (POWER) | **Partial.** 5 of 6 variables; `T2M` failed and is absent. One point, one year. |
| Mars / Moon climate | **None exist.** |
| `website/site_manifest.json` | **Broken.** 0 of 7 paths resolve. |
| README | **Contradicts the package** (says it contains no data). |
| Security | **A credential-like string is embedded in `reports/download_log.json`.** See §9. |

## 2. Package inventory (VERIFIED)

32 files. Data lives under `Data/processed/{Earth,Mars,Moon} files/` plus `Data/processed/comparison_120m.csv`.

| Group | Files |
|---|---|
| Terrain CSV | 6 (3 sites × 120 m and 360 m) |
| Terrain GeoJSON | 6 |
| Terrain summary JSON | 6 |
| POWER | `earth_western_desert_power_daily.csv`, `earth_western_desert_power_summary.json` |
| Comparison | `comparison_120m.csv` |
| Reports | 10 files (`status_*.md/json`, `processing_status.json`, `download_log.json`, `power_parameter_availability.json`) |
| Metadata | `sources.json`, `DATASET_INVENTORY.md` |
| Website | `site_manifest.json` only |

**Not in the ZIP:** `raw/`, all Python scripts, `config.py`, `requirements.txt`, `run_all.bat`, and the raw POWER JSON files. The pipeline cannot be re-run from this package, and raw-to-processed lineage cannot be re-derived.

## 3. CSV audit (VERIFIED)

All six terrain CSVs share 12 columns: `site, scale_m, x_m_localTM, y_m_localTM, lon_deg, lat_deg, elevation, slope_deg, aspect_deg, roughness_std, elev_variability_std, tri`.

| File | Rows | Grid (nx × ny) | Duplicates | Elevation range (m) | Slope range (°) |
|---|---:|---|---:|---|---|
| Earth 120 m | 68,944 | 248 × 278 | 0 | −2.43 … 290.48 | 0.003 … 25.50 |
| Earth 360 m | 7,896 | 84 × 94 | 0 | 4.88 … 288.00 | 0.007 … 10.06 |
| Mars 120 m | 96,369 | 353 × 273 | 0 | −2916.99 … −1518.25 | 0.002 … 39.45 |
| Mars 360 m | 10,856 | 118 × 92 | 0 | −2907.17 … −1536.44 | 0.013 … 27.60 |
| Moon 120 m | 29,535 | 179 × 165 | 0 | −2922.47 … −205.73 | 0.021 … 37.77 |
| Moon 360 m | 3,416 | 61 × 56 | 0 | −2900.15 … −211.96 | 0.054 … 29.74 |

- Every grid is complete (rows = nx × ny) with constant spacing of exactly 120 m or 360 m. No `inf` values. Slope stays within 0–90° and aspect within 0–360°.
- **Elevation has no missing values in any file.**
- **Missing values** are only in the derived metrics and sit exactly on the kernel border. For Earth 120 m: 1,048 NaN in `slope_deg`, `aspect_deg`, `roughness_std` and `tri` (equal to the 2·nx + 2·(ny−2) border cells), and 2,088 NaN in `elev_variability_std` (two-cell border for the 5×5 window). The same pattern holds in all six files. This is expected, not data loss.
- **CSV values are rounded to 4 decimals.** This explains tiny relative differences against the summaries on very small minima (e.g. slope min 0.0029 vs 0.002923).
- **Units are not in the CSV headers.** Metres and degrees appear only in summaries and the README.
- **Aspect is populated on near-flat cells** (slope < 0.1°): 696 cells for Earth, 353 for Mars, 12 for Moon. Aspect is physically meaningless there.

## 4. GeoJSON audit (VERIFIED)

- All six are `FeatureCollection`s of **Point** geometries with 2-element `[lon, lat]` coordinates. No `crs` member.
- Properties are the same six keys in every feature: `elevation, slope_deg, aspect_deg, roughness_std, elev_variability_std, tri`. Missing values are JSON `null`.
- Every feature matches a CSV cell with zero elevation difference. They are decimated copies, not averaged.
- **Decimation is inconsistent:**

| File | Features | Share of CSV cells |
|---|---:|---:|
| Earth 120 m | 2,800 | 4.1 % |
| Earth 360 m | 1,974 | 25.0 % |
| Mars 120 m | 3,905 | 4.1 % |
| Mars 360 m | 2,714 | 25.0 % |
| Moon 120 m | 3,300 | 11.2 % |
| Moon 360 m | 3,416 | 100 % |

- Aggregates from the GeoJSON therefore differ from the summaries. Example: Earth 120 m GeoJSON mean elevation is 55.58 m vs 54.70 m in the CSV and summary.
- Features carry no `site`, `scale_m`, `body` or units.
- **Coordinate-system problem.** RFC 7946 makes GeoJSON WGS84 by definition. That is correct for Earth (source EPSG:4326). For Mars (77.2–77.95°E, 18.1–18.65°N) and the Moon (30.4–31.16°E, 19.85–20.5°N), the lon/lat come from sphere-based CRSs (`GCS_Mars_2000_Sphere`, Moon sphere R = 1737.4 km). Placed on an Earth basemap, the Mars points land in India. Treating them as WGS84 is incorrect.

## 5. Summary JSON vs CSV (VERIFIED)

For all six terrain summaries I compared `n, min, max, mean, std` for `elevation, slope_deg, roughness_std, elev_variability_std, tri` against the CSVs.

- `n`, `grid.cells`, `grid.valid_cells` and `grid.csv_rows` match exactly.
- Mean, std, min and max match within CSV rounding. Std is population (ddof = 0) in the summary; pandas default is ddof = 1. Differences are negligible at these n.
- Summaries have **no entry for `aspect_deg`**.
- `provenance.source_file` values are Windows paths (`raw\earth\…`) to files that are not in the package.

## 6. `comparison_120m.csv` (VERIFIED)

Three rows (one per body), 12 columns. Every value equals the matching 120 m summary to 4 decimals.

| Body | Mean slope (°) | Mean roughness (m) | Mean TRI | Mean elev. variability (m) |
|---|---:|---:|---:|---:|
| Earth | 1.64 | 3.12 | 11.18 | 4.31 |
| Mars | 3.52 | 6.27 | 19.96 | 10.16 |
| Moon | 10.42 | 18.62 | 56.31 | 31.87 |

Limitations:
- Only 120 m. No 360 m rows, so scale sensitivity is not shown.
- Only mean and std of right-skewed variables. No medians or percentiles, and no elevation or aspect rows.
- **No similarity metric of any kind exists in the package**, despite the project name. The file is a descriptive side-by-side, not a similarity result.
- No climate variables.

## 7. Climate variables

### What exists (VERIFIED)
`earth_western_desert_power_daily.csv`: 365 rows, 2023-01-01 to 2023-12-31, contiguous, no duplicates, no nulls, no −999 fill values, `T2M_MAX ≥ T2M_MIN` on every day.

| Variable | Units (as logged) | Range |
|---|---|---|
| `T2M_MAX` | °C | 14.50 … 43.08 |
| `T2M_MIN` | °C | 2.39 … 27.84 |
| `ALLSKY_SFC_SW_DWN` | MJ/m²/day | 9.64 … 30.74 |
| `WS2M` | m/s | 0.70 … 5.81 |
| `PS` | kPa | 98.64 … 100.78 |

### What is missing
- **`T2M` (mean air temperature)** is absent. `status_earth.md` says FAILED (`KeyError('T2M')`) and `processing_status.json` says "5/6 variables". `download_log.json` says the download succeeded, so the failure is in what was on disk (see §8).
- **Mars:** every atmospheric variable (temperature, pressure, wind, solar, humidity). MEDA is researched in `DATASET_INVENTORY.md` but has no code and no data.
- **Moon:** no temperature (Diviner not implemented), and no pressure or wind (no atmosphere). Solar flux has no verified dataset.
- **Earth, further gaps:** humidity, precipitation, hourly/diurnal data, multi-year climatology, and land-cover/soil layers.
- **Cross-body:** there is no common climate variable set. Only Earth has any. A climate-based similarity comparison is not possible with the current data.

### Structural limits (VERIFIED)
- POWER is one point (lon 28.15, lat 27.3) for a ~30 × 33 km site, so the climate value cannot vary per terrain cell.
- Reanalysis/satellite-derived model output, not station data.
- Date is stored as integer `YYYYMMDD`.

## 8. Metadata and processing reports

**Consistent (VERIFIED):** `processing_status.json` row counts equal the CSVs (68,944 / 7,896 / 96,369 / 10,856 / 29,535 / 3,416). The `status_*.md/json` "VALIDATED" claims agree with the summaries.

**REPORTED (cannot re-check, raw files absent):**

| Body | Raw dataset | Raster | Native pixel | Valid pixels | Elevation range |
|---|---|---|---|---|---|
| Earth | NASADEM tile n27e028 cropped | 1080 × 1080, EPSG:4326 | 27.5 × 30.9 m | 100 % | −33.0 … 293.0 m |
| Mars | CTX DEM 20 m | 4456 × 5067, projected | 20 × 20 m | 99.94 % | −3504.6 … −475.8 m |
| Moon | LOLA window | 196 × 170, simple cylindrical | 118.45 m | 100 % | −2925.0 … −205.5 m (after ×0.5) |

Mars size matches the server Content-Length (90,345,300 B). The Moon server supported byte ranges and the 0.5 scale is recorded as applied once.

**Problems found:**
1. **T2M record is inconsistent.** `download_log.json` logs T2M at 6,628 B with sha256 `998cda6a…`. `status_earth.md` reports the T2M file on disk with sha256 `f82cf7f6…`, which is the logged hash of the **T2M_MIN** file, and also prints "PASS: sha256 equals download log". Either the file was overwritten with T2M_MIN content, or the validator compared the wrong file or log entry. Both explain the `KeyError`. I cannot tell which without the raw file.
2. **Earth raw minimum (−33.0 m) vs processed minimum (−2.43 m).** Only two 120 m cells are below 0 m (near 28.17°E, 27.30°N). A 30 m pit averaged to 120 m can lose depth, but it could also be a NASADEM artefact. Unresolved without the raw tile.
3. **Stale status text.** `status_*.md` still say the downloaders are "written; not yet run against the real API/USGS", while the same files and the download log show they ran. The README says `raw/` and `processed/` are empty and the ZIP contains no data. Both are false for this package.
4. **Repeated NASADEM auth failures** (9 logged failed attempts: 8 login rejections and 1 encoding error) before success at 15:07 UTC. Resolved, but see §9.
5. `status_index.md` shows "1 of 2" Earth datasets validated, so Earth is not fully validated.
6. `sources.json` still says "code_status: written, not run" for all four datasets.
7. Hard-coded Windows paths (`D:\Nasa Apps Kafer 2026\…`) appear throughout the logs.

## 9. Security finding

`reports/download_log.json`, the entry timestamped `2026-11-14T14:51:36`, contains a `UnicodeEncodeError` message that echoes what appears to be an Earthdata account password (the error message includes the offending string). I have not reproduced it here. If that is a real password: **change it, remove the entry before sharing or committing the repository, and check that the project does not publish `reports/` to the website or GitHub.** The README claims credentials are "never typed into any file by this project", which this log contradicts.

## 10. Website manifest (VERIFIED)

`website/site_manifest.json` lists 7 paths (3 GeoJSON, 3 summaries, 1 climate summary).

- **0 of 7 resolve.** Paths are `processed/<file>`. I tested them relative to `website/`, the project root and `Data/`. The real location is `Data/processed/<Earth|Mars|Moon> files/<file>`. Folder names contain spaces and a capital `D`/capitalised names, which break on case-sensitive hosts (Linux, GitHub Pages).
- Lists **only 120 m** layers. All 360 m GeoJSON and summaries, all CSVs, `power_daily.csv` and `comparison_120m.csv` are unreferenced (14 data files).
- Has **no** bounds, CRS, units, body, resolution, or feature counts. A front end could not place Mars/Moon layers correctly from the manifest alone.
- The note says "Lists only layers whose raw source validated". Earth is listed with `climate`, but its POWER dataset is only PARTIAL.

## 11. Scientific limitations

1. **Resolution mismatch (VERIFIED).** Native pixel sizes are Earth ~30 m (27.5 × 30.9 m), Mars 20 m, Moon 118 m. All are placed on 120 m and 360 m grids by area averaging. Earth is averaged ~4× (120 m), Mars ~6×, Moon ~1×, so terrain smoothness differs by body before any physical difference. Roughness and TRI are especially sensitive to this.
2. **Scale dependence (VERIFIED).** Mean slope falls from 120 m to 360 m (Earth 1.64→0.86°, Mars 3.52→2.86°, Moon 10.42→9.97°). Roughness and variability use windows of 360/600 m at 120 m scale but 1080/1800 m at 360 m scale, so they rise (Moon roughness 18.6→53.8 m). **These are different quantities; do not compare across scales.**
3. **Coordinate systems (VERIFIED).** Earth is WGS84 lon/lat. Mars and Moon are sphere-based planetocentric. Each grid is a local transverse Mercator in metres, which is appropriate for slope math, but it is a different origin for every site and is not stated in the CSV.
4. **Vertical references differ (REPORTED).** Earth (datum not recorded in the package), Mars (MOLA-localised per USGS catalog), Moon (sphere R = 1737.4 km). Absolute elevations are not comparable; only relief metrics are.
5. **Moon effective resolution (ASSUMPTION).** LOLA LDEM 118 m is a gridded product. Its true information content may be coarser than the nominal pixel. Not testable here.
6. **Site selection (ASSUMPTION).** The package does not document why these three sites (Western Desert box, Jezero, Taurus-Littrow) or box sizes were chosen. The Mars box (~42 × 33 km) is narrower than the commonly cited Jezero crater diameter (~45 km, external knowledge), so the crater may be clipped.
7. **Climate comparability.** No common variables across bodies, one year for Earth, a single point.
8. **Modelled data.** POWER is model/satellite-derived. It is not an in-situ measurement.

## 12. Verified facts vs assumptions

| Statement | Basis |
|---|---|
| Terrain CSV row counts, columns, grid completeness, NaN pattern | **VERIFIED** |
| Summary JSON n/min/max/mean/std match CSV | **VERIFIED** |
| `comparison_120m.csv` equals the 120 m summaries | **VERIFIED** |
| GeoJSON geometry types, property keys, and match to CSV cells | **VERIFIED** |
| GeoJSON decimation ratios differ by file | **VERIFIED** |
| 0 of 7 manifest paths resolve | **VERIFIED** |
| POWER daily CSV has 365 clean rows and 5 variables, no T2M | **VERIFIED** |
| README claim "ZIP contains code, not data" | **VERIFIED FALSE** |
| Mars/Moon GeoJSON coordinates are not WGS84 | **VERIFIED** (CRS in status JSON) |
| Raw raster properties (size, CRS, valid pixels, raw min/max) | **REPORTED** |
| Mars file size equals server Content-Length | **REPORTED** |
| NASADEM/CTX/LOLA/POWER provenance and URLs | **REPORTED** (`download_log.json`) |
| Why T2M failed | **ASSUMPTION** (two candidate causes, §8) |
| Earth −33 m raw minimum is real | **ASSUMPTION** (unchecked) |
| Earth vertical datum is orthometric/EGM96 | **ASSUMPTION** (inventory notes it as secondary-source) |
| POWER grid cell is ~0.5° | **ASSUMPTION** (inventory cites official page; not in files) |
| Jezero crater is ~45 km wide | **ASSUMPTION** (external knowledge) |

## 13. Required fixes before website development

**Blockers**
1. **Rotate the Earthdata password and scrub `download_log.json`** (§9).
2. **Fix `site_manifest.json`:** correct paths (or move data to `website/data/` with lowercase, space-free names such as `data/earth/…`), and add the 360 m layers.
3. **Add per-layer metadata to the manifest:** body, site, scale_m, bounds, CRS, units, feature count, native resolution, and a flag that Mars/Moon lon/lat are not WGS84.
4. **Decide how Mars and Moon are displayed.** Do not use an Earth basemap. Render them in the local metre grid (`x_m_localTM`, `y_m_localTM`), or a planetary tile source or plain canvas, and label the coordinate system.
5. **Resolve the T2M gap:** inspect the raw `earth_western_desert_T2M_AG.json`, re-download T2M if needed, regenerate `power_daily.csv` and the summary, and fix the validator's hash/log matching.

**High priority**
6. **Standardise GeoJSON:** use the same sampling for all files (or ship full-resolution data in a more efficient format), and add `site`, `scale_m`, `body`, and units to properties or the collection.
7. **Add units to CSV headers or a data dictionary** (`elevation_m`, `slope_deg`, etc.).
8. **Include `aspect_deg` in summaries**, and set aspect to NaN where slope is below a threshold.
9. **Correct the README and `status_*.md`/`sources.json`** to reflect what has actually run, and include the missing scripts/`config.py`/`requirements.txt` or the raw files so results are reproducible.
10. **Investigate the Earth −33 m raw minimum** against the raw NASADEM tile.

**Before making any similarity claims**
11. Compute an actual similarity method (e.g. distributions, percentiles, or a defined distance) rather than only comparing means.
12. Add `comparison_360m.csv`, and compare only quantities measured over the same window in metres.
13. Document the site and bbox choices; consider widening the Mars box.
14. Add climate for Mars (MEDA) and Moon (Diviner) if climate similarity is a project goal, or state clearly in the site that climate comparison is Earth-only for now.
15. Strip the Windows `D:\…` paths from shipped reports.
