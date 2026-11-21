/*! FIELD//ZERO route simulation v0.1.0
 *
 *  SIMULATED VALUES. NOT A PHYSICALLY VALIDATED ROVER DYNAMICS MODEL.
 *
 *  Moves a rover along a route that was PLANNED ELSEWHERE (Person 1's Mission Planning Engine).
 *  This module never invents a route, terrain value or coordinate: it only consumes what the plan
 *  contains. Anything the plan does not contain is reported as a data gap, never filled silently.
 *
 *  Pure computation, no DOM, no randomness, no wall-clock dependence (browser + Node 18+).
 *  Same plan + same rover + same options  =>  byte-identical report. The step size only affects how
 *  often states are emitted, not the outcome (sub-steps are cut exactly at every event).
 *
 *  ======================================================================================
 *  INPUT CONTRACT  (PROVISIONAL: "FZ-PLAN-PROVISIONAL-0.1", to be mapped to Person 1's final API)
 *  ======================================================================================
 *  plan = {
 *    contract: 'FZ-PLAN-PROVISIONAL-0.1', id, name, body: 'earth'|'mars'|'moon',
 *    waypoints: [ { id, x_m, y_m,                       // local metres (e.g. the project's x_m_localTM / y_m_localTM)
 *                   lon_deg?, lat_deg?, elevation_m? } ],   // lon/lat only used if x_m/y_m are missing (see ASSUMPTIONS)
 *    segments?: [ {                                     // segments[i] joins waypoints[i] -> waypoints[i+1]
 *                   from?, to?,                         // waypoint ids (checked against waypoints if given)
 *                   length_m?,                          // else polyline length, else straight-line distance
 *                   path?: [ {x_m, y_m}, ... ],         // optional polyline, used only for position interpolation
 *                   slope_deg?, slope_deg_max?,         // mean slope drives speed/energy, max slope drives limit checks
 *                   roughness_std?, roughness_std_max?, tri?,
 *                   traction_speed_factor?,             // (0,1] surface effect on speed, default 1
 *                   passable?,                          // false = planner marks segment blocked
 *                   surface?, terrain_source? } ],      // free labels, passed through
 *    objectives?: [ { id, waypoint_id, label?, required?=true, dwell_s?=0, power_w?, requires?: [{resource_id, quantity}] } ],
 *    constraints?: { max_slope_deg, max_roughness_std, max_mission_s, min_battery_soc_frac },   // null/absent = not constrained
 *    environment?: { solar_input_w },                   // constant charging power; absent => 0 and listed as data gap
 *    alternatives?: [ ... ]                             // optional planner detours, consumed only by failure-analysis.js
 *  }
 *  rover = see DEFAULT_ROVER below (every number is an ASSUMPTION unless the caller supplies real values).
 *
 *  ======================================================================================
 *  MODEL AND FORMULAS  (all parameters are caller-supplied or flagged ASSUMPTION)
 *  ======================================================================================
 *  Per segment, with slope s (deg, mean), roughness r, condition c = rover.condition:
 *    slope_limit_eff   = rover.max_slope_deg * c.slope_limit_factor
 *    speed derate      = clamp(1 - s / slope_limit_eff, min_speed_fraction, 1)          (linear, ASSUMPTION)
 *    roughness derate  = 1 / (1 + roughness_speed_coeff * r)                             (default coeff 0 = off)
 *    v   = nominal_speed_mps * c.mobility * slope derate * roughness derate * traction_speed_factor
 *    P   = (drive_power_w + slope_power_w_per_deg * max(0,s) + roughness_power_w_per_unit * r) * c.power_draw_factor
 *    time = length / v      energy_load = P * time / 3600  [Wh]
 *    dwell load = (objective.power_w ?? dwell_power_w) * power_draw_factor;  wait load = idle_power_w * power_draw_factor
 *  Battery:  usable = capacity * battery_health;  E0 = usable * initial_soc_frac;  reserve = usable * max(rover.min_soc_frac, constraint)
 *    dE = (load - solar_input_w) * dt / 3600, clamped to [0, usable] (energy above full is counted as "curtailed").
 *  Missing slope/roughness on a segment => treated as 0 for the arithmetic AND flagged terrain_known=false.
 *
 *  Hard stops ("failure" events): BATTERY_BELOW_RESERVE, BATTERY_DEPLETED, TIME_LIMIT_REACHED, SLOPE_EXCEEDS_LIMIT,
 *  ROUGHNESS_EXCEEDS_LIMIT, SEGMENT_BLOCKED, ROVER_IMMOBILE.  With options.onViolation = 'record_and_continue' the
 *  terrain/blocked/time/reserve violations are logged and the run continues (BATTERY_DEPLETED always stops).
 *
 *  ======================================================================================
 *  OUTPUT CONTRACT
 *  ======================================================================================
 *  controller = createSimulation(plan, options)
 *    .play() .pause() .resume() .reset() .tick([simSeconds]) .runToEnd() .setSpeed(multiplier)
 *    .getState()  -> "FZ-SIM-STATE-0.1"  (position, progress, time, resources, objectives, new events)
 *    .getReport() -> "FZ-SIM-REPORT-0.1" (totals, objectives, per-segment log, events, trace, gaps, assumptions)
 *    .snapshot()  -> { state, resume }   resume = options.initial for a continuation (also in report.resume; used by failure-analysis.js)
 *    .applyAction({type:'WAIT', duration_s} | {type:'SKIP_OBJECTIVE', objective_id})
 *    .on('state'|'event'|'status', fn) -> unsubscribe fn
 *  estimatePlan(plan, rover, options) -> analytic pre-run estimate (same model, no stepping)
 *  Provenance tags used everywhere: 'plan' (from planner input), 'simulated', 'estimated', 'assumed', 'unknown'.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FieldZeroSim = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var VERSION = '0.1.0';
  var CONTRACT = { plan: 'FZ-PLAN-PROVISIONAL-0.1', state: 'FZ-SIM-STATE-0.1', report: 'FZ-SIM-REPORT-0.1' };
  var EPS = 1e-9, TOL_WH = 1e-6;
  // Mean radii for the lon/lat fallback only. Mars/Moon values are the ones already used by website/js/map.js; Earth = IUGG mean radius.
  var BODY_RADIUS_M = { earth: 6371008.8, mars: 3396190, moon: 1737400 };
  var NOMINAL_CONDITION = { mobility: 1, power_draw_factor: 1, battery_health: 1, slope_limit_factor: 1 };

  var DEFAULT_ROVER = {
    id: 'GENERIC_ASSUMED_ROVER',
    name: 'Generic rover (ASSUMED parameters, not a real vehicle)',
    nominal_speed_mps: 0.1, max_slope_deg: 20, min_speed_fraction: 0.1,
    roughness_speed_coeff: 0, max_roughness_std: null,
    battery_capacity_wh: 3000, initial_soc_frac: 1, min_soc_frac: 0.15,
    drive_power_w: 100, slope_power_w_per_deg: 4, roughness_power_w_per_unit: 0,
    idle_power_w: 20, dwell_power_w: 40,
    condition: { mobility: 1, power_draw_factor: 1, battery_health: 1, slope_limit_factor: 1 },
    equipment: [],
    parameter_provenance: 'assumed'
  };

  var ASSUMPTIONS = [
    'Rover parameters (speed, power, battery, slope limit) are caller-supplied or generic placeholders; none describe a real vehicle unless the caller says so.',
    'Speed derate with slope is a linear rule; power rises linearly with slope. These are transparent engineering placeholders, not validated terramechanics (no wheel-soil, slip, thermal or gravity model).',
    'Slope, roughness and length are taken per segment as supplied by the plan; within a segment they are treated as constant.',
    'Position between waypoints is linearly interpolated (or along the planner polyline if supplied). It is a simulated position, not a localisation solution.',
    'Solar/charging input is a constant power only if the caller supplies it; otherwise it is 0 and no charging is credited.',
    'Time is simulated mission time; no wall-clock, communication latency, day/night, temperature or dust effects are modelled.'
  ];

  // ------------------------------------------------------------------ helpers
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function rd(v, d) { if (!isNum(v)) return v; var k = Math.pow(10, d == null ? 4 : d); return Math.round(v * k) / k; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function merge(base, over) { var o = clone(base); Object.keys(over || {}).forEach(function (k) { if (over[k] !== undefined) o[k] = over[k]; }); return o; }
  function dist(a, b) { return Math.sqrt((a.x_m - b.x_m) * (a.x_m - b.x_m) + (a.y_m - b.y_m) * (a.y_m - b.y_m)); }
  function positive(v) { return isNum(v) && v > 0; }

  // ------------------------------------------------------------------ rover
  function normalizeRover(input) {
    var r = merge(DEFAULT_ROVER, input || {});
    r.condition = merge(NOMINAL_CONDITION, (input && input.condition) || {});
    r.equipment = (input && input.equipment) ? clone(input.equipment) : [];
    var errors = [], warnings = [];
    if (!positive(r.nominal_speed_mps)) errors.push('rover.nominal_speed_mps must be > 0');
    if (!positive(r.max_slope_deg)) errors.push('rover.max_slope_deg must be > 0');
    if (!positive(r.battery_capacity_wh)) errors.push('rover.battery_capacity_wh must be > 0');
    ['drive_power_w', 'slope_power_w_per_deg', 'idle_power_w', 'dwell_power_w', 'roughness_power_w_per_unit', 'roughness_speed_coeff'].forEach(function (k) {
      if (!isNum(r[k]) || r[k] < 0) errors.push('rover.' + k + ' must be a number >= 0');
    });
    if (!isNum(r.initial_soc_frac) || r.initial_soc_frac < 0 || r.initial_soc_frac > 1) errors.push('rover.initial_soc_frac must be within [0,1]');
    if (!isNum(r.min_soc_frac) || r.min_soc_frac < 0 || r.min_soc_frac >= 1) errors.push('rover.min_soc_frac must be within [0,1)');
    if (!isNum(r.min_speed_fraction) || r.min_speed_fraction <= 0 || r.min_speed_fraction > 1) errors.push('rover.min_speed_fraction must be within (0,1]');
    var c = r.condition;
    if (!isNum(c.mobility) || c.mobility < 0 || c.mobility > 1) errors.push('rover.condition.mobility must be within [0,1]');
    if (!isNum(c.power_draw_factor) || c.power_draw_factor <= 0) errors.push('rover.condition.power_draw_factor must be > 0');
    if (!isNum(c.battery_health) || c.battery_health <= 0 || c.battery_health > 1) errors.push('rover.condition.battery_health must be within (0,1]');
    if (!isNum(c.slope_limit_factor) || c.slope_limit_factor <= 0 || c.slope_limit_factor > 1) errors.push('rover.condition.slope_limit_factor must be within (0,1]');
    if (r.parameter_provenance !== 'supplied') warnings.push('Rover parameters are placeholders (parameter_provenance = "' + r.parameter_provenance + '"). Results describe the model, not a specific vehicle.');
    return { rover: r, errors: errors, warnings: warnings };
  }

  /** Speed and electrical load while driving a segment. cond = rover condition; flat = ignore terrain (reference case). */
  function drivingModel(seg, R, cond, flat) {
    var s = (flat || seg.slope_deg == null) ? 0 : Math.max(0, seg.slope_deg);
    var rg = (flat || seg.roughness_std == null) ? 0 : Math.max(0, seg.roughness_std);
    var lim = R.max_slope_deg * cond.slope_limit_factor;
    var sf = lim > 0 ? clamp(1 - s / lim, R.min_speed_fraction, 1) : R.min_speed_fraction;
    var rf = 1 / (1 + R.roughness_speed_coeff * rg);
    var tr = flat ? 1 : seg.traction_speed_factor;
    var v = R.nominal_speed_mps * cond.mobility * sf * rf * tr;
    var p = (R.drive_power_w + R.slope_power_w_per_deg * s + R.roughness_power_w_per_unit * rg) * cond.power_draw_factor;
    return { v: v, p: p };
  }

  // ------------------------------------------------------------------ plan preparation
  function prepare(planIn, options) {
    options = options || {};
    var rr = normalizeRover(options.rover);
    var R = rr.rover, plan = planIn || {};
    var errors = rr.errors.slice(), warnings = rr.warnings.slice(), gaps = [];
    var body = plan.body || null;
    if (!plan.contract) warnings.push('plan.contract missing; assuming ' + CONTRACT.plan + '.');
    else if (plan.contract !== CONTRACT.plan) warnings.push('plan.contract "' + plan.contract + '" differs from ' + CONTRACT.plan + '; field mapping may be incomplete.');

    // waypoints
    var wps = [], i;
    var rawW = Array.isArray(plan.waypoints) ? plan.waypoints : [];
    if (rawW.length < 2) errors.push('plan.waypoints needs at least 2 waypoints (the simulation does not invent routes).');
    var ref = null;
    rawW.forEach(function (w) { if (!ref && isNum(w.lon_deg) && isNum(w.lat_deg)) ref = w; });
    var projected = 0;
    rawW.forEach(function (w, k) {
      var o = { id: w.id != null ? String(w.id) : 'WP' + k, index: k, lon_deg: isNum(w.lon_deg) ? w.lon_deg : null, lat_deg: isNum(w.lat_deg) ? w.lat_deg : null, elevation_m: isNum(w.elevation_m) ? w.elevation_m : null };
      if (isNum(w.x_m) && isNum(w.y_m)) { o.x_m = w.x_m; o.y_m = w.y_m; }
      else if (o.lon_deg != null && ref && BODY_RADIUS_M[body]) {
        var Rm = BODY_RADIUS_M[body], d2r = Math.PI / 180;
        o.x_m = Rm * Math.cos(ref.lat_deg * d2r) * (o.lon_deg - ref.lon_deg) * d2r; o.y_m = Rm * (o.lat_deg - ref.lat_deg) * d2r; projected++;
      } else errors.push('waypoint ' + o.id + ' has no usable x_m/y_m (and no lon/lat + known body radius).');
      wps.push(o);
    });
    if (projected) warnings.push(projected + ' waypoint(s) were projected from lon/lat with an equirectangular approximation (assumption); prefer supplying x_m/y_m.');
    var seen = {}; wps.forEach(function (w) { if (seen[w.id]) errors.push('duplicate waypoint id ' + w.id); seen[w.id] = true; });

    // segments
    var segs = [], unknownTerrain = 0;
    for (i = 0; i < wps.length - 1; i++) {
      var g = (plan.segments && plan.segments[i]) || {};
      if (g.from != null && String(g.from) !== wps[i].id) errors.push('segments[' + i + '].from "' + g.from + '" does not match waypoint ' + wps[i].id);
      if (g.to != null && String(g.to) !== wps[i + 1].id) errors.push('segments[' + i + '].to "' + g.to + '" does not match waypoint ' + wps[i + 1].id);
      var path = null, plen = null;
      if (Array.isArray(g.path) && g.path.length >= 2 && g.path.every(function (p) { return isNum(p.x_m) && isNum(p.y_m); })) {
        path = [{ x_m: g.path[0].x_m, y_m: g.path[0].y_m, c: 0 }];
        for (var q = 1; q < g.path.length; q++) path.push({ x_m: g.path[q].x_m, y_m: g.path[q].y_m, c: path[q - 1].c + dist(g.path[q - 1], g.path[q]) });
        plen = path[path.length - 1].c;
      }
      var straight = (isNum(wps[i].x_m) && isNum(wps[i + 1].x_m)) ? dist(wps[i], wps[i + 1]) : null;
      var len = isNum(g.length_m) ? g.length_m : (plen != null ? plen : straight);
      var lenSrc = isNum(g.length_m) ? 'plan' : (plen != null ? 'plan (polyline length)' : 'derived (straight line between waypoints)');
      if (!isNum(len) || len < 0) { errors.push('segment ' + i + ' has no valid length'); len = 0; }
      var tf = isNum(g.traction_speed_factor) ? g.traction_speed_factor : 1;
      if (tf <= 0 || tf > 1) { errors.push('segments[' + i + '].traction_speed_factor must be within (0,1]'); tf = 1; }
      var sl = isNum(g.slope_deg) ? g.slope_deg : null, rg = isNum(g.roughness_std) ? g.roughness_std : null;
      var seg = { index: i, id: g.id != null ? String(g.id) : wps[i].id + '>' + wps[i + 1].id, from: wps[i].id, to: wps[i + 1].id, length_m: len, length_source: lenSrc, path: path,
        slope_deg: sl, slope_deg_max: isNum(g.slope_deg_max) ? g.slope_deg_max : sl, roughness_std: rg, roughness_std_max: isNum(g.roughness_std_max) ? g.roughness_std_max : rg,
        tri: isNum(g.tri) ? g.tri : null, traction_speed_factor: tf, passable: g.passable !== false, surface: g.surface || null, terrain_source: g.terrain_source || null,
        terrain_known: sl != null };
      if (!seg.terrain_known) { unknownTerrain++; }
      segs.push(seg);
    }
    if (unknownTerrain) gaps.push({ code: 'SEGMENT_SLOPE_MISSING', count: unknownTerrain, message: unknownTerrain + ' of ' + segs.length + ' segments carry no slope in the plan; slope is treated as 0 for speed/energy and cannot be checked against limits.' });
    if (Array.isArray(plan.segments) && plan.segments.length > Math.max(0, wps.length - 1)) warnings.push('plan.segments has more entries than waypoint pairs; extras ignored.');

    // objectives
    var objs = [], oseen = {}, objByWp = {};
    (Array.isArray(plan.objectives) ? plan.objectives : []).forEach(function (o, k) {
      var id = o.id != null ? String(o.id) : 'OBJ' + k;
      if (oseen[id]) { errors.push('duplicate objective id ' + id); return; } oseen[id] = true;
      var wi = -1; wps.forEach(function (w) { if (w.id === String(o.waypoint_id)) wi = w.index; });
      if (wi < 0) { errors.push('objective ' + id + ' references unknown waypoint "' + o.waypoint_id + '"'); return; }
      var dw = isNum(o.dwell_s) ? o.dwell_s : 0; if (dw < 0) { errors.push('objective ' + id + ' dwell_s < 0'); dw = 0; }
      var ob = { id: id, label: o.label || id, waypoint_id: wps[wi].id, waypoint_index: wi, required: o.required !== false, dwell_s: dw, power_w: isNum(o.power_w) ? o.power_w : null, requires: Array.isArray(o.requires) ? clone(o.requires) : [] };
      objs.push(ob); (objByWp[wi] = objByWp[wi] || []).push(ob);
    });
    if (!objs.length) gaps.push({ code: 'NO_OBJECTIVES', message: 'The plan defines no objectives; mission success can only be judged on route completion.' });

    // constraints / environment
    var cIn = plan.constraints || {};
    var C = { max_slope_deg: positive(cIn.max_slope_deg) ? cIn.max_slope_deg : null, max_roughness_std: positive(cIn.max_roughness_std) ? cIn.max_roughness_std : null,
      max_mission_s: positive(cIn.max_mission_s) ? cIn.max_mission_s : null, min_battery_soc_frac: isNum(cIn.min_battery_soc_frac) ? clamp(cIn.min_battery_soc_frac, 0, 1) : null };
    var env = merge({ solar_input_w: 0 }, plan.environment || {}); env = merge(env, options.environment || {});
    var solarKnown = isNum(env.solar_input_w) && env.solar_input_w > 0;
    if (!isNum(env.solar_input_w) || env.solar_input_w < 0) { errors.push('environment.solar_input_w must be >= 0'); env.solar_input_w = 0; }
    if (!solarKnown) gaps.push({ code: 'NO_CHARGING_SOURCE', message: 'No solar/charging input supplied: battery can only discharge and no recharge recovery can be evaluated.' });
    if (options.initial && options.initial.max_mission_s_override !== undefined) C.max_mission_s = options.initial.max_mission_s_override;

    // effective limits and battery
    var rovSlopeLim = R.max_slope_deg * R.condition.slope_limit_factor;
    var slopeLim = C.max_slope_deg != null ? Math.min(rovSlopeLim, C.max_slope_deg) : rovSlopeLim;
    var slopeGov = (C.max_slope_deg != null && C.max_slope_deg < rovSlopeLim) ? 'route_constraint' : 'rover_capability';
    var roughLim = null, roughGov = null;
    if (positive(R.max_roughness_std)) { roughLim = R.max_roughness_std; roughGov = 'rover_capability'; }
    if (C.max_roughness_std != null && (roughLim == null || C.max_roughness_std < roughLim)) { roughLim = C.max_roughness_std; roughGov = 'route_constraint'; }
    var usable = R.battery_capacity_wh * R.condition.battery_health;
    var reserveFrac = Math.max(R.min_soc_frac, C.min_battery_soc_frac || 0);
    var limits = { slope_deg: slopeLim, slope_governed_by: slopeGov, rover_slope_limit_deg: rovSlopeLim, constraint_slope_limit_deg: C.max_slope_deg,
      roughness_std: roughLim, roughness_governed_by: roughGov, max_mission_s: C.max_mission_s, reserve_frac: reserveFrac, reserve_wh: usable * reserveFrac, usable_capacity_wh: usable,
      nameplate_capacity_wh: R.battery_capacity_wh, solar_input_w: env.solar_input_w };

    // per-segment physics (constant per segment)
    segs.forEach(function (sg) {
      var a = drivingModel(sg, R, R.condition, false), n = drivingModel(sg, R, NOMINAL_CONDITION, false), f = drivingModel(sg, R, NOMINAL_CONDITION, true);
      sg.model = { v: a.v, p: a.p, t_full: a.v > 0 ? sg.length_m / a.v : Infinity, e_full: a.v > 0 ? a.p * (sg.length_m / a.v) / 3600 : Infinity,
        nom_t_full: n.v > 0 ? sg.length_m / n.v : Infinity, nom_e_full: n.v > 0 ? n.p * (sg.length_m / n.v) / 3600 : Infinity,
        flat_t_full: f.v > 0 ? sg.length_m / f.v : Infinity, flat_e_full: f.v > 0 ? f.p * (sg.length_m / f.v) / 3600 : Infinity };
    });

    return { rover: R, errors: errors, warnings: warnings, gaps: gaps, body: body, plan_id: plan.id || null, plan_name: plan.name || null, waypoints: wps, segments: segs,
      objectives: objs, objByWp: objByWp, constraints: C, environment: env, limits: limits, usable_wh: usable, reserve_wh: usable * reserveFrac,
      E0: usable * R.initial_soc_frac, solar_w: env.solar_input_w, alternatives: Array.isArray(plan.alternatives) ? plan.alternatives : [] };
  }

  // ------------------------------------------------------------------ analytic estimate
  function estimateFromModel(M, ini) {
    ini = ini || {};
    var R = M.rover, pf = R.condition.power_draw_factor;
    var done = {}; (ini.completed || []).forEach(function (id) { done[id] = true; }); (ini.skipped || []).forEach(function (id) { done[id] = true; });
    var startSeg = ini.segment_index || 0, off = ini.offset_m || 0;
    var at = ini.at_waypoint != null ? ini.at_waypoint : (off <= EPS);
    var T = { drive_s: 0, dwell_s: 0 }, E = { drive_wh: 0, dwell_wh: 0 }, D = 0, per = [], unreachable = false;
    function dwellAt(wi, first) {
      (M.objByWp[wi] || []).forEach(function (o) { if (done[o.id]) return;
        var dl = (first && ini.dwell && ini.dwell.id === o.id) ? ini.dwell.left : o.dwell_s;
        T.dwell_s += dl; E.dwell_wh += (o.power_w != null ? o.power_w : R.dwell_power_w) * pf * dl / 3600; });
    }
    if (at) dwellAt(startSeg, true);
    for (var i = startSeg; i < M.segments.length; i++) {
      var sg = M.segments[i], o2 = i === startSeg ? off : 0, rem = Math.max(0, sg.length_m - o2);
      if (!(sg.model.v > 0)) { unreachable = true; continue; }
      var t = rem / sg.model.v, e = sg.model.p * t / 3600;
      T.drive_s += t; E.drive_wh += e; D += rem; per.push({ segment_index: i, remaining_m: rem, time_s: t, energy_wh: e });
      dwellAt(i + 1, false);
    }
    var time = T.drive_s + T.dwell_s, energy = E.drive_wh + E.dwell_wh;
    return { time_s: time, energy_wh: energy, distance_m: D, drive: { time_s: T.drive_s, energy_wh: E.drive_wh }, dwell: { time_s: T.dwell_s, energy_wh: E.dwell_wh },
      solar_credit_upper_bound_wh: M.solar_w * time / 3600, per_segment: per, unreachable_segments: unreachable,
      provenance: 'estimated (analytic, same assumed model as the simulation; not measured)' };
  }
  function estimatePlan(plan, rover, options) {
    var M = prepare(plan, merge(options || {}, { rover: rover }));
    var est = M.errors.length ? null : estimateFromModel(M, (options || {}).initial);
    return { errors: M.errors, warnings: M.warnings, estimate: est, limits: M.limits };
  }

  // ------------------------------------------------------------------ simulation controller
  function createSimulation(plan, options) {
    options = options || {};
    var M = prepare(plan, options);
    var R = M.rover, pf = R.condition.power_draw_factor;
    var listeners = { state: [], event: [], status: [] };
    var S, timer = null, speedMult = 1, lastStatus = null;
    var stepSeconds = positive(options.stepSeconds) ? options.stepSeconds : 60;
    var tickMs = positive(options.tickIntervalMs) ? options.tickIntervalMs : 100;
    var sched = options.scheduler || { setInterval: function (f, ms) { return setInterval(f, ms); }, clearInterval: function (h) { clearInterval(h); } };
    var traceCap = 2000, estimateAtStart = null;

    function fire(kind, payload) { listeners[kind].slice().forEach(function (fn) { try { fn(payload); } catch (e) { /* listener errors must not break the simulation */ } }); }

    function initState() {
      var ini = options.initial || {};
      var s = { t: ini.elapsed_s || 0, t0: ini.elapsed_s || 0, E: isNum(ini.energy_wh) ? clamp(ini.energy_wh, 0, M.usable_wh) : M.E0, dist: ini.distance_m || 0,
        seg: ini.segment_index || 0, off: ini.offset_m || 0, atWp: ini.at_waypoint != null ? !!ini.at_waypoint : !(ini.offset_m > EPS), objI: 0, dwell: ini.dwell ? clone(ini.dwell) : null,
        entered: -1, wait: null, pre: [], started: false, playing: false, halted: null, done: false,
        objStatus: {}, objT: {}, energy_by: { drive: 0, dwell: 0, wait: 0 }, time_by: { drive: 0, dwell: 0, wait: 0 }, gen: 0, curtailed: 0, nomDwellWait: 0,
        minE: 0, events: [], newEvents: [], trace: [], traceEvery: 0, traceNext: 0, timeExceeded: false, reserveBreached: false, tick: 0,
        segLog: M.segments.map(function (sg) { return { time_s: 0, energy_wh: 0, traveled_m: 0, started_t: null, finished_t: null, status: 'not_started', warned: false }; }) };
      s.E0 = s.E; s.minE = s.E;
      M.objectives.forEach(function (o) { s.objStatus[o.id] = 'pending'; });
      (ini.completed || []).forEach(function (id) { if (s.objStatus[id] != null) { s.objStatus[id] = 'completed'; s.objT[id] = null; } });
      (ini.skipped || []).concat(options.skipObjectives || []).forEach(function (id) { if (s.objStatus[id] === 'pending') s.objStatus[id] = 'skipped'; });
      for (var k = 0; k < s.seg && k < s.segLog.length; k++) s.segLog[k].status = 'completed';
      if (s.seg < s.segLog.length && s.off > 0) { s.segLog[s.seg].status = 'in_progress'; s.segLog[s.seg].traveled_m = s.off; s.entered = s.seg; }
      (options.preActions || []).forEach(function (a) { if (a && a.type === 'WAIT' && positive(a.duration_s)) s.pre.push({ duration_s: a.duration_s, reason: a.reason || 'WAIT action' }); });
      var est = M.errors.length ? null : estimateFromModel(M, ini);
      estimateAtStart = est;
      s.traceEvery = positive(options.traceEveryS) ? options.traceEveryS : Math.max(60, est ? est.time_s / 400 : 600);
      return s;
    }

    // ---- events
    function emit(code, severity, message, data) {
      var ev = { id: S.events.length + 1, t_s: S.t, code: code, severity: severity, message: message, data: data || {} };
      S.events.push(ev); S.newEvents.push(ev); fire('event', ev); return ev;
    }
    function trace(force) {
      if (!force && S.t < S.traceNext) return;
      var p = positionAt(S.seg, S.off);
      S.trace.push({ t_s: rd(S.t, 3), x_m: rd(p.x_m, 3), y_m: rd(p.y_m, 3), distance_m: rd(S.dist, 3), energy_wh: rd(S.E, 4), soc_frac: M.usable_wh > 0 ? rd(S.E / M.usable_wh, 5) : null, segment_index: Math.min(S.seg, M.segments.length - 1) });
      S.traceNext = S.t + S.traceEvery;
      if (S.trace.length > traceCap) { S.trace = S.trace.filter(function (_, i) { return i % 2 === 0 || i === S.trace.length - 1; }); S.traceEvery *= 2; }
    }
    function halt(code, message, data) {
      var sgi = Math.min(S.seg, M.segments.length - 1);
      S.halted = { code: code, message: message, t_s: S.t, segment_index: S.seg < M.segments.length ? S.seg : null, offset_m: S.off, data: data || {} };
      if (S.seg < S.segLog.length && S.segLog[S.seg].status !== 'completed') S.segLog[S.seg].status = (code === 'SEGMENT_BLOCKED' || code === 'SLOPE_EXCEEDS_LIMIT' || code === 'ROUGHNESS_EXCEEDS_LIMIT') && S.off <= EPS ? 'blocked' : 'in_progress';
      emit(code, 'failure', message, merge(data || {}, { segment_index: S.seg < M.segments.length ? sgi : null }));
      trace(true);
    }
    function violation(code, message, data) {
      if (options.onViolation === 'record_and_continue') emit(code, 'violation', message, data); else halt(code, message, data);
    }

    // ---- geometry
    function positionAt(si, off) {
      var n = M.segments.length;
      if (!n || !M.waypoints.length) return { x_m: 0, y_m: 0, lon_deg: null, lat_deg: null, elevation_m: null };
      if (si >= n) { var w = M.waypoints[M.waypoints.length - 1]; return { x_m: w.x_m, y_m: w.y_m, lon_deg: w.lon_deg, lat_deg: w.lat_deg, elevation_m: w.elevation_m }; }
      var sg = M.segments[si], a = M.waypoints[si], b = M.waypoints[si + 1];
      var f = sg.length_m > EPS ? clamp(off / sg.length_m, 0, 1) : 1, x, y;
      if (sg.path) {
        var tgt = f * sg.path[sg.path.length - 1].c, k = 1; while (k < sg.path.length - 1 && sg.path[k].c < tgt) k++;
        var p0 = sg.path[k - 1], p1 = sg.path[k], span = p1.c - p0.c, u = span > EPS ? (tgt - p0.c) / span : 1;
        x = p0.x_m + (p1.x_m - p0.x_m) * u; y = p0.y_m + (p1.y_m - p0.y_m) * u;
      } else { x = a.x_m + (b.x_m - a.x_m) * f; y = a.y_m + (b.y_m - a.y_m) * f; }
      var ll = a.lon_deg != null && b.lon_deg != null && !sg.path;
      var el = a.elevation_m != null && b.elevation_m != null;
      return { x_m: x, y_m: y, lon_deg: ll ? a.lon_deg + (b.lon_deg - a.lon_deg) * f : null, lat_deg: ll ? a.lat_deg + (b.lat_deg - a.lat_deg) * f : null, elevation_m: el ? a.elevation_m + (b.elevation_m - a.elevation_m) * f : null };
    }

    // ---- dispatch (what is the rover doing next?)
    function completeObjective(ob) {
      S.objStatus[ob.id] = 'completed'; S.objT[ob.id] = S.t;
      emit('OBJECTIVE_COMPLETED', 'info', 'Objective ' + ob.id + ' completed at ' + ob.waypoint_id + '.', { objective_id: ob.id, required: ob.required });
    }
    function finishSegment() {
      var sg = M.segments[S.seg], lg = S.segLog[S.seg];
      lg.status = 'completed'; lg.finished_t = S.t; S.off = 0; S.seg++; S.atWp = true; S.objI = 0; S.dwell = null;
      emit('WAYPOINT_REACHED', 'info', 'Reached waypoint ' + sg.to + '.', { waypoint_id: sg.to, segment_index: sg.index });
      trace(true);
    }
    function enterSegment(sg) {
      S.entered = S.seg; var lg = S.segLog[S.seg];
      if (S.off > EPS) return;                     // resumed mid-segment: checks already passed
      if (lg.started_t == null) lg.started_t = S.t;
      lg.status = 'in_progress';
      var L = M.limits;
      if (!sg.passable) { violation('SEGMENT_BLOCKED', 'Segment ' + sg.id + ' is marked not passable by the planner.', { segment_id: sg.id }); if (S.halted) return; }
      var smax = sg.slope_deg_max;
      if (smax != null && smax > L.slope_deg + 1e-9) {
        violation('SLOPE_EXCEEDS_LIMIT', 'Segment ' + sg.id + ' max slope ' + rd(smax, 2) + ' deg exceeds the ' + rd(L.slope_deg, 2) + ' deg limit (' + L.slope_governed_by.replace('_', ' ') + ').',
          { segment_id: sg.id, slope_deg_max: smax, limit_deg: L.slope_deg, governed_by: L.slope_governed_by, rover_limit_deg: L.rover_slope_limit_deg, constraint_limit_deg: L.constraint_slope_limit_deg }); if (S.halted) return;
      } else if (smax != null && smax > 0.8 * L.slope_deg && !lg.warned) { lg.warned = true; emit('NEAR_SLOPE_LIMIT', 'warning', 'Segment ' + sg.id + ' max slope is within 20% of the limit.', { segment_id: sg.id, slope_deg_max: smax, limit_deg: L.slope_deg }); }
      var rmax = sg.roughness_std_max;
      if (L.roughness_std != null && rmax != null && rmax > L.roughness_std + 1e-9) {
        violation('ROUGHNESS_EXCEEDS_LIMIT', 'Segment ' + sg.id + ' roughness ' + rd(rmax, 2) + ' exceeds the limit ' + rd(L.roughness_std, 2) + '.', { segment_id: sg.id, roughness_std_max: rmax, limit: L.roughness_std, governed_by: L.roughness_governed_by }); if (S.halted) return;
      }
      if (!sg.terrain_known) emit('TERRAIN_DATA_MISSING', 'warning', 'Segment ' + sg.id + ' has no slope data; limits cannot be checked.', { segment_id: sg.id });
    }
    function finish() { S.done = true; S.atWp = false; emit('ROUTE_COMPLETED', 'info', 'Route completed.', {}); trace(true); }

    function dispatch() {
      if (S.wait) { if (S.wait.left > EPS) return { kind: 'wait', load: R.idle_power_w * pf, max: S.wait.left }; S.wait = null; emit('WAIT_ENDED', 'info', 'Wait ended.', {}); return null; }
      if (S.pre.length) { var a = S.pre.shift(); S.wait = { left: a.duration_s }; emit('WAIT_STARTED', 'info', 'Waiting ' + rd(a.duration_s, 1) + ' s (' + a.reason + ').', { duration_s: a.duration_s }); return null; }
      if (S.atWp) {
        var list = M.objByWp[S.seg] || [];
        while (S.objI < list.length) {
          var ob = list[S.objI];
          if (S.objStatus[ob.id] !== 'pending') { S.objI++; S.dwell = null; continue; }
          if (!S.dwell) S.dwell = { id: ob.id, left: ob.dwell_s };
          if (S.dwell.left <= EPS) { completeObjective(ob); S.objI++; S.dwell = null; continue; }
          return { kind: 'dwell', load: (ob.power_w != null ? ob.power_w : R.dwell_power_w) * pf, max: S.dwell.left };
        }
        S.atWp = false;
      }
      if (S.seg >= M.segments.length) { finish(); return null; }
      var sg = M.segments[S.seg];
      if (S.entered !== S.seg) { enterSegment(sg); if (S.halted) return null; }
      if (sg.length_m - S.off <= EPS) { finishSegment(); return null; }
      if (!(sg.model.v > 0)) { halt('ROVER_IMMOBILE', 'Effective speed on segment ' + sg.id + ' is 0 (mobility factor 0).', { segment_id: sg.id }); return null; }
      return { kind: 'drive', load: sg.model.p, v: sg.model.v, max: (sg.length_m - S.off) / sg.model.v };
    }

    function advance(dt) {
      if (M.errors.length || S.halted || S.done) return;
      S.started = true;
      var left = dt, guard = 0, lim = M.limits.max_mission_s;
      if (!S.trace.length) trace(true);
      while (left > EPS && !S.halted && !S.done) {
        if (++guard > 3000000) { halt('SIM_GUARD', 'Internal step guard tripped.', {}); break; }
        var act = dispatch(); if (!act) continue;
        if (lim != null && !S.timeExceeded && S.t >= lim - 1e-6) {
          if (options.onViolation === 'record_and_continue') { S.timeExceeded = true; emit('TIME_LIMIT_EXCEEDED', 'violation', 'Mission time limit of ' + rd(lim, 1) + ' s exceeded.', { limit_s: lim }); }
          else { halt('TIME_LIMIT_REACHED', 'Mission time limit of ' + rd(lim, 1) + ' s reached before the mission was finished.', { limit_s: lim }); break; }
        }
        var net = act.load - M.solar_w;
        if (net > 0 && S.E - M.reserve_wh <= TOL_WH) {
          if (S.E <= TOL_WH) { halt('BATTERY_DEPLETED', 'Battery is empty.', { energy_wh: S.E }); break; }
          if (options.onViolation === 'record_and_continue' && !S.reserveBreached) { S.reserveBreached = true; emit('BATTERY_BELOW_RESERVE', 'violation', 'Battery fell below the reserve of ' + rd(M.reserve_wh, 1) + ' Wh.', { energy_wh: S.E, reserve_wh: M.reserve_wh }); }
          else if (options.onViolation !== 'record_and_continue') { halt('BATTERY_BELOW_RESERVE', 'Battery reached the reserve of ' + rd(M.reserve_wh, 1) + ' Wh (' + rd(S.E, 1) + ' Wh left).', { energy_wh: S.E, reserve_wh: M.reserve_wh }); break; }
        }
        var step = Math.min(left, act.max);
        if (lim != null && !S.timeExceeded) step = Math.min(step, Math.max(0, lim - S.t));
        if (net > 0) {
          var floor = (options.onViolation === 'record_and_continue' && S.reserveBreached) ? 0 : M.reserve_wh;
          var tc = (S.E - floor) * 3600 / net; if (tc > 0) step = Math.min(step, tc);
        } else if (net < 0 && S.E < M.usable_wh) step = Math.min(step, (M.usable_wh - S.E) * 3600 / (-net));
        if (!(step > 0)) step = Math.min(left, act.max) > 0 ? Math.min(left, act.max, 1e-6) : 0;
        if (!(step > 0)) continue;
        var eLoad = act.load * step / 3600, eSol = M.solar_w * step / 3600, nE = S.E - eLoad + eSol;
        if (nE > M.usable_wh) { S.curtailed += nE - M.usable_wh; nE = M.usable_wh; }
        if (nE < 0) nE = 0;
        S.E = nE; if (S.E < S.minE) S.minE = S.E;
        S.energy_by[act.kind] += eLoad; S.time_by[act.kind] += step; S.gen += eSol; S.t += step; left -= step;
        if (act.kind === 'drive') {
          var sg = M.segments[S.seg], lg = S.segLog[S.seg], dd = act.v * step;
          S.off += dd; S.dist += dd; lg.time_s += step; lg.energy_wh += eLoad; lg.traveled_m += dd;
          if (sg.length_m - S.off <= 1e-7) { S.dist += sg.length_m - S.off; lg.traveled_m += sg.length_m - S.off; S.off = sg.length_m; }
        } else if (act.kind === 'dwell') { S.dwell.left -= step; if (S.dwell.left <= 1e-9) S.dwell.left = 0; }
        else if (act.kind === 'wait') { S.wait.left -= step; if (S.wait.left <= 1e-9) S.wait.left = 0; }
        trace(false);
      }
      if (S.halted || S.done) trace(true);
    }

    // ---- views
    function status() {
      if (M.errors.length) return 'invalid';
      if (S.halted) return 'halted'; if (S.done) return 'completed';
      if (S.playing) return 'running'; return S.started ? 'paused' : 'idle';
    }
    function totalDistance() { return M.segments.reduce(function (a, s) { return a + s.length_m; }, 0); }
    function objLists() {
      var c = [], p = [], k = [];
      M.objectives.forEach(function (o) { var st = S.objStatus[o.id]; (st === 'completed' ? c : st === 'skipped' ? k : p).push(o.id); });
      return { completed: c, pending: p, skipped: k };
    }
    function getState(consumeEvents) {
      var pos = positionAt(S.seg, S.off), total = totalDistance(), sg = S.seg < M.segments.length ? M.segments[S.seg] : null;
      var ol = objLists(), lim = M.limits.max_mission_s;
      var phase = S.halted ? 'halted' : S.done ? 'done' : S.wait ? 'waiting' : (S.atWp && S.dwell) ? 'dwelling' : (S.atWp ? 'at_waypoint' : 'driving');
      var cur = (S.dwell && S.objStatus[S.dwell.id] === 'pending') ? S.dwell.id : null;
      var drivenInPlan = 0; for (var i = 0; i < M.segments.length; i++) drivenInPlan += i < S.seg ? M.segments[i].length_m : (i === S.seg ? S.off : 0);
      var st = {
        contract: CONTRACT.state, plan_id: M.plan_id, tick: S.tick, status: status(), phase: phase,
        halted: S.halted ? clone(S.halted) : null,
        time: { elapsed_s: rd(S.t, 3), run_elapsed_s: rd(S.t - S.t0, 3), limit_s: lim, remaining_s: lim != null ? rd(Math.max(0, lim - S.t), 3) : null },
        position: { x_m: rd(pos.x_m, 3), y_m: rd(pos.y_m, 3), lon_deg: pos.lon_deg != null ? rd(pos.lon_deg, 7) : null, lat_deg: pos.lat_deg != null ? rd(pos.lat_deg, 7) : null, elevation_m: pos.elevation_m != null ? rd(pos.elevation_m, 2) : null,
          provenance: 'simulated (interpolated along planned route)' },
        route: { segment_index: sg ? sg.index : null, segment_count: M.segments.length, segment_id: sg ? sg.id : null, from: sg ? sg.from : null, to: sg ? sg.to : null,
          distance_traveled_m: rd(drivenInPlan, 3), total_distance_m: rd(total, 3), remaining_distance_m: rd(Math.max(0, total - drivenInPlan), 3), progress_fraction: total > 0 ? rd(clamp(drivenInPlan / total, 0, 1), 5) : null },
        objectives: { completed: ol.completed, pending: ol.pending, skipped: ol.skipped, current: cur, total: M.objectives.length },
        resources: { battery_wh: rd(S.E, 4), usable_capacity_wh: rd(M.usable_wh, 3), soc_frac: M.usable_wh > 0 ? rd(S.E / M.usable_wh, 5) : null, reserve_wh: rd(M.reserve_wh, 3), above_reserve_wh: rd(S.E - M.reserve_wh, 4),
          consumed_wh: { drive: rd(S.energy_by.drive, 4), dwell: rd(S.energy_by.dwell, 4), wait: rd(S.energy_by.wait, 4), total: rd(S.energy_by.drive + S.energy_by.dwell + S.energy_by.wait, 4) },
          generated_wh: rd(S.gen, 4), provenance: 'simulated (assumed rover power model)' },
        terrain: sg ? { slope_deg: sg.slope_deg, slope_deg_max: sg.slope_deg_max, roughness_std: sg.roughness_std, tri: sg.tri, traction_speed_factor: sg.traction_speed_factor, known: sg.terrain_known, source: sg.terrain_source || (sg.terrain_known ? 'plan' : 'unknown') } : null,
        rover: { speed_mps: (phase === 'driving' && sg) ? rd(sg.model.v, 5) : 0, condition: clone(R.condition) },
        events_new: S.newEvents.slice(), events_total: S.events.length
      };
      if (consumeEvents) S.newEvents = [];
      return st;
    }
    function resumeState() {
      var ol = objLists();
      return { elapsed_s: S.t, energy_wh: S.E, distance_m: S.dist, segment_index: Math.min(S.seg, M.segments.length), offset_m: S.off, at_waypoint: S.atWp, dwell: S.dwell ? clone(S.dwell) : null, completed: ol.completed, skipped: ol.skipped };
    }
    function emitState() { S.tick++; var st = getState(true); fire('state', st); if (st.status !== lastStatus) { lastStatus = st.status; fire('status', st.status); } return st; }

    function getReport() {
      var segs = M.segments.map(function (sg, i) {
        var lg = S.segLog[i], L = sg.length_m, f = L > EPS ? clamp(lg.traveled_m / L, 0, 1) : (lg.status === 'completed' ? 1 : 0), m = sg.model;
        var fin = function (x) { return isFinite(x) ? x * f : null; };
        return { index: i, id: sg.id, from: sg.from, to: sg.to, status: lg.status, length_m: rd(L, 3), length_source: sg.length_source, traveled_m: rd(lg.traveled_m, 3),
          slope_deg: sg.slope_deg, slope_deg_max: sg.slope_deg_max, roughness_std: sg.roughness_std, roughness_std_max: sg.roughness_std_max, tri: sg.tri, traction_speed_factor: sg.traction_speed_factor, terrain_known: sg.terrain_known,
          planned_speed_mps: rd(m.v, 6), planned_load_w: rd(m.p, 4), time_s: rd(lg.time_s, 4), energy_wh: rd(lg.energy_wh, 4),
          nominal_time_s: rd(fin(m.nom_t_full), 4), nominal_energy_wh: rd(fin(m.nom_e_full), 4), flat_nominal_time_s: rd(fin(m.flat_t_full), 4), flat_nominal_energy_wh: rd(fin(m.flat_e_full), 4),
          started_t_s: lg.started_t, finished_t_s: lg.finished_t };
      });
      var drv = { flat_e: 0, nom_e: 0, act_e: 0, flat_t: 0, nom_t: 0, act_t: 0 };
      segs.forEach(function (s) { drv.flat_e += s.flat_nominal_energy_wh || 0; drv.nom_e += s.nominal_energy_wh || 0; drv.act_e += s.energy_wh; drv.flat_t += s.flat_nominal_time_s || 0; drv.nom_t += s.nominal_time_s || 0; drv.act_t += s.time_s; });
      var ol = objLists(), total = totalDistance(), driven = 0;
      M.segments.forEach(function (sg, i) { driven += i < S.seg ? sg.length_m : (i === S.seg ? S.off : 0); });
      var consumed = S.energy_by.drive + S.energy_by.dwell + S.energy_by.wait;
      var objectives = M.objectives.map(function (o) { var st = S.objStatus[o.id]; return { id: o.id, label: o.label, waypoint_id: o.waypoint_id, required: o.required, dwell_s: o.dwell_s, requires: o.requires, status: st === 'completed' ? 'completed' : st === 'skipped' ? 'skipped' : 'incomplete', completed_t_s: S.objT[o.id] != null ? S.objT[o.id] : null }; });
      return {
        contract: CONTRACT.report, version: VERSION, plan_id: M.plan_id, plan_name: M.plan_name, body: M.body, rover_id: R.id, rover: clone(R),
        status: status(), halted: S.halted ? clone(S.halted) : null, validation: { errors: M.errors.slice(), warnings: M.warnings.slice() },
        totals: {
          run_started_at_s: S.t0, elapsed_s: S.t, run_elapsed_s: S.t - S.t0, time_by_activity_s: { drive: S.time_by.drive, dwell: S.time_by.dwell, wait: S.time_by.wait },
          planned_distance_m: total, distance_in_plan_m: driven, progress_fraction: total > 0 ? clamp(driven / total, 0, 1) : null, distance_travelled_this_run_m: S.dist - (options.initial ? (options.initial.distance_m || 0) : 0),
          energy: { start_wh: S.E0, end_wh: S.E, min_wh: S.minE, reserve_wh: M.reserve_wh, usable_capacity_wh: M.usable_wh, nameplate_capacity_wh: R.battery_capacity_wh,
            consumed_wh: { drive: S.energy_by.drive, dwell: S.energy_by.dwell, wait: S.energy_by.wait, total: consumed }, generated_wh: S.gen, curtailed_wh: S.curtailed,
            balance_check_wh: S.E0 - consumed + S.gen - S.curtailed - S.E,
            decomposition_wh: { drive_flat_nominal: drv.flat_e, drive_terrain_excess: drv.nom_e - drv.flat_e, drive_condition_excess: drv.act_e - drv.nom_e,
              dwell_nominal: S.energy_by.dwell / pf, dwell_condition_excess: S.energy_by.dwell - S.energy_by.dwell / pf, wait_nominal: S.energy_by.wait / pf, wait_condition_excess: S.energy_by.wait - S.energy_by.wait / pf } },
          time_decomposition_s: { drive_flat_nominal: drv.flat_t, drive_terrain_slowdown: drv.nom_t - drv.flat_t, drive_condition_slowdown: drv.act_t - drv.nom_t, dwell: S.time_by.dwell, wait: S.time_by.wait },
          provenance: 'simulated (assumed model); not measured'
        },
        objectives: objectives, objective_summary: { total: objectives.length, completed: ol.completed.length, skipped: ol.skipped.length, incomplete: objectives.length - ol.completed.length - ol.skipped.length,
          required_total: objectives.filter(function (o) { return o.required; }).length, required_completed: objectives.filter(function (o) { return o.required && o.status === 'completed'; }).length },
        segments: segs, waypoints: M.waypoints.map(function (w) { return { id: w.id, x_m: w.x_m, y_m: w.y_m, lon_deg: w.lon_deg, lat_deg: w.lat_deg, elevation_m: w.elevation_m }; }),
        events: S.events.slice(), trace: S.trace.slice(), limits: clone(M.limits), constraints: clone(M.constraints), plan_estimate: estimateAtStart,
        resume: resumeState(), alternatives_available: M.alternatives.length, data_gaps: M.gaps.slice(), assumptions: ASSUMPTIONS.slice(),
        provenance: { route: 'plan (Person 1 contract, provisional)', terrain: 'plan (per-segment values as supplied)', rover_parameters: R.parameter_provenance, motion_and_energy: 'simulated', position: 'simulated (interpolated)' }
      };
    }

    // ---- public controller
    function startTimer() {
      if (timer != null) return;
      timer = sched.setInterval(function () {
        if (!S.playing) return;
        advance(stepSeconds * speedMult); emitState();
        if (S.halted || S.done) { S.playing = false; stopTimer(); emitState(); }
      }, tickMs);
    }
    function stopTimer() { if (timer != null) { sched.clearInterval(timer); timer = null; } }

    var ctl = {
      version: VERSION, validation: { errors: M.errors.slice(), warnings: M.warnings.slice(), data_gaps: M.gaps.slice() },
      play: function () { if (M.errors.length || S.halted || S.done) return getState(false); S.playing = true; S.started = true; startTimer(); return emitState(); },
      pause: function () { if (S.playing) { S.playing = false; stopTimer(); } return emitState(); },
      resume: function () { return ctl.play(); },
      reset: function () { stopTimer(); S = initState(); lastStatus = null; return emitState(); },
      tick: function (simSeconds) { advance(positive(simSeconds) ? simSeconds : stepSeconds * speedMult); return emitState(); },
      runToEnd: function () { stopTimer(); S.playing = false; advance(Infinity); emitState(); return getReport(); },
      setSpeed: function (m) { if (positive(m)) speedMult = m; return speedMult; },
      getState: function () { return getState(false); },
      getReport: getReport,
      snapshot: function () { return { state: getState(false), resume: resumeState() }; },
      applyAction: function (a) {
        if (!a || S.halted || S.done) return false;
        if (a.type === 'WAIT' && positive(a.duration_s)) { S.pre.push({ duration_s: a.duration_s, reason: a.reason || 'WAIT action' }); return true; }
        if (a.type === 'SKIP_OBJECTIVE' && S.objStatus[a.objective_id] === 'pending') { S.objStatus[a.objective_id] = 'skipped'; if (S.dwell && S.dwell.id === a.objective_id) S.dwell = null; emit('OBJECTIVE_SKIPPED', 'info', 'Objective ' + a.objective_id + ' skipped by action.', { objective_id: a.objective_id }); return true; }
        return false;
      },
      on: function (evt, fn) { if (!listeners[evt]) return function () {}; listeners[evt].push(fn); return function () { var k = listeners[evt].indexOf(fn); if (k !== -1) listeners[evt].splice(k, 1); }; }
    };
    S = initState();
    return ctl;
  }

  return { version: VERSION, CONTRACT: CONTRACT, DEFAULT_ROVER: DEFAULT_ROVER, NOMINAL_CONDITION: NOMINAL_CONDITION, ASSUMPTIONS: ASSUMPTIONS, BODY_RADIUS_M: BODY_RADIUS_M,
    normalizeRover: normalizeRover, validate: function (plan, rover) { var M = prepare(plan, { rover: rover }); return { errors: M.errors, warnings: M.warnings, data_gaps: M.gaps, limits: M.limits }; },
    createSimulation: createSimulation, estimatePlan: estimatePlan,
    run: function (plan, options) { return createSimulation(plan, options).runToEnd(); } };
});
