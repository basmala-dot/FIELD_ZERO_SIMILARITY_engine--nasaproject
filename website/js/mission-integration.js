/*! FIELD//ZERO mission integration v1.0.0
 *
 *  The ONE place where the planning engine (Person 1) is joined to the simulation and operations modules (Person 3)
 *  and to the mission UI (Person 2). It owns no science. It maps schemas, orchestrates calls and reports what the
 *  owning engines returned. Every number in its output is copied or arithmetically re-expressed from:
 *
 *    FieldZeroMission      (mission-engine.js)     sites, routes, route risk, planner estimates, staging
 *    FieldZeroSim          (route-simulation.js)   position, time, battery, events, objectives
 *    FieldZeroScenario     (scenario-engine.js)    meaning of every what-if change (applyChanges)
 *    FieldZeroFailure      (failure-analysis.js)   failures, causes, consequences, recovery evaluation
 *    FieldZeroCost         (cost-engine.js)        resource ledger and cost
 *    FieldZeroResults      (mission-results.js)    outcome verdict, limitations, markdown dossier
 *
 *  WHY THIS FILE EXISTS (API MISMATCH FOUND DURING INTEGRATION)
 *    mission-ui.js was written against a contract-1.0 object  { catalog, validate, plan, run, runScenario }.
 *    mission-engine.js exports { create, fromFZ, optimize/run (on an instance), exportSimulationScenario }, and its
 *    run(config) takes the engine's own mission config (targetBody, rover.massKg ...), not the builder's setup
 *    (destination, vehicle.mass_kg ...). route-simulation.js wants FZ-PLAN-PROVISIONAL-0.1, a waypoint/segment plan.
 *    None of these were compatible, so this file provides the contract-1.0 adapter (FieldZeroIntegration.api)
 *    and the schema mappings (setupToConfig, buildSimPlan, buildRover).
 *
 *  WHAT-IF SEMANTICS
 *    A scenario injects a route-condition event (blocked segment, traction loss, steeper terrain, rougher terrain,
 *    path inflation) starting at a trigger (time, leg or waypoint). The change itself is defined by
 *    FieldZeroScenario.applyChanges; this file splices the changed segments in FROM the trigger leg onward and
 *    leaves earlier legs untouched. Effects start at a leg boundary (the leg containing the trigger time), which is a
 *    stated limitation. Rover-level changes (battery health, power draw) are not offered as triggered events because
 *    they cannot start mid-leg in the simulation model.
 *
 *  COORDINATES
 *    run.map.crs is 'WGS84' only when the rehearsal body is Earth. For Mars and Moon it is 'local_m' (x_m_localTM,
 *    y_m_localTM metres) and the UI must never draw those on a WGS84 basemap.
 *
 *  Works in browsers (global FieldZeroIntegration, and FieldZeroIntegration.api) and Node 18+ (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FieldZeroIntegration = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (G) {
  'use strict';

  var VERSION = '1.0.0', CONTRACT = '1.0';
  var STRATS = ['fast', 'safe', 'scientific'];
  var SEC = 3600;

  // ------------------------------------------------------------------ helpers
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function rd(v, d) { if (!isNum(v)) return null; var k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; }
  function clone(o) { return o === undefined || o === null ? o : JSON.parse(JSON.stringify(o)); }
  function IErr(code, message, extra) { var e = new Error(message); e.name = 'IntegrationError'; e.code = code; if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; }); return e; }
  function dep(over, key, g, file) {
    if (over && over[key]) return over[key];
    if (G && G[g]) return G[g];
    if (typeof require === 'function') { try { return require(file); } catch (e) { return null; } }
    return null;
  }
  function getDeps(over) {
    var d = {
      model: dep(over, 'model', 'FieldZeroMissionModel', './mission-model.js'), mission: dep(over, 'mission', 'FieldZeroMission', './mission-engine.js'),
      sim: dep(over, 'sim', 'FieldZeroSim', './route-simulation.js'), scenario: dep(over, 'scenario', 'FieldZeroScenario', './scenario-engine.js'),
      failure: dep(over, 'failure', 'FieldZeroFailure', './failure-analysis.js'), cost: dep(over, 'cost', 'FieldZeroCost', './cost-engine.js'),
      results: dep(over, 'results', 'FieldZeroResults', './mission-results.js'), loader: (over && over.loader) || (G && G.FieldZeroData) || null
    };
    var miss = Object.keys(d).filter(function (k) { return k !== 'loader' && !d[k]; });
    if (miss.length) throw IErr('MISSING_DEPENDENCY', 'Required modules are not loaded: ' + miss.join(', ') + '.');
    return d;
  }
  function sKey(s) { return String(s).toLowerCase(); }
  function sUp(s) { return String(s).toUpperCase(); }

  // ------------------------------------------------------------------ setup (builder) -> engine mission config
  // engine config paths -> builder setup paths (for error messages that point at the right field)
  var PATH_BACK = { 'rover.massKg': 'vehicle.mass_kg', 'rover.nominalSpeedMps': 'vehicle.speed_mps_flat', 'rover.basePowerW': 'vehicle.power_w',
    'constraints.maxSlopeDeg': 'vehicle.max_slope_deg', 'resources.energyBudgetWh': 'vehicle.battery_wh', 'resources.energyReserveFraction': 'constraints.min_battery_pct',
    'resources.timeBudgetH': 'constraints.max_duration_s', 'goal': 'site', 'start': 'route.start', 'targetBody': 'destination', 'name': 'name' };
  function backPath(p) { return PATH_BACK[p] || p; }

  function cellLoc(o) {
    if (!o) return null;
    if (isNum(o.csv_row_index) || isNum(o.row_index)) return { row_index: isNum(o.csv_row_index) ? o.csv_row_index : o.row_index };
    if (isNum(o.x_m) && isNum(o.y_m)) return { x_m: o.x_m, y_m: o.y_m };
    if (isNum(o.x_m_localTM) && isNum(o.y_m_localTM)) return { x_m: o.x_m_localTM, y_m: o.y_m_localTM };
    if (isNum(o.lon_deg) && isNum(o.lat_deg)) return { lon_deg: o.lon_deg, lat_deg: o.lat_deg };
    return null;
  }

  /** Builder setup (FZShell.getSetup shape) -> { config, errors[], warnings[] }. No scientific defaults are invented here. */
  function setupToConfig(setup) {
    var errors = [], warnings = [], s = setup || {}, v = s.vehicle || {}, c = s.constraints || {}, site = s.site || {};
    function bad(path, code, message) { errors.push({ path: path, code: code, message: message }); }
    if (!s || typeof s !== 'object') { bad('', 'TYPE', 'The mission setup is missing.'); return { config: null, errors: errors, warnings: warnings }; }
    var dest = s.destination, rehearsal = (s.route && s.route.body) || 'earth';
    if (dest !== 'mars' && dest !== 'moon') bad('destination', 'ENUM', dest === 'earth'
      ? 'Earth is the analog search domain, not a similarity target. Choose Mars or Moon as the destination; the rehearsal then runs on Earth analog terrain (or on the destination terrain if you choose that).'
      : 'Choose Mars or Moon as the destination.');
    if (['earth', 'mars', 'moon'].indexOf(rehearsal) < 0) bad('route.body', 'ENUM', 'Rehearsal terrain must be earth, mars or moon.');
    if (rehearsal !== 'earth' && dest && rehearsal !== dest) bad('route.body', 'CONFLICT', 'Rehearsal terrain (' + rehearsal + ') must be Earth or the destination body (' + dest + ').');
    var eqMass = 0, eqPower = 0;
    (s.equipment || []).forEach(function (e) { if (isNum(e.mass_kg)) eqMass += e.mass_kg; if (isNum(e.power_w)) eqPower += e.power_w; });
    var cfg = {
      name: s.name || 'FIELD//ZERO mission', targetBody: dest === 'moon' ? 'moon' : 'mars', operatingBody: rehearsal, routeScaleM: 120, strategy: 'ALL',
      rover: {}, resources: {}, constraints: {}, objectives: {}
    };
    if (isNum(v.mass_kg)) cfg.rover.massKg = v.mass_kg + eqMass;
    if (isNum(v.speed_mps_flat)) cfg.rover.nominalSpeedMps = v.speed_mps_flat;
    if (isNum(v.power_w)) cfg.rover.basePowerW = v.power_w + eqPower;
    if (isNum(v.max_slope_deg)) cfg.constraints.maxSlopeDeg = v.max_slope_deg;
    if (isNum(v.battery_wh)) cfg.resources.energyBudgetWh = v.battery_wh;
    if (isNum(c.min_battery_pct)) cfg.resources.energyReserveFraction = c.min_battery_pct / 100;
    if (isNum(c.max_duration_s)) cfg.resources.timeBudgetH = c.max_duration_s / SEC;
    if (isNum(s.seed) && Math.floor(s.seed) !== s.seed) bad('seed', 'TYPE', 'The seed must be a whole number.');
    if (rehearsal === 'earth') {
      var g = cellLoc(site);
      if (!g) bad('site', 'REQUIRED', 'Choose an analog site (a portfolio site, a ranked candidate, or coordinates).');
      else cfg.goal = g;
    } else {
      var st = s.route && s.route.start, gl = s.route && s.route.goal;
      if (!(st && isNum(st.x_m) && isNum(st.y_m))) bad('route.start', 'REQUIRED', 'Enter the rover start (x, y in metres) for ' + rehearsal + ' terrain.');
      else cfg.start = { x_m: st.x_m, y_m: st.y_m };
      if (!(gl && isNum(gl.x_m) && isNum(gl.y_m))) bad('route.goal', 'REQUIRED', 'Enter the goal (x, y in metres) for ' + rehearsal + ' terrain.');
      else cfg.goal = { x_m: gl.x_m, y_m: gl.y_m };
    }
    return { config: cfg, errors: errors, warnings: warnings, equipment_mass_kg: eqMass, equipment_power_w: eqPower };
  }

  /** Full validation: shape checks above plus the planning model's own validateMissionConfig. */
  function validateSetup(setup, deps) {
    var m = setupToConfig(setup), errors = m.errors.slice(), warnings = m.warnings.slice();
    if (m.config) {
      var v = deps.model.validateMissionConfig(m.config);
      v.errors.forEach(function (e) { errors.push({ path: backPath(e.path), code: e.code, message: e.message }); });
      v.warnings.forEach(function (w) { warnings.push({ path: backPath(w.path), code: w.code, message: w.message }); });
    }
    return { ok: errors.length === 0, errors: errors, warnings: warnings, config: m.config };
  }

  // ------------------------------------------------------------------ plan (engine) -> simulation plan (FZ-PLAN-PROVISIONAL-0.1)
  function roverFromSetup(setup, engineMission) {
    var v = setup.vehicle || {}, c = setup.constraints || {}, eq = setup.equipment || [];
    var r = {
      id: 'USER_ROVER', name: v.name || 'User rover', nominal_speed_mps: v.speed_mps_flat, max_slope_deg: v.max_slope_deg, battery_capacity_wh: v.battery_wh,
      initial_soc_frac: 1, min_soc_frac: isNum(c.min_battery_pct) ? c.min_battery_pct / 100 : 0,
      drive_power_w: v.power_w, idle_power_w: v.power_w, dwell_power_w: v.power_w, parameter_provenance: 'supplied',
      equipment: eq.map(function (e, i) { return { id: 'eq' + (i + 1), name: e.name, duty: 'dwell', power_w: isNum(e.power_w) ? e.power_w : 0, mass_kg: isNum(e.mass_kg) ? e.mass_kg : 0 }; })
    };
    return r;
  }


  /** Aggregate the engine's per-cell-step segments between consecutive route waypoints into simulation segments. */
  function aggregateSegments(rt, rows, body, wpList, idPrefix) {
    var P = rt.path, S = rt.segments, W = wpList || rt.waypoints, out = [], i, k;
    for (i = 0; i < W.length - 1; i++) {
      var a = W[i].path_index, b = W[i + 1].path_index, len = 0, wsum = 0, smax = 0, pts = [], rg = [], rmax = null;
      for (k = a; k < b; k++) {
        len += S.length_m[k]; wsum += S.grade_deg[k] * S.length_m[k];
        smax = Math.max(smax, Math.abs(S.grade_deg[k]), isNum(rt.profile.cell_slope_deg[k]) ? rt.profile.cell_slope_deg[k] : 0, isNum(rt.profile.cell_slope_deg[k + 1]) ? rt.profile.cell_slope_deg[k + 1] : 0);
      }
      for (k = a; k <= b; k++) {
        pts.push({ x_m: P.x_m[k], y_m: P.y_m[k], lon_deg: P.lon_deg[k], lat_deg: P.lat_deg[k] });
        var row = rows && rows[P.row_indices[k]];
        if (row && isNum(row.roughness_std)) { rg.push(row.roughness_std); rmax = rmax === null ? row.roughness_std : Math.max(rmax, row.roughness_std); }
      }
      out.push({
        id: (idPrefix ? idPrefix + W[i].id : W[i].id) + '>' + (idPrefix ? idPrefix + W[i + 1].id : W[i + 1].id), from: idPrefix ? idPrefix + W[i].id : W[i].id, to: idPrefix ? idPrefix + W[i + 1].id : W[i + 1].id,
        length_m: rd(len, 3), slope_deg: rd(len > 0 ? wsum / len : 0, 4), slope_deg_max: rd(smax, 4),
        roughness_std: rg.length ? rd(rg.reduce(function (x, y) { return x + y; }, 0) / rg.length, 4) : null, roughness_std_max: rmax === null ? null : rd(rmax, 4),
        path: pts, terrain_source: 'engine route cells (' + body + ' ' + rt.scale_m + ' m terrain table)', surface: null
      });
    }
    return out;
  }

  /**
   * Engine route -> simulation plan. waypoints = engine route waypoints; segment i joins waypoint i to i+1 and aggregates the
   * engine's per-cell-step segments between them. Slope and roughness come from the engine/terrain table; nothing is invented.
   * `rows` is the terrain table of the route body (for roughness_std), same row indexing as the engine's row_index.
   */
  function buildSimPlan(plan, strategyId, setup, rows, deps) {
    var id = sUp(strategyId), sp = plan.strategies[id];
    if (!sp || !sp.route || sp.route.status !== 'ok') throw IErr('NO_ROUTE', 'Strategy ' + id + ' has no feasible route to simulate.');
    var rt = sp.route, P = rt.path, S = rt.segments, W = rt.waypoints, cfg = plan.mission.config, body = rt.body;
    var dwell = (cfg.objectives.siteDwellH || 0) * SEC;
    var eqPower = (setup.equipment || []).reduce(function (a, e) { return a + (isNum(e.power_w) ? e.power_w : 0); }, 0);
    var basePower = (setup.vehicle && setup.vehicle.power_w) || 0;
    var waypoints = W.map(function (w) { return { id: w.id, x_m: w.x_m, y_m: w.y_m, lon_deg: w.lon_deg, lat_deg: w.lat_deg, elevation_m: w.elevation_m }; });
    var segments = aggregateSegments(rt, rows, body);
    var objectives = [];
    W.forEach(function (w, n) {
      if (w.kind === 'stop') objectives.push({ id: 'obj_' + w.id, waypoint_id: w.id, label: 'Work at site (grid row ' + w.row_index + ')', required: true, dwell_s: dwell, power_w: (eqPower > 0 ? basePower + eqPower : null) });
    });
    var ca = rt.constraints_applied || {}, res = cfg.resources || {};
    var constraints = { max_slope_deg: isNum(ca.slope_limit_applied_deg) ? ca.slope_limit_applied_deg : null, max_roughness_std: isNum(ca.roughness_limit_applied_m) ? ca.roughness_limit_applied_m : null,
      max_mission_s: isNum(res.timeBudgetH) ? res.timeBudgetH * SEC : null, min_battery_soc_frac: isNum(res.energyReserveFraction) ? res.energyReserveFraction : null };
    return { contract: 'FZ-PLAN-PROVISIONAL-0.1', id: (plan.mission.config.id || 'plan') + ':' + id, name: cfg.name + ' (' + id + ')', body: body, waypoints: waypoints, segments: segments, objectives: objectives,
      constraints: constraints, environment: {}, alternatives: [], resources: [] };
  }


  // ------------------------------------------------------------------ catalogs (derived from what the owning modules support)
  var INJECTIONS = [
    { id: 'segment_blocked', label: 'Route leg blocked', description: 'The trigger leg becomes impassable (scenario-engine route_conditions.blocked_segments). A detour is evaluated by re-planning around it with the planning engine.', change: 'blocked_segments',
      param: null },
    { id: 'traction_loss', label: 'Traction loss', description: 'Driving speed on this and all later legs is multiplied by the magnitude (route_conditions.traction_speed_factor). Same power, longer time, more energy.', change: 'traction_speed_factor',
      param: { label: 'Speed factor', unit: '× (0 to 1]', def: 0.5, min: 0.05, max: 1 } },
    { id: 'steeper_terrain', label: 'Steeper terrain', description: 'Slope on this and all later legs rises by the magnitude in degrees (route_conditions.slope_offset_deg). May exceed the slope limit.', change: 'slope_offset_deg',
      param: { label: 'Added slope', unit: 'deg', def: 8, min: 0.5, max: 45 } },
    { id: 'path_inflation', label: 'Longer path', description: 'Leg lengths from the trigger onward are multiplied by the magnitude (route_conditions.length_scale), for example unplanned detours.', change: 'length_scale',
      param: { label: 'Length factor', unit: '×', def: 1.5, min: 1.01, max: 5 } }
  ];
  var RECOVERIES = [
    { id: 'ACCEPT_PARTIAL', label: 'Accept partial outcome', description: 'Stop and keep what was achieved.' },
    { id: 'ALTERNATE_ROUTE', label: 'Detour around the leg', description: 'Re-plan the blocked leg with the planning engine and continue (needs a feasible detour).' },
    { id: 'OVERRIDE_PLANNING_LIMIT', label: 'Relax the planning limit', description: 'Allow the rover its own capability instead of the conservative planning limit.' },
    { id: 'WAIT_RECHARGE', label: 'Wait and recharge', description: 'Needs a charging source; none is defined in the project data.' },
    { id: 'DESCOPE_OPTIONAL', label: 'Drop optional objectives', description: 'Skip optional objectives to save time and energy.' },
    { id: 'EXTEND_TIME_LIMIT', label: 'Extend the time limit', description: 'Continue beyond the mission time limit (needs authorisation).' }
  ];
  var EVENT_LABEL = { WAYPOINT_REACHED: 'Waypoint reached', OBJECTIVE_STARTED: 'Objective work started', OBJECTIVE_COMPLETED: 'Objective completed', ROUTE_COMPLETED: 'Route completed',
    BATTERY_BELOW_RESERVE: 'Battery below reserve', BATTERY_DEPLETED: 'Battery depleted', TIME_LIMIT_REACHED: 'Time limit reached', TIME_LIMIT_EXCEEDED: 'Time limit exceeded',
    SLOPE_EXCEEDS_LIMIT: 'Slope exceeds limit', ROUGHNESS_EXCEEDS_LIMIT: 'Roughness exceeds limit', SEGMENT_BLOCKED: 'Leg blocked', ROVER_IMMOBILE: 'Rover immobile' };
  var COMPONENT = { BATTERY_BELOW_RESERVE: 'Battery and power', BATTERY_DEPLETED: 'Battery and power', TIME_LIMIT_REACHED: 'Mission schedule', TIME_LIMIT_EXCEEDED: 'Mission schedule',
    SLOPE_EXCEEDS_LIMIT: 'Mobility on terrain', ROUGHNESS_EXCEEDS_LIMIT: 'Mobility on terrain', SEGMENT_BLOCKED: 'Planned route', ROVER_IMMOBILE: 'Mobility' };
  function catalog() {
    return { contract: CONTRACT, injections: INJECTIONS.map(function (x) { return { id: x.id, label: x.label, description: x.description + (x.param ? ' Default magnitude ' + x.param.def + ' ' + x.param.unit + ' is an assumed what-if value, not a measurement.' : ''), param: x.param }; }),
      recoveries: RECOVERIES.map(function (x) { return { id: x.id, label: x.label, description: x.description }; }), triggers: ['time', 'leg', 'waypoint'],
      note: 'Events are route-condition changes defined by the scenario engine. They start at a leg boundary. Rover-level failures (battery health, power draw) are available as whole-run what-ifs in the scenario engine but cannot start mid-leg, so they are not offered as triggered events.' };
  }

  // ------------------------------------------------------------------ small deterministic PRNG (used only for the optional scenario probability)
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function hash(str) { var h = 5381, i; for (i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return (h >>> 0).toString(16); }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function cancelled(o) { return o && o.signal && o.signal.aborted; }
  function checkCancel(o) { if (cancelled(o)) throw IErr('CANCELLED', 'The operation was cancelled.'); }
  function progress(o, f, stage) { if (o && typeof o.onProgress === 'function') { try { o.onProgress({ fraction: f, stage: stage }); } catch (e) { /* UI errors must not break the engine */ } } }

  // ------------------------------------------------------------------ geometry: simulated x/y -> lon/lat along the real route cells
  function makeLocator(simPlan) {
    var segs = simPlan.segments;
    return function (segIdx, x, y) {
      var seg = segs[Math.max(0, Math.min(segs.length - 1, segIdx))], p = seg.path, best = null, j;
      for (j = 0; j < p.length - 1; j++) {
        var ax = p[j].x_m, ay = p[j].y_m, bx = p[j + 1].x_m, by = p[j + 1].y_m, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        var u = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2)) : 0, qx = ax + u * dx, qy = ay + u * dy, d = (x - qx) * (x - qx) + (y - qy) * (y - qy);
        if (!best || d < best.d) best = { d: d, j: j, u: u };
      }
      var A = p[best.j], B = p[best.j + 1];
      return { lon_deg: rd(A.lon_deg + (B.lon_deg - A.lon_deg) * best.u, 7), lat_deg: rd(A.lat_deg + (B.lat_deg - A.lat_deg) * best.u, 7), off_route_m: rd(Math.sqrt(best.d), 3) };
    };
  }

  // ------------------------------------------------------------------ simulation + analysis of one plan
  function simulate(simPlan, rover, deps, opt) {
    opt = opt || {};
    var est = deps.sim.estimatePlan(simPlan, rover, {});
    var report = deps.sim.createSimulation(simPlan, { rover: rover, traceEveryS: opt.traceEveryS || (est.estimate ? Math.max(30, est.estimate.time_s / 600) : 300) }).runToEnd();
    return report;
  }
  function analyse(simPlan, rover, report, deps, evalRecovery) {
    var failure = deps.failure.analyze(report, { plan: simPlan, rover: rover, evaluateRecovery: evalRecovery !== false, deps: { simulation: deps.sim } });
    var cost = deps.cost.compute({ report: report, plan: simPlan, rover: rover, deps: { simulation: deps.sim } });
    return { failure: failure, cost: cost };
  }

  // ------------------------------------------------------------------ run object (contract 1.0) from the owning engines' outputs
  function riskLevel(deps, index) {
    if (!isNum(index)) return null;
    if (deps.model && typeof deps.model.classifyRisk === 'function') { var c = deps.model.classifyRisk(index); return typeof c === 'string' ? c : (c && c.class) || null; }
    return index < 25 ? 'low' : index < 50 ? 'moderate' : index < 75 ? 'high' : 'severe';
  }
  function verdictToOutcome(v) { return v === 'SUCCESS' || v === 'SUCCESS_WITH_CAVEATS' ? 'success' : v === 'PARTIAL' ? 'partial' : v === 'FAILED' ? 'failed' : 'aborted'; }
  function sevMap(s) { return s === 'failure' ? 'critical' : s === 'violation' ? 'warning' : 'info'; }

  function assembleRun(a) {
    var report = a.report, failure = a.failure, cost = a.cost, results = a.results, sp = a.simPlan, deps = a.deps, setup = a.setup, T = report.totals, E = T.energy, body = sp.body;
    var loc = makeLocator(sp), planned = T.planned_distance_m || 0, crs = body === 'earth' ? 'WGS84' : 'local_m';
    // timeline
    var tr = report.trace.slice(), last = tr[tr.length - 1];
    if (!last || Math.abs(last.t_s - T.elapsed_s) > 1) tr.push({ t_s: rd(T.elapsed_s, 3), x_m: last ? last.x_m : sp.waypoints[0].x_m, y_m: last ? last.y_m : sp.waypoints[0].y_m, distance_m: rd(T.distance_in_plan_m, 3), energy_wh: rd(E.end_wh, 4), segment_index: last ? last.segment_index : 0 });
    var samples = tr.map(function (p, i) {
      var ll = loc(p.segment_index, p.x_m, p.y_m), prev = tr[i - 1], moving = prev ? p.distance_m - prev.distance_m > 1e-6 : false, final = i === tr.length - 1;
      return { t_s: p.t_s, x_m: p.x_m, y_m: p.y_m, lon_deg: ll.lon_deg, lat_deg: ll.lat_deg, distance_m: p.distance_m, battery_wh: p.energy_wh, progress: planned > 0 ? Math.max(0, Math.min(1, p.distance_m / planned)) : null,
        status: final ? (report.status === 'completed' ? 'completed' : report.status === 'halted' ? 'halted' : report.status) : i === 0 ? 'ready' : moving ? 'driving' : 'working' };
    });
    // route / legs / waypoints. Legs are numbered from 1; ids are strings.
    var waypoints = sp.waypoints.map(function (w, i) {
      var segPrev = i > 0 ? report.segments[i - 1] : null;
      return { id: w.id, label: w.id + (a.kinds && a.kinds[i] ? ' (' + a.kinds[i] + ')' : ''), kind: a.kinds ? a.kinds[i] : null,
        point: { lon_deg: w.lon_deg, lat_deg: w.lat_deg, x_m: w.x_m, y_m: w.y_m, elevation_m: w.elevation_m }, planned_t_s: i === 0 ? 0 : (segPrev && isNum(segPrev.finished_t_s) ? rd(segPrev.finished_t_s, 1) : null) };
    });
    var legs = sp.segments.map(function (g, i) {
      var rs = report.segments[i];
      return { id: String(i + 1), label: 'Leg ' + (i + 1) + ': ' + g.from + ' to ' + g.to, from: g.from, to: g.to, distance_m: g.length_m, duration_s: rs && isNum(rs.time_s) ? rd(rs.time_s, 1) : null, status: rs ? rs.status : null,
        slope_deg: g.slope_deg, slope_deg_max: g.slope_deg_max, roughness_std: g.roughness_std, points: g.path.map(function (p) { return { lon_deg: p.lon_deg, lat_deg: p.lat_deg, x_m: p.x_m, y_m: p.y_m }; }) };
    });
    // events
    var events = report.events.map(function (e) { return { t_s: rd(e.t_s, 1), title: EVENT_LABEL[e.code] || String(e.code).replace(/_/g, ' ').toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); }), detail: e.message, severity: sevMap(e.severity), code: e.code }; });
    if (a.scenarioNote) events.unshift({ t_s: rd(a.scenarioNote.t_s, 1), title: 'Scenario event', detail: a.scenarioNote.text, severity: 'warning', code: 'SCENARIO_INJECTION' });
    events.sort(function (x, y) { return x.t_s - y.t_s; });
    // failures + recovery options
    var exec = a.recoveryExec, policy = a.policy || null;
    var failures = failure.failures.map(function (f) {
      var acts = f.recovery.actions || [], chosenId = exec && exec.executed ? exec.action_id : null;
      var options = acts.map(function (x) {
        return { id: x.type, action_id: x.id, label: (RECOVERIES.filter(function (r) { return r.id === x.type; })[0] || { label: x.type }).label, description: x.description, feasible: x.feasible === null ? null : !!x.feasible, chosen: chosenId === x.id,
          time_cost_s: x.estimate && isNum(x.estimate.action_time_s) ? x.estimate.action_time_s : null, energy_cost_wh: x.estimate && isNum(x.estimate.energy_wh) ? x.estimate.energy_wh : null, cost_delta: null, success_probability: null,
          reason_not_chosen: chosenId === x.id ? null : x.feasibility_reason, feasibility_reason: x.feasibility_reason, outcome: x.outcome ? { status: x.outcome.status, required_completed: x.outcome.required_completed, required_total: x.outcome.required_total, mission_class: x.outcome.mission_class, progress_fraction: x.outcome.progress_fraction, elapsed_s: x.outcome.elapsed_s } : null, tradeoffs: x.tradeoffs || [] };
      });
      var applied = options.filter(function (o) { return o.chosen; })[0] || null;
      var recovered = f.consequences.stops_mission ? (applied && exec.outcome ? (exec.outcome.required_total > 0 ? exec.outcome.required_completed === exec.outcome.required_total : exec.outcome.status === 'completed') && exec.feasible === true : false) : null;
      return { id: f.id, kind: a.injectionId || f.code, code: f.code, t_s: rd(f.t_s, 1), severity: sevMap(f.severity), component: COMPONENT[f.code] || 'Mission', root_cause: f.causes.summary, impact: f.consequences.text, recovered: recovered, caused_mission_loss: !!f.consequences.stops_mission,
        location: f.location, evidence: f.causes.evidence || [], mission_impact: f.mission_impact,
        recovery: { policy: applied ? applied.id : null, outcome: applied ? (recovered ? 'recovered' : 'not_recovered') : 'not_applied', feasibility: f.recovery.feasibility, best_action_id: f.recovery.best_action_id, explanation: f.recovery.explanation,
          time_cost_s: applied ? applied.time_cost_s : null, energy_cost_wh: applied ? applied.energy_cost_wh : null, cost_delta: null, options: options } };
    });
    var stopF = failures.filter(function (f) { return f.caused_mission_loss; })[0] || null;
    // hazards: where the simulation stopped, and where a scenario changed the route
    var hazards = [];
    failures.forEach(function (f) { if (f.location && isNum(f.location.x_m)) { var ll = loc(f.location.segment_index == null ? 0 : f.location.segment_index, f.location.x_m, f.location.y_m); hazards.push({ id: 'hz-' + f.id, label: f.code.replace(/_/g, ' ').toLowerCase(), kind: f.code, severity: f.severity, source: 'simulation failure', radius_m: 60, point: { lon_deg: ll.lon_deg, lat_deg: ll.lat_deg, x_m: f.location.x_m, y_m: f.location.y_m } }); } });
    if (a.scenarioNote && a.scenarioNote.point) hazards.push({ id: 'hz-injection', label: a.scenarioNote.label, kind: a.injectionId, severity: 'warning', source: 'scenario injection', radius_m: 60, point: a.scenarioNote.point });
    // resources
    var usable = E.usable_capacity_wh, reserve = E.reserve_wh, marginWh = E.min_wh - reserve, marginPct = usable > 0 ? 100 * marginWh / usable : null;
    var resources = { t_s: samples.map(function (s) { return s.t_s; }), series: [ { label: 'Battery', unit: 'Wh', values: samples.map(function (s) { return s.battery_wh; }) }, { label: 'Distance travelled', unit: 'm', values: samples.map(function (s) { return s.distance_m; }) } ],
      thresholds: [ { label: 'Battery reserve', unit: 'Wh', value: rd(reserve, 2) } ] };
    // cost
    var cs = cost.cost, sim = cs.simulated, est = cs.estimated, mb = setup.constraints && setup.constraints.max_cost, userCur = setup.constraints && setup.constraints.currency, cmp = isNum(mb) && (!userCur || /^cu$/i.test(userCur));
    var breakdown = sim.components.map(function (c, i) { var ec = est && est.components[i]; return { category: c.label, basis: c.formula, unit: c.unit, quantity: c.quantity, rate: c.rate, rate_provenance: c.rate_provenance, estimated: ec ? ec.amount : null, simulated: c.amount, expected: c.amount, low: null, high: null }; });
    var eqUsed = (cost.ledger.equipment || []).filter(function (q) { return q.hours_used > 0; }).map(function (q) { return q.name; });
    var costOut = { currency: 'CU', currency_note: cs.currency, expected: sim.total, estimated: est ? est.total : null, simulated: sim.total, low: null, high: null, within_budget: cmp ? sim.total <= mb : null,
      budget_note: isNum(mb) && !cmp ? 'The budget limit is in ' + userCur + ' but the cost model works in abstract cost units (CU), so the two are not compared.' : null,
      energy: { capacity_wh: usable, used_wh: rd(E.consumed_wh.total, 3), margin_wh: rd(marginWh, 3), margin_pct: rd(marginPct, 2), reserve_ok: marginWh >= -1e-9 && !failures.some(function (f) { return f.code.indexOf('BATTERY') === 0; }) },
      equipment: { listed: (cost.ledger.equipment || []).length, used: eqUsed }, duration: { planned_s: rd(T.elapsed_s, 1), limit_s: report.limits.max_mission_s, within_limit: isNum(report.limits.max_mission_s) ? T.elapsed_s <= report.limits.max_mission_s + 1e-6 : null },
      breakdown: breakdown, assumptions: [cs.currency + ' Rates: ' + Object.keys(cost.assumptions.rates).map(function (k) { return k + ' = ' + cost.assumptions.rates[k] + ' (' + cost.assumptions.rate_provenance[k] + ')'; }).join('; ') + '.'].concat(cost.notes || []) };
    var verdict = results.success_assessment, outcome = verdictToOutcome(verdict.verdict);
    var risk = failure.margins ? { score: rd(failure.margins.risk_index / 100, 3), level: riskLevel(deps, failure.margins.risk_index), basis: 'failure-analysis heuristic index (not a probability)' } : null;
    var reqOk = results.objectives.required_total > 0 ? results.objectives.required_completed === results.objectives.required_total : report.status === 'completed';
    return {
      run_id: a.runId, kind: a.kind, strategy: a.strategy, scenario_id: a.scenarioId || null, baseline_run_id: a.baselineRunId || null, outcome: outcome, outcome_label: verdict.label, outcome_reason: (verdict.rationale || [])[0] || null, objective_met: reqOk, loss_cause: stopF ? (EVENT_LABEL[stopF.code] || stopF.code) : null,
      summary: { duration_s: rd(T.elapsed_s, 1), distance_m: rd(T.distance_in_plan_m, 1), energy_used_wh: rd(E.consumed_wh.total, 2), energy_margin_pct: costOut.energy.margin_pct, open_failures: failures.filter(function (f) { return f.recovered !== true && f.caused_mission_loss; }).length,
        risk: risk || { level: null, score: null }, success_probability: null, success_probability_method: null, progress_fraction: T.progress_fraction, status: report.status },
      provenance: { fixture: false, model: 'route-simulation ' + report.version + ' + failure-analysis ' + failure.version + ' + cost-engine ' + cost.version + ' + mission-results ' + results.version, terrain: a.datasets },
      engine_version: 'planner ' + a.plannerVersion + ' / integration ' + VERSION, seed_used: isNum(a.seed) ? a.seed : null,
      map: { crs: crs, body: body, frame: crs === 'WGS84' ? 'WGS84 longitude/latitude (Earth)' : (body === 'mars' ? 'Mars local metres (x_m_localTM, y_m_localTM); not WGS84' : 'Moon local metres (x_m_localTM, y_m_localTM); not WGS84') },
      route: { waypoints: waypoints, legs: legs }, hazards: hazards, timeline: { dt_s: rd(T.elapsed_s / Math.max(1, samples.length - 1), 2), samples: samples }, events: events, failures: failures, cost: costOut, resources: resources,
      limitations: results.data_limitations, assumptions: results.assumptions, environment: { label: 'No environment model is applied: charging power 0 W; no thermal, dust, wind or illumination data exist for the route (Earth climate is one POWER grid point and is not used by the simulation).' },
      results: results, scenario_explanation: a.scenarioExplanation || null, scenario_applied: a.scenarioApplied || null, recovery_executed: exec || null, policy: policy,
      planner: { plan_id: a.planId, recommended_strategy: a.recommended, route_risk_index: a.routeRisk, planner_estimate: a.plannerEstimate }
    };
  }

  // ------------------------------------------------------------------ session (engine instance, caches, stored simulation inputs per run)
  function createSession(opts) {
    opts = opts || {};
    var deps = getDeps(opts.deps), engines = [], store = { runs: {}, plans: {} };
    function engineFor(ctx) {
      var c = ctx || {}, i;
      if (!c.analysis || !c.rows) throw IErr('DATA_NOT_READY', 'The terrain data and similarity analysis are not ready yet.');
      for (i = 0; i < engines.length; i++) if (engines[i].analysis === c.analysis && engines[i].rows === c.rows && engines[i].data === c.data) return engines[i].eng;
      var eng = deps.mission.create({ data: c.data, analysis: c.analysis, rows: c.rows });
      engines.push({ analysis: c.analysis, rows: c.rows, data: c.data, eng: eng }); return eng;
    }
    function routeRows(ctx, body) {
      if (body === 'earth') return ctx.rows;
      var d = ctx.data && ctx.data.terrain && ctx.data.terrain[body] && ctx.data.terrain[body]['120'];
      return d && d.csv ? d.csv.rows : null;
    }
    function datasets(body) { return [body + '_120m_terrain_csv'].concat(body === 'earth' ? ['earth_120m_terrain_csv (similarity scores)'] : []); }

    function validate(setup) { try { var v = validateSetup(setup, deps); return { ok: v.ok, errors: v.errors, warnings: v.warnings }; } catch (e) { return { ok: false, errors: [{ path: '', code: e.code || 'INTERNAL', message: e.message }] }; } }

    function kindsOf(enginePlan, id) { return enginePlan.strategies[sUp(id)].route.waypoints.map(function (w) { return w.kind; }); }

    async function plan(setup, ctx, o) {
      o = o || {}; var v = validateSetup(setup, deps);
      if (!v.ok) throw IErr('INVALID_SETUP', v.errors.map(function (e) { return e.message; }).join(' '), { errors: v.errors });
      var eng = engineFor(ctx); progress(o, 0.02, 'terrain'); checkCancel(o);
      var body = v.config.operatingBody;
      if (body !== 'earth') { await eng.ensureTerrain(body, v.config.routeScaleM); }
      await tick(); checkCancel(o); progress(o, 0.1, 'planning');
      var out = eng.run(v.config);
      if (!out.ok) throw IErr(out.errors[0] && out.errors[0].code || 'PLAN_FAILED', out.errors.map(function (e) { return e.message; }).join(' '), { errors: out.errors });
      var ep = out.plan, rows = routeRows(ctx, body), rover = roverFromSetup(setup), strategies = {}, planId = 'plan-' + hash(JSON.stringify([v.config, setup.seed]));
      var i = 0;
      for (i = 0; i < STRATS.length; i++) {
        var k = STRATS[i], id = sUp(k), sp = ep.strategies[id], route = sp.route;
        await tick(); checkCancel(o); progress(o, 0.3 + 0.2 * i, 'simulating ' + k);
        if (!route || route.status !== 'ok') { strategies[k] = { feasible: false, infeasible_reason: route ? (route.explanation && route.explanation[0]) || route.reason : 'no route was planned', summary: null }; continue; }
        var simPlan = buildSimPlan(ep, id, setup, rows, deps), report = simulate(simPlan, rover, deps), an = analyse(simPlan, rover, report, deps, false);
        var res = deps.results.build({ plan: simPlan, rover: rover, report: report, failure: an.failure, cost: an.cost }), cmpRow = ep.comparison.table.filter(function (r) { return r.strategy === id; })[0] || {};
        var T = report.totals, E = T.energy, marginPct = E.usable_capacity_wh > 0 ? 100 * (E.min_wh - E.reserve_wh) / E.usable_capacity_wh : null;
        strategies[k] = { feasible: true, infeasible_reason: null, route: { waypoints: simPlan.waypoints.map(function (w) { return { id: w.id }; }), legs: simPlan.segments.map(function (g, n) { return { id: String(n + 1) }; }) },
          summary: { duration_s: rd(T.elapsed_s, 1), distance_m: rd(T.distance_in_plan_m, 1), energy_used_wh: rd(E.consumed_wh.total, 2), energy_margin_pct: rd(marginPct, 2), open_failures: an.failure.failures.filter(function (f) { return f.consequences.stops_mission; }).length,
            cost_expected: an.cost.cost.simulated.total, risk: { level: cmpRow.risk_class || riskLevel(deps, sp.risk && sp.risk.mission_risk_index), score: isNum(sp.risk && sp.risk.mission_risk_index) ? rd(sp.risk.mission_risk_index / 100, 3) : null },
            success_probability: null, outcome_label: res.success_assessment.label, outcome: verdictToOutcome(res.success_assessment.verdict), planner_estimate: { total_time_h: sp.totals.total_time_h, energy_wh: sp.totals.energy_wh, distance_m: sp.totals.distance_m, budget_status: sp.resources && { time: sp.resources.time && sp.resources.time.status, energy: sp.resources.energy && sp.resources.energy.status } } },
          strategy_id: id };
      }
      store.plans[planId] = { setup: setup, config: v.config, enginePlan: ep, rows: rows, rover: rover, ctx: ctx };
      var st = ep.context.staging, goal = null;
      if (v.config.goal) { goal = ep.strategies.FAST && ep.strategies.FAST.route && ep.strategies.FAST.route.goals ? ep.strategies.FAST.route.goals[0] : null; }
      progress(o, 1, 'done');
      return { plan_id: planId, engine_version: 'planner ' + deps.mission.version + ' / integration ' + VERSION, seed_used: isNum(setup.seed) ? setup.seed : null, strategies: strategies, recommended_strategy: ep.recommended_strategy ? sKey(ep.recommended_strategy) : null,
        site_resolved: { goal: goal, staging: st, body: body, crs: body === 'earth' ? 'WGS84' : 'local_m' }, environment: { label: 'No environment model: charging power 0 W; no thermal, dust, wind or illumination data.' },
        provenance: { fixture: false, model: 'mission-engine ' + deps.mission.version + ' + route-simulation + cost-engine', terrain: datasets(body) },
        currency: 'CU', limitations: (ep.data_limitations || []).map(function (l) { return (l.id ? l.id + ': ' : '') + l.statement; }), assumptions: ep.assumptions_and_estimates.concat([
          'Rover speed, power, battery, mass and slope limit come from the mission builder; slope-dependent power (4 W per degree) and min speed fraction (0.1) are simulation-module assumptions.',
          'Equipment mass is added to rover mass for the planner; equipment power is drawn while working at a site.',
          'SCIENTIFIC visits the engine\'s own top-ranked sites, not only the site you chose; FAST and SAFE go to your chosen site.']),
        comparison: ep.comparison, label: ep.label, disclaimer: ep.disclaimer, _store_id: planId };
    }

    async function run(setup, stratPlan, ctx, o) {
      o = o || {}; var key = null, planId = null;
      Object.keys(store.plans).forEach(function (pid) { if (store.plans[pid].setup === setup || JSON.stringify(store.plans[pid].setup) === JSON.stringify(setup)) planId = pid; });
      if (!planId) throw IErr('PLAN_NOT_FOUND', 'No plan exists for this setup. Launch the mission first.');
      var P = store.plans[planId], id = stratPlan && stratPlan.strategy_id; if (!id) throw IErr('NO_STRATEGY', 'The strategy plan carries no strategy id.');
      checkCancel(o); progress(o, 0.1, 'simulation'); await tick();
      var simPlan = buildSimPlan(P.enginePlan, id, setup, P.rows, deps), report = simulate(simPlan, P.rover, deps);
      progress(o, 0.5, 'failure analysis'); await tick(); checkCancel(o);
      var an = analyse(simPlan, P.rover, report, deps, true);
      var stopF = an.failure.failures.filter(function (f) { return f.consequences.stops_mission; })[0];
      var results = deps.results.build({ plan: simPlan, rover: P.rover, report: report, failure: an.failure, cost: an.cost });
      var rid = 'run-' + planId + '-' + sKey(id);
      var run = assembleRun({ runId: rid, kind: 'nominal', strategy: sKey(id), report: report, failure: an.failure, cost: an.cost, results: results, simPlan: simPlan, deps: deps, setup: setup, kinds: kindsOf(P.enginePlan, id),
        datasets: datasets(simPlan.body), plannerVersion: deps.mission.version, seed: setup.seed, planId: planId, recommended: P.enginePlan.recommended_strategy, routeRisk: P.enginePlan.strategies[id].route.metrics.route_risk_index,
        plannerEstimate: P.enginePlan.strategies[id].totals });
      store.runs[rid] = { planId: planId, strategy: id, simPlan: simPlan, rover: P.rover, report: report, setup: setup };
      progress(o, 1, 'done');
      return run;
    }

    // ---- scenarios
    function legForTrigger(base, trigger) {
      var rep = base.report, n = rep.segments.length, i;
      if (trigger.kind === 'leg') { var li = parseInt(trigger.leg_id, 10) - 1; if (!(li >= 0 && li < n)) throw IErr('BAD_TRIGGER', 'Unknown leg ' + trigger.leg_id + '. Valid legs are 1 to ' + n + '.'); return li; }
      if (trigger.kind === 'waypoint') {
        var wi = base.simPlan.waypoints.map(function (w) { return w.id; }).indexOf(String(trigger.waypoint_id));
        if (wi < 0) throw IErr('BAD_TRIGGER', 'Unknown waypoint ' + trigger.waypoint_id + '.');
        if (wi >= n) throw IErr('BAD_TRIGGER', 'The last waypoint has no leg after it; pick an earlier waypoint.');
        return wi;
      }
      var t = trigger.time_s;
      for (i = 0; i < n; i++) { var s = rep.segments[i]; if (s.status === 'not_started') break; if (isNum(s.finished_t_s) ? t < s.finished_t_s : t <= rep.totals.elapsed_s) return i; }
      throw IErr('BAD_TRIGGER', 'The baseline never reaches a leg at ' + Math.round(t) + ' s (it ends or stops earlier, or only dwells after the last leg).');
    }
    function alternativesFor(P, base, segIdx, ctx) {
      try {
        var eng = engineFor(ctx), sp = base.simPlan, seg = sp.segments[segIdx], a = sp.waypoints[segIdx], b = sp.waypoints[segIdx + 1], rt = P.enginePlan.strategies[base.strategy].route;
        var wa = rt.waypoints[segIdx], wb = rt.waypoints[segIdx + 1], cells = [], k;
        for (k = wa.path_index; k <= wb.path_index; k++) cells.push(k);
        if (cells.length < 3) return { alternatives: [], note: 'The blocked leg is a single cell step; a keep-out detour needs at least one interior cell to avoid.' };
        var mid = cells[Math.floor(cells.length / 2)], P2 = rt.path, cfg = clone(P.config);
        cfg.constraints = cfg.constraints || {}; cfg.constraints.keepOut = (cfg.constraints.keepOut || []).concat([{ x_m: P2.x_m[mid], y_m: P2.y_m[mid], radius_m: 0.5 * rt.scale_m }]);
        cfg.strategy = sUp(base.strategy); cfg.id = undefined;
        var r = eng.planRoute({ mission: cfg, strategy: sUp(base.strategy), start: { row_index: wa.row_index }, goal: { row_index: wb.row_index }, body: rt.body, scale: rt.scale_m });
        if (!r || r.status !== 'ok') return { alternatives: [], note: 'The planning engine found no detour around the blocked leg under the same constraints.' };
        var via = r.waypoints.slice(1, r.waypoints.length - 1), all = r.waypoints, segs = aggregateSegments(r, P.rows, rt.body, all, 'alt' + (segIdx + 1) + '_');
        return { alternatives: [{ id: 'detour' + (segIdx + 1), from: a.id, to: b.id, waypoints: via.map(function (w) { return { id: 'alt' + (segIdx + 1) + '_' + w.id, x_m: w.x_m, y_m: w.y_m, lon_deg: w.lon_deg, lat_deg: w.lat_deg, elevation_m: w.elevation_m }; }),
          segments: segs.map(function (g) { return { length_m: g.length_m, slope_deg: g.slope_deg, slope_deg_max: g.slope_deg_max, roughness_std: g.roughness_std, roughness_std_max: g.roughness_std_max, path: g.path, terrain_source: g.terrain_source }; }), planner_distance_m: r.metrics.distance_m }], note: null };
      } catch (e) { return { alternatives: [], note: 'No detour could be planned: ' + e.message }; }
    }

    async function runScenario(baseRun, sc, ctx, o) {
      o = o || {}; var base = store.runs[baseRun && baseRun.run_id];
      if (!base) throw IErr('RUN_NOT_FOUND', 'The baseline run is not known to the integration layer. Re-run the strategy first.');
      var inj = INJECTIONS.filter(function (x) { return x.id === sc.injection; })[0]; if (!inj) throw IErr('BAD_INJECTION', 'Unknown event "' + sc.injection + '".');
      var pol = RECOVERIES.filter(function (x) { return x.id === sc.recovery; })[0]; if (!pol) throw IErr('BAD_RECOVERY', 'Unknown recovery policy "' + sc.recovery + '".');
      var P = store.plans[base.planId], seg0 = legForTrigger(base, sc.trigger || {}), mag = isNum(sc.magnitude) ? sc.magnitude : (inj.param ? inj.param.def : null);
      if (inj.param && (mag < inj.param.min || mag > inj.param.max)) throw IErr('BAD_MAGNITUDE', inj.param.label + ' must be between ' + inj.param.min + ' and ' + inj.param.max + ' ' + inj.param.unit + '.');
      checkCancel(o); progress(o, 0.1, 'scenario'); await tick();
      // probability: a single deterministic draw from the seed (documented); blank probability means the event always happens
      var seed = isNum(sc.seed) ? sc.seed : (isNum(base.setup.seed) ? base.setup.seed : 1), occurs = true, draw = null;
      if (isNum(sc.probability)) { draw = mulberry32(seed)(); occurs = draw < sc.probability; }
      var changes = { route_conditions: {} }; changes.route_conditions[inj.change] = inj.change === 'blocked_segments' ? [seg0] : mag;
      var ap = deps.scenario.applyChanges(base.simPlan, base.rover, changes, deps.sim);
      if (!ap.applied.length) throw IErr('INVALID_SCENARIO', 'The scenario engine could not apply the event: ' + ap.ignored.map(function (x) { return x.reason; }).join('; '));
      var plan2 = clone(base.simPlan), i, from = seg0;
      if (occurs) for (i = from; i < plan2.segments.length; i++) { if (inj.change === 'blocked_segments' && i !== seg0) continue; plan2.segments[i] = ap.plan.segments[i]; }
      var altInfo = { alternatives: [], note: null };
      if (occurs && inj.id === 'segment_blocked') { altInfo = alternativesFor(P, base, seg0, ctx); plan2.alternatives = altInfo.alternatives; }
      var report = simulate(plan2, base.rover, deps); await tick(); checkCancel(o); progress(o, 0.55, 'failure analysis');
      var an = analyse(plan2, base.rover, report, deps, true), stopF = an.failure.failures.filter(function (f) { return f.consequences.stops_mission; })[0], exec = null, actId = null;
      if (stopF) {
        var act = stopF.recovery.actions.filter(function (a) { return a.type === pol.id && a.applicable && a.feasible !== false; })[0] || stopF.recovery.actions.filter(function (a) { return a.type === pol.id; })[0];
        if (act) { actId = act.id; exec = deps.failure.executeRecovery(an.failure, act.id); }
      }
      var results = deps.results.build({ plan: plan2, rover: base.rover, report: report, failure: an.failure, cost: an.cost, recovery: actId ? { action_id: actId } : undefined });
      var segStart = base.report.segments[seg0] && isNum(base.report.segments[seg0].started_t_s) ? base.report.segments[seg0].started_t_s : 0, w0 = base.simPlan.waypoints[seg0], ll0 = makeLocator(base.simPlan)(seg0, w0.x_m, w0.y_m);
      var note = { t_s: segStart, label: inj.label, point: { lon_deg: ll0.lon_deg, lat_deg: ll0.lat_deg, x_m: w0.x_m, y_m: w0.y_m },
        text: occurs ? inj.label + ' from leg ' + (seg0 + 1) + (inj.param ? ' (' + inj.param.label + ' ' + mag + ' ' + inj.param.unit + ')' : '') + '. Effect starts at the leg boundary, t = ' + Math.round(segStart) + ' s.'
          : 'The event did not occur: seed ' + seed + ' gave a draw of ' + rd(draw, 4) + ', not below the probability ' + sc.probability + '.' };
      var explanation = null;
      if (occurs && seg0 === 0) { var se = deps.scenario.run({ plan: base.simPlan, rover: base.rover, scenarios: [{ id: sc.id, changes: changes }], attribution: false, options: { evaluateRecovery: false }, deps: { simulation: deps.sim } }); explanation = se && se.scenarios && se.scenarios[0] ? { explanation: se.scenarios[0].explanation, mission_class: se.scenarios[0].summary && se.scenarios[0].summary.mission_class } : null; }
      var rid = 'run-' + base.planId + '-' + sKey(base.strategy) + '-' + sc.id;
      var run = assembleRun({ runId: rid, kind: 'scenario', strategy: sKey(base.strategy), scenarioId: sc.id, baselineRunId: baseRun.run_id, report: report, failure: an.failure, cost: an.cost, results: results, simPlan: plan2, deps: deps, setup: base.setup,
        kinds: kindsOf(P.enginePlan, base.strategy), datasets: datasets(plan2.body), plannerVersion: deps.mission.version, seed: seed, planId: base.planId, recommended: P.enginePlan.recommended_strategy, routeRisk: P.enginePlan.strategies[base.strategy].route.metrics.route_risk_index,
        plannerEstimate: P.enginePlan.strategies[base.strategy].totals, injectionId: occurs ? inj.id : null, scenarioNote: note, recoveryExec: exec, policy: pol.id, scenarioApplied: { applied: ap.applied, ignored: ap.ignored, effective_from_leg: seg0 + 1, effective_from_t_s: rd(segStart, 1), occurred: occurs, draw: rd(draw, 4), seed: seed, magnitude: mag },
        scenarioExplanation: explanation });
      if (altInfo.note) run.limitations = (run.limitations || []).concat([altInfo.note]);
      store.runs[rid] = { planId: base.planId, strategy: base.strategy, simPlan: plan2, rover: base.rover, report: report, setup: base.setup };
      progress(o, 1, 'done');
      return run;
    }

    function exportMarkdown(state) {
      var nom = state && state.runs && state.runs[state.nominal_run_id]; if (!nom) return null;
      var L = [deps.results.toMarkdown(nom.results).trimEnd(), '', '## Strategy comparison (simulated nominal runs)'];
      if (state.plan) STRATS.forEach(function (k) {
        var sp = state.plan.strategies[k], line;
        if (sp.feasible) line = sp.summary.outcome_label + ', ' + rd(sp.summary.duration_s / 3600, 2) + ' h, ' + rd(sp.summary.distance_m, 0) + ' m, ' + rd(sp.summary.energy_used_wh, 1) + ' Wh, cost ' + sp.summary.cost_expected + ' CU (planner estimate ' + sp.summary.planner_estimate.total_time_h + ' h, ' + sp.summary.planner_estimate.energy_wh + ' Wh)';
        else line = 'no feasible route: ' + sp.infeasible_reason;
        L.push('- ' + k.toUpperCase() + ': ' + line);
      });
      L.push('', '## What-if scenarios');
      (state.scenarios || []).forEach(function (s) { var r = state.runs[s.run_id]; L.push('- ' + s.name + ' (' + s.scenario.injection + ', recovery ' + s.scenario.recovery + '): ' + r.outcome_label + ', ' + rd(r.summary.duration_s / 3600, 2) + ' h, cost ' + r.cost.expected + ' CU' + (r.scenario_applied && !r.scenario_applied.occurred ? ' (event did not occur)' : '')); });
      if (!(state.scenarios || []).length) L.push('- None run.');
      L.push('', '## Provenance', '- Planning: mission-engine ' + deps.mission.version + '; simulation/failure/cost/scenario/results modules v0.1.0; integration ' + VERSION + '.', '- Map frame: ' + nom.map.frame + '.', '- Cost unit: ' + nom.cost.currency_note, '- No telemetry or measured values exist; every number is modelled.');
      return L.join('\n') + '\n';
    }

    var api = { version: VERSION, contract: CONTRACT, catalog: catalog, validate: validate, plan: plan, run: run, runScenario: runScenario, exportMarkdown: exportMarkdown };
    return { api: api, deps: deps, store: store, engineFor: engineFor };
  }

  var lazy = null;
  function getApi() { if (!lazy) lazy = createSession(); return lazy.api; }

  return { version: VERSION, CONTRACT: CONTRACT, INJECTIONS: INJECTIONS, RECOVERIES: RECOVERIES, catalog: catalog, createSession: createSession, get api() { return getApi(); }, setupToConfig: setupToConfig, validateSetup: validateSetup,
    buildSimPlan: buildSimPlan, roverFromSetup: roverFromSetup, _helpers: { isNum: isNum, rd: rd, clone: clone, getDeps: getDeps, IErr: IErr } };
});
