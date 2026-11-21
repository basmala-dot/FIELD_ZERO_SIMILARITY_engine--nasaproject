/*! FIELD//ZERO failure analysis and recovery v0.1.0
 *
 *  RULE-BASED ANALYSIS OF SIMULATED RUNS. NOT A RELIABILITY OR FMEA MODEL. No failure probabilities are produced.
 *
 *  Detects failures from a route-simulation report ("FZ-SIM-REPORT-0.1") and the constraints stored in it, explains
 *  causes with an accounting decomposition under the assumed energy/time model, states consequences for the mission,
 *  and evaluates recovery actions by SIMULATING A CONTINUATION from the failure point (same model, same assumptions).
 *
 *  Pure computation (browser + Node 18+), deterministic. Reads only: report, plan, rover. Never mutates its inputs.
 *
 *  ======================================================================================
 *  INPUT   analyze(report, context)
 *    report   FZ-SIM-REPORT-0.1 from FieldZeroSim (required)
 *    context  { plan, rover, deps?: {simulation}, evaluateRecovery?: true (false skips the continuation runs), maxBisection?: 40 }
 *             plan + rover are needed only for recovery evaluation; detection and causes need the report alone.
 *             plan.alternatives (planner detours, consumed read-only; this module never invents a route):
 *               [ { id, from, to,            // waypoint ids of the segment being replaced
 *                   waypoints: [ {id,x_m,y_m,...} ],   // intermediate (via) waypoints of the detour, may be []
 *                   segments:  [ {...} ] } ]           // length = waypoints.length + 1, same fields as plan.segments
 *  OUTPUT  "FZ-FAILURE-ANALYSIS-0.1"
 *    { status, failures[], warnings[], margins, summary, limitations[], assumptions[] }
 *    failure = { id, code, severity, t_s, location, message, detected_by, causes, consequences, recovery, mission_impact }
 *    recovery = { evaluated, feasibility: 'full'|'partial'|'none'|'not_evaluated', best_action_id, explanation, actions[] }
 *    action = { id, type, description, applicable, feasible, feasibility_reason, requires[], estimate:{action_time_s, energy_wh, ...},
 *               outcome:{ status, required_completed, required_total, progress_fraction, elapsed_s, total_energy_consumed_wh,
 *                         final_energy_wh, halted_code }, tradeoffs[], provenance }
 *
 *  FORMULAS
 *   Energy accounting (Wh):   consumed = flat_nominal_driving + terrain_excess + condition_excess + dwell_nominal + wait_nominal
 *     terrain_excess = sum(nominal_energy - flat_nominal_energy) over travelled segments   (slope/roughness/surface effect)
 *     condition_excess = actual - nominal energy (rover.condition: power_draw_factor, mobility)
 *     supply side: nameplate - usable = battery_health loss; usable - start = reduced initial charge; reserve = policy.
 *   Time accounting (s): same split for driving time (terrain_slowdown, condition_slowdown) + dwell + wait.
 *   These shares are an ACCOUNTING decomposition under the assumed model, not proof of physical causation.
 *   Recharge wait: net_charge_w = solar_input_w - idle_power_w * power_draw_factor; minimal wait found by bisection over
 *     [0, (usable - E)/net_charge_w] using the simulation itself; infeasible if no charging source is defined.
 *   Risk margins:  energy_m = (min_E - reserve)/(usable - reserve), risk 1 - clamp(m/0.30);  time_m = (limit - elapsed)/limit,
 *     risk 1 - clamp(m/0.20);  terrain_m = 1 - max_segment_slope/limit, risk 1 - clamp(m/0.25);  data_risk = share of segments
 *     with unknown slope.  index = 100 * (0.5*max + 0.5*weighted_mean) with weights energy .4, time .2, terrain .3, data .1
 *     (not-applicable components dropped); a halted run is 100.  A HEURISTIC INDEX, NOT A PROBABILITY.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.FieldZeroFailure = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (root) {
  'use strict';

  var VERSION = '0.1.0', CONTRACT = 'FZ-FAILURE-ANALYSIS-0.1';
  var BATTERY = { BATTERY_BELOW_RESERVE: 1, BATTERY_DEPLETED: 1 };
  var TIME = { TIME_LIMIT_REACHED: 1, TIME_LIMIT_EXCEEDED: 1 };
  var TERRAIN = { SLOPE_EXCEEDS_LIMIT: 1, ROUGHNESS_EXCEEDS_LIMIT: 1, SEGMENT_BLOCKED: 1 };
  var FAILURE_CODES = { BATTERY_BELOW_RESERVE: 1, BATTERY_DEPLETED: 1, TIME_LIMIT_REACHED: 1, TIME_LIMIT_EXCEEDED: 1, SLOPE_EXCEEDS_LIMIT: 1, ROUGHNESS_EXCEEDS_LIMIT: 1, SEGMENT_BLOCKED: 1, ROVER_IMMOBILE: 1, SIM_GUARD: 1 };
  var ASSUMPTIONS = [
    'Recovery options are evaluated by re-running the same assumed simulation model from the failure point; they are not validated operational procedures.',
    'A recharge wait is only evaluated when a constant charging power (environment.solar_input_w) is supplied; otherwise it is reported as infeasible/unsupported, not guessed.',
    'Alternative routes are only evaluated when the planner supplies them in plan.alternatives; this module never invents routes or terrain.',
    'Cause shares are an accounting decomposition under the assumed model; they indicate which modelled term dominates, not physical proof.',
    'No failure probabilities, hardware faults or comms/thermal failures are modelled; only constraint violations of the simulated state are detected.'
  ];
  var LIMITATIONS = [
    'Only failures expressible through simulated energy, time, slope, roughness and planner blockage flags can be detected.',
    'Recovery time and resource estimates inherit every assumption of the rover model (see report.assumptions).',
    'Missing terrain data prevents limit checks on the affected segments; those segments are listed as data gaps, not as safe.'
  ];

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function rd(v, d) { if (!isNum(v)) return v; var k = Math.pow(10, d == null ? 3 : d); return Math.round(v * k) / k; }
  function dep(ctx, key, g, file) {
    if (ctx && ctx.deps && ctx.deps[key]) return ctx.deps[key];
    if (root && root[g]) return root[g];
    if (typeof require === 'function') { try { return require(file); } catch (e) { /* not available */ } }
    return null;
  }
  function fmtT(s) { if (!isNum(s)) return 'n/a'; if (s < 120) return rd(s, 1) + ' s'; if (s < 7200) return rd(s / 60, 1) + ' min'; return rd(s / 3600, 2) + ' h'; }

  // ------------------------------------------------------------------ margins / risk
  function margins(report) {
    var E = report.totals.energy, L = report.limits || {}, comps = [], W = { energy: 0.4, time: 0.2, terrain: 0.3, data: 0.1 };
    var span = E.usable_capacity_wh - E.reserve_wh;
    var em = span > 0 ? (E.min_wh - E.reserve_wh) / span : null;
    comps.push({ id: 'energy', margin_frac: em, risk: em == null ? null : 1 - clamp(em / 0.30, 0, 1), weight: W.energy, note: 'lowest battery level vs reserve, as share of usable-above-reserve' });
    var tm = isNum(L.max_mission_s) && L.max_mission_s > 0 ? (L.max_mission_s - report.totals.elapsed_s) / L.max_mission_s : null;
    comps.push({ id: 'time', margin_frac: tm, risk: tm == null ? null : 1 - clamp(tm / 0.20, 0, 1), weight: W.time, note: 'time left vs mission limit' });
    var smax = null, unknown = 0;
    (report.segments || []).forEach(function (s) { if (s.slope_deg_max != null) smax = smax == null ? s.slope_deg_max : Math.max(smax, s.slope_deg_max); if (!s.terrain_known) unknown++; });
    var tmar = (smax != null && L.slope_deg > 0) ? 1 - smax / L.slope_deg : null;
    comps.push({ id: 'terrain', margin_frac: tmar, risk: tmar == null ? null : 1 - clamp(tmar / 0.25, 0, 1), weight: W.terrain, note: 'steepest planned segment vs effective slope limit' });
    var n = (report.segments || []).length;
    comps.push({ id: 'data', margin_frac: n ? 1 - unknown / n : null, risk: n ? unknown / n : null, weight: W.data, note: 'share of segments with unknown slope' });
    var act = comps.filter(function (c) { return c.risk != null; }), wsum = 0, wr = 0, mx = 0;
    act.forEach(function (c) { wsum += c.weight; wr += c.weight * c.risk; mx = Math.max(mx, c.risk); });
    var idx = act.length ? 100 * (0.5 * mx + 0.5 * (wr / wsum)) : null;
    if (report.status === 'halted') idx = 100;
    return { risk_index: idx == null ? null : rd(idx, 1), components: comps.map(function (c) { return { id: c.id, margin_frac: c.margin_frac == null ? null : rd(c.margin_frac, 4), risk: c.risk == null ? null : rd(c.risk, 4), weight: c.weight, note: c.note }; }),
      formula: 'index = 100*(0.5*max(risk_i) + 0.5*weighted_mean(risk_i)); halted run = 100. Heuristic, not a probability.', provenance: 'derived from simulated values' };
  }

  // ------------------------------------------------------------------ causes
  function energyCauses(report) {
    var E = report.totals.energy, D = E.decomposition_wh, C = E.consumed_wh.total;
    var share = function (wh) { return C > 0 ? rd(wh / C, 4) : null; };
    var demand = [
      { factor: 'route_length_flat_driving', label: 'Driving the planned distance on flat nominal ground', wh: D.drive_flat_nominal, baseline: true },
      { factor: 'terrain_slope_roughness_surface', label: 'Extra driving energy from slope, roughness and surface (speed derate + power rise)', wh: D.drive_terrain_excess },
      { factor: 'rover_condition', label: 'Extra energy from degraded rover condition (power draw factor / reduced mobility)', wh: D.drive_condition_excess + D.dwell_condition_excess + D.wait_condition_excess },
      { factor: 'objective_activities', label: 'Dwell / science activities at objectives', wh: D.dwell_nominal },
      { factor: 'waiting_idle', label: 'Waiting / idle load', wh: D.wait_nominal }
    ].map(function (c) { c.wh = rd(c.wh, 3); c.share_of_consumed = share(c.wh); return c; });
    var supply = [
      { factor: 'battery_health_loss', label: 'Battery capacity lost to degradation (nameplate - usable)', wh: E.nameplate_capacity_wh - E.usable_capacity_wh },
      { factor: 'reduced_initial_charge', label: 'Battery not fully charged at the start of this run', wh: E.usable_capacity_wh - E.start_wh },
      { factor: 'reserve_policy', label: 'Energy held back as reserve (policy, not spendable)', wh: E.reserve_wh, policy: true }
    ].map(function (c) { c.wh = rd(Math.max(0, c.wh), 3); return c; }).filter(function (c) { return c.wh > 1e-6; });
    var cand = demand.filter(function (c) { return !c.baseline; }).concat(supply.filter(function (c) { return !c.policy; })).filter(function (c) { return c.wh > 1e-6; }).sort(function (a, b) { return b.wh - a.wh; });
    return { demand_side: demand, supply_side: supply, primary_candidates: cand };
  }
  function timeCauses(report) {
    var T = report.totals.time_decomposition_s, tot = T.drive_flat_nominal + T.drive_terrain_slowdown + T.drive_condition_slowdown + T.dwell + T.wait;
    var items = [
      { factor: 'route_length_flat_driving', label: 'Driving the planned distance on flat nominal ground', s: T.drive_flat_nominal, baseline: true },
      { factor: 'terrain_slowdown', label: 'Slower driving on slopes/rough/low-traction segments', s: T.drive_terrain_slowdown },
      { factor: 'rover_condition_slowdown', label: 'Slower driving from degraded mobility', s: T.drive_condition_slowdown },
      { factor: 'objective_activities', label: 'Dwell / science activities', s: T.dwell },
      { factor: 'waiting', label: 'Waiting', s: T.wait }
    ].map(function (c) { c.s = rd(c.s, 2); c.share_of_elapsed_activity = tot > 0 ? rd(c.s / tot, 4) : null; return c; });
    return { items: items, primary_candidates: items.filter(function (c) { return !c.baseline && c.s > 1e-6; }).sort(function (a, b) { return b.s - a.s; }) };
  }

  function explainCause(f, report) {
    var ev = f.event, d = ev.data || {}, L = report.limits, out = { summary: '', primary: null, evidence: [] };
    if (BATTERY[f.code]) {
      var ec = energyCauses(report), E = report.totals.energy, avail = E.start_wh - E.reserve_wh, est = report.plan_estimate;
      out.demand_side = ec.demand_side; out.supply_side = ec.supply_side;
      var top = ec.primary_candidates[0];
      out.primary = top ? top.factor : 'route_length_flat_driving';
      out.evidence.push('Consumed ' + rd(E.consumed_wh.total, 1) + ' Wh in this run against ' + rd(avail, 1) + ' Wh available above the reserve (start ' + rd(E.start_wh, 1) + ' Wh, reserve ' + rd(E.reserve_wh, 1) + ' Wh).');
      if (est && est.energy_wh != null) {
        out.evidence.push('Pre-run analytic estimate of the full plan: ' + rd(est.energy_wh, 1) + ' Wh versus ' + rd(avail, 1) + ' Wh available' + (est.energy_wh > avail ? ' (the plan was energy-infeasible from the start under this model).' : '.'));
        out.structural_shortfall_wh = rd(Math.max(0, est.energy_wh - avail), 2);
      }
      out.summary = 'Battery ' + (f.code === 'BATTERY_DEPLETED' ? 'was depleted' : 'reached its reserve') + ' because modelled demand exceeded the usable energy. ' +
        (top ? 'Largest modelled contributor beyond plain route length: ' + top.label.toLowerCase() + ' (' + rd(top.wh, 1) + ' Wh).' : 'No modelled penalty term dominates; the planned route length and activities alone exceed the available energy.');
    } else if (TIME[f.code]) {
      var tc = timeCauses(report), lim = L.max_mission_s;
      out.items = tc.items; out.primary = tc.primary_candidates[0] ? tc.primary_candidates[0].factor : 'route_length_flat_driving';
      out.evidence.push('Elapsed ' + fmtT(report.totals.elapsed_s) + ' against a limit of ' + fmtT(lim) + '.');
      if (report.plan_estimate) out.evidence.push('Pre-run analytic estimate of the full plan: ' + fmtT(report.plan_estimate.time_s) + '.');
      var tp = tc.primary_candidates[0];
      out.summary = 'The mission time limit was reached before the route/objectives finished. ' + (tp ? 'Largest modelled time penalty: ' + tp.label.toLowerCase() + ' (' + fmtT(tp.s) + ').' : 'Plain route length and activities alone exceed the limit.');
    } else if (f.code === 'SLOPE_EXCEEDS_LIMIT') {
      out.primary = d.governed_by === 'route_constraint' ? 'route_constraint_slope_limit' : 'rover_slope_capability';
      out.evidence.push('Segment ' + d.segment_id + ': max slope ' + rd(d.slope_deg_max, 2) + ' deg vs limit ' + rd(d.limit_deg, 2) + ' deg.');
      out.evidence.push('Rover effective slope limit ' + rd(d.rover_limit_deg, 2) + ' deg' + (d.constraint_limit_deg != null ? '; planning constraint ' + rd(d.constraint_limit_deg, 2) + ' deg' : '; no planning constraint set') + '.');
      if (d.rover_limit_deg < report.rover.max_slope_deg - 1e-9) out.evidence.push('Rover limit is reduced from ' + rd(report.rover.max_slope_deg, 2) + ' deg by condition (slope_limit_factor ' + report.rover.condition.slope_limit_factor + ').');
      out.summary = 'The planned segment is steeper than the ' + (d.governed_by === 'route_constraint' ? 'planning constraint (the rover itself could climb up to ' + rd(d.rover_limit_deg, 1) + ' deg)' : 'rover slope capability') + '.';
    } else if (f.code === 'ROUGHNESS_EXCEEDS_LIMIT') {
      out.primary = d.governed_by === 'route_constraint' ? 'route_constraint_roughness_limit' : 'rover_roughness_capability';
      out.evidence.push('Segment ' + d.segment_id + ': roughness ' + rd(d.roughness_std_max, 2) + ' vs limit ' + rd(d.limit, 2) + '.');
      out.summary = 'Planned segment roughness exceeds the ' + (d.governed_by === 'route_constraint' ? 'planning constraint.' : 'rover capability.');
    } else if (f.code === 'SEGMENT_BLOCKED') {
      out.primary = 'planner_blocked_segment'; out.evidence.push('Segment ' + d.segment_id + ' has passable=false in the plan.');
      out.summary = 'The plan marks this segment as not passable, so the route cannot continue along it.';
    } else if (f.code === 'ROVER_IMMOBILE') { out.primary = 'zero_mobility'; out.summary = 'Rover mobility factor is 0, so no segment can be driven.'; out.evidence.push('rover.condition.mobility = 0'); }
    else { out.primary = 'unknown'; out.summary = 'Failure code not covered by the cause rules.'; }
    return out;
  }

  // ------------------------------------------------------------------ detection
  function detect(report) {
    var fails = [], seen = {};
    (report.events || []).forEach(function (ev) {
      if ((ev.severity === 'failure' || ev.severity === 'violation') && FAILURE_CODES[ev.code]) {
        fails.push({ code: ev.code, severity: ev.severity, t_s: ev.t_s, message: ev.message, event: ev, detected_by: 'simulation_event' }); seen[ev.code] = true;
      }
    });
    // cross-checks from stored values, only where the simulator did not already report the condition
    var L = report.limits || {}, E = report.totals.energy;
    if (!seen.TIME_LIMIT_REACHED && !seen.TIME_LIMIT_EXCEEDED && isNum(L.max_mission_s) && report.totals.elapsed_s > L.max_mission_s + 1e-6)
      fails.push({ code: 'TIME_LIMIT_EXCEEDED', severity: 'violation', t_s: report.totals.elapsed_s, message: 'Elapsed time exceeds the mission limit.', event: { data: { limit_s: L.max_mission_s } }, detected_by: 'cross_check' });
    if (!seen.BATTERY_BELOW_RESERVE && !seen.BATTERY_DEPLETED && E.min_wh < E.reserve_wh - 1e-6)
      fails.push({ code: 'BATTERY_BELOW_RESERVE', severity: 'violation', t_s: report.totals.elapsed_s, message: 'Battery minimum is below the reserve.', event: { data: {} }, detected_by: 'cross_check' });
    if (!seen.SLOPE_EXCEEDS_LIMIT) (report.segments || []).forEach(function (s) {
      if (s.slope_deg_max != null && s.traveled_m > 0 && s.slope_deg_max > L.slope_deg + 1e-9) fails.push({ code: 'SLOPE_EXCEEDS_LIMIT', severity: 'violation', t_s: s.started_t_s, message: 'Travelled segment ' + s.id + ' is steeper than the limit.',
        event: { data: { segment_id: s.id, slope_deg_max: s.slope_deg_max, limit_deg: L.slope_deg, governed_by: L.slope_governed_by, rover_limit_deg: L.rover_slope_limit_deg, constraint_limit_deg: L.constraint_slope_limit_deg } }, detected_by: 'cross_check' }); });
    fails.sort(function (a, b) { return (a.t_s || 0) - (b.t_s || 0); });
    return fails;
  }

  function warningsFrom(report) {
    var w = [];
    (report.events || []).forEach(function (e) { if (e.severity === 'warning') w.push({ code: e.code, t_s: e.t_s, message: e.message }); });
    (report.data_gaps || []).forEach(function (g) { w.push({ code: g.code, message: g.message }); });
    var m = margins(report);
    m.components.forEach(function (c) { if (report.status === 'completed' && c.margin_frac != null && c.risk >= 0.5 && c.id !== 'data') w.push({ code: 'THIN_MARGIN_' + c.id.toUpperCase(), message: 'Mission completed but the ' + c.id + ' margin is only ' + rd(c.margin_frac * 100, 1) + '% (' + c.note + ').' }); });
    return w;
  }

  // ------------------------------------------------------------------ outcome helpers
  function classify(requiredCompleted, requiredTotal, routeComplete) {
    if (requiredTotal === 0) return routeComplete ? 'SUCCESS' : 'FAILED';
    if (requiredCompleted === requiredTotal && routeComplete !== false) return 'SUCCESS';
    return requiredCompleted > 0 ? 'PARTIAL' : 'FAILED';
  }
  function outcomeFrom(cont, base) {
    var os = cont.objective_summary;
    var consumed = (base.totals.energy.consumed_wh.total || 0) + cont.totals.energy.consumed_wh.total;
    return { status: cont.status, halted_code: cont.halted ? cont.halted.code : null, required_completed: os.required_completed, required_total: os.required_total, objectives_completed: os.completed, objectives_total: os.total,
      progress_fraction: rd(cont.totals.progress_fraction, 4), elapsed_s: rd(cont.totals.elapsed_s, 2), total_energy_consumed_wh: rd(consumed, 3), final_energy_wh: rd(cont.totals.energy.end_wh, 3),
      mission_class: classify(os.required_completed, os.required_total, cont.status === 'completed'), provenance: 'simulated continuation (assumed model)' };
  }
  function completesAllRequired(o) { return o.status === 'completed' && o.required_completed === o.required_total; }

  // ------------------------------------------------------------------ recovery evaluation
  function modPlan(plan, patch) {
    var p = clone(plan); p.constraints = p.constraints || {};
    Object.keys(patch || {}).forEach(function (k) { p.constraints[k] = patch[k]; }); return p;
  }
  function evaluateRecovery(failure, report, ctx) {
    var Sim = dep(ctx, 'simulation', 'FieldZeroSim', './route-simulation.js');
    var plan = ctx.plan, rover = ctx.rover;
    var out = { evaluated: false, feasibility: 'not_evaluated', best_action_id: null, explanation: '', actions: [] };
    var base = report;
    var requiredTotal = base.objective_summary.required_total, rc = base.objective_summary.required_completed;
    // always: accept partial outcome
    out.actions.push({ id: 'ACCEPT_PARTIAL', type: 'ACCEPT_PARTIAL', description: 'Stop here and keep what was achieved so far.', applicable: true, feasible: true, feasibility_reason: 'No further action; outcome is the state at failure.',
      requires: [], estimate: { action_time_s: 0, energy_wh: 0 }, outcome: { status: base.status, halted_code: base.halted ? base.halted.code : failure.code, required_completed: rc, required_total: requiredTotal, objectives_completed: base.objective_summary.completed,
        objectives_total: base.objective_summary.total, progress_fraction: rd(base.totals.progress_fraction, 4), elapsed_s: rd(base.totals.elapsed_s, 2), total_energy_consumed_wh: rd(base.totals.energy.consumed_wh.total, 3), final_energy_wh: rd(base.totals.energy.end_wh, 3),
        mission_class: classify(rc, requiredTotal, false), provenance: 'state at failure' }, tradeoffs: ['Required objectives that were not reached stay incomplete.'], provenance: 'simulated state' });
    if (!Sim || !plan || !rover) {
      out.explanation = 'Recovery actions other than ACCEPT_PARTIAL were not evaluated: ' + (!Sim ? 'route-simulation module not available.' : 'plan and rover were not passed in the analysis context.');
      return out;
    }
    if (!base.resume) { out.explanation = 'Report carries no resume state; cannot simulate a continuation.'; return out; }
    out.evaluated = true;
    var resume = base.resume, pf = base.rover.condition.power_draw_factor, pend = base.objectives.filter(function (o) { return o.status === 'incomplete'; });
    var pendOptional = pend.filter(function (o) { return !o.required; }).map(function (o) { return o.id; });
    var simOpts = function (extra) { var o = { rover: rover, initial: clone(resume), onViolation: 'halt', traceEveryS: 1e9 }; Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; }); return o; };
    var runC = function (pl, extra) { return Sim.createSimulation(pl, simOpts(extra)).runToEnd(); };
    var T0 = resume.elapsed_s;
    var addAction = function (a) { out.actions.push(a); return a; };
    var mkAction = function (id, type, desc) { return { id: id, type: type, description: desc, applicable: true, feasible: null, feasibility_reason: '', requires: [], estimate: {}, outcome: null, tradeoffs: [], provenance: 'simulated continuation (assumed model)' }; };
    var na = function (a, why) { a.applicable = false; a.feasible = false; a.feasibility_reason = why; return a; };

    if (BATTERY[failure.code]) {
      // --- recharge and continue
      var a1 = mkAction('WAIT_RECHARGE', 'WAIT_RECHARGE', 'Hold position, recharge from the supplied charging source, then resume the plan.');
      var solar = base.limits.solar_input_w, idle = base.rover.idle_power_w * pf;
      var netC = solar - (idle != null ? idle : 0);
      a1.requires = ['Charging source of constant ' + solar + ' W (assumed constant, no day/night model)'];
      if (!(solar > 0)) na(a1, 'No charging source is defined in the plan (environment.solar_input_w = 0); recharge cannot be evaluated.');
      else if (!(netC > 0)) na(a1, 'Charging power ' + solar + ' W does not exceed the idle load ' + rd(idle, 2) + ' W; the battery would not charge.');
      else {
        var usable = base.limits.usable_capacity_wh, wmax = (usable - resume.energy_wh) * 3600 / netC;
        var noLim = modPlan(plan, { max_mission_s: null });
        var test = function (w) { return runC(noLim, { preActions: w > 0 ? [{ type: 'WAIT', duration_s: w, reason: 'recharge' }] : [] }); };
        var top = test(wmax);
        if (!(top.status === 'completed')) {
          a1.feasible = false; a1.feasibility_reason = 'Even from a full battery the remaining route does not complete (' + (top.halted ? top.halted.code : top.status) + '); recharge alone cannot recover the mission.';
          a1.outcome = outcomeFrom(top, base);
        } else {
          var lo = 0, hi = wmax, it = ctx.maxBisection || 40;
          while (it-- > 0 && hi - lo > 1) { var mid = (lo + hi) / 2; if (test(mid).status === 'completed') hi = mid; else lo = mid; }
          var wait = hi, cont = runC(plan, { preActions: [{ type: 'WAIT', duration_s: wait, reason: 'recharge' }] });
          a1.estimate = { action_time_s: rd(wait, 1), energy_wh: rd(netC * wait / 3600, 2), energy_wh_meaning: 'net energy gained during the wait', net_charge_w: rd(netC, 3), time_to_complete_s: rd(cont.totals.elapsed_s - T0, 1), time_precision_s: 1 };
          a1.outcome = outcomeFrom(cont, base);
          if (completesAllRequired(a1.outcome)) { a1.feasible = true; a1.feasibility_reason = 'Waiting about ' + fmtT(wait) + ' restores enough energy to finish the remaining route under the model.'; }
          else { var nl = runC(noLim, { preActions: [{ type: 'WAIT', duration_s: wait, reason: 'recharge' }] }); a1.feasible = false;
            a1.feasibility_reason = 'Energy is sufficient after ' + fmtT(wait) + ' but the mission time limit would be exceeded (needs ' + fmtT(nl.totals.elapsed_s - (base.limits.max_mission_s || 0)) + ' more than the limit allows).'; a1.estimate.extra_time_beyond_limit_s = rd(nl.totals.elapsed_s - (base.limits.max_mission_s || 0), 1); }
          a1.tradeoffs = ['Consumes ' + fmtT(wait) + ' of mission time.', 'Assumes constant charging power for the whole wait.'];
        }
      }
      addAction(a1);
      // --- drop optional objectives
      var a2 = mkAction('DESCOPE_OPTIONAL', 'DESCOPE_OPTIONAL', 'Skip the remaining optional objectives to save dwell energy and time, then continue.');
      if (!pendOptional.length) na(a2, 'No optional objectives remain to be skipped.');
      else {
        var c2 = runC(plan, { skipObjectives: pendOptional });
        a2.outcome = outcomeFrom(c2, base); a2.estimate = { action_time_s: 0, energy_wh: rd(c2.totals.energy.consumed_wh.total, 2), energy_wh_meaning: 'consumed by the continuation', skipped_objectives: pendOptional, time_to_complete_s: rd(c2.totals.elapsed_s - T0, 1) };
        a2.feasible = completesAllRequired(a2.outcome);
        a2.feasibility_reason = a2.feasible ? 'Skipping ' + pendOptional.length + ' optional objective(s) frees enough energy to finish all required objectives.' : 'Skipping optional objectives only saves dwell energy; the run still ' + (c2.halted ? 'halts (' + c2.halted.code + ').' : 'does not meet all required objectives.');
        a2.tradeoffs = ['Loses ' + pendOptional.length + ' optional objective(s).'];
      }
      addAction(a2);
    }

    if (TIME[failure.code]) {
      var a3 = mkAction('EXTEND_TIME_LIMIT', 'EXTEND_TIME_LIMIT', 'Obtain approval for more mission time and continue.');
      a3.requires = ['Operator / programme authorisation to extend the time limit (outside this model)'];
      var lim = base.limits.max_mission_s, c3 = runC(modPlan(plan, { max_mission_s: null }));
      a3.outcome = outcomeFrom(c3, base); var extra = c3.totals.elapsed_s - (lim || 0);
      a3.estimate = { action_time_s: 0, extra_time_needed_s: rd(Math.max(0, extra), 1), time_to_complete_s: rd(c3.totals.elapsed_s - T0, 1), energy_wh: rd(c3.totals.energy.consumed_wh.total, 2), energy_wh_meaning: 'consumed by the continuation' };
      a3.feasible = completesAllRequired(a3.outcome);
      a3.feasibility_reason = a3.feasible ? 'Needs ' + fmtT(extra) + ' beyond the limit; energy suffices under the model. Feasible only if the extension is authorised.' : 'More time alone is not enough: the continuation ' + (c3.halted ? 'halts (' + c3.halted.code + ').' : 'does not meet all required objectives.');
      a3.tradeoffs = ['Overruns the planned schedule by ' + fmtT(Math.max(0, extra)) + '.'];
      addAction(a3);
      var a4 = mkAction('DESCOPE_OPTIONAL', 'DESCOPE_OPTIONAL', 'Skip remaining optional objectives to finish required work inside the time limit.');
      if (!pendOptional.length) na(a4, 'No optional objectives remain to be skipped.');
      else if (!(isNum(lim) && report.totals.elapsed_s >= lim - 1e-6)) na(a4, 'Time limit has not been reached yet in this run.');
      else na(a4, 'The time limit is already used up; skipping objectives cannot create time. Combine with an extension.');
      addAction(a4);
    }

    if (TERRAIN[failure.code]) {
      var d = failure.event.data || {}, hseg = failure.event.data && failure.event.data.segment_index != null ? failure.event.data.segment_index : (base.halted && base.halted.segment_index);
      var seg = base.segments[hseg];
      // --- relax a planning constraint (never a rover capability)
      var a5 = mkAction('OVERRIDE_PLANNING_LIMIT', 'OVERRIDE_PLANNING_LIMIT', 'Relax the conservative planning constraint to the rover\'s own capability and continue.');
      a5.requires = ['Planner / operator approval to exceed the planning constraint'];
      if (failure.code === 'SEGMENT_BLOCKED') na(a5, 'The planner marked the segment impassable; this is not a limit that can be relaxed in the model.');
      else if (d.governed_by !== 'route_constraint') na(a5, 'The limit is the rover\'s own capability' + (isNum(d.rover_limit_deg) ? ' (' + rd(d.rover_limit_deg, 1) + ' deg)' : '') + '; it cannot be waived.');
      else {
        var patch = failure.code === 'SLOPE_EXCEEDS_LIMIT' ? { max_slope_deg: null } : { max_roughness_std: null };
        var c5 = runC(modPlan(plan, patch));
        a5.outcome = outcomeFrom(c5, base); a5.estimate = { action_time_s: 0, time_to_complete_s: rd(c5.totals.elapsed_s - T0, 1), energy_wh: rd(c5.totals.energy.consumed_wh.total, 2), energy_wh_meaning: 'consumed by the continuation' };
        a5.feasible = completesAllRequired(a5.outcome);
        a5.feasibility_reason = a5.feasible ? 'The segment is within rover capability; the run completes if the planning limit is relaxed.' : 'Relaxing the planning limit does not finish the mission: ' + (c5.halted ? c5.halted.code : 'required objectives remain') + '.';
        a5.tradeoffs = ['Removes the safety margin the planning constraint was providing; risk is higher.'];
      }
      addAction(a5);
      // --- planner-supplied alternatives
      var alts = (plan.alternatives || []).filter(function (a) { return seg && String(a.from) === seg.from && String(a.to) === seg.to; });
      if (!alts.length) {
        addAction(na(mkAction('ALTERNATE_ROUTE', 'ALTERNATE_ROUTE', 'Detour around the blocked segment.'), 'The planning engine supplied no alternative route for ' + (seg ? seg.from + ' -> ' + seg.to : 'this segment') + ' (plan.alternatives). This module does not invent routes.'));
      } else alts.forEach(function (alt) {
        var a6 = mkAction('ALTERNATE_ROUTE:' + alt.id, 'ALTERNATE_ROUTE', 'Detour "' + alt.id + '" supplied by the planning engine.');
        var vw = Array.isArray(alt.waypoints) ? alt.waypoints : [], vs = Array.isArray(alt.segments) ? alt.segments : [];
        if (vs.length !== vw.length + 1) { addAction(na(a6, 'Alternative is malformed: segments.length must equal waypoints.length + 1.')); return; }
        var p2 = clone(plan), i = hseg;
        p2.waypoints = p2.waypoints.slice(0, i + 1).concat(clone(vw), p2.waypoints.slice(i + 1));
        var rawS = p2.segments || []; while (rawS.length < i) rawS.push({});
        p2.segments = rawS.slice(0, i).concat(clone(vs), rawS.slice(i + 1));
        var r2 = clone(resume); r2.segment_index = i; r2.offset_m = 0; r2.at_waypoint = false; r2.dwell = null;
        var c6 = Sim.createSimulation(p2, { rover: rover, initial: r2, onViolation: 'halt', traceEveryS: 1e9 }).runToEnd();
        a6.outcome = outcomeFrom(c6, base);
        var unk = vs.filter(function (s) { return s.slope_deg == null; }).length;
        a6.estimate = { action_time_s: 0, time_to_complete_s: rd(c6.totals.elapsed_s - T0, 1), energy_wh: rd(c6.totals.energy.consumed_wh.total, 2), energy_wh_meaning: 'consumed by the continuation', detour_length_m: rd(vs.reduce(function (a, s) { return a + (isNum(s.length_m) ? s.length_m : 0); }, 0), 1) };
        a6.feasible = completesAllRequired(a6.outcome);
        a6.feasibility_reason = a6.feasible ? 'Detour completes the remaining mission under the model.' : 'Detour does not finish the mission: ' + (c6.halted ? c6.halted.code : 'required objectives remain') + '.';
        if (unk) a6.tradeoffs.push(unk + ' detour segment(s) carry no slope data; their limit checks are not possible (low confidence).');
        a6.tradeoffs.push('Detour terrain is exactly as supplied by the planner; not independently verified.');
        addAction(a6);
      });
    }

    if (failure.code === 'ROVER_IMMOBILE' || failure.code === 'SIM_GUARD') {
      out.explanation = 'No recovery model exists for this failure code beyond accepting the partial outcome.';
      return out;
    }

    // ranking
    var rank = function (a) { var o = a.outcome; return [a.feasible ? 0 : 1, o ? -o.required_completed : 0, a.estimate && a.estimate.skipped_objectives ? a.estimate.skipped_objectives.length : 0, a.requires && a.requires.length && /authoris|approval/i.test(a.requires.join(' ')) ? 1 : 0, a.estimate && a.estimate.action_time_s || 0]; };
    var viable = out.actions.filter(function (a) { return a.applicable && a.feasible && a.id !== 'ACCEPT_PARTIAL' && a.outcome; });
    viable.sort(function (a, b) { var x = rank(a), y = rank(b); for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.id < b.id ? -1 : 1; });
    var full = viable.filter(function (a) { return completesAllRequired(a.outcome); });
    if (full.length) { out.feasibility = 'full'; out.best_action_id = full[0].id; out.explanation = 'Recovery is feasible under the model: ' + full[0].description + ' ' + full[0].feasibility_reason; }
    else {
      var better = out.actions.filter(function (a) { return a.applicable && a.id !== 'ACCEPT_PARTIAL' && a.outcome && a.outcome.required_completed > rc; }).sort(function (a, b) { return b.outcome.required_completed - a.outcome.required_completed || (a.id < b.id ? -1 : 1); });
      if (better.length) { out.feasibility = 'partial'; out.best_action_id = better[0].id; out.explanation = 'No action completes every required objective, but ' + better[0].id + ' reaches ' + better[0].outcome.required_completed + ' of ' + requiredTotal + ' (vs ' + rc + ' now).'; }
      else { out.feasibility = 'none'; out.explanation = 'No evaluated action improves on the state at failure. ' + out.actions.filter(function (a) { return !a.applicable; }).map(function (a) { return a.id + ': ' + a.feasibility_reason; }).join(' '); }
    }
    return out;
  }

  // ------------------------------------------------------------------ public API
  function analyze(report, context) {
    context = context || {};
    if (!report || report.contract !== 'FZ-SIM-REPORT-0.1') return { contract: CONTRACT, version: VERSION, status: 'invalid_input', failures: [], warnings: [], error: 'report must be an FZ-SIM-REPORT-0.1 object from FieldZeroSim.', assumptions: ASSUMPTIONS.slice(), limitations: LIMITATIONS.slice() };
    if (report.validation && report.validation.errors.length) return { contract: CONTRACT, version: VERSION, status: 'invalid_input', failures: [], warnings: [], error: 'Simulation input was invalid: ' + report.validation.errors.join('; '), assumptions: ASSUMPTIONS.slice(), limitations: LIMITATIONS.slice() };
    var os = report.objective_summary, detected = detect(report), halted = report.halted;
    var failures = detected.map(function (d, i) {
      var tr = report.trace && report.trace.length ? report.trace[report.trace.length - 1] : null, segI = d.event && d.event.data && d.event.data.segment_index != null ? d.event.data.segment_index : (halted && d.code === halted.code ? halted.segment_index : null);
      var seg = segI != null ? report.segments[segI] : null, isHalt = halted && d.code === halted.code && d.t_s === halted.t_s;
      var lostReq = report.objectives.filter(function (o) { return o.status === 'incomplete' && o.required; }).map(function (o) { return o.id; });
      var lostOpt = report.objectives.filter(function (o) { return o.status === 'incomplete' && !o.required; }).map(function (o) { return o.id; });
      var f = { id: 'F' + (i + 1), code: d.code, severity: d.severity, t_s: d.t_s, detected_by: d.detected_by, message: d.message,
        location: { segment_index: segI, segment_id: seg ? seg.id : null, from: seg ? seg.from : null, to: seg ? seg.to : null, offset_m: isHalt ? halted.offset_m : null, x_m: isHalt && tr ? tr.x_m : null, y_m: isHalt && tr ? tr.y_m : null, provenance: 'simulated' }, event: d.event };
      f.causes = explainCause(f, report);
      var distLeft = report.totals.planned_distance_m - report.totals.distance_in_plan_m;
      f.consequences = isHalt ? { stops_mission: true, progress_fraction_at_failure: rd(report.totals.progress_fraction, 4), distance_not_travelled_m: rd(distLeft, 1), required_objectives_incomplete: lostReq, optional_objectives_incomplete: lostOpt,
        text: 'The run stops at ' + rd((report.totals.progress_fraction || 0) * 100, 1) + '% of the route; ' + lostReq.length + ' required and ' + lostOpt.length + ' optional objective(s) remain incomplete.' }
        : { stops_mission: false, text: 'Violation recorded while the run continued (record_and_continue); the mission was not stopped by it in the simulation, but a real operation would have to treat it as a breach.' };
      f.recovery = (isHalt && context.evaluateRecovery !== false) ? evaluateRecovery(f, report, context) : { evaluated: false, feasibility: 'not_evaluated', best_action_id: null, explanation: isHalt ? 'Recovery evaluation was switched off (context.evaluateRecovery = false).' : 'Recovery is evaluated only for the failure that stopped the run.', actions: [] };
      var best = f.recovery.actions.filter(function (a) { return a.id === f.recovery.best_action_id; })[0];
      var without = classify(os.required_completed, os.required_total, report.status === 'completed');
      f.mission_impact = { outcome_without_recovery: without, required_objectives_lost: lostReq, optional_objectives_lost: lostOpt, progress_fraction_at_failure: rd(report.totals.progress_fraction, 4),
        outcome_with_best_recovery: best && best.outcome ? best.outcome.mission_class : (f.recovery.evaluated ? without : null), best_recovery_action_id: f.recovery.best_action_id,
        text: isHalt ? 'Without recovery the mission outcome is ' + without + '.' + (best && best.outcome ? ' With ' + best.id + ' it becomes ' + best.outcome.mission_class + ' (simulated).' : (f.recovery.evaluated ? ' No evaluated recovery improves on that.' : ' Recovery was not evaluated.')) : 'No impact on the simulated outcome.' };
      delete f.event; return f;
    });
    var m = margins(report);
    var stopping = failures.filter(function (f) { return f.consequences.stops_mission; });
    return { contract: CONTRACT, version: VERSION, status: failures.length ? 'failure_detected' : 'no_failure', failures: failures, warnings: warningsFrom(report), margins: m,
      summary: { failure_count: failures.length, mission_stopping_failure: stopping.length ? stopping[0].code : null, recovery_feasibility: stopping.length ? stopping[0].recovery.feasibility : null,
        best_recovery_action_id: stopping.length ? stopping[0].recovery.best_action_id : null, risk_index: m.risk_index,
        text: failures.length ? failures.length + ' failure/violation event(s) detected; ' + (stopping.length ? 'the run stopped on ' + stopping[0].code + '. Recovery: ' + stopping[0].recovery.feasibility + '.' : 'none stopped the run.') : 'No failures detected under the simulated constraints (risk index ' + m.risk_index + ').' },
      assumptions: ASSUMPTIONS.slice(), limitations: LIMITATIONS.slice() };
  }

  /** Marks one evaluated recovery action as the chosen one and returns its simulated outcome. Nothing is re-run. */
  function executeRecovery(analysis, actionId) {
    var f = (analysis.failures || []).filter(function (x) { return x.recovery && x.recovery.actions.length && x.consequences.stops_mission; })[0];
    if (!f) return { executed: false, reason: 'No mission-stopping failure with evaluated recovery.' };
    var a = f.recovery.actions.filter(function (x) { return x.id === (actionId || f.recovery.best_action_id); })[0];
    if (!a) return { executed: false, reason: 'Unknown action id.' };
    if (!a.applicable || !a.outcome) return { executed: false, reason: a.feasibility_reason || 'Action not applicable.' };
    return { executed: true, failure_id: f.id, failure_code: f.code, action_id: a.id, feasible: a.feasible, feasibility_reason: a.feasibility_reason, outcome: clone(a.outcome), estimate: clone(a.estimate), provenance: 'simulated (continuation of the assumed model); no real operation was performed' };
  }

  return { version: VERSION, CONTRACT: CONTRACT, ASSUMPTIONS: ASSUMPTIONS, LIMITATIONS: LIMITATIONS, analyze: analyze, executeRecovery: executeRecovery, margins: margins, detect: detect, classify: classify };
});
