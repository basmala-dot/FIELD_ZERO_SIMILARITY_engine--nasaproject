# FIELD//ZERO - Website Data Mapping

Generated 2026-11-14 from `website/site_manifest.json` (schema_version 2). Every dataset below was loaded through `website/js/data-loader.js` and passed (section 6). The scientific datasets under `Data/processed/` were not renamed, moved or modified.

## 1. How paths work

- Every `path` in the manifest is **relative to the manifest file** (`website/site_manifest.json`), so the data folder is reached as `../Data/processed/...`.
- Folder names contain spaces. Paths are stored **URL-encoded** (`Earth%20files`) and resolved with `new URL(path, manifestUrl)`. The manifest validator rejects raw spaces.
- The data sits next to `website/`, not inside it, so **the web server root must be the project root** (the folder containing `Data/` and `website/`):
  ```
  cd FIELD_ZERO_SIMILARITY
  python -m http.server 8000      # then open http://localhost:8000/website/
  ```
- Opening an HTML file by double-click (`file://`) will not work, because browsers block `fetch()` there. The loader detects this and says so.
- Use `<script src="js/data-loader.js"></script>` (adjust the relative prefix). The loader finds the manifest from its own script location, so pages in any website folder work.

## 2. Dataset ID to file map

`Manifest path` is exactly what is stored in `site_manifest.json`. `Disk path` is the decoded path from the project root. Load mode `auto` = loaded by `loadAll()`; `on_demand` = large file, loaded only on request (`load(id)` or `loadAll({mode:'all'})`).

| Dataset ID | Kind | Fmt | Load | Manifest path (relative to `website/`) | Disk path (from project root) | Contents |
|---|---|---|---|---|---|---|
| `earth_120m_geojson` | terrain_geojson | geojson | auto | `../Data/processed/Earth%20files/earth_western_desert_120m_terrain.geojson` | `Data/processed/Earth files/earth_western_desert_120m_terrain.geojson` | 2,800 features |
| `earth_120m_summary` | terrain_summary | json | auto | `../Data/processed/Earth%20files/earth_western_desert_120m_terrain_summary.json` | `Data/processed/Earth files/earth_western_desert_120m_terrain_summary.json` | required keys |
| `earth_120m_terrain_csv` | terrain_csv | csv | on_demand | `../Data/processed/Earth%20files/earth_western_desert_120m_terrain.csv` | `Data/processed/Earth files/earth_western_desert_120m_terrain.csv` | 68,944 rows |
| `earth_360m_geojson` | terrain_geojson | geojson | auto | `../Data/processed/Earth%20files/earth_western_desert_360m_terrain.geojson` | `Data/processed/Earth files/earth_western_desert_360m_terrain.geojson` | 1,974 features |
| `earth_360m_summary` | terrain_summary | json | auto | `../Data/processed/Earth%20files/earth_western_desert_360m_terrain_summary.json` | `Data/processed/Earth files/earth_western_desert_360m_terrain_summary.json` | required keys |
| `earth_360m_terrain_csv` | terrain_csv | csv | on_demand | `../Data/processed/Earth%20files/earth_western_desert_360m_terrain.csv` | `Data/processed/Earth files/earth_western_desert_360m_terrain.csv` | 7,896 rows |
| `mars_120m_geojson` | terrain_geojson | geojson | auto | `../Data/processed/Mars%20files/mars_jezero_120m_terrain.geojson` | `Data/processed/Mars files/mars_jezero_120m_terrain.geojson` | 3,905 features |
| `mars_120m_summary` | terrain_summary | json | auto | `../Data/processed/Mars%20files/mars_jezero_120m_terrain_summary.json` | `Data/processed/Mars files/mars_jezero_120m_terrain_summary.json` | required keys |
| `mars_120m_terrain_csv` | terrain_csv | csv | on_demand | `../Data/processed/Mars%20files/mars_jezero_120m_terrain.csv` | `Data/processed/Mars files/mars_jezero_120m_terrain.csv` | 96,369 rows |
| `mars_360m_geojson` | terrain_geojson | geojson | auto | `../Data/processed/Mars%20files/mars_jezero_360m_terrain.geojson` | `Data/processed/Mars files/mars_jezero_360m_terrain.geojson` | 2,714 features |
| `mars_360m_summary` | terrain_summary | json | auto | `../Data/processed/Mars%20files/mars_jezero_360m_terrain_summary.json` | `Data/processed/Mars files/mars_jezero_360m_terrain_summary.json` | required keys |
| `mars_360m_terrain_csv` | terrain_csv | csv | on_demand | `../Data/processed/Mars%20files/mars_jezero_360m_terrain.csv` | `Data/processed/Mars files/mars_jezero_360m_terrain.csv` | 10,856 rows |
| `moon_120m_geojson` | terrain_geojson | geojson | auto | `../Data/processed/Moon%20files/moon_taurus_littrow_120m_terrain.geojson` | `Data/processed/Moon files/moon_taurus_littrow_120m_terrain.geojson` | 3,300 features |
| `moon_120m_summary` | terrain_summary | json | auto | `../Data/processed/Moon%20files/moon_taurus_littrow_120m_terrain_summary.json` | `Data/processed/Moon files/moon_taurus_littrow_120m_terrain_summary.json` | required keys |
| `moon_120m_terrain_csv` | terrain_csv | csv | on_demand | `../Data/processed/Moon%20files/moon_taurus_littrow_120m_terrain.csv` | `Data/processed/Moon files/moon_taurus_littrow_120m_terrain.csv` | 29,535 rows |
| `moon_360m_geojson` | terrain_geojson | geojson | auto | `../Data/processed/Moon%20files/moon_taurus_littrow_360m_terrain.geojson` | `Data/processed/Moon files/moon_taurus_littrow_360m_terrain.geojson` | 3,416 features |
| `moon_360m_summary` | terrain_summary | json | auto | `../Data/processed/Moon%20files/moon_taurus_littrow_360m_terrain_summary.json` | `Data/processed/Moon files/moon_taurus_littrow_360m_terrain_summary.json` | required keys |
| `moon_360m_terrain_csv` | terrain_csv | csv | on_demand | `../Data/processed/Moon%20files/moon_taurus_littrow_360m_terrain.csv` | `Data/processed/Moon files/moon_taurus_littrow_360m_terrain.csv` | 3,416 rows |
| `earth_power_daily_csv` | climate_csv | csv | auto | `../Data/processed/Earth%20files/earth_western_desert_power_daily.csv` | `Data/processed/Earth files/earth_western_desert_power_daily.csv` | 365 rows |
| `earth_power_summary` | climate_summary | json | auto | `../Data/processed/Earth%20files/earth_western_desert_power_summary.json` | `Data/processed/Earth files/earth_western_desert_power_summary.json` | required keys |
| `comparison_120m` | comparison | csv | auto | `../Data/processed/comparison_120m.csv` | `Data/processed/comparison_120m.csv` | 3 rows |

