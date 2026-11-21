# FIELD//ZERO — Simulation Validation, Testing & Findings (Person 3, Task 2)

**Date of execution:** 2026-11-21 · **Runtime:** Node v22.23.5 · **Scope:** `route-simulation.js`, `scenario-engine.js`, `failure-analysis.js`, `cost-engine.js`, `mission-results.js`
**Companion document:** `reports/simulation/simulation_api.md` (integration contract for Person 2)

Everything below was executed. Where something was not tested it is listed under "Not tested / limitations".

---

## 1. Summary of findings

1. **Main defect (integration): the simulation modules could not consume the real planning engine's output.** The real planner (`FieldZeroMission`, `mission-engine.js`) exports `exportSimulationScenario()` → `kind: "fieldzero_simulation_scenario"`. The simulator expected a different, hand-written "provisional" plan (`FZ-PLAN-PROVISIONAL-0.1`). Nothing bridged the two. Feeding the raw export to `FieldZeroSim.run()` did **not fail** — it ran "successfully" while silently dropping all terrain (`SEGMENT_SLOPE_MISSING` on 4 of 4 legs), ignoring the planned 3-D path lengths (straight lines used instead) and losing the site stop as an objective. The existing test suite never caught this because it only used a hand-built fixture.
   **Fix:** added `FieldZeroSim.fromMissionScenario()` (additive; no existing function changed). Verified on real planner exports for Earth, Mars and Moon (§4).
2. **Coordinate-reference gap:** outputs carried lon/lat with no statement of which system they are in; unknown or missing `plan.body` was accepted silently. **Fix:** `report.coordinate_reference`, `state.position.wgs84`, body validation, and rejection of a Mars/Moon plan that claims WGS84.
3. **Cost engine:** an equipment item with an unknown `duty` leaked `NaN` into the ledger and could create a bogus shortage; invalid or unknown cost rates were dropped silently. **Fixed.**
4. **Scenario engine:** threw (instead of returning an error object) on a non-array `scenarios`, a `null` entry, and non-array sweep `values`; duplicate scenario ids were accepted; a `reserve_frac` change that could not take effect was reported as "applied". **Fixed.**
5. **Mission results:** a route that finished while constraints were violated (possible under `record_and_continue`) was only caveated implicitly. Now an explicit criterion and rationale state the violation. The verdict was already never plain `SUCCESS` in the cases I could construct (violations always produce a negative margin); the fix makes the reason explicit.
6. **Failure analysis: no defects found; file left unmodified.** All probes (invalid reports, no context, switched-off recovery, malformed alternatives, record-and-continue, input immutability) behaved correctly.
7. **Everything else validated** as listed in §3: determinism, step-size independence, energy balance, pause/resume/reset, resume-equals-continuous, unavailable-recovery handling, measured-vs-simulated separation.

**Final results:** `scripts/test_simulation_validation.js` → **145 checks, 145 passed, 0 failed.** `scripts/test_simulation_ops.js` → **51 PASS lines, ALL CHECKS PASSED**, output byte-identical to its pre-change baseline.

---

## 2. Commands executed and actual results

All commands run from the project root.

| # | Command | Result |
|---|---|---|
| 1 | `node scripts/test_simulation_ops.js` (before any edit) | exit 0, 51 PASS, ALL CHECKS PASSED |
| 2 | `node scripts/test_simulation_ops.js` (after edits) | exit 0, 51 PASS; output **identical** to run 1 |
| 3 | `node scripts/test_simulation_validation.js` (first run) | 3 FAIL, then aborted (see §6, all three were test-fixture errors, not module defects) |
| 4 | `node scripts/test_simulation_validation.js` (after fixture correction) | exit 0, **145 checks, 145 passed** (118 tagged `[REAL]`, 27 `[SYNTH]`/`[SYNTH-ENV]`) |
| 5 | same command, second process | exit 0; output **identical** to run 4 (cross-process repeatability) |
| 6 | the new test run against the **original** code snapshot | aborts at the first adapter call: `TypeError: Sim.fromMissionScenario is not a function` (proves the new test detects the original gap) |
| 7 | `diff -rq` original snapshot vs final tree | only the 4 modules below + 1 new test file differ; no dataset, planner or frontend file changed |
| 8 | documented quick-start (API doc §2) executed verbatim | `report completed / failure no_failure / cost ok / scenarios ok / results ok` |

