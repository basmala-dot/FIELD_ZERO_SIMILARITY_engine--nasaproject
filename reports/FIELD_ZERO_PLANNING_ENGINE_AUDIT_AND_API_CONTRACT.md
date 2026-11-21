# FIELD//ZERO — Planning Engine: Project Audit and API Contract

**Status:** draft v0.1.0 · **Date:** 2026-11-21 · **Audience:** Person 1 (planning engine), Person 2 (Frontend), Person 3 (Simulation & Operations)
**Package inspected:** `FIELD_ZERO_SIMILARITY_engine--nasaproject-main.zip` (66 files, 91 MB unpacked)

## 0. Ground rules for this document

1. **No existing file was modified.** This document is the only new artifact. Suggested location in the repo: `docs/PLANNING_ENGINE_AUDIT_AND_API_CONTRACT.md`.
2. **No scientific data is invented.** Every number below is read from a file in the package. Where a number comes from a project report rather than from a file I could re-check, it is marked **(reported)**.
3. **I did not re-run any project script.** `run_similarity.js`, `run_intelligence.js` and `validate_similarity.js` write into `outputs/` and `reports/`, so running them would change existing files. Test and validation results quoted here are the project's own reports.
4. Tags used: **VERIFIED** = I read or computed it from a file in the ZIP; **(reported)** = stated by a report, not re-checkable here; **PROPOSED** = new design in this document, does not exist yet.

---

## 1. Inspection findings

### 1.1 Architecture as it exists today

Everything is **client-side JavaScript with no backend**. Each module is a UMD file that works in the browser (global) and in Node 18+ (`require`).

```
website/site_manifest.json  (schema_version 2, 21 datasets)
        │
        ▼
FieldZeroData      data-loader.js        loads + validates CSV/JSON/GeoJSON, never fills missing values
        │  FieldZeroData.data
        ▼
FieldZeroSimilarity similarity-engine.js  v1.0.0  scores every Earth cell against Mars (Jezero) and Moon (Taurus-Littrow)
        │  analysis
        ▼
FieldZeroIntel     mission-intelligence.js v1.0.0  portfolio optimizer + evidence-gap detector
        │
        ▼
app.js  ──publishes──►  window.FZ = { data, analysis, rows, portfolio, gaps, pinned, target, scale }
        │
        ├─► FZMap    map.js     Leaflet map (Earth: WGS84 tiles; Mars/Moon: L.CRS.Simple, metres)
        └─► FZCharts charts.js  Chart.js
```

Boot order in `app.js` (VERIFIED): `FieldZeroData.init()` → `loadAll()` → `load('earth_120m_terrain_csv')` and `load('earth_360m_terrain_csv')` → `FieldZeroSimilarity.analyzeLoaded(data)` (about 2 s, main thread, per the integration report) → `FieldZeroIntel.evidenceGaps(data)` → render chapters.

Important design properties to preserve (VERIFIED from code and methodology):
- Pure, deterministic computation (no randomness; ties break on lowest CSV row index).
- Missing values stay `null`; a score is never written as 0 when it could not be computed.
- Every candidate carries the label `"Terrain-metric similarity candidate. Not a confirmed analog."`
- The engine rejects absolute elevation, temperature and pressure as similarity features.

### 1.2 Scientific datasets actually available (on disk, processed)

All terrain tables share 12 columns: `site, scale_m, x_m_localTM, y_m_localTM, lon_deg, lat_deg, elevation, slope_deg, aspect_deg, roughness_std, elev_variability_std, tri`. Rows are a complete regular grid (VERIFIED: Earth 120 m is 248 × 278 = 68,944, no gaps).

| Body / site | Source dataset | Native resolution | 120 m grid (cells) | 360 m grid (cells) | Window extent (120 m) | Validation status (reported) |
|---|---|---|---|---|---|---|
| **Earth** · Western Desert, Egypt | NASADEM_HGT v001 (NASA LP DAAC), 1 arc-second | 27.5 × 30.9 m | 248 × 278 = 68,944 | 84 × 94 = 7,896 | ~29.8 × 33.4 km; lon 28.000–28.300, lat 27.150–27.450 | NASADEM **VALIDATED** |
| **Mars** · Jezero | Mars 2020 CTX DEM mosaic, USGS Astrogeology | 20 m | 353 × 273 = 96,369 | 118 × 92 = 10,856 | ~42.4 × 32.8 km | **VALIDATED** |
| **Moon** · Taurus-Littrow | LRO LOLA global LDEM 118 m (Mar 2014), USGS | 118.45 m | 179 × 165 = 29,535 | 61 × 56 = 3,416 | ~21.5 × 19.8 km | **VALIDATED** |
| **Earth climate** | NASA POWER daily point, community AG | one grid cell | 365 daily rows, 2023-01-01 to 2023-12-31 | — | one point (lon 28.15, lat 27.3, per the project audit) | **PARTIAL**: 5 of 6 variables |

Derived terrain metrics per cell: `elevation` (m), `slope_deg` (3×3 central difference, 240 m baseline at 120 m scale), `aspect_deg`, `roughness_std` (3×3 std, m), `elev_variability_std` (5×5 std, m), `tri` (Riley TRI, m).

Real comparison of the three windows at 120 m (`Data/processed/comparison_120m.csv`, VERIFIED):

| Body | Mean slope (°) | Mean roughness (m) | Mean TRI (m) | Mean elev. variability (m) |
|---|---:|---:|---:|---:|
| Earth | 1.64 | 3.12 | 11.18 | 4.31 |
| Mars | 3.52 | 6.27 | 19.96 | 10.16 |
| Moon | 10.42 | 18.62 | 56.31 | 31.87 |

POWER variables present (VERIFIED from `earth_western_desert_power_summary.json`): `T2M_MAX` (°C), `T2M_MIN` (°C), `ALLSKY_SFC_SW_DWN` (MJ/m²/day), `WS2M` (m/s), `PS` (kPa). **`T2M` is absent** (the download or validation failed; the audit found an inconsistent T2M record).