## 3. Where each dataset appears on the loader's data object

`FieldZeroData.data.<path>` is `null` until the dataset has loaded and stays `null` if it failed. Nothing is substituted. The payload is also available as `FieldZeroData.get(id)` / `data.byId[id]`; load details (warnings, counts, errors) are in `data.meta[id]`.

| Dataset ID | Access path | Shape |
|---|---|---|
| `earth_120m_geojson` | `data.terrain.earth['120'].geojson` | GeoJSON FeatureCollection |
| `earth_120m_summary` | `data.terrain.earth['120'].summary` | parsed JSON object |
| `earth_120m_terrain_csv` | `data.terrain.earth['120'].csv` | `{columns, rows[], rowCount, nullCounts, columnTypes}` |
| `earth_360m_geojson` | `data.terrain.earth['360'].geojson` | GeoJSON FeatureCollection |
| `earth_360m_summary` | `data.terrain.earth['360'].summary` | parsed JSON object |
| `earth_360m_terrain_csv` | `data.terrain.earth['360'].csv` | `{columns, rows[], rowCount, nullCounts, columnTypes}` |
| `mars_120m_geojson` | `data.terrain.mars['120'].geojson` | GeoJSON FeatureCollection |
| `mars_120m_summary` | `data.terrain.mars['120'].summary` | parsed JSON object |
| `mars_120m_terrain_csv` | `data.terrain.mars['120'].csv` | `{columns, rows[], rowCount, nullCounts, columnTypes}` |
| `mars_360m_geojson` | `data.terrain.mars['360'].geojson` | GeoJSON FeatureCollection |
| `mars_360m_summary` | `data.terrain.mars['360'].summary` | parsed JSON object |
| `mars_360m_terrain_csv` | `data.terrain.mars['360'].csv` | `{columns, rows[], rowCount, nullCounts, columnTypes}` |
| `moon_120m_geojson` | `data.terrain.moon['120'].geojson` | GeoJSON FeatureCollection |
| `moon_120m_summary` | `data.terrain.moon['120'].summary` | parsed JSON object |
| `moon_120m_terrain_csv` | `data.terrain.moon['120'].csv` | `{columns, rows[], rowCount, nullCounts, columnTypes}` |
| `moon_360m_geojson` | `data.terrain.moon['360'].geojson` | GeoJSON FeatureCollection |
| `moon_360m_summary` | `data.terrain.moon['360'].summary` | parsed JSON object |
| `moon_360m_terrain_csv` | `data.terrain.moon['360'].csv` | `{columns, rows[], rowCount, nullCounts, columnTypes}` |
| `earth_power_daily_csv` | `data.climate.earth.daily` | `{columns, rows[], rowCount, nullCounts, columnTypes}` |
| `earth_power_summary` | `data.climate.earth.summary` | parsed JSON object |
| `comparison_120m` | `data.comparison['120']` | `{columns, rows[], rowCount, nullCounts, columnTypes}` |