**Not run on purpose:** `scripts/run_intelligence.js` and `scripts/run_similarity.js` overwrite files in `outputs/` and `reports/`. The new test loads datasets read-only via the project's own `scripts/similarity_io.js` and writes nothing.

**Test-design rule applied:** section A of the new test (real integration) uses the real planner on the real processed datasets. Synthetic inputs are used only for isolated edge cases and are tagged `[SYNTH]`; no `[SYNTH]` result is claimed as evidence of real integration.

---

## 3. Validation by module (what was checked, what was found)

### 3.1 Route simulation (`FieldZeroSim`)
| Requirement | Evidence |
|---|---|
| Input validation | null / `{}` / `waypoints:'x'` / duplicate waypoint ids / segment endpoint mismatch / objective at unknown waypoint / invalid rover numbers / lon-lat without body → all `status:'invalid'` with explicit errors, never simulated |
| Movement & position | Final simulated position equals last planned waypoint to <0.01 m (real routes); position at half the driving time lies inside the route bounds; progress monotonic 0→1; trace/time monotonic |
| Distance / time / resources | segment distances sum to the total; drive+dwell+wait = elapsed; **energy balance closes** (`|start − consumed + generated − curtailed − end| < 1e-6 Wh`) on all 9 real routes |
| Controls | play / pause / resume / reset verified with an injected scheduler; resume-from-snapshot reproduces the uninterrupted run (elapsed and end energy equal within 1e-3); outcome independent of step size |
| Limits | slope (rover- or constraint-governed), battery reserve/empty, time limit, blocked segment, zero mobility all halt with the right code; `record_and_continue` logs violations but an empty battery always stops |
| Coordinates | Earth/Mars/Moon: `coordinate_reference.wgs84` = true / false / false on real exports; lon/lat fallback uses each body's own radius (0.01° at the equator = 1112.0 m Earth, 592.7 m Mars, 303.2 m Moon) and is flagged as an assumption (spherical, not the WGS84 ellipsoid) |
| Defect fixed | no CRS tagging, silent unknown body/options, no adapter (§1) |

### 3.2 Scenario engine (`FieldZeroScenario`)
- What-if creation, parameter modification, baseline vs modified comparison: real Earth FAST plan, baseline `SUCCESS` vs 40 % battery → `FAILED (BATTERY_DEPLETED)`; delta fields equal `scenario − baseline`; a no-op change gives exactly zero delta.
- Deterministic (two runs identical) and non-mutating (baseline plan unchanged).
- Sweep finds the outcome change point (battery scale between 0.3 and 0.6 on this plan).
- Invalid changes are listed as `ignored` with reasons, never silently applied. **Fixed:** throwing on malformed input, duplicate ids, ineffective `reserve_frac`.

### 3.3 Failure analysis (`FieldZeroFailure`)
- Detection and classification: battery, time, slope (rover vs planning-constraint governed), blocked segment; healthy run → `no_failure`; invalid/foreign reports → `invalid_input`.
- Impact: `mission_impact.outcome_without_recovery`, progress and objectives lost; cause decomposition sums to consumed energy.
- Recovery: with **no charging source defined, `WAIT_RECHARGE` is reported `applicable:false`** (not guessed); with an assumed charging source it is evaluated by re-simulation, and an independent replay confirms the recommended wait is sufficient and minimal (5 s less fails). Blocked segment with no planner alternative → `ALTERNATE_ROUTE` unavailable, "does not invent routes". Malformed alternatives rejected. Recovery "not evaluated" when plan/rover absent or switched off.
- **No defect found; unmodified.**

### 3.4 Cost engine (`FieldZeroCost`)
- Total = sum of components; ledger energy equals the simulation and balances; remaining energy = end − reserve; consumables (2 available − 1 used = 1) and equipment dwell hours tracked.
- **Provenance separation:** without telemetry `actuals.measured` and `cost.measured` are `null` and the output says "not measured"; with partial telemetry the measured block stays separate and its missing quantities are `null` with a reason (cost marked incomplete). Rates are labelled `placeholder`; cost is in abstract units.
- Unfinished run → energy shortage estimated (81.91 Wh on the test case).
- **Fixed:** NaN on unknown equipment duty; silent drop of invalid rates; lower-bound note when the estimate skips zero-speed segments.