Derived outputs already in `outputs/`:
- `earth_mars_similarity.geojson`, `earth_moon_similarity.geojson` (33 MB each, 68,944 points, not fetched by the website).
- `top_candidates.json` (10 candidates per target at 120 m, 10 sensitivity candidates at 360 m).
- `mission_portfolio.json` (Mars and Moon portfolios), `evidence_gaps.json` (9 gaps).

### 1.3 Datasets that do NOT exist in the project

| Missing | Consequence for planning |
|---|---|
| Mars atmosphere/climate (MEDA: temperature, pressure, wind, solar, humidity) | No Mars thermal, dust, wind or power analysis. Researched in `DATASET_INVENTORY.md` (A5), no code, no data. |
| Moon temperature (LRO Diviner) and rock abundance | No lunar thermal or regolith analysis. Researched (A6), not downloaded. |
| Lunar illumination / solar geometry | No lighting, shadow or power-availability planning. No dataset even verified. |
| Earth `T2M`, humidity, precipitation, hourly data, multi-year climatology | Earth climate is one point, one year, modelled (not station data). |
| Surface composition, soil/regolith, land cover, thermal inertia/albedo | No geology or trafficability-by-soil analysis. |
| Ground-truth analog labels | The similarity model is validated for correctness and calibration, **not** for scientific validity as an analog finder. |
| Common vertical datum | Absolute elevations are not comparable across bodies; only relief metrics are. |
| Raw rasters and the Python pipeline (`raw/`, `config.py`, downloaders, processors, validator) | Not in the ZIP; raw → processed lineage cannot be re-derived from this package. (Only `scripts/crosscheck_similarity.py` exists.) |

### 1.4 Data limitations that constrain what a planner may claim

1. **Resolution mismatch.** Native 30 m / 20 m / 118 m are all area-averaged to 120 m and 360 m, so smoothing differs by body (Earth ~4×, Mars ~6×, Moon ~1×).
2. **Scale dependence.** 120 m and 360 m metrics are different quantities (kernels are defined in metres). Only about 44% (Mars) and 63% (Moon) of 120 m cells score within 15 points of their 360 m parent (reported). Example: the real #1 Mars candidate scores 98.72 at 120 m but 77.49 at 360 m (`divergent`).
3. **Slope is not rover-scale.** A 240 m baseline cannot describe obstacles a rover or lander meets. Any routing or landing-hazard output must be labelled coarse.
4. **Four metrics, effectively one axis.** Spearman among them is 0.75–1.00; AUC separating Mars-site from Moon-site cells is only about 0.54–0.68 (reported). High similarity ≠ analog.
5. **Search domain is one 30 × 33 km Earth window**, not "the Western Desert" and not "Earth".
6. **Mars and Moon lon/lat are not WGS84** (sphere-based). They must never be drawn on an Earth basemap. Earth is WGS84.
7. **One reference site per body**, so scores describe closeness to Jezero or Taurus-Littrow only.
8. **Edge cells** have `null` metrics (all four missing on the 1-cell border; `elev_variability_std` also missing on the 2-cell border).

### 1.5 Discrepancies and issues found in the package

| # | Finding | Basis | Action needed |
|---|---|---|---|
| 1 | `reports/download_log.json` entry index 12 is a `UnicodeEncodeError` message. The earlier project audit says it echoes what appears to be an Earthdata password. I confirmed the entry still exists; I did **not** print or inspect its content. | VERIFIED (presence only) | Open that entry yourself. If it is a real password: change it and delete the entry before sharing or pushing the repo. `.gitignore` covers `*.log` but not this `.json`. |
| 2 | `metadata/sources.json` still says `code_status: "written, not run"` for all four datasets, and `status_*.md` still say downloaders were "not yet run", while the same reports show the data downloaded and validated. | VERIFIED | Stale text; correct it when code is next touched. |
| 3 | `reports/PROJECT_AUDIT.md` says the manifest is broken (0 of 7 paths resolve). That is **outdated**: the current manifest is `schema_version 2` with 21 datasets and **all 21 paths resolve** (relative to `website/`, `%20` decoded). | VERIFIED | Treat the audit's §10 as superseded. |
| 4 | `status_index.md`: Earth is "1 of 2 datasets validated" (POWER partial). The manifest's `unavailable` list correctly lists `T2M`. | VERIFIED | Do not claim full Earth climate. |
| 5 | Candidates in `top_candidates.json` have no `csv_row_index` (portfolio items do). `FZMap.focus(lon, lat)` finds the cell by string key `lon + ',' + lat`, which is fragile. | VERIFIED | The planner must expose a stable `cell_index` (see §5.2). |
| 6 | `FZMap.focus`, `overlays` and `showPortfolio` work for **Earth only**. Mars/Moon cannot show plan sites today. | VERIFIED | Frontend work item (§5.5). |
| 7 | Mars/Moon terrain CSVs are `on_demand` (9.3 MB and 3.1 MB). `app.js` loads only Earth CSVs at boot. | VERIFIED | The planner needs an async `ensureData()` for non-Earth bodies. |
| 8 | The 6 terrain GeoJSON files are **decimated** (Earth 120 m: 2,800 of 68,944 cells; Moon 360 m: 100%). Aggregates from them differ from the summaries. | VERIFIED | Planning must read the CSVs, never the GeoJSON, for statistics or routing. |
| 9 | Window-edge scoring: 1,048 Earth 120 m cells are unscored (all metrics null). | VERIFIED | Planner must treat `score: null` as "not evaluable", not zero. |

---

## 2. Existing functions that can be reused

### 2.1 `FieldZeroData` (data-loader.js, v1.0.0)

| Function | Purpose | Reuse |
|---|---|---|
| `init(opts)` / `loadAll(opts)` / `load(id, {force})` | Load manifest and datasets; `load` always resolves with `{id, ok, data, meta, warnings, error, url}` | As is. Planner uses `load()` for Mars/Moon CSVs. |
| `get(id)`, `getEntry(id)`, `getSource(id)`, `list(filter)`, `status()`, `report()`, `on(evt, fn)` | Access, listing, progress/error events | As is. |
| `data.terrain[body][scale].{geojson, summary, csv}` | Slots are `null` until loaded (distinguishes "registered" from "unknown") | As is. CSV object: `{columns, rows (objects), rowCount, nullCounts, columnTypes}`. |
| `data.climate.earth.{daily, summary, missingVariables}`, `data.unavailable`, `data.sources`, `data.manifest` | Climate and provenance | As is. Source of truth for "what exists". |
| `util.parseCsv`, `util.column`, `util.parseYyyymmdd` | Parsing helpers | As is. |