Also present: `data.manifest`, `data.sources`, `data.unavailable`, `data.climate.earth.missingVariables`. There is **no** `data.climate.mars` or `data.climate.moon`, because no such datasets exist.

## 4. Metadata and source references

Each manifest entry carries: `title`, `description`, `body`, `site`, `scale_m`, `sources` (IDs into the manifest `sources` block), `coordinate_system`, `units`, `native_resolution`, `expected` (counts, columns, bounds), `missing_value_policy`, `notes`, `bytes` and `sha256`.

| Source ID | Provider | Reference |
|---|---|---|
| `nasadem` | NASA LP DAAC | NASADEM_HGT v001 (NASA LP DAAC), 1 arc-second - https://www.earthdata.nasa.gov/data/catalog/lpcloud-nasadem-hgt-001 |
| `usgs_ctx_dem_20m` | USGS Astrogeology | Mars 2020 Science Investigation CTX DEM Mosaic, 20 m (M20_JezeroCrater_CTXDEM_20m.tif) - https://astrogeology.usgs.gov/search/map/mars_2020_science_investigation_ctx_dem_mosaic |
| `usgs_lola_ldem_118m` | USGS Astrogeology / LOLA Science Team (GSFC) | LRO LOLA global LDEM 118 m, Mar 2014 (Lunar_LRO_LOLA_Global_LDEM_118m_Mar2014.tif) - https://astrogeology.usgs.gov/search/map/moon_lro_lola_dem_118m |
| `nasa_power_daily` | NASA LaRC POWER project | NASA POWER daily point API (community AG) - https://power.larc.nasa.gov/api/temporal/daily/point |
| `field_zero_pipeline` | FIELD//ZERO team | FIELD//ZERO processing pipeline (derived products) |

Project-side provenance: `metadata/sources.json`, `metadata/DATASET_INVENTORY.md`, `reports/download_log.json`, `reports/status_*.md`, `reports/processing_status.json`.

## 5. Known data gaps (recorded in the manifest, never filled)

- **Earth `T2M`** is absent from the POWER CSV and summary. It is listed under `missing_variables`. Do not derive it from `T2M_MAX`/`T2M_MIN`.
- **Mars and Moon have no climate datasets** (no MEDA, no Diviner). They are listed in the manifest `unavailable` block.
- **GeoJSON files are decimated** copies of the CSV grids (4.1 % to 100 %). Aggregate statistics must come from the summary JSON or the CSV, not from the GeoJSON.
- **Mars and Moon `lon/lat` are not WGS84** (sphere-based). Do not draw them on an Earth basemap.
- **Kernel-border cells** have `null` slope, aspect, roughness and TRI (and `null` elevation variability on a 2-cell border). These are real missing values, kept as `null`.
- `comparison_120m` has no 360 m equivalent, and summaries have no `aspect_deg` statistics.

## 6. Load test results

Test: `node website/tests/test_data_loader.js` (Node 22, no dependencies): **44 passed, 0 failed**.

