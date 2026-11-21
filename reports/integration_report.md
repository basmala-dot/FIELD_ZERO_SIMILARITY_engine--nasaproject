# FIELD//ZERO Task 4: Full System Integration Report

Date of run: 2026-11-21. Scope: connect the existing Mission Builder, planning engine, simulation engine and the five Person 3 modules into one workflow, without rebuilding the project and without touching the scientific datasets.

## 1. Verdict

The end-to-end workflow **was executed successfully** on the real project datasets, in Node (170 automated checks) and in a real Chromium browser (ad-hoc run, see section 8 for what that run does and does not prove). Full integration is claimed only for what is listed as verified below; section 9 and `known_issues.md` list what is not verified.

## 2. The API mismatch (investigated, confirmed, resolved)

| Piece | What it actually exposes / expects |
|---|---|
| `mission-ui.js` (before) | expected `window.FieldZeroMission = { catalog, validate, plan, run, runScenario }`, a "contract 1.0" with its own run schema (`timeline.samples[].lon_deg/lat_deg`, `failures[].recovery.options`, `cost.low/expected/high`, `success_probability`). |
| `mission-engine.js` | exports `{ version, create, fromFZ, MissionError }`. `create()` returns an instance with `run(config)`, `optimize`, `planRoute`, `exportSimulationScenario`. `run()` takes the planner's own config (`targetBody`, `rover.massKg`, `resources.energyBudgetWh`), not the builder setup. |
| `route-simulation.js` | wants `FZ-PLAN-PROVISIONAL-0.1`: waypoints, per-leg segments (length, slope, roughness, polyline), objectives, constraints. It outputs x/y positions only (no lon/lat). |
| Result: | `FieldZeroMission.run` is `undefined`. The old UI could not have worked against the real engine. The integration test asserts this finding (`FINDING CONFIRMED`). |

Resolution: a new adapter, `website/js/mission-integration.js`, implements contract 1.0 as `window.FieldZeroIntegration.api` and maps every schema in both directions. `mission-ui.js` now reads that adapter. `window.FieldZeroMission` is left as the planner namespace and is never called by the UI.

## 3. Data flow (who owns what)

```
Mission Builder (FZShell.getSetup)
  -> setupToConfig / validateMissionConfig        [integration + mission-model]
  -> engine.run(config)  FAST/SAFE/SCIENTIFIC      [mission-engine: sites, routes, route risk, estimates]
  -> buildSimPlan (route waypoints + per-step segments + terrain-table roughness) [integration, pure mapping]
  -> FieldZeroSim.createSimulation                 [route-simulation: position, time, battery, events]
  -> FieldZeroScenario.applyChanges (+ run)        [scenario-engine: meaning of each what-if change]
  -> FieldZeroFailure.analyze / executeRecovery    [failure-analysis]
  -> FieldZeroCost.compute                         [cost-engine]
  -> FieldZeroResults.build / toMarkdown           [mission-results: verdict, limitations, dossier text]
  -> assembleRun -> mission-ui renders             [integration reshapes; UI displays]
```

Mappings (all documented in the file header): builder `vehicle.speed_mps_flat` -> planner `nominalSpeedMps` and sim `nominal_speed_mps`; `power_w` -> planner base power and sim drive/idle/dwell power; equipment mass and power are added to planner mass/base power and to sim dwell power; `min_battery_pct` -> sim `min_soc_frac` and planner reserve fraction; `max_duration_s` -> planner time budget and sim `max_mission_s`; planner applied slope limit -> sim `constraints.max_slope_deg`.

## 4. Workflow coverage

| Stage | Implementation | Verified by |
|---|---|---|
| Mission Builder | existing shell; added "Rehearse on" (Earth analog or destination terrain) with start/goal x,y for Mars/Moon | browser run, test sec. 2 |
| Analog Intelligence / Site Selection | existing portfolio and ranking; selected site becomes the planner goal | test sec. 0, 3 |
| Route Planning | `engine.run` with `strategy: 'ALL'` | test sec. 3 |
| FAST / SAFE / SCIENTIFIC | each route is simulated at plan time so the cards show simulated duration, distance, energy, cost, outcome | test sec. 3, 5 |
| Virtual Rehearsal | nominal run per strategy; Play, Pause, Resume, Reset, speed, scrub (existing controls) | test sec. 5; browser |
| What-If | events: blocked leg, traction loss, steeper terrain, longer path; triggers: time, leg, waypoint; optional magnitude, probability, seed; baseline comparison | test sec. 6; browser |
| Failure Analysis / Recovery | failures with cause, impact, location; recovery options evaluated by the failure module; chosen policy executed | test sec. 6; browser |
| Cost Analysis | estimated vs simulated cost per line, energy margin, equipment hours, budget and time-limit checks | test sec. 7; browser |
| Mission Dossier | on-page report, `.json` result export (existing), new `.md` dossier export | test sec. 9; browser (both downloads) |

## 5. Map and coordinate systems