### 2.2 `FieldZeroSimilarity` (similarity-engine.js, v1.0.0)

| Function | Purpose | Reuse |
|---|---|---|
| `analyze(inputs, config)` / `analyzeLoaded(data, config)` | Full scoring → `{model, config, references, results, candidates, scale_comparison, inputs_meta}` | As is. `results[body][scale] = {cells, ranked, stats}`; `cells[i]` aligns with CSV row `i`. |
| `resolveConfig`, `DEFAULT_CONFIG` | Weights (normalised), distribution rule, thresholds | As is. Planner passes `weights` through. |
| `buildReference`, `scoreFeature`, `scoreCell`, `scoreTable` | Score one value/cell/table against a reference | **Reuse to score a hypothetical or user-edited cell** without re-running everything. |
| `compareScales`, `assignConfidence` | 120 vs 360 m consistency, confidence class | As is. |
| `selectCandidates(table, rows, ref, cfg)` | Greedy top-N with minimum separation | Reuse; planner adds constraints and `cell_index`. |
| `toGeoJSON`, `toTopCandidates` | Export shapes | As is. |
| `MODEL_LABEL`, `DISCLAIMER`, `ALLOWED_FEATURES`, `FORBIDDEN_FEATURES`, `FEATURE_INFO` | Mandatory wording and feature metadata | Reuse verbatim in every plan. |

Per-cell fields (VERIFIED): `status` (`scored`/`insufficient`), `score` (0–100 or `null`), `rank`, `completeness`, `n_features_used`, `n_outside_ref_range`, `limiting_feature`, `confidence` (`high`/`medium`/`low`/`insufficient`), `features[f] = {value, status, z, percentile, score, weight, effective_weight, contribution, shortfall, outside_ref_range}`, `scale = {parent_index, score_coarse, delta, consistency}`, plus `index, x, y, lon, lat`.

### 2.3 `FieldZeroIntel` (mission-intelligence.js, v1.0.0)

| Function | Purpose | Reuse |
|---|---|---|
| `portfolio(analysis, rows, {target, n (1–12), minSepM, poolSize, minCompleteness, weights, diversityRefSD})` | Greedy site portfolio: `gain = 0.5·score/100 + 0.3·min(1, d_terrain/1.0) + 0.2·completeness`, hard separation constraint | Reuse as the engine core of "campaign site selection". Needs a pre-filter hook for constraints (PROPOSED). |
| `evidenceGaps(data)` | 9 gap items with `status` derived from what is actually loaded | Reuse; plan-level evidence = this + plan-specific caveats. |

Item shape (VERIFIED): `pick, csv_row_index, lon_deg, lat_deg, x_m_localTM, y_m_localTM, score, engine_cell_rank, confidence, completeness, features, elevation_m, nearest_selected_km, terrain_distance_to_selected, objective_gain, scale_consistency, score_360m, why_selected, status_label`.

### 2.4 Frontend modules

| Module | Reusable parts | Limits |
|---|---|---|
| `FZMap` (map.js) | `init(FZ, hooks)`, `setBody`, `setLayer`, `layersFor`, `showPortfolio(items)`, `toggle`, `select`, `focus(lon, lat)`, `BODIES`, `RADIUS_M` | Overlays and `focus` are Earth-only. Mars/Moon plot from GeoJSON lon/lat via an equirectangular projection from the site centre — a different origin than `x_m_localTM`. |
| `FZCharts` (charts.js) | Terrain/climate/similarity charts | Read-only consumers of `FZ`. |
| `app.js` | Chapters (control, explorer, discovery, notes, portfolio, evidence, brief); brief export (.md/.json) | The brief is built from the portfolio only; it has no plan concept. |
| `window.FZ` | The shared state object | De facto frontend store; the planner should attach as `FZ.planner` and `FZ.plan`. |

---

## 3. Missing mission-planning capabilities

"Buildable now" = can be computed from datasets that exist today. "Blocked" = needs data the project does not have.

| # | Capability | Status | Notes |
|---|---|---|---|
| 1 | **Mission request/plan data model** (body, objectives, constraints, assumptions) | Buildable now | Currently only cells and candidates exist; nothing is a "mission" or a "plan". |
| 2 | **Hard terrain constraints** (e.g. max slope, max roughness) | Buildable now | Threshold values are engineering inputs that **no file in the project provides**. The planner must take them from the user and label them `user_input`. No defaults. |
| 3 | **Region-of-interest and spatial queries** (polygon/bbox/radius, neighbours, area stats) | Buildable now | Cells carry `x_m_localTM`, `y_m_localTM`, `lon_deg`, `lat_deg`; grid is complete. |
| 4 | **Site suitability = constraints + similarity + confidence** | Buildable now | Similarity exists only for Earth cells (targets: Mars, Moon). |
| 5 | **Campaign portfolio with constraints** | Partially exists | `portfolio()` has separation and diversity but no constraint pre-filter. |
| 6 | **Terrain-only traversability / route planning** on the grid | Buildable now, coarse | Row-major grid with slope at 120/360 m. Label output "coarse terrain-only, not rover-scale". |
| 7 | **Distances, areas and logistics geometry** between sites | Buildable now | Euclidean in local TM metres. Travel *time* needs a speed → `user_input`/`assumption`. |
| 8 | **Terrain-only operations planning on Mars/Moon windows** | Buildable now | Their grids exist; needs CSV loading and non-WGS84 handling. |
| 9 | **Plan-level evidence, uncertainty and limitations** | Buildable now | Reuse `evidenceGaps`, `confidence`, `scale_consistency`; add plan caveats. |
| 10 | **Plan persistence, hashing, export, versioning** | Buildable now | JSON + Markdown. |
| 11 | **Thermal, power, comms, dust, wind, illumination planning** | **Blocked** | Mars/Moon environment data absent; Earth is one modelled point, one year, no `T2M`. |
| 12 | **Scientific validation of analog quality** | **Blocked** | No labelled ground truth. |
| 13 | **Planning beyond the 30 × 33 km Earth window** | **Blocked** | Needs additional processed Earth terrain (data work, not planner code). |
| 14 | **Soil/geology/composition-aware planning** | **Blocked** | No layers. |

