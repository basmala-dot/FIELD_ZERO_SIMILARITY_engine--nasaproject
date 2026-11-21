# FIELD//ZERO — Simulation Modules: Integration API Contract (for Person 2)

**Versions:** `route-simulation` 0.2.0 · `failure-analysis` 0.1.0 · `cost-engine` 0.1.1 · `scenario-engine` 0.1.1 · `mission-results` 0.1.1
**Rule of this document:** every function listed exists in the code and was executed in `scripts/test_simulation_validation.js`. Things that do **not** exist are listed in §10 — do not assume them.
**All values are SIMULATED under an assumed model unless a field says otherwise. Nothing here is a measurement, a prediction, or a safety assessment.**

---

## 1. Modules, load order, initialisation

| Module | Browser global | Node |
|---|---|---|
| `website/js/route-simulation.js` | `window.FieldZeroSim` | `require('./route-simulation.js')` |
| `website/js/failure-analysis.js` | `window.FieldZeroFailure` | `require('./failure-analysis.js')` |
| `website/js/cost-engine.js` | `window.FieldZeroCost` | `require('./cost-engine.js')` |
| `website/js/scenario-engine.js` | `window.FieldZeroScenario` | `require('./scenario-engine.js')` |
| `website/js/mission-results.js` | `window.FieldZeroResults` | `require('./mission-results.js')` |

- **No `init()` and no state at module level.** Each module is stateless; just call the functions.
- **Load order (browser):** `route-simulation.js` first, then `failure-analysis.js`, `cost-engine.js`, `scenario-engine.js`, `mission-results.js`. The others look up `FieldZeroSim` (and each other) **at call time** from `window`, so they must all be loaded before the first call. Alternatively pass `deps: { simulation, failure, cost, scenarios }` in the call options.
- **Planner (Person 1) scripts required to produce simulation input:** `data-loader.js`, `similarity-engine.js`, `mission-intelligence.js`, `mission-model.js`, `mission-engine.js` (global `FieldZeroMission`).
- **⚠ Not currently loaded:** `website/index.html` today loads none of `mission-model.js`, `mission-engine.js`, `mission-ui.js` or the five simulation modules. Add the script tags (Person 2).
- No DOM access, no network, no randomness, no wall-clock timestamps. Same input ⇒ byte-identical output (verified across two processes). Inputs are never mutated (verified with deep-frozen inputs).
- Live playback uses `setInterval` (injectable via `options.scheduler`).

## 2. Verified quick start

```js
// planner (Person 1)
const engine   = FieldZeroMission.fromFZ(window.FZ);           // after app.js boot
const out      = engine.run({ targetBody: 'mars', strategy: 'ALL', resources: { energyBudgetWh: 600, timeBudgetH: 8 } });
const scenario = engine.exportSimulationScenario(out.plan, 'FAST');   // throws MissionError NO_ROUTE if that strategy has no route -> try/catch

// simulation (Person 3)
const ad = FieldZeroSim.fromMissionScenario(scenario);          // { ok, plan, rover, errors, warnings, mapping, source }
if (!ad.ok) throw new Error(ad.errors.join('; '));
const ctl = FieldZeroSim.createSimulation(ad.plan, { rover: ad.rover, stepSeconds: 60 });
ctl.on('state', s => render(s));                                // live view
const report   = ctl.runToEnd();                                // or ctl.play() / ctl.tick()
const failure  = FieldZeroFailure.analyze(report, { plan: ad.plan, rover: ad.rover });
const cost     = FieldZeroCost.compute({ report, plan: ad.plan, rover: ad.rover });
const scenarios= FieldZeroScenario.run({ plan: ad.plan, rover: ad.rover, scenarios: [{ id: 'low-battery', changes: { resources: { battery_capacity_scale: 0.4 } } }] });
const results  = FieldZeroResults.run({ plan: ad.plan, rover: ad.rover, scenarios: [ /* same list */ ] });   // one-call alternative to the four lines above
```
(Executed verbatim in Node: `report completed | failure no_failure | cost ok | scenarios ok | results ok`.)