- Run against a static server on the project root with SHA-256 verification on: all 21 datasets loaded, 0 errors, 0 warnings, and every checksum equals the manifest.
- Second run through Python's `http.server`: 21 of 21 loaded, 22 requests (manifest + 21 files) all HTTP 200, no 404s, which confirms `%20` paths work on a standard server.
- Independent cross-check against pandas for all 8 CSVs and 6 GeoJSON files: row/feature counts, per-column null counts and column sums matched, so the loader did not change, default or drop any value.
- Error-handling tests pass for: missing file (404), raw space in a path, HTML page returned with HTTP 200, invalid JSON, ragged CSV row, non-numeric text in a numeric column, missing column, blank cell becoming `null`, HTTP 500, network failure with retry, unknown ID, missing manifest, invalid manifest, checksum mismatch.
- **Not tested:** execution in a real browser (only Node's `fetch`, which has the same API). The `file://` hint and the `document.currentScript` manifest lookup are browser-only code paths.

| Dataset ID | Resolved URL (test server) | Result |
|---|---|---|
| `earth_120m_geojson` | `http://<host>/Data/processed/Earth%20files/earth_western_desert_120m_terrain.geojson` | OK - 2,800 features, 525 null property values |
| `earth_120m_summary` | `http://<host>/Data/processed/Earth%20files/earth_western_desert_120m_terrain_summary.json` | OK - JSON object, required keys present |
| `earth_120m_terrain_csv` | `http://<host>/Data/processed/Earth%20files/earth_western_desert_120m_terrain.csv` | OK - 68,944 rows, 6,280 nulls |
| `earth_360m_geojson` | `http://<host>/Data/processed/Earth%20files/earth_western_desert_360m_terrain.geojson` | OK - 1,974 features, 526 null property values |
| `earth_360m_summary` | `http://<host>/Data/processed/Earth%20files/earth_western_desert_360m_terrain_summary.json` | OK - JSON object, required keys present |
| `earth_360m_terrain_csv` | `http://<host>/Data/processed/Earth%20files/earth_western_desert_360m_terrain.csv` | OK - 7,896 rows, 2,104 nulls |
| `mars_120m_geojson` | `http://<host>/Data/processed/Mars%20files/mars_jezero_120m_terrain.geojson` | OK - 3,905 features, 625 null property values |
| `mars_120m_summary` | `http://<host>/Data/processed/Mars%20files/mars_jezero_120m_terrain_summary.json` | OK - JSON object, required keys present |
| `mars_120m_terrain_csv` | `http://<host>/Data/processed/Mars%20files/mars_jezero_120m_terrain.csv` | OK - 96,369 rows, 7,480 nulls |
| `mars_360m_geojson` | `http://<host>/Data/processed/Mars%20files/mars_jezero_360m_terrain.geojson` | OK - 2,714 features, 622 null property values |
| `mars_360m_summary` | `http://<host>/Data/processed/Mars%20files/mars_jezero_360m_terrain_summary.json` | OK - JSON object, required keys present |
| `mars_360m_terrain_csv` | `http://<host>/Data/processed/Mars%20files/mars_jezero_360m_terrain.csv` | OK - 10,856 rows, 2,488 nulls |
| `moon_120m_geojson` | `http://<host>/Data/processed/Moon%20files/moon_taurus_littrow_120m_terrain.geojson` | OK - 3,300 features, 624 null property values |
| `moon_120m_summary` | `http://<host>/Data/processed/Moon%20files/moon_taurus_littrow_120m_terrain_summary.json` | OK - JSON object, required keys present |
| `moon_120m_terrain_csv` | `http://<host>/Data/processed/Moon%20files/moon_taurus_littrow_120m_terrain.csv` | OK - 29,535 rows, 4,096 nulls |
| `moon_360m_geojson` | `http://<host>/Data/processed/Moon%20files/moon_taurus_littrow_360m_terrain.geojson` | OK - 3,416 features, 1,372 null property values |
| `moon_360m_summary` | `http://<host>/Data/processed/Moon%20files/moon_taurus_littrow_360m_terrain_summary.json` | OK - JSON object, required keys present |
| `moon_360m_terrain_csv` | `http://<host>/Data/processed/Moon%20files/moon_taurus_littrow_360m_terrain.csv` | OK - 3,416 rows, 1,372 nulls |
| `earth_power_daily_csv` | `http://<host>/Data/processed/Earth%20files/earth_western_desert_power_daily.csv` | OK - 365 rows, 0 nulls |
| `earth_power_summary` | `http://<host>/Data/processed/Earth%20files/earth_western_desert_power_summary.json` | OK - JSON object, required keys present |
| `comparison_120m` | `http://<host>/Data/processed/comparison_120m.csv` | OK - 3 rows, 0 nulls |

## 7. What changed from the old manifest

- Old manifest: 7 entries with paths like `processed/...`; **0 of 7 resolved**. Only 120 m layers, one climate summary, no metadata.
- New manifest: 21 datasets (6 GeoJSON, 6 summaries, 6 terrain CSVs, POWER daily CSV, POWER summary, comparison CSV), a `sources` block, per-dataset metadata, a `layers` index that groups IDs by site, and an `unavailable` list. File paths are defined only in `datasets[]`; `layers` refers to IDs.
- The six terrain CSVs were added beyond the request because they are the only complete-grid data (GeoJSON is decimated). They are `on_demand`, so the page does not download about 25 MB unless asked.