---

## 4. How the planning engine communicates

### 4.1 Principles

1. **One new module, same pattern as the others (PROPOSED):** `website/js/mission-planner.js`, UMD, global `FieldZeroPlanner`, loaded after `mission-intelligence.js`. No DOM access, no network calls, no randomness.
2. **JSON in, JSON out.** Every request and response is plain JSON-serializable (no class instances, no functions, no typed arrays across the boundary except `getGrid`, §5.3). This keeps the option of moving the planner into a Web Worker or calling it from Node/Python later without a contract change.
3. **Dependency injection, not globals:** `FieldZeroPlanner.create({ data, analysis, rows, gaps })` returns a planner instance. The frontend passes `window.FZ`; tests pass objects built in Node.
4. **The planner never recomputes similarity.** It reads `analysis` (as `FieldZeroIntel` already does) and calls `scoreCell` only for explicit what-if evaluation.
5. **Ownership.** The planner owns the **plan**. The frontend owns **presentation state** and must not edit plan fields. Simulation owns **simulation results** and must not edit plan fields. Results attach to a plan by `plan_id` + `plan_hash`.
6. **Data flow**

```
User input ──► Frontend (Person 2) ──MissionRequest──► Planner (Person 1) ──MissionPlan──► Frontend renders
                                                              │
                                                              └─MissionPlan + terrain access─► Simulation (Person 3)
                                                                                                    │
                          Frontend renders  ◄──────────SimulationResult (attached by plan_id)──────┘
```

### 4.2 Transport options (pick per consumer; same payloads)

| Consumer | In-process (default) | Message form (if a Worker or other runtime is used) |
|---|---|---|
| Frontend | `FZ.planner.method(params)` → `Result` | `{id, method, params}` → `{id, result}` |
| Simulation in JS | same, plus `planner.getGrid()` | same |
| Simulation in Python or other | not applicable | exchange JSON files: `outputs/plans/<plan_id>.json` (in) and `outputs/simulations/<sim_id>.json` (out) |

**Open question for Person 3:** which runtime? The JSON file exchange works for either; the in-process path is JS only.

---

## 5. API contract (v0.1.0)

### 5.1 Conventions