### 3.5 Mission results (`FieldZeroResults`)
- Results equal the underlying values (progress, cost, energy, objectives) on a real run; repeatable; no NaN/Infinity in any module output; markdown export works and states the coordinate reference.
- Mars results carry the "NOT WGS84" limitation; Earth results carry WGS84.
- Real Earth FAST run: verdict `SUCCESS`, **confidence `low`** (placeholder rover, roughness unknown). Route finished with time-limit violation under `record_and_continue` → `SUCCESS_WITH_CAVEATS` with explicit rationale. **Fixed:** explicit violation criterion/rationale, coordinate reference in meta/limitations.

---

## 4. Real-data integration evidence (adapter on real planner exports)

Real engine (`FieldZeroMission.create({analysis, rows, terrainRows})`) on the real 120 m terrain tables (Earth NASADEM, Mars Jezero CTX, Moon Taurus-Littrow LOLA). Earth: default analog search (target Mars) with a 600 Wh energy budget (25 % reserve) and 8 h time budget. Mars and Moon: operating-body routes between two real grid cells ~3 km apart (cells chosen from the real CSV by slope < 3°).

| Body / strategy | Waypoints | Planner distance (m) | Simulated distance (m) | Planner time / energy | Simulated time / energy | Simulated status |
|---|---:|---:|---:|---|---|---|
| Earth FAST | 5 | 989.6 | 989.6 | 2.586 h / 214.5 Wh | 2.603 h / 231.9 Wh | completed |
| Earth SAFE | 17 | 7311.1 | 7311.1 | planner: *exceeds budget* | halts, battery | halted `BATTERY_DEPLETED` |
| Earth SCIENTIFIC | 23 | 16221.2 | 16221.1 | planner: *exceeds budget* | halts, battery | halted `BATTERY_DEPLETED` |
| Mars FAST / SAFE / SCIENTIFIC | 5 / 10 / 6 | 3630.2 / 4027.3 / 3729.2 | same | 4.13 / 4.32 / 4.17 h | 4.18 / 4.36 / 4.21 h | completed, `wgs84:false` |
| Moon FAST / SAFE / SCIENTIFIC | 10 / 9 / 6 | 3758.5 / 3858.0 / 3758.5 | same | 4.20 / 4.26 / 4.20 h | 4.25 / 4.31 / 4.25 h | completed, `wgs84:false` |

Additional checks executed on these 9 exports: all 91 waypoint coordinates equal the `x_m_localTM / y_m_localTM` of the CSV row they reference (0 mismatches), and **0 of 9 routes** triggered the adapter's non-straight-leg warning.

Interpretation, stated carefully:
- **Route geometry carries over exactly** (distance equal to ≤0.5 m): the simulator uses the planner's real cell path and grades.
- **Time and energy differ by ~1–8 %** on completed routes because the planner and the simulator use *different assumed physics* (planner: rolling-resistance/gravity mechanical model; simulator: linear speed/power rules). This is expected and is not an error; neither is a measurement. The adapter derives the simulator's drive power from the planner's own formula (see API doc §3.1).
- For Earth SAFE/SCIENTIFIC, the planner itself reports the energy budget as exceeded and the simulation independently halts on battery — the two agree qualitatively.

---

## 5. Defects and files changed

| File | Change | Reason |
|---|---|---|
| `website/js/route-simulation.js` (v0.1.0 → v0.2.0) | **added** `fromMissionScenario`, `BODY_CRS`; `report.coordinate_reference`; `state.position.wgs84`; validation of body, options and `coordinate_frame`; clearer lon/lat projection warning | §1 items 1–2 |
| `website/js/cost-engine.js` (→ 0.1.1) | duty validation, ignored-input notes, lower-bound note, shortage guard | §1 item 3 |
| `website/js/scenario-engine.js` (→ 0.1.1) | input validation (no throws), duplicate ids, ineffective `reserve_frac`, sweep validation and row reasons | §1 item 4 |
| `website/js/mission-results.js` (→ 0.1.1) | `no_constraint_violations` criterion + rationale; coordinate reference in meta, provenance, limitations, markdown | §1 item 5 |
| `scripts/test_simulation_validation.js` | **new** test (145 checks) | testing requirement |
| `website/js/failure-analysis.js` | **unchanged** | no defect found |

Compatibility: all pre-existing public functions, names, and output field names are unchanged; changes are additive (new fields `coordinate_reference`, `wgs84`, `ignored_inputs`, a new criterion id, a new verdict *reason*, new status values `invalid_scenario` / `duty_invalid`). The original suite's output is identical.

**API change to report immediately to Person 2:** new function `FieldZeroSim.fromMissionScenario`; new fields listed above; `FieldZeroScenario.run` now returns `{status:'error'}` for a non-array `scenarios` and per-item `status:'invalid_scenario'` instead of throwing.