- Earth rehearsal: WGS84 on the street basemap. Rover position is simulated x/y projected onto the real route cells and interpolated between the planner's own cell centres (the sim emits x/y only).
- Mars and Moon rehearsal: `run.map.crs = 'local_m'`. The map is `L.CRS.Simple` in metres (`x_m_localTM`, `y_m_localTM`) with **no basemap**. Body lon/lat are never drawn on an Earth map. A frame note under the map states the frame in use.
- Verified in Node (every simulated Mars and Moon position lies inside the real x/y grid; `crs` is `local_m`) and in the browser run (Mars map created with the Simple CRS; the tile-layer counter did not increase).

## 6. Changes by file

| File | Change |
|---|---|
| `website/js/mission-integration.js` | **new.** Contract-1.0 adapter, schema mappings, scenario splicing, detour planning through the planner, run assembly, markdown dossier. |
| `website/js/mission-ui.js` | engine lookup via adapter; map frame follows run CRS (Simple for Mars/Moon); validation accepts local frames; strategy cards/tiles show simulated outcome instead of an invented probability; cost table shows Estimated vs Simulated; compare table gains Risk index and an "After recovery" row; magnitude field; launch gated until data ready; dossier `.md` download. |
| `website/index.html` | loads the engine and Person 3 modules in dependency order, then `mission-integration.js`, and `mission-ui.js` after the inline shell; rehearsal-terrain and start/goal fields; magnitude field; label and table-header updates; shell reads the new fields. |
| `website/js/app.js` | dispatches `fz:data-ready` / `fz:data-failed` so the UI unlocks planning only when data and analysis exist (3 lines). |
| `scripts/test_field_zero_integration.js` | **new.** End-to-end test on real datasets. |
| `reports/integration/*.md` | **new.** This report and `known_issues.md`. |

Not modified: the scientific datasets, the similarity engine, the planner, simulation, scenario, failure, cost and results modules, `style.css`, `charts.js`, `map.js`.

## 7. Test results (exact)

Run from the project root on Node v22.

| Command | Result |
|---|---|
| `node scripts/test_field_zero_integration.js` | **PASSED 170, FAILED 0** (exit 0) |
| `node scripts/test_simulation_ops.js` (existing) | **51 PASS, 0 FAIL**, "ALL CHECKS PASSED" (identical before and after my changes) |
| `node scripts/validate_similarity.js` (existing) | **22 PASS, 0 FAIL**, "all gated tests passed" (includes byte-for-byte reproduction of the dataset outputs, so datasets are unchanged) |
| `node scripts/smoke_test_dom.js` (existing) | **cannot run**: `Cannot find module 'jsdom'`. jsdom is not installed and the sandbox has no network. Same failure before my changes. Not counted as pass or fail. |
| `scripts/run_similarity.js`, `run_intelligence.js`, `crosscheck_similarity.py` | not run (data generators, not tests). |

What the integration test covers (real data, no fixtures): contract confirmation and the mismatch finding; valid and invalid setups with field-level messages; typed errors for bad setup and missing data; three real strategies with checks against the engine's own route distance, goal row, constraints and rover capabilities; nominal runs for FAST, SAFE, SCIENTIFIC (monotonic timeline, start at planned start, end at goal, positions inside the real grid, energy ledger balance, determinism, no NaN/undefined); plan-card values equal rehearsal values; failure injection (blocked leg) that interrupts the run before the route end, failure analysis, evaluated recovery options, executed detour recovery planned by the real planner, partial-acceptance contrast, one-cell leg limitation, traction loss, steeper terrain with slope-limit failure, time/leg/waypoint triggers, probability and seed behaviour, leg-1 equivalence with the scenario engine, bad-input handling; cost lines, energy margin, equipment hours, budget/time checks, tight-battery battery failure; Mars and Moon rehearsals in local metres; markdown dossier; script order and DOM-id audit of `index.html`.

## 8. Browser verification (ad hoc, not part of the repo)

I drove the real page in headless Chromium (Playwright) with the real datasets: builder -> launch -> plan -> choose SAFE -> Play/Pause/Resume/Reset -> what-if "blocked leg + detour" -> failure panel -> cost panel -> `.md` and `.json` downloads, once on Earth and once with Mars terrain. All steps worked and the page logged no console errors in the Mars run.
**Limits of that run:** Leaflet and Chart.js come from a CDN that is blocked here, so I substituted small recording stubs. It proves the page logic, the CRS choice (Simple vs EPSG3857), and that no tile layer is added for Mars, but **not** real map rendering, tile loading, or zoom behaviour of `L.CRS.Simple` with real Leaflet. That script lives in `/tmp` and is not delivered because the task listed only two new files.

## 9. What is not verified

- Real Leaflet/OSM rendering and `fitBounds` behaviour on the Simple CRS (stub only).
- `smoke_test_dom.js` (jsdom missing).
- Visual layout on narrow screens: no CSS was changed and new fields reuse existing classes, but I did not screenshot mobile widths.
- Moon rehearsal ran in Node (one real route) but not in the browser.

See `known_issues.md` for modelling limits and design decisions that affect interpretation.