| Topic | Rule |
|---|---|
| **Result envelope** | Every method returns `Result<T>` = `{ ok: true, data: T, warnings: Warning[] }` or `{ ok: false, error: PlannerError }`. Methods **never throw** for bad input or missing data. |
| **Synchronous vs async** | All methods are synchronous and pure **except** `ensureData` and `hashPlan` (Promises). |
| **Null policy** | Missing, unscorable or unavailable values are `null`. Never `0`, `NaN`, `""` or an invented default. The frontend renders `null` as "n/a". |
| **Units** | Always explicit in the type (`slope_deg` in degrees; `roughness_std`, `elev_variability_std`, `tri`, `elevation` in metres; distances in metres; scores 0–100). |
| **Scale** | `scale_m` is `120` (primary) or `360` (sensitivity). Results at different scales are **never** mixed or averaged. |
| **Cell identity** | `cell_index` = row index in that body's 120 m (or 360 m) CSV. Grid order is **row-major, north to south**: `row = floor(i / nx)`, `col = i % nx`, `y` descends with `row`, `x` ascends with `col` (VERIFIED on Earth 120 m: first row y = 16,620, x from −14,820). `nx, ny` = Earth 248×278, Mars 353×273, Moon 179×165 at 120 m. For Earth, `cell_index` equals the engine's `cells[i]` index. |
| **Coordinates** | Every location carries `crs` and both coordinate pairs. `lon/lat` is WGS84 **only** when `crs === "WGS84"`. `x_m_localTM, y_m_localTM` is the per-site local transverse-Mercator metre grid (different origin per site; valid for distance math within one site). |
| **Provenance** | Every value that is not a plain label carries or inherits one of: `dataset` (read from a processed file), `derived` (computed by project code from dataset values), `user_input` (supplied by the mission owner), `assumption` (explicit modelling assumption), `simulated` (output of Person 3's simulation), `unavailable` (no data). `assumption` and `user_input` require a `source_note`. |
| **Mandatory labels** | Every site carries `status_label = "Terrain-metric similarity candidate. Not a confirmed analog."` Every plan carries `model.label` and `model.disclaimer` copied from `FieldZeroSimilarity.MODEL_LABEL` / `DISCLAIMER`. |
| **Determinism** | Same request + same data ⇒ byte-identical plan (excluding `meta`). |
| **Versioning** | `schema_version` is semver. While `< 1.0.0`, minor bumps may break; consumers must check `schema_version` and refuse an unknown major/minor with a clear message. |

### 5.2 Shared types

```ts
type Body = "earth" | "mars" | "moon";
type Scale = 120 | 360;
type Provenance = "dataset" | "derived" | "user_input" | "assumption" | "simulated" | "unavailable";
type Crs = "WGS84" | "Mars2000Sphere" | "MoonSphere1737.4km";
type TerrainMetric = "slope_deg" | "roughness_std" | "elev_variability_std" | "tri";

interface Location {
  body: Body;
  scale_m: Scale;
  cell_index: number;            // row index in that body's CSV at scale_m
  crs: Crs;                      // Earth = WGS84; Mars/Moon are NOT WGS84
  lon_deg: number;
  lat_deg: number;
  x_m_localTM: number;
  y_m_localTM: number;
  elevation_m: number | null;    // own vertical datum; never compare across bodies
}

interface TerrainValues {        // all provenance "dataset" (CSV values, 4-decimal rounded)
  slope_deg: number | null;
  roughness_std: number | null;
  elev_variability_std: number | null;
  tri: number | null;
}

interface Similarity {           // Earth cells only; reference = Jezero (mars) or Taurus-Littrow (moon)
  target_body: "mars" | "moon";
  score: number | null;          // 0-100, null = not scored
  rank: number | null;           // among scored cells at this scale
  confidence: "high" | "medium" | "low" | "insufficient";
  completeness: number;          // 0-1 weight share available
  limiting_feature: TerrainMetric | null;
  n_outside_ref_range: number;
  features: Record<TerrainMetric, {
    value: number | null; score: number | null; contribution: number | null;
    shortfall: number | null; reference_center: number | null; percentile: number | null;
  }>;
  scale_check: { score_360m: number | null; delta_120m_minus_360m: number | null;
                 consistency: "consistent" | "divergent" | "n/a" } | null;
}

interface Constraint {
  metric: TerrainMetric | "elevation";   // "elevation" is allowed only as a within-body filter
  op: "<=" | ">=";
  value: number;                         // units of the metric
  provenance: "user_input" | "assumption";
  source_note: string;                   // REQUIRED: where the threshold comes from
}

interface Assumption {
  id: string; description: string; value: number | string | boolean | null; unit: string | null;
  provenance: "user_input" | "assumption"; source_note: string; owner: "planner" | "simulation" | "user";
}

interface Warning { code: WarningCode; message: string; site_id?: string; }
interface PlannerError { code: ErrorCode; message: string; details?: object; hint?: string; }
```

### 5.3 Planner methods

#### `planner.capabilities()` → `Result<Capabilities>`
Derived from `FZ.data` at call time (not hard-coded), so it reflects what is actually loaded.
```ts
interface Capabilities {
  planner_version: string; schema_version: string;
  engine_versions: { data_loader: string; similarity: string; intel: string };
  bodies: Record<Body, {
    terrain: { 120: "loaded" | "not_loaded" | "unavailable"; 360: "loaded" | "not_loaded" | "unavailable" };
    similarity_layer: boolean;                 // true only for earth
    climate: { available: string[]; unavailable: { variable: string; reason: string }[] };
  }>;
  constraint_metrics: (TerrainMetric | "elevation")[];
  features_not_supported: { feature: string; reason: string }[];  // e.g. thermal/power/illumination
}
```
Real expected content today: Earth climate `available = [T2M_MAX, T2M_MIN, ALLSKY_SFC_SW_DWN, WS2M, PS]`, `unavailable` includes `T2M`; Mars and Moon `available = []`.

#### `planner.ensureData({ body, scale_m })` → `Promise<Result<{ loaded: string[] }>>`
Loads the on-demand terrain CSV (and summary) for a body via `FieldZeroData.load`. Required before any query on Mars or Moon. Earth 120/360 are already loaded at boot.

#### `planner.describeBody(body, scale_m)` → `Result<BodyInfo>`
`{ body, site, label, crs, grid: {nx, ny, spacing_m, cells, valid_cells}, bounds: {lon: [min,max], lat: [min,max], x_m: [min,max], y_m: [min,max]}, source: {dataset, native_pixel_m, source_sha256}, reference_stats: {metric: {n, mean, std, min, max}}, notes: string[] }`. All fields come from the summary JSON and CSV.

#### `planner.getGrid({ body, scale_m, layers })` → `Result<Grid>`  *(for Person 3)*
```ts
interface Grid {
  body: Body; scale_m: Scale; nx: number; ny: number; spacing_m: number;
  order: "row-major-north-to-south";
  x_m_localTM: number[]; y_m_localTM: number[];            // length nx and ny (axis coordinates)
  layers: Partial<Record<TerrainMetric | "elevation" | "aspect_deg", (number | null)[]>>;  // length nx*ny
  crs: Crs; provenance: "dataset";
}
```
Read-only; `null` marks border/invalid cells. In-process only (large arrays).

#### `planner.queryCells(req)` → `Result<{ total: number; returned: number; cells: CellRecord[] }>`
```ts
interface CellQuery {
  body: Body; scale_m: Scale;
  roi?: { kind: "bbox"; x_min: number; x_max: number; y_min: number; y_max: number }   // local TM metres
      | { kind: "radius"; center_cell_index: number; radius_m: number }
      | { kind: "polygon"; coordinates_xy_m: [number, number][] };
  where?: Constraint[];
  target?: "mars" | "moon";          // Earth only: attach Similarity
  sort?: { by: "score" | TerrainMetric | "cell_index"; dir: "asc" | "desc" };
  limit?: number;                    // default 100, max 5000
}
interface CellRecord { location: Location; terrain: TerrainValues; similarity: Similarity | null; }
```

#### `planner.evaluateLocation(req)` → `Result<SiteEvaluation>`
```ts
interface EvaluateRequest {
  body: Body; scale_m: Scale;
  at: { cell_index: number } | { x_m_localTM: number; y_m_localTM: number } | { lon_deg: number; lat_deg: number };
  target?: "mars" | "moon"; constraints?: Constraint[];
}
interface SiteEvaluation {
  location: Location; terrain: TerrainValues; similarity: Similarity | null;
  constraints_check: { constraint: Constraint; value: number | null; pass: boolean | null }[];  // null = value missing
  evidence_flags: string[];     // e.g. "scale_divergent", "partial_completeness", "border_cell"
  status_label: string;
}
```
`{lon_deg, lat_deg}` lookup is valid for Earth only (WGS84); for Mars/Moon it returns `UNSUPPORTED_COORDINATE_INPUT`.

#### `planner.findSites(req)` → `Result<{ sites: PlanSite[]; search: SearchInfo }>`
Ranked candidates with constraints and minimum separation.
```ts
interface FindSitesRequest {
  target: "mars" | "moon"; scale_m?: Scale;            // default 120
  n?: number;                                           // 1-12, default 5
  min_separation_m?: number;                            // default 2000
  constraints?: Constraint[];
  roi?: CellQuery["roi"];
  weights?: Partial<Record<TerrainMetric, number>>;     // passed to similarity config
  min_completeness?: number;                            // default 0.7 (same as FieldZeroIntel)
  mode: "top_score" | "portfolio";                      // top_score = selectCandidates; portfolio = FieldZeroIntel.portfolio
}
interface SearchInfo { eligible_cells: number; excluded_by_constraints: number; pool_size: number; objective: string; limitations: string[]; }
```
`weights` default to the engine's expert-judgement weights; the response states that they are not fitted.

#### `planner.buildPortfolio(req)` → `Result<PortfolioResult>`
Same as `findSites` with `mode: "portfolio"`, plus `comparison_to_top_scores_only` (reused unchanged from `FieldZeroIntel.portfolio`). With no constraints, `n = 5`, `min_separation_m = 2000`, it **must reproduce `outputs/mission_portfolio.json`** (regression test, §7).

#### `planner.assessRoute(req)` → `Result<RouteAssessment>`
Terrain-only traversability on the grid.
```ts
interface RouteRequest {
  body: Body; scale_m: Scale;
  waypoints: { cell_index: number }[];                   // ≥ 2
  constraints: Constraint[];                             // REQUIRED, at least one (no default slope limit exists in the project)
  connectivity?: 4 | 8;                                  // default 8
  assumed_speed_m_per_s?: number;                        // optional; if absent, no time is computed
}
interface RouteAssessment {
  feasible: boolean;
  path: { cell_index: number; location: Location; slope_deg: number | null }[] | null;
  length_m: number | null;                               // sum of centre-to-centre distances at the chosen scale
  max_slope_deg: number | null; mean_slope_deg: number | null;
  blocked_segments: { from_waypoint: number; to_waypoint: number; reason: "no_path_within_constraints" | "null_cells" }[];
  duration_s: number | null;                             // null unless assumed_speed_m_per_s given
  limitations: string[];                                 // must include "coarse terrain-only: slope baseline 2x scale; not rover-scale"
  provenance: { terrain: "dataset"; path: "derived"; duration: "assumption" | null };
}
```
Cost is distance only within the feasible set (cells satisfying all constraints); no invented traversability cost model.

#### `planner.createPlan(request)` → `Result<MissionPlan>`
```ts
interface MissionRequest {
  schema_version: "0.1.0";
  name: string;
  target_body: "mars" | "moon";                  // which reference the Earth analog search targets
  operating_body: Body;                          // where sites/routes live; default "earth"
  scale_m: Scale;
  objectives: { id: string; label: string; kind: "terrain_similarity" | "constraint_compliance" | "site_diversity" | "route_access" }[];
  site_selection: Omit<FindSitesRequest, "target" | "scale_m">;
  routes?: Omit<RouteRequest, "body" | "scale_m">[];
  assumptions?: Assumption[];
}

interface PlanSite {
  site_id: string;                               // "S1", "S2", … in pick order
  role: "anchor" | "diversity" | "candidate";
  location: Location; terrain: TerrainValues; similarity: Similarity | null;
  constraints_check: SiteEvaluation["constraints_check"];
  nearest_other_site_m: number | null;
  rationale: string;                             // generated from real numbers only
  evidence_flags: string[];
  status_label: string;
}

interface MissionPlan {
  schema_version: "0.1.0";
  plan_id: string;                               // deterministic: "plan_" + first 12 hex of plan_hash
  plan_hash: string | null;                      // sha256 of canonical JSON excluding `meta`; set by hashPlan()
  request: MissionRequest;                       // echoed exactly
  model: { label: string; disclaimer: string; similarity_version: string; intel_version: string; planner_version: string };
  data_provenance: { dataset_id: string; sha256: string | null; source: string }[];  // from manifest / summaries
  sites: PlanSite[];
  portfolio_comparison: object | null;
  routes: RouteAssessment[];
  evidence: { gaps: object[]; plan_limitations: string[]; unavailable_for_this_plan: { capability: string; reason: string }[] };
  assumptions: Assumption[];
  status: "complete" | "partial" | "infeasible";
  meta: { generated_utc: string };               // excluded from the hash
}
```
`plan.evidence.unavailable_for_this_plan` is mandatory and lists, from `capabilities()`, every capability a reader might assume but the data cannot support (thermal, power, illumination, Mars/Moon climate, soil).

#### `planner.validatePlan(plan)` → `Result<{ valid: boolean; issues: { path: string; message: string }[] }>`
Checks schema version, required labels, provenance on every constraint/assumption, `null` integrity, separation constraint, and that site values equal the loaded CSV/engine values (detects stale plans after a data or weight change → `PLAN_STALE`).

#### `planner.getEnvironment({ body, site_id? })` → `Result<Environment>`  *(for Person 3)*
```ts
interface Environment {
  body: Body;
  variables: { name: string; unit: string; n: number; min: number; max: number; mean: number;
               period: string; spatial: "single grid cell"; origin: "modelled (NASA POWER AG)";
               provenance: "dataset" }[];
  unavailable: { variable: string; reason: string }[];   // from data.unavailable + evidence gaps
}
```
Earth returns the five POWER variables from the summary; Mars and Moon return `variables: []` and the `unavailable` list. **It never returns estimated or typical values.**

#### `planner.exportPlan(plan, format)` → `Result<string>`  with `format: "json" | "markdown"`
Markdown follows the existing brief structure (sites, findings, limits, evidence limitations, disclaimer).

#### `planner.hashPlan(plan)` → `Promise<string>`
SHA-256 of canonical JSON (sorted keys, no `meta`). Uses `crypto.subtle` (browser) or `crypto` (Node).

#### Events
`planner.on(event, fn)` → `off()`. Events: `plan:created`, `plan:invalid`, `progress {stage, done, total}`.

### 5.4 Error and warning codes

| Error code | Meaning |
|---|---|
| `INVALID_REQUEST` | Schema violation (details list paths) |
| `UNKNOWN_BODY`, `UNSUPPORTED_SCALE` | Bad `body` / `scale_m` |
| `DATA_NOT_LOADED` | Needed CSV/summary not loaded; `hint` says call `ensureData` |
| `CONSTRAINT_MISSING_PROVENANCE` | Constraint or assumption lacks `provenance` / `source_note` |
| `CONSTRAINT_REQUIRED` | `assessRoute` called without constraints |
| `UNSUPPORTED_COORDINATE_INPUT` | lon/lat input for a non-WGS84 body |
| `OUT_OF_DOMAIN` | Point outside the processed window |
| `CELL_NOT_EVALUABLE` | Border cell, all metrics `null` |
| `NO_FEASIBLE_SITES` | Constraints leave no eligible cells (`details.excluded_by_constraints`) |
| `UNAVAILABLE_DATA` | Request needs a dataset the project lacks (e.g. Mars temperature) |
| `PLAN_STALE` | Plan values no longer match loaded data/engine |

| Warning code | Meaning |
|---|---|
| `SCALE_DIVERGENT` | 120 m and 360 m scores differ by more than 15 points |
| `LOW_CONFIDENCE`, `PARTIAL_COMPLETENESS` | From engine confidence/completeness |
| `COARSE_RESOLUTION_FOR_ROUTING` | Always present on routes |
| `NON_WGS84_COORDS` | Mars/Moon location |
| `MODELLED_CLIMATE`, `SINGLE_POINT_CLIMATE` | Earth POWER caveats |
| `WEIGHTS_NOT_FITTED` | Default weights are expert judgement |

### 5.5 Contract for Person 2 (Frontend)

**Boot (PROPOSED change, after the existing scoring step):**
```js
FZ.planner = FieldZeroPlanner.create({ data: FZ.data, analysis: FZ.analysis, rows: FZ.rows, gaps: FZ.gaps });
```

| UI feature | Call | Render |
|---|---|---|
| Mission setup form | `capabilities()` | Offer only constraint metrics and bodies returned; show `features_not_supported` as disabled with the reason. |
| Define constraints | none (form) | Each constraint must have value, op and a **source note** field; the planner rejects it otherwise. Do not pre-fill thresholds. |
| Find / rank sites | `findSites` | Table: rank, location, score, confidence, limiting feature, `scale_check.consistency`. |
| Site detail | `evaluateLocation` | Per-feature bars (existing `.fbar` pattern: `similarity.features[f].score`), value vs `reference_center`, contribution, `evidence_flags`. |
| Portfolio | `buildPortfolio` | Existing portfolio cards; `rationale` text. |
| Route | `assessRoute` | Polyline from `path[].location`; panel with `length_m`, `max_slope_deg`, `blocked_segments`, and the limitations text. |
| Plan view | `createPlan` | Sites + routes + evidence section + `unavailable_for_this_plan` list. |
| Export | `exportPlan` | Download `.md` / `.json` (same pattern as the existing brief buttons). |
| Evidence panel | `plan.evidence` | Same card layout as `FZ.gaps.items`. |

**Mandatory display rules**
1. Show `status_label` on every site and the plan's `model.disclaimer` on every plan view and export.
2. `null` ⇒ "n/a". Never show 0 for a missing value.
3. Show a provenance badge wherever a value is `user_input`, `assumption` or `simulated`; a simulated value must never look like measured data.
4. Show confidence and, when `scale_check.consistency === "divergent"`, a visible warning (the top Mars candidate is divergent).
5. Coordinates: draw on the OSM tile basemap **only** when `location.crs === "WGS84"`. For Mars/Moon use metres in `x_m_localTM, y_m_localTM` on `L.CRS.Simple`.
6. Never compare `elevation_m` across bodies.
7. Plans are immutable. To change inputs, call `createPlan` again; do not edit a plan object.

**Frontend work items implied (not to be done now):** extend `FZMap` overlays and `focus` to Mars/Moon (and decide whether to switch Mars/Moon plotting to `x_m_localTM/y_m_localTM` so plan sites align with the cells); add a "Plan" chapter in `app.js`; extend the brief export.

**Performance:** keep `findSites`/`createPlan` off the first paint; each is a synchronous call over ≤ 68,944 cells. If a call is measured to block the UI, run the planner in a Web Worker using the message form in §4.2.

### 5.6 Contract for Person 3 (Simulation & Operations)

**What the planner gives you**
- `MissionPlan` (sites, routes, evidence, assumptions) — by object or by `outputs/plans/<plan_id>.json`.
- `getGrid()` for terrain rasters (elevation, slope, roughness, TRI) at 120 or 360 m.
- `getEnvironment()` for the real climate variables that exist (Earth only; five POWER variables, 2023, one modelled grid cell).

**What the planner does NOT give you** (no data exists; do not expect a default)
- Mars or Moon temperature, pressure, wind, solar flux, humidity, illumination.
- Earth `T2M`, hourly or multi-year climate.
- Rover/lander/habitat parameters (mass, power, thermal limits, speed), soil properties.

If the simulation needs one of these, it must either (a) receive it as an explicit `Assumption` with `provenance: "user_input"` or `"assumption"` and a `source_note`, or (b) the project must first acquire the dataset (candidates are researched in `metadata/DATASET_INVENTORY.md`: MEDA, Diviner, LOLA illumination).

```ts
interface SimulationInput {
  plan_ref: { plan_id: string; plan_hash: string };
  scenario: { id: string; name: string; site_ids: string[]; route_indices?: number[] };
  assumptions: Assumption[];                       // all non-dataset inputs, each with provenance + source_note
  required_inputs: { name: string; unit: string | null; needed_for: string }[];  // what the sim declares it needs
}

interface SimulationResult {
  schema_version: "0.1.0";
  sim_id: string;
  plan_ref: { plan_id: string; plan_hash: string };
  simulator: { name: string; version: string };
  status: "completed" | "partial" | "failed" | "blocked_missing_inputs";
  inputs_used: Assumption[];
  missing_inputs: { name: string; reason: string }[];        // e.g. "Mars 120 m site temperature: dataset unavailable"
  outputs: { metric: string; unit: string | null; site_id?: string;
             value?: number | null; series?: { t: (number | string)[]; v: (number | null)[] };
             provenance: "simulated" }[];                    // always "simulated", never "dataset"
  limitations: string[];
}
```

**Rules**
1. Simulation does not modify the plan. It returns a `SimulationResult` keyed by `plan_ref`; the frontend displays it next to the plan.
2. All outputs are `provenance: "simulated"`. Anything derived from an assumption must list that assumption in `inputs_used`.
3. If a required input is unavailable, return `status: "blocked_missing_inputs"` with `missing_inputs` filled. Do not fall back to typical values.
4. A stale plan (`plan_hash` no longer matches) must be re-run, not reused.
5. Terrain access is read-only; local TM metres are the shared coordinate system.

### 5.7 Worked example (real values)

The top Mars candidate in `outputs/top_candidates.json` (VERIFIED), shown as the planner's `PlanSite` core. Fields not present in the source file are marked.

```json
{
  "site_id": "S1",
  "role": "anchor",
  "location": {
    "body": "earth", "scale_m": 120, "crs": "WGS84",
    "cell_index": "<derived by planner from x/y; not in the source file>",
    "lon_deg": 28.112981, "lat_deg": 27.43807,
    "x_m_localTM": -3660, "y_m_localTM": 15300,
    "elevation_m": "<from Earth 120 m CSV row>"
  },
  "similarity": {
    "target_body": "mars", "score": 98.72, "rank": 1, "confidence": "medium",
    "completeness": 1, "limiting_feature": "tri", "n_outside_ref_range": 0,
    "features": {
      "slope_deg":            { "value": 2.3189,  "reference_center": 2.277,  "score": 98.44, "contribution": 29.53 },
      "roughness_std":        { "value": 4.1214,  "reference_center": 4.1192, "score": 99.95, "contribution": 19.99 },
      "elev_variability_std": { "value": 6.5774,  "reference_center": 6.6422, "score": 99.15, "contribution": 29.75 },
      "tri":                  { "value": 13.8859, "reference_center": 13.466, "score": 97.24, "contribution": 19.45 }
    },
    "scale_check": { "score_360m": 77.49, "delta_120m_minus_360m": 21.22, "consistency": "divergent" }
  },
  "evidence_flags": ["scale_divergent"],
  "status_label": "Terrain-metric similarity candidate. Not a confirmed analog."
}
```
This is exactly the case the frontend must not present as a clean "98.72 match": the 360 m check disagrees by 21 points and the plan must show that.

---

## 6. Work split and ownership

| Item | Owner |
|---|---|
| `mission-planner.js`, schema, error/warning codes, regression tests | Person 1 |
| Plan chapter, constraint form, map overlays for all three bodies, provenance badges, export UI | Person 2 |
| Simulator(s), `SimulationInput/Result` handling, assumption registry, environment needs list | Person 3 |
| Data acquisition (T2M re-download, MEDA, Diviner, illumination) | Project-level decision; blocks any thermal/power/illumination planning |

## 7. Acceptance tests for the planner (all on the real data, Node)

1. **Regression:** `buildPortfolio({target:"mars", n:5, min_separation_m:2000})` with no constraints equals `outputs/mission_portfolio.json` (same picks, same scores), and likewise for Moon.
2. **No recomputation:** every `PlanSite.similarity.score` equals `analysis.results[target][scale].cells[cell_index].score`.
3. **Determinism:** two `createPlan` calls with the same request produce identical JSON except `meta`.
4. **Constraints:** every returned site passes every constraint; `excluded_by_constraints` + eligible = total evaluable cells.
5. **Separation:** pairwise distance between sites ≥ `min_separation_m`.
6. **Null integrity:** border cells return `CELL_NOT_EVALUABLE`; no `0` appears where the source is `null`.
7. **Provenance:** `createPlan` rejects any constraint or assumption lacking `provenance` or `source_note`.
8. **Routes:** a path never crosses a `null` cell or a cell violating a constraint; infeasible requests return `feasible: false` with `blocked_segments`.
9. **Unavailable data:** `getEnvironment("mars")` and `("moon")` return empty `variables` and a non-empty `unavailable`; Earth returns exactly the five POWER variables and lists `T2M` as unavailable.
10. **Coordinates:** a lon/lat lookup on Mars/Moon returns `UNSUPPORTED_COORDINATE_INPUT`.
11. **Staleness:** changing `weights` after plan creation makes `validatePlan` report `PLAN_STALE`.

## 8. Decisions needed before implementation

1. **Mission types.** The model currently supports "Earth analog campaign for a Mars/Moon target" and "terrain-only study on a body's own window". Are there other mission types (and objectives) the team wants? Nothing in the project defines them.
2. **Constraint thresholds.** The project has no slope/roughness limits for any vehicle. Who supplies them, and from which source? The planner will reject unsourced thresholds.
3. **Person 3's runtime** (JS in-browser, Node, or Python) — decides whether the exchange is in-process or JSON files.
4. **Mars/Moon plotting origin** — keep the current equirectangular-from-centre display or move to `x_m_localTM/y_m_localTM` so plan sites align exactly with plotted cells.
5. **Climate-dependent planning.** Thermal/power/illumination features stay disabled until the data in §1.3 is acquired. Is that acquisition in scope? (Re-running the Earth `T2M` download is the smallest first step.)
6. **Security item** in §1.5 #1 should be handled before the repository is shared with Persons 2 and 3.

## Appendix A — File map

| Purpose | Path |
|---|---|
| Manifest (21 datasets, schema 2) | `website/site_manifest.json` |
| Loader / engine / intelligence / map / charts / app | `website/js/{data-loader,similarity-engine,mission-intelligence,map,charts,app}.js` |
| Terrain data | `Data/processed/{Earth,Mars,Moon} files/*_{120,360}m_terrain{.csv,.geojson,_summary.json}` |
| Earth climate | `Data/processed/Earth files/earth_western_desert_power_{daily.csv,summary.json}` |
| Cross-body comparison | `Data/processed/comparison_120m.csv` |
| Existing outputs | `outputs/{top_candidates,mission_portfolio,evidence_gaps}.json`, `outputs/earth_{mars,moon}_similarity.geojson` |
| Methodology | `metadata/SIMILARITY_METHODOLOGY.md`, `reports/intelligence_methodology.md` |
| Dataset research (not downloaded) | `metadata/DATASET_INVENTORY.md` |
| Per-planet status | `reports/status_{earth,mars,moon}.md` |
| Proposed new module | `website/js/mission-planner.js` (does not exist yet) |