---

## 6. Test failures encountered during development (full disclosure)

The first execution of the new test had 3 failures; all were mistakes in my test fixtures, not module defects, and I verified that before changing anything:
1. "Position at 50 % of elapsed time": 7,200 s of the 9,370 s route time is the planner's 2 h stop dwell, so 50 % lands at the stop. Test now uses half the *driving* time.
2. `record_and_continue` with a 0 %-reserve battery: an empty battery always stops (documented). Test now uses a time-limit overrun for a route that completes with a violation, and a separate reserve-breach check.
3. Recharge recovery fixture: the charging source must exceed the idle load and the time limit must not bind. The fixture is an **invented test input** (55 W), tagged `[SYNTH-ENV]`.

---

## 7. Issues for other owners (not changed — outside my ownership)

| # | Owner | Issue | Impact |
|---|---|---|---|
| 1 | Person 2 | `website/index.html` loads only `data-loader, similarity-engine, mission-intelligence, map, charts, app`. It does **not** load `mission-model.js`, `mission-engine.js`, `mission-ui.js`, or any of the five simulation modules. | None of the planner/simulation APIs exist in the browser until script tags are added (order in API doc §1). |
| 2 | Person 1 | The planner export contains **no roughness** per cell or leg. | Simulated roughness is `null`; roughness limits cannot be checked on real exports. |
| 3 | Person 1 | The export has **no `alternatives`** (detours). | `ALTERNATE_ROUTE` recovery is always "unavailable" for real routes (correctly reported, not invented). |
| 4 | Person 1 | `expected.resources.energy.budget` is the *spendable* energy (budget × (1 − reserve)); the raw budget and reserve fraction are not separately exported. | The adapter sets simulated reserve to 0 and capacity to the spendable amount. A raw budget + reserve field would remove this workaround. |
| 5 | Person 1 / project | No charging, illumination, thermal or dust data exist for Mars/Moon (and Earth POWER has no T2M). The planner says "solar recharge is not modelled". | Simulated charging is 0 unless a caller supplies an explicit assumption; recharge recovery is then unavailable. |
| 6 | Person 1 | The planner's `grid.y0_m` is the *minimum* y while rows run north→south; waypoints carry correct `x_m,y_m`. | The adapter uses only the waypoint coordinates and verifies leg straightness; nobody should reconstruct cell positions from `row_index` + `y0_m` without checking orientation. |

---

## 8. Not tested / known limitations

- **No browser test.** Modules were tested in Node only. They use the same UMD pattern as the loaded modules, but a browser load order and global-name check has not been executed (the pages do not load them yet).
- **No real rover, no telemetry.** All rover parameters are planner placeholders or test inputs. Every time/energy/cost figure is **simulated under an assumed model** — not a prediction, not validated, not flight-qualified. Verdict confidence is capped at `medium` and is `low` for placeholder rovers.
- **Planner vs simulator physics differ** (§4); there is no ground truth to say which is closer to reality.
- **Slope data is coarse.** Grades come from 120 m DEM cell centres and a 240 m slope baseline; they are not rover-scale hazards.
- **Position interpolation:** between waypoints positions are linear. On a leg that is not straight the adapter warns that positions may deviate from the planned cells (none occurred in the 9 real routes tested, but only 9 routes were tested). Plot `x_m/y_m`, not interpolated `lon_deg/lat_deg`.
- **360 m scale** exports were not tested through the adapter (the adapter is scale-agnostic; only 120 m was exercised).
- **Moon/Mars routes** were tested for one start/goal pair per body.
- **Performance:** typical calls take milliseconds (e.g. `Sim.run` on a 23-waypoint route ≈ 1 ms; `Results.run` with 3 scenarios and attribution ≈ 4 ms) on this Node host; browser timing not measured. The planner itself (similarity scoring) takes about 3 s to initialise.
- **Similarity is not safety.** The similarity score used by the planner to choose sites says nothing about operational safety; no module here treats it as such, and `similarity` is not an input to any simulation module.
- **Earth terrain is never used as Mars/Moon terrain:** Earth analog routes keep `body:'earth'` and WGS84; Mars/Moon plans exist only when the planner was run with Mars/Moon as the operating body on that body's own DEM.
- `FieldZeroFailure.executeRecovery` only *reports* the already-simulated outcome of a recovery; there is no function to apply a recovery to a live running controller (see API doc §8).