**Always pass the same `plan` and `rover` objects (the adapter's output) to every module.** Pass `ad.rover`, not the planner's vehicle.

## 3. Inputs

### 3.1 `FieldZeroSim.fromMissionScenario(scenario, options?)`  — NEW in 0.2.0
Converts the **real** planner hand-off (`exportSimulationScenario()`, `kind:'fieldzero_simulation_scenario'`, `schema_version:'1.0'`) into `{ plan, rover }`.

| Param | Type | Notes |
|---|---|---|
| `scenario` | object (required) | exact output of `exportSimulationScenario` |
| `options.id`, `options.name` | string, optional | override the generated plan id/name |
| `options.rover` | object, optional | fields merged over the derived rover (e.g. a real `battery_capacity_wh`, `parameter_provenance:'supplied'`) |

Returns `{ ok: boolean, plan, rover, errors: string[], warnings: string[], mapping: [{field, source, provenance, derivation?}], source: {kind, schema_version, body, scale_m, strategy, path_cells, waypoints} }`. On `ok:false`, `plan` and `rover` are `null` and `errors` says why. It never throws.

Mapping applied (all listed again in `mapping`):

| Simulation field | From the planner export | Provenance |
|---|---|---|
| `plan.waypoints[]` `{id,x_m,y_m,lon_deg,lat_deg,elevation_m}` | `waypoints[]` (real grid-cell centres) | planner/dataset |
| `plan.segments[i].length_m` | sum of `segments.length_m` (3-D, cell steps) between waypoint *i* and *i+1* | planner estimate |
| `plan.segments[i].slope_deg` | length-weighted mean of `|segments.grade_deg|` | derived from DEM |
| `plan.segments[i].slope_deg_max` | max(`|grade_deg|`, `profile.cell_slope_deg` of the cells on the leg) | derived from DEM |
| `plan.segments[i].roughness_*`, `tri` | **not exported** → `null` (unknown) | — |
| `plan.objectives[]` | one **required** objective per waypoint of `kind:'stop'`; `dwell_s = expected.resources.site_dwell_h_each × 3600` | planner assumption |
| `plan.constraints.max_slope_deg` / `max_roughness_std` | `constraints.applied.slope_limit_applied_deg` / `roughness_limit_applied_m` | user input / planner |
| `plan.constraints.max_mission_s` | `expected.resources.time.budget` (h→s), only if the user set one | user input |
| `plan.coordinate_frame` | `coordinate_frame` | planner |
| `rover.nominal_speed_mps` | `vehicle.parameters.nominalSpeedMps` | placeholder (planner) |
| `rover.idle_power_w`, `dwell_power_w` | `basePowerW` | placeholder |
| `rover.drive_power_w` | `basePowerW + m·g·Crr·v/η` (flat-ground value of the planner's own formula) | derived |
| `rover.slope_power_w_per_deg` | `m·g·v/η·π/180` (small-angle form of the planner's uphill term) | derived |
| `rover.max_slope_deg` | `constraints.user.max_slope_deg` | user input |
| `rover.battery_capacity_wh`, `min_soc_frac:0` | `expected.resources.energy.budget` (already budget×(1−reserve)) | user input |
| `rover.parameter_provenance` | `'assumed'` if `vehicle.is_placeholder` else `'supplied'` | — |

If the export has **no energy budget**, the simulator's placeholder battery (3000 Wh, `assumed`) is kept and a warning says so — supply a real `options.rover.battery_capacity_wh`.
**The planner and simulator use different physical models**: time/energy differ by a few percent (1–8 % on the 9 real routes tested). Compare the simulator to `plan.planner_estimate` (copied from the export), do not treat either as ground truth.

Errors returned (`ok:false`): not an object; wrong `kind`; missing/short `waypoints`/`path`; `segments.length_m|horizontal_m|grade_deg` not arrays of length `path.length−1`; waypoint missing numeric `x_m,y_m,row_index`; waypoint not on `path` in travel order; first/last waypoint not first/last path cell.
Warnings: schema version differs; missing `profile.cell_slope_deg`; legs with a missing grade (left **unknown**, not filled); legs that are not straight (position will be interpolated); roughness not exported; no energy budget; no `stop` waypoints; incomplete `vehicle`.

> Do **not** feed the raw export to `FieldZeroSim.run()`. It runs "successfully" but silently drops all terrain (`SEGMENT_SLOPE_MISSING`) and the objectives.

### 3.2 Plan contract `FZ-PLAN-PROVISIONAL-0.1` (what the simulator reads; produced by the adapter, or hand-built)
```
plan = { contract?, id?, name?, body: 'earth'|'mars'|'moon', coordinate_frame?: {name, lon_lat, wgs84},
  waypoints: [ { id, x_m, y_m, lon_deg?, lat_deg?, elevation_m? } ]        // >= 2 required; ids unique
  segments?: [ { from?, to?, length_m?, path?: [{x_m,y_m}], slope_deg?, slope_deg_max?, roughness_std?, roughness_std_max?, tri?,
                 traction_speed_factor? (0,1], passable? (false = blocked), surface?, terrain_source? } ]   // segments[i] joins waypoints[i]->[i+1]
  objectives?: [ { id, waypoint_id, label?, required? (default true), dwell_s? (>=0), power_w?, requires?: [{resource_id, quantity}] } ]
  constraints?: { max_slope_deg, max_roughness_std, max_mission_s, min_battery_soc_frac },   // absent/null = unconstrained
  environment?: { solar_input_w }      // constant charging power W; absent => 0 and reported as data gap NO_CHARGING_SOURCE
  resources?: [ { id, name, unit, available, unit_cost? } ]                   // consumables (cost engine)
  alternatives?: [ { id, from, to, waypoints: [...], segments: [...] } ]      // planner detours (failure analysis only); NONE exist in real exports today
}
```
Units: metres, degrees, seconds, watts. `x_m,y_m` are local metres (planner: local transverse-Mercator, origin differs per site, valid only within one site). Missing slope ⇒ treated as 0 for arithmetic **and** flagged `terrain_known:false` + data gap (never silently safe).

### 3.3 Rover (`options.rover`, defaults are **assumed placeholders**, `parameter_provenance:'assumed'` unless you set `'supplied'`)
`nominal_speed_mps` 0.1 · `max_slope_deg` 20 · `min_speed_fraction` 0.1 · `roughness_speed_coeff` 0 · `max_roughness_std` null · `battery_capacity_wh` 3000 · `initial_soc_frac` 1 · `min_soc_frac` 0.15 · `drive_power_w` 100 · `slope_power_w_per_deg` 4 · `roughness_power_w_per_unit` 0 · `idle_power_w` 20 · `dwell_power_w` 40 · `condition:{ mobility 1, power_draw_factor 1, battery_health 1, slope_limit_factor 1 }` · `equipment:[{id,name,duty:'drive'|'dwell'|'wait'|'always',available_hours?,cost_per_hour?}]`.
Invalid values ⇒ `status:'invalid'` with the exact reasons in `validation.errors`.

## 4. `FieldZeroSim` — simulation and live state

### 4.1 Functions
| Function | Returns |
|---|---|
| `createSimulation(plan, options?)` | controller (below) |
| `run(plan, options?)` | `createSimulation(...).runToEnd()` → report |
| `estimatePlan(plan, rover, options?)` | `{ errors, warnings, estimate, limits }` analytic pre-run estimate (`estimate:null` if invalid) |
| `validate(plan, rover)` | `{ errors, warnings, data_gaps, limits }` without running |
| `normalizeRover(rover)` | `{ rover, errors, warnings }` |
| `fromMissionScenario(scenario, options?)` | see §3.1 |
| constants | `version, CONTRACT, DEFAULT_ROVER, NOMINAL_CONDITION, ASSUMPTIONS, BODY_RADIUS_M, BODY_CRS` |

`options` of `createSimulation`/`run`: `rover`, `stepSeconds` (60), `tickIntervalMs` (100), `scheduler` `{setInterval,clearInterval}`, `onViolation` (`'halt'` default | `'record_and_continue'`), `traceEveryS`, `environment:{solar_input_w}`, `skipObjectives:[ids]`, `preActions:[{type:'WAIT',duration_s,reason?}]`, `initial` (resume state, §4.4). Unrecognised/invalid option values add a warning to `validation.warnings`.

### 4.2 Controller (`createSimulation`)
| Method | Behaviour |
|---|---|
| `play()` | start timed playback (`stepSeconds × speed` per tick); returns state. No-op (returns state) if invalid/halted/completed |
| `pause()` / `resume()` | stop / restart playback; state frozen while paused |
| `reset()` | back to the initial state of **the same plan/rover**; replay is repeatable. (To change plan/rover create a new controller) |
| `tick(simSeconds?)` | advance manually (default `stepSeconds × speed`); returns state |
| `runToEnd()` | run to completion/halt; returns the **report** |
| `setSpeed(multiplier)` | playback speed (> 0); returns the speed |
| `getState()` | current state (does **not** consume `events_new`) |
| `getReport()` | report so far (valid mid-run) |
| `snapshot()` | `{ state, resume }` — `resume` is a continuation state |
| `applyAction({type:'WAIT',duration_s})` / `({type:'SKIP_OBJECTIVE',objective_id})` | queue a wait / skip an objective; returns `true/false` (false if halted/completed/unknown) |
| `on('state'\|'event'\|'status', fn)` | returns an unsubscribe function. `state`: every `play/pause/reset/tick/runToEnd` (carries `events_new`); `event`: each simulation event; `status`: when `status` changes |
| `validation` | `{ errors, warnings, data_gaps }` of the input |

`status`: `idle` · `running` · `paused` · `halted` · `completed` · `invalid`.

### 4.3 State `FZ-SIM-STATE-0.1` (`getState()` / `'state'` listeners)
```
{ contract, plan_id, tick, status, phase: 'driving'|'dwelling'|'waiting'|'at_waypoint'|'halted'|'done',
  halted: null | { code, message, t_s, segment_index, offset_m, data },
  time:      { elapsed_s, run_elapsed_s, limit_s|null, remaining_s|null },
  position:  { x_m, y_m, lon_deg|null, lat_deg|null, elevation_m|null, wgs84: true|false|null, provenance: 'simulated (interpolated along planned route)' },
  route:     { segment_index, segment_count, segment_id, from, to, distance_traveled_m, total_distance_m, remaining_distance_m, progress_fraction },
  objectives:{ completed[ids], pending[ids], skipped[ids], current|null, total },
  resources: { battery_wh, usable_capacity_wh, soc_frac, reserve_wh, above_reserve_wh, consumed_wh:{drive,dwell,wait,total}, generated_wh, provenance },
  terrain:   { slope_deg, slope_deg_max, roughness_std|null, tri|null, traction_speed_factor, known, source } | null,
  rover:     { speed_mps, condition }, events_new: [event], events_total }
```
`events_new` is filled only in payloads from `tick/play/pause/reset` and `'state'` listeners (it is consumed there); `getState()` returns the same field without consuming it.
**Plotting:** draw from `x_m,y_m`. Use `lon_deg/lat_deg` **only if `position.wgs84 === true`** (Earth, WGS84, on an Earth basemap). Mars/Moon lon/lat are sphere-based and must never go on a WGS84 basemap. `lon/lat` inside a leg are linearly interpolated (simulated), not new data.

### 4.4 Report `FZ-SIM-REPORT-0.1` (`runToEnd()`, `getReport()`)
`{ contract, version, plan_id, plan_name, body, coordinate_reference, rover_id, rover, status, halted, validation:{errors,warnings}, totals, objectives[], objective_summary, segments[], waypoints[], events[], trace[], limits, constraints, plan_estimate, resume, alternatives_available, data_gaps[], assumptions[], provenance }`
- `coordinate_reference`: `{ wgs84: true|false|null, lon_lat: string, local_xy: string, source }`.
- `totals`: `elapsed_s, run_elapsed_s, time_by_activity_s{drive,dwell,wait}, planned_distance_m, distance_in_plan_m, progress_fraction, distance_travelled_this_run_m, energy{ start_wh, end_wh, min_wh, reserve_wh, usable_capacity_wh, nameplate_capacity_wh, consumed_wh{drive,dwell,wait,total}, generated_wh, curtailed_wh, balance_check_wh, decomposition_wh }, time_decomposition_s, provenance`.
- `trace[]`: `{ t_s, x_m, y_m, distance_m, energy_wh, soc_frac, segment_index }` (capped ≈2000 points).
- `events[]`: `{ id, t_s, code, severity: 'info'|'warning'|'violation'|'failure', message, data }`. Codes: `WAYPOINT_REACHED, OBJECTIVE_COMPLETED, OBJECTIVE_SKIPPED, WAIT_STARTED, WAIT_ENDED, ROUTE_COMPLETED, NEAR_SLOPE_LIMIT, TERRAIN_DATA_MISSING`, and failure codes `BATTERY_BELOW_RESERVE, BATTERY_DEPLETED, TIME_LIMIT_REACHED (halt) / TIME_LIMIT_EXCEEDED (violation), SLOPE_EXCEEDS_LIMIT, ROUGHNESS_EXCEEDS_LIMIT, SEGMENT_BLOCKED, ROVER_IMMOBILE, SIM_GUARD`.
- `resume`: `{ elapsed_s, energy_wh, distance_m, segment_index, offset_m, at_waypoint, dwell, completed[], skipped[] }` → pass as `options.initial` to continue.
- Provenance tags used everywhere: `plan`, `simulated`, `estimated`, `assumed`, `unknown`, `measured` (cost engine only), `placeholder`, `user-supplied`.

## 5. How modules exchange mission state and execution order

```
FieldZeroMission.run -> plan -> exportSimulationScenario(plan, strategy)
        -> FieldZeroSim.fromMissionScenario -> { plan, rover }              (shared by ALL modules below)
        -> FieldZeroSim.createSimulation -> controller -> report (FZ-SIM-REPORT-0.1)   <- the shared mission state
              report -> FieldZeroFailure.analyze(report, {plan,rover})  -> failure (FZ-FAILURE-ANALYSIS-0.1)
              report -> FieldZeroCost.compute({report,plan,rover})      -> cost (FZ-COST-0.1)
              {plan,rover,scenarios} -> FieldZeroScenario.run           -> scenarios (FZ-SCENARIOS-0.1)  (re-runs the simulator itself)
              {report,failure,cost,scenarios} -> FieldZeroResults.build -> results (FZ-MISSION-RESULTS-0.1)
        FieldZeroResults.run({plan,rover,...}) does all of the above in one call.
```
The **report object is the state exchanged** between modules. `report.resume` is the continuation point. Modules never mutate their inputs.

**Continue after a failure (what failure-analysis does internally; you can do the same):**
```js
FieldZeroSim.createSimulation(plan, { rover, initial: report.resume,
  preActions: [{ type: 'WAIT', duration_s: 3600 }], skipObjectives: ['OBJ-wp4'] }).runToEnd();
```
(`applyAction` does nothing on a controller that has already halted — create a new controller from `resume` instead.)

## 6. `FieldZeroFailure`
`analyze(report, context?)` → `FZ-FAILURE-ANALYSIS-0.1`. `context = { plan?, rover?, deps?, evaluateRecovery? (false skips), maxBisection? }`. Detection/causes need only the report; recovery evaluation needs `plan` **and** `rover`.
```
{ contract, version, status: 'failure_detected'|'no_failure'|'invalid_input', error?,
  failures: [ { id, code, severity, t_s, detected_by, message, location{segment_index,segment_id,from,to,offset_m,x_m,y_m,provenance},
      causes{ summary, primary, evidence[], demand_side?, supply_side?, items? },
      consequences{ stops_mission, progress_fraction_at_failure, distance_not_travelled_m, required_objectives_incomplete[], optional_objectives_incomplete[], text },
      recovery{ evaluated, feasibility:'full'|'partial'|'none'|'not_evaluated', best_action_id, explanation, actions:[action] },
      mission_impact{ outcome_without_recovery, outcome_with_best_recovery, best_recovery_action_id, required_objectives_lost[], text } } ],
  warnings[], margins{ risk_index, components[], formula }, summary{ failure_count, mission_stopping_failure, recovery_feasibility, best_recovery_action_id, risk_index, text }, assumptions[], limitations[] }
action = { id, type, description, applicable, feasible, feasibility_reason, requires[], estimate{}, outcome{ status, mission_class, required_completed, required_total, progress_fraction, elapsed_s, total_energy_consumed_wh, final_energy_wh, halted_code }|null, tradeoffs[], provenance }
```
Action ids: `ACCEPT_PARTIAL` (always), `WAIT_RECHARGE`, `DESCOPE_OPTIONAL`, `EXTEND_TIME_LIMIT`, `OVERRIDE_PLANNING_LIMIT`, `ALTERNATE_ROUTE` / `ALTERNATE_ROUTE:<id>`.
**Unavailable recovery:** `applicable:false, feasible:false, feasibility_reason:<why>` (e.g. no charging source defined; no planner alternative supplied; limit is the rover's own capability; no optional objectives left). **Never** treat `applicable:false` as feasible. Recovery is evaluated only for the failure that stopped the run. `risk_index` is a heuristic 0–100, **not a probability**.
`executeRecovery(analysis, actionId?)` → `{ executed, reason? | failure_id, action_id, feasible, outcome, estimate, provenance }` — **reports** the already-simulated outcome of one action; it changes no state. Also: `margins(report)`, `detect(report)`, `classify(requiredCompleted, requiredTotal, routeComplete)` → `'SUCCESS'|'PARTIAL'|'FAILED'`.

## 7. `FieldZeroCost`
`compute({ report, plan?, rover?, assumptions?, telemetry?, estimate?, deps? })` → `FZ-COST-0.1` or `{status:'invalid_input', error}`.
- `assumptions = { currency?, rates?: { operations_per_hour, energy_per_wh, mobility_wear_per_km, battery_cycle_cost } }` — defaults are **placeholders** in abstract cost units (CU); invalid/unknown rate inputs are ignored **and listed in `notes`**.
- `telemetry = { elapsed_s?, distance_m?, energy_consumed_wh?, battery_net_discharge_wh?, equipment_hours?:{id:h}, consumables_used?:{id:qty} }` — the **only** way a number becomes `measured`. The project contains no telemetry.
```
{ contract, version, status:'ok', plan_id,
  ledger{ energy{...}, time{...}, distance{...}, equipment[{id,duty,hours_used,available_hours,remaining_hours,status}], consumables[{id,available,used,remaining,planned_total_need,status}] },
  estimates{ time_s, energy_wh, distance_m, provenance:'estimated ...' } | null,
  actuals{ simulated{ ..., provenance:'simulated ... not measured' }, measured: null | {..., provenance:'measured (caller-supplied telemetry)'} },
  variance{ rows[{quantity, estimated, simulated, measured, ...}], note },
  remaining{ energy_above_reserve_wh, time_s, equipment[], consumables[] }, remaining_route_estimate, shortages[{resource, required, available, shortfall_lower, shortfall_upper, provenance:'estimated'}],
  cost{ currency, estimated, simulated, measured|null, cost_per_km_simulated }, assumptions, notes[], limitations[] }
```
Each `cost.*` block: `{ components[{id,label,quantity,unit,rate,rate_unit,rate_provenance,formula,amount|null,unavailable_reason,quantity_provenance}], total, complete, missing_components, source }`. A component whose quantity is unavailable has `amount:null` + `unavailable_reason` (never 0). Equipment with an unknown `duty` ⇒ `status:'duty_invalid'`, hours `null`. Distinguish **estimated** (pre-run analytic) / **simulated** (accumulated by the run, *not* a measurement) / **measured** (telemetry only) / **assumed** (rates, rover).

## 8. `FieldZeroScenario` (what-if)
`run({ plan, rover, scenarios, options?, assumptions?, attribution? (default true), includeReports?, deps? })` → `FZ-SCENARIOS-0.1`.
`scenarios = [ { id, name?, description?, changes } ]` (array required; ids must be unique). Supported `changes` (anything else is **ignored and listed**, never applied):
| group | keys |
|---|---|
| `resources` | `battery_capacity_scale`, `battery_capacity_wh`, `initial_soc_frac`, `solar_input_w`, `reserve_frac` |
| `duration` | `max_mission_s`, `max_mission_scale` |
| `rover_condition` | `mobility` [0,1], `power_draw_factor` (>0), `battery_health` (0,1], `slope_limit_factor` (0,1] |
| `route_conditions` | `slope_offset_deg`, `slope_scale`, `roughness_scale`, `length_scale`, `traction_speed_factor`, `blocked_segments` [id\|index], `max_slope_deg`, `max_roughness_std` |

`options`: `{ onViolation?, evaluateRecovery? }` — recovery is evaluated for scenarios unless `evaluateRecovery:false`; the baseline's recovery only if `true`.
```
{ contract, version, status:'ok'|'error'|'invalid_baseline', error?,
  baseline: summary, baseline_failure,
  scenarios: [ { id, name, status:'ok'|'no_changes_applied'|'invalid_scenario', changes_applied[{path,from,to,description}], ignored[{path,value?,reason}],
      summary, delta_vs_baseline{ metric:{baseline,scenario,delta,pct} }, outcome_change{baseline,scenario,changed}, explanation[], failure, attribution{ per_change[], interaction_progress_pts, note } } ],
  ranking[], supported_changes, notes[], limitations[], assumptions[] }
summary = { status, halted_code, mission_class:'SUCCESS'|'PARTIAL'|'FAILED', required_completed, required_total, objectives_completed, progress_fraction, distance_m, elapsed_s, energy_consumed_wh, final_energy_wh, min_energy_wh, usable_capacity_wh, reserve_wh, risk_index, cost_simulated_total, failure_count, primary_failure_code, provenance }
```
`sweep({ plan, rover, path:'group.key', values:[...] (non-empty array, ≤200), deps?, assumptions? })` → `{ status, path, baseline, rows[{value,status,reason,mission_class,halted_code,progress_fraction,required_completed,risk_index,min_energy_wh}], first_outcome_change:{between_values,from,to}|null }` or `{status:'error', error}`.
Also `applyChanges(plan, rover, changes, Sim)` → `{ plan, rover, applied, ignored }` (deep copies) and `SUPPORTED_CHANGES`. Scenarios modify the **simulation plan/rover**; they do **not** re-run the planner.

## 9. `FieldZeroResults` (final results / report)
- `run({ plan, rover, simOptions?, costAssumptions?, telemetry?, scenarios?, recovery?: {action_id?}, includeRaw?, deps? })` → results (runs everything).
- `build({ report, failure?, cost?, scenarios?, plan?, rover?, recovery?, deps? })` → results from already-computed parts.
- `toMarkdown(results)` → string. Results `status`: `'ok'` | `'invalid_input'` | `'error'` (never a fabricated report).
```
{ contract:'FZ-MISSION-RESULTS-0.1', version, status, deterministic,
  meta{ plan_id, plan_name, body, rover_id, modules{}, plan_contract, coordinate_reference },
  progress{ status, status_label, progress_fraction, distance_in_plan_m, planned_distance_m, elapsed_s, time_limit_s, segments_completed, segments_total, stopped_by|null, last_position },
  objectives{ total, completed[], incomplete[], skipped[], required_completed, required_total, required_completion_fraction },
  rover_performance{ ... , model_vs_estimate[] }, resource_consumption{ energy{}, time{}, equipment[], consumables[], remaining, shortages[] },
  failures{ status, count, summary, risk{index,components}, warnings, items[] }, recovery{ evaluated, feasibility, best_action_id, explanation, actions[], executed, status_note },
  cost{ currency, rate_provenance, estimated_total, simulated_total, measured_total, measured_available, components_*, variance, note },
  success_assessment{ verdict: 'SUCCESS'|'SUCCESS_WITH_CAVEATS'|'PARTIAL'|'FAILED'|'INVALID_INPUT', label, confidence:'low'|'medium', criteria[{id,description,met,value}], rationale[], with_recovery_simulated? },
  scenarios | null, provenance[], data_limitations[], assumptions[], raw? }
```
Verdict rules: `SUCCESS` = route done, all required objectives done, no failure/violation, no thin margin, terrain known; `SUCCESS_WITH_CAVEATS` = same but thin margin, unknown terrain **or recorded constraint violations** (`criteria.no_constraint_violations`); `PARTIAL`/`FAILED` otherwise. **Confidence is never `high`** and is `low` for placeholder rovers or unknown terrain. `with_recovery_simulated` is a **simulated** continuation: show it as such, never as something that happened. If no objectives exist, success = route completion (stated in `rationale`).

## 10. Mandatory display rules (integrity)
1. Label everything from these modules **"simulated"** (or `estimated` / `assumed` as tagged). Never show it next to measured data without the tag. `measured` exists only if the caller passed telemetry.
2. `null` ⇒ "n/a" / "unknown". Never show 0 for a null (terrain unknown, cost component unavailable).
3. Show `data_limitations` and `assumptions` with every results view; show `validation.warnings` of the adapter.
4. Coordinates: use `x_m,y_m`; lon/lat only on a WGS84 basemap and **only when `wgs84 === true`**. Mars/Moon lon/lat are NOT WGS84. Local x/y origins differ per site; never mix sites.
5. Earth terrain is Earth terrain. The planner's Earth analog routes keep `body:'earth'`; do not present them as Mars/Moon terrain. Similarity is a terrain-metric score, not evidence of operational safety, and is not an input to any simulation module.
6. Show `parameter_provenance` ("assumed"/"supplied") and the placeholder-rover warning wherever results appear.

## 11. Error and validation behaviour
| Situation | Behaviour |
|---|---|
| Invalid plan / rover | `createSimulation` still returns a controller; `status:'invalid'`, `validation.errors[]`; `play/tick` do nothing; other modules return `invalid_input` |
| Missing optional terrain | flagged in `data_gaps` / `warnings`; value stays `null`/unknown |
| Bad scenario input | `status:'error'` / per-item `invalid_scenario` / `no_changes_applied` (never throws) |
| Missing module dependency | `{status:'error', error:'route-simulation module (FieldZeroSim) is required.'}` |
| Adapter fed a bad export | `{ ok:false, errors }` |
| Planner side | `FieldZeroMission.run` returns `{ok:false,errors}`; `exportSimulationScenario` **throws** `MissionError` (`NO_ROUTE`) for a strategy without a feasible route — wrap in try/catch |

## 12. Gaps — APIs that do NOT exist (do not code against them)
1. **No `SimulationInput` / `SimulationResult` objects** as proposed in `reports/FIELD_ZERO_PLANNING_ENGINE_AUDIT_AND_API_CONTRACT.md` §5.6 (`plan_ref`, `blocked_missing_inputs`, `sim_id` …). The real contracts are the five documented above.
2. **No `FieldZeroPlanner` / `mission-planner.js`.** The planner is `FieldZeroMission` (`mission-engine.js`).
3. **No function that applies a recovery to a live controller.** Use §5 (new controller from `report.resume`) or `ctl.applyAction` before a halt. `executeRecovery` only reports.
4. **No seek / rewind / step-back**; only `reset()`.
5. **No serialisation of a controller**; persist `report`/`resume` (plain JSON) instead.
6. **No re-planning in what-if scenarios** (scenarios change simulation inputs only) and no multi-vehicle simulation.
7. **No roughness, detours or charging data from the real planner export**; roughness limits are unchecked, `ALTERNATE_ROUTE` is always unavailable, recharge is unavailable unless the caller supplies `environment.solar_input_w` as an explicit assumption.
8. **Browser loading not yet wired** (`index.html`, §1) and **not browser-tested**.
9. **No `events` API for the adapter**; it is a synchronous pure function.

## 13. API changes in this release (report to Person 2 now)
- **New:** `FieldZeroSim.fromMissionScenario`, `FieldZeroSim.BODY_CRS`, `report.coordinate_reference`, `state.position.wgs84`, `plan.planner_estimate` (adapter output only), `assumptions.ignored_inputs` (cost), `criteria[].id = 'no_constraint_violations'` and `meta.coordinate_reference` (results), `rows[].reason` (sweep), cost equipment `status:'duty_invalid'`, scenario `status:'invalid_scenario'`.
- **Changed behaviour:** `FieldZeroScenario.run` returns `{status:'error'}` (non-array `scenarios`) or `invalid_scenario` items instead of throwing; `FieldZeroSim` rejects a Mars/Moon plan whose `coordinate_frame.wgs84` is `true`; unknown/missing `plan.body` produces a warning.
- **Unchanged:** every pre-existing function name, parameter and output field. `failure-analysis.js` is unchanged.
